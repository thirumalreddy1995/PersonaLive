import test from 'node:test';
import assert from 'node:assert/strict';
import { FaceLandmarker } from '@mediapipe/tasks-vision';
import { CANONICAL_FACE_MODEL } from './canonicalFaceModel.ts';
import { buildFaceTopology, eyeFadeWeights } from './faceMesh.ts';
import {
  JAW_MAX_DEPTH,
  JAW_TAPER,
  LOWER_JAW_OVAL,
  LidClosure,
  MESH_POINTS,
  NeutralShapeCalibrator,
  PROPORTION_MAX_SHIFT,
  STABLE_POINTS,
  applyJawExtension,
  applyProportions,
  beardDepths,
  eyeFrame,
  fitAffine,
  hasBeard,
  jawPlan,
  jawSideScale,
  lidPassThroughWeights,
  normalizeShape,
  sideRegionVertices,
  silhouetteWeights,
  proportionOffsets,
  proportionWeights,
  upperLidBands,
} from './identityShape.ts';

const topo = buildFaceTopology(FaceLandmarker.FACE_LANDMARKS_TESSELATION, FaceLandmarker.FACE_LANDMARKS_FACE_OVAL, 468);

/** A frontal face in image pixels (y down) from the canonical model: x lateral, y up → image. */
function canonicalFace(scale = 10, cx = 320, cy = 240, mirror = false): Float32Array {
  const p = new Float32Array(478 * 2);
  for (let i = 0; i < MESH_POINTS; i++) {
    const x = CANONICAL_FACE_MODEL[i * 3];
    const y = CANONICAL_FACE_MODEL[i * 3 + 1];
    // Un-mirrored image: the subject's left (x > 0) appears on the image's right.
    p[i * 2] = cx + (mirror ? -x : x) * scale;
    p[i * 2 + 1] = cy - y * scale;
  }
  return p;
}

test('eyeFrame and normalizeShape give the same subject-centred coordinates for a mirrored image', () => {
  const plain = canonicalFace(10);
  const mirrored = canonicalFace(10, 320, 240, true);
  const f = eyeFrame(plain)!;
  assert.ok(f.iod > 0);
  // y points toward the chin (image down) in both.
  assert.ok(f.vy > 0.99);
  const a = normalizeShape(plain)!;
  const b = normalizeShape(mirrored)!;
  for (let i = 0; i < MESH_POINTS * 2; i++) assert.ok(Math.abs(a[i] - b[i]) < 1e-4, `coordinate ${i}`);
  // Scale and translation do not matter.
  const c = normalizeShape(canonicalFace(23, 100, 50))!;
  for (let i = 0; i < MESH_POINTS * 2; i++) assert.ok(Math.abs(a[i] - c[i]) < 1e-4);
  // The nose tip sits below the eyes, the subject's left eye at +x.
  assert.ok(a[1 * 2 + 1] > 0);
  assert.ok(a[263 * 2] > 0 && a[33 * 2] < 0);
});

test('fitAffine recovers a rotation, scale, shear and translation exactly', () => {
  const src = normalizeShape(canonicalFace())!;
  const A = [12.5, -3, 2, 11, 400, 260];
  const dst = new Float32Array(src.length);
  for (let i = 0; i < MESH_POINTS; i++) {
    dst[i * 2] = A[0] * src[i * 2] + A[1] * src[i * 2 + 1] + A[4];
    dst[i * 2 + 1] = A[2] * src[i * 2] + A[3] * src[i * 2 + 1] + A[5];
  }
  const fit = fitAffine(src, dst, STABLE_POINTS)!;
  for (let k = 0; k < 6; k++) assert.ok(Math.abs(fit[k] - A[k]) < 1e-3, `param ${k}: ${fit[k]} vs ${A[k]}`);
  assert.equal(fitAffine(new Float32Array(src.length), dst, STABLE_POINTS), null, 'degenerate source');
});

test('NeutralShapeCalibrator averages frames and is ready after the minimum', () => {
  const cal = new NeutralShapeCalibrator(3, 10, 2);
  assert.equal(cal.shape(), null);
  cal.add([1, 2, 3, 4]);
  cal.add([3, 4, 5, 6]);
  assert.equal(cal.ready, false);
  cal.add([2, 3, 4, 5]);
  assert.equal(cal.ready, true);
  assert.deepEqual(Array.from(cal.shape()!), [2, 3, 4, 5]);
  cal.reset();
  assert.equal(cal.ready, false);
});

