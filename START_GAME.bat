@echo off
setlocal
cd /d "%~dp0"
title NEON STRIKE - Game Launcher
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed.
  echo Please install the latest Node.js LTS from https://nodejs.org/en/download
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing game dependencies. This happens only the first time...
  call npm install
  if errorlevel 1 (
    echo [ERROR] Dependency installation failed. Check your internet connection.
    pause
    exit /b 1
  )
)
echo Starting NEON STRIKE...
start "NEON STRIKE browser" cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:3000"
call npm run dev
pause
