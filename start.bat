@echo off
title OmniFlow: Dynamic Elastic Micro-Phasing Traffic Controller
echo ===================================================================
echo     OMNIFLOW: DYNAMIC ELASTIC MICRO-PHASING (EDGE-AI) CONTROLLER
echo ===================================================================
echo.

set PYTHON_CMD=python
where python >nul 2>nul
if %errorlevel% neq 0 (
    if exist "%LOCALAPPDATA%\Programs\Thonny\python.exe" (
        set PYTHON_CMD="%LOCALAPPDATA%\Programs\Thonny\python.exe"
    )
)

echo Starting Backend Server on http://localhost:8000 and ws://localhost:8765...
start "" http://localhost:8000

%PYTHON_CMD% "%~dp0backend\server.py"

if %errorlevel% neq 0 (
    echo.
    echo [Notice] Python backend was stopped or not installed in PATH.
    echo Opening frontend directly in your default browser (Standalone Mode)...
    start "" "%~dp0frontend\index.html"
)
pause
