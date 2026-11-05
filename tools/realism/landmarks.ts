/**
 * MediaPipe Face Landmarker index sets used by the realism metrics. Kept here (not imported from
 * the app) so the capture tool runs in plain Node without the MediaPipe package.
 */

/** Face oval, ordered clockwise starting at the top (landmark 10). */
export const FACE_OVAL_RING = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136,
  172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
];

/** Outer lip contour (docs/REALISM_PLAN.md, R1). */
export const OUTER_LIP_RING = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146];

/** Inner lip contour (mouth aperture). */
export const INNER_LIP_RING = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191];

/** Upper face-oval points used for the forehead region (plan R4b). */
export const UPPER_OVAL = [54, 103, 67, 109, 10, 338, 297, 332, 284];

export const LMK = {
  TOP: 10,
  GLABELLA: 9,
  CHIN: 152,
  LEFT_TEMPLE: 454,
  RIGHT_TEMPLE: 234,
  LEFT_CHEEK: 280,
  RIGHT_CHEEK: 50,
  LEFT_TEMPLE_UPPER: 332,
  RIGHT_TEMPLE_UPPER: 103,
} as const;

export const LANDMARK_COUNT = 478;
