@echo off
setlocal
REM ============================================================
REM  SelectPop 冒烟测试启动器（双击运行）
REM  产出：artifacts\popup-idle.png / popup-result.png / popup-result-dark.png / settings.png
REM ============================================================
cd /d "%~dp0"
call "scripts\win-preflight.cmd"
if errorlevel 1 (
  pause
  exit /b 1
)

if exist "artifacts\*.png" del /q "artifacts\*.png" >nul 2>nul

echo [SelectPop] 数据目录： %SELECTPOP_DATA_DIR%
echo [SelectPop] 正在跑冒烟测试...
echo.

"node_modules\electron\dist\electron.exe" . --smoke --user-data-dir="%SELECTPOP_DATA_DIR%\data" %SELECTPOP_EXTRA_ARGS%
set "CODE=%ERRORLEVEL%"

if "%CODE%"=="-2147483645" goto retry
if "%CODE%"=="-1073741819" goto retry
if "%CODE%"=="3221225595" goto retry
goto report

:retry
echo.
echo [提示] Chromium 沙箱初始化被系统拒绝，改用 --no-sandbox 重试...
"node_modules\electron\dist\electron.exe" . --smoke --user-data-dir="%SELECTPOP_DATA_DIR%\data" --no-sandbox
set "CODE=%ERRORLEVEL%"

:report
echo.
echo [SelectPop] 退出码 = %CODE%  ^(0 = 全部截图成功^)
echo.
if exist "artifacts\*.png" (
  dir /b "artifacts\*.png"
) else (
  echo [警告] artifacts 下没有生成截图，看日志： "%SELECTPOP_DATA_DIR%\logs\selectpop.log"
)
echo.
pause
