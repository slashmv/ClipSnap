@echo off
setlocal enabledelayedexpansion
title YouTube Clipper Local

:: Check if Python is installed
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo Python is not installed! Please install Python 3.8 or newer.
    echo Download from: https://www.python.org/downloads/
    pause
    exit /b 1
)

:: Check if Node.js is installed
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo Node.js is not installed! Please install Node.js LTS.
    echo Download from: https://nodejs.org/
    pause
    exit /b 1
)

:: Check if venv exists, if not create it
if not exist "venv" (
    echo Creating virtual environment...
    python -m venv venv
    
    echo Installing Python dependencies...
    call venv\Scripts\activate
    pip install flask flask-cors yt-dlp python-dateutil
    
    echo Installing frontend dependencies...
    cd frontend/frontend
    call npm install
    cd ../..
)

:: Activate venv
call venv\Scripts\activate

:: Check if FFmpeg exists in PATH
ffmpeg -version >nul 2>&1
if %errorlevel% neq 0 (
    echo FFmpeg not found in PATH!
    echo Downloading FFmpeg...
    
    :: Download and extract FFmpeg
    powershell -Command "Invoke-WebRequest -Uri 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip' -OutFile 'ffmpeg.zip'"
    powershell -Command "Expand-Archive -Path 'ffmpeg.zip' -DestinationPath 'ffmpeg_temp'"
    
    :: Add FFmpeg to PATH for current session
    set "PATH=%CD%\ffmpeg_temp\ffmpeg-master-latest-win64-gpl\bin;%PATH%"
)

:: Create necessary directories if they don't exist
if not exist "backend\clips" mkdir "backend\clips"
if not exist "backend\tmp" mkdir "backend\tmp"

:: Kill any existing processes on ports 5000 and 5173
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":5000"') do taskkill /F /PID %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":5173"') do taskkill /F /PID %%a >nul 2>&1

echo Starting YouTube Clipper...

:: Start backend (Python/Flask)
start "Backend Server" cmd /k "call venv\Scripts\activate && cd backend && python app.py"

:: Wait for backend to initialize
timeout /t 2 >nul

:: Start frontend (Vite)
start "Frontend Server" cmd /k "cd frontend/frontend && npm run dev"

:: Wait for frontend to start
timeout /t 3 >nul

:: Open browser
start http://localhost:5173

echo YouTube Clipper is running!
echo Close this window to stop all servers.

:: Keep the script running and monitor child processes
:loop
timeout /t 1 >nul
tasklist | find "cmd.exe" >nul
if %errorlevel% equ 0 goto loop

:: Clean up when the user closes the window
taskkill /F /FI "WindowTitle eq Backend Server*" >nul 2>&1
taskkill /F /FI "WindowTitle eq Frontend Server*" >nul 2>&1