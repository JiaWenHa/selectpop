'use strict';

const { SEARCH_ENGINES, TRANSLATE_SITES } = require('./constants');
const { buildSearchQuery } = require('./text');

/** DeepL 用的是两位语言码 */
const DEEPL_LANG = {
  'zh-CN': 'zh',
  'zh-TW': 'zh',
  en: 'en',
  ja: 'ja',
  ko: 'ko',
  fr: 'fr',
  de: 'de',
  es: 'es',
  ru: 'ru',
  pt: 'pt',
  it: 'it',
  ar: 'ar',
  th: 'th',
  vi: 'vi',
};

/**
 * 规范化用户填写的 API Base URL：
 *  - 允许 https://api.deepseek.com、https://api.deepseek.com/v1、带尾部斜杠
 *  - 没有协议时补 https://
 * 返回去掉末尾斜杠的地址；非法时返回空串。
 */
function normalizeBaseUrl(raw) {
  const input = String(raw || '').trim();
  if (!input) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

/** 把 {query} / {text} / {lang} 占位符替换成编码后的值 */
function fillTemplate(template, vars) {
  return String(template || '').replace(/\{(query|text|lang)\}/g, (match, key) => {
    const value = vars[key];
    return value === undefined ? match : encodeURIComponent(value);
  });
}

/**
 * 搜索链接。
 * 自定义模板必须包含 {query}，否则回落到 Bing。
 */
function buildSearchUrl(engineId, rawText, customTemplate = '') {
  const text = buildSearchQuery(rawText);
  if (!text) return '';
  if (engineId === 'custom') {
    const template = String(customTemplate || '').trim();
    if (template.includes('{query}')) return fillTemplate(template, { query: text });
    return fillTemplate(SEARCH_ENGINES.bing.url, { query: text });
  }
  const engine = SEARCH_ENGINES[engineId] || SEARCH_ENGINES.bing;
  return fillTemplate(engine.url, { query: text });
}

/**
 * 网页翻译链接（没有 DeepSeek Key 时的兜底）。
 * needsClipboard 为 true 表示该站点不支持 URL 传参，需要先把原文放进剪贴板。
 */
function buildTranslateUrl(siteId, rawText, lang = 'zh-CN') {
  const text = String(rawText || '').trim();
  if (!text) return { url: '', needsClipboard: false };
  const site = TRANSLATE_SITES[siteId] || TRANSLATE_SITES.bing;
  if (site.id === 'deepl') {
    return {
      url: fillTemplate(site.url, { text, lang: DEEPL_LANG[lang] || 'zh' }),
      needsClipboard: false,
    };
  }
  if (site.id === 'youdao') {
    return { url: site.url, needsClipboard: true };
  }
  return { url: fillTemplate(site.url, { text, lang: encodeURIComponent(lang) }), needsClipboard: false };
}

module.exports = {
  normalizeBaseUrl,
  fillTemplate,
  buildSearchUrl,
  buildTranslateUrl,
  DEEPL_LANG,
};
