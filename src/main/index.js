'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  app,
  clipboard,
  globalShortcut,
  nativeTheme,
  Notification,
  screen,
  shell,
  systemPreferences,
  dialog,
  safeStorage,
} = require('electron');

const { createLogger } = require('./logger');
const { SettingsStore } = require('./settings-store');
const { KeySender } = require('./keystroke');
const { ClipboardGuard } = require('./clipboard-guard');
const { SelectionCapture } = require('./capture');
const { describeForeground, describeWindowAt } = require('./foreground');
const { SelectionMonitor } = require('./selection-monitor');
const { PopupWindow } = require('./popup-window');
const { SettingsWindow } = require('./settings-window');
const { PopupController } = require('./popup-controller');
const { createTray } = require('./tray');
const { registerIpc } = require('./ipc');
const { Updater } = require('./updater');
const { normalizeText } = require('../shared/text');
const { APP_ID, APP_NAME } = require('../shared/constants');

const isDev = process.argv.includes('--dev');
const isSmoke = process.argv.includes('--smoke');

if (process.env.SELECTPOP_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.SELECTPOP_USER_DATA));
}
if (isSmoke || process.env.SELECTPOP_DISABLE_GPU === '1') {
  app.disableHardwareAcceleration();
}

global.__SELECTPOP_PACKAGED__ = app.isPackaged;

let logger = null;
let store = null;
let guard = null;
let keySender = null;
let capture = null;
let monitor = null;
let popup = null;
let settingsWindow = null;
let controller = null;
let tray = null;
let ipc = null;
let updater = null;
let currentHotkey = null;
let quitting = false;

app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

/**
 * 数据目录兜底：Chromium 启动要往 userData 里建缓存/锁文件，
 * 目录不可写时 Windows 上会直接 0xc0000142 或拿不到单实例锁（表现为「双击没反应」）。
 * 这里在真正的窗口逻辑之前探测可用目录，实在不可写就换到能找到的可写位置。
 */
function ensureWritableUserData() {
  if (process.env.SELECTPOP_USER_DATA) return;
  const os = require('node:os');
  const probe = (dir) => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, '.write-probe');
      fs.writeFileSync(file, 'ok');
      fs.unlinkSync(file);
      return true;
    } catch {
      return false;
    }
  };

  const current = app.getPath('userData');
  if (probe(current)) return;

  const candidates = [];
  if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, `${APP_NAME}-Data`));
  candidates.push(path.join(os.tmpdir(), `${APP_NAME}-Data`));
  candidates.push(path.join(path.dirname(process.execPath), `${APP_NAME}-Data`));

  for (const dir of candidates) {
    if (!probe(dir)) continue;
    try {
      app.setPath('userData', dir);
      app.setPath('sessionData', dir);
    } catch {
      /* 老版本没有 sessionData，忽略 */
    }
    // eslint-disable-next-line no-console
    console.warn(`[SelectPop] 默认数据目录不可写，已切换到 ${dir}`);
    return;
  }
  // eslint-disable-next-line no-console
  console.warn('[SelectPop] 找不到可写的数据目录，启动可能失败');
}

ensureWritableUserData();

const assetsDir = path.join(__dirname, '..', '..', 'assets');
// 打包后 assets 在 app.asar 里，读没问题，但 spawn 出去的路径必须指向 app.asar.unpacked，
// 否则 CreateProcess 拿到 "...\app.asar\assets\bin\sendcopy.exe" 这种虚拟路径会失败。
const spawnAssetsDir = assetsDir.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
const sendCopyPath = path.join(spawnAssetsDir, 'bin', 'sendcopy.exe');
const winInfoPath = path.join(spawnAssetsDir, 'bin', 'wininfo.exe');

/** 屏幕物理坐标处的窗口（拿不到就返回 null，不影响取词） */
function windowAtPoint(x, y) {
  return describeWindowAt(x, y, { helperPath: winInfoPath });
}
function notify(title, body) {
  try {
    if (Notification.isSupported()) {
      new Notification({ title, body, silent: true }).show();
    }
  } catch (error) {
    logger?.warn('系统通知失败', { message: error.message });
  }
}

