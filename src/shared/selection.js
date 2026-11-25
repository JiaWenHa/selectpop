'use strict';

/** 划词触发判定：只放纯逻辑，方便单测。 */

/**
 * @param {object} params
 * @param {number} params.dragDistance 按下到抬起的最大位移（像素）
 * @param {number} params.durationMs 按下到抬起的时长
 * @param {number} params.clicks 抬起事件的连击数（双击时通常为 2）
 * @param {number} params.minDragPx 触发拖拽划词的最小位移
 * @param {boolean} params.allowDrag 是否允许拖拽划词
 * @param {boolean} params.allowDoubleClick 是否允许双击选词
 * @returns {{trigger:boolean, reason:string}}
 */
function shouldTriggerSelection({
  dragDistance = 0,
  durationMs = 0,
  clicks = 1,
  minDragPx = 6,
  allowDrag = true,
  allowDoubleClick = true,
}) {
  if (clicks >= 2) {
    if (!allowDoubleClick) return { trigger: false, reason: 'double-click-disabled' };
    return { trigger: true, reason: 'double-click' };
  }
  if (!allowDrag) return { trigger: false, reason: 'drag-disabled' };
  if (dragDistance < minDragPx) return { trigger: false, reason: 'too-small' };
  // 拖拽窗口 / 拖放文件 / 拖滚动条通常又慢又长，直接放过，避免误发 Ctrl+C
  if (dragDistance > 900) return { trigger: false, reason: 'too-far' };
  if (durationMs > 4000) return { trigger: false, reason: 'too-slow' };
  return { trigger: true, reason: 'drag' };
}

/** 同一段文字在 windowMs 内只弹一次 */
function isDuplicateCapture({ previousText, previousAt, text, now, windowMs = 1500 }) {
  if (!previousText || previousText !== text) return false;
  return now - previousAt < windowMs;
}

module.exports = { shouldTriggerSelection, isDuplicateCapture };
