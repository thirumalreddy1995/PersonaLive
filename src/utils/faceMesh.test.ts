import test from 'node:test';
import assert from 'node:assert/strict';
import { FaceLandmarker } from '@mediapipe/tasks-vision';
import {
  applyEyelidKinematics,
  applyGazeIrisTracking,
  applyPerspectiveForeshortening,
  applySmileBias,
  applySpeechAnatomy,
  buildFaceTopology,
  closedLipMaskForZone,
  computeKinematics,
  eyeFadeWeights,
  fanTriangles,
  INNER_LIP_RING,
  LEFT_EYE_RING,
  LIP_FEATHER_RING1,
  lipFadeForMar,
  LM,
  OUTER_LIP_RING,
  RIGHT_EYE_RING,
  SEPARATING_TRIANGLES,
  smoothingToFilterParams,
} from './faceMesh.ts';
import { extractOralApertureMetrics } from './oralCavityRenderer.ts';

const TESSELLATION = FaceLandmarker.FACE_LANDMARKS_TESSELATION;
const OVAL = FaceLandmarker.FACE_LANDMARKS_FACE_OVAL;

test('buildFaceTopology turns the MediaPipe tessellation into a watertight triangle list', () => {
  const topo = buildFaceTopology(TESSELLATION, OVAL, 468);

  // 468 vertices, 1322 unique edges, outer boundary + 3 holes (two eyes, inner mouth):
  // Euler: F_total = 2 - V + E = 856 faces including the outer face and 3 holes → 852 triangles.
  assert.equal(topo.triangles.length / 3, 852);
  assert.equal(topo.vertexCount, 468);

  // Every edge of a disk triangulation belongs to at most 2 triangles.
  const edgeUse = new Map<string, number>();
  for (let i = 0; i < topo.triangles.length; i += 3) {
    const t = [topo.triangles[i], topo.triangles[i + 1], topo.triangles[i + 2]];
    for (const [a, b] of [[t[0], t[1]], [t[1], t[2]], [t[0], t[2]]]) {
      const key = `${Math.min(a, b)},${Math.max(a, b)}`;
      edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
    }
  }
  for (const [edge, count] of edgeUse) assert.ok(count <= 2, `edge ${edge} used ${count} times`);

  // The separating (non-face) 3-cycles must be excluded.
  const triKeys = new Set<string>();
  for (let i = 0; i < topo.triangles.length; i += 3) {
    triKeys.add([topo.triangles[i], topo.triangles[i + 1], topo.triangles[i + 2]].sort((a, b) => a - b).join(','));
  }
  for (const t of SEPARATING_TRIANGLES) assert.ok(!triKeys.has([...t].sort((a, b) => a - b).join(',')));
});

test('eyes and inner mouth are holes in the skin mesh, filled only by explicit fans', () => {
  const topo = buildFaceTopology(TESSELLATION, OVAL, 468);
  const adjacency = new Map<number, Set<number>>();
  for (let i = 0; i < topo.triangles.length; i += 3) {
    const t = [topo.triangles[i], topo.triangles[i + 1], topo.triangles[i + 2]];
    for (const [a, b] of [[t[0], t[1]], [t[1], t[2]], [t[0], t[2]]]) {
      if (!adjacency.has(a)) adjacency.set(a, new Set());
      if (!adjacency.has(b)) adjacency.set(b, new Set());
      adjacency.get(a)!.add(b);
      adjacency.get(b)!.add(a);
    }
  }
  // Opposite points across an eye / the mouth must not be connected → the wearer's real eyes & teeth show through.
  assert.ok(!adjacency.get(LM.LEFT_EYE.top1)!.has(LM.LEFT_EYE.bottom1));
  assert.ok(!adjacency.get(LM.RIGHT_EYE.top1)!.has(LM.RIGHT_EYE.bottom1));
  assert.ok(!adjacency.get(LM.MOUTH.upperInner)!.has(LM.MOUTH.lowerInner));

  // Eye fans cover both rings: (n - 2) triangles per ring.
  assert.equal(topo.eyeTriangles.length / 3, LEFT_EYE_RING.length - 2 + (RIGHT_EYE_RING.length - 2));
  assert.equal(fanTriangles(INNER_LIP_RING).length / 3, INNER_LIP_RING.length - 2);
});

