import test from 'node:test';
import assert from 'node:assert/strict';
import { degradeImage } from './degrade.ts';
import { decodeJpegBuffer } from './png.ts';
import type { RgbaImage } from './metrics.ts';

function gradient(width: number, height: number): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      data[o] = (x * 255) / width;
      data[o + 1] = (y * 255) / height;
      data[o + 2] = ((x + y) * 7) % 256;
      data[o + 3] = 255;
    }
  }
  return { width, height, data };
}

test('degradeImage downscales to the long edge, recompresses lossily and returns decodable JPEG bytes', () => {
  const src = gradient(1024, 768);
  const { image, jpeg } = degradeImage(src, { maxEdge: 700, quality: 55, passes: 2 });
  assert.equal(image.width, 700);
  assert.equal(image.height, 525);
  assert.ok(jpeg.length > 1000);
  const decoded = decodeJpegBuffer(jpeg);
  assert.equal(decoded.width, 700);
  // Lossy: the recompressed pixels differ from a clean resize somewhere.
  let diff = 0;
  const clean = degradeImage(src, { maxEdge: 700, quality: 100, passes: 1 }).image;
  for (let i = 0; i < image.data.length; i += 4) diff += Math.abs(image.data[i] - clean.data[i]);
  assert.ok(diff > 0);
  // Small images are not upscaled.
  const small = degradeImage(gradient(300, 200), { maxEdge: 700, quality: 55, passes: 1 }).image;
  assert.equal(small.width, 300);
});
