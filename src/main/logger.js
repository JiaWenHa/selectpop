'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const MAX_BYTES = 1024 * 1024;

/**
 * 极简文件日志：
 * - 同步追加，进程崩溃前的日志不会丢（划词工具日志量很小，这点开销可忽略）
 * - 超过 1MB 自动轮转成 .1 文件
 */
function createLogger({ dir, level = 'info', isDev = false } = {}) {
  let threshold = LEVELS[level] === undefined ? LEVELS.info : LEVELS[level];
  let logFile = '';

  if (dir) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      logFile = path.join(dir, 'selectpop.log');
    } catch {
      logFile = '';
    }
  }

  function rotateIfNeeded() {
    if (!logFile) return;
    try {
      const stat = fs.statSync(logFile);
      if (stat.size > MAX_BYTES) {
        fs.renameSync(logFile, `${logFile}.1`);
      }
    } catch {
      /* 文件不存在或重命名失败都无所谓 */
    }
  }

  function stringifyMeta(meta) {
    if (meta === undefined) return '';
    if (meta instanceof Error) return ` ${meta.stack || meta.message}`;
    try {
      return ` ${JSON.stringify(meta)}`;
    } catch {
      return ' [unserializable meta]';
    }
  }

  function write(levelName, message, meta) {
    if ((LEVELS[levelName] ?? LEVELS.info) > threshold) return;
    const line = `${new Date().toISOString()} ${levelName.toUpperCase().padEnd(5)} ${message}${stringifyMeta(meta)}`;
    if (isDev || levelName === 'error') {
      // eslint-disable-next-line no-console
      (levelName === 'error' ? console.error : console.log)(line);
    }
    if (!logFile) return;
    try {
      fs.appendFileSync(logFile, `${line}\n`, 'utf8');
    } catch {
      /* 日志写失败不能影响主流程 */
    }
  }

  rotateIfNeeded();

  return {
    error: (message, meta) => write('error', message, meta),
    warn: (message, meta) => write('warn', message, meta),
    info: (message, meta) => write('info', message, meta),
    debug: (message, meta) => write('debug', message, meta),
    setLevel(next) {
      threshold = LEVELS[next] === undefined ? LEVELS.info : LEVELS[next];
    },
    get file() {
      return logFile;
    },
  };
}

module.exports = { createLogger, LEVELS };
