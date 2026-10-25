@echo off
rem FalconOath: start the listener in its own window (if it isn't running yet),
rem then open the app. The desktop icon (Setup FalconOath.bat) does the same.
rem In the listener window press P for a pairing code, D for devices, Q to stop.
cd /d "%~dp0"
set PY=%LOCALAPPDATA%\Programs\Python\Python312\python.exe
if not exist "%PY%" (echo Python 3.12 not found at %PY% & pause & exit /b 1)
"%PY%" -X utf8 -m falconoath open
