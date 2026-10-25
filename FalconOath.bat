@echo off
rem FalconOath: start the listener in its own window, then open the app.
rem The phone uses the Tailscale address shown in that window.
cd /d "%~dp0"
set PY=%LOCALAPPDATA%\Programs\Python\Python312\python.exe
start "FalconOath listener" "%PY%" -X utf8 -m falconoath serve
timeout /t 3 /nobreak >nul
start "" http://localhost:8767/
