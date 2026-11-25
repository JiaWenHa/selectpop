'use strict';

const { ipcMain, clipboard, shell, systemPreferences } = require('electron');
const { isValidAccelerator } = require('../shared/settings-schema');
const {
  LANGUAGES,
  SEARCH_ENGINES,
  TRANSLATE_SITES,
  THEMES,
  TRANSLATE_MODES,
  LOG_LEVELS,
  AI_MODELS,
  ACTION_ORDER,
  ACTIONS,
} = require('../shared/constants');
const { testConnection } = require('./deepseek');

/** 设置界面需要展示的枚举项，由主进程统一提供，避免渲染进程里再抄一份 */
const UI_OPTIONS = {
  languages: LANGUAGES,
  themes: THEMES,
  translateModes: TRANSLATE_MODES,
  translateSites: Object.values(TRANSLATE_SITES).map((site) => ({ id: site.id, name: site.name })),
  searchEngines: Object.values(SEARCH_ENGINES).map((engine) => ({ id: engine.id, name: engine.name })),
  logLevels: LOG_LEVELS,
  models: AI_MODELS,
  actions: ACTION_ORDER.map((id) => ({ id, label: ACTIONS[id].label, kind: ACTIONS[id].kind })),
};

function isHttpUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * 注册所有 IPC。
 *
 * 安全约定：
 *  - 只接受来自我们自己的两个窗口的消息
 *  - 不用 ipcRenderer.invoke 暴露任意通道，每个 handler 都有明确参数
 *  - 打开外链只允许 http/https
 */
function registerIpc({
  store,
  popup,
  controller,
  updater,
  getSettingsWindow,
  getAppInfo,
  onSettingsChanged,
  onQuit,
  logger,
}) {
  const allowedSenderIds = () =>
    [popup.win?.webContents?.id, getSettingsWindow()?.webContents?.id].filter(Boolean);

  function trusted(event) {
    const id = event.sender?.id;
    return id !== undefined && allowedSenderIds().includes(id);
  }

  function handle(channel, listener) {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!trusted(event)) {
        logger?.warn('拒绝来自未知窗口的 IPC', { channel });
        return { ok: false, reason: 'untrusted' };
      }
      try {
        return await listener(...args);
      } catch (error) {
        logger?.error(`IPC ${channel} 执行失败`, { message: error.message });
        return { ok: false, reason: 'error', message: error.message };
      }
    });
  }

  handle('popup:action', async ({ action } = {}) => controller.runAction(String(action || '')));
  handle('popup:copy-text', async ({ text } = {}) => {
    const value = String(text || '').slice(0, 1000000);
    if (!value) return { ok: false };
    await clipboard.writeText(value);
    return { ok: true };
  });
  handle('popup:close', async () => {
    controller.hide();
    return { ok: true };
  });
  handle('popup:retry', async () => controller.retry());
  handle('popup:stop', async () => controller.stop());
  handle('popup:open-settings', async ({ section } = {}) => {
    controller.openSettingsForUser(section || 'ai');
    return { ok: true };
  });
  handle('popup:open-external', async ({ url } = {}) => {
    if (!isHttpUrl(url)) return { ok: false, reason: 'invalid-url' };
    controller.hide();
    await shell.openExternal(String(url));
    return { ok: true };
  });

  ipcMain.on('popup:resize', (event, { height, width } = {}) => {
    if (!trusted(event)) return;
    if (typeof height !== 'number' || !Number.isFinite(height)) return;
    popup.resize(height, typeof width === 'number' ? width : undefined);
  });

  handle('settings:get', async () => ({
    ...store.getPublic(),
    app: getAppInfo(),
    options: UI_OPTIONS,
    permission: {
      accessibility: process.platform === 'darwin' ? systemPreferences.isTrustedAccessibilityClient(false) : true,
      required: process.platform === 'darwin',
    },
  }));

  handle('settings:set', async ({ patch } = {}) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, reason: 'invalid-patch' };
    delete patch.secrets;
    const result = store.update(patch);
    onSettingsChanged?.(result);
    return { ok: true, changed: result.changed, ...store.getPublic() };
  });

  handle('settings:set-key', async ({ key } = {}) => {
    store.setApiKey(String(key || ''));
    onSettingsChanged?.({ changed: ['secrets.apiKey'], settings: store.get() });
    return { ok: true, ...store.getPublic() };
  });

  handle('settings:test-key', async ({ key } = {}) => {
    const settings = store.get();
    const apiKey = String(key || '').trim() || store.getApiKey();
    const result = await testConnection({
      apiKey,
      baseUrl: settings.ai.baseUrl,
      timeoutMs: 20000,
    });
    return result;
  });

  handle('settings:validate-hotkey', async ({ accelerator } = {}) => {
    const value = String(accelerator || '');
    if (!value) return { ok: true, accelerator: '' };
    if (!isValidAccelerator(value)) return { ok: false, message: '快捷键格式不正确' };
    return { ok: true, accelerator: value };
  });

  handle('settings:check-permission', async () => {
    if (process.platform !== 'darwin') return { ok: true, granted: true, required: false };
    const granted = systemPreferences.isTrustedAccessibilityClient(false);
    return { ok: true, granted, required: true };
  });

  handle('settings:prompt-permission', async () => {
    if (process.platform !== 'darwin') return { ok: true, granted: true, required: false };
    // 传 true 会弹出系统授权引导，并把应用加入「辅助功能」列表
    const granted = systemPreferences.isTrustedAccessibilityClient(true);
    return { ok: true, granted, required: true };
  });

  handle('settings:open-data-dir', async () => {
    await shell.openPath(getAppInfo().userDataPath);
    return { ok: true };
  });

  handle('settings:open-log', async () => {
    const info = getAppInfo();
    if (!info.logPath) return { ok: false };
    await shell.openPath(info.logPath);
    return { ok: true };
  });

  handle('settings:open-external', async ({ url } = {}) => {
    if (!isHttpUrl(url)) return { ok: false };
    await shell.openExternal(String(url));
    return { ok: true };
  });

  handle('app:info', async () => ({ ...getAppInfo(), ...store.getPublic() }));

  handle('app:quit', async () => {
    setTimeout(() => onQuit?.(), 50);
    return { ok: true };
  });

  handle('app:check-update', async () => (updater ? updater.checkForUpdates() : { ok: false, reason: 'unavailable' }));
  handle('app:download-update', async () => (updater ? updater.downloadUpdate() : { ok: false, reason: 'unavailable' }));
  handle('app:install-update', async () => (updater ? updater.installUpdate() : { ok: false, reason: 'unavailable' }));

  return {
    broadcast(channel, payload) {
      const settingsWin = getSettingsWindow();
      if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send(channel, payload);
    },
    dispose() {
      const channels = [
        'popup:action',
        'popup:copy-text',
        'popup:close',
        'popup:retry',
        'popup:stop',
        'popup:open-settings',
        'popup:open-external',
        'settings:get',
        'settings:set',
        'settings:set-key',
        'settings:test-key',
        'settings:validate-hotkey',
        'settings:check-permission',
        'settings:prompt-permission',
        'settings:open-data-dir',
        'settings:open-log',
        'settings:open-external',
        'app:info',
        'app:quit',
        'app:check-update',
        'app:download-update',
        'app:install-update',
      ];
      for (const channel of channels) ipcMain.removeHandler(channel);
      ipcMain.removeAllListeners('popup:resize');
    },
  };
}

module.exports = { registerIpc, isHttpUrl };
