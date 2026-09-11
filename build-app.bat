@echo off
REM ASCII-only batch to avoid cmd parenthesis / UTF-8 parse breakage.
setlocal EnableExtensions
pushd "%~dp0"

title TianshuTai - Release Build

set "RELEASE_DIR=%CD%\release-dist"
set "PORTABLE_DIR=%RELEASE_DIR%\portable"
set "INSTALLER_DIR=%RELEASE_DIR%\installer"
set "CARGO_TARGET_DIR=C:\temp\cloakforge-target"

if not exist "C:\temp" mkdir "C:\temp" >nul 2>&1
if exist "%RELEASE_DIR%" rmdir /s /q "%RELEASE_DIR%" >nul 2>&1
mkdir "%PORTABLE_DIR%" >nul 2>&1
mkdir "%INSTALLER_DIR%" >nul 2>&1

echo.
echo ================================================
echo   TianshuTai CloakForge - One-click Package
echo   Portable : %PORTABLE_DIR%
echo   Installer: %INSTALLER_DIR%
echo ================================================
echo.

if not exist "package.json" (
  echo [FAIL] Run build-app.bat from project root.
  goto fail
)

echo [Step 1/7] Check / install build environment...
call "scripts\env-setup.bat" BUILD
if errorlevel 1 goto fail
call "scripts\env-setup.bat" VS

echo.
echo [Step 2/7] Prepare Sidecar runtime...
call "scripts\prepare-sidecar-runtime.bat"
if errorlevel 1 goto fail

echo.
echo [Step 3/7] Frontend production build...
call npm.cmd run build
if errorlevel 1 goto frontend_fail

echo.
echo [Step 4/7] Tauri release build. This may take 5-15 minutes...
set "CARGO_TARGET_DIR=%CARGO_TARGET_DIR%"
call npm.cmd run tauri -- build
if errorlevel 1 goto tauri_fail

echo.
echo [Step 5/7] Assemble PORTABLE package...
set "BUNDLE_ROOT=%CARGO_TARGET_DIR%\release\bundle"
if not exist "%BUNDLE_ROOT%" set "BUNDLE_ROOT=src-tauri\target\release\bundle"

set "EXE_SRC="
if exist "%CARGO_TARGET_DIR%\release\cloakforge.exe" set "EXE_SRC=%CARGO_TARGET_DIR%\release\cloakforge.exe"
if not defined EXE_SRC if exist "src-tauri\target\release\cloakforge.exe" set "EXE_SRC=src-tauri\target\release\cloakforge.exe"

REM productName may produce a Unicode exe name; probe via dir /b
if not defined EXE_SRC (
  for /f "delims=" %%F in ('dir /b "%CARGO_TARGET_DIR%\release\*.exe" 2^>nul') do (
    if /I not "%%F"=="cloakforge_lib.exe" if not defined EXE_SRC set "EXE_SRC=%CARGO_TARGET_DIR%\release\%%F"
  )
)
if not defined EXE_SRC (
  for /f "delims=" %%F in ('dir /b "src-tauri\target\release\*.exe" 2^>nul') do (
    if /I not "%%F"=="cloakforge_lib.exe" if not defined EXE_SRC set "EXE_SRC=src-tauri\target\release\%%F"
  )
)

if not defined EXE_SRC (
  echo [ERROR] Main exe not found after Tauri build.
  goto fail
)

echo [INFO] Using exe: %EXE_SRC%
copy /Y "%EXE_SRC%" "%PORTABLE_DIR%\cloakforge.exe" >nul
copy /Y "%EXE_SRC%" "%PORTABLE_DIR%\TianshuTai.exe" >nul
echo [OK] Main exe copied to portable\

call "scripts\copy-sidecar-bundle.bat" "%PORTABLE_DIR%"
if errorlevel 1 goto fail

if exist "extensions" (
  xcopy /E /I /Y "extensions" "%PORTABLE_DIR%\extensions\" >nul
  echo [OK] extensions copied
)

REM Bundle offline 151-pro fingerprint kernel (free 146 downloads via ensureBinary)
call "scripts\copy-browse-kernels.bat" "%PORTABLE_DIR%"

powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\packaging\copy-guide.ps1" "%PORTABLE_DIR%"
if exist "src-tauri\icons\icon.ico" copy /Y "src-tauri\icons\icon.ico" "%PORTABLE_DIR%\" >nul

copy /Y "scripts\check-runtime.bat" "%PORTABLE_DIR%\" >nul
copy /Y "scripts\release-launcher.bat" "%PORTABLE_DIR%\Start-TianshuTai.bat" >nul
if not exist "%PORTABLE_DIR%\scripts" mkdir "%PORTABLE_DIR%\scripts" >nul 2>&1
if exist "scripts\install-twp-extension.ps1" copy /Y "scripts\install-twp-extension.ps1" "%PORTABLE_DIR%\scripts\" >nul
copy /Y "scripts\packaging\README-portable.txt" "%PORTABLE_DIR%\README.txt" >nul
echo [OK] Portable package ready: %PORTABLE_DIR%

echo.
echo [Step 6/7] Assemble INSTALLER package...
xcopy /E /I /Y "%PORTABLE_DIR%\*" "%INSTALLER_DIR%\payload\" >nul
if errorlevel 1 (
  echo [ERROR] Failed to copy portable tree into installer\payload
  goto fail
)

mkdir "%INSTALLER_DIR%\scripts" >nul 2>&1
copy /Y "scripts\installer-wizard.ps1" "%INSTALLER_DIR%\scripts\" >nul
copy /Y "scripts\Setup-TianshuTai.bat" "%INSTALLER_DIR%\Setup-TianshuTai.bat" >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\packaging\copy-guide.ps1" "%INSTALLER_DIR%"
copy /Y "scripts\packaging\README-installer.txt" "%INSTALLER_DIR%\README.txt" >nul

if exist "%BUNDLE_ROOT%\nsis" (
  xcopy /E /I /Y "%BUNDLE_ROOT%\nsis\*" "%INSTALLER_DIR%\nsis-tauri\" >nul
  echo [OK] Tauri NSIS files copied to installer\nsis-tauri\
)

echo [OK] Installer package ready: %INSTALLER_DIR%

echo.
echo [Step 7/7] Write root README...
copy /Y "scripts\packaging\README-root.txt" "%RELEASE_DIR%\README.txt" >nul

echo.
echo ================================================
echo [DONE] Packages ready
echo   Portable : %PORTABLE_DIR%
echo   Installer: %INSTALLER_DIR%
echo Zip each folder separately for distribution.
echo ================================================
echo.

popd
pause
exit /b 0

:frontend_fail
echo [ERROR] Frontend build failed.
goto fail

:tauri_fail
echo [ERROR] Tauri/Rust build failed.
echo [TIP] Install VS C++ Build Tools
echo [TIP] Prefer ASCII project path like C:\AiBrowser
echo [TIP] Check cargo/npm network
goto fail

:fail
popd
pause
exit /b 1
