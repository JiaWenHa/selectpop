'use strict';

const { ACTIONS } = require('../shared/constants');
const { buildSearchUrl, buildTranslateUrl } = require('../shared/urls');
const { buildMessages, languageName } = require('../shared/prompts');
const { previewText, charCount } = require('../shared/text');
const { chatStream, DeepSeekError } = require('./deepseek');

/**
 * 弹窗的业务编排：
 *  - 维护当前划词会话
 *  - 执行动作（复制 / 搜索 / 网页翻译 / DeepSeek 流式生成）
 *  - 取消、自动关闭、错误提示
 *
 * 它不直接碰 Electron API，全部通过注入的 openExternal / notify 完成，
 * 方便单测和替换。
 */
class PopupController {
  constructor({ store, popup, guard, logger, openSettings, openExternal, notify, onSessionStart } = {}) {
    this.store = store;
    this.popup = popup;
    this.guard = guard;
    this.logger = logger;
    this.openSettings = openSettings || (() => {});
    this.openExternal = openExternal || (() => {});
    this.notify = notify || (() => {});
    this.onSessionStart = onSessionStart || (() => {});

    this.session = null;
    this.abortController = null;
    this.lastAction = null;
    this.autoHideTimer = null;
    this.busy = false;
  }

  get uiLang() {
    return this.store.get().app.uiLang === 'en-US' ? 'en-US' : 'zh-CN';
  }

  label(action) {
    return this.uiLang === 'en-US' ? action.labelEn : action.label;
  }

  buildPayload() {
    const settings = this.store.get();
    const actions = settings.popup.actions
      .map((id) => ACTIONS[id])
      .filter(Boolean)
      .map((action) => ({
        id: action.id,
        kind: action.kind,
        label: this.label(action),
        icon: action.icon,
        hint: action.hint,
      }));

    return {
      actions,
      hasApiKey: this.store.hasApiKey(),
      targetLang: settings.translate.targetLang,
      targetLangName: languageName(settings.translate.targetLang),
      uiLang: this.uiLang,
      fontScale: settings.popup.fontScale,
      width: settings.popup.width,
      autoHideMs: settings.popup.autoHideMs,
      translateMode: settings.translate.mode,
      platform: process.platform,
    };
  }

  /** 新建一次划词会话并弹出窗口 */
  async beginSession({ text, at, source = 'mouse' }) {
    const normalized = String(text || '');
    if (!normalized.trim()) return false;
    const settings = this.store.get();
    this.cancelAi();
    this.clearAutoHide();
    this.session = {
      text: normalized,
      at: { x: Math.round(at.x), y: Math.round(at.y) },
      source,
      startedAt: Date.now(),
    };
    this.lastAction = null;
    if (this.popup.isVisible()) this.popup.hide();

    try {
      await this.popup.show({
        text: normalized,
        at: this.session.at,
        payload: {
          ...this.buildPayload(),
          preview: previewText(normalized, settings.popup.maxPreviewChars),
          charCount: charCount(normalized),
          source,
        },
      });
    } catch (error) {
      this.logger?.error('显示弹窗失败', { message: error.message });
      return false;
    }

    this.onSessionStart(this.session);
    this.scheduleAutoHide();
    return true;
  }

  scheduleAutoHide(delayMs) {
    this.clearAutoHide();
    const delay = delayMs === undefined ? this.store.get().popup.autoHideMs : delayMs;
    if (!delay || delay <= 0) return;
    this.autoHideTimer = setTimeout(() => {
      this.autoHideTimer = null;
      this.hide();
    }, delay);
  }

  clearAutoHide() {
    if (this.autoHideTimer) {
      clearTimeout(this.autoHideTimer);
      this.autoHideTimer = null;
    }
  }

  cancelAi() {
    if (this.abortController) {
      try {
        this.abortController.abort();
      } catch {
        /* ignore */
      }
      this.abortController = null;
    }
    this.busy = false;
  }

  hide() {
    this.clearAutoHide();
    this.cancelAi();
    this.session = null;
    this.popup.hide();
  }

  toast(message, kind = 'info') {
    this.popup.send('popup:event', { type: 'toast', message, kind });
  }

