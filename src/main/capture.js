'use strict';

const { normalizeText, isMeaningful } = require('../shared/text');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 把「当前选区」抓进剪贴板并读出文字。
 *
 * 关键点：先把剪贴板写成一个唯一的哨兵值，再发 Ctrl+C / Cmd+C。
 * 这样即使用户选中的文字和剪贴板里原来的内容一模一样，也能判断出「复制成功了」，
 * 而什么都没选中时剪贴板仍是哨兵值，不会误弹窗。
 */
class SelectionCapture {
  constructor({ keySender, guard, logger, foregroundProbe = null, now = () => Date.now() } = {}) {
    this.keySender = keySender;
    this.guard = guard;
    this.logger = logger;
    this.foregroundProbe = foregroundProbe;
    this.now = now;
    this.busy = false;
    this.resolveTargetWindow = null;
    this.targetWindow = null;
  }

  makeSentinel() {
    // 零宽字符组成，肉眼不可见，也不会被输入法/历史记录误认成正常文本
    return `\u200b\u2063SelectPop-${this.now().toString(36)}-\u2063\u200b`;
  }

  /**
   * @param {object} options
   * @param {number} [options.delayMs] 抬起鼠标到发快捷键之间的等待
   * @param {number} [options.timeoutMs] 等待剪贴板变化的最长时间
   * @param {boolean} [options.restoreClipboard] 用完是否恢复原剪贴板
   * @param {() => Promise<{hwnd:number,process:string,title:string}|null>} [options.resolveTargetWindow]
   *    懒加载「用户真正拖拽的那个窗口」。只在第一次 Ctrl+C 没抓到东西时才调用，
   *    避免每次划词都多 spawn 一个进程。
   * @returns {Promise<{ok:boolean, text?:string, reason?:string, durationMs:number}>}
   */
  async capture({
    delayMs = 90,
    timeoutMs = 450,
    restoreClipboard = true,
    resolveTargetWindow = null,
  } = {}) {
    if (this.busy) return { ok: false, reason: 'busy', durationMs: 0 };
    this.busy = true;
    this.resolveTargetWindow = typeof resolveTargetWindow === 'function' ? resolveTargetWindow : null;
    this.targetWindow = null;
    const startedAt = this.now();
    const before = await this.guard.snapshot();
    let sentinel = '';
    let usedSentinel = false;
    let text = '';

    try {
      sentinel = this.makeSentinel();
      usedSentinel = await this.guard.writeText(sentinel);
      if (!usedSentinel) {
        // 写不进剪贴板就退回「比较旧内容」的模式
        sentinel = before.text;
      }

      if (delayMs > 0) await sleep(delayMs);

      const sendAt = this.now();
      let shortcutOk = false;
      try {
        shortcutOk = await this.keySender.sendCopyShortcut();
      } catch (error) {
        this.logger?.warn('发送复制快捷键失败', { message: error.message });
        return { ok: false, reason: 'shortcut-failed', durationMs: this.now() - startedAt };
      }
      if (!shortcutOk) {
        return { ok: false, reason: 'shortcut-failed', durationMs: this.now() - startedAt };
      }

      // 轮询剪贴板。有的程序（尤其是浏览器）要等一两百毫秒才响应 Ctrl+C，
      // 所以没反应时再补发一次，避免「偶发没弹窗」。
      const deadline = sendAt + timeoutMs;
      const retryGap = Math.max(120, Math.round(timeoutMs * 0.45));
      let retries = 0;
      let nextRetryAt = sendAt + retryGap;
      while (this.now() < deadline) {
        text = await this.guard.readText();
        if (text && normalizeText(text) !== normalizeText(sentinel)) break;
        if (retries < 1 && this.now() >= nextRetryAt && this.now() + 60 < deadline) {
          retries += 1;
          await this.retryWithFocus();
          nextRetryAt = this.now() + retryGap;
        }
        await sleep(25);
      }

      const normalized = normalizeText(text);
      if (!normalized || normalized === normalizeText(sentinel)) {
        const target = await this.targetOfInterest();
        if (target) {
          // 失败时把「Ctrl+C 当时发给谁」记下来：绝大多数 no-selection 都是焦点不对
          this.logger?.info('未抓到选区时的目标窗口', { process: target.process, title: target.title });
        }
        this.logger?.debug('没有抓到新选区', { timeoutMs, sentinelWritten: usedSentinel });
        return { ok: false, reason: 'no-selection', durationMs: this.now() - startedAt };
      }
      if (!isMeaningful(normalized)) {
        return { ok: false, reason: 'not-text', durationMs: this.now() - startedAt };
      }

      return { ok: true, text: normalized, reason: 'ok', durationMs: this.now() - startedAt };
    } finally {
      if (restoreClipboard) {
        // 只有当前内容仍是「我们抓到的文本」时才恢复，避免覆盖用户随后复制的新内容
        const current = text ? normalizeText(text) : sentinel;
        try {
          await this.guard.restore(before, current);
        } catch (error) {
          this.logger?.warn('恢复剪贴板失败', { message: error.message });
        }
      }
      this.busy = false;
      this.resolveTargetWindow = null;
      this.targetWindow = null;
    }
  }

  /**
   * 补发一次 Ctrl+C。
   *
   * 优先把焦点还给「用户真正拖拽的那个窗口」（懒加载 resolveTargetWindow），
   * 没有的话退回到当前前台窗口。拖拽结束时焦点偶尔会被托盘、通知气泡或其它程序
   * 抢走，这时普通的 SendInput 把 ^C 发给了错的窗口，剪贴板却纹丝不动。
   *
   * 注意：Chromium 窗口一旦失去焦点，选区通常会被清掉，所以对浏览器这类目标，
   * 重新聚焦并不能找回选区；这条路径主要帮到 Notepad / Word 这类「失焦不清选区」
   * 的程序，以及「焦点被抢但选区还在」的场景。
   */
  async retryWithFocus() {
    const target = await this.targetOfInterest();
    if (target && typeof this.keySender.sendCopyToWindow === 'function') {
      try {
        await this.keySender.sendCopyToWindow(target.hwnd);
        this.logger?.debug('已重新聚焦后补发复制', { process: target.process, title: target.title });
        return;
      } catch (error) {
        this.logger?.debug('聚焦后补发失败，改用普通方式', { message: error.message });
      }
    }
    try {
      await this.keySender.sendCopyShortcut();
    } catch (error) {
      this.logger?.debug('重试发送复制快捷键失败', { message: error.message });
    }
  }

  /** 这次抓取「关心」的窗口：优先懒加载的拖拽窗口，其次当前前台窗口 */
  async targetOfInterest() {
    if (this.targetWindow) return this.targetWindow;
    if (this.resolveTargetWindow) {
      try {
        this.targetWindow = await this.resolveTargetWindow();
      } catch (error) {
        this.logger?.debug('读取拖拽窗口失败', { message: error.message });
      }
      if (this.targetWindow) return this.targetWindow;
    }
    return this.describeTarget();
  }

  /** 读取前台窗口信息（Windows 专属，其它平台返回 null） */
  async describeTarget() {
    if (typeof this.foregroundProbe !== 'function') return null;
    try {
      return await this.foregroundProbe();
    } catch (error) {
      this.logger?.debug('读取前台窗口失败', { message: error.message });
      return null;
    }
  }
}

module.exports = { SelectionCapture, sleep };
