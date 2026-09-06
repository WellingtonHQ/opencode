@echo off
setlocal

rem === Pinned bun toolchain ================================================
rem The repo pins bun via "packageManager" in the root package.json, which is
rem read below as the single source of truth. Newer releases (1.4.x as of
rem 2026-09) have a bundler regression that breaks the compiled binary, so
rem this script always builds with the pinned version: it uses the system bun
rem if it already matches, otherwise downloads the pinned release into
rem %LOCALAPPDATA% and prepends it to PATH for every step below.

set "PM="
for /f "tokens=2 delims=:," %%a in ('findstr /c:"packageManager" "%~dp0..\..\package.json"') do set "PM=%%a"
set "PM=%PM:"=%"
set "PM=%PM: =%"
set "BUN_VERSION=%PM:bun@=%"
set "VER_OK="
for /f "delims=" %%v in ('powershell -NoProfile -Command "[regex]::IsMatch('%BUN_VERSION%','^[0-9]+[.][0-9]+[.][0-9]+$')"') do set "VER_OK=%%v"
if /i not "%VER_OK%"=="True" (
    echo ERROR: could not read a bun version from packageManager in ..\..\package.json - got %PM%
    exit /b 1
)

set "BUN_ARCH=x64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "BUN_ARCH=arm64"

set "SYS_BUN_VERSION="
for /f "delims=" %%v in ('bun --version 2^>nul') do set "SYS_BUN_VERSION=%%v"

if "%SYS_BUN_VERSION%"=="%BUN_VERSION%" goto :have_bun

echo === Downloading bun %BUN_VERSION%; system bun is %SYS_BUN_VERSION% ===
set "BUN_DIR=%LOCALAPPDATA%\opencode-build-tools\bun-%BUN_VERSION%-windows-%BUN_ARCH%"
if exist "%BUN_DIR%\bun.exe" goto :check_bun

if not exist "%BUN_DIR%" mkdir "%BUN_DIR%" || exit /b 1
set "ZIP=%BUN_DIR%.zip"
set "STAGE=%TEMP%\bun-dl-%RANDOM%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri 'https://github.com/oven-sh/bun/releases/download/bun-v%BUN_VERSION%/bun-windows-%BUN_ARCH%.zip' -OutFile '%ZIP%'; Expand-Archive -LiteralPath '%ZIP%' -DestinationPath '%STAGE%' -Force; Move-Item -LiteralPath '%STAGE%\bun-windows-%BUN_ARCH%\bun.exe' -Destination '%BUN_DIR%\bun.exe' -Force; Remove-Item -LiteralPath '%ZIP%' -Force; Remove-Item -Recurse -Force '%STAGE%'"
if errorlevel 1 exit /b 1

:check_bun
set "GOT_BUN_VERSION="
for /f "delims=" %%v in ('"%BUN_DIR%\bun.exe" --version 2^>nul') do set "GOT_BUN_VERSION=%%v"
if "%GOT_BUN_VERSION%"=="%BUN_VERSION%" goto :have_bun

echo ERROR: %BUN_DIR%\bun.exe reports version %GOT_BUN_VERSION%, expected %BUN_VERSION%.
echo Delete that folder and re-run this script.
exit /b 1

:have_bun
if not "%SYS_BUN_VERSION%"=="%BUN_VERSION%" set "PATH=%BUN_DIR%;%PATH%"

echo === Installing dependencies ===
cd /d "%~dp0.."
call bun install
if errorlevel 1 exit /b 1

echo === Building ===
cd /d "%~dp0"
call bun run build --single
if errorlevel 1 exit /b 1

echo === Installing ===
set "BIN_FILE="
for /d %%D in ("%~dp0dist\opencode-windows-*") do if exist "%%D\bin\opencode.exe" set "BIN_FILE=%%D\bin\opencode.exe"
if not defined BIN_FILE (
    echo ERROR: no built binary found under dist\opencode-windows-*\bin
    exit /b 1
)

set "INSTALL_DIR=%USERPROFILE%\.opencode\bin"
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
copy /y "%BIN_FILE%" "%INSTALL_DIR%\" || exit /b 1

echo %PATH% | findstr /i "%INSTALL_DIR%" >nul
if errorlevel 1 (
    echo WARNING: %INSTALL_DIR% is not in your PATH. Add it to run "opencode" from any terminal.
)

echo === Done ===
echo Installed: %INSTALL_DIR%\opencode.exe
