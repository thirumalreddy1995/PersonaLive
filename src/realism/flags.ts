/**
 * Realism stage flags.
 *
 * Every visual stage of the persona pipeline that the realism pass touches sits behind one of
 * these flags so before/after can be compared live (debug panel) and headlessly (capture tool).
 * Defaults are the behaviour of the latest finished phase (R4: segmentation masks, foreshortening fade and
 * persona inpaint on top of R3c's auto relight radius and R3: relit from the real frame, rest-mouth
 * lip window, steady camera match, soft pass-through edges, on top of R1/R2's tracked warp, real
 * mouth and eye pass-through, rigid forehead, WebGL2 texture pipeline). `--flags r0` restores the pre-R1 behaviour; a default changes only after a
 * phase report shows the comparison.
 *
 * This module is pure (no DOM, no Vite env) so the capture tool and the unit tests can import it.
 */
export interface RealismFlagDef {
  key: RealismFlagKey;
  label: string;
  description: string;
  defaultValue: boolean;
  /** Where in the pipeline the flag acts. */
  group: 'mesh' | 'overlay' | 'post' | 'bank' | 'shader' | 'mouth-eyes' | 'texture';
  /** Set when toggling needs the persona to be re-prepared, or the engine re-created, rather than taking effect next frame. */
  appliesOn?: 'persona-reload' | 'engine-restart';
}

export type RealismFlagKey =
  | 'speechAnatomy'
  | 'perspectiveForeshortening'
  | 'eyelidKinematics'
  | 'foreheadHarmonize'
  | 'hairlineSoften'
  | 'oralCavity'
  | 'catchlights'
  | 'syntheticSuite'
  | 'shaderUnsharp'
  | 'shaderSubsurface'
  | 'shaderSebum'
  | 'realMouth'
  | 'eyePassThrough'
  | 'closedLipMask'
  | 'rigidForehead'
  | 'webgl2'
  | 'personaCrop'
  | 'cameraMatch'
  | 'relight'
  | 'restMouth'
  | 'softHoles'
  | 'steadyCameraMatch'
  | 'motionBlur'
  | 'relightGlobalTone'
  | 'relightShadowGuard'
  | 'personaDelight'
  | 'autoRadius'
  | 'symmetricDelight'
  | 'segmentation'
  | 'twoBandBlend'
  | 'foreshortenFade'
  | 'personaInpaint'
  | 'cameraMatchSameMask';

