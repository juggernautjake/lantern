@echo off
rem Sets Lantern up on this computer (see scripts\install.ps1 for the options).
rem Double-click it, or run it with --quiet for no questions.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1" %*
exit /b %errorlevel%
