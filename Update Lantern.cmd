@echo off
rem Checks for a newer Lantern and installs it if you say yes. Your data is backed up first and never touched.
cd /d "%~dp0"
where node >nul 2>nul || ( echo Lantern needs Node.js. Run "Install Lantern.cmd" first. & pause & exit /b 1 )
node scripts\update.mjs %*
echo.
pause