export const REALISM_FLAG_DEFS: ReadonlyArray<RealismFlagDef> = [
  {
    key: 'speechAnatomy',
    label: 'Speech anatomy offsets',
    description: 'applySpeechAnatomy moves upper-lip vertices away from the tracked lips while talking.',
    defaultValue: false,
    group: 'mesh',
  },
  {
    key: 'perspectiveForeshortening',
    label: 'Perspective foreshortening',
    description: 'applyPerspectiveForeshortening shifts vertices by yaw/pitch instead of using the tracked points.',
    defaultValue: false,
    group: 'mesh',
  },
  {
    key: 'eyelidKinematics',
    label: 'Eyelid kinematics',
    description: 'applyEyelidKinematics folds persona eyelid vertices down on blinks.',
    defaultValue: false,
    group: 'mesh',
  },
  {
    key: 'rigidForehead',
    label: 'Rigid-pose forehead',
    description:
      'Forehead vertices follow the smoothed head pose from the facial transformation matrix (plus a learned shape offset) and fade back to the tracked points between 15° and 30° of yaw; brows follow it plus a smoothed expression offset (R2).',
    defaultValue: true,
    group: 'mesh',
  },
  {
    key: 'foreheadHarmonize',
    label: 'Forehead boundary erase',
    description: 'CranialBoundaryBlender.harmonizeForeheadBoundary erases persona alpha across the upper forehead.',
    defaultValue: true,
    group: 'overlay',
  },
  {
    key: 'hairlineSoften',
    label: 'Hairline blur pass',
    description: 'CranialBoundaryBlender.softenHairlineEdges blurs the overlay alpha along the hairline (blur(4px) per frame).',
    defaultValue: true,
    group: 'overlay',
  },
  {
    key: 'oralCavity',
    label: 'Procedural oral cavity',
    description: 'OralCavityRenderer paints synthetic teeth, tongue and mouth shadows over the real mouth.',
    defaultValue: false,
    group: 'post',
  },
  {
    key: 'catchlights',
    label: 'Painted eye catchlights',
    description: 'A fixed white glint is drawn on each iris regardless of the real lighting.',
    defaultValue: false,
    group: 'post',
  },
  {
    key: 'syntheticSuite',
    label: 'Synthesised keyframe suite',
    description:
      'MultiReferenceBank.synthesizeSuiteFromMaster builds yaw/pitch/viseme/smile keyframes by shifting the one photo.',
    defaultValue: false,
    group: 'bank',
    appliesOn: 'persona-reload',
  },
  {
    key: 'shaderUnsharp',
    label: 'Shader unsharp mask',
    description: 'Fixed-offset high-pass sharpening of the persona texture in the warp shader (R1 §5).',
    defaultValue: false,
    group: 'shader',
  },
  {
    key: 'shaderSubsurface',
    label: 'Shader subsurface tint',
    description: 'Warm "subdermal" tint mixed into mid-tones in the warp shader (R1 §5).',
    defaultValue: false,
    group: 'shader',
  },
  {
    key: 'shaderSebum',
    label: 'Shader sebum sheen',
    description: 'Synthetic specular sheen added where the lighting gain is high (R1 §5).',
    defaultValue: false,
    group: 'shader',
  },
  {
    key: 'webgl2',
    label: 'WebGL2 renderer',
    description: 'Prefer a WebGL2 context (GLSL ES 3.00, highp, mipmaps for any texture size, asynchronous readback). Takes effect when the engine is created (R2 §1).',
    defaultValue: true,
    group: 'texture',
    appliesOn: 'engine-restart',
  },
  {
    key: 'personaCrop',
    label: 'Persona crop + mipmaps',
    description: 'Crop the reference to the face oval × 1.6, resize to the texture-size setting, recompute UVs and upload with mipmaps and anisotropic filtering (R2 §2).',
    defaultValue: true,
    group: 'texture',
    appliesOn: 'persona-reload',
  },
  {
    key: 'cameraMatch',
    label: 'Camera-matched sharpness and noise',
    description: 'Every 15 frames compare the wearer\'s and the persona\'s face-region sharpness and noise (asynchronous readback, WebGL2 only) and blur/sharpen the persona plus add matching noise (R2 §4).',
    defaultValue: true,
    group: 'texture',
  },
  {
    key: 'realMouth',
    label: 'Keep my real mouth (lip fade)',
    description: 'Fades the persona lip band as the mouth opens so the wearer\'s real lips show instead of stretched persona lips (R1 §2). Also needs the user setting.',
    defaultValue: true,
    group: 'mouth-eyes',
  },
  {
    key: 'eyePassThrough',
    label: 'Eye pass-through ring',
    description: 'Fades the persona in a ring around the eye holes so the wearer\'s lids and lashes show (R1 §6). Radius is a user setting.',
    defaultValue: true,
    group: 'mouth-eyes',
  },
  {
    key: 'relight',
    label: 'Relight from the real frame',
    description:
      'Frequency-separation relighting (R3): the persona keeps its own detail (pores, brows, stubble) over the wearer\'s low-pass shading, with its chroma matched toward the wearer\'s at the face boundary (setting skinToneMatch). Replaces the 5-zone gain while on.',
    defaultValue: true,
    group: 'shader',
  },
  {
    key: 'relightGlobalTone',
    label: 'Relight: global persona tone',
    description:
      'The relit chroma is the wearer\'s local chroma shifted by the persona\'s mean skin tone over the wearer\'s (raised to 1 - tone weight), instead of the persona\'s local low-pass chroma: the persona\'s own light colour (warm key, cold fill) no longer leaks into the output (R3).',
    defaultValue: true,
    group: 'shader',
  },
  {
    key: 'relightShadowGuard',
    label: 'Relight: shadow guard',
    description: 'Where the persona low pass is nearly black (deep shadow in the photo) the detail term fades to 1 so the divided-out noise is not amplified (R3).',
    defaultValue: true,
    group: 'shader',
  },
  {
    key: 'personaDelight',
    label: 'Persona de-light at load',
    description:
      'Fits a 2nd-order shading field per channel over the persona photo\'s face skin (linear light) and divides it out when the persona is prepared, so the photo\'s key/fill light and colour cast go while mid-scale form stays (R3b). Re-prepares the persona.',
    defaultValue: false,
    group: 'texture',
    appliesOn: 'persona-reload',
  },
  {
    key: 'autoRadius',
    label: 'Auto relight radius',
    description:
      'Each persona starts at a 2% relight radius and the loop raises it toward 8% while the output\'s side-shading gap and cheek-vs-neck gap stay within ~3 L / 3 ΔE of the wearer\'s own (hysteresis-smoothed, same async readback as the camera match), backing off otherwise (R3c item 1). Replaces the relightRadius setting while on.',
    defaultValue: true,
    group: 'shader',
  },
  {
    key: 'symmetricDelight',
    label: 'Symmetric de-light',
    description:
      'Splits the persona\'s mid-band luminance (2% to the active radius) per mesh vertex into the part that is mirror-symmetric about the face midline and the part that is not, and divides the asymmetric part (the photo\'s key light) out in linear light (R3c item 2). Re-prepares the persona.',
    defaultValue: false,
    group: 'shader',
    appliesOn: 'persona-reload',
  },
  {
    key: 'segmentation',
    label: 'Segmentation masks',
    description:
      'MediaPipe multiclass selfie segmenter every N frames (setting segmentEvery), EMA-smoothed and uploaded as a texture: the persona is removed under the wearer\'s hair (ghost strands), hands (body skin) and glasses (accessories) and limited to face skin; the geometric hairline falloff and the destination-out passes become the fallback when the segmenter is unavailable (R4 §1–2).',
    defaultValue: true,
    group: 'overlay',
  },
  {
    key: 'twoBandBlend',
    label: 'Two-band boundary blend',
    description: 'Blends the relit low frequencies over a wide feather (~12% of face width, 7 rings) and the detail over the narrow one, using the R3 low-pass layers (R4 §3).',
    defaultValue: false,
    group: 'shader',
  },
  {
    key: 'foreshortenFade',
    label: 'Foreshortened-triangle fade',
    description: 'Per frame, fades persona alpha on triangles compressed below 40% of their rest area or back-facing, so the far cheek on a turned head shows the colour-matched real skin instead of a smear (R4 §4).',
    defaultValue: true,
    group: 'mesh',
  },
  {
    key: 'personaInpaint',
    label: 'Persona photo inpaint',
    description: 'Segments the persona photo at load and inpaints hair and accessories (glasses) inside the face oval from the surrounding skin; the share replaced feeds the quality-gate warning (R4).',
    defaultValue: true,
    group: 'texture',
    appliesOn: 'persona-reload',
  },
  {
    key: 'cameraMatchSameMask',
    label: 'Camera match on the same pixels',
    description: 'The camera-match loop measures the camera frame only on the pixels where it measures the persona (where the persona layer is opaque). Without it, fading or removing parts of the persona (foreshortening fade, segmentation) drops their detail from the persona side only, the persona reads blurrier than it looks and the loop lowers the blur (R4).',
    defaultValue: false,
    group: 'texture',
  },
  {
    key: 'steadyCameraMatch',
    label: 'Steady camera match',
    description: 'Camera-match estimates go through a slow EMA with a dead band and hold during fast head motion, so the blur tracks the camera\'s steady softness rather than per-frame motion blur (R3 item 3).',
    defaultValue: true,
    group: 'texture',
  },
  {
    key: 'motionBlur',
    label: 'Directional motion blur',
    description: 'Blurs the persona along the head\'s screen velocity, proportional to it, so a moving persona smears like the camera frame does (R3 item 3).',
    defaultValue: false,
    group: 'texture',
  },
  {
    key: 'restMouth',
    label: 'Rest-mouth calibration',
    description: 'Learns the wearer\'s resting mouth aperture from frontal frames (low percentile over ~2 s, recalibrated while frontal) and places the lip-fade thresholds above it (R3 item 1).',
    defaultValue: true,
    group: 'mouth-eyes',
  },
  {
    key: 'softHoles',
    label: 'Soft pass-through edges',
    description: 'Widens the eye and mouth pass-through fades to the camera-match blur radius so their edges do not sit sharper than the matched skin (R3 item 4).',
    defaultValue: true,
    group: 'mouth-eyes',
  },
  {
    key: 'closedLipMask',
    label: 'Closed-lip mask',
    description: 'With the mouth closed, removes persona lip colour outside the wearer\'s outer lip contour (feathered to the next ring) so fuller persona lips draw no painted outline (R2).',
    defaultValue: false,
    group: 'mouth-eyes',
  },
];

