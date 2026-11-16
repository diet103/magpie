@echo off
rem Double-click this, or run it from a terminal. Options are passed through, e.g.  setup.cmd -Backups
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
echo.
pause
