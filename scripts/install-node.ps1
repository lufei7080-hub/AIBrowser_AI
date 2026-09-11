$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$msi = Join-Path $env:TEMP "nodejs-lts.msi"
$uris = @(
  "https://nodejs.org/dist/v22.14.0/node-v22.14.0-x64.msi",
  "https://npmmirror.com/mirrors/node/v22.14.0/node-v22.14.0-x64.msi"
)
$ok = $false
foreach ($uri in $uris) {
  try {
    Write-Host "[INFO] Download $uri"
    Invoke-WebRequest -Uri $uri -OutFile $msi -UseBasicParsing
    $ok = $true
    break
  } catch {
    Write-Host "[WARN] download failed: $($_.Exception.Message)"
  }
}
if (-not $ok) { exit 1 }
Write-Host "[INFO] msiexec quiet install..."
$p = Start-Process -FilePath "msiexec.exe" -ArgumentList "/i `"$msi`" /qn /norestart" -Wait -PassThru
exit $p.ExitCode
