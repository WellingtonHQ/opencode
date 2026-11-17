@echo off
setlocal EnableExtensions

rem === Single-instance lock ================================================
rem Shared with build-all-windows.bat: a build and an install can never run at
rem once, and two installs can't race on the installer and the service. The
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
rem Install everything build-all-windows.bat produced:
rem   1. the CLI binary into %USERPROFILE%\.opencode\bin
rem   2. the desktop app (runs the NSIS installer; the desktop app must be
rem      closed first)
rem   3. stop and restart the background server so the phone's web app picks
rem      up the new interface, then verify it
rem
rem Usage:
rem   install-all-windows.bat               install everything; asks for
rem                                           confirmation before stopping and
rem                                           restarting the background server
rem   install-all-windows.bat --yes         same, but skip all confirmations
rem   install-all-windows.bat --no-desktop  skip the desktop app install
rem   install-all-windows.bat --no-restart  skip the server stop and restart
rem
rem A running background service is stopped before the CLI file is replaced
rem (a running exe locks its own file on Windows) and restarted at the end,
rem unless --no-restart is given.
rem
rem Run build-all-windows.bat first. This script installs and restarts; it
rem builds nothing.
rem ============================================================================

rem === Arguments ==============================================================
set "INSTALL_DESKTOP=1"
set "RESTART_SERVICE=1"
set "SKIP_CONFIRM="
:parse_args
if "%~1"=="" goto :args_done
if /i "%~1"=="--no-desktop" goto :arg_known
if /i "%~1"=="--no-restart" goto :arg_known
if /i "%~1"=="--yes" goto :arg_known
echo ERROR: unknown argument %~1 (use --yes, --no-desktop or --no-restart)
goto :fail
:arg_known
if /i "%~1"=="--no-desktop" set "INSTALL_DESKTOP="
if /i "%~1"=="--no-restart" set "RESTART_SERVICE="
if /i "%~1"=="--yes" set "SKIP_CONFIRM=1"
shift
goto :parse_args
:args_done
if not defined INSTALL_DESKTOP echo Skipping: desktop app install
if not defined RESTART_SERVICE echo Skipping: server stop and restart

set "CLI_DIST=%~dp0packages\cli\dist\cli-windows-x64-baseline"
set "CLI_BIN=%CLI_DIST%\bin\opencode.exe"
set "CLI_PKG=%CLI_DIST%\package.json"
set "DESKTOP_CLI_VERSION_FILE=%~dp0packages\desktop\resources\opencode-cli.version"
set "INSTALLER=%~dp0packages\desktop\dist\opencode-desktop-win-x64.exe"

rem === Pre-flight checks ======================================================
if not exist "%CLI_BIN%" (
    echo ERROR: no built CLI at %CLI_BIN%. Run build-all-windows.bat first.
    goto :fail
)
if not exist "%INSTALLER%" (
    echo ERROR: no desktop installer at %INSTALLER%. Run build-all-windows.bat first.
    goto :fail
)

rem The desktop installer must bundle the same CLI version as the one being
rem installed: on start, the desktop adopts a running server that matches its
rem bundled CLI version, and replaces one that does not.
set "CLI_VERSION="
for /f "delims=" %%v in ('powershell -NoProfile -Command "(Get-Content -LiteralPath '%CLI_PKG%' -Raw | ConvertFrom-Json).version"') do set "CLI_VERSION=%%v"
set "DESKTOP_CLI_VERSION="
for /f "delims=" %%v in ('type "%DESKTOP_CLI_VERSION_FILE%" 2^>nul') do set "DESKTOP_CLI_VERSION=%%v"
if not defined CLI_VERSION (
    echo ERROR: could not read the CLI version from %CLI_PKG%
    goto :fail
)
if not defined DESKTOP_CLI_VERSION (
    echo ERROR: could not read the bundled CLI version from %DESKTOP_CLI_VERSION_FILE%
    goto :fail
)
if not "%CLI_VERSION%"=="%DESKTOP_CLI_VERSION%" (
    echo ERROR: CLI version %CLI_VERSION% does not match the desktop's bundled
    echo CLI version %DESKTOP_CLI_VERSION%. Run build-all-windows.bat to build
    echo both in the same pass.
    goto :fail
)
echo Build version: %CLI_VERSION%