test('feather weights are 0 on the face oval and 1 in the interior', () => {
  const topo = buildFaceTopology(TESSELLATION, OVAL, 468);
  for (const { start } of OVAL) assert.equal(topo.featherWeights[start], 0);
  assert.equal(topo.featherWeights[LM.NOSE_TIP], 1);
  assert.equal(topo.featherWeights[LM.MOUTH.upperInner], 1);
  const ring1 = topo.featherWeights.filter((w) => w > 0 && w < 1).length;
  assert.ok(ring1 > 20, 'there should be a soft transition ring');
});

function syntheticFace(options: { eyesOpen: boolean; mouthOpen: boolean }): Float32Array {
  const pts = new Float32Array(478 * 2);
  // Default: spread everything on a loose grid so nothing is degenerate.
  for (let i = 0; i < 478; i++) {
    pts[i * 2] = 300 + (i % 20) * 10;
    pts[i * 2 + 1] = 200 + Math.floor(i / 20) * 10;
  }
  const set = (i: number, x: number, y: number) => {
    pts[i * 2] = x;
    pts[i * 2 + 1] = y;
  };
  // Eyes (subject's right eye on the left of the image).
  const eyeH = options.eyesOpen ? 12 : 1;
  set(LM.RIGHT_EYE.outer, 300, 300);
  set(LM.RIGHT_EYE.inner, 360, 300);
  set(LM.RIGHT_EYE.top1, 320, 300 - eyeH);
  set(LM.RIGHT_EYE.top2, 340, 300 - eyeH);
  set(LM.RIGHT_EYE.bottom1, 320, 300 + eyeH);
  set(LM.RIGHT_EYE.bottom2, 340, 300 + eyeH);
  set(LM.LEFT_EYE.inner, 440, 300);
  set(LM.LEFT_EYE.outer, 500, 300);
  set(LM.LEFT_EYE.top2, 460, 300 - eyeH);
  set(LM.LEFT_EYE.top1, 480, 300 - eyeH);
  set(LM.LEFT_EYE.bottom2, 460, 300 + eyeH);
  set(LM.LEFT_EYE.bottom1, 480, 300 + eyeH);
  set(LM.RIGHT_IRIS_CENTER, 330, 300);
  set(LM.LEFT_IRIS_CENTER, 470, 300);
  // Nose / chin / forehead for a frontal pose.
  set(LM.FOREHEAD, 400, 220);
  set(LM.NOSE_TIP, 400, 300 + 0.42 * 200);
  set(LM.CHIN, 400, 500);
  // Mouth.
  const mouthH = options.mouthOpen ? 30 : 2;
  set(LM.MOUTH.cornerRight, 360, 440);
  set(LM.MOUTH.cornerLeft, 440, 440);
  set(LM.MOUTH.upperInner, 400, 440 - mouthH / 2);
  set(LM.MOUTH.lowerInner, 400, 440 + mouthH / 2);
  return pts;
}

test('computeKinematics derives blink and mouth-open state from landmark geometry', () => {
  const open = computeKinematics(syntheticFace({ eyesOpen: true, mouthOpen: true }), 80);
  assert.ok(open.earLeft > 0.3 && open.earRight > 0.3, 'open eyes have a high EAR');
  assert.ok(open.mar > 0.3, 'open mouth has a high MAR');
  assert.equal(open.mouthWidthRatio, 1);
  assert.ok(Math.abs(open.yaw) < 1 && Math.abs(open.roll) < 1, 'frontal pose');
  assert.ok(Math.abs(open.gazeX) < 0.01, 'centred irises → neutral gaze');

  const closed = computeKinematics(syntheticFace({ eyesOpen: false, mouthOpen: false }), 80);
  assert.ok(closed.earLeft < 0.05 && closed.earRight < 0.05, 'closed eyes have a near-zero EAR');
  assert.ok(closed.mar < 0.05, 'closed mouth has a near-zero MAR');
});

