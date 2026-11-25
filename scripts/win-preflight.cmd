@echo off
REM ============================================================
REM  SelectPop Windows 启动前置检查（被 run-dev.cmd / run-smoke.cmd 调用）
REM  作用：补齐 PATH、清掉 DSH 注入的环境变量、准备一个确定可写的数据目录
REM  产出变量：SELECTPOP_DATA_DIR / SELECTPOP_EXTRA_ARGS
REM ============================================================

REM 1) 内置 Node（本机没有全局 node 时也能让 pnpm 脚本找到 node）
set "NODE_BIN=C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin"
if exist "%NODE_BIN%\node.exe" set "PATH=%NODE_BIN%;%PATH%"

REM 2) DSH 会话里普遍存在 ELECTRON_RUN_AS_NODE=1，不删掉 electron.exe 会当 Node 跑
set "ELECTRON_RUN_AS_NODE="
set "SELECTPOP_DISABLE_GPU="

REM 3) 检查 Electron 是否就绪
if not exist "node_modules\electron\dist\electron.exe" (
  echo [错误] 找不到 node_modules\electron\dist\electron.exe
  echo        请先在项目目录执行： pnpm install
  echo        然后执行： node node_modules\electron\install.js
  exit /b 1
)

REM 4) 开发启动器固定用项目内 .data 当数据目录：
REM    免去 %APPDATA% 可能存在的权限/ACL 问题（那会导致 0xc0000142 或单实例锁拿不到）
set "SELECTPOP_DATA_DIR=%CD%\.data"
mkdir "%SELECTPOP_DATA_DIR%\temp" 2>nul
mkdir "%SELECTPOP_DATA_DIR%\data" 2>nul

REM 5) TEMP 指向可写目录，Chromium 启动要在这写共享内存
set "TEMP=%SELECTPOP_DATA_DIR%\temp"
set "TMP=%SELECTPOP_DATA_DIR%\temp"

REM 6) 数据目录不在系统默认位置，沙箱常常起不来，直接带 --no-sandbox
set "SELECTPOP_EXTRA_ARGS=--no-sandbox"

exit /b 0
