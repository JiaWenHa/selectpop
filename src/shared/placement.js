'use strict';

/** 弹窗定位：纯函数，方便单测覆盖多屏 / 边缘翻转。 */

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function pointInRect(point, rect) {
  if (!point || !rect) return false;
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

/**
 * 计算弹窗位置（Electron 的 DIP 坐标）。
 *
 * - 默认出现在光标右下方（不遮住选区末尾）
 * - 右边放不下就翻到光标左侧
 * - 下面放不下就翻到光标上方
 * - 最后再夹紧到当前显示器的工作区
 *
 * @param {{x:number,y:number}} cursor 光标位置
 * @param {{width:number,height:number}} size 弹窗尺寸
 * @param {{x:number,y:number,width:number,height:number}} workArea 显示器工作区
 */
function computePopupBounds({ cursor, size, workArea, gap = 16, offsetY = 20, margin = 10 }) {
  const width = Math.max(1, Math.round(size.width));
  const height = Math.max(1, Math.round(size.height));
  const areaRight = workArea.x + workArea.width;
  const areaBottom = workArea.y + workArea.height;

  let x = cursor.x + gap;
  if (x + width > areaRight - margin) {
    x = cursor.x - width - gap;
  }
  x = clamp(x, workArea.x + margin, Math.max(workArea.x + margin, areaRight - width - margin));

  let y = cursor.y + offsetY;
  if (y + height > areaBottom - margin) {
    y = cursor.y - height - offsetY;
  }
  y = clamp(y, workArea.y + margin, Math.max(workArea.y + margin, areaBottom - height - margin));

  return { x: Math.round(x), y: Math.round(y), width, height };
}

module.exports = { computePopupBounds, clamp, pointInRect };
