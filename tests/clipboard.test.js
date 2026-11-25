'use strict';

// 剪贴板适配层：Electron 45 起 clipboard 是异步 Web Clipboard API（Promise + ClipboardItem），
// 老版本仍是同步 readHTML/readRTF，这里两种都覆盖。

const test = require('node:test');
const assert = require('node:assert/strict');

const { ClipboardGuard, asText, isThenable } = require('../src/main/clipboard-guard');

/** 新版：异步 API，有 readText/writeText，没有 readHTML */
function modernClipboard(initial = '') {
  const state = { text: initial, writes: [] };
  return {
    state,
    async readText() {
      return state.text;
    },
    async writeText(value) {
      state.text = value;
      state.writes.push(value);
    },
    async clear() {
      state.text = '';
    },
    async has() {
      return state.text.length > 0;
    },
  };
}

/** 只有 read/write（ClipboardItem 形态），没有 readText */
function itemClipboard(initial = '') {
  const state = { text: initial };
  return {
    state,
    async read() {
      const value = state.text;
      return [
        {
          types: ['text/plain'],
          async getType(type) {
            if (type !== 'text/plain') throw new Error('unsupported');
            return { text: async () => value };
          },
        },
      ];
    },
    async write() {
      throw new Error('clipboard.write expects an array of ClipboardItem');
    },
  };
}

/** 老版本：同步 API + 富文本 */
function legacyClipboard(initial = '', html = '<b>hi</b>') {
  const state = { text: initial, html, writes: [] };
  return {
    state,
    readText: () => state.text,
    writeText: (value) => {
      state.text = value;
      state.writes.push({ text: value });
    },
    readHTML: () => state.html,
    readRTF: () => '',
    write: (payload) => {
      state.writes.push(payload);
      state.text = payload.text ?? '';
      state.html = payload.html ?? '';
    },
    clear: () => {
      state.text = '';
      state.html = '';
    },
  };
}

test('isThenable / asText 处理 Promise 与各种返回值', () => {
  assert.equal(isThenable(Promise.resolve('x')), true);
  assert.equal(isThenable('x'), false);
  assert.equal(asText('abc'), 'abc');
  assert.equal(asText(null), '');
  assert.equal(asText(undefined), '');
  assert.equal(asText(Buffer.from('你好', 'utf8')), '你好');
  assert.equal(asText({ text: 'inner' }), 'inner');
  assert.equal(asText({ weird: 1 }), '');
  assert.equal(asText(Promise.resolve('x')), '');
});

test('异步剪贴板：读写、快照、按内容判定恢复', async () => {
  const clipboard = modernClipboard('原来的内容');
  const guard = new ClipboardGuard({ clipboard });

  assert.equal(await guard.readText(), '原来的内容');
  assert.equal(await guard.writeText('新内容'), true);
  assert.equal(clipboard.state.text, '新内容');

  const snapshot = await guard.snapshot();
  assert.deepEqual(snapshot, { text: '新内容', html: '', rtf: '' });

  // 当前内容等于「我们抓到的文本」才恢复
  await guard.writeText('抓到的选区');
  assert.equal(await guard.restore(snapshot, '抓到的选区'), true);
  assert.equal(await guard.readText(), '新内容');

  // 用户又复制了别的东西：不覆盖
  await guard.writeText('用户新复制');
  assert.equal(await guard.restore(snapshot, '抓到的选区'), false);
  assert.equal(await guard.readText(), '用户新复制');
});

test('异步剪贴板：空内容时用 clear 而不是写入空串', async () => {
  let cleared = 0;
  const clipboard = modernClipboard('临时内容');
  clipboard.clear = async () => {
    cleared += 1;
    clipboard.state.text = '';
  };
  const guard = new ClipboardGuard({ clipboard });

  const snapshot = await guard.snapshot();
  snapshot.text = '';
  assert.equal(await guard.restore(snapshot), true);
  assert.equal(cleared, 1);
});

test('只有 read/write 的 ClipboardItem 剪贴板也能读出文字', async () => {
  const guard = new ClipboardGuard({ clipboard: itemClipboard('item 内容') });
  assert.equal(await guard.readText(), 'item 内容');
  assert.equal(await guard.writeText('写不进去'), false);
  assert.equal(await guard.readText(), 'item 内容');
});

test('老式同步剪贴板：保留 HTML 快照并按富文本恢复', async () => {
  const clipboard = legacyClipboard('旧文本', '<b>旧</b>');
  const guard = new ClipboardGuard({ clipboard });

  assert.equal(guard.supportsRichText(), true);
  const snapshot = await guard.snapshot();
  assert.equal(snapshot.text, '旧文本');
  assert.equal(snapshot.html, '<b>旧</b>');

  await guard.writeText('临时');
  assert.equal(await guard.restore(snapshot, '临时'), true);
  assert.equal(clipboard.state.text, '旧文本');
  assert.equal(clipboard.state.html, '<b>旧</b>');
  const last = clipboard.state.writes.at(-1);
  assert.deepEqual(last, { html: '<b>旧</b>', text: '旧文本' });
});

test('新版剪贴板没有 readHTML 时不会去调它', async () => {
  const clipboard = modernClipboard('纯文本');
  const guard = new ClipboardGuard({ clipboard });
  assert.equal(guard.supportsRichText(), false);
  assert.deepEqual(await guard.snapshot(), { text: '纯文本', html: '', rtf: '' });
});

test('读写剪贴板抛错时返回兜底值，不把异常抛给调用方', async () => {
  const clipboard = {
    async readText() {
      throw new Error('read boom');
    },
    async writeText() {
      throw new Error('write boom');
    },
  };
  const guard = new ClipboardGuard({ clipboard });
  assert.equal(await guard.readText(), '');
  assert.equal(await guard.writeText('x'), false);
});
