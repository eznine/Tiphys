# Upload a versioned APK to tiphys.xyz/apk/ and sync both version.json copies.
# Usage: scripts/upload-apk-tiphys-xyz.ps1 [path\to\tiphys-X.Y.Z.apk]
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$HostName = if ($env:EZNINE_SSH_HOST) { $env:EZNINE_SSH_HOST } else { "20.214.241.113" }
$UserName = if ($env:EZNINE_SSH_USER) { $env:EZNINE_SSH_USER } else { "eznine" }
$Key = if ($env:EZNINE_SSH_KEY) { $env:EZNINE_SSH_KEY } else { "F:\server\eznine_deploy_b" }
$PassFile = if ($env:EZNINE_SSH_PASS_FILE) { $env:EZNINE_SSH_PASS_FILE } else { "F:\server\tiphys-deploy-pass.txt" }
$RemoteWeb = if ($env:EZNINE_REMOTE_WEB) { $env:EZNINE_REMOTE_WEB } else { "/srv/tiphys-web" }
$RemoteApk = if ($env:EZNINE_REMOTE_APK) { $env:EZNINE_REMOTE_APK } else { "$RemoteWeb/apk" }
$RemoteApp = if ($env:EZNINE_REMOTE_APP) { $env:EZNINE_REMOTE_APP } else { "$RemoteWeb/tiphys" }

$VersionJson = if ($env:TIPHYS_VERSION_JSON) { $env:TIPHYS_VERSION_JSON } else { "public\version.json" }
if (-not (Test-Path $Key)) { throw "SSH key not found: $Key" }
if (-not (Test-Path $PassFile)) { throw "Password file not found: $PassFile" }
if (-not (Test-Path $VersionJson)) { throw "version.json not found: $VersionJson" }
$Password = (Get-Content -Raw $PassFile).Trim()

$verObj = [System.IO.File]::ReadAllText((Resolve-Path $VersionJson), [System.Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
$ApkPath = $args[0]
if (-not $ApkPath) {
  foreach ($cand in @("dist-apk\tiphys-$($verObj.version).apk", "dist-apk\tiphys-debug.apk", "android\app\build\outputs\apk\debug\app-debug.apk")) {
    if (Test-Path $cand) { $ApkPath = $cand; break }
  }
}
if (-not $ApkPath -or -not (Test-Path $ApkPath)) { throw "APK not found. Pass path or place dist-apk\tiphys-<ver>.apk" }

Write-Host "→ verify APK signing cert (canonical efd833d2…)"
node "$Root\scripts\verify-apk-cert.mjs" $ApkPath
if ($LASTEXITCODE -ne 0) { throw "APK cert verification failed — refuse upload" }


$remoteName = if ($verObj.apkUrl) { Split-Path -Leaf $verObj.apkUrl } else { Split-Path -Leaf $ApkPath }
$sshTarget = "${UserName}@${HostName}"
$sshArgs = @("-i", $Key, "-o", "StrictHostKeyChecking=no", "-o", "IdentitiesOnly=yes", $sshTarget)

Write-Host "→ upload $ApkPath → ${RemoteApk}/${remoteName}"
& ssh @sshArgs "mkdir -p /tmp/tiphys-apk-upload"
if ($LASTEXITCODE -ne 0) { throw "ssh mkdir failed" }
& scp -i $Key -o StrictHostKeyChecking=no -o IdentitiesOnly=yes $ApkPath "${sshTarget}:/tmp/tiphys-apk-upload/$remoteName"
if ($LASTEXITCODE -ne 0) { throw "scp apk failed" }
& scp -i $Key -o StrictHostKeyChecking=no -o IdentitiesOnly=yes $VersionJson "${sshTarget}:/tmp/tiphys-apk-upload/version.json"
if ($LASTEXITCODE -ne 0) { throw "scp version.json failed" }

$install = @"
mkdir -p '$RemoteApk' '$RemoteApp' &&
install -m 644 '/tmp/tiphys-apk-upload/$remoteName' '$RemoteApk/$remoteName' &&
cp -f '/tmp/tiphys-apk-upload/$remoteName' '$RemoteApk/tiphys.apk' &&
install -m 644 /tmp/tiphys-apk-upload/version.json '$RemoteWeb/version.json' &&
install -m 644 /tmp/tiphys-apk-upload/version.json '$RemoteApp/version.json' &&
chown eznine:eznine '$RemoteWeb/version.json' '$RemoteApp/version.json' '$RemoteApk/$remoteName' '$RemoteApk/tiphys.apk' 2>/dev/null || true &&
rm -rf /tmp/tiphys-apk-upload
"@
$b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($install))
$Password | & ssh @sshArgs "sudo -S -p '' bash -lc `"echo $b64 | base64 -d | bash`""
if ($LASTEXITCODE -ne 0) { throw "sudo install failed" }

$size = (Get-Item $ApkPath).Length
Write-Host "OK https://tiphys.xyz/apk/$remoteName ($size bytes)"
try {
  (Invoke-WebRequest -Uri "https://tiphys.xyz/version.json?t=$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())" -UseBasicParsing).Content
  (Invoke-WebRequest -Uri "https://tiphys.xyz/tiphys/version.json?t=$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())" -UseBasicParsing).Content
} catch { Write-Warning $_.Exception.Message }
