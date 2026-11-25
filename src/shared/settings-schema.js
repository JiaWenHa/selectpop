'use strict';

const {
  ACTION_IDS,
  LANGUAGE_CODES,
  THEMES,
  TRANSLATE_MODES,
  LOG_LEVELS,
  TRANSLATE_SITES,
  SEARCH_ENGINES,
} = require('./constants');
const { normalizeBaseUrl } = require('./urls');

/** 设置默认值。升级时新增的字段会自动合并进来，不会破坏老配置。 */
const DEFAULTS = {
  version: 1,
  app: {
    enabled: true,
    launchAtLogin: false,
    theme: 'system',
    uiLang: 'zh-CN',
  },
  trigger: {
    mouseSelection: true,
    doubleClick: true,
    minDragPx: 6,
    copyDelayMs: 90,
    clipboardTimeoutMs: 450,
    hotkey: 'CommandOrControl+Shift+Space',
  },
  popup: {
    actions: ACTION_IDS.slice(),
    maxPreviewChars: 140,
    autoHideMs: 0,
    width: 384,
    fontScale: 1,
  },
  clipboard: { restore: true },
  translate: { targetLang: 'zh-CN', mode: 'auto', webSite: 'bing', aiPrompt: '' },
  search: { engine: 'bing', customUrl: '' },
  ai: {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    temperature: 1.3,
    maxTokens: 1200,
    maxInputChars: 4000,
    timeoutMs: 60000,
    extraSystemPrompt: '',
  },
  advanced: { logLevel: 'info' },
};

