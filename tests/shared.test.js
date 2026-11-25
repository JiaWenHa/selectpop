'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const text = require('../src/shared/text');
const urls = require('../src/shared/urls');
const { createSSEParser } = require('../src/shared/sse');
const { computePopupBounds, clamp, pointInRect } = require('../src/shared/placement');
const { shouldTriggerSelection, isDuplicateCapture } = require('../src/shared/selection');
const { DEFAULTS, normalizeSettings, applyPatch, diffSettings, isValidAccelerator } = require('../src/shared/settings-schema');
const { buildMessages, ACTION_CONFIG } = require('../src/shared/prompts');
const { ACTIONS, ACTION_ORDER, SEARCH_ENGINES, TRANSLATE_SITES } = require('../src/shared/constants');

test('text.normalizeText 统一换行、去掉零宽字符与尾部空白', () => {
  assert.equal(text.normalizeText('  a\r\nb\u200b\t \n c  '), 'a\nb\n c');
  assert.equal(text.normalizeText(null), '');
  assert.equal(text.normalizeText('   \n\t '), '');
});

test('text.isMeaningful 只认真实文字', () => {
  assert.equal(text.isMeaningful('hello'), true);
  assert.equal(text.isMeaningful('中文'), true);
  assert.equal(text.isMeaningful('12'), true);
  assert.equal(text.isMeaningful('…—·'), false);
  assert.equal(text.isMeaningful(''), false);
});

test('text.charCount / previewText 按码点计数与截断', () => {
  assert.equal(text.charCount('中文😀'), 3);
  assert.equal(text.previewText('a\n\nb   c', 140), 'a b c');
  const long = 'x'.repeat(200);
  const short = text.previewText(long, 20);
  assert.equal(Array.from(short).length, 20);
  assert.ok(short.endsWith('…'));
});

test('text.truncateForModel 超长时标注截断并保留原始长度', () => {
  const ok = text.truncateForModel('abc', 10);
  assert.deepEqual(ok, { text: 'abc', truncated: false, originalLength: 3 });
  const cut = text.truncateForModel('abcdef', 3);
  assert.equal(cut.truncated, true);
  assert.equal(cut.originalLength, 6);
  assert.ok(cut.text.startsWith('abc'));
  assert.match(cut.text, /已截断/);
});

test('text.buildSearchQuery 去掉省略号；looksLikeUrl 判断链接', () => {
  assert.equal(text.buildSearchQuery('a'.repeat(50), 10), 'a'.repeat(9));
  assert.equal(text.looksLikeUrl('https://example.com/a?b=1'), true);
  assert.equal(text.looksLikeUrl('www.example.com'), true);
  assert.equal(text.looksLikeUrl('example.com/path'), true);
  assert.equal(text.looksLikeUrl('hello world'), false);
  assert.equal(text.looksLikeUrl('中文。'), false);
});

test('text.hashText 稳定且区分内容', () => {
  assert.equal(text.hashText('abc'), text.hashText('abc'));
  assert.notEqual(text.hashText('abc'), text.hashText('abd'));
});

test('urls.normalizeBaseUrl 兼容多种写法', () => {
  assert.equal(urls.normalizeBaseUrl('https://api.deepseek.com/'), 'https://api.deepseek.com');
  assert.equal(urls.normalizeBaseUrl('api.deepseek.com/v1'), 'https://api.deepseek.com/v1');
  assert.equal(urls.normalizeBaseUrl('http://127.0.0.1:8080/v1/'), 'http://127.0.0.1:8080/v1');
  assert.equal(urls.normalizeBaseUrl('ftp://x.com'), '');
  assert.equal(urls.normalizeBaseUrl(''), '');
});

