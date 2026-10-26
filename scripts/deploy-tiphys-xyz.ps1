# Deploy dist/ to tiphys.xyz app subpath ONLY (/srv/tiphys-web/tiphys/).
# Never touches the landing page at web root or /apk/.
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$HostName = if ($env:EZNINE_SSH_HOST) { $env:EZNINE_SSH_HOST } else { "20.214.241.113" }
$UserName = if ($env:EZNINE_SSH_USER) { $env:EZNINE_SSH_USER } else { "eznine" }
$Key = if ($env:EZNINE_SSH_KEY) { $env:EZNINE_SSH_KEY } else { "F:\server\eznine_deploy_b" }
$PassFile = if ($env:EZNINE_SSH_PASS_FILE) { $env:EZNINE_SSH_PASS_FILE } else { "F:\server\tiphys-deploy-pass.txt" }
$RemoteTmp = if ($env:EZNINE_REMOTE_TMP) { $env:EZNINE_REMOTE_TMP } else { "/tmp/tiphys-dist" }
$RemoteWeb = if ($env:EZNINE_REMOTE_WEB) { $env:EZNINE_REMOTE_WEB } else { "/srv/tiphys-web" }
$RemoteApp = if ($env:EZNINE_REMOTE_APP) { $env:EZNINE_REMOTE_APP } else { "$RemoteWeb/tiphys" }
$AppPublicUrl = if ($env:TIPHYS_APP_PUBLIC_URL) { $env:TIPHYS_APP_PUBLIC_URL } else { "https://tiphys.xyz/tiphys/" }
$LandingUrl = if ($env:TIPHYS_LANDING_URL) { $env:TIPHYS_LANDING_URL } else { "https://tiphys.xyz/" }

if (-not (Test-Path "dist\index.html")) { throw "dist/ missing. Run: npm run build" }
$index = Get-Content -Raw "dist\index.html"
if ($index -notmatch '(/tiphys/|\./)assets/') {
  throw "dist/index.html does not look like a /tiphys/ (or relative) build. Abort."
}
if (-not (Test-Path $Key)) {
  throw "SSH key not found: $Key`nPut the deploy key at F:\server\eznine_deploy_b (outside git)."
}
if (-not (Test-Path $PassFile)) {
  throw "Password file not found: $PassFile`nPut one line (sudo password) in F:\server\tiphys-deploy-pass.txt (outside git)."
}
$Password = (Get-Content -Raw $PassFile).Trim()
if (-not $Password) { throw "Password file empty: $PassFile" }

$sshTarget = "${UserName}@${HostName}"
$sshArgs = @("-i", $Key, "-o", "StrictHostKeyChecking=no", "-o", "IdentitiesOnly=yes", $sshTarget)

function Invoke-Remote([string]$Cmd) {
  & ssh @sshArgs $Cmd
  if ($LASTEXITCODE -ne 0) { throw "ssh failed: $Cmd" }
}
function Invoke-SudoRemote([string]$Cmd) {
  $b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($Cmd))
  $Password | & ssh @sshArgs "sudo -S -p '' bash -lc `"echo $b64 | base64 -d | bash`""
  if ($LASTEXITCODE -ne 0) { throw "sudo remote failed: $Cmd" }
}

Write-Host "→ snapshot landing file on origin disk (CDN HTML hash is flaky)"
$landingBefore = (& ssh @sshArgs "sha256sum '$RemoteWeb/index.html'").Split()[0]
Write-Host "   landing disk sha256: $landingBefore"

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
Write-Host "→ backup remote app dir $RemoteApp"
Invoke-SudoRemote "if [[ -d '$RemoteApp' ]]; then cp -a '$RemoteApp' '$RemoteApp.bak-$stamp'; fi; mkdir -p '$RemoteApp' '$RemoteTmp'"

Write-Host "→ prepare $RemoteTmp"
Invoke-Remote "rm -rf '$RemoteTmp' && mkdir -p '$RemoteTmp'"

Write-Host "→ upload dist/ (tar-over-ssh)"
$upload = "tar -C dist -cf - . | ssh -i `"$Key`" -o StrictHostKeyChecking=no -o IdentitiesOnly=yes $sshTarget `"tar -C '$RemoteTmp' -xf -`""
cmd /c $upload
if ($LASTEXITCODE -ne 0) { throw "upload failed" }

Write-Host "→ sudo install $RemoteApp/ ONLY (never landing /apk)"
Invoke-SudoRemote "rsync -a --delete --filter='P apk/' --filter='P apk/**' '$RemoteTmp/' '$RemoteApp/' && if [[ -f '$RemoteApp/version.json' ]]; then cp -f '$RemoteApp/version.json' '$RemoteWeb/version.json'; chown eznine:eznine '$RemoteWeb/version.json' 2>/dev/null || true; fi && rm -rf '$RemoteTmp'"

Write-Host "→ verify landing disk unchanged + app live"
$landingAfter = (& ssh @sshArgs "sha256sum '$RemoteWeb/index.html'").Split()[0]
if ($landingBefore -ne $landingAfter) {
  throw "FATAL: landing file on disk changed ($landingBefore → $landingAfter). Investigate immediately."
}
Write-Host "   landing OK (disk unchanged)"

$local = ([regex]::Match((Get-Content -Raw dist\index.html), 'assets/index-[^"\s]+\.js')).Value
try {
  $html = (Invoke-WebRequest -Uri ("{0}?v={1}" -f $AppPublicUrl, [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()) -UseBasicParsing).Content
  $live = ([regex]::Match($html, 'assets/index-[^"\s]+\.js')).Value
} catch { $live = "" }
Write-Host "local: $local"
Write-Host "live:  $live"
if ($local -and $local -eq $live) { Write-Host "OK $AppPublicUrl matches this dist/" }
else { Write-Warning "live app asset differs; hard-refresh and recheck." }
