/**
 * PNG I/O and contact-sheet composition for the realism review (pngjs, no native deps).
 */
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import type { Rect, RgbaImage } from './metrics.ts';

export function decodePngBuffer(buffer: Buffer): RgbaImage {
  const png = PNG.sync.read(buffer);
  return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length) };
}

export function decodePngDataUrl(dataUrl: string): RgbaImage {
  const comma = dataUrl.indexOf(',');
  return decodePngBuffer(Buffer.from(dataUrl.slice(comma + 1), 'base64'));
}

export function encodePng(img: RgbaImage): Buffer {
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length);
  return PNG.sync.write(png);
}

export function writePng(file: string, img: RgbaImage) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodePng(img));
}

export function writeDataUrlPng(file: string, dataUrl: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const comma = dataUrl.indexOf(',');
  fs.writeFileSync(file, Buffer.from(dataUrl.slice(comma + 1), 'base64'));
}

export function blank(width: number, height: number, rgb: [number, number, number] = [15, 23, 42]): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

export function crop(img: RgbaImage, rect: Rect): RgbaImage {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(img.width, Math.ceil(rect.x + rect.w));
  const y1 = Math.min(img.height, Math.ceil(rect.y + rect.h));
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const out = blank(w, h);
  for (let y = 0; y < h; y++) {
    const src = ((y0 + y) * img.width + x0) * 4;
    out.data.set(img.data.subarray(src, src + w * 4), y * w * 4);
  }
  return out;
}

/** Bilinear resize. */
export function scaleImage(img: RgbaImage, factor: number): RgbaImage {
  const w = Math.max(1, Math.round(img.width * factor));
  const h = Math.max(1, Math.round(img.height * factor));
  const out = blank(w, h);
  const sx = img.width / w;
  const sy = img.height / h;
  for (let y = 0; y < h; y++) {
    const fy = Math.min(img.height - 1, (y + 0.5) * sy - 0.5);
    const y0 = Math.max(0, Math.floor(fy));
    const y1 = Math.min(img.height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(img.width - 1, (x + 0.5) * sx - 0.5);
      const x0 = Math.max(0, Math.floor(fx));
      const x1 = Math.min(img.width - 1, x0 + 1);
      const wx = fx - x0;
      const o = (y * w + x) * 4;
      for (let c = 0; c < 4; c++) {
        const p00 = img.data[(y0 * img.width + x0) * 4 + c];
        const p10 = img.data[(y0 * img.width + x1) * 4 + c];
        const p01 = img.data[(y1 * img.width + x0) * 4 + c];
        const p11 = img.data[(y1 * img.width + x1) * 4 + c];
        out.data[o + c] = Math.round((p00 * (1 - wx) + p10 * wx) * (1 - wy) + (p01 * (1 - wx) + p11 * wx) * wy);
      }
    }
  }
  return out;
}

/** Composites an RGBA image over a checkerboard so alpha is visible. */
export function compositeOnChecker(img: RgbaImage, cell = 8): RgbaImage {
  const out = blank(img.width, img.height);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const o = (y * img.width + x) * 4;
      const bg = ((Math.floor(x / cell) + Math.floor(y / cell)) & 1) === 0 ? 70 : 100;
      const a = img.data[o + 3] / 255;
      for (let c = 0; c < 3; c++) out.data[o + c] = Math.round(img.data[o + c] * a + bg * (1 - a));
    }
  }
  return out;
}

export function blit(dst: RgbaImage, src: RgbaImage, x: number, y: number) {
  for (let row = 0; row < src.height; row++) {
    const dy = y + row;
    if (dy < 0 || dy >= dst.height) continue;
    const w = Math.min(src.width, dst.width - x);
    if (w <= 0) continue;
    dst.data.set(src.data.subarray(row * src.width * 4, (row * src.width + w) * 4), (dy * dst.width + x) * 4);
  }
}

// --- Tiny 5x7 bitmap font for labels ---------------------------------------------------------------

const GLYPHS: Record<string, string[]> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11100', '10010', '10001', '10001', '10001', '10010', '11100'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '10001', '11001', '10101', '10011', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '10001', '01010', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '/': ['00000', '00001', '00010', '00100', '01000', '10000', '00000'],
  '=': ['00000', '00000', '11111', '00000', '11111', '00000', '00000'],
  '%': ['11000', '11001', '00010', '00100', '01000', '10011', '00011'],
  '(': ['00010', '00100', '01000', '01000', '01000', '00100', '00010'],
  ')': ['01000', '00100', '00010', '00010', '00010', '00100', '01000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};
const UNKNOWN = ['11111', '10001', '10001', '10001', '10001', '10001', '11111'];

export function drawText(img: RgbaImage, text: string, x: number, y: number, scale = 2, rgb: [number, number, number] = [226, 232, 240]) {
  let cx = x;
  for (const ch of text.toUpperCase()) {
    const glyph = GLYPHS[ch] ?? UNKNOWN;
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (glyph[row][col] !== '1') continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const px = cx + col * scale + dx;
            const py = y + row * scale + dy;
            if (px < 0 || py < 0 || px >= img.width || py >= img.height) continue;
            const o = (py * img.width + px) * 4;
            img.data[o] = rgb[0];
            img.data[o + 1] = rgb[1];
            img.data[o + 2] = rgb[2];
            img.data[o + 3] = 255;
          }
        }
      }
    }
    cx += 6 * scale;
  }
}

export function textWidth(text: string, scale = 2): number {
  return text.length * 6 * scale;
}

// --- Contact sheet --------------------------------------------------------------------------------

export interface SheetTile {
  label: string;
  image: RgbaImage;
}

export interface SheetRow {
  label: string;
  tiles: SheetTile[];
}

/** Rows of tiles with a label column on the left and a caption above each tile. */
export function contactSheet(title: string, rows: SheetRow[]): RgbaImage {
  const pad = 8;
  const labelW = 110;
  const captionH = 18;
  const titleH = 28;
  let width = labelW;
  let height = titleH + pad;
  const rowHeights: number[] = [];
  for (const row of rows) {
    let rw = labelW;
    let rh = 0;
    for (const t of row.tiles) {
      rw += t.image.width + pad;
      rh = Math.max(rh, t.image.height);
    }
    width = Math.max(width, rw + pad);
    rowHeights.push(rh + captionH);
    height += rh + captionH + pad;
  }
  const sheet = blank(Math.max(width, 240), height);
  drawText(sheet, title, pad, 8, 2);
  let y = titleH + pad;
  rows.forEach((row, i) => {
    drawText(sheet, row.label, pad, y + captionH + 4, 2, [251, 191, 36]);
    let x = labelW;
    for (const t of row.tiles) {
      drawText(sheet, t.label, x, y + 2, 2, [148, 163, 184]);
      blit(sheet, t.image, x, y + captionH);
      x += t.image.width + pad;
    }
    y += rowHeights[i] + pad;
  });
  return sheet;
}