rem === Confirm: stop and restart the background server =======================
rem Stopping is required before the CLI file is replaced: a service running
rem from %USERPROFILE%\.opencode\bin locks that file on Windows. The restart
rem and verification happen below. --yes skips the confirmation.
if not defined RESTART_SERVICE goto :skip_confirm
if defined SKIP_CONFIRM goto :skip_confirm
echo.
echo This will STOP and RESTART the background server. Any active agent
echo sessions and their persistent terminals are interrupted; the phone and
echo desktop reconnect automatically to the same address with the same
echo credentials.
echo.
set "CONFIRM="
set /p "CONFIRM=" Restart the background server? [y/N] 
if /i "%CONFIRM%"=="y" goto :skip_confirm
echo Aborted: nothing was installed and the server was not touched.
goto :done
:skip_confirm

rem === Stop the running background service ====================================
rem Stop every serve --service process, not just one: the background service
rem and the desktop app's bundled CLI can both run one, and a survivor keeps
rem the old version serving (or locks the CLI file) through the copy below.
if not defined RESTART_SERVICE goto :service_stop_done
set "SERVICE_STOPPED="
for /f "delims=" %%p in ('powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'opencode*' -and $_.CommandLine -like '*serve --service*' } | Select-Object -ExpandProperty ProcessId"') do (
    echo Stopping the running background service ^(pid %%p^).
    taskkill /PID %%p /F
    if errorlevel 1 goto :fail
    set "SERVICE_STOPPED=1"
)
if not defined SERVICE_STOPPED echo No running background service found.
rem A survivor means something (usually the desktop app) respawned the
rem service: fail loudly instead of copying over a locked file.
for /f "delims=" %%r in ('powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'opencode*' -and $_.CommandLine -like '*serve --service*' } | Select-Object -ExpandProperty ProcessId"') do (
    echo ERROR: a background service ^(pid %%r^) survived the stop.
    echo Close the desktop app and re-run.
    goto :fail
)
:service_stop_done

rem === 1. Install the CLI =====================================================
if not exist "%USERPROFILE%\.opencode\bin" mkdir "%USERPROFILE%\.opencode\bin" || goto :fail
copy /y "%CLI_BIN%" "%USERPROFILE%\.opencode\bin\" || (
    echo ERROR: could not copy the CLI into %USERPROFILE%\.opencode\bin.
    echo A running process may be locking the file. Stop the service and the
    echo desktop app, then re-run.
    goto :fail
)
echo CLI installed: %USERPROFILE%\.opencode\bin\opencode.exe
echo %PATH% | findstr /i "%USERPROFILE%\.opencode\bin" >nul
if errorlevel 1 (
    echo WARNING: %USERPROFILE%\.opencode\bin is not in your PATH. Add it to
    echo run "opencode" from any terminal.
)

rem === 2. Install the desktop app ============================================
if not defined INSTALL_DESKTOP goto :skip_desktop
echo.
echo Installing the desktop app. It must be CLOSED for the installer to
echo replace its files.
rem The NSIS installer cannot replace files that are in use: fail with a clear
rem message instead of leaving a half-installed app.
tasklist /FI "IMAGENAME eq OpenCode Dev.exe" | findstr /I "OpenCode Dev.exe" >nul
if not errorlevel 1 (
    echo ERROR: the desktop app is running. Close it and re-run.
    goto :fail
)
start /wait "" "%INSTALLER%"
if errorlevel 1 (
    echo WARNING: the desktop installer did not complete successfully
) else (
    echo Desktop app installed
)
:skip_desktop

rem === 3. Restart the background server ======================================
rem "opencode service restart" starts the freshly installed CLI as the
rem registered service. The address, port and credentials come from the user
rem environment, so clients reconnect without re-authenticating.
if not defined RESTART_SERVICE goto :done

