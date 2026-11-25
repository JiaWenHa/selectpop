'use strict';

const { createSSEParser } = require('../shared/sse');
const { normalizeBaseUrl } = require('../shared/urls');

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_TIMEOUT_MS = 60000;

/** 面向用户的错误，message 可以直接展示在弹窗里 */
class DeepSeekError extends Error {
  constructor(message, { code = 'error', status = 0, detail = '' } = {}) {
    super(message);
    this.name = 'DeepSeekError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

const STATUS_MAP = {
  400: { code: 'bad-request', message: '请求格式有误（400）' },
  401: { code: 'invalid-key', message: 'API Key 无效，请到设置里重新填写' },
  402: { code: 'insufficient-balance', message: 'DeepSeek 账户余额不足（402）' },
  403: { code: 'forbidden', message: '没有权限访问该接口（403）' },
  404: { code: 'not-found', message: '接口地址不存在，请检查 Base URL（404）' },
  422: { code: 'invalid-params', message: '请求参数不被接受（422）' },
  429: { code: 'rate-limited', message: '请求太频繁，请稍后再试（429）' },
  500: { code: 'server-error', message: 'DeepSeek 服务异常（500）' },
  502: { code: 'bad-gateway', message: 'DeepSeek 网关错误（502）' },
  503: { code: 'overloaded', message: 'DeepSeek 服务繁忙，请稍后重试（503）' },
  504: { code: 'gateway-timeout', message: 'DeepSeek 响应超时（504）' },
};

/** 兼容用户把 /chat/completions 或 /v1 一起填进 Base URL 的情况 */
function resolveEndpoints(baseUrl) {
  const base = normalizeBaseUrl(baseUrl) || DEFAULT_BASE_URL;
  if (/\/chat\/completions$/i.test(base)) {
    return { chat: base, models: `${base.replace(/\/chat\/completions$/i, '')}/models` };
  }
  if (/\/models$/i.test(base)) {
    return { chat: `${base.replace(/\/models$/i, '')}/chat/completions`, models: base };
  }
  return { chat: `${base}/chat/completions`, models: `${base}/models` };
}

async function readErrorDetail(response) {
  try {
    const raw = await response.text();
    if (!raw) return '';
    try {
      const parsed = JSON.parse(raw);
      const message = parsed?.error?.message || parsed?.message || '';
      return String(message || raw).slice(0, 400);
    } catch {
      return raw.slice(0, 400);
    }
  } catch {
    return '';
  }
}

function statusError(status, detail) {
  const mapped = STATUS_MAP[status] || { code: 'http-error', message: `请求失败（HTTP ${status}）` };
  return new DeepSeekError(mapped.message, { code: mapped.code, status, detail });
}

function abortError(signal, timeoutMs) {
  if (signal?.aborted) {
    return new DeepSeekError('已取消', { code: 'aborted' });
  }
  return new DeepSeekError(`请求超时（${Math.round(timeoutMs / 1000)} 秒无响应）`, { code: 'timeout' });
}

/**
 * 调用 chat/completions，支持流式与非流式。
 *
 * @param {object} options
 * @param {string} options.apiKey
 * @param {string} [options.baseUrl]
 * @param {string} [options.model]
 * @param {Array<{role:string,content:string}>} options.messages
 * @param {number} [options.temperature]
 * @param {number} [options.maxTokens]
 * @param {number} [options.timeoutMs] 无数据超时（每收到一段数据都会重置）
 * @param {AbortSignal} [options.signal]
 * @param {(delta:string)=>void} [options.onDelta]
 * @param {(delta:string)=>void} [options.onReasoning]
 * @param {boolean} [options.stream=true]
 * @param {Function} [options.fetchImpl]
 * @returns {Promise<{text:string, reasoning:string, usage:object|null, finishReason:string, model:string}>}
 */
async function chatStream({
  apiKey,
  baseUrl = DEFAULT_BASE_URL,
  model = 'deepseek-chat',
  messages,
  temperature = 1.3,
  maxTokens = 1200,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
  onDelta,
  onReasoning,
  stream = true,
  fetchImpl,
} = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new DeepSeekError('当前运行环境不支持网络请求', { code: 'no-fetch' });
  }
  if (!apiKey) {
    throw new DeepSeekError('还没有配置 DeepSeek API Key', { code: 'no-key' });
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new DeepSeekError('请求内容为空', { code: 'empty' });
  }

  const { chat } = resolveEndpoints(baseUrl);
  const controller = new AbortController();
  let timedOut = false;
  const onOuterAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onOuterAbort, { once: true });
  }

  let timer = null;
  const touch = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  };
  touch();

  let text = '';
  let reasoning = '';
  let usage = null;
  let finishReason = '';

  try {
    const response = await doFetch(chat, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: stream ? 'text/event-stream' : 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: Boolean(stream),
        ...(stream ? { stream_options: { include_usage: true } } : {}),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await readErrorDetail(response);
      throw statusError(response.status, detail);
    }

    if (!stream || !response.body) {
      const payload = await response.json();
      const choice = payload?.choices?.[0];
      text = choice?.message?.content || '';
      finishReason = choice?.finish_reason || '';
      usage = payload?.usage || null;
      if (text) onDelta?.(text);
      return { text, reasoning, usage, finishReason, model: payload?.model || model };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = createSSEParser((event) => {
      if (event.type === 'done') return;
      if (event.type !== 'message') return;
      const payload = event.data;
      if (payload?.usage) usage = payload.usage;
      const choice = payload?.choices?.[0];
      if (!choice) return;
      const delta = choice.delta || {};
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        reasoning += delta.reasoning_content;
        onReasoning?.(delta.reasoning_content);
      }
      if (typeof delta.content === 'string' && delta.content) {
        text += delta.content;
        onDelta?.(delta.content);
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    });

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      touch();
      parser.feed(decoder.decode(value, { stream: true }));
    }
    parser.feed(decoder.decode());
    parser.end();

    if (!text.trim()) {
      throw new DeepSeekError('模型没有返回内容，请换个问法或稍后重试', { code: 'empty-response' });
    }
    return { text, reasoning, usage, finishReason, model };
  } catch (error) {
    if (error instanceof DeepSeekError) throw error;
    if (controller.signal.aborted) throw abortError(signal, timeoutMs);
    if (timedOut) throw abortError(undefined, timeoutMs);
    const reason = error?.cause?.code || error?.code || '';
    throw new DeepSeekError(
      reason === 'ENOTFOUND' || reason === 'EAI_AGAIN'
        ? '无法连接 DeepSeek，请检查网络或 Base URL'
        : `网络请求失败：${error.message}`,
      { code: 'network', detail: String(reason) },
    );
  } finally {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onOuterAbort);
  }
}

/** 用 GET /models 验证 Key 是否可用，比发一次对话便宜 */
async function testConnection({ apiKey, baseUrl, timeoutMs = 20000, fetchImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (!apiKey) return { ok: false, message: '还没有填写 API Key' };
  const { models } = resolveEndpoints(baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await doFetch(models, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await readErrorDetail(response);
      const error = statusError(response.status, detail);
      return { ok: false, message: error.message, status: response.status, detail };
    }
    const payload = await response.json();
    const ids = Array.isArray(payload?.data) ? payload.data.map((item) => item.id).filter(Boolean) : [];
    return { ok: true, message: '连接成功', models: ids };
  } catch (error) {
    if (controller.signal.aborted) return { ok: false, message: `连接超时（${timeoutMs / 1000} 秒）` };
    return { ok: false, message: `连接失败：${error.message}` };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  DeepSeekError,
  chatStream,
  testConnection,
  resolveEndpoints,
  DEFAULT_BASE_URL,
};