test('urls.buildSearchUrl 使用引擎模板并对查询编码', () => {
  const url = urls.buildSearchUrl('bing', '你好 world');
  assert.ok(url.startsWith('https://www.bing.com/search?q='));
  assert.ok(url.includes(encodeURIComponent('你好 world')));
  // 自定义模板缺少 {query} 时回落到 Bing
  assert.ok(urls.buildSearchUrl('custom', 'abc', 'https://example.com/?q={query}').startsWith('https://example.com/?q=abc'));
  assert.ok(urls.buildSearchUrl('custom', 'abc', 'https://example.com/').includes('bing.com'));
  assert.equal(urls.buildSearchUrl('bing', '   '), '');
  assert.equal(urls.buildSearchUrl('unknown-engine', 'abc'), urls.buildSearchUrl('bing', 'abc'));
});

test('urls.buildTranslateUrl 处理 Deepl / 有道 / 常规站点', () => {
  const deepl = urls.buildTranslateUrl('deepl', 'hello', 'zh-CN');
  assert.equal(deepl.needsClipboard, false);
  assert.ok(deepl.url.includes('#auto/zh/hello'));

  const youdao = urls.buildTranslateUrl('youdao', 'hello', 'zh-CN');
  assert.equal(youdao.needsClipboard, true);
  assert.ok(youdao.url.startsWith('https://'));

  const bing = urls.buildTranslateUrl('bing', 'hello world', 'ja');
  assert.equal(bing.needsClipboard, false);
  assert.ok(bing.url.includes(encodeURIComponent('hello world')));

  assert.deepEqual(urls.buildTranslateUrl('bing', '', 'ja'), { url: '', needsClipboard: false });
});

test('SSE 解析器能处理跨 chunk 切断的 JSON 与 [DONE]', () => {
  const events = [];
  const parser = createSSEParser((event) => events.push(event));
  const payload = 'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n';
  const cut = 20;
  parser.feed(payload.slice(0, cut));
  parser.feed(payload.slice(cut));
  parser.feed(': keep-alive\n\n');
  parser.feed('data: {"choices":[{"delta":{"content":"世界"}}]}\n\ndata: [DONE]\n\n');
  parser.end();

  assert.equal(events.length, 3);
  assert.equal(events[0].type, 'message');
  assert.equal(events[0].data.choices[0].delta.content, '你好');
  assert.equal(events[1].data.choices[0].delta.content, '世界');
  assert.deepEqual(events[2], { type: 'done' });
});

test('SSE 解析器把非法 JSON 报成 invalid，而不是崩溃', () => {
  const events = [];
  const parser = createSSEParser((event) => events.push(event));
  parser.feed('data: {oops\n\n');
  assert.equal(events[0].type, 'invalid');
  assert.equal(events[0].raw, '{oops');
});

test('computePopupBounds 默认出现在光标右下方', () => {
  const bounds = computePopupBounds({
    cursor: { x: 400, y: 300 },
    size: { width: 384, height: 320 },
    workArea: { x: 0, y: 0, width: 1920, height: 1080 },
  });
  assert.deepEqual(bounds, { x: 416, y: 320, width: 384, height: 320 });
});

test('computePopupBounds 右侧放不下时翻到左侧', () => {
  const bounds = computePopupBounds({
    cursor: { x: 1800, y: 300 },
    size: { width: 384, height: 320 },
    workArea: { x: 0, y: 0, width: 1920, height: 1080 },
  });
  assert.equal(bounds.x, 1800 - 384 - 16);
});

test('computePopupBounds 下方放不下时翻到上方，并夹紧在工作区内', () => {
  const bounds = computePopupBounds({
    cursor: { x: 100, y: 1050 },
    size: { width: 384, height: 320 },
    workArea: { x: 0, y: 0, width: 1920, height: 1080 },
  });
  assert.equal(bounds.y, 1050 - 320 - 20);
  assert.ok(bounds.y + bounds.height <= 1080 - 10);
});

test('computePopupBounds 支持负坐标的第二显示器', () => {
  const bounds = computePopupBounds({
    cursor: { x: -1500, y: 100 },
    size: { width: 384, height: 320 },
    workArea: { x: -1920, y: 0, width: 1920, height: 1080 },
  });
  assert.ok(bounds.x >= -1920 + 10);
  assert.ok(bounds.x + bounds.width <= 0);
});

