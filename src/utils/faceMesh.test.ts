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
  computeKinematics,
  fanTriangles,
  INNER_LIP_RING,
  LEFT_EYE_RING,
  LM,
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
