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

rem Rebuild only when src/resources are newer than the build output
node scripts\check-build.mjs
if errorlevel 1 (
  echo [Update] Building app, please wait...
  call npm run build
  if errorlevel 1 (
    echo Build failed. Run "npm run build" to see details.
    pause
    exit /b 1
  )
)

rem Launch detached GUI process: no console window stays open
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
exit /b 0
