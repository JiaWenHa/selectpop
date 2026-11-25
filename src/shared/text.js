'use strict';

/** 文本处理工具：与平台无关，可单独测试。 */

const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF]/g;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * 清洗剪贴板读到的文本：统一换行、去掉零宽字符与控制字符、去掉首尾空白。
 * 保留内部换行与缩进，避免破坏代码格式。
 */
function normalizeText(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(ZERO_WIDTH_RE, '')
    .replace(CONTROL_RE, '')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

/** 是否有实际内容（至少一个字母/数字/汉字） */
function isMeaningful(text) {
  return /[\p{L}\p{N}]/u.test(text || '');
}

/** 按码点计数，避免中文/emoji 被算成两个字符 */
function charCount(text) {
  return Array.from(text || '').length;
}

/**
 * 弹窗顶部预览：折叠换行与多余空白，按码点截断。
 */
function previewText(text, max = 140) {
  const flat = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(flat);
  if (chars.length <= max) return flat;
  return `${chars.slice(0, Math.max(1, max - 1)).join('')}…`;
}

/** 截断长文本给模型，超出时显式标注，避免模型以为原文就这么短 */
function truncateForModel(text, maxChars) {
  const chars = Array.from(text || '');
  if (!maxChars || chars.length <= maxChars) {
    return { text: text || '', truncated: false, originalLength: chars.length };
  }
  return {
    text: `${chars.slice(0, maxChars).join('')}\n\n[…原文过长，已截断，共 ${chars.length} 个字符]`,
    truncated: true,
    originalLength: chars.length,
  };
}

/** 搜索框用：折叠空白，限制长度 */
function buildSearchQuery(text, max = 200) {
  return previewText(text, max).replace(/…$/, '');
}

/** 简单判断是否为链接 */
function looksLikeUrl(text) {
  const t = String(text || '').trim();
  if (!t || /\s/.test(t)) return false;
  return /^(https?:\/\/|www\.)\S+$/i.test(t) || /^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(t);
}

/**
 * 计算两次鼠标位置之间的欧氏距离（uiohook 给的是屏幕物理像素，这里只用于阈值比较，
 * 阈值会按缩放系数换算，所以相对比较是安全的）。
 */
function distance(x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return Math.sqrt(dx * dx + dy * dy);
}

/** FNV-1a，用于「同一段文字短时间内不重复弹窗」的去重，不需要密码学强度 */
function hashText(text) {
  let h = 0x811c9dc5;
  const s = String(text || '');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

module.exports = {
  normalizeText,
  isMeaningful,
  charCount,
  previewText,
  truncateForModel,
  buildSearchQuery,
  looksLikeUrl,
  distance,
  hashText,
};
