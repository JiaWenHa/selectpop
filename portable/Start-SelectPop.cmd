@echo off
setlocal
cd /d "%~dp0"

set "ELECTRON_RUN_AS_NODE="
set "DATA=%CD%\.data"
mkdir "%DATA%\temp" 2>nul
set "TEMP=%DATA%\temp"
set "TMP=%DATA%\temp"

echo [SelectPop] Data dir: %DATA%
echo [SelectPop] Starting...
"SelectPop.exe" --user-data-dir="%DATA%" --no-sandbox %*

echo.
echo [SelectPop] Exited with code %ERRORLEVEL%
echo Log: %DATA%\logs\selectpop.log
pause