test('proportion offsets are clamped and the weights spare the outline and the real eyes', () => {
  const persona = new Float32Array([0, 0, 1, 0]);
  const wearer = new Float32Array([0, 0.05, 0, 0]);
  const off = proportionOffsets(persona, wearer, 2);
  assert.ok(Math.abs(off[1] + 0.05) < 1e-6, 'small shift kept');
  assert.ok(Math.abs(Math.hypot(off[2], off[3]) - PROPORTION_MAX_SHIFT) < 1e-6, 'large shift clamped');

  const w = proportionWeights(topo, true);
  for (const v of LOWER_JAW_OVAL) assert.equal(w[v], 0, `oval vertex ${v} stays on the wearer`);
  assert.equal(w[1], 1, 'nose tip moves fully');
  for (const v of [33, 133, 159, 145, 263, 362]) assert.equal(w[v], 0, `eye ring vertex ${v} stays with real eyes`);
  for (const v of [13, 14, 78, 308]) assert.equal(w[v], 0, `inner lip vertex ${v} stays on the real mouth`);
  for (const v of [0, 17, 61, 291]) assert.ok(w[v] > 0 && w[v] <= 0.5, `outer lip vertex ${v} moves half way`);
  const withPersonaEyes = proportionWeights(topo, false);
  assert.ok(withPersonaEyes[159] > 0, 'persona eyes: the eye ring may move');
});

test('applyProportions maps offsets through the affine and releases the lips as the mouth opens', () => {
  const pos = new Float32Array([10, 10, 20, 20]);
  const offsets = new Float32Array([0.1, 0, 0.1, 0]);
  const weights = new Float32Array([1, 1]);
  const lip = new Float32Array([0, 1]);
  applyProportions(pos, offsets, weights, lip, 1, [50, 0, 0, 50], 1, 2);
  assert.deepEqual(Array.from(pos), [15, 10, 20, 20], 'the lip vertex returns to the wearer with an open mouth');
  const pos2 = new Float32Array([10, 10, 20, 20]);
  applyProportions(pos2, offsets, weights, lip, 0, [0, -50, 50, 0], 0.5, 2);
  assert.deepEqual(Array.from(pos2), [10, 12.5, 20, 22.5], 'rotated and scaled by strength');
});

test('jawPlan covers the lower oval rings with the taper, and nothing above the nose tip', () => {
  const plan = jawPlan(topo);
  assert.ok(plan.vertex.length > LOWER_JAW_OVAL.length);
  const byVertex = new Map<number, number>();
  for (let k = 0; k < plan.vertex.length; k++) byVertex.set(plan.vertex[k], plan.taper[k]);
  for (const v of LOWER_JAW_OVAL) assert.equal(byVertex.get(v), JAW_TAPER[0], `jaw point ${v} takes the full depth`);
  assert.equal(byVertex.has(10), false, 'forehead untouched');
  assert.equal(byVertex.has(1), false, 'nose tip untouched');
});

/** A synthetic persona photo: skin face, a dark beard band below the jaw line on the chin side. */
function beardImage(beard: boolean) {
  const pts = canonicalFace(12, 320, 260);
  const chinY = pts[152 * 2 + 1];
  const sample = (x: number, y: number): [number, number, number] | null => {
    if (x < 0 || y < 0 || x > 640 || y > 520) return null;
    if (beard && y > chinY - 30 && y < chinY + 45 && Math.abs(x - 320) < 90) return [35, 30, 28];
    if (y > chinY + 10) return [235, 235, 232]; // wall below
    return [200, 150, 120]; // skin
  };
  return { pts, sample, chinY };
}

