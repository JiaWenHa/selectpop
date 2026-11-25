'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

/**
 * 向「当前前台窗口」发送复制快捷键。
 *
 * 为什么不用 robotjs / nut-js：它们需要为每个 Electron ABI 重新编译原生模块，
 * 在 Windows 上还要装 VS Build Tools。
 *
 * Windows 上踩过的三个坑（Win11 22621 实测）：
 *  1. System.Windows.Forms.SendKeys：假成功，按键根本没送到前台窗口。
 *  2. PowerShell + Add-Type 运行时编译 C#：在 Electron 派生的 PowerShell 里会报
 *     「客户端没有所需的特权」（ERROR_PRIVILEGE_NOT_HELD），编译这步不可靠。
 *  3. cscript + WScript.Shell.SendKeys：只对自己进程的窗口有效，Chromium / Edge
 *     这类别的进程收不到（剪贴板不变）。
 *
 * 最终方案：随包发布一个 5KB 的 sendcopy.exe（native/win-sendcopy/SendCopy.cs），
 * 直接用 user32!SendInput 带扫描码发 Ctrl+C。它不需要运行时编译，不受上面三条影响。
 * 常驻 `serve` 模式读 stdin，一次按键只要几毫秒；找不到 exe 时退回 cscript SendKeys。
 *
 * 其它平台：macOS 用 osascript + System Events（需要辅助功能权限），Linux 用 xdotool。
 */
class KeySender {
  constructor({ platform = process.platform, logger, timeoutMs = 4000, scriptDir, helperPath } = {}) {
    this.platform = platform;
    this.logger = logger;
    this.timeoutMs = timeoutMs;
    this.scriptDir = scriptDir || os.tmpdir();
    this.helperPath = helperPath || null;
    this.worker = null;
    this.workerReady = null;
    this.workerBroken = false;
    this.pending = null;
    this.stdoutBuffer = '';
    this.onReady = null;
    this.scriptPaths = null;
    this.strategy = null;
  }

  /** 提前把常驻进程拉起来，避免第一次划词慢半秒 */
  async warmup() {
    if (this.platform !== 'win32') return;
    try {
      await this.ensureWorker();
    } catch (error) {
      this.logger?.warn('复制快捷键常驻进程启动失败，将退回单次调用', { message: error.message });
    }
  }

  /** 常驻版 VBS（兜底用）：读 stdin 的 copy/quit，回 OK/ERR */
  buildWorkerScript() {
    return [
      'Dim sh, line, rc',
      'Set sh = CreateObject("WScript.Shell")',
      'If Err.Number <> 0 Then',
      '  WScript.StdOut.WriteLine "ERR"',
      '  WScript.Quit 1',
      'End If',
      'WScript.StdOut.WriteLine "READY"',
      'Do While Not WScript.StdIn.AtEndOfStream',
      '  line = LCase(Trim(WScript.StdIn.ReadLine))',
      '  If line = "quit" Then Exit Do',
      '  If line = "copy" Then',
      '    On Error Resume Next',
      '    sh.SendKeys "^c"',
      '    rc = Err.Number',
      '    Err.Clear',
      '    On Error GoTo 0',
      '    If rc = 0 Then',
      '      WScript.StdOut.WriteLine "OK"',
      '    Else',
      '      WScript.StdOut.WriteLine "ERR"',
      '    End If',
      '  End If',
      'Loop',
      '',
    ].join('\r\n');
  }

  /** 一次性版 VBS：只发一次就退出 */
  buildOneShotScript() {
    return [
      'Dim sh, rc',
      'Set sh = CreateObject("WScript.Shell")',
      'On Error Resume Next',
      'sh.SendKeys "^c"',
      'rc = Err.Number',
      'If rc <> 0 Then WScript.Quit 2',
      '',
    ].join('\r\n');
  }

  /** 把两个 VBS 落到可写目录，返回路径 */
  ensureScripts() {
    if (this.scriptPaths) return this.scriptPaths;
    fs.mkdirSync(this.scriptDir, { recursive: true });
    const workerPath = path.join(this.scriptDir, 'selectpop-keys-worker.vbs');
    const oneShotPath = path.join(this.scriptDir, 'selectpop-keys-once.vbs');
    fs.writeFileSync(workerPath, this.buildWorkerScript(), 'utf8');
    fs.writeFileSync(oneShotPath, this.buildOneShotScript(), 'utf8');
    this.scriptPaths = { workerPath, oneShotPath };
    return this.scriptPaths;
  }

  hasHelper() {
    if (this.platform !== 'win32' || !this.helperPath) return false;
    try {
      return fs.existsSync(this.helperPath);
    } catch {
      return false;
    }
  }

  /** 决定用哪个常驻进程：优先自带的 sendcopy.exe，其次 cscript */
  plan() {
    if (this.strategy) return this.strategy;
    if (this.hasHelper()) {
      this.strategy = { kind: 'helper', file: this.helperPath, args: ['serve'] };
    } else {
      const { workerPath } = this.ensureScripts();
      this.strategy = { kind: 'cscript', file: 'cscript.exe', args: ['//nologo', '//B', workerPath] };
    }
    return this.strategy;
  }

