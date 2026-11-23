@echo off
REM ============================================================================
REM Jindal Steel & Power - SMS Digital Transformation & Automation
REM In-Motion Weighbridge Dashboard - Windows production start script
REM
REM Runs serve.py (waitress, 16 worker threads by default). All settings
REM (database, port, threads, admin key) are read from the .env file.
REM ============================================================================
setlocal
cd /d "%~dp0"
TITLE IMWB Weighbridge Production Server

REM Use the environment made by setup_venv.bat (.venv); an older "venv" also works
set "PY=python"
if exist ".venv\Scripts\python.exe" (
    set "PY=.venv\Scripts\python.exe"
) else if exist "venv\Scripts\python.exe" (
    set "PY=venv\Scripts\python.exe"
) else (
    echo [INFO] No virtual environment found, using system Python.
)

REM Install the requirements if any of the main packages is missing
"%PY%" -c "import flask, waitress, openpyxl, tzdata" 2>nul
if errorlevel 1 (
    echo [WARNING] Required packages are missing. Installing from requirements.txt...
    "%PY%" -m pip install -r requirements.txt
    if errorlevel 1 (
        echo [ERROR] Package installation failed. Check the network connection and try again.
        pause
        exit /b 1
    )
)

echo.
echo Starting the dashboard. Press CTRL+C to stop it.
echo.
"%PY%" serve.py

echo.
echo The server has stopped.
pause