const MODIFIERS = new Set(['CommandOrControl', 'Command', 'Control', 'Alt', 'Option', 'Shift', 'Super', 'Meta']);
const KEY_PATTERN =
  /^([A-Z]|[0-9]|F([1-9]|1[0-9]|2[0-4])|Space|Enter|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right|Plus|Minus|[`~!@#$%^&*()_+\-=[\]{};':",./<>?\\|])$/;

/** Electron accelerator 的宽松校验，真正注册时还会再 try/catch 一次 */
function isValidAccelerator(accelerator) {
  if (typeof accelerator !== 'string') return false;
  const parts = accelerator.split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 1 || parts.length > 5) return false;
  const key = parts.pop();
  if (MODIFIERS.has(key)) return false;
  if (!KEY_PATTERN.test(key)) return false;
  if (!parts.every((m) => MODIFIERS.has(m))) return false;
  // 单独的 Space / 字母会把全局输入抢走，只允许不常用的功能键单独注册
  if (parts.length === 0 && !/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) return false;
  return true;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function getPath(object, path) {
  return path.split('.').reduce((acc, key) => (acc && typeof acc === 'object' ? acc[key] : undefined), object);
}

function setPath(object, path, value) {
  const keys = path.split('.');
  let cursor = object;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const key = keys[i];
    if (!cursor[key] || typeof cursor[key] !== 'object') cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[keys[keys.length - 1]] = value;
  return object;
}

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** 深合并：对象递归，数组整体替换 */
function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return clone(base);
  const output = clone(base);
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(output[key])) {
      output[key] = deepMerge(output[key], value);
    } else if (value !== undefined) {
      output[key] = isPlainObject(value) ? clone(value) : value;
    }
  }
  return output;
}

const bool = (fallback) => (value) => (typeof value === 'boolean' ? value : value === 'true' ? true : value === 'false' ? false : fallback);
const int = (min, max, fallback) => (value) => {
  const n = typeof value === 'number' ? value : Number.parseFloat(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), min), max);
};
const num = (min, max, fallback) => (value) => {
  const n = typeof value === 'number' ? value : Number.parseFloat(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
};
const enumOf = (values, fallback) => (value) => (values.includes(value) ? value : fallback);
const text = (maxLength, fallback = '') => (value) => {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
};

/** 校验规则表：key 为点路径，value 为「取值 → 合法值」的函数 */
const SPECS = {
  'app.enabled': bool(DEFAULTS.app.enabled),
  'app.launchAtLogin': bool(DEFAULTS.app.launchAtLogin),
  'app.theme': enumOf(THEMES, DEFAULTS.app.theme),
  'app.uiLang': enumOf(['zh-CN', 'en-US'], DEFAULTS.app.uiLang),

  'trigger.mouseSelection': bool(DEFAULTS.trigger.mouseSelection),
  'trigger.doubleClick': bool(DEFAULTS.trigger.doubleClick),
  'trigger.minDragPx': int(2, 40, DEFAULTS.trigger.minDragPx),
  'trigger.copyDelayMs': int(0, 800, DEFAULTS.trigger.copyDelayMs),
  'trigger.clipboardTimeoutMs': int(100, 2000, DEFAULTS.trigger.clipboardTimeoutMs),
  'trigger.hotkey': (value) => {
    if (value === '') return '';
    return isValidAccelerator(value) ? value : DEFAULTS.trigger.hotkey;
  },

  'popup.actions': (value) => {
    if (!Array.isArray(value)) return DEFAULTS.popup.actions.slice();
    const picked = ACTION_IDS.filter((id) => value.includes(id));
    return picked.length ? picked : ['copy', 'translate', 'search'];
  },
  'popup.maxPreviewChars': int(40, 600, DEFAULTS.popup.maxPreviewChars),
  'popup.autoHideMs': int(0, 15000, DEFAULTS.popup.autoHideMs),
  'popup.width': int(320, 560, DEFAULTS.popup.width),
  'popup.fontScale': num(0.85, 1.4, DEFAULTS.popup.fontScale),

  'clipboard.restore': bool(DEFAULTS.clipboard.restore),

  'translate.targetLang': enumOf(LANGUAGE_CODES, DEFAULTS.translate.targetLang),
  'translate.mode': enumOf(TRANSLATE_MODES, DEFAULTS.translate.mode),
  'translate.webSite': enumOf(Object.keys(TRANSLATE_SITES), DEFAULTS.translate.webSite),
  'translate.aiPrompt': text(2000, DEFAULTS.translate.aiPrompt),

  'search.engine': enumOf(Object.keys(SEARCH_ENGINES), DEFAULTS.search.engine),
  'search.customUrl': text(500, DEFAULTS.search.customUrl),

  'ai.baseUrl': (value) => normalizeBaseUrl(value) || DEFAULTS.ai.baseUrl,
  'ai.model': text(80, DEFAULTS.ai.model) || DEFAULTS.ai.model,
  'ai.temperature': num(0, 2, DEFAULTS.ai.temperature),
  'ai.maxTokens': int(64, 8192, DEFAULTS.ai.maxTokens),
  'ai.maxInputChars': int(200, 20000, DEFAULTS.ai.maxInputChars),
  'ai.timeoutMs': int(5000, 180000, DEFAULTS.ai.timeoutMs),
  'ai.extraSystemPrompt': text(2000, DEFAULTS.ai.extraSystemPrompt),

  'advanced.logLevel': enumOf(LOG_LEVELS, DEFAULTS.advanced.logLevel),
};

/**
 * 把任意输入（可能是老版本配置、手改坏的 JSON、渲染进程传来的 patch）
 * 规整成一份完整、类型正确、范围合法的设置。
 */
function normalizeSettings(input) {
  const source = isPlainObject(input) ? input : {};
  const output = {};
  for (const [path, coerce] of Object.entries(SPECS)) {
    const raw = getPath(source, path);
    const value = raw === undefined ? clone(getPath(DEFAULTS, path)) : coerce(raw);
    setPath(output, path, value);
  }
  output.version = DEFAULTS.version;
  return output;
}

/** 在现有设置上应用部分更新（patch 里只出现需要改的字段） */
function applyPatch(current, patch) {
  return normalizeSettings(deepMerge(normalizeSettings(current), patch));
}

/** 返回 patch 中被修正过的字段，便于界面提示 */
function diffSettings(a, b) {
  const changed = [];
  const walk = (left, right, prefix) => {
    const keys = new Set([...Object.keys(left || {}), ...Object.keys(right || {})]);
    for (const key of keys) {
      const path = prefix ? `${prefix}.${key}` : key;
      const l = left ? left[key] : undefined;
      const r = right ? right[key] : undefined;
      if (isPlainObject(l) && isPlainObject(r)) walk(l, r, path);
      else if (JSON.stringify(l) !== JSON.stringify(r)) changed.push(path);
    }
  };
  walk(a, b, '');
  return changed;
}

module.exports = {
  DEFAULTS,
  SPECS,
  normalizeSettings,
  applyPatch,
  deepMerge,
  diffSettings,
  getPath,
  setPath,
  isValidAccelerator,
};
