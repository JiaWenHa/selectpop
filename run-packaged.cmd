@echo off
setlocal
REM ============================================================
REM  启动打包版（dist\win-unpacked\SelectPop.exe）
REM  有问题时先跑这个：它会把数据目录和 TEMP 都放到项目内可写位置
REM  用法：可选参数 --smoke（生成截图后自动退出）
REM ============================================================
cd /d "%~dp0"
set "EXE=dist\win-unpacked\SelectPop.exe"
if not exist "%EXE%" (
  echo [错误] 还没有打包，先执行： pnpm dist:dir
  pause
  exit /b 1
)

set "ELECTRON_RUN_AS_NODE="
set "DATA=%CD%\.data\packaged"
mkdir "%DATA%\temp" 2>nul
set "TEMP=%DATA%\temp"
set "TMP=%DATA%\temp"

echo [SelectPop] 数据目录： %DATA%
echo [SelectPop] 启动打包版...
echo.

"%EXE%" --user-data-dir="%DATA%\data" --no-sandbox %*
set "CODE=%ERRORLEVEL%"
echo.
echo [SelectPop] 退出码 = %CODE%
echo   0 = 正常退出
echo   -2147483645 ^(0x80000003^) / -1073741819 ^(0xC0000005^) = Chromium 被系统拒绝
echo   3221225794 ^(0xC0000142^) = DLL 初始化失败
echo.
echo 日志： "%DATA%\data\logs\selectpop.log"
echo.
pause
