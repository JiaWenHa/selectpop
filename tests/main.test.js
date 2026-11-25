'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SelectionCapture } = require('../src/main/capture');
const { chatStream, testConnection, resolveEndpoints, DeepSeekError, DEFAULT_BASE_URL } = require('../src/main/deepseek');
const { SettingsStore, PLAIN_PREFIX } = require('../src/main/settings-store');
const { DEFAULTS } = require('../src/shared/settings-schema');

/* ------------------------------ 测试替身 ------------------------------ */

class FakeGuard {
  constructor(initial = '') {
    this.text = initial;
    this.writes = [];
    this.restored = null;
  }

  snapshot() {
    return { text: this.text, at: 0 };
  }

  writeText(value) {
    this.text = value;
    this.writes.push(value);
    return true;
  }

  readText() {
    return this.text;
  }

  restore(before, current) {
    this.restored = { before: before.text, current };
    const same = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    if (same(this.text) === same(current)) this.text = before.text;
  }
}

function sseStream(chunks) {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    getReader() {
      return {
        async read() {
          if (index >= chunks.length) return { done: true, value: undefined };
          const value = encoder.encode(chunks[index]);
          index += 1;
          return { done: false, value };
        },
      };
    },
  };
}

function streamResponse(chunks) {
  return {
    ok: true,
    status: 200,
    body: sseStream(chunks),
    async json() {
      throw new Error('不应读取 JSON');
    },
    async text() {
      return chunks.join('');
    },
  };
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: null,
    async json() {
      return payload;
    },
    async text() {
      return JSON.stringify(payload);
    },
  };
}

function errorResponse(status, payload) {
  return {
    ok: false,
    status,
    body: null,
    async json() {
      return payload;
    },
    async text() {
      return JSON.stringify(payload);
    },
  };
}

/* ------------------------------ 划词抓取 ------------------------------ */

test('SelectionCapture 成功抓到选区，并恢复原剪贴板', async () => {
  const guard = new FakeGuard('原来的剪贴板');
  const keySender = {
    async sendCopyShortcut() {
      guard.text = '  选中的文字  ';
      return true;
    },
  };
  const capture = new SelectionCapture({ keySender, guard, logger: null });
  const result = await capture.capture({ delayMs: 0, timeoutMs: 300 });

  assert.equal(result.ok, true);
  assert.equal(result.text, '选中的文字');
  assert.equal(result.reason, 'ok');
  assert.ok(Array.isArray(guard.writes) && guard.writes.length === 1);
  assert.match(guard.writes[0], /SelectPop-/); // 先写了哨兵值
  assert.equal(guard.text, '原来的剪贴板'); // 用完恢复
  assert.equal(guard.restored.before, '原来的剪贴板');
});

test('SelectionCapture 没有抓到时返回 no-selection，且不把哨兵当内容', async () => {
  const guard = new FakeGuard('a');
  const capture = new SelectionCapture({
    keySender: { async sendCopyShortcut() { return true; } },
    guard,
    logger: null,
  });
  const result = await capture.capture({ delayMs: 0, timeoutMs: 60, restoreClipboard: false });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-selection');
});

