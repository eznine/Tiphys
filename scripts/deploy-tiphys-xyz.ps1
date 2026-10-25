# Deploy dist/ to tiphys.xyz nginx origin. Not Cloudflare Pages / wrangler.
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$HostName = if ($env:EZNINE_SSH_HOST) { $env:EZNINE_SSH_HOST } else { "20.214.241.113" }
$UserName = if ($env:EZNINE_SSH_USER) { $env:EZNINE_SSH_USER } else { "eznine" }
$Key = if ($env:EZNINE_SSH_KEY) { $env:EZNINE_SSH_KEY } else { "F:\server\eznine_deploy_b" }
$PassFile = if ($env:EZNINE_SSH_PASS_FILE) { $env:EZNINE_SSH_PASS_FILE } else { "F:\server\tiphys-deploy-pass.txt" }
$RemoteTmp = "/tmp/tiphys-dist"
$RemoteWeb = "/srv/tiphys-web"

if (-not (Test-Path "dist\index.html")) { throw "dist/ missing. Run: npm run build" }
if (-not (Test-Path $Key)) {
  throw @"
SSH key not found: $Key
Put the deploy key at F:\server\eznine_deploy_b (outside git).
This is NOT a Cloudflare / wrangler token.
"@
}
if (-not (Test-Path $PassFile)) {
  throw @"
Password file not found: $PassFile
Put one line (sudo password) in F:\server\tiphys-deploy-pass.txt (outside git).
"@
}
$Password = (Get-Content -Raw $PassFile).Trim()
if (-not $Password) { throw "Password file empty: $PassFile" }

$sshTarget = "${UserName}@${HostName}"
$sshArgs = @("-i", $Key, "-o", "StrictHostKeyChecking=no", "-o", "IdentitiesOnly=yes", $sshTarget)

Write-Host "→ prepare $RemoteTmp"
& ssh @sshArgs "rm -rf '$RemoteTmp' && mkdir -p '$RemoteTmp'"
if ($LASTEXITCODE -ne 0) { throw "ssh login failed. Check key $Key and server authorized_keys." }

Write-Host "→ upload dist/ (tar-over-ssh)"
$upload = "tar -C dist -cf - . | ssh -i `"$Key`" -o StrictHostKeyChecking=no -o IdentitiesOnly=yes $sshTarget `"tar -C '$RemoteTmp' -xf -`""
cmd /c $upload
if ($LASTEXITCODE -ne 0) { throw "upload failed" }

Write-Host "→ sudo install $RemoteWeb"
# Feed password to remote sudo -S
# Protect /apk/ so separately uploaded APKs survive --delete of the SPA tree.
$Password | & ssh @sshArgs "sudo -S rsync -a --delete --filter='P apk/' --filter='P apk/**' '$RemoteTmp/' '$RemoteWeb/'"
if ($LASTEXITCODE -ne 0) { throw "sudo rsync failed. Check password in $PassFile" }

$local = ([regex]::Match((Get-Content -Raw dist\index.html), 'assets/index-[^"\s]+\.js')).Value
try {
  $html = (Invoke-WebRequest -Uri ("https://tiphys.xyz/?v={0}" -f [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()) -UseBasicParsing).Content
  $live = ([regex]::Match($html, 'assets/index-[^"\s]+\.js')).Value
} catch { $live = "" }
Write-Host "local: $local"
Write-Host "live:  $live"
if ($local -and $local -eq $live) { Write-Host "OK tiphys.xyz matches this dist/" }
else { Write-Warning "live asset differs; hard-refresh and recheck." }
