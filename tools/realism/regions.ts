/**
 * Draws the metric regions (cheek, neck and ear patches, face oval, forehead bands) on a driver
 * and output frame pair, with the measured values as captions, so patch placement can be
 * reviewed next to the numbers.
 */
import * as M from './metrics.ts';
import { blank, blit, crop, drawPolyline, drawText, scaleImage } from './png.ts';

const RED: [number, number, number] = [255, 0, 0];
const GREEN: [number, number, number] = [0, 255, 0];
const BLUE: [number, number, number] = [0, 0, 255];
const OVAL: [number, number, number] = [74, 222, 128];
const CYAN: [number, number, number] = [34, 211, 238];
const ORANGE: [number, number, number] = [251, 146, 60];
const AMBER: [number, number, number] = [251, 191, 36];

function tint(img: M.RgbaImage, mask: Uint8Array, rgb: [number, number, number]) {
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const o = i * 4;
    for (let c = 0; c < 3; c++) img.data[o + c] = Math.round(img.data[o + c] * 0.5 + rgb[c] * 0.5);
  }
}

function rgbText(v: [number, number, number]): string {
  return v.map((x) => x.toFixed(0)).join('/');
}

/** One annotated, zoomed face crop. */
export function annotateRegions(img: M.RgbaImage, pts: M.Landmarks, label: string, extra: string[] = []): M.RgbaImage {
  const r = M.faceRegions(pts, img.width, img.height);
  const step = M.foreheadStep(img, pts);
  const copy = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
  tint(copy, r.cheekLeft, RED);
  tint(copy, r.cheekRight, RED);
  tint(copy, r.neck, GREEN);
  tint(copy, r.earLeft, BLUE);
  tint(copy, r.earRight, BLUE);
  drawPolyline(copy, r.oval, OVAL, true, 1);
  if (step) {
    drawPolyline(copy, step.patches.upper, CYAN, true, 2);
    drawPolyline(copy, step.patches.lower, ORANGE, true, 2);
  }
  const box = M.clampRect(M.expandRect(r.ovalBox, 1.8, 1.7), img.width, img.height);
  const zoom = scaleImage(crop(copy, box), 2);
  const lines = [
    step ? `${label}  FOREHEAD DE ${step.deltaE.toFixed(1)}  HAIRLINE ${step.hairlineAt ?? '-'}  UP ${rgbText(step.rgb.upper)}  LOW ${rgbText(step.rgb.lower)}` : label,
    ...extra,
  ];
  lines.forEach((t, i) => drawText(zoom, t, 6, 6 + i * 18, 2, i === 0 ? CYAN : AMBER));
  return zoom;
}

/** Driver and output side by side with the skin-tone numbers of the pair. */
export function regionsSheet(driver: M.RgbaImage, output: M.RgbaImage, pts: M.Landmarks): M.RgbaImage {
  const skin = M.skinToneMatch(output, driver, pts);
  const skinLine = skin
    ? [`NECK DE OUT ${skin.cheekVsNeck.toFixed(1)} DRV ${skin.driverCheekVsNeck.toFixed(1)}  EARS OUT ${skin.cheekVsEars.toFixed(1)} DRV ${skin.driverCheekVsEars.toFixed(1)}`]
    : [];
  const a = annotateRegions(driver, pts, 'DRIVER', skinLine);
  const b = annotateRegions(output, pts, 'OUTPUT', skinLine);
  const sheet = blank(a.width + b.width + 12, Math.max(a.height, b.height));
  blit(sheet, a, 0, 0);
  blit(sheet, b, a.width + 12, 0);
  return sheet;
}
