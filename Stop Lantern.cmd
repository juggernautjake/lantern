@echo off
rem Stops Lantern. Your data is saved as you go, so nothing is lost.
cd /d "%~dp0"
node scripts\launch.mjs --stop
