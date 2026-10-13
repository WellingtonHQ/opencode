@echo off
setlocal

echo === Installing dependencies ===
cd /d "%~dp0..\.." || exit /b 1
call bun install --frozen-lockfile
if errorlevel 1 exit /b 1

echo === Prebuilding ===
cd /d "%~dp0" || exit /b 1
call bun run prebuild
if errorlevel 1 exit /b 1

echo === Building ===
call bun run build
if errorlevel 1 exit /b 1

echo === Packaging for Windows ===
call bun run package:win
if errorlevel 1 exit /b 1

echo === Done ===
echo Output: dist\opencode-desktop-win-x64.exe
