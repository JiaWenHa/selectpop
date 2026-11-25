#!/usr/bin/env node
'use strict';

/**
 * 不开界面，直接验证 DeepSeek 接入链路（密钥、网络、SSE 流式、错误映射）。
 * 这段逻辑和弹窗里用的是同一份 src/main/deepseek.js，所以它通过就代表 AI 部分是通的。
 *
 *   node scripts/check-api.js --key sk-xxxx
 *   node scripts/check-api.js --key sk-xxxx --action summarize --lang zh-CN --text "要总结的内容"
 *   node scripts/check-api.js --key sk-xxxx --test
 *   DEEPSEEK_API_KEY=sk-xxxx node scripts/check-api.js
 */

const { chatStream, testConnection, DeepSeekError, DEFAULT_BASE_URL } = require('../src/main/deepseek');
const { buildMessages, ACTION_CONFIG } = require('../src/shared/prompts');
const { ACTION_IDS } = require('../src/shared/constants');

const SAMPLE_TEXT = 'The quick brown fox jumps over the lazy dog. SelectPop should translate this sentence as soon as the mouse selection ends.';

function parseArgs(argv) {
  const options = {
    key: process.env.DEEPSEEK_API_KEY || '',
    baseUrl: process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL,
    model: 'deepseek-chat',
    action: 'translate',
    lang: 'zh-CN',
    text: SAMPLE_TEXT,
    testOnly: false,
    stream: true,
    temperature: null,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} 缺少取值`);
      return argv[index];
    };
    switch (arg) {
      case '--key':
        options.key = next();
        break;
      case '--base':
      case '--base-url':
        options.baseUrl = next();
        break;
      case '--model':
        options.model = next();
        break;
      case '--action':
        options.action = next();
        break;
      case '--lang':
        options.lang = next();
        break;
      case '--text':
        options.text = next();
        break;
      case '--temperature':
        options.temperature = Number(next());
        break;
      case '--test':
        options.testOnly = true;
        break;
      case '--no-stream':
        options.stream = false;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        if (arg.startsWith('--')) throw new Error(`未知参数 ${arg}`);
        options.text = arg;
    }
  }
  return options;
}

function usage() {
  const actions = ACTION_IDS.join(' | ');
  process.stdout.write(
    [
      '用法: node scripts/check-api.js --key sk-xxxx [选项]',
      '',
      '  --key <key>        DeepSeek API Key（也可用环境变量 DEEPSEEK_API_KEY）',
      '  --base <url>       API 地址，默认 https://api.deepseek.com',
      '  --model <name>     deepseek-chat（默认）或 deepseek-reasoner',
      `  --action <name>    ${actions}，默认 translate`,
      '  --lang <code>      目标语言，默认 zh-CN',
      '  --text <文本>      要处理的文字，默认一句英文',
      '  --temperature <n>  覆盖默认温度',
      '  --test             只请求 /models，不做补全',
      '  --no-stream        关掉流式，一次性拿完整结果',
      '  -h, --help         显示这段帮助',
      '',
    ].join('\n'),
  );
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`参数错误: ${error.message}\n\n`);
    usage();
    return 1;
  }

  if (options.help) {
    usage();
    return 0;
  }

  if (!options.key) {
    process.stderr.write('缺少 API Key：用 --key sk-xxxx 传入，或设置环境变量 DEEPSEEK_API_KEY。\n');
    process.stderr.write('在 https://platform.deepseek.com/api_keys 申请。\n');
    return 1;
  }
  if (!ACTION_CONFIG[options.action]) {
    process.stderr.write(`未知动作 ${options.action}，可用：${ACTION_IDS.join(', ')}\n`);
    return 1;
  }

  process.stdout.write(`接口  ${options.baseUrl}\n模型  ${options.model}\n`);

  const startedAt = Date.now();
  const connection = await testConnection({ apiKey: options.key, baseUrl: options.baseUrl });
  if (!connection.ok) {
    process.stderr.write(`✗ 连接失败（${Date.now() - startedAt}ms）：${connection.message}\n`);
    return 2;
  }
  process.stdout.write(`✓ 连接正常（${Date.now() - startedAt}ms）${connection.models?.length ? `，可用模型: ${connection.models.join(', ')}` : ''}\n`);
  if (options.testOnly) return 0;

  const { messages, temperature, title } = buildMessages({
    action: options.action,
    text: options.text,
    targetLang: options.lang,
  });

  process.stdout.write(`\n动作  ${title}（temperature ${options.temperature ?? temperature}）\n原文  ${options.text.slice(0, 80)}${options.text.length > 80 ? '…' : ''}\n---- 输出 ----\n`);

  let firstCharAt = 0;
  let chars = 0;
  const requestStarted = Date.now();

  const result = await chatStream({
    apiKey: options.key,
    baseUrl: options.baseUrl,
    model: options.model,
    messages,
    temperature: options.temperature ?? temperature,
    stream: options.stream,
    onDelta: (delta) => {
      if (!firstCharAt && delta) firstCharAt = Date.now();
      chars += delta.length;
      process.stdout.write(delta);
    },
    onReasoning: (delta) => {
      if (!firstCharAt && delta) firstCharAt = Date.now();
      process.stdout.write(delta);
    },
  });

  const elapsed = Date.now() - requestStarted;
  process.stdout.write(`\n---- 结束 ----\n`);
  process.stdout.write(`首字延迟  ${firstCharAt ? firstCharAt - requestStarted : 'n/a'}ms\n`);
  process.stdout.write(`总耗时    ${elapsed}ms，共 ${result.text.length} 字符\n`);
  if (result.usage) {
    process.stdout.write(`用量      prompt ${result.usage.prompt_tokens ?? '?'} / completion ${result.usage.completion_tokens ?? '?'} / total ${result.usage.total_tokens ?? '?'}\n`);
  }
  if (result.finishReason) process.stdout.write(`结束原因  ${result.finishReason}\n`);
  if (!result.text.trim()) {
    process.stderr.write('✗ 返回内容为空\n');
    return 2;
  }
  process.stdout.write(`✓ 链路正常，收到 ${chars} 个增量字符\n`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    if (error instanceof DeepSeekError) {
      process.stderr.write(`✗ ${error.message}\n`);
      if (error.code) process.stderr.write(`  代码: ${error.code}${error.status ? ` / HTTP ${error.status}` : ''}\n`);
      if (error.detail) process.stderr.write(`  详情: ${String(error.detail).slice(0, 300)}\n`);
      process.exitCode = 2;
      return;
    }
    process.stderr.write(`✗ 未预期的错误: ${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 3;
  });
