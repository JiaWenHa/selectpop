'use strict';

const { Tray, Menu, nativeImage } = require('electron');

/**
 * 托盘：应用的主入口（窗口都是「用完即走」的，关掉后仍驻留托盘）。
 */
function createTray({ iconPath, templateIconPath, store, logger, actions } = {}) {
  let image = null;
  const candidate = process.platform === 'darwin' ? templateIconPath || iconPath : iconPath;
  try {
    image = nativeImage.createFromPath(candidate);
    if (image.isEmpty()) throw new Error('图标为空');
  } catch (error) {
    logger?.warn('托盘图标加载失败，使用空图标', { message: error.message, candidate });
    image = nativeImage.createEmpty();
  }
  if (process.platform === 'darwin' && typeof image.setTemplateImage === 'function') {
    image.setTemplateImage(true);
  }

  const tray = new Tray(image);
  tray.setToolTip('SelectPop 划词助手');

  function buildMenu() {
    const settings = store.get();
    return Menu.buildFromTemplate([
      {
        label: settings.app.enabled ? '划词已启用（点击暂停）' : '划词已暂停（点击启用）',
        type: 'checkbox',
        checked: Boolean(settings.app.enabled),
        click: (item) => store.update({ app: { enabled: item.checked } }),
      },
      {
        label: '翻译剪贴板内容',
        click: () => actions.captureClipboard?.(),
      },
      { type: 'separator' },
      {
        label: '打开设置…',
        accelerator: 'CommandOrControl+,',
        click: () => actions.openSettings?.(),
      },
      {
        label: '开机自动启动',
        type: 'checkbox',
        checked: Boolean(settings.app.launchAtLogin),
        click: (item) => store.update({ app: { launchAtLogin: item.checked } }),
      },
      { type: 'separator' },
      {
        label: '查看日志',
        click: () => actions.openLog?.(),
      },
      {
        label: '打开配置目录',
        click: () => actions.openDataDir?.(),
      },
      { type: 'separator' },
      {
        label: '退出 SelectPop',
        click: () => actions.quit?.(),
      },
    ]);
  }

  function rebuild() {
    tray.setContextMenu(buildMenu());
  }

  tray.on('double-click', () => actions.openSettings?.());
  if (process.platform !== 'darwin') {
    tray.on('click', () => actions.openSettings?.());
  }

  rebuild();

  return {
    tray,
    rebuild,
    destroy() {
      try {
        tray.destroy();
      } catch {
        /* ignore */
      }
    },
  };
}

module.exports = { createTray };
