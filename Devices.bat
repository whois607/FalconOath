@echo off
rem FalconOath: list paired phones and browsers.
cd /d "%~dp0"
set PY=%LOCALAPPDATA%\Programs\Python\Python312\python.exe
title FalconOath devices
"%PY%" -X utf8 -m falconoath devices
echo.
echo To remove one:  "%PY%" -X utf8 -m falconoath unpair ID
echo.
pause