test('beardDepths finds a beard reaching below the chin and nothing on a clean-shaven face', () => {
  const b = beardImage(true);
  const iod = eyeFrame(b.pts)!.iod;
  const depths = beardDepths(b.sample, b.pts, { maxDepth: 0.9 });
  const chin = depths[LOWER_JAW_OVAL.indexOf(152)];
  assert.equal(depths[0], 0, 'the jaw ends by the ears take no push');
  assert.equal(depths[LOWER_JAW_OVAL.length - 1], 0);
  // The beard ends 45 px below the chin point.
  assert.ok(Math.abs(chin * iod - 45) < 0.1 * iod, `chin depth ${(chin * iod).toFixed(1)} px`);
  assert.ok(hasBeard(depths));
  // By default the depth stops at JAW_MAX_DEPTH (the wearer's jaw silhouette, not the neck).
  const capped = beardDepths(b.sample, b.pts);
  const c152 = capped[LOWER_JAW_OVAL.indexOf(152)];
  assert.ok(c152 <= JAW_MAX_DEPTH + 1e-6 && c152 >= JAW_MAX_DEPTH - 0.03, `capped chin depth ${c152}`);
  const clean = beardDepths(beardImage(false).sample, beardImage(false).pts);
  assert.ok(!hasBeard(clean), `clean-shaven depths ${Array.from(clean).map((d) => d.toFixed(2))}`);
});

test('applyJawExtension pushes the jaw outward by depth·IOD and leaves the rest alone', () => {
  const pts = canonicalFace(10);
  const before = Float32Array.from(pts);
  const plan = jawPlan(topo);
  const depths = new Float32Array(LOWER_JAW_OVAL.length).fill(0.5);
  assert.ok(applyJawExtension(pts, plan, depths));
  const iod = eyeFrame(before)!.iod;
  const chinMove = Math.hypot(pts[152 * 2] - before[152 * 2], pts[152 * 2 + 1] - before[152 * 2 + 1]);
  assert.ok(Math.abs(chinMove - 0.5 * iod) < 1e-3, 'chin moves by depth · IOD');
  assert.ok(pts[152 * 2 + 1] > before[152 * 2 + 1], 'chin moves down');
  for (const v of [1, 10, 33, 263]) assert.equal(pts[v * 2 + 1], before[v * 2 + 1], `vertex ${v} untouched`);
  const none = Float32Array.from(before);
  applyJawExtension(none, plan, new Float32Array(LOWER_JAW_OVAL.length));
  assert.deepEqual(Array.from(none), Array.from(before), 'no beard, no change');
});

test('jawSideScale is 1 on a frontal face, drops the compressed side of a turned one, and a turn stops the jaw push', () => {
  const frontal = canonicalFace(10);
  const [r, l] = jawSideScale(frontal);
  assert.ok(r > 0.99 && l > 0.99, `frontal ${r}, ${l}`);
  // Squash the subject's left half (x > centre in an un-mirrored image) to 55%: that side is foreshortened.
  const turned = Float32Array.from(frontal);
  const cx = frontal[168 * 2];
  for (let i = 0; i < MESH_POINTS; i++) if (turned[i * 2] > cx) turned[i * 2] = cx + (turned[i * 2] - cx) * 0.55;
  const [r2, l2] = jawSideScale(turned);
  assert.ok(r2 > 0.99, 'near side keeps the push');
  assert.equal(l2, 0, 'far side takes none');
  // A turned head is not pushed at all (its oval already follows the jaw silhouette).
  const plan = jawPlan(topo);
  const depths = new Float32Array(LOWER_JAW_OVAL.length).fill(0.5);
  const moved = Float32Array.from(turned);
  applyJawExtension(moved, plan, depths);
  assert.deepEqual(Array.from(moved), Array.from(turned));
});

test('upper-lid bands cover only vertices above each eye and add on top of the base pass-through', () => {
  const bands = upperLidBands(topo, 1);
  const base = eyeFadeWeights(topo, 1);
  let leftSum = 0;
  let rightSum = 0;
  for (let v = 0; v < topo.vertexCount; v++) {
    leftSum += bands.left[v];
    rightSum += bands.right[v];
    if (bands.left[v] > 0) assert.ok(CANONICAL_FACE_MODEL[v * 3] > 0, `left band vertex ${v} on the left`);
    if (bands.right[v] > 0) assert.ok(CANONICAL_FACE_MODEL[v * 3] < 0, `right band vertex ${v} on the right`);
    if (bands.left[v] > 0 || bands.right[v] > 0) assert.ok(CANONICAL_FACE_MODEL[v * 3 + 1] > 2.6, `band vertex ${v} above the eye`);
  }
  assert.ok(leftSum > 0 && rightSum > 0);
  const out = new Float32Array(topo.vertexCount);
  lidPassThroughWeights(base, bands, 0, 0, out);
  assert.deepEqual(Array.from(out), Array.from(base), 'open eyes: the base pass-through');
  lidPassThroughWeights(base, bands, 1, 0, out);
  let grew = 0;
  for (let v = 0; v < topo.vertexCount; v++) {
    assert.ok(out[v] >= base[v] && out[v] <= 1);
    if (out[v] > base[v]) {
      grew++;
      assert.ok(bands.left[v] > 0, 'only the closing eye grows');
    }
  }
  assert.ok(grew > 0);
});

