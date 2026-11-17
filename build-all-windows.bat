@echo off
setlocal EnableExtensions

rem === Single-instance lock ================================================
rem Two concurrent runs race on the shared dist directories and can package a
rem half-written build (for example an empty out\renderer). install-all-windows
rem uses the same lock, so a build and an install can never run at once. The
rem lock is removed on every exit path; a lock left behind by a killed run is
rem stale and is cleaned up here once it is older than 45 minutes (longer than
rem any build or install takes), so a crashed run can never block the next
rem one. Kept flat, in no parenthesized block: a block is parsed and its
rem variables expanded before any of its lines run, so a value set inside it
rem is not visible to later lines of the same block.
set "LOCK=%TEMP%\opencode-build-all.%USERNAME%.lock"
set "LOCK_STALE="
if not exist "%LOCK%" goto :lock_free
for /f "delims=" %%s in ('powershell -NoProfile -Command "if (((Get-Date) - (Get-Item -LiteralPath \"%LOCK%\").LastWriteTime) -gt [TimeSpan]::FromMinutes(45)) { \"stale\" }"') do set "LOCK_STALE=%%s"
if defined LOCK_STALE goto :lock_stale
goto :lock_taken
:lock_stale
del "%LOCK%" >nul 2>nul
goto :lock_free
:lock_taken
echo ERROR: a build or install is already in progress ^(lock: %LOCK%^).
echo If nothing is actually running, delete that file and re-run.
exit /b 1
:lock_free
echo %date% %time% > "%LOCK%"

rem ============================================================================
rem Build the CLI (with its embedded web UI) and the desktop app installer in
rem one pass. Nothing is installed and nothing is restarted by this script.
rem
rem Usage:
rem   build-all-windows.bat            build the CLI and the desktop installer
rem
rem Run install-all-windows.bat afterwards to install the CLI and the desktop
rem app, and to optionally restart the background server.
rem
rem How it works (see packages/cli, packages/desktop, packages/client):
rem   - The CLI is built for channel "dev" with a unique version. The channel
rem     is baked into the binary and selects the service registration file
rem     (%USERPROFILE%\.local\state\opencode\service.json); "dev" is the
rem     channel of the installed desktop app, so both address the same
rem     service. The unique version stops the desktop from reusing a stale
rem     staged CLI (it stages under a version-named folder).
rem   - The desktop build packages packages\cli\dist\cli-windows-x64-baseline
rem     (selected with OPENCODE_TARGET=windows-x64-baseline) into its
rem     installer, so the app and its private CLI share one version.
rem   - "opencode service restart" from the new CLI stops the registered
rem     server and starts the new binary in its place. The server keeps its
rem     address, port and credentials (the user environment variables
rem     OPENCODE_SERVER_PORT / OPENCODE_SERVER_PASSWORD /
rem     OPENCODE_SERVER_USERNAME), so the phone and desktop reconnect
rem     without re-authenticating.
rem
rem The running server is not touched until you explicitly confirm the
rem restart. Building never restarts anything.
rem ============================================================================

rem === Pinned bun toolchain ================================================
rem The repo pins bun via "packageManager" in the root package.json. Use the
rem system bun if it already matches, otherwise download the pinned release
rem into %LOCALAPPDATA% and prepend it to PATH for every step below.

set "PM="
for /f "tokens=2 delims=:," %%a in ('findstr /c:"packageManager" "%~dp0package.json"') do set "PM=%%a"
set "PM=%PM:"=%"
set "PM=%PM: =%"
set "BUN_VERSION=%PM:bun@=%"
set "VER_OK="
for /f "delims=" %%v in ('powershell -NoProfile -Command "[regex]::IsMatch('%BUN_VERSION%','^[0-9]+[.][0-9]+[.][0-9]+$')"') do set "VER_OK=%%v"
if /i not "%VER_OK%"=="True" (
    echo ERROR: could not read a bun version from packageManager in package.json - got %PM%
    goto :fail
)

set "BUN_ARCH=x64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "BUN_ARCH=aarch64"

set "SYS_BUN_VERSION="
for /f "delims=" %%v in ('bun --version 2^>nul') do set "SYS_BUN_VERSION=%%v"

if "%SYS_BUN_VERSION%"=="%BUN_VERSION%" goto :have_bun

echo === Downloading bun %BUN_VERSION%; system bun is %SYS_BUN_VERSION% ===
set "BUN_DIR=%LOCALAPPDATA%\opencode-build-tools\bun-%BUN_VERSION%-windows-%BUN_ARCH%"
if exist "%BUN_DIR%\bun.exe" goto :check_bun

if not exist "%BUN_DIR%" mkdir "%BUN_DIR%" || goto :fail
set "ZIP=%BUN_DIR%.zip"
set "STAGE=%TEMP%\bun-dl-%RANDOM%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference = 'Stop'; Invoke-WebRequest -Uri 'https://github.com/oven-sh/bun/releases/download/bun-v%BUN_VERSION%/bun-windows-%BUN_ARCH%.zip' -OutFile '%ZIP%'; Expand-Archive -LiteralPath '%ZIP%' -DestinationPath '%STAGE%' -Force; Move-Item -LiteralPath '%STAGE%\bun-windows-%BUN_ARCH%\bun.exe' -Destination '%BUN_DIR%\bun.exe' -Force; Remove-Item -LiteralPath '%ZIP%' -Force; Remove-Item -Recurse -Force '%STAGE%'"
if errorlevel 1 goto :fail

