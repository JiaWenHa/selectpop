'use strict';

/**
 * 全局常量：动作定义、图标名、语言、搜索/翻译站点。
 * 这个文件被主进程和渲染进程共用，禁止引入 electron / node 内置模块。
 */

const APP_ID = 'com.selectpop.desktop';
const APP_NAME = 'SelectPop';
const APP_NAME_ZH = '划词助手';

/** 弹窗里的动作顺序即默认展示顺序 */
const ACTION_ORDER = ['copy', 'translate', 'search', 'explain', 'summarize', 'polish', 'grammar'];

/**
 * kind:
 *  - local    纯本地动作（写剪贴板）
 *  - external 打开浏览器
 *  - translate 翻译（AI 或网页，取决于设置）
 *  - ai       调用 DeepSeek
 */
const ACTIONS = {
  copy: { id: 'copy', kind: 'local', label: '复制', labelEn: 'Copy', icon: 'copy', hint: '1' },
  translate: { id: 'translate', kind: 'translate', label: '翻译', labelEn: 'Translate', icon: 'translate', hint: '2' },
  search: { id: 'search', kind: 'external', label: '搜索', labelEn: 'Search', icon: 'search', hint: '3' },
  explain: { id: 'explain', kind: 'ai', label: '解释', labelEn: 'Explain', icon: 'spark', hint: '4' },
  summarize: { id: 'summarize', kind: 'ai', label: '总结', labelEn: 'Summarize', icon: 'list', hint: '5' },
  polish: { id: 'polish', kind: 'ai', label: '润色', labelEn: 'Polish', icon: 'pen', hint: '6' },
  grammar: { id: 'grammar', kind: 'ai', label: '语法检查', labelEn: 'Grammar', icon: 'check', hint: '7' },
};

const ACTION_IDS = ACTION_ORDER.slice();

/** 翻译目标语言（code 用于提示词与网页链接） */
const LANGUAGES = [
  { code: 'zh-CN', name: '简体中文', native: '简体中文' },
  { code: 'zh-TW', name: '繁體中文', native: '繁體中文' },
  { code: 'en', name: '英语', native: 'English' },
  { code: 'ja', name: '日语', native: '日本語' },
  { code: 'ko', name: '韩语', native: '한국어' },
  { code: 'fr', name: '法语', native: 'Français' },
  { code: 'de', name: '德语', native: 'Deutsch' },
  { code: 'es', name: '西班牙语', native: 'Español' },
  { code: 'ru', name: '俄语', native: 'Русский' },
  { code: 'pt', name: '葡萄牙语', native: 'Português' },
  { code: 'it', name: '意大利语', native: 'Italiano' },
  { code: 'ar', name: '阿拉伯语', native: 'العربية' },
  { code: 'th', name: '泰语', native: 'ไทย' },
  { code: 'vi', name: '越南语', native: 'Tiếng Việt' },
];

const LANGUAGE_CODES = LANGUAGES.map((l) => l.code);

const SEARCH_ENGINES = {
  bing: { id: 'bing', name: 'Bing', url: 'https://www.bing.com/search?q={query}' },
  google: { id: 'google', name: 'Google', url: 'https://www.google.com/search?q={query}' },
  baidu: { id: 'baidu', name: '百度', url: 'https://www.baidu.com/s?wd={query}' },
  duckduckgo: { id: 'duckduckgo', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q={query}' },
  custom: { id: 'custom', name: '自定义', url: '' },
};

/** 无 API Key 时的网页翻译兜底 */
const TRANSLATE_SITES = {
  bing: { id: 'bing', name: 'Bing 翻译', url: 'https://www.bing.com/translator?text={text}' },
  google: {
    id: 'google',
    name: 'Google 翻译',
    url: 'https://translate.google.com/?sl=auto&tl={lang}&text={text}&op=translate',
  },
  deepl: { id: 'deepl', name: 'DeepL', url: 'https://www.deepl.com/translator#auto/{lang}/{text}' },
  youdao: { id: 'youdao', name: '有道翻译', url: 'https://fanyi.youdao.com/#/TextTranslate' },
};

const THEMES = ['system', 'light', 'dark'];
const TRANSLATE_MODES = ['auto', 'ai', 'web'];
const LOG_LEVELS = ['error', 'warn', 'info', 'debug'];

/** DeepSeek 官方可选模型 */
const AI_MODELS = [
  { id: 'deepseek-chat', name: 'deepseek-chat（通用对话）' },
  { id: 'deepseek-reasoner', name: 'deepseek-reasoner（深度思考）' },
];

module.exports = {
  APP_ID,
  APP_NAME,
  APP_NAME_ZH,
  ACTION_ORDER,
  ACTION_IDS,
  ACTIONS,
  LANGUAGES,
  LANGUAGE_CODES,
  SEARCH_ENGINES,
  TRANSLATE_SITES,
  THEMES,
  TRANSLATE_MODES,
  LOG_LEVELS,
  AI_MODELS,
};