/**
 * The behaviour shipped at the end of R0, as a flag string: `--flags r0` reproduces it whatever
 * the current defaults are. Update this only when a phase report changes defaults.
 */
export const R0_FLAG_STRING =
  'speechAnatomy=1,perspectiveForeshortening=1,eyelidKinematics=1,foreheadHarmonize=1,hairlineSoften=1,oralCavity=1,catchlights=1,syntheticSuite=1,shaderUnsharp=1,shaderSubsurface=1,shaderSebum=1,realMouth=0,eyePassThrough=0,closedLipMask=0,rigidForehead=0,webgl2=0,personaCrop=0,cameraMatch=0,relight=0,restMouth=0,softHoles=0,steadyCameraMatch=0,motionBlur=0,relightGlobalTone=0,relightShadowGuard=0,personaDelight=0,autoRadius=0,symmetricDelight=0,segmentation=0,twoBandBlend=0,foreshortenFade=0,personaInpaint=0,cameraMatchSameMask=0';

/** The R1 defaults, as a flag string: `--flags r1` reproduces the end-of-R1 behaviour. */
export const R1_FLAG_STRING =
  'speechAnatomy=0,perspectiveForeshortening=0,eyelidKinematics=0,foreheadHarmonize=1,hairlineSoften=1,oralCavity=0,catchlights=0,syntheticSuite=0,shaderUnsharp=0,shaderSubsurface=0,shaderSebum=0,realMouth=1,eyePassThrough=1,closedLipMask=0,rigidForehead=0,webgl2=0,personaCrop=0,cameraMatch=0,relight=0,restMouth=0,softHoles=0,steadyCameraMatch=0,motionBlur=0,relightGlobalTone=0,relightShadowGuard=0,personaDelight=0,autoRadius=0,symmetricDelight=0,segmentation=0,twoBandBlend=0,foreshortenFade=0,personaInpaint=0,cameraMatchSameMask=0';

