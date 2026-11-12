@echo off
setlocal

echo === Installing dependencies ===
cd /d "%~dp0..\.." || exit /b 1
call bun install --frozen-lockfile
if errorlevel 1 exit /b 1

echo === Building ===
cd /d "%~dp0" || exit /b 1
set OPENCODE_TARGET=windows-x64
call bun run build
if errorlevel 1 exit /b 1

echo === Packaging for Windows ===
call bunx electron-builder --win --x64 --publish never --config electron-builder.config.ts
if errorlevel 1 exit /b 1

echo === Done ===
echo Output: dist\opencode-desktop-win-x64.exe