  async runAction(actionId) {
    const session = this.session;
    if (!session) return { ok: false, reason: 'no-session' };
    const settings = this.store.get();
    const action = ACTIONS[actionId];
    if (!action) return { ok: false, reason: 'unknown-action' };
    if (!settings.popup.actions.includes(actionId)) return { ok: false, reason: 'disabled' };

    this.clearAutoHide();
    this.lastAction = actionId;

    try {
      switch (action.kind) {
        case 'local':
          await this.guard.writeText(session.text);
          this.toast(this.uiLang === 'en-US' ? 'Copied' : '已复制', 'success');
          setTimeout(() => this.hide(), 700);
          return { ok: true };

        case 'external': {
          const url = buildSearchUrl(settings.search.engine, session.text, settings.search.customUrl);
          if (!url) return { ok: false, reason: 'empty-query' };
          this.hide();
          this.openExternal(url);
          return { ok: true, url };
        }

        case 'translate': {
          const mode = settings.translate.mode;
          const useAi = mode === 'ai' || (mode === 'auto' && this.store.hasApiKey());
          if (!useAi) {
            const { url, needsClipboard } = buildTranslateUrl(
              settings.translate.webSite,
              session.text,
              settings.translate.targetLang,
            );
            if (!url) return { ok: false, reason: 'empty-text' };
            if (needsClipboard) await this.guard.writeText(session.text);
            this.hide();
            this.openExternal(url);
            return { ok: true, url, fallback: 'web' };
          }
          return this.runAi('translate');
        }

        default:
          return this.runAi(actionId);
      }
    } catch (error) {
      this.logger?.error('执行动作失败', { actionId, message: error.message });
      this.popup.send('popup:event', { type: 'error', message: '操作失败，请重试', code: 'action-failed' });
      return { ok: false, reason: 'error' };
    }
  }

  /** 调用 DeepSeek 流式生成 */
  async runAi(actionId) {
    const session = this.session;
    if (!session) return { ok: false, reason: 'no-session' };
    const settings = this.store.get();
    if (!this.store.hasApiKey()) {
      this.popup.send('popup:event', { type: 'need-key' });
      return { ok: false, reason: 'no-key' };
    }
    if (this.busy) this.cancelAi();

    const built = buildMessages({
      action: actionId,
      text: session.text,
      targetLang: settings.translate.targetLang,
      maxInputChars: settings.ai.maxInputChars,
      extraSystemPrompt: settings.ai.extraSystemPrompt,
      uiLang: this.uiLang,
      translatePrompt: settings.translate.aiPrompt,
    });

    this.abortController = new AbortController();
    this.busy = true;
    this.popup.send('popup:event', {
      type: 'action-start',
      action: actionId,
      title: this.uiLang === 'en-US' ? ACTIONS[actionId].labelEn : built.title,
      subtitle: actionId === 'translate' ? built.targetLangName : '',
      truncated: built.truncated,
      originalLength: built.originalLength,
    });

    try {
      const result = await chatStream({
        apiKey: this.store.getApiKey(),
        baseUrl: settings.ai.baseUrl,
        model: settings.ai.model,
        messages: built.messages,
        temperature: built.temperature,
        maxTokens: settings.ai.maxTokens,
        timeoutMs: settings.ai.timeoutMs,
        signal: this.abortController.signal,
        onDelta: (delta) => {
          this.popup.send('popup:event', { type: 'delta', text: delta });
        },
      });

      this.busy = false;
      this.abortController = null;
      this.popup.send('popup:event', {
        type: 'done',
        text: result.text,
        usage: result.usage,
        finishReason: result.finishReason,
        model: result.model,
      });
      this.scheduleAutoHide();
      return { ok: true, text: result.text };
    } catch (error) {
      this.busy = false;
      this.abortController = null;
      const code = error instanceof DeepSeekError ? error.code : 'unknown';
      if (code === 'aborted') {
        this.popup.send('popup:event', { type: 'aborted' });
        return { ok: false, reason: 'aborted' };
      }
      this.logger?.warn('DeepSeek 请求失败', { code, message: error.message, status: error.status });
      this.popup.send('popup:event', {
        type: 'error',
        message: error.message || '请求失败',
        code,
        status: error.status || 0,
      });
      if (code === 'invalid-key' || code === 'insufficient-balance' || code === 'no-key') {
        this.popup.send('popup:event', { type: 'need-key', message: error.message });
      }
      return { ok: false, reason: code };
    }
  }

  retry() {
    if (!this.lastAction) return { ok: false, reason: 'no-action' };
    if (!this.session) return { ok: false, reason: 'no-session' };
    return this.runAction(this.lastAction);
  }

  stop() {
    if (this.abortController) {
      this.cancelAi();
      return { ok: true };
    }
    return { ok: false };
  }

  openSettingsForUser(section = 'ai') {
    this.openSettings(section);
  }

  dispose() {
    this.clearAutoHide();
    this.cancelAi();
    this.session = null;
  }
}

module.exports = { PopupController };
