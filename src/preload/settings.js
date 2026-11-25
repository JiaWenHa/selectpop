'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const invoke = (channel, payload) =>
  ipcRenderer.invoke(channel, payload).catch((error) => ({
    ok: false,
    reason: 'ipc-error',
    message: error?.message || String(error),
  }));

contextBridge.exposeInMainWorld('selectpop', {
  // 数据
  get: () => invoke('settings:get'),
  set: (patch) => invoke('settings:set', { patch }),
  setKey: (key) => invoke('settings:set-key', { key: String(key ?? '') }),
  testKey: (key) => invoke('settings:test-key', { key: key ? String(key) : '' }),
  validateHotkey: (accelerator) => invoke('settings:validate-hotkey', { accelerator: String(accelerator ?? '') }),

  // 权限
  checkPermission: () => invoke('settings:check-permission'),
  promptPermission: () => invoke('settings:prompt-permission'),

  // 其他
  getAppInfo: () => invoke('app:info'),
  openDataDir: () => invoke('settings:open-data-dir'),
  openLog: () => invoke('settings:open-log'),
  openExternal: (url) => invoke('settings:open-external', { url: String(url) }),
  quit: () => invoke('app:quit'),

  // 自动更新
  checkUpdate: () => invoke('app:check-update'),
  downloadUpdate: () => invoke('app:download-update'),
  installUpdate: () => invoke('app:install-update'),

  // 事件
  onChange: (cb) => subscribe('settings:changed', cb),
  onFocusSection: (cb) => subscribe('settings:focus-section', cb),
  onUpdateStatus: (cb) => subscribe('settings:update-status', cb),

  platform: process.platform,
});