test('SelectionCapture 首次发送没反应时，先把焦点还给拖拽的窗口再补发', async () => {
  const guard = new FakeGuard('');
  const focused = [];
  const resolved = [];
  const capture = new SelectionCapture({
    keySender: {
      async sendCopyShortcut() {
        return true; // 发出去了，但剪贴板没变（焦点在别的窗口）
      },
      async sendCopyToWindow(hwnd) {
        focused.push(hwnd);
        guard.text = '补发拿到的选区';
        return true;
      },
    },
    guard,
    logger: null,
  });

  const result = await capture.capture({
    delayMs: 0,
    timeoutMs: 400,
    restoreClipboard: false,
    resolveTargetWindow: async () => {
      resolved.push(1);
      return { hwnd: 12345, process: 'msedge', title: '文档页面' };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.text, '补发拿到的选区');
  assert.deepEqual(focused, [12345]);
  assert.deepEqual(resolved, [1]);
});

test('SelectionCapture 没有拖拽窗口时退回到前台窗口补发', async () => {
  const guard = new FakeGuard('');
  const focused = [];
  const capture = new SelectionCapture({
    keySender: {
      async sendCopyShortcut() {
        return true;
      },
      async sendCopyToWindow(hwnd) {
        focused.push(hwnd);
        guard.text = '前台窗口补发';
        return true;
      },
    },
    guard,
    logger: null,
    foregroundProbe: async () => ({ hwnd: 777, process: 'Code', title: 'main.js' }),
  });

  const result = await capture.capture({ delayMs: 0, timeoutMs: 400, restoreClipboard: false });
  assert.equal(result.ok, true);
  assert.deepEqual(focused, [777]);
});

test('SelectionCapture 成功抓到选区时不会去解析拖拽窗口（省一次进程调用）', async () => {
  const guard = new FakeGuard('');
  let resolved = 0;
  const capture = new SelectionCapture({
    keySender: {
      async sendCopyShortcut() {
        guard.text = '一次就抓到了';
        return true;
      },
    },
    guard,
    logger: null,
  });

  const result = await capture.capture({
    delayMs: 0,
    timeoutMs: 200,
    restoreClipboard: false,
    resolveTargetWindow: async () => {
      resolved += 1;
      return { hwnd: 1, process: 'x', title: 'x' };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(resolved, 0);
});

test('SelectionCapture 在快捷键发送失败时给出 shortcut-failed', async () => {
  const guard = new FakeGuard('');
  const capture = new SelectionCapture({
    keySender: { async sendCopyShortcut() { return false; } },
    guard,
    logger: null,
  });
  const result = await capture.capture({ delayMs: 0, timeoutMs: 50 });
  assert.equal(result.reason, 'shortcut-failed');
});

test('SelectionCapture 抓到纯符号时返回 not-text', async () => {
  const guard = new FakeGuard('');
  const capture = new SelectionCapture({
    keySender: {
      async sendCopyShortcut() {
        guard.text = '—— …… ···';
        return true;
      },
    },
    guard,
    logger: null,
  });
  const result = await capture.capture({ delayMs: 0, timeoutMs: 80 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not-text');
});

test('SelectionCapture 并发调用时第二次直接返回 busy', async () => {
  const guard = new FakeGuard('');
  const capture = new SelectionCapture({
    keySender: {
      async sendCopyShortcut() {
        await new Promise((resolve) => setTimeout(resolve, 30));
        guard.text = '文字';
        return true;
      },
    },
    guard,
    logger: null,
  });
  const first = capture.capture({ delayMs: 0, timeoutMs: 200 });
  const second = await capture.capture({ delayMs: 0, timeoutMs: 100 });
  assert.equal(second.reason, 'busy');
  assert.equal((await first).ok, true);
});

/* ------------------------------ DeepSeek ------------------------------ */

test('resolveEndpoints 兼容各种 Base URL 写法', () => {
  assert.deepEqual(resolveEndpoints('https://api.deepseek.com'), {
    chat: 'https://api.deepseek.com/chat/completions',
    models: 'https://api.deepseek.com/models',
  });
  assert.deepEqual(resolveEndpoints('https://api.deepseek.com/v1/'), {
    chat: 'https://api.deepseek.com/v1/chat/completions',
    models: 'https://api.deepseek.com/v1/models',
  });
  assert.equal(resolveEndpoints('https://x.dev/v1/chat/completions').chat, 'https://x.dev/v1/chat/completions');
  assert.equal(resolveEndpoints('https://x.dev/v1/chat/completions').models, 'https://x.dev/v1/models');
  assert.equal(resolveEndpoints('').chat, `${DEFAULT_BASE_URL}/chat/completions`);
});

test('chatStream 逐段拼接流式内容、推理内容与 usage', async () => {
  const deltas = [];
  const reasoning = [];
  const chunks = [
    'data: {"choices":[{"delta":{"reasoning_content":"先想"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"你',
    '好"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"，世界"},"finish_reason":"stop"}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":5,"total_tokens":17}}\n\n',
    'data: [DONE]\n\n',
  ];
  const result = await chatStream({
    apiKey: 'sk-test',
    messages: [{ role: 'user', content: 'hi' }],
    onDelta: (delta) => deltas.push(delta),
    onReasoning: (delta) => reasoning.push(delta),
    fetchImpl: async (url, init) => {
      assert.equal(url, `${DEFAULT_BASE_URL}/chat/completions`);
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.Authorization, 'Bearer sk-test');
      const body = JSON.parse(init.body);
      assert.equal(body.stream, true);
      assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
      return streamResponse(chunks);
    },
  });

  assert.equal(result.text, '你好，世界');
  // 被网络切断的 JSON 会等这一块补齐后再一次性解析，所以「你」「好」合并成一段
  assert.deepEqual(deltas, ['你好', '，世界']);
  assert.equal(result.reasoning, '先想');
  assert.deepEqual(reasoning, ['先想']);
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.usage.total_tokens, 17);
});

test('chatStream 非流式模式直接读取 JSON', async () => {
  const result = await chatStream({
    apiKey: 'sk-test',
    stream: false,
    messages: [{ role: 'user', content: 'hi' }],
    fetchImpl: async () =>
      jsonResponse({
        model: 'deepseek-chat',
        choices: [{ message: { content: '答' }, finish_reason: 'stop' }],
        usage: { total_tokens: 3 },
      }),
  });
  assert.equal(result.text, '答');
  assert.equal(result.model, 'deepseek-chat');
  assert.equal(result.usage.total_tokens, 3);
});

test('chatStream 把 401 映射成 invalid-key 并带上详情', async () => {
  await assert.rejects(
    () =>
      chatStream({
        apiKey: 'bad',
        messages: [{ role: 'user', content: 'hi' }],
        fetchImpl: async () => errorResponse(401, { error: { message: 'Authentication Fails' } }),
      }),
    (error) => {
      assert.ok(error instanceof DeepSeekError);
      assert.equal(error.code, 'invalid-key');
      assert.equal(error.status, 401);
      assert.match(error.detail, /Authentication Fails/);
      assert.match(error.message, /API Key 无效/);
      return true;
    },
  );
});

test('chatStream 余额不足 402、服务繁忙 503 有对应错误码', async () => {
  const run = (status) =>
    chatStream({
      apiKey: 'k',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl: async () => errorResponse(status, {}),
    });
  await assert.rejects(() => run(402), (error) => error.code === 'insufficient-balance');
  await assert.rejects(() => run(503), (error) => error.code === 'overloaded');
});

test('chatStream 缺少 Key / 空消息 / 空响应都有明确报错', async () => {
  await assert.rejects(() => chatStream({ apiKey: '', messages: [{ role: 'user', content: 'x' }] }), (error) => error.code === 'no-key');
  await assert.rejects(() => chatStream({ apiKey: 'k', messages: [] }), (error) => error.code === 'empty');
  await assert.rejects(
    () =>
      chatStream({
        apiKey: 'k',
        messages: [{ role: 'user', content: 'x' }],
        fetchImpl: async () => streamResponse(['data: [DONE]\n\n']),
      }),
    (error) => error.code === 'empty-response',
  );
});

test('chatStream 网络错误被包装成中文提示', async () => {
  await assert.rejects(
    () =>
      chatStream({
        apiKey: 'k',
        messages: [{ role: 'user', content: 'x' }],
        fetchImpl: async () => {
          const error = new Error('getaddrinfo ENOTFOUND');
          error.cause = { code: 'ENOTFOUND' };
          throw error;
        },
      }),
    (error) => {
      assert.equal(error.code, 'network');
      assert.match(error.message, /无法连接 DeepSeek/);
      return true;
    },
  );
});

test('chatStream 可以被外部 signal 取消', async () => {
  const controller = new AbortController();
  const promise = chatStream({
    apiKey: 'k',
    messages: [{ role: 'user', content: 'x' }],
    signal: controller.signal,
    fetchImpl: (url, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      }),
  });
  controller.abort();
  await assert.rejects(() => promise, (error) => error.code === 'aborted');
});

test('testConnection 用 /models 验证 Key', async () => {
  const ok = await testConnection({
    apiKey: 'sk-test',
    fetchImpl: async (url, init) => {
      assert.equal(url, `${DEFAULT_BASE_URL}/models`);
      assert.equal(init.method, 'GET');
      return jsonResponse({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] });
    },
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.models, ['deepseek-chat', 'deepseek-reasoner']);

  const bad = await testConnection({
    apiKey: 'sk-bad',
    fetchImpl: async () => errorResponse(401, { error: { message: 'bad key' } }),
  });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /API Key 无效/);

  const missing = await testConnection({ apiKey: '' });
  assert.equal(missing.ok, false);
  assert.match(missing.message, /还没有填写/);
});

/* ------------------------------ 设置存储 ------------------------------ */

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'selectpop-test-'));
}