function toDip(point) {
  if (process.platform !== 'win32') return point;
  try {
    return screen.screenToDipPoint(point) || point;
  } catch {
    return point;
  }
}

// DIP → 物理像素。wininfo.exe 的 WindowFromPoint 需要物理坐标，
// 而鼠标钩子给出的点已经被 toDip 转成了 DIP，高 DPI 屏幕上两者不一样。
function toScreenPoint(point) {
  if (process.platform !== 'win32') return point;
  try {
    return screen.dipToScreenPoint(point) || point;
  } catch {
    return point;
  }
}

function isOwnPoint(point) {
  return Boolean(popup?.contains(point) || settingsWindow?.contains(point));
}

function accessibilityGranted() {
  if (process.platform !== 'darwin') return true;
  try {
    return systemPreferences.isTrustedAccessibilityClient(false);
  } catch {
    return true;
  }
}

function getAppInfo() {
  return {
    name: APP_NAME,
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    isPackaged: app.isPackaged,
    userDataPath: app.getPath('userData'),
    logPath: logger?.file || '',
    accessibilityGranted: accessibilityGranted(),
    hotkeyRegistered: Boolean(currentHotkey),
    hotkey: currentHotkey || '',
    monitorActive: Boolean(monitor?.started),
    monitorAvailable: Boolean(monitor?.available),
  };
}

async function handleMouseSelection({ x, y }) {
  if (!store.get().app.enabled) return;
  if (capture.busy) return;
  const settings = store.get();
  // 懒加载「用户在哪拖的」：第一次 Ctrl+C 没抓到东西时，再把焦点还给这个窗口补发。
  // 注意 x/y 是 DIP，要转回物理像素再查窗口。
  const screenPoint = toScreenPoint({ x, y });
  const result = await capture.capture({
    delayMs: settings.trigger.copyDelayMs,
    timeoutMs: settings.trigger.clipboardTimeoutMs,
    restoreClipboard: settings.clipboard.restore,
    resolveTargetWindow: () => windowAtPoint(screenPoint.x, screenPoint.y),
  });
  if (!result.ok) {
    logger.info('未获取到选区', result);
    return;
  }
  logger.info('捕获到选区', { chars: result.text.length, durationMs: result.durationMs, source: 'mouse' });
  if (controller.session && controller.session.text === result.text && popup.isVisible()) return;
  await controller.beginSession({ text: result.text, at: { x, y }, source: 'mouse' });
}

async function handleHotkey() {
  if (!store.get().app.enabled) {
    notify('划词已暂停', '在托盘菜单里重新启用 SelectPop');
    return;
  }
  if (capture.busy) return;
  const at = screen.getCursorScreenPoint();
  const settings = store.get();
  const result = await capture.capture({
    delayMs: settings.trigger.copyDelayMs,
    timeoutMs: settings.trigger.clipboardTimeoutMs,
    restoreClipboard: settings.clipboard.restore,
  });
  if (result.ok) {
    await controller.beginSession({ text: result.text, at, source: 'hotkey' });
    return;
  }
  const fallback = normalizeText(await guard.readText());
  if (fallback) {
    await controller.beginSession({ text: fallback, at, source: 'clipboard' });
    return;
  }
  notify('没有取到文字', '先选中一段文字，或先复制内容到剪贴板');
}

async function captureClipboardToPopup() {
  const text = normalizeText(await guard.readText());
  if (!text) {
    notify('剪贴板是空的', '先复制一段文字再试');
    return;
  }
  const at = screen.getCursorScreenPoint();
  await controller.beginSession({ text, at, source: 'clipboard' });
}

const HOTKEY_FALLBACKS = ['CommandOrControl+Shift+X', 'CommandOrControl+Alt+S', 'CommandOrControl+Shift+D'];

function tryRegister(accelerator) {
  try {
    return globalShortcut.register(accelerator, () => {
      handleHotkey().catch((error) => logger.error('快捷键处理失败', { message: error.message }));
    });
  } catch (error) {
    logger.warn('注册快捷键异常', { message: error.message, accelerator });
    return false;
  }
}

function updateHotkey() {
  const accelerator = store.get().trigger.hotkey;
  if (currentHotkey && currentHotkey !== accelerator) {
    try {
      globalShortcut.unregister(currentHotkey);
    } catch {
      /* ignore */
    }
    currentHotkey = null;
  }
  if (!accelerator) return { ok: true };
  if (currentHotkey === accelerator) return { ok: true };

  if (tryRegister(accelerator)) {
    currentHotkey = accelerator;
    logger.info('注册快捷键成功', { accelerator });
    return { ok: true };
  }

  logger.warn('注册快捷键失败（可能被其他程序占用）', { accelerator });
  // 被占用时自动换一组，免得用户以为划词快捷键彻底失效
  for (const fallback of HOTKEY_FALLBACKS) {
    if (fallback === accelerator) continue;
    if (!tryRegister(fallback)) continue;
    currentHotkey = fallback;
    logger.warn('已改用备用快捷键', { accelerator, fallback });
    notify('快捷键被占用', `${accelerator} 已被其他程序使用，暂时改用 ${fallback}（可在设置里改）`);
    return { ok: true, fallback, requested: accelerator };
  }
  notify('快捷键不可用', `${accelerator} 被占用，请到设置 → 触发方式 里换一组`);
  return { ok: false, message: `快捷键 ${accelerator} 被占用` };
}

function updateMonitor() {
  const settings = store.get();
  const shouldRun = settings.app.enabled && settings.trigger.mouseSelection;
  if (shouldRun && !monitor.started) {
    const ok = monitor.start();
    if (!ok && process.platform === 'darwin' && !accessibilityGranted()) {
      notify('需要辅助功能权限', '系统设置 → 隐私与安全性 → 辅助功能，勾选 SelectPop 后重启应用');
    }
  } else if (!shouldRun && monitor.started) {
    monitor.stop();
  }
}

function updateLaunchAtLogin() {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return;
  // 开发模式下不要把自己写进开机启动（否则注册的是 electron.exe）
  if (!app.isPackaged) return;
  const { launchAtLogin } = store.get().app;
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(launchAtLogin),
      openAsHidden: true,
      args: [],
    });
  } catch (error) {
    logger.warn('设置开机启动失败', { message: error.message });
  }
}

function applySettings() {
  const settings = store.get();
  nativeTheme.themeSource = settings.app.theme;
  logger.setLevel(settings.advanced.logLevel);
  updateHotkey();
  updateMonitor();
  updateLaunchAtLogin();
  tray?.rebuild();
}

function broadcastSettings() {
  const payload = {
    ...store.getPublic(),
    app: getAppInfo(),
    permission: {
      accessibility: accessibilityGranted(),
      required: process.platform === 'darwin',
    },
  };
  ipc?.broadcast('settings:changed', payload);
  popup?.send('popup:settings', payload);
}

function openSettings(section) {
  settingsWindow.open(section);
}

function openDataDir() {
  shell.openPath(app.getPath('userData')).catch(() => {});
}

function openLog() {
  if (logger?.file) shell.openPath(logger.file).catch(() => {});
}

function ensureMacPermissions() {
  if (process.platform !== 'darwin') return;
  if (accessibilityGranted()) return;
  const choice = dialog.showMessageBoxSync({
    type: 'info',
    title: '需要辅助功能权限',
    message: 'SelectPop 需要「辅助功能」权限才能监听划词并模拟 Command+C。',
    detail:
      '请到 系统设置 → 隐私与安全性 → 辅助功能 中勾选 SelectPop。\n授权后请退出并重新打开 SelectPop。',
    buttons: ['打开系统设置', '稍后'],
    defaultId: 0,
    cancelId: 1,
  });
  if (choice === 0) {
    try {
      systemPreferences.isTrustedAccessibilityClient(true);
      shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
    } catch {
      /* ignore */
    }
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function captureWindow(win, fileName, outDir) {
  if (!win || win.isDestroyed()) return null;
  try {
    const image = await win.webContents.capturePage();
    const buffer = image.toPNG();
    if (!buffer.length) {
      logger.warn('截图为空', { fileName });
      return null;
    }
    const output = path.join(outDir, fileName);
    fs.writeFileSync(output, buffer);
    logger.info('已生成截图', { output, bytes: buffer.length });
    return output;
  } catch (error) {
    // GPU 进程挂掉时 capturePage 会抛 UnknownVizError，别让它把自检卡死
    logger.warn('截图失败', { fileName, message: error.message });
    return null;
  }
}

/** 无界面自检：渲染弹窗 / 设置页并截图，用来验证打包前的 UI 是否正常 */
async function runSmoke() {
  // 打包后 app.asar 是只读的，截图要写到当前目录（双击运行时就是 exe 所在目录的 artifacts）
  const baseDir = app.isPackaged ? process.cwd() : app.getAppPath();
  const outDir = path.join(baseDir, 'artifacts');
  fs.mkdirSync(outDir, { recursive: true });
  const artifacts = [];

  const sample =
    '划词助手：选中一段文字，立刻复制、翻译或搜索。接入 DeepSeek 后，还能解释、总结和润色。';
  await controller.beginSession({ text: sample, at: { x: 320, y: 220 }, source: 'smoke' });
  await wait(900);
  artifacts.push(await captureWindow(popup.win, 'popup-idle.png', outDir));

  const answer =
    '这句话在介绍 SelectPop 的核心交互：选中文字后弹出小窗，提供复制、翻译、搜索。\n\n接入 DeepSeek 之后，同一个弹窗还能：\n\n- **解释**：说明这段话的含义与背景\n- **总结**：提炼 3-6 条要点\n- **润色**：改写表述，保持原意';
  popup.send('popup:event', { type: 'action-start', action: 'explain', title: '解释', subtitle: '' });
  for (const char of answer) {
    popup.send('popup:event', { type: 'delta', text: char });
    await wait(6);
  }
  popup.send('popup:event', {
    type: 'done',
    text: answer,
    usage: { prompt_tokens: 48, completion_tokens: 96 },
  });
  await wait(600);
  artifacts.push(await captureWindow(popup.win, 'popup-result.png', outDir));

  nativeTheme.themeSource = 'dark';
  await wait(500);
  artifacts.push(await captureWindow(popup.win, 'popup-result-dark.png', outDir));
  nativeTheme.themeSource = 'system';

  settingsWindow.open('general');
  await wait(1200);
  artifacts.push(await captureWindow(settingsWindow.win, 'settings.png', outDir));

  const summary = {
    ok: artifacts.every(Boolean),
    artifacts: artifacts.filter(Boolean),
    missing: ['popup-idle.png', 'popup-result.png', 'popup-result-dark.png', 'settings.png'].filter(
      (name) => !artifacts.includes(path.join(outDir, name)),
    ),
    popupVisible: popup.isVisible(),
    settingsLoaded: Boolean(settingsWindow.win && !settingsWindow.win.webContents.isLoading()),
  };
  // eslint-disable-next-line no-console
  console.log(`SMOKE_RESULT ${JSON.stringify(summary)}`);
  await wait(200);
  app.exit(summary.ok ? 0 : 1);
}

async function bootstrap() {
  logger = createLogger({
    dir: path.join(app.getPath('userData'), 'logs'),
    level: isDev ? 'debug' : 'info',
    isDev,
  });
  logger.info('启动 SelectPop', {
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: process.platform,
    arch: process.arch,
    smoke: isSmoke,
  });

  const settingsFile = path.join(app.getPath('userData'), 'settings.json');
  const isFirstRun = !fs.existsSync(settingsFile);

  store = new SettingsStore({ dir: app.getPath('userData'), safeStorage, logger });
  store.load();
  nativeTheme.themeSource = store.get().app.theme;

  guard = new ClipboardGuard({ clipboard, logger });
  keySender = new KeySender({ logger, scriptDir: app.getPath('userData'), helperPath: sendCopyPath });
  if (process.platform === 'win32' && !fs.existsSync(sendCopyPath)) {
    logger.warn('缺少 sendcopy.exe，划词后将退回 cscript 方案（对其它进程可能无效）', { expected: sendCopyPath });
  }
  capture = new SelectionCapture({
    keySender,
    guard,
    logger,
    foregroundProbe: () => describeForeground({ helperPath: winInfoPath }),
  });

  popup = new PopupWindow({
    logger,
    onBlur: () => {
      if (popup.isVisible()) controller?.hide();
    },
  });

  settingsWindow = new SettingsWindow({
    logger,
    isDev,
    onClosed: () => {
      /* 允许重新打开，无需处理 */
    },
  });

  controller = new PopupController({
    store,
    popup,
    guard,
    logger,
    openSettings,
    openExternal: (url) => {
      shell.openExternal(url).catch((error) => logger.warn('打开外部链接失败', { message: error.message }));
    },
    notify,
    onSessionStart: () => {},
  });

  updater = new Updater({ logger, notify, getSettingsWindow: () => settingsWindow });
  updater.init();

  ipc = registerIpc({
    store,
    popup,
    controller,
    updater,
    getSettingsWindow: () => settingsWindow?.win || null,
    getAppInfo,
    onQuit: () => {
      quitting = true;
      app.quit();
    },
    logger,
  });

  store.on('change', () => {
    applySettings();
    broadcastSettings();
  });

  monitor = new SelectionMonitor({
    logger,
    getSettings: () => store.get(),
    toDip,
    isOwnPoint,
    onSelection: (payload) => {
      handleMouseSelection(payload).catch((error) => logger.error('划词处理失败', { message: error.message }));
    },
  });

  if (process.platform === 'darwin' && typeof app.dock?.hide === 'function') {
    app.dock.hide();
  }

  applySettings();

  if (isSmoke) {
    await runSmoke();
    return;
  }

  tray = createTray({
    iconPath: path.join(assetsDir, 'tray.png'),
    templateIconPath: path.join(assetsDir, 'trayTemplate.png'),
    store,
    logger,
    actions: {
      openSettings: () => openSettings(),
      captureClipboard: () => captureClipboardToPopup(),
      openLog,
      openDataDir,
      quit: () => {
        quitting = true;
        app.quit();
      },
    },
  });

  keySender.warmup().catch(() => {});

  ensureMacPermissions();

  if (isFirstRun) {
    openSettings('general');
    notify('SelectPop 已启动', '选中文字试试；在设置里填入 DeepSeek API Key 可启用 AI 功能');
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (app.isReady()) openSettings();
  });

  app.whenReady().then(async () => {
    try {
      await bootstrap();
    } catch (error) {
      logger?.error('启动失败', { message: error.message, stack: error.stack });
      dialog.showErrorBox('SelectPop 启动失败', String(error?.stack || error));
      app.exit(1);
    }
  });

  app.on('activate', () => {
    if (app.isReady()) openSettings();
  });

  // 托盘应用：关掉窗口不等于退出
  app.on('window-all-closed', () => {
    /* noop */
  });

  app.on('before-quit', () => {
    quitting = true;
    try {
      monitor?.stop();
    } catch {
      /* ignore */
    }
    try {
      keySender?.dispose();
    } catch {
      /* ignore */
    }
    try {
      tray?.destroy();
    } catch {
      /* ignore */
    }
    try {
      ipc?.dispose();
    } catch {
      /* ignore */
    }
    try {
      updater?.dispose();
    } catch {
      /* ignore */
    }
    try {
      controller?.dispose();
    } catch {
      /* ignore */
    }
    globalShortcut.unregisterAll();
    logger?.info('已退出');
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });

  process.on('uncaughtException', (error) => {
    logger?.error('未捕获异常', { message: error.message, stack: error.stack });
  });
  process.on('unhandledRejection', (reason) => {
    logger?.error('未处理的 Promise 拒绝', { message: String(reason) });
  });
}
