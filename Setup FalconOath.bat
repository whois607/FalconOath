@echo off
rem One-time setup: draws the FalconOath icon and puts a "FalconOath" shortcut
rem on the Desktop, in the Start menu and in this folder.
rem After this, just double-click "FalconOath".
cd /d "%~dp0"
set "PY=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if not exist "%PY%" (echo Python 3.12 not found at %PY% & pause & exit /b 1)
"%PY%" -X utf8 tools\make_launcher.py
echo.
pause
