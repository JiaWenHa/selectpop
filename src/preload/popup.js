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
  // 主进程 → 渲染进程
  onInit: (cb) => subscribe('popup:init', cb),
  onEvent: (cb) => subscribe('popup:event', cb),
  onSettings: (cb) => subscribe('popup:settings', cb),

  // 渲染进程 → 主进程
  action: (action) => invoke('popup:action', { action: String(action) }),
  copyText: (text) => invoke('popup:copy-text', { text: String(text ?? '') }),
  close: () => invoke('popup:close'),
  retry: () => invoke('popup:retry'),
  stop: () => invoke('popup:stop'),
  openSettings: (section) => invoke('popup:open-settings', { section: section ? String(section) : 'ai' }),
  openExternal: (url) => invoke('popup:open-external', { url: String(url) }),
  resize: (height, width) =>
    ipcRenderer.send('popup:resize', {
      height: Math.round(height),
      width: typeof width === 'number' ? Math.round(width) : undefined,
    }),

  platform: process.platform,
});
