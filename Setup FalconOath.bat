@echo off
rem Builds FalconOath.exe (dist\FalconOath\) and puts a "FalconOath" shortcut on
rem the Desktop, in the Start menu and in this folder. Run it again after a
rem change to FalconOath's Python (screens change without it). About a minute.
cd /d "%~dp0"
set "PY=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if not exist "%PY%" (echo Python 3.12 not found at %PY% & pause & exit /b 1)
"%PY%" -m pip install --disable-pip-version-check -q -r requirements.txt
"%PY%" -X utf8 tools\build_exe.py
echo.
pause