const fakeSafeStorageNoEncryption = {
  isEncryptionAvailable: () => false,
  encryptString: () => {
    throw new Error('not available');
  },
  decryptString: () => '',
};

test('SettingsStore 首次启动返回默认值并落盘', () => {
  const dir = tempDir();
  const store = new SettingsStore({ dir, safeStorage: fakeSafeStorageNoEncryption, logger: null });
  store.load();
  assert.deepEqual(store.get(), DEFAULTS);
  assert.equal(store.hasApiKey(), false);

  store.update({ popup: { width: 420 } });
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.equal(raw.settings.popup.width, 420);
  assert.equal(raw.version, DEFAULTS.version);
});

test('SettingsStore 加密不可用时用 raw:v1: 存储 Key，并可读回', () => {
  const dir = tempDir();
  const store = new SettingsStore({ dir, safeStorage: fakeSafeStorageNoEncryption, logger: null });
  store.load();
  store.setApiKey('sk-1234567890abcdef');

  assert.equal(store.getApiKey(), 'sk-1234567890abcdef');
  assert.equal(store.hasApiKey(), true);
  assert.equal(store.getPublic().keyHint, 'sk-…cdef');
  assert.equal(store.getPublic().settings.ai.model, DEFAULTS.ai.model);

  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.ok(raw.secrets.apiKey.startsWith(PLAIN_PREFIX));
  assert.equal(raw.secrets.apiKey.includes('sk-1234567890abcdef'), false);

  const reloaded = new SettingsStore({ dir, safeStorage: fakeSafeStorageNoEncryption, logger: null });
  reloaded.load();
  assert.equal(reloaded.getApiKey(), 'sk-1234567890abcdef');
  assert.equal(reloaded.getPublic().hasApiKey, true);
});

