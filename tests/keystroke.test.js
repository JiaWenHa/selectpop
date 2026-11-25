'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { KeySender } = require('../src/main/keystroke');

/* 说明：这里只测「选哪条通道、脚本长什么样」这类纯逻辑。
   真正的按键注入和进程 spawn 不放进单测——它依赖交互式桌面，也依赖 spawn 权限。 */

function tempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `selectpop-${label}-`));
  return dir;
}

test('Windows 上有 sendcopy.exe 时优先用它（serve 模式）', () => {
  const dir = tempDir('keys');
  const helper = path.join(dir, 'sendcopy.exe');
  fs.writeFileSync(helper, 'stub');
  const sender = new KeySender({ platform: 'win32', helperPath: helper, scriptDir: dir });

  assert.equal(sender.hasHelper(), true);
  const plan = sender.plan();
  assert.equal(plan.kind, 'helper');
  assert.equal(plan.file, helper);
  assert.deepEqual(plan.args, ['serve']);
});

test('Windows 上没有 sendcopy.exe 时退回 cscript + VBS', () => {
  const dir = tempDir('keys');
  const sender = new KeySender({
    platform: 'win32',
    helperPath: path.join(dir, 'missing.exe'),
    scriptDir: dir,
  });

  assert.equal(sender.hasHelper(), false);
  const plan = sender.plan();
  assert.equal(plan.kind, 'cscript');
  assert.equal(plan.file, 'cscript.exe');
  assert.equal(plan.args[0], '//nologo');
  assert.equal(plan.args[1], '//B');

  // 两个 VBS 应该已经写到 scriptDir
  const worker = fs.readFileSync(path.join(dir, 'selectpop-keys-worker.vbs'), 'utf8');
  const once = fs.readFileSync(path.join(dir, 'selectpop-keys-once.vbs'), 'utf8');
  assert.match(worker, /READY/);
  assert.match(worker, /SendKeys "\^c"/);
  assert.match(worker, /"quit"/);
  assert.match(once, /SendKeys "\^c"/);
  assert.ok(worker.includes('\r\n'), 'VBS 用 CRLF 换行');
});

test('macOS 不碰 Windows 那一套', () => {
  const dir = tempDir('keys');
  const sender = new KeySender({ platform: 'darwin', scriptDir: dir, helperPath: 'C:\\x\\sendcopy.exe' });
  assert.equal(sender.hasHelper(), false);
  // 非 Windows 不会写 VBS
  assert.equal(fs.existsSync(path.join(dir, 'selectpop-keys-worker.vbs')), false);
});

test('dispose 在没有常驻进程时是安全的，且可重复调用', () => {
  const dir = tempDir('keys');
  const sender = new KeySender({ platform: 'win32', scriptDir: dir });
  assert.doesNotThrow(() => sender.dispose());
  assert.doesNotThrow(() => sender.dispose());
});

test('warmup 在非 Windows 平台直接返回', async () => {
  const dir = tempDir('keys');
  const sender = new KeySender({ platform: 'darwin', scriptDir: dir });
  assert.equal(await sender.warmup(), undefined);
});
