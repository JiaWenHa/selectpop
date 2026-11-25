'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { describeForeground, describeWindowAt, runWinInfo } = require('../src/main/foreground');

/** 造一个假的 execFile：记录参数，返回预设的 stdout */
function fakeExec(stdout, error = null) {
  const calls = [];
  const impl = (file, args, options, callback) => {
    calls.push({ file, args, options });
    callback(error, stdout, '');
  };
  return { impl, calls };
}

const isWindows = process.platform === 'win32';

test('runWinInfo 解析 wininfo 的 TAB 分隔输出', async (t) => {
  if (!isWindows) return t.skip('仅 Windows 有 wininfo.exe');
  const { impl, calls } = fakeExec('62460266\t54064\tmsedge\t文档 标题\t带 TAB\t尾\n');
  const info = await runWinInfo({ helperPath: 'C:/x/wininfo.exe', execFileImpl: impl });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, []);
  assert.equal(info.hwnd, 62460266);
  assert.equal(info.pid, 54064);
  assert.equal(info.process, 'msedge');
  assert.equal(info.title, '文档 标题\t带 TAB\t尾');
});

test('describeWindowAt 把坐标传给 at 子命令', async (t) => {
  if (!isWindows) return t.skip('仅 Windows 有 wininfo.exe');
  const { impl, calls } = fakeExec('111\t222\texplorer\t桌面\n');
  const info = await describeWindowAt(700.4, 900.6, { helperPath: 'C:/x/wininfo.exe', execFileImpl: impl });

  assert.deepEqual(calls[0].args, ['at', '700', '901']);
  assert.equal(info.hwnd, 111);
  assert.equal(info.process, 'explorer');
});

test('坐标不是数字时不去调用外部程序', async (t) => {
  if (!isWindows) return t.skip('仅 Windows 有 wininfo.exe');
  const { impl, calls } = fakeExec('111\t222\texplorer\t桌面\n');
  const info = await describeWindowAt('abc', null, { helperPath: 'C:/x/wininfo.exe', execFileImpl: impl });

  assert.equal(info, null);
  assert.equal(calls.length, 0);
});

test('没有 helper 路径时直接返回 null（不影响取词）', async () => {
  const info = await describeForeground({ helperPath: '' });
  assert.equal(info, null);
});

test('wininfo 失败或输出不可解析时返回 null', async (t) => {
  if (!isWindows) return t.skip('仅 Windows 有 wininfo.exe');
  const failed = fakeExec('', new Error('spawn ENOENT'));
  assert.equal(await runWinInfo({ helperPath: 'C:/x/wininfo.exe', execFileImpl: failed.impl }), null);

  const empty = fakeExec('\n');
  assert.equal(await runWinInfo({ helperPath: 'C:/x/wininfo.exe', execFileImpl: empty.impl }), null);

  const zero = fakeExec('0\t0\t\t\n');
  assert.equal(await runWinInfo({ helperPath: 'C:/x/wininfo.exe', execFileImpl: zero.impl }), null);
});