/** The R2 defaults, as a flag string: `--flags r2` reproduces the end-of-R2 behaviour. */
export const R2_FLAG_STRING =
  'speechAnatomy=0,perspectiveForeshortening=0,eyelidKinematics=0,foreheadHarmonize=1,hairlineSoften=1,oralCavity=0,catchlights=0,syntheticSuite=0,shaderUnsharp=0,shaderSubsurface=0,shaderSebum=0,realMouth=1,eyePassThrough=1,closedLipMask=1,rigidForehead=1,webgl2=1,personaCrop=1,cameraMatch=1,relight=0,restMouth=0,softHoles=0,steadyCameraMatch=0,motionBlur=0,relightGlobalTone=0,relightShadowGuard=0,personaDelight=0,autoRadius=0,symmetricDelight=0,segmentation=0,twoBandBlend=0,foreshortenFade=0,personaInpaint=0,cameraMatchSameMask=0';

/** The R3 defaults (end of R3b), as a flag string: `--flags r3` reproduces them (fixed 2% relight radius, no loop). */
export const R3_FLAG_STRING =
  'speechAnatomy=0,perspectiveForeshortening=0,eyelidKinematics=0,foreheadHarmonize=1,hairlineSoften=1,oralCavity=0,catchlights=0,syntheticSuite=0,shaderUnsharp=0,shaderSubsurface=0,shaderSebum=0,realMouth=1,eyePassThrough=1,closedLipMask=0,rigidForehead=1,webgl2=1,personaCrop=1,cameraMatch=1,relight=1,restMouth=1,softHoles=1,steadyCameraMatch=1,motionBlur=0,relightGlobalTone=1,relightShadowGuard=1,personaDelight=0,autoRadius=0,symmetricDelight=0,segmentation=0,twoBandBlend=0,foreshortenFade=0,personaInpaint=0,cameraMatchSameMask=0';

/** The R3c defaults (auto relight radius on, R4 flags off), as a flag string: `--flags r3c`. The loop's thresholds are constants (1.5 / 2.5 since R4). */
export const R3C_FLAG_STRING = R3_FLAG_STRING.replace('autoRadius=0', 'autoRadius=1');

