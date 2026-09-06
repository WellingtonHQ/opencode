@echo off
setlocal EnableExtensions

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0add-to-path.ps1"
if errorlevel 1 exit /b 1