echo.
echo Restarting the background server.

rem Start the service from the installed CLI, not from the build output: a
rem service running from packages\cli\dist locks that directory on Windows
rem and breaks the next build.
set "OPENCODE_VERSION=%CLI_VERSION%"
"%USERPROFILE%\.opencode\bin\opencode.exe" service restart
if errorlevel 1 (
    echo ERROR: opencode service restart failed
    goto :fail
)

rem === 4. Verify the new server ==============================================
rem Reads the registration file, checks it is on the expected port, authenticates
rem against /api/info, checks the running version, and fetches the web UI shell
rem plus its entry script. The credential is used only inside PowerShell and
rem never printed.
set "VERIFY_PS1=%TEMP%\opencode-verify-%RANDOM%-%RANDOM%.ps1"
> "%VERIFY_PS1%" echo $ErrorActionPreference = 'Stop'
>> "%VERIFY_PS1%" echo $reg = Join-Path $env:USERPROFILE '.local\state\opencode\service.json'
>> "%VERIFY_PS1%" echo $info = Get-Content $reg -Raw ^| ConvertFrom-Json
>> "%VERIFY_PS1%" echo $expectedPort = $env:OPENCODE_SERVER_PORT
>> "%VERIFY_PS1%" echo if ($expectedPort -and ([uri]$info.url).Port -ne [int]$expectedPort) { throw ('server is on port ' + ([uri]$info.url).Port + ', expected ' + $expectedPort) }
>> "%VERIFY_PS1%" echo $cred = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($info.username + ':' + $info.password))
>> "%VERIFY_PS1%" echo $h = @{ Authorization = 'Basic ' + $cred }
>> "%VERIFY_PS1%" echo $api = Invoke-WebRequest -Uri ($info.url + '/api/info') -Headers $h -UseBasicParsing
>> "%VERIFY_PS1%" echo $server = $api.Content ^| ConvertFrom-Json
>> "%VERIFY_PS1%" echo if ($server.version -ne $env:OPENCODE_VERSION) { throw ('server version ' + $server.version + ' does not match ' + $env:OPENCODE_VERSION) }
>> "%VERIFY_PS1%" echo if ($server.pid -ne $info.pid) { throw 'server process does not match the registration' }
>> "%VERIFY_PS1%" echo $shell = Invoke-WebRequest -Uri $info.url -Headers $h -UseBasicParsing
>> "%VERIFY_PS1%" echo $m = [regex]::Match($shell.Content, '^<script[^^^>]*\bsrc="(/_assets/[^"]+\.js)"')
>> "%VERIFY_PS1%" echo if (-not $m.Success) { throw 'web UI shell names no entry script' }
>> "%VERIFY_PS1%" echo $entry = Invoke-WebRequest -Uri ($info.url + $m.Groups[1].Value) -Headers $h -UseBasicParsing
>> "%VERIFY_PS1%" echo if ([int]$entry.Content.Length -eq 0) { throw 'web UI entry script is empty' }
>> "%VERIFY_PS1%" echo Write-Output ('server ' + $server.version + ' at ' + $info.url + ' is serving the new web UI')
powershell -NoProfile -ExecutionPolicy Bypass -File "%VERIFY_PS1%"
set "VERIFY_ERROR=%errorlevel%"
del "%VERIFY_PS1%" >nul 2>nul
if not "%VERIFY_ERROR%"=="0" (
    echo ERROR: the server restarted but verification failed
    goto :fail
)

echo.
echo The phone now reaches the new web UI. If it still looks old, force a
echo reload of the page (the web app can cache its interface).
if defined INSTALL_DESKTOP goto :done
echo.
echo NOTE: the desktop app was not updated. The previously installed desktop
echo app bundles the older CLI and would replace the server with it if started.
goto :done

:done
del "%LOCK%" >nul 2>nul
endlocal
exit /b 0

:fail
del "%LOCK%" >nul 2>nul
exit /b 1