/** Named flag presets accepted by parseRealismFlagString (case-insensitive). */
export const REALISM_FLAG_PRESETS: Record<string, string> = { r0: R0_FLAG_STRING, r1: R1_FLAG_STRING, r2: R2_FLAG_STRING, r3: R3_FLAG_STRING, r3c: R3C_FLAG_STRING };

export type RealismFlags = Record<RealismFlagKey, boolean>;

export function defaultRealismFlags(): RealismFlags {
  const flags = {} as RealismFlags;
  for (const def of REALISM_FLAG_DEFS) flags[def.key] = def.defaultValue;
  return flags;
}

export function isRealismFlagKey(key: string): key is RealismFlagKey {
  return REALISM_FLAG_DEFS.some((d) => d.key === key);
}

const TRUE_WORDS = new Set(['1', 'true', 'on', 'yes']);
const FALSE_WORDS = new Set(['0', 'false', 'off', 'no']);

/**
 * Parses `key=value` pairs separated by commas, semicolons or whitespace, e.g.
 * `oralCavity=0,catchlights=off syntheticSuite=false`. A bare key means `true`; a `!key` or `-key`
 * prefix means `false`. Unknown keys and unparseable values are reported, not applied.
 */
export function parseRealismFlagString(input: string): { flags: Partial<RealismFlags>; errors: string[] } {
  const flags: Partial<RealismFlags> = {};
  const errors: string[] = [];
  for (const raw of input.split(/[\s,;]+/)) {
    const token = raw.trim();
    if (!token) continue;
    const preset = REALISM_FLAG_PRESETS[token.toLowerCase()];
    if (preset !== undefined) {
      const expanded = parseRealismFlagString(preset);
      Object.assign(flags, expanded.flags);
      errors.push(...expanded.errors);
      continue;
    }
    let key = token;
    let value: boolean | null = true;
    const eq = token.indexOf('=');
    if (eq >= 0) {
      key = token.slice(0, eq).trim();
      const word = token.slice(eq + 1).trim().toLowerCase();
      value = TRUE_WORDS.has(word) ? true : FALSE_WORDS.has(word) ? false : null;
    } else if (key.startsWith('!') || key.startsWith('-')) {
      key = key.slice(1);
      value = false;
    }
    if (!isRealismFlagKey(key)) {
      errors.push(`unknown flag "${key}"`);
      continue;
    }
    if (value === null) {
      errors.push(`flag "${key}" needs on/off, 1/0 or true/false`);
      continue;
    }
    flags[key] = value;
  }
  return { flags, errors };
}

/** Reads flag overrides from a URL query string (`?rf=oralCavity=0,catchlights=0`). */
export function parseRealismFlagsFromSearch(search: string): Partial<RealismFlags> {
  const params = new URLSearchParams(search);
  const rf = params.get('rf');
  return rf ? parseRealismFlagString(rf).flags : {};
}

/** Serialises the flags that differ from their defaults, for run labels and report.json. */
export function describeRealismFlags(flags: RealismFlags): string {
  const defaults = defaultRealismFlags();
  const parts: string[] = [];
  for (const def of REALISM_FLAG_DEFS) {
    if (flags[def.key] !== defaults[def.key]) parts.push(`${def.key}=${flags[def.key] ? 'on' : 'off'}`);
  }
  return parts.length ? parts.join(',') : 'defaults';
}

type Listener = (flags: RealismFlags, changed: RealismFlagKey[]) => void;

/** Process-wide flag store. The engine reads it per frame; the panel and the debug hook write it. */
class RealismFlagStore {
  private flags = defaultRealismFlags();
  private listeners = new Set<Listener>();

  get(): RealismFlags {
    return this.flags;
  }

  set(patch: Partial<RealismFlags>): RealismFlagKey[] {
    const changed: RealismFlagKey[] = [];
    const next = { ...this.flags };
    for (const def of REALISM_FLAG_DEFS) {
      const v = patch[def.key];
      if (typeof v === 'boolean' && v !== next[def.key]) {
        next[def.key] = v;
        changed.push(def.key);
      }
    }
    if (changed.length === 0) return changed;
    this.flags = next;
    for (const l of this.listeners) l(next, changed);
    return changed;
  }

  reset(): RealismFlagKey[] {
    return this.set(defaultRealismFlags());
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const realismFlags = new RealismFlagStore();
