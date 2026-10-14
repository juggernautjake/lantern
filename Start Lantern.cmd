@echo off
rem Opens Lantern (starting it first if it is not running). Only one copy ever runs.
cd /d "%~dp0"
where node >nul 2>nul || ( echo Lantern needs Node.js. Run "Install Lantern.cmd" first. & pause & exit /b 1 )
node scripts\launch.mjs %*
