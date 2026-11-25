'use strict';

/**
 * 自动更新（electron-updater + GitHub Release）。
 * 仅在打包后的安装版里可用：electron-updater 依赖 electron-builder 写入的
 * app-update.yml（发布地址、版本号）与 latest.yml（最新版本元数据）。
 * 开发模式（未打包）与 portable 便携版不可用。
 */

const { app } = require('electron');

class Updater {
  constructor({ logger, notify, getSettingsWindow }) {
    this.logger = logger;
    this.notify = notify;
    this.getSettingsWindow = getSettingsWindow;
    this.autoUpdater = null;
    this.status = { state: 'idle', data: null };
  }

  init() {
    // 未打包（开发/冒烟）时 electron-updater 读不到 app-update.yml，直接跳过。
    if (!app.isPackaged) {
      this.logger.debug('未打包环境，跳过自动更新');
      return;
    }
    try {
      // 延迟 require，避免在不需要自动更新的场景加载依赖。
      const { autoUpdater } = require('electron-updater');
      this.autoUpdater = autoUpdater;
      autoUpdater.autoDownload = false; // 先提示用户，再由用户点「下载」
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.logger = this.logger;
      this.bindEvents();
    } catch (err) {
      this.logger.warn('自动更新不可用', { message: err.message });
    }
  }

  bindEvents() {
    const au = this.autoUpdater;
    au.on('checking-for-update', () => this.broadcast('checking', null));
    au.on('update-available', (info) => {
      this.broadcast('available', info);
      this.notify?.('发现新版本', `SelectPop ${info.version} 已发布，可前往设置下载。`);
    });
    au.on('update-not-available', (info) => this.broadcast('not-available', info));
    au.on('error', (err) => this.broadcast('error', { message: err.message }));
    au.on('download-progress', (p) => this.broadcast('downloading', p));
    au.on('update-downloaded', (info) => {
      this.broadcast('downloaded', info);
      this.notify?.('更新已就绪', `SelectPop ${info.version} 已下载完成，重启即可安装。`);
    });
  }

  broadcast(state, data) {
    this.status = { state, data };
    const win = this.getSettingsWindow?.();
    if (win && win.win && !win.win.isDestroyed()) {
      win.send('settings:update-status', { state, data, currentVersion: app.getVersion() });
    }
  }

  get currentVersion() {
    return app.getVersion();
  }

  async checkForUpdates() {
    if (!this.autoUpdater) {
      this.broadcast('error', { message: '自动更新仅对安装版生效（开发版 / 便携版不可用）。' });
      return { ok: false, reason: 'unavailable' };
    }
    try {
      await this.autoUpdater.checkForUpdates();
      return { ok: true, status: this.status };
    } catch (err) {
      this.broadcast('error', { message: err.message });
      return { ok: false, reason: 'error', message: err.message };
    }
  }

  async downloadUpdate() {
    if (!this.autoUpdater) return { ok: false, reason: 'unavailable' };
    try {
      await this.autoUpdater.downloadUpdate();
      return { ok: true };
    } catch (err) {
      this.broadcast('error', { message: err.message });
      return { ok: false, reason: 'error', message: err.message };
    }
  }

  async installUpdate() {
    if (!this.autoUpdater) return { ok: false, reason: 'unavailable' };
    try {
      setImmediate(() => this.autoUpdater.quitAndInstall(false, true));
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: 'error', message: err.message };
    }
  }

  dispose() {
    if (this.autoUpdater) {
      this.autoUpdater.removeAllListeners();
    }
    this.autoUpdater = null;
  }
}

module.exports = { Updater };
