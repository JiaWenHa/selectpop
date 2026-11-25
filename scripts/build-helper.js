'use strict';

// 编译 Windows 上的两个小工具（都在 assets/bin 下）：
//   sendcopy.exe  发 Ctrl+C（SendInput + 扫描码），支持 serve 常驻 / focuscopy <hwnd>
//   wininfo.exe   打印当前前台窗口的 hwnd/pid/进程名/标题，用于定位「焦点跑哪去了」
//
// 为什么要预编译而不是运行时 Add-Type：在 Electron 派生的 PowerShell 进程里，
// Add-Type 的运行时 C# 编译会报「客户端没有所需的特权」(ERROR_PRIVILEGE_NOT_HELD)，
// 而且编译本身要几百毫秒。预编译成几 KB 的 exe 之后，按键注入只要几毫秒。
//
// 只需要 Windows + .NET Framework（Win10/11 自带），macOS/Linux 上直接跳过。
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'assets', 'bin');

const TARGETS = [
  {
    name: 'sendcopy',
    source: path.join(root, 'native', 'win-sendcopy', 'SendCopy.cs'),
  },
  {
    name: 'wininfo',
    source: path.join(root, 'native', 'win-foreground', 'WinForeground.cs'),
  },
];

function findCsc() {
  const candidates = [
    'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
    'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
  ];
  return candidates.find((file) => fs.existsSync(file)) || null;
}

function buildOne(csc, target) {
  const outFile = path.join(outDir, `${target.name}.exe`);
  // 先编译到临时名字：正在运行的 SelectPop 可能已经把 sendcopy.exe 当常驻进程用着，
  // 直接写目标文件会拿到 CS0016「无法写入输出文件」。
  const staging = path.join(outDir, `${target.name}.build.exe`);
  const args = ['/nologo', '/target:exe', '/platform:anycpu', '/optimize+', `/out:${staging}`, target.source];
  const result = spawnSync(csc, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    console.error(`[build-helper] ${target.name} 编译失败`);
    console.error(result.stdout || '');
    console.error(result.stderr || '');
    return false;
  }
  try {
    fs.renameSync(staging, outFile);
  } catch (error) {
    try {
      fs.unlinkSync(staging);
    } catch {
      /* ignore */
    }
    console.warn(`[build-helper] 无法覆盖 ${path.relative(root, outFile)}（${error.code || error.message}），` +
      '请先退出正在运行的 SelectPop 再重试；现有的 exe 仍然可用');
    return true;
  }
  console.log(`[build-helper] 已生成 ${path.relative(root, outFile)} (${fs.statSync(outFile).size} 字节)`);
  return true;
}

function main() {
  if (process.platform !== 'win32') {
    console.log('[build-helper] 非 Windows，跳过（macOS 用 osascript 发 Cmd+C）');
    return;
  }
  const csc = findCsc();
  if (!csc) {
    console.warn('[build-helper] 找不到 csc.exe（.NET Framework 4.x），保留现有的 assets/bin/*.exe');
    return;
  }
  fs.mkdirSync(outDir, { recursive: true });
  let ok = true;
  for (const target of TARGETS) {
    if (!buildOne(csc, target)) ok = false;
  }
  if (!ok) process.exitCode = 1;
}

main();
