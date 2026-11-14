/**
 * "Stronger likeness": the user-facing switch for the R6b identity pipeline, chosen per persona
 * (docs/REALISM_PLAN.md, R6b round 3 and the close-out after it).
 *
 * The R6b flags make the output carry more of the persona (its beard, brows, skin tone and lip and
 * nose colour, interior proportions and jaw line) at a measured cost in cheek tone: on the
 * 28-persona grid of single photos the worst 10% reached about ±4.7 ΔE against the camera's neck
 * and ears (tolerance 3), mostly on harshly lit, colour-cast or bearded photos. So the switch is
 * off for an uploaded photo and on for a guided webcam enrollment, whose seven shots are taken in
 * the room's own even light; the user can turn it either way for each persona.
 *
 * Pure (no DOM), like flags.ts, so the engine, the panel, the review tools and the tests share it.
 */
import type { AuthorizedPersona, TransformationSettings } from '../types/index.ts';
import type { RealismFlagKey, RealismFlags } from './flags.ts';

/** The R6b identity flags the switch turns on (the `r6b` preset minus `r6`). */
export const STRONGER_LIKENESS_FLAGS: ReadonlyArray<RealismFlagKey> = [
  'relightIllumination',
  'skinTint',
  'personaProportions',
  'jawExtension',
  'lidPassThrough',
  'seamFade',
  'photoLighting',
];

/** Skin tone match while the switch is on, until the user moves the slider (the persona keeps most of its own tone). */
export const LIKENESS_SKIN_TONE_MATCH = 0.3;

/** True for a persona made by the guided webcam enrollment: only that flow attaches reference shots. */
export function isGuidedEnrollment(persona: Pick<AuthorizedPersona, 'references'>): boolean {
  return (persona.references?.length ?? 0) > 0;
}

/** The switch's value when the user has not chosen one for this persona. */
export function strongerLikenessDefault(persona: Pick<AuthorizedPersona, 'references'>): boolean {
  return isGuidedEnrollment(persona);
}

/** Whether Stronger likeness is on for this persona: the user's choice, else the default. Off without a persona. */
export function strongerLikenessFor(persona: Pick<AuthorizedPersona, 'references' | 'strongerLikeness'> | null | undefined): boolean {
  if (!persona) return false;
  return typeof persona.strongerLikeness === 'boolean' ? persona.strongerLikeness : strongerLikenessDefault(persona);
}

/**
 * The flags the engine renders with: the stored flags, plus every R6b identity flag while Stronger
 * likeness is on. The switch only adds flags, so a review run or the debug panel can still turn
 * them on without it; with the switch off the stored flags are returned unchanged.
 */
export function effectiveRealismFlags(flags: RealismFlags, strongerLikeness: boolean): RealismFlags {
  if (!strongerLikeness || STRONGER_LIKENESS_FLAGS.every((k) => flags[k])) return flags;
  const out = { ...flags };
  for (const k of STRONGER_LIKENESS_FLAGS) out[k] = true;
  return out;
}

/** Keys whose value differs between two flag sets. */
export function changedFlagKeys(a: RealismFlags, b: RealismFlags): RealismFlagKey[] {
  return (Object.keys(b) as RealismFlagKey[]).filter((k) => a[k] !== b[k]);
}

function unit(v: number | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;
}

/**
 * The skin tone match the engine uses. Stronger likeness keeps its own value
 * (`likenessSkinToneMatch`, default LIKENESS_SKIN_TONE_MATCH), so moving the slider for a
 * likeness persona never changes the look of the uploaded-photo personas, and back.
 */
export function resolveSkinToneMatch(s: Pick<TransformationSettings, 'skinToneMatch' | 'likenessSkinToneMatch'>, strongerLikeness: boolean): number {
  return strongerLikeness ? unit(s.likenessSkinToneMatch, LIKENESS_SKIN_TONE_MATCH) : unit(s.skinToneMatch, 1);
}

/** The settings key the skin tone slider writes to. */
export function skinToneMatchKey(strongerLikeness: boolean): 'skinToneMatch' | 'likenessSkinToneMatch' {
  return strongerLikeness ? 'likenessSkinToneMatch' : 'skinToneMatch';
}

export type LikenessMode = 'auto' | 'on' | 'off';

/**
 * The review tools' `--likeness auto|on|off` as a persona's `strongerLikeness`: `auto` leaves it
 * unset (the app's default). Without the option a run that names its flags (`--flags r6`) renders
 * exactly those flags, so the switch is off; a run without `--flags` captures the app as it ships.
 */
export function reviewLikeness(mode: LikenessMode | null, flagsGiven: boolean): boolean | undefined {
  const m = mode ?? (flagsGiven ? 'off' : 'auto');
  return m === 'auto' ? undefined : m === 'on';
}
