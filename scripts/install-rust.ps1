$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$exe = Join-Path $env:TEMP "rustup-init.exe"
$uris = @(
  "https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe",
  "https://mirrors.ustc.edu.cn/rust-static/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe"
)
$ok = $false
foreach ($uri in $uris) {
  try {
    Write-Host "[INFO] Download $uri"
    Invoke-WebRequest -Uri $uri -OutFile $exe -UseBasicParsing
    $ok = $true
    break
  } catch {
    Write-Host "[WARN] download failed: $($_.Exception.Message)"
  }
}
if (-not $ok) { exit 1 }
Write-Host "[INFO] rustup-init -y ..."
& $exe -y --default-toolchain stable --profile minimal
exit $LASTEXITCODE
