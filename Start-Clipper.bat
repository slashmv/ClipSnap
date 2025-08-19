@echo off
title YouTube Clipper Local

:: Start backend (Python/Flask)
start "Backend Server" cmd /k "cd backend && python app.py"

:: Wait a moment for backend to initialize
timeout /t 2 >nul

:: Start frontend (Vite)
start "Frontend Server" cmd /k "cd frontend/frontend && npm run dev"

:: Open browser after a short delay
timeout /t 3 >nul
start http://localhost:5173