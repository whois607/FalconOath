@echo off
rem FalconOath without the .exe: start the listener out of sight (if it isn't
rem running yet), then open FalconOath's window. FalconOath.exe does the same.
rem Pairing, devices, folders and Stop are in Settings in that window.
cd /d "%~dp0"
set PY=%LOCALAPPDATA%\Programs\Python\Python312\python.exe
if not exist "%PY%" (echo Python 3.12 not found at %PY% & pause & exit /b 1)
start "" "%LOCALAPPDATA%\Programs\Python\Python312\pythonw.exe" -X utf8 -m falconoath app
