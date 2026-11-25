'use strict';

const path = require('node:path');
const { BrowserWindow, shell } = require('electron');

/** 设置窗口：普通窗口，可调整大小，独立于弹窗生命周期 */
class SettingsWindow {
  constructor({ logger, onClosed, isDev } = {}) {
    this.logger = logger;
    this.onClosed = onClosed;
    this.isDev = Boolean(isDev);
    this.win = null;
  }

  ensure() {
    if (this.win && !this.win.isDestroyed()) return this.win;

    this.win = new BrowserWindow({
      width: 820,
      height: 660,
      minWidth: 720,
      minHeight: 560,
      show: false,
      title: 'SelectPop 设置',
      backgroundColor: '#111318',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'settings.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        devTools: !global.__SELECTPOP_PACKAGED__,
      },
    });

    this.win.setMenuBarVisibility(false);
    const { webContents } = this.win;
    webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
      return { action: 'deny' };
    });
    webContents.on('will-navigate', (event) => event.preventDefault());
    webContents.on('render-process-gone', (_event, details) => {
      this.logger?.error('设置窗口渲染进程退出', details);
    });

    this.win.on('ready-to-show', () => {
      this.win.show();
      this.win.focus();
    });
    this.win.on('closed', () => {
      this.win = null;
      this.onClosed?.();
    });

    this.win.loadFile(path.join(__dirname, '..', 'renderer', 'settings', 'index.html'));
    return this.win;
  }

  open(section) {
    const win = this.ensure();
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
    if (section) {
      const send = () => win.webContents.send('settings:focus-section', section);
      if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
      else send();
    }
    return win;
  }

  contains(point) {
    if (!this.win || this.win.isDestroyed() || !this.win.isVisible()) return false;
    const bounds = this.win.getBounds();
    return (
      point.x >= bounds.x &&
      point.x <= bounds.x + bounds.width &&
      point.y >= bounds.y &&
      point.y <= bounds.y + bounds.height
    );
  }

  send(channel, payload) {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.webContents.send(channel, payload);
  }

  destroy() {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}

module.exports = { SettingsWindow };
