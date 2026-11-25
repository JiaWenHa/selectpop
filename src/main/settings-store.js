'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { DEFAULTS, normalizeSettings, applyPatch, diffSettings, deepMerge } = require('../shared/settings-schema');

const SECRET_PREFIX = 'enc:v1:';
const PLAIN_PREFIX = 'raw:v1:';

/**
 * 设置与密钥的持久化。
 *
 * 文件结构：
 * {
 *   "version": 1,
 *   "settings": { ...normalizeSettings 之后的设置... },
 *   "secrets":  { "apiKey": "enc:v1:..." }
 * }
 *
 * API Key 使用 Electron 的 safeStorage（Windows DPAPI / macOS Keychain）加密；
 * 加密不可用时退化为 base64 存储，并在日志里明确警告。
 */
class SettingsStore extends EventEmitter {
  constructor({ dir, safeStorage, logger } = {}) {
    super();
    this.dir = dir;
    this.file = path.join(dir, 'settings.json');
    this.safeStorage = safeStorage;
    this.logger = logger;
    this.settings = normalizeSettings(DEFAULTS);
    this.secrets = { apiKey: '' };
    this.apiKeyCache = null;
  }

  load() {
    let parsed = null;
    try {
      // 记事本 / PowerShell 写出的 UTF-8 可能带 BOM，JSON.parse 会直接失败
      const text = fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '');
      parsed = JSON.parse(text);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.logger?.warn('读取设置失败，使用默认设置', { message: error.message });
      }
    }

    if (parsed && typeof parsed === 'object') {
      const rawSettings = parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : parsed;
      this.settings = normalizeSettings(deepMerge(DEFAULTS, rawSettings));
      this.secrets = {
        apiKey: typeof parsed.secrets?.apiKey === 'string' ? parsed.secrets.apiKey : '',
      };
    }
    this.apiKeyCache = null;
    return this.settings;
  }

  save() {
    const payload = {
      version: DEFAULTS.version,
      settings: this.settings,
      secrets: this.secrets,
    };
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, this.file);
      return true;
    } catch (error) {
      this.logger?.error('保存设置失败', { message: error.message });
      return false;
    }
  }

  get() {
    return this.settings;
  }

  update(patch) {
    const next = applyPatch(this.settings, patch);
    const changed = diffSettings(this.settings, next);
    this.settings = next;
    if (changed.length > 0) {
      this.save();
      this.emit('change', this.getPublic(), changed);
    }
    return { settings: this.settings, changed };
  }

  encrypt(value) {
    if (!value) return '';
    try {
      if (this.safeStorage?.isEncryptionAvailable?.()) {
        return `${SECRET_PREFIX}${this.safeStorage.encryptString(value).toString('base64')}`;
      }
    } catch (error) {
      this.logger?.warn('系统加密不可用，API Key 将以明文形式保存', { message: error.message });
    }
    return `${PLAIN_PREFIX}${Buffer.from(value, 'utf8').toString('base64')}`;
  }

  decrypt(stored) {
    if (!stored) return '';
    try {
      if (stored.startsWith(SECRET_PREFIX)) {
        if (!this.safeStorage?.isEncryptionAvailable?.()) {
          this.logger?.warn('系统加密不可用，无法解密已保存的 API Key');
          return '';
        }
        return this.safeStorage.decryptString(Buffer.from(stored.slice(SECRET_PREFIX.length), 'base64'));
      }
      if (stored.startsWith(PLAIN_PREFIX)) {
        return Buffer.from(stored.slice(PLAIN_PREFIX.length), 'base64').toString('utf8');
      }
      return '';
    } catch (error) {
      this.logger?.warn('解密 API Key 失败', { message: error.message });
      return '';
    }
  }

  getApiKey() {
    if (this.apiKeyCache === null) this.apiKeyCache = this.decrypt(this.secrets.apiKey);
    return this.apiKeyCache;
  }

  setApiKey(rawKey) {
    const key = String(rawKey || '').trim();
    this.secrets.apiKey = this.encrypt(key);
    this.apiKeyCache = key;
    this.save();
    this.emit('change', this.getPublic(), ['secrets.apiKey']);
    return true;
  }

  hasApiKey() {
    return Boolean(this.getApiKey());
  }

  getPublic() {
    const key = this.getApiKey();
    let keyHint = '';
    if (key.length > 8) keyHint = `${key.slice(0, 3)}…${key.slice(-4)}`;
    else if (key) keyHint = '已设置';
    return {
      settings: this.settings,
      hasApiKey: Boolean(key),
      keyHint,
    };
  }
}

module.exports = { SettingsStore, SECRET_PREFIX, PLAIN_PREFIX };
