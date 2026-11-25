@echo off
setlocal
REM ============================================================
REM  SelectPop 开发模式启动器（双击运行，无需管理员权限）
REM ============================================================
cd /d "%~dp0"
call "scripts\win-preflight.cmd"
if errorlevel 1 (
  pause
  exit /b 1
)

echo [SelectPop] 数据目录： %SELECTPOP_DATA_DIR%
echo [SelectPop] 启动开发模式（控制台会打印日志）...
echo.

"node_modules\electron\dist\electron.exe" . --dev --user-data-dir="%SELECTPOP_DATA_DIR%\data" %SELECTPOP_EXTRA_ARGS%
set "CODE=%ERRORLEVEL%"

if "%CODE%"=="-2147483645" goto retry
if "%CODE%"=="-1073741819" goto retry
if "%CODE%"=="3221225595" goto retry
goto report

:retry
echo.
echo [提示] Chromium 沙箱初始化被系统拒绝，改用 --no-sandbox 重试...
"node_modules\electron\dist\electron.exe" . --dev --user-data-dir="%SELECTPOP_DATA_DIR%\data" --no-sandbox
set "CODE=%ERRORLEVEL%"

:report
echo.
echo [SelectPop] 进程已退出，退出码 = %CODE%
if not "%CODE%"=="0" (
  echo.
  echo 退出码说明：
  echo   -2147483645  ^(0x80000003^) = Chromium 初始化被系统拒绝（非交互式桌面 / 安全软件拦截）
  echo   -1073741819  ^(0xC0000005^) = Chromium 初始化访问冲突（同上）
  echo   0                           = 正常退出（可能是单实例锁：已有托盘实例在跑）
)
echo.
echo 日志： "%SELECTPOP_DATA_DIR%\logs\selectpop.log"
echo.
pause
