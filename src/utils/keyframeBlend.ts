/**
 * Keyframe cross-fade (R5 §1, flag keyframeCrossfade).
 *
 * Real keyframes are separate photos of the persona (guided enrollment). Each one is uploaded to
 * the GPU once and kept; a switch only changes which two textures the shader samples and how
 * they are mixed, so it uploads nothing. Both classes are pure (no DOM, no GL) so the rule
 * "switching keyframes uploads nothing" is unit-tested.
 */

/** Length of the cross-fade after the bank switches its primary keyframe. */
export const KEYFRAME_FADE_MS = 150;

/**
 * One GPU resource per keyframe source, created on first use and reused on every later switch.
 * `create` is the upload (texImage2D in the renderer); `uploads` counts how often it ran.
 */
export class KeyframeTextureCache<S extends object, T> {
  private entries = new Map<S, T>();
  /** Number of uploads since construction (or the last clear). */
  public uploads = 0;

  constructor(
    private readonly create: (source: S) => T,
    private readonly destroy?: (resource: T) => void
  ) {}

  /** The resource for `source`, uploading it only the first time it is asked for. */
  get(source: S): T {
    let entry = this.entries.get(source);
    if (entry === undefined) {
      entry = this.create(source);
      this.uploads++;
      this.entries.set(source, entry);
    }
    return entry;
  }

  has(source: S): boolean {
    return this.entries.has(source);
  }

  get size(): number {
    return this.entries.size;
  }

  /** Uploads every source that is not cached yet (persona load), so no switch ever uploads. */
  warm(sources: Iterable<S>): void {
    for (const s of sources) this.get(s);
  }

  /** Drops everything (new persona, lost context). `release` false skips the destroy callback (the context is gone). */
  clear(release = true): void {
    if (release && this.destroy) for (const e of this.entries.values()) this.destroy(e);
    this.entries.clear();
    this.uploads = 0;
  }
}

export interface KeyframeFade {
  /** The keyframe the bank selected (fading in, or fully shown). */
  primary: string;
  /** The keyframe being faded out, null when no fade is running. */
  secondary: string | null;
  /** Share of the secondary keyframe in the mix: 1 at the moment of the switch, 0 when the fade is over. */
  secondaryWeight: number;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/**
 * Turns the bank's primary-keyframe choice into a time-based cross-fade: on a switch the old
 * keyframe fades out over `durationMs` (smoothstep), so nothing pops. A switch back during a
 * fade reverses it from where it is; a switch to a third keyframe fades from whichever of the
 * two is currently dominant.
 */
export class KeyframeCrossfader {
  private current: string | null = null;
  private previous: string | null = null;
  /** Milliseconds the running fade has lasted (kept in ms so whole-millisecond steps add up exactly). */
  private elapsed = Infinity;
  private lastT: number | null = null;

  /** Linear progress of the running fade, 0..1 (1 = finished). */
  private get progress(): number {
    return this.durationMs > 0 ? Math.min(1, this.elapsed / this.durationMs) : 1;
  }

  constructor(private readonly durationMs = KEYFRAME_FADE_MS) {}

  reset(): void {
    this.current = null;
    this.previous = null;
    this.elapsed = Infinity;
    this.lastT = null;
  }

  /** Feeds the bank's primary keyframe id for this frame; `tMs` is monotonic milliseconds. */
  update(target: string, tMs: number): KeyframeFade {
    const dt = this.lastT === null ? 0 : Math.max(0, tMs - this.lastT);
    this.lastT = tMs;
    if (this.progress < 1) this.elapsed += dt;

    if (this.current === null) {
      this.current = target;
      this.previous = null;
      this.elapsed = Infinity;
    } else if (target !== this.current) {
      if (this.progress < 1 && target === this.previous) {
        // Back to the keyframe that was fading out: reverse from the current mix.
        this.previous = this.current;
        this.current = target;
        this.elapsed = this.durationMs - this.elapsed;
      } else {
        // A new keyframe: fade from whichever is dominant right now.
        this.previous = this.progress < 0.5 && this.previous !== null ? this.previous : this.current;
        this.current = target;
        this.elapsed = this.durationMs > 0 ? 0 : Infinity;
      }
    }
    if (this.progress >= 1) this.previous = null;
    return {
      primary: this.current,
      secondary: this.previous,
      secondaryWeight: this.previous === null ? 0 : 1 - smooth(this.progress),
    };
  }
}
