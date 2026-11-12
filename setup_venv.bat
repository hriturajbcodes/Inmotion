@echo off
setlocal

:: Define the environment folder name
set "VENV_DIR=.venv"

:: Check if Python is installed and accessible in PATH
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python was not found in your PATH. Please install Python or add it to PATH.
    pause
    exit /b 1
)

:: Create the virtual environment if it does not already exist
if not exist "%VENV_DIR%\Scripts\activate.bat" (
    echo [*] Creating virtual environment in "%VENV_DIR%"...
    python -m venv "%VENV_DIR%"
    if errorlevel 1 (
        echo [ERROR] Failed to create virtual environment.
        pause
        exit /b 1
    )
    echo [*] Virtual environment created successfully.
) else (
    echo [*] Virtual environment "%VENV_DIR%" already exists.
)

:: Upgrade pip
echo [*] Upgrading pip...
call "%VENV_DIR%\Scripts\python.exe" -m pip install --upgrade pip

:: Install dependencies if requirements.txt exists
if exist "requirements.txt" (
    echo [*] Installing dependencies from requirements.txt...
    call "%VENV_DIR%\Scripts\pip.exe" install -r requirements.txt
) else (
    echo [*] No requirements.txt found. Skipping package installation.
)

echo.
echo ========================================================
echo Virtual environment ready. Launching activated terminal.
echo ========================================================
echo.

:: Keep the command prompt open with the environment activated
cmd /k "%VENV_DIR%\Scripts\activate.bat"