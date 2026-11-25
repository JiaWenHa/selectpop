'use strict';

const path = require('node:path');
const { app, BrowserWindow, screen, shell } = require('electron');
const { computePopupBounds } = require('../shared/placement');

const MIN_HEIGHT = 120;
const MAX_HEIGHT = 680;

/**
 * 划词弹窗：无边框、透明、置顶、不进任务栏。
 * 只创建一次，之后复用（隐藏/显示），保证划词到弹窗出现的延迟足够低。
 */
class PopupWindow {
  constructor({ logger, onBlur, onClosed } = {}) {
    this.logger = logger;
    this.onBlur = onBlur;
    this.onClosed = onClosed;
    this.win = null;
    this.anchor = { x: 0, y: 0 };
    this.size = { width: 384, height: 168 };
    this.ignoreBlurUntil = 0;
    this.readyPromise = null;
    this.visible = false;
  }

  ensure() {
    if (this.win && !this.win.isDestroyed()) return this.win;

    this.win = new BrowserWindow({
      width: this.size.width,
      height: this.size.height,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      movable: false,
      acceptFirstMouse: true,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'popup.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        backgroundThrottling: false,
        devTools: !global.__SELECTPOP_PACKAGED__,
      },
    });

    this.win.setAlwaysOnTop(true, 'screen-saver');
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.win.setMenuBarVisibility(false);

    const { webContents } = this.win;
    webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
      return { action: 'deny' };
    });
    webContents.on('will-navigate', (event) => event.preventDefault());
    webContents.on('render-process-gone', (_event, details) => {
      this.logger?.error('弹窗渲染进程退出', details);
    });
    webContents.on('console-message', (event) => {
      const { level, message } = event;
      if (message) this.logger?.debug('弹窗控制台', { level, message: String(message).slice(0, 300) });
    });

    this.win.on('blur', () => {
      if (Date.now() < this.ignoreBlurUntil) return;
      this.onBlur?.();
    });
    this.win.on('closed', () => {
      this.win = null;
      this.visible = false;
      this.onClosed?.();
    });

    this.readyPromise = new Promise((resolve) => {
      webContents.once('did-finish-load', () => resolve());
    });
    this.win.loadFile(path.join(__dirname, '..', 'renderer', 'popup', 'index.html'));
    return this.win;
  }

  async show({ text, payload, at, height }) {
    const win = this.ensure();
    await this.readyPromise;
    if (win.isDestroyed()) return;
    this.anchor = { x: at.x, y: at.y };
    if (height) this.size.height = height;
    if (payload && Number.isFinite(payload.width)) {
      this.size.width = Math.min(Math.max(Math.round(payload.width), 320), 560);
    }
    this.applyBounds();
    this.ignoreBlurUntil = Date.now() + 250;
    if (process.platform === 'darwin') {
      try {
        app.focus({ steal: true });
      } catch {
        /* ignore */
      }
    }
    win.setOpacity(1);
    win.show();
    win.focus();
    this.visible = true;
    win.webContents.send('popup:init', { text, ...payload });
  }

  applyBounds() {
    if (!this.win || this.win.isDestroyed()) return;
    const display = screen.getDisplayNearestPoint(this.anchor);
    const bounds = computePopupBounds({
      cursor: this.anchor,
      size: this.size,
      workArea: display.workArea,
    });
    this.win.setBounds(bounds);
  }

  /** 渲染进程测量内容高度后调用，窗口跟着长高/变矮 */
  resize(height, width) {
    if (!this.win || this.win.isDestroyed()) return;
    const nextHeight = Math.min(Math.max(Math.round(height), MIN_HEIGHT), MAX_HEIGHT);
    const nextWidth = width ? Math.min(Math.max(Math.round(width), 320), 560) : this.size.width;
    if (Math.abs(nextHeight - this.size.height) < 1 && nextWidth === this.size.width) return;
    this.size = { width: nextWidth, height: nextHeight };
    this.applyBounds();
  }

  send(channel, payload) {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.webContents.send(channel, payload);
  }

  contains(point) {
    if (!this.visible || !this.win || this.win.isDestroyed()) return false;
    const bounds = this.win.getBounds();
    return (
      point.x >= bounds.x &&
      point.x <= bounds.x + bounds.width &&
      point.y >= bounds.y &&
      point.y <= bounds.y + bounds.height
    );
  }

  hide() {
    if (!this.win || this.win.isDestroyed()) {
      this.visible = false;
      return;
    }
    this.visible = false;
    this.win.hide();
  }

  isVisible() {
    return Boolean(this.visible && this.win && !this.win.isDestroyed() && this.win.isVisible());
  }

  focus() {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.focus();
  }

  openDevTools() {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.openDevTools({ mode: 'detach' });
  }

  destroy() {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
    this.visible = false;
  }
}

module.exports = { PopupWindow, MIN_HEIGHT, MAX_HEIGHT };