test('SettingsStore.update 只在真的有变化时触发 change', () => {
  const dir = tempDir();
  const store = new SettingsStore({ dir, safeStorage: fakeSafeStorageNoEncryption, logger: null });
  store.load();
  const events = [];
  store.on('change', (publicState, changed) => events.push({ publicState, changed }));

  store.update({ popup: { width: 400 } });
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].changed, ['popup.width']);

  store.update({ popup: { width: 400 } });
  assert.equal(events.length, 1); // 没变就不触发
});

test('SettingsStore 读到损坏的配置文件时回落到默认值', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'settings.json'), '{ 这不是 JSON', 'utf8');
  const store = new SettingsStore({ dir, safeStorage: fakeSafeStorageNoEncryption, logger: null });
  store.load();
  assert.deepEqual(store.get(), DEFAULTS);
});

test('SettingsStore 能读取带 BOM 的配置文件', () => {
  const dir = tempDir();
  const payload = JSON.stringify({ version: 1, settings: { popup: { width: 420 } }, secrets: {} });
  fs.writeFileSync(path.join(dir, 'settings.json'), '\uFEFF' + payload, 'utf8');
  const store = new SettingsStore({ dir, safeStorage: fakeSafeStorageNoEncryption, logger: null });
  store.load();
  assert.equal(store.get().popup.width, 420);
});

/* ------------------------------ 图标生成 ------------------------------ */

test('gen-icons 能生成合法 PNG，且尺寸正确', () => {
  const { encodePNG, encodeICO, render, trayTemplateSample, appIconSample } = require('../scripts/gen-icons');
  const size = 16;
  const rgba = render(size, appIconSample);
  assert.equal(rgba.length, size * size * 4);
  const png = encodePNG(size, size, rgba);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), size);
  assert.equal(png.readUInt32BE(20), size);

  // 圆角之外完全透明，中心不透明
  assert.equal(rgba[3], 0);
  const center = (8 * size + 8) * 4 + 3;
  assert.equal(rgba[center], 255);

  // 模板图标必须是纯黑 + alpha
  const template = render(8, trayTemplateSample);
  for (let i = 0; i < template.length; i += 4) {
    assert.equal(template[i], 0);
    assert.equal(template[i + 1], 0);
    assert.equal(template[i + 2], 0);
  }

  // .ico：目录头 + 每个尺寸的偏移必须落在文件内
  const ico = encodeICO([16, 32, 256].map((s) => ({ size: s, png: encodePNG(s, s, render(s, appIconSample)) })));
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 3);
  for (let index = 0; index < 3; index += 1) {
    const entry = 6 + index * 16;
    const length = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    assert.ok(offset + length <= ico.length);
    assert.deepEqual([...ico.subarray(offset, offset + 4)], [0x89, 0x50, 0x4e, 0x47]);
  }
  assert.equal(ico.readUInt8(6), 16);
  assert.equal(ico.readUInt8(6 + 32), 0); // 256 用 0 表示
});
