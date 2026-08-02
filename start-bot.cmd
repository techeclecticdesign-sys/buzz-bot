@echo off
REM RPC Logger Bot launcher (Windows) -- double-click to run.
REM Backfills recent history once, then starts the bot and keeps it alive,
REM restarting it automatically if it crashes. Close this window to stop.
setlocal
cd /d "%~dp0"
title RPC Logger Bot

REM --- Node installed? ---
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo ERROR: Node.js was not found on this machine.
  echo Install Node 18 or newer from https://nodejs.org then double-click this file again.
  echo.
  pause
  exit /b 1
)

REM --- config present? ---
if not exist ".env" (
  echo.
  echo ERROR: .env not found in this folder.
  echo Copy .env.example to .env and fill in your token / database URL first.
  echo.
  pause
  exit /b 1
)

REM --- first run: install dependencies ---
if not exist "node_modules" (
  echo First run: installing dependencies, this may take a minute...
  call npm install
  if errorlevel 1 (
    echo.
    echo npm install failed -- see the messages above.
    pause
    exit /b 1
  )
)

REM --- backfill recent history once ---
echo Backfilling recent history...
call npm run backfill

REM --- run the bot, restarting if it crashes ---
:loop
echo.
echo Starting bot...
call npm start
echo.
echo Bot stopped (exit code %errorlevel%). Restarting in 5s -- close this window to stop.
timeout /t 5 >nul
goto loop
