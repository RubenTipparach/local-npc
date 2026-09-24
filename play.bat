@echo off
rem Starts local-npc and opens it in your browser. Press Ctrl+C in this window to stop.
rem   play.bat --cli    play in this window instead (text mode, /quit to exit)
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Run install.bat first.
  pause
  exit /b 1
)

node scripts\play.js %*
if errorlevel 1 pause
