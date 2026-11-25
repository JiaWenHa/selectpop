'use strict';

/**
 * 生成应用图标与托盘图标（纯 Node，不依赖任何图形库）。
 *
 *   node scripts/gen-icons.js
 *
 * 产出：
 *   build/icon.png          512×512  应用图标（Windows / macOS 打包用）
 *   assets/icon.png         256×256  应用内展示
 *   assets/tray.png          32×32   托盘图标（Windows）
 *   assets/trayTemplate.png  32×32   macOS 模板图标（纯黑 + alpha，随系统自动反色）
 *   assets/tray@2x.png       64×64   高清托盘图标
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');

/* ------------------------------ PNG 编码 ------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePNG(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * 生成 Windows .ico：每个尺寸塞一张 PNG（Vista 以后都支持 PNG 压缩的 ico）。
 * 自己生成可以省掉 electron-builder 转换图标时调用外部工具的步骤。
 */
function encodeICO(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const entries = Buffer.alloc(16 * images.length);
  let offset = header.length + entries.length;
  images.forEach((image, index) => {
    const entry = 16 * index;
    const dimension = image.size >= 256 ? 0 : image.size;
    entries.writeUInt8(dimension, entry + 0);
    entries.writeUInt8(dimension, entry + 1);
    entries.writeUInt8(0, entry + 2); // 调色板大小
    entries.writeUInt8(0, entry + 3); // 保留
    entries.writeUInt16LE(1, entry + 4); // planes
    entries.writeUInt16LE(32, entry + 6); // bpp
    entries.writeUInt32LE(image.png.length, entry + 8);
    entries.writeUInt32LE(offset, entry + 12);
    offset += image.png.length;
  });

  return Buffer.concat([header, entries, ...images.map((image) => image.png)]);
}

/* ------------------------------ 几何与颜色 ------------------------------ */

const clamp01 = (value) => Math.min(1, Math.max(0, value));

/** 圆角矩形的有符号距离场：<= 0 表示在内部 */
function sdRoundRect(px, py, cx, cy, hw, hh, radius) {
  const qx = Math.abs(px - cx) - (hw - radius);
  const qy = Math.abs(py - cy) - (hh - radius);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - radius;
}

function mix(a, b, t) {
  const k = clamp01(t);
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

const BLUE = [0x3b, 0x82, 0xf6];
const VIOLET = [0x7c, 0x3a, 0xed];
const WHITE = [0xff, 0xff, 0xff];
const INK = [0x1b, 0x4b, 0xd8];

/** 用 4×4 超采样把一个「归一化坐标 → 颜色」的函数画成 RGBA 位图 */
function render(size, sample) {
  const SS = 4;
  const out = Buffer.alloc(size * size * 4);
  const total = SS * SS;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const px = (x + (sx + 0.5) / SS) / size;
          const py = (y + (sy + 0.5) / SS) / size;
          const color = sample(px, py);
          const a = clamp01(color[3]);
          red += color[0] * a;
          green += color[1] * a;
          blue += color[2] * a;
          alpha += a;
        }
      }
      const a = alpha / total;
      const offset = (y * size + x) * 4;
      out[offset + 3] = Math.round(clamp01(a) * 255);
      if (a > 0) {
        out[offset] = Math.round(clamp01(red / alpha) * 255);
        out[offset + 1] = Math.round(clamp01(green / alpha) * 255);
        out[offset + 2] = Math.round(clamp01(blue / alpha) * 255);
      }
    }
  }
  return out;
}

/* ------------------------------ 图形设计 ------------------------------ */

