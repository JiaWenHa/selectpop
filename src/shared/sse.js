'use strict';

/**
 * 极简 SSE 解析器：OpenAI / DeepSeek 的 stream=true 响应是
 *   data: {"choices":[...]}\n\n
 *   data: [DONE]\n\n
 * feed() 可以喂任意切分的 chunk（网络分片可能把一个 JSON 劈成两半）。
 */
function createSSEParser(onEvent) {
  let buffer = '';

  function parseBlock(block) {
    const dataLines = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const match = /^data:\s?(.*)$/.exec(line);
      if (match) dataLines.push(match[1]);
    }
    if (dataLines.length === 0) return;
    const data = dataLines.join('\n');
    if (data.trim() === '[DONE]') {
      onEvent({ type: 'done' });
      return;
    }
    try {
      onEvent({ type: 'message', data: JSON.parse(data) });
    } catch (error) {
      onEvent({ type: 'invalid', raw: data, error });
    }
  }

  return {
    feed(chunk) {
      buffer += String(chunk).replace(/\r\n/g, '\n');
      let index = buffer.indexOf('\n\n');
      while (index >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (block.trim()) parseBlock(block);
        index = buffer.indexOf('\n\n');
      }
    },
    end() {
      const rest = buffer.trim();
      buffer = '';
      if (rest) parseBlock(rest);
    },
  };
}

module.exports = { createSSEParser };
