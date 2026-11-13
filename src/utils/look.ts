/**
 * R6: the user-facing "Camera blend" setting. 0 is the Balanced look (the default chosen at the end
 * of R6); 1 is the measured Camera-matched preset, which softens the face boundary and keeps more
 * of the wearer's own lips at rest so the persona sits into the camera image, at a measured cost in
 * how strongly it reads as the persona (docs/REALISM_PLAN.md, R6 Part 2 report). Pure, so the
 * engine, the panel and the tests share one mapping.
 */
import type { TransformationSettings } from '../types/index.ts';

/** The Camera-matched preset's values, reached at cameraBlend = 1 (Balanced is 1 and 0). */
export const CAMERA_BLEND_FULL = { boundaryFeather: 1.5, lipFadeFloor: 0.3 } as const;

export interface ResolvedLook {
  /** Width of the face-boundary feather relative to the built-in one (1 = five mesh rings). */
  boundaryFeather: number;
  /** Minimum lip fade, 0..1 (0 = persona lips at rest, 1 = always the wearer's). */
  lipFadeFloor: number;
}

function unit(v: number | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/**
 * The boundary feather and lip-fade floor the engine uses. An explicit `boundaryFeather` (review
 * tools, `?rs=`) wins over the blend; the lip floor is the higher of the user's own "lips at rest"
 * value and the blend's, so moving the blend never brings back persona lips the user turned off.
 */
export function resolveLook(s: Pick<TransformationSettings, 'lipFadeFloor' | 'boundaryFeather' | 'cameraBlend'>): ResolvedLook {
  const blend = unit(s.cameraBlend);
  const explicitFeather = typeof s.boundaryFeather === 'number' && Number.isFinite(s.boundaryFeather) ? s.boundaryFeather : null;
  return {
    boundaryFeather: explicitFeather ?? 1 + (CAMERA_BLEND_FULL.boundaryFeather - 1) * blend,
    lipFadeFloor: Math.max(unit(s.lipFadeFloor), CAMERA_BLEND_FULL.lipFadeFloor * blend),
  };
}