test('LidClosure rises as the eye aspect ratio falls below the learned open value, and with downward gaze', () => {
  const lc = new LidClosure();
  let c: [number, number] = [0, 0];
  for (let i = 0; i < 20; i++) c = lc.update(0.3, 0.3, 0);
  assert.ok(c[0] < 0.01 && c[1] < 0.01, 'open eyes');
  for (let i = 0; i < 10; i++) c = lc.update(0.12, 0.3, 0);
  assert.ok(c[0] > 0.9 && c[1] < 0.01, `left lid lowered: ${c}`);
  for (let i = 0; i < 10; i++) c = lc.update(0.3, 0.3, 0.6);
  assert.ok(c[0] > 0.7 && c[1] > 0.7, `looking down: ${c}`);
});

test('silhouetteWeights fade side vertices whose UVs fall on the background and keep those on skin', () => {
  const pts = canonicalFace(12, 320, 260);
  const side = sideRegionVertices(topo);
  assert.ok(side.length > 10);
  for (const v of side) assert.ok(Math.abs(CANONICAL_FACE_MODEL[v * 3]) > 4, `side vertex ${v}`);
  // All skin: every weight 1.
  const skin = (): [number, number, number] => [200, 150, 120];
  const all = silhouetteWeights(skin, pts, topo, side);
  for (let v = 0; v < topo.vertexCount; v++) assert.ok(all[v] > 0.99, `vertex ${v} on skin`);
  // The subject's left side (x > image centre + 50 px) is wall: those side vertices fade, the rest stay.
  const wall = (x: number): [number, number, number] => (x > 320 + 50 ? [235, 235, 228] : [200, 150, 120]);
  const w = silhouetteWeights(wall, pts, topo, side);
  let faded = 0;
  for (const v of side) {
    if (pts[v * 2] > 320 + 60) {
      assert.ok(w[v] < 0.05, `vertex ${v} over the wall`);
      faded++;
    }
    if (pts[v * 2] < 320 - 60) assert.ok(w[v] > 0.99, `vertex ${v} on skin`);
  }
  assert.ok(faded > 3);
  assert.equal(w[1], 1, 'interior untouched');
});

test('LidClosure follows the blink and look-down blendshapes when the aspect ratio does not move', () => {
  const lc = new LidClosure();
  let c: [number, number] = [0, 0];
  for (let i = 0; i < 20; i++) c = lc.update(0.3, 0.3, 0, [0, 0], [0, 0]);
  assert.ok(c[0] < 0.01 && c[1] < 0.01);
  for (let i = 0; i < 6; i++) c = lc.update(0.3, 0.3, 0, [0, 0], [0.7, 0.7]);
  assert.ok(c[0] > 0.8 && c[1] > 0.8, `looking down by blendshape: ${c}`);
  for (let i = 0; i < 20; i++) c = lc.update(0.3, 0.3, 0, [0, 0.9], [0, 0]);
  assert.ok(c[0] < 0.05 && c[1] > 0.9, `right-eye blink only: ${c}`);
});

test('LidClosure rises with the chin down even when the eyes and their blendshapes stay open', () => {
  const lc = new LidClosure();
  let c: [number, number] = [0, 0];
  for (let i = 0; i < 20; i++) c = lc.update(0.3, 0.3, 0, [0, 0], [0, 0], 0);
  assert.ok(c[0] < 0.01);
  for (let i = 0; i < 6; i++) c = lc.update(0.3, 0.3, 0, [0, 0], [0, 0], 1);
  assert.ok(c[0] > 0.85 && c[1] > 0.85, `chin down: ${c}`);
});
