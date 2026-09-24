@echo off
rem One-step setup for local-npc: checks Node, downloads llama.cpp and the models you pick.
rem Usage: install.bat [starter, recommended or all]  (asks if you leave it out)
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required and was not found.
  where winget >nul 2>nul
  if errorlevel 1 (
    echo Install it from https://nodejs.org and run install.bat again.
    pause
    exit /b 1
  )
  choice /m "Install Node.js LTS now with winget"
  if errorlevel 2 exit /b 1
  winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
  echo.
  echo Node.js installed. Close this window and run install.bat again so it is on your PATH.
  pause
  exit /b 0
)

node scripts\install.js %*
echo.
pause
