@echo off
setlocal

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