:check_bun
set "GOT_BUN_VERSION="
for /f "delims=" %%v in ('"%BUN_DIR%\bun.exe" --version 2^>nul') do set "GOT_BUN_VERSION=%%v"
if "%GOT_BUN_VERSION%"=="%BUN_VERSION%" goto :have_bun

echo ERROR: %BUN_DIR%\bun.exe reports version %GOT_BUN_VERSION%, expected %BUN_VERSION%.
echo Delete that folder and re-run this script.
goto :fail

:have_bun
if not "%SYS_BUN_VERSION%"=="%BUN_VERSION%" set "PATH=%BUN_DIR%;%PATH%"

set "CLI_DIST=%~dp0packages\cli\dist\cli-windows-x64-baseline"
set "CLI_BIN=%CLI_DIST%\bin\opencode.exe"

rem === Guard: nothing may be running from the dist directory ================
rem A service started from packages\cli\dist locks that directory on Windows
rem and makes the build's cleanup fail with EPERM. Fail fast with a clear hint.
set "DIST_HOLDER="
for /f "delims=" %%p in ('powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'opencode*' -and $_.CommandLine -like '*\packages\cli\dist*' } | Select-Object -ExpandProperty ProcessId"') do set "DIST_HOLDER=%%p"
rem Parens in the echo text stay escaped: an unescaped ) ends the block early
rem and the leftover text is parsed as a command.
if defined DIST_HOLDER (
    echo ERROR: process %DIST_HOLDER% is running from packages\cli\dist.
    echo Stop the background service first ^(opencode service stop^), then re-run.
    goto :fail
)

rem === Build version =========================================================
rem Unique per run: the desktop stages its private CLI under a version-named
rem folder and reuses an existing stage with the same version, so rebuilding
rem with the same version would silently ship the old CLI.
set "OPENCODE_CHANNEL=dev"
rem Local time, so the stamp matches the clock on this machine. The stamp
rem only needs to be unique per run (builds are minutes apart), and on a
rem single machine local time is unambiguous.
for /f "delims=" %%t in ('powershell -NoProfile -Command "(Get-Date).ToString('yyyyMMddHHmmss')"') do set "OPENCODE_VERSION=0.0.0-dev-%%t"
rem Fail fast if the stamp is malformed (for example an empty timestamp from a
rem failing date command): a broken version poisons the whole build and later
rem trips the desktop's version-mismatch replacement.
set "STAMP_OK="
for /f "delims=" %%v in ('powershell -NoProfile -Command "[regex]::IsMatch('%OPENCODE_VERSION%','^0[.]0[.]0-dev-[0-9]{14}$')"') do set "STAMP_OK=%%v"
if /i not "%STAMP_OK%"=="True" (
    echo ERROR: malformed build version [%OPENCODE_VERSION%] - the date command
    echo produced no timestamp. Re-run this script.
    goto :fail
)

echo === Build version %OPENCODE_VERSION% ===

rem === Install dependencies (once) ===========================================
cd /d "%~dp0" || goto :fail
call bun install --frozen-lockfile
if errorlevel 1 goto :fail

rem === 1. Build the CLI with its embedded web UI =============================
rem OPENCODE_TARGET selects the exact package the desktop build packages
rem (cli-windows-x64-baseline); when set, it overrides the --single and
rem --baseline flags. --skip-install: installing is install-all-windows.bat's
rem job.
set "OPENCODE_TARGET=windows-x64-baseline"
cd /d "%~dp0packages\cli" || goto :fail
call bun run build --skip-install
if errorlevel 1 goto :fail
if not exist "%CLI_BIN%" (
    echo ERROR: the CLI build did not produce %CLI_BIN%
    goto :fail
)
echo CLI built: %CLI_BIN%

rem === 2. Build and package the desktop against that CLI =====================
rem OPENCODE_CLI_DIST points the desktop build at the freshly built CLI so it
rem is packaged instead of rebuilt or downloaded. OPENCODE_TARGET selects the
rem windows-x64 CLI package and node-pty prebuild for packaging.
cd /d "%~dp0packages\desktop" || goto :fail
set "OPENCODE_CLI_DIST=%~dp0packages\cli\dist"
set "OPENCODE_TARGET=windows-x64"
call bun run build
if errorlevel 1 goto :fail
call bunx electron-builder --win --x64 --publish never --config electron-builder.config.ts
if errorlevel 1 goto :fail
set "INSTALLER=%~dp0packages\desktop\dist\opencode-desktop-win-x64.exe"
if not exist "%INSTALLER%" (
    echo ERROR: the desktop build did not produce %INSTALLER%
    goto :fail
)
echo Desktop installer built: %INSTALLER%


echo.
echo === Build complete ===
echo Desktop installer: %INSTALLER%
echo CLI binary:        %CLI_BIN%
echo Build version:     %OPENCODE_VERSION%
echo.
echo Nothing was installed and nothing was restarted. To install the CLI and
echo the desktop app, and to optionally restart the background server, run:
echo   install-all-windows.bat
goto :done

:done
del "%LOCK%" >nul 2>nul
endlocal
exit /b 0

:fail
del "%LOCK%" >nul 2>nul
exit /b 1