test('clamp / pointInRect', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-5, 0, 10), 0);
  assert.equal(clamp(50, 0, 10), 10);
  assert.equal(pointInRect({ x: 5, y: 5 }, { x: 0, y: 0, width: 10, height: 10 }), true);
  assert.equal(pointInRect({ x: 15, y: 5 }, { x: 0, y: 0, width: 10, height: 10 }), false);
  assert.equal(pointInRect(null, { x: 0, y: 0, width: 1, height: 1 }), false);
});

test('shouldTriggerSelection 覆盖拖拽、双击与各种误触', () => {
  assert.deepEqual(shouldTriggerSelection({ dragDistance: 60, durationMs: 400 }), {
    trigger: true,
    reason: 'drag',
  });
  assert.equal(shouldTriggerSelection({ dragDistance: 3 }).reason, 'too-small');
  assert.equal(shouldTriggerSelection({ dragDistance: 1200 }).reason, 'too-far');
  assert.equal(shouldTriggerSelection({ dragDistance: 60, durationMs: 9000 }).reason, 'too-slow');
  assert.equal(shouldTriggerSelection({ dragDistance: 60, allowDrag: false }).reason, 'drag-disabled');
  assert.deepEqual(shouldTriggerSelection({ clicks: 2 }), { trigger: true, reason: 'double-click' });
  assert.equal(shouldTriggerSelection({ clicks: 2, allowDoubleClick: false }).trigger, false);
});

test('isDuplicateCapture 同文案在时间窗内去重', () => {
  assert.equal(isDuplicateCapture({ previousText: 'abc', previousAt: 1000, text: 'abc', now: 1200 }), true);
  assert.equal(isDuplicateCapture({ previousText: 'abc', previousAt: 1000, text: 'abc', now: 3000 }), false);
  assert.equal(isDuplicateCapture({ previousText: 'abc', previousAt: 1000, text: 'abd', now: 1100 }), false);
  assert.equal(isDuplicateCapture({ previousText: '', previousAt: 0, text: 'abc', now: 10 }), false);
});

test('normalizeSettings 补全缺失字段并修正非法值', () => {
  const settings = normalizeSettings({
    trigger: { minDragPx: '999', hotkey: 'not-a-hotkey' },
    ai: { baseUrl: 'api.deepseek.com/v1/', temperature: 9, maxTokens: -5 },
    theme: 'neon',
    popup: { actions: ['copy', 'unknown'] },
  });
  assert.equal(settings.trigger.minDragPx, 40);
  assert.equal(settings.trigger.hotkey, DEFAULTS.trigger.hotkey);
  assert.equal(settings.ai.baseUrl, 'https://api.deepseek.com/v1');
  assert.equal(settings.ai.temperature, 2);
  assert.equal(settings.ai.maxTokens, 64);
  assert.deepEqual(settings.popup.actions, ['copy']); // 未知动作被丢弃
  assert.equal(settings.app.theme, DEFAULTS.app.theme);
  assert.equal(settings.version, DEFAULTS.version);
  // 默认值本身必须是合法的
  assert.deepEqual(normalizeSettings(DEFAULTS), DEFAULTS);
});

test('popup.actions 顺序按 ACTION_ORDER 归一，并至少保留一项', () => {
  const settings = normalizeSettings({ popup: { actions: ['search', 'copy'] } });
  assert.deepEqual(settings.popup.actions, ['copy', 'search']);
  const empty = normalizeSettings({ popup: { actions: [] } });
  assert.deepEqual(empty.popup.actions, ['copy', 'translate', 'search']);
  const all = normalizeSettings({ popup: { actions: ACTION_ORDER } });
  assert.deepEqual(all.popup.actions, ACTION_ORDER);
});

test('applyPatch 只改给定字段，diffSettings 报出被修正的路径', () => {
  const base = normalizeSettings(DEFAULTS);
  const next = applyPatch(base, { popup: { width: 9999 } });
  assert.equal(next.popup.width, 560);
  assert.equal(next.popup.fontScale, base.popup.fontScale);
  assert.deepEqual(diffSettings(base, next), ['popup.width']);
});

