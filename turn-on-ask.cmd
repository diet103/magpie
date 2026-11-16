@echo off
rem Double-click this to switch on the Ask box in the web app. It asks for your Anthropic API key once.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" -Assistant %*
echo.
pause
