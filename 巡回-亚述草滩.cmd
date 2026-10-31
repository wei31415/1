@echo off
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0patrol.ps1" -Key m3
echo.
pause