test('isValidAccelerator 校验快捷键写法', () => {
  assert.equal(isValidAccelerator('CommandOrControl+Shift+Space'), true);
  assert.equal(isValidAccelerator('Alt+F2'), true);
  assert.equal(isValidAccelerator('F9'), true); // 功能键可以单独注册
  assert.equal(isValidAccelerator('Space'), false); // 单独的空格会抢走全局输入
  assert.equal(isValidAccelerator('CommandOrControl+'), false);
  assert.equal(isValidAccelerator('CommandOrControl'), false); // 只有修饰键不算
  assert.equal(isValidAccelerator('Shift+A'), true);
  assert.equal(isValidAccelerator(42), false);
});

test('buildMessages 按动作生成提示词、温度与目标语言', () => {
  const built = buildMessages({ action: 'translate', text: 'hello', targetLang: 'ja' });
  assert.equal(built.temperature, ACTION_CONFIG.translate.temperature);
  assert.equal(built.targetLangName, '日本語');
  assert.equal(built.title, '翻译');
  assert.equal(built.truncated, false);
  assert.equal(built.messages.length, 2);
  assert.equal(built.messages[0].role, 'system');
  assert.match(built.messages[0].content, /<selected_text>/);
  assert.equal(built.messages[1].content, '<selected_text>\nhello\n</selected_text>');
  assert.throws(() => buildMessages({ action: 'unknown', text: 'x' }), /未知动作/);
});

test('buildMessages 超长输入被截断并在系统提示里附加用户偏好', () => {
  const built = buildMessages({
    action: 'summarize',
    text: 'x'.repeat(50),
    maxInputChars: 10,
    extraSystemPrompt: '  用要点回答  ',
  });
  assert.equal(built.truncated, true);
  assert.equal(built.originalLength, 50);
  assert.match(built.messages[0].content, /用要点回答/);
  assert.equal(built.messages[0].content.includes('  用要点回答  '), false); // 已 trim
});

test('buildMessages 语法检查动作有独立提示词与低温', () => {
  const built = buildMessages({ action: 'grammar', text: 'i has a apple', targetLang: 'zh-CN' });
  assert.equal(built.temperature, ACTION_CONFIG.grammar.temperature);
  assert.equal(built.title, '语法检查');
  assert.match(built.messages[0].content, /语法/);
  assert.match(built.messages[0].content, /改为：/);
  assert.match(built.messages[0].content, /修改后全文/);
  assert.equal(built.messages[1].content, '<selected_text>\ni has a apple\n</selected_text>');
});

test('buildMessages 翻译支持自定义提示词并替换 {lang}', () => {
  const built = buildMessages({
    action: 'translate',
    text: 'hello',
    targetLang: 'ja',
    translatePrompt: '  把 <selected_text> 译成{lang}，用敬语  ',
  });
  assert.equal(built.targetLangName, '日本語');
  assert.match(built.messages[0].content, /译成日本語，用敬语/);
  assert.equal(built.messages[0].content.includes('把 <selected_text> 中的文本翻译成'), false); // 默认任务被替换
});

test('buildMessages 翻译留空提示词时退回默认', () => {
  const built = buildMessages({ action: 'translate', text: 'hello', targetLang: 'zh-CN', translatePrompt: '   ' });
  assert.match(built.messages[0].content, /翻译成简体中文/);
});

test('常量自洽：动作、引擎、翻译站点都有必要字段', () => {
  for (const id of ACTION_ORDER) {
    const action = ACTIONS[id];
    assert.ok(action, `缺少动作 ${id}`);
    assert.ok(action.label);
    assert.ok(['local', 'translate', 'external', 'ai'].includes(action.kind));
  }
  for (const [id, engine] of Object.entries(SEARCH_ENGINES)) {
    assert.ok(engine.name, id);
    if (id !== 'custom') assert.match(engine.url, /\{query\}/, id);
  }
  for (const [id, site] of Object.entries(TRANSLATE_SITES)) {
    assert.ok(site.name, id);
    assert.ok(site.url.startsWith('https://'), id);
  }
});
