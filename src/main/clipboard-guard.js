'use strict';

const { normalizeText } = require('../shared/text');

function isThenable(value) {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof value.then === 'function'
  );
}

async function unwrap(value) {
  return isThenable(value) ? await value : value;
}

function asText(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (isThenable(value)) return '';
  if (typeof value.text === 'string') return value.text;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (typeof value === 'object') return '';
  return String(value);
}

/**
 * 剪贴板守卫：读写 + 快照恢复。
 *
 * 划词需要「借」剪贴板来拿选区内容，所以：
 *  1. 先快照用户原来的内容
 *  2. 用完立刻恢复
 *  3. 恢复前确认当前内容是刚才抓到的选区（避免把用户新复制的东西覆盖掉）
 *
 * 关于 API 差异：Electron 45 起主进程的 clipboard 换成了异步的 Web Clipboard 风格
 * （readText/writeText 返回 Promise，read/write 收发 ClipboardItem，且不再提供
 * readHTML/readRTF）。老版本仍是同步 API。这里统一 await + 特性探测，两代都能跑。
 */
class ClipboardGuard {
  constructor({ clipboard, logger } = {}) {
    this.clipboard = clipboard;
    this.logger = logger;
  }

  hasMethod(name) {
    return !!this.clipboard && typeof this.clipboard[name] === 'function';
  }

  /** 老式同步 API 才支持富文本往返 */
  supportsRichText() {
    return this.hasMethod('readHTML') || this.hasMethod('readRTF');
  }

  async readText() {
    try {
      if (this.hasMethod('readText')) {
        return asText(await unwrap(this.clipboard.readText()));
      }
      if (this.hasMethod('read')) {
        const items = await unwrap(this.clipboard.read());
        const list = Array.isArray(items) ? items : [];
        for (const item of list) {
          if (item && typeof item.getType === 'function') {
            try {
              const blob = await unwrap(item.getType('text/plain'));
              if (blob && typeof blob.text === 'function') return asText(await blob.text());
              if (typeof blob === 'string') return blob;
            } catch {
              /* 换下一种格式 */
            }
          }
        }
      }
      return '';
    } catch (error) {
      this.logger?.warn('读取剪贴板失败', { message: error.message });
      return '';
    }
  }

  async writeText(text) {
    const value = typeof text === 'string' ? text : String(text ?? '');
    try {
      if (this.hasMethod('writeText')) {
        await unwrap(this.clipboard.writeText(value));
        return true;
      }
      return false;
    } catch (error) {
      this.logger?.warn('写入剪贴板失败', { message: error.message });
      return false;
    }
  }

  async snapshot() {
    const text = await this.readText();
    let html = '';
    let rtf = '';
    if (this.hasMethod('readHTML')) {
      try {
        html = asText(await unwrap(this.clipboard.readHTML()));
      } catch (error) {
        this.logger?.warn('读取剪贴板 HTML 失败', { message: error.message });
      }
    }
    if (this.hasMethod('readRTF')) {
      try {
        rtf = asText(await unwrap(this.clipboard.readRTF()));
      } catch (error) {
        this.logger?.warn('读取剪贴板 RTF 失败', { message: error.message });
      }
    }
    return { text, html, rtf };
  }

  /**
   * @param {{text:string,html?:string,rtf?:string}} snapshot
   * @param {string} [onlyIfCurrentEquals] 当前剪贴板内容等于它时才恢复
   * @returns {Promise<boolean>} 是否真正写过剪贴板
   */
  async restore(snapshot, onlyIfCurrentEquals) {
    if (!snapshot) return false;
    try {
      if (onlyIfCurrentEquals !== undefined) {
        const current = await this.readText();
        if (normalizeText(current) !== normalizeText(onlyIfCurrentEquals)) return false;
      }

      const html = typeof snapshot.html === 'string' ? snapshot.html : '';
      const rtf = typeof snapshot.rtf === 'string' ? snapshot.rtf : '';
      if ((html || rtf) && this.supportsRichText() && this.hasMethod('write')) {
        // 老式 API：write({ text, html, rtf })
        const payload = {};
        if (html) payload.html = html;
        if (!html && rtf) payload.rtf = rtf;
        if (snapshot.text) payload.text = snapshot.text;
        await unwrap(this.clipboard.write(payload));
        return true;
      }

      if (snapshot.text) return await this.writeText(snapshot.text);

      if (this.hasMethod('clear')) {
        await unwrap(this.clipboard.clear());
        return true;
      }
      return false;
    } catch (error) {
      this.logger?.warn('恢复剪贴板失败', { message: error.message });
      return false;
    }
  }
}

module.exports = { ClipboardGuard, asText, unwrap, isThenable };
