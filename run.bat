@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title FrameForge

set "BACKEND_PORT=8765"
set "FRONTEND_URL=http://127.0.0.1:%BACKEND_PORT%/"

echo FrameForge - does NOT start ComfyUI or QwenEdit.
echo Make sure those are running separately when you want to generate.
echo.

where python >nul 2>&1
if errorlevel 1 (
  echo Python not found on PATH.
  pause
  exit /b 1
)

if not exist "backend\.venv\Scripts\python.exe" (
  echo Creating Python venv...
  python -m venv backend\.venv
  if errorlevel 1 (
    echo venv creation failed.
    pause
    exit /b 1
  )
  echo Installing backend dependencies...
  backend\.venv\Scripts\pip install -r backend\requirements.txt
  if errorlevel 1 (
    echo Dependency install failed.
    pause
    exit /b 1
  )
)

if not exist "node_modules" (
  echo Installing frontend dependencies...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

if not exist "dist\index.html" (
  echo Building UI...
  call npm run build
  if errorlevel 1 (
    echo npm run build failed.
    pause
    exit /b 1
  )
)

rem Reuse the backend if something is already listening on the port.
netstat -ano | findstr /c:":%BACKEND_PORT%" | findstr /c:"LISTENING" >nul 2>&1
if errorlevel 1 (
  echo Starting backend on port %BACKEND_PORT%...
  start "FrameForge API" /min cmd /c "cd /d "%~dp0backend" && .venv\Scripts\python.exe -m frameforge"
  echo Waiting for backend...
  set "READY="
  for /l %%i in (1,1,15) do (
    if not defined READY (
      curl -s -o nul "http://127.0.0.1:%BACKEND_PORT%/api/health" && set "READY=1"
      if not defined READY timeout /t 1 /nobreak >nul
    )
  )
  if not defined READY (
    echo Backend did not answer the health check. Look at the "FrameForge API" window for errors.
    pause
    exit /b 1
  )
) else (
  echo Backend already running on port %BACKEND_PORT%.
)

start "" "%FRONTEND_URL%"
echo.
echo Open: %FRONTEND_URL%
echo API:  %FRONTEND_URL%api/health
echo Close the "FrameForge API" window to stop the backend.
pause
