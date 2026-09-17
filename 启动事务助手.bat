@echo off
title AI Desk Companion Launcher
cd /d "%~dp0"

if not exist node_modules (
  echo [First run] Installing dependencies, please wait...
  call npm install
  if errorlevel 1 (
    echo npm install failed. Check your network and try again.
    pause
    exit /b 1
  )
)

echo Starting AI Desk Companion...
echo NOTE: To exit, use the tray menu. Closing this window will kill the app.
call npm run dev
