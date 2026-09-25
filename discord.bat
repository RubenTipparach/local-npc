@echo off
rem Runs Bramblewick as a Discord bot on this computer. The first run walks you through setup.
rem Press Ctrl+C in this window to close the town (the bot posts that it's closed and goes offline).
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Run install.bat first.
  pause
  exit /b 1
)

node scripts\play.js --discord %*
if errorlevel 1 pause
