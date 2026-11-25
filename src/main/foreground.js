'use strict';

const { execFile } = require('node:child_process');

/**
 * 读取窗口信息（Windows 专用，靠 assets/bin/wininfo.exe）。
 *
 * 为什么需要它：划词失败时最要紧的一件事是「Ctrl+C 到底发给了哪个窗口」——
 * 拖拽在 A 窗口结束、但焦点已经跑到 B 窗口（通知气泡、刚弹出的弹窗、远程桌面
 * 工具抢焦点）时，浏览器里明明选中了文字，剪贴板却纹丝不动。
 */
function runWinInfo({ args = [], helperPath, execFileImpl = execFile, timeoutMs = 1500 } = {}) {
  if (process.platform !== 'win32' || !helperPath) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFileImpl(helperPath, args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
      if (error || !stdout) {
        resolve(null);
        return;
      }
      const line = String(stdout).split(/\r?\n/).find((item) => item.trim()) || '';
      const [hwndRaw, pidRaw, processName = '', ...rest] = line.split('\t');
      const hwnd = Number.parseInt(hwndRaw, 10);
      if (!Number.isFinite(hwnd) || hwnd === 0) {
        resolve(null);
        return;
      }
      resolve({
        hwnd,
        pid: Number.parseInt(pidRaw, 10) || 0,
        process: processName.trim(),
        title: rest.join('\t').trim(),
      });
    });
  });
}

/** 当前前台窗口 → `{hwnd, pid, process, title}` 或 null */
function describeForeground(options = {}) {
  return runWinInfo({ ...options, args: [] });
}

/** 屏幕物理坐标 (x, y) 处的窗口 → `{hwnd, pid, process, title}` 或 null */
function describeWindowAt(x, y, options = {}) {
  const px = Math.round(Number(x));
  const py = Math.round(Number(y));
  if (!Number.isFinite(px) || !Number.isFinite(py)) return Promise.resolve(null);
  return runWinInfo({ ...options, args: ['at', String(px), String(py)] });
}

module.exports = { describeForeground, describeWindowAt, runWinInfo };
