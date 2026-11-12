/**
 * Head pose from MediaPipe's facial transformation matrix (R5 §5, flag matrixHeadPose).
 *
 * The landmarker's `outputFacialTransformationMatrixes` gives a 4×4 matrix that maps the canonical
 * face model into camera space (x right, y up, z toward the camera; the face looks along +z). Its
 * rotation is a real 3-D head pose in degrees, unlike the landmark-ratio estimate
 * (`estimateHeadPose`), which scales a nose offset and saturates at ±55°. Pure and unit-tested.
 */

export interface EulerAngles {
  /** Rotation about the vertical axis, degrees: positive turns the nose toward +x (image right, un-mirrored). */
  yaw: number;
  /** Rotation about the horizontal axis, degrees: positive tips the nose down. */
  pitch: number;
  /** Rotation about the viewing axis, degrees: positive is counter-clockwise as seen by the camera. */
  roll: number;
}

const DEG = 180 / Math.PI;

/**
 * Yaw, pitch and roll of a 4×4 transformation matrix, with the rotation factored as
 * R = Ry(yaw) · Rx(pitch) · Rz(roll) (roll applied first, then pitch, then yaw). Accepts the flat
 * 16-number array of the JS API in either storage order (the face sits at a negative z in front of
 * the camera, which tells them apart, as in rigidPose.decomposeTransform) and removes any uniform
 * or per-axis scale. Returns null for a malformed or degenerate matrix.
 *
 * At pitch = ±90° yaw and roll are not separable (gimbal lock); roll is then reported as 0 and
 * the whole in-plane rotation goes to yaw.
 */
export function matrixToEuler(data: ArrayLike<number>): EulerAngles | null {
  if (!data || data.length !== 16) return null;
  for (let i = 0; i < 16; i++) if (!Number.isFinite(data[i])) return null;
  const rowMajor = data[11] < 0 || data[14] >= 0;
  const m = (r: number, c: number) => (rowMajor ? data[r * 4 + c] : data[c * 4 + r]);
  // Columns of the rotation, each normalised (removes the model scale).
  const col = (c: number): [number, number, number] | null => {
    const x = m(0, c), y = m(1, c), z = m(2, c);
    const l = Math.hypot(x, y, z);
    return l > 1e-9 ? [x / l, y / l, z / l] : null;
  };
  const c0 = col(0), c1 = col(1), c2 = col(2);
  if (!c0 || !c1 || !c2) return null;
  // R[row][col]: r02 = c2[0], r12 = c2[1], r22 = c2[2], r10 = c0[1], r11 = c1[1].
  const sinPitch = Math.max(-1, Math.min(1, -c2[1]));
  const pitch = Math.asin(sinPitch);
  let yaw: number;
  let roll: number;
  if (Math.abs(sinPitch) > 0.999999) {
    // Gimbal lock: R = Ry(yaw ∓ roll) with the nose straight up or down.
    roll = 0;
    yaw = Math.atan2(-c0[2], c0[0]);
  } else {
    yaw = Math.atan2(c2[0], c2[2]);
    roll = Math.atan2(c0[1], c1[1]);
  }
  return { yaw: yaw * DEG, pitch: pitch * DEG, roll: roll * DEG };
}

/**
 * The matrix for given angles (degrees), R = Ry(yaw) · Rx(pitch) · Rz(roll), in column-major
 * order with a uniform scale and a translation. The inverse of matrixToEuler, used by its tests
 * and by synthetic fixtures.
 */
export function eulerToMatrix(yaw: number, pitch: number, roll: number, scale = 1, translation: [number, number, number] = [0, 0, -50]): number[] {
  const y = yaw / DEG, p = pitch / DEG, r = roll / DEG;
  const cy = Math.cos(y), sy = Math.sin(y);
  const cx = Math.cos(p), sx = Math.sin(p);
  const cz = Math.cos(r), sz = Math.sin(r);
  // Rows of Ry · Rx · Rz.
  const R = [
    [cy * cz + sy * sx * sz, -cy * sz + sy * sx * cz, sy * cx],
    [cx * sz, cx * cz, -sx],
    [-sy * cz + cy * sx * sz, sy * sz + cy * sx * cz, cy * cx],
  ];
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 3; c++) for (let rr = 0; rr < 3; rr++) out[c * 4 + rr] = R[rr][c] * scale;
  out[12] = translation[0];
  out[13] = translation[1];
  out[14] = translation[2];
  out[15] = 1;
  return out;
}

/**
 * The matrix pose in the app's driver convention, i.e. the signs of the landmark estimate on the
 * displayed frame: yaw is positive when the nose points toward the right of the displayed
 * (possibly mirrored) picture, pitch is positive looking down, roll is 0 for an upright head and
 * positive clockwise on the display. Mirroring the display flips yaw and roll. Null without a
 * usable matrix.
 */
export function driverPoseFromMatrix(data: ArrayLike<number> | null | undefined, mirror: boolean): EulerAngles | null {
  const e = data ? matrixToEuler(data) : null;
  if (!e) return null;
  const s = mirror ? -1 : 1;
  // Camera-space roll is counter-clockwise positive as the camera sees it; the display convention is clockwise positive.
  return { yaw: s * e.yaw, pitch: e.pitch, roll: -s * e.roll };
}
