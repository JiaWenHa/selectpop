'use strict';

const { shouldTriggerSelection } = require('../shared/selection');
const { distance } = require('../shared/text');

/**
 * 全局鼠标监听：判断「这次抬起是不是一次划词」。
 *
 * uiohook-napi 提供的是操作系统级的鼠标钩子（Windows: SetWindowsHookEx，
 * macOS: CGEventTap），不需要任何窗口获得焦点。
 *
 * 注意：
 * - macOS 需要「辅助功能」权限，否则收不到事件
 * - 坐标是物理像素，统一用 toDip 转成 Electron 的 DIP 再做几何判断
 */
class SelectionMonitor {
  constructor({ logger, getSettings, toDip, isOwnPoint, onSelection } = {}) {
    this.logger = logger;
    this.getSettings = getSettings || (() => ({}));
    this.toDip = toDip || ((point) => point);
    this.isOwnPoint = isOwnPoint || (() => false);
    this.onSelection = onSelection || (() => {});

    this.uiohook = null;
    this.available = false;
    this.started = false;
    this.down = null;
    this.lastTriggerAt = 0;
    // 诊断用：第一次收到鼠标事件时写一条 info，用户能从日志确认「钩子到底通不通」
    this.stats = { down: 0, up: 0, move: 0, reported: 0 };

    this.onMouseDown = this.handleMouseDown.bind(this);
    this.onMouseMove = this.handleMouseMove.bind(this);
    this.onMouseUp = this.handleMouseUp.bind(this);
  }

  tryLoad() {
    if (this.uiohook) return true;
    try {
      // 延迟 require：即使原生模块加载失败，应用其它功能仍然可用
      const { uIOhook } = require('uiohook-napi');
      this.uiohook = uIOhook;
      this.available = true;
    } catch (error) {
      this.available = false;
      this.logger?.error('加载鼠标钩子失败', { message: error.message });
    }
    return this.available;
  }

  start() {
    if (this.started) return true;
    if (!this.tryLoad()) return false;
    try {
      this.uiohook.on('mousedown', this.onMouseDown);
      this.uiohook.on('mousemove', this.onMouseMove);
      this.uiohook.on('mouseup', this.onMouseUp);
      this.uiohook.start();
      this.started = true;
      this.logger?.info('鼠标监听已启动');
      return true;
    } catch (error) {
      this.logger?.error('启动鼠标监听失败', { message: error.message });
      return false;
    }
  }

  stop() {
    if (!this.started || !this.uiohook) return;
    try {
      this.uiohook.off('mousedown', this.onMouseDown);
      this.uiohook.off('mousemove', this.onMouseMove);
      this.uiohook.off('mouseup', this.onMouseUp);
      this.uiohook.stop();
    } catch (error) {
      this.logger?.warn('停止鼠标监听失败', { message: error.message });
    }
    this.started = false;
  }

  handleMouseDown(event) {
    this.stats.down += 1;
    if (this.stats.down === 1) {
      this.logger?.info('鼠标钩子已收到事件', { button: event.button, x: event.x, y: event.y });
    }
    if (event.button !== 1) return;
    const point = this.toDip({ x: event.x, y: event.y });
    this.down = {
      x: point.x,
      y: point.y,
      at: Date.now(),
      clicks: event.clicks || 1,
      ignored: this.isOwnPoint(point),
      maxDistance: 0,
    };
  }

  handleMouseMove(event) {
    this.stats.move += 1;
    if (!this.down) return;
    const point = this.toDip({ x: event.x, y: event.y });
    const moved = distance(this.down.x, this.down.y, point.x, point.y);
    if (moved > this.down.maxDistance) this.down.maxDistance = moved;
  }

  handleMouseUp(event) {
    const down = this.down;
    this.down = null;
    if (!down || event.button !== 1) return;

    const point = this.toDip({ x: event.x, y: event.y });
    // 在弹窗 / 设置窗口里点按，不当作划词
    if (down.ignored || this.isOwnPoint(point)) return;

    const settings = this.getSettings();
    if (!settings?.app?.enabled || !settings?.trigger?.mouseSelection) return;

    const now = Date.now();
    if (now - this.lastTriggerAt < 300) return;

    const totalDistance = Math.max(down.maxDistance, distance(down.x, down.y, point.x, point.y));
    const durationMs = now - down.at;

    const decision = shouldTriggerSelection({
      dragDistance: totalDistance,
      durationMs,
      clicks: Math.max(event.clicks || 1, down.clicks),
      minDragPx: settings.trigger.minDragPx,
      allowDrag: settings.trigger.mouseSelection,
      allowDoubleClick: settings.trigger.doubleClick,
    });

    this.logger?.debug('鼠标抬起', {
      distance: Math.round(totalDistance),
      durationMs,
      clicks: event.clicks,
      trigger: decision.trigger,
      reason: decision.reason,
    });

    if (!decision.trigger) {
      // 关掉「划词不弹」时可以只看这两个 info；原因细节留在 debug
      if (this.stats.reported < 5) {
        this.stats.reported += 1;
        this.logger?.debug('未触发划词', {
          reason: decision.reason,
          distance: Math.round(totalDistance),
          durationMs,
          clicks: event.clicks,
        });
      }
      return;
    }

    this.logger?.debug('判定为划词', {
      reason: decision.reason,
      distance: Math.round(totalDistance),
      durationMs,
      clicks: event.clicks,
    });
    this.lastTriggerAt = now;
    this.onSelection({ x: point.x, y: point.y, clicks: event.clicks || 1, source: decision.reason });
  }
}

module.exports = { SelectionMonitor };
