@echo off
REM Copy bundled CloakBrowser kernels from repo Browse\ into a package directory.
REM Usage: copy-browse-kernels.bat <dest_root>
REM Soft-fail: missing Browse\ only warns (dev machines without kernels).
setlocal EnableExtensions

set "DEST=%~1"
if "%DEST%"=="" (
  echo [WARN] copy-browse-kernels: missing destination
  exit /b 0
)

set "SRC=%~dp0..\Browse"
set "PRO_DIR=chromium-151.0.7922.108.3-pro"

if not exist "%SRC%\%PRO_DIR%\chrome.exe" (
  echo [WARN] Browse\%PRO_DIR%\chrome.exe not found — skip bundling 151-pro kernel
  exit /b 0
)

if not exist "%DEST%\Browse" mkdir "%DEST%\Browse" >nul 2>&1
echo [INFO] Copying Browse\%PRO_DIR% to %DEST%\Browse\ ...
xcopy /E /I /Y "%SRC%\%PRO_DIR%" "%DEST%\Browse\%PRO_DIR%\" >nul
if errorlevel 1 (
  echo [WARN] Failed to copy Browse\%PRO_DIR%
  exit /b 0
)
echo [OK] Bundled kernel: Browse\%PRO_DIR%
exit /b 0