  ensureWorker() {
    if (this.workerReady) return this.workerReady;
    if (this.platform !== 'win32') return Promise.resolve(false);
    const plan = this.plan();
    this.workerReady = new Promise((resolve, reject) => {
      let settled = false;
      const child = spawn(plan.file, plan.args, {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.worker = child;
      const label = plan.kind === 'helper' ? 'sendcopy.exe' : 'cscript';
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.markBroken(`${label} 启动超时`);
        reject(new Error(`${label} 启动超时`));
      }, 8000);

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => this.handleStdout(chunk));
      child.stderr.on('data', (chunk) => {
        const text = String(chunk).trim();
        if (text) this.logger?.debug(`${label} stderr`, { text });
      });
      child.on('error', (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          this.markBroken(error.message);
          reject(error);
        }
      });
      child.on('exit', (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          this.markBroken(`${label} 退出，code=${code}`);
          reject(new Error(`${label} 退出，code=${code}`));
        } else if (this.worker === child) {
          // 常驻进程意外结束：清掉引用，后续调用走一次性模式（不再反复重启）
          this.worker = null;
          this.workerReady = null;
          this.markBroken(`${label} 进程结束`);
        }
      });

      this.onReady = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      };
    });
    return this.workerReady;
  }

  handleStdout(chunk) {
    this.stdoutBuffer += chunk;
    let index = this.stdoutBuffer.indexOf('\n');
    while (index >= 0) {
      const line = this.stdoutBuffer.slice(0, index).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      if (line === 'READY' && this.onReady) this.onReady();
      else if (line === 'OK' || line === 'ERR') this.resolvePending(line === 'OK');
      index = this.stdoutBuffer.indexOf('\n');
    }
  }

  resolvePending(ok) {
    if (!this.pending) return;
    const { resolve, reject, timer } = this.pending;
    this.pending = null;
    clearTimeout(timer);
    if (ok) resolve(true);
    else reject(new Error('发送复制快捷键失败'));
  }

  markBroken(reason) {
    this.workerBroken = true;
    this.logger?.warn('复制快捷键通道不可用，改用单次调用', { reason });
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error(reason));
      this.pending = null;
    }
  }

  /** 通过常驻进程发一次 Ctrl+C */
  sendViaWorker() {
    return new Promise((resolve, reject) => {
      if (!this.worker || !this.worker.stdin.writable) {
        reject(new Error('按键通道未就绪'));
        return;
      }
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new Error('等待按键注入超时'));
      }, this.timeoutMs);
      this.pending = { resolve, reject, timer };
      try {
        this.worker.stdin.write('copy\n');
      } catch (error) {
        clearTimeout(timer);
        this.pending = null;
        reject(error);
      }
    });
  }

  /** 一次性调用，常驻进程不可用时的兜底 */
  sendOneShot() {
    return new Promise((resolve, reject) => {
      if (this.platform === 'win32') {
        const plan = this.plan();
        const file = plan.kind === 'helper' ? plan.file : 'cscript.exe';
        const args = plan.kind === 'helper' ? ['copy'] : ['//nologo', '//B', this.ensureScripts().oneShotPath];
        let child;
        try {
          child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
        } catch (error) {
          reject(error);
          return;
        }
        let stderr = '';
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error('复制快捷键超时'));
        }, this.timeoutMs);
        child.stderr.on('data', (chunk) => {
          stderr += String(chunk);
        });
        child.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on('exit', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve(true);
          else reject(new Error(stderr.trim() || `复制助手退出，code=${code}`));
        });
        return;
      }

      if (this.platform === 'darwin') {
        const script = 'tell application "System Events" to key code 8 using command down';
        const child = spawn('/usr/bin/osascript', ['-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error('osascript 复制超时'));
        }, this.timeoutMs);
        child.stderr.on('data', (chunk) => {
          stderr += String(chunk);
        });
        child.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on('exit', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve(true);
          else reject(new Error(stderr.trim() || `osascript 退出，code=${code}`));
        });
        return;
      }

      const child = spawn('xdotool', ['key', 'ctrl+c'], { stdio: ['ignore', 'ignore', 'pipe'] });
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('xdotool 复制超时'));
      }, this.timeoutMs);
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(true);
        else reject(new Error(`xdotool 退出，code=${code}`));
      });
    });
  }

  /** 发送一次复制快捷键，返回是否成功 */
  async sendCopyShortcut() {
    if (this.platform === 'win32' && !this.workerBroken) {
      try {
        await this.ensureWorker();
        return await this.sendViaWorker();
      } catch (error) {
        this.logger?.debug('常驻进程复制失败，使用单次调用', { message: error.message });
      }
    }
    return this.sendOneShot();
  }

  /**
   * 先把指定窗口置前、再发 Ctrl+C。
   * 场景：拖拽在浏览器里结束，但焦点被别的窗口抢走（托盘、远程桌面工具、刚弹出的弹窗），
   * 这时 Ctrl+C 发给了错误的目标，选区自然抓不到。
   */
  async sendCopyToWindow(hwnd) {
    if (this.platform !== 'win32' || !this.helperPath) return false;
    const target = Number(hwnd);
    if (!Number.isFinite(target) || target <= 0) return false;
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(this.helperPath, ['focuscopy', String(Math.trunc(target))], {
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'pipe'],
        });
      } catch (error) {
        reject(error);
        return;
      }
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('聚焦复制超时'));
      }, this.timeoutMs);
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(true);
        else reject(new Error(stderr.trim() || `聚焦复制退出，code=${code}`));
      });
    });
  }

  dispose() {
    const child = this.worker;
    this.worker = null;
    if (child) {
      try {
        child.stdin.write('quit\n');
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      }, 100);
    }
  }
}

module.exports = { KeySender };