test('applySmileBias lifts the mouth corners and leaves distant points untouched', () => {
  const pts = syntheticFace({ eyesOpen: true, mouthOpen: false });
  const before = Float32Array.from(pts);
  applySmileBias(pts, 0.5, 200);
  assert.ok(pts[LM.MOUTH.cornerLeft * 2 + 1] < before[LM.MOUTH.cornerLeft * 2 + 1], 'left corner moved up');
  assert.ok(pts[LM.MOUTH.cornerRight * 2 + 1] < before[LM.MOUTH.cornerRight * 2 + 1], 'right corner moved up');
  assert.ok(pts[LM.MOUTH.cornerLeft * 2] > before[LM.MOUTH.cornerLeft * 2], 'left corner moved outward');
  assert.equal(pts[LM.FOREHEAD * 2 + 1], before[LM.FOREHEAD * 2 + 1], 'forehead unaffected');
  assert.equal(pts[LM.NOSE_TIP * 2 + 1], before[LM.NOSE_TIP * 2 + 1], 'nose unaffected');

  const unchanged = syntheticFace({ eyesOpen: true, mouthOpen: false });
  applySmileBias(unchanged, 0, 200);
  assert.deepEqual(Array.from(unchanged), Array.from(before));
});

test('smoothingToFilterParams maps the slider to a monotonic cutoff range', () => {
  const responsive = smoothingToFilterParams(20);
  const steady = smoothingToFilterParams(100);
  assert.ok(responsive.minCutoff > steady.minCutoff);
  assert.ok(responsive.beta > steady.beta);
  assert.ok(steady.minCutoff > 0.5);
  const clampedLow = smoothingToFilterParams(-50);
  assert.deepEqual(clampedLow, responsive);
});

test('applySpeechAnatomy stabilizes upper lip and mustache landmarks during speech', () => {
  const pts = syntheticFace({ eyesOpen: true, mouthOpen: true });
  const beforeY = pts[LM.MOUTH.upperInner * 2 + 1];
  applySpeechAnatomy(pts, 0.25, 200);
  const afterY = pts[LM.MOUTH.upperInner * 2 + 1];
  assert.ok(afterY <= beforeY, 'upper lip descent was restrained');
});

test('applyEyelidKinematics folds eyelid landmarks down when blinking', () => {
  const pts = syntheticFace({ eyesOpen: true, mouthOpen: false });
  const beforeL = pts[385 * 2 + 1];
  const beforeR = pts[158 * 2 + 1];
  // Blink with near-zero EAR
  applyEyelidKinematics(pts, 0.05, 0.05, 0.9, 0.9);
  assert.ok(pts[385 * 2 + 1] > beforeL, 'left upper eyelid moved down');
  assert.ok(pts[158 * 2 + 1] > beforeR, 'right upper eyelid moved down');
});

test('applyGazeIrisTracking shifts irises according to gaze vector', () => {
  const pts = syntheticFace({ eyesOpen: true, mouthOpen: false });
  const beforeX = pts[LM.LEFT_IRIS_CENTER * 2];
  applyGazeIrisTracking(pts, 0.8, 0, 200);
  assert.ok(pts[LM.LEFT_IRIS_CENTER * 2] > beforeX, 'left iris shifted rightwards with gaze');
});

test('applyPerspectiveForeshortening adjusts landmark spacing on head turns', () => {
  const pts = syntheticFace({ eyesOpen: true, mouthOpen: false });
  const beforeCheekL = pts[LM.LEFT_CHEEK * 2];
  // Yaw right +25 deg (subject turns head to their right)
  applyPerspectiveForeshortening(pts, 25, 0, 200, 200, { x: 400, y: 400 });
  assert.notEqual(pts[LM.LEFT_CHEEK * 2], beforeCheekL, 'cheek landmark adjusted with 3D rotation');
});

test('extractOralApertureMetrics correctly calculates jaw opening and mouth width', () => {
  const pts = syntheticFace({ eyesOpen: true, mouthOpen: true });
  const metrics = extractOralApertureMetrics(pts);
  assert.ok(metrics !== null, 'metrics extracted');
  assert.ok(metrics!.mar > 0.3, 'mouth opening correctly measured');
  assert.equal(metrics!.mouthWidthPx, 80, 'mouth width is 80px');
});