/** 应用图标：圆角渐变方块 + 白色弹窗卡片 + 三条「文字」条 */
function appIconSample(x, y) {
  if (sdRoundRect(x, y, 0.5, 0.5, 0.445, 0.445, 0.118) > 0) return [0, 0, 0, 0];

  // 对角渐变 + 左上高光
  let color = mix(BLUE, VIOLET, x * 0.35 + y * 0.75);
  const glow = Math.max(0, 0.62 - Math.hypot(x - 0.3, y - 0.22));
  color = mix(color, WHITE, glow * 0.35);

  // 白色卡片
  const card = sdRoundRect(x, y, 0.5, 0.53, 0.285, 0.2, 0.062);
  if (card <= 0) {
    color = WHITE;
    // 卡片里的三条文字
    const bars = [
      [0.36, 0.335, 0.14],
      [0.36, 0.445, 0.095],
      [0.36, 0.555, 0.155],
    ];
    for (const [left, cy, halfWidth] of bars) {
      if (sdRoundRect(x, y, left, cy, halfWidth, 0.021, 0.021) <= 0) {
        color = mix(INK, VIOLET, 0.35);
      }
    }
  } else if (card <= 0.006) {
    color = mix(color, WHITE, 0.55);
  }

  return [color[0] / 255, color[1] / 255, color[2] / 255, 1];
}

/** 托盘彩色图标：更粗、更简洁，保证 16~32px 也能看清 */
function trayIconSample(x, y) {
  if (sdRoundRect(x, y, 0.5, 0.5, 0.46, 0.46, 0.2) > 0) return [0, 0, 0, 0];

  let color = mix(BLUE, VIOLET, x * 0.3 + y * 0.7);
  const card = sdRoundRect(x, y, 0.5, 0.52, 0.3, 0.235, 0.1);
  if (card <= 0) {
    color = WHITE;
    const bars = [
      [0.38, 0.33, 0.16],
      [0.38, 0.47, 0.11],
      [0.38, 0.61, 0.17],
    ];
    for (const [left, cy, halfWidth] of bars) {
      if (sdRoundRect(x, y, left, cy, halfWidth, 0.036, 0.036) <= 0) color = mix(INK, VIOLET, 0.3);
    }
  }
  return [color[0] / 255, color[1] / 255, color[2] / 255, 1];
}

/** macOS 模板图标：纯黑 + alpha，系统会按菜单栏明暗自动反色 */
function trayTemplateSample(x, y) {
  const stroke = sdRoundRect(x, y, 0.5, 0.5, 0.44, 0.44, 0.18);
  let alpha = 0;
  if (Math.abs(stroke) <= 0.052) alpha = 1;
  const bars = [
    [0.38, 0.34, 0.15],
    [0.38, 0.5, 0.1],
    [0.38, 0.66, 0.16],
  ];
  for (const [left, cy, halfWidth] of bars) {
    if (sdRoundRect(x, y, left, cy, halfWidth, 0.048, 0.048) <= 0) alpha = 1;
  }
  return [0, 0, 0, alpha];
}

/* ------------------------------ 输出 ------------------------------ */

const targets = [
  { file: 'build/icon.png', size: 512, sample: appIconSample },
  { file: 'assets/icon.png', size: 256, sample: appIconSample },
  { file: 'assets/tray.png', size: 32, sample: trayIconSample },
  { file: 'assets/tray@2x.png', size: 64, sample: trayIconSample },
  { file: 'assets/trayTemplate.png', size: 32, sample: trayTemplateSample },
  { file: 'assets/trayTemplate@2x.png', size: 64, sample: trayTemplateSample },
];

function main() {
  for (const target of targets) {
    const output = path.join(ROOT, target.file);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const rgba = render(target.size, target.sample);
    const png = encodePNG(target.size, target.size, rgba);
    fs.writeFileSync(output, png);
    process.stdout.write(`✓ ${target.file}  ${target.size}×${target.size}  ${(png.length / 1024).toFixed(1)} KB\n`);
  }

  // Windows 用的 .ico（多尺寸）
  const icoImages = [16, 24, 32, 48, 64, 128, 256].map((size) => ({
    size,
    png: encodePNG(size, size, render(size, appIconSample)),
  }));
  const ico = encodeICO(icoImages);
  const icoPath = path.join(ROOT, 'build/icon.ico');
  fs.mkdirSync(path.dirname(icoPath), { recursive: true });
  fs.writeFileSync(icoPath, ico);
  process.stdout.write(`✓ build/icon.ico  ${icoImages.length} 种尺寸  ${(ico.length / 1024).toFixed(1)} KB\n`);
}

if (require.main === module) main();

module.exports = { encodePNG, encodeICO, render, appIconSample, trayIconSample, trayTemplateSample };
