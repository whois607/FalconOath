@echo off
rem FalconOath: show a six-digit code to pair a phone or browser.
rem The listener (FalconOath.bat) must be running for the code to be used.
cd /d "%~dp0"
set PY=%LOCALAPPDATA%\Programs\Python\Python312\python.exe
if not exist "%PY%" (echo Python 3.12 not found at %PY% & pause & exit /b 1)
title FalconOath pairing
"%PY%" -X utf8 -m falconoath pair
echo.
pause