test('lip weights cover exactly the inner and outer lip rings', () => {
  const topo = buildFaceTopology(TESSELLATION, OVAL, 468);
  for (const v of [...INNER_LIP_RING, ...OUTER_LIP_RING]) assert.equal(topo.lipWeights[v], 1, `vertex ${v}`);
  const ones = topo.lipWeights.filter((w) => w === 1).length;
  assert.equal(ones, new Set([...INNER_LIP_RING, ...OUTER_LIP_RING]).size);
  const feather = topo.lipWeights.filter((w) => Math.abs(w - LIP_FEATHER_RING1) < 1e-6).length;
  assert.ok(feather >= OUTER_LIP_RING.length, `feather ring has ${feather} vertices`);
  assert.equal(topo.lipWeights[LM.NOSE_TIP], 0);
  assert.equal(topo.lipWeights[LM.CHIN], 0);
  // The outer ring is one hop from the inner ring, so the band is contiguous.
  assert.ok(OUTER_LIP_RING.every((v) => topo.eyeRingDistance[v] > 2));
});

test('eyeFadeWeights grows outward from the eye rings with the radius', () => {
  const topo = buildFaceTopology(TESSELLATION, OVAL, 468);
  for (const v of [...LEFT_EYE_RING, ...RIGHT_EYE_RING]) assert.equal(topo.eyeRingDistance[v], 0);
  const none = eyeFadeWeights(topo, 0);
  assert.ok(none.every((w) => w === 0));
  const one = eyeFadeWeights(topo, 1);
  for (const v of LEFT_EYE_RING) assert.equal(one[v], 1);
  const ring1 = [...topo.eyeRingDistance].map((d, v) => (d === 1 ? v : -1)).filter((v) => v >= 0);
  assert.ok(ring1.length > 0);
  for (const v of ring1) assert.equal(one[v], 0);
  const two = eyeFadeWeights(topo, 2);
  for (const v of ring1) assert.equal(two[v], 1);
  const half = eyeFadeWeights(topo, 1.5);
  for (const v of ring1) assert.equal(half[v], 0.5);
  assert.equal(one[LM.NOSE_TIP], 0);
  assert.equal(two[LM.CHIN], 0);
});

test('lipFadeForMar is 0 for a closed mouth and 1 once the mouth is clearly open', () => {
  assert.equal(lipFadeForMar(0), 0);
  assert.equal(lipFadeForMar(0.02), 0);
  assert.equal(lipFadeForMar(0.1), 1);
  assert.equal(lipFadeForMar(0.5), 1);
  const mid = lipFadeForMar(0.06);
  assert.ok(mid > 0.4 && mid < 0.6, `mid ${mid}`);
  assert.equal(lipFadeForMar(0, 0.2), 0.2);
  assert.equal(lipFadeForMar(0.3, 0.2), 1);
});

test('lip zones tag the inner ring, outer contour, the ring outside and the rest', () => {
  const topo = buildFaceTopology(TESSELLATION, OVAL, 468);
  for (const v of INNER_LIP_RING) assert.equal(topo.lipZones[v], 0);
  for (const v of OUTER_LIP_RING) assert.equal(topo.lipZones[v], 1);
  const ring1 = [...topo.lipZones].filter((z) => z === 2).length;
  assert.ok(ring1 >= OUTER_LIP_RING.length, `ring outside the contour has ${ring1} vertices`);
  assert.equal(topo.lipZones[LM.NOSE_TIP], 3);
  assert.equal(topo.lipZones[LM.CHIN], 3);
});

test('closedLipMaskForZone keeps the lip band, masks just outside the contour and feathers out', () => {
  assert.equal(closedLipMaskForZone(0), 0);
  assert.equal(closedLipMaskForZone(0.9), 0);
  assert.equal(closedLipMaskForZone(1), 0);
  assert.equal(closedLipMaskForZone(1.3), 1);
  assert.equal(closedLipMaskForZone(2), 1);
  const mid = closedLipMaskForZone(2.5);
  assert.ok(mid > 0.4 && mid < 0.6, `mid ${mid}`);
  assert.equal(closedLipMaskForZone(3), 0);
});
