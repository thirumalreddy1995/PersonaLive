/**
 * Per-frame stage profiler for the facial engine.
 *
 * Records wall-clock durations per named stage and per frame in fixed-size ring buffers, so the
 * debug panel and the capture tool can read FPS, p50/p95 frame time and per-stage averages at any
 * moment. When `measure` is on it also emits `performance.measure('realism:<stage>')` entries so the
 * browser profiler shows the same stages; those are cleared periodically so they never pile up.
 *
 * Pure (no DOM) apart from `performance`, which Node provides too, so it is unit-testable.
 */
export interface StageSummary {
  avgMs: number;
  p95Ms: number;
  samples: number;
}

export interface ProfileSummary {
  fps: number;
  frameP50Ms: number;
  frameP95Ms: number;
  frameAvgMs: number;
  frames: number;
  stages: Record<string, StageSummary>;
}

const DEFAULT_WINDOW = 300;

export class RingBuffer {
  private buf: Float64Array;
  private head = 0;
  private count = 0;

  constructor(size: number) {
    this.buf = new Float64Array(Math.max(1, size));
  }

  push(v: number) {
    this.buf[this.head] = v;
    this.head = (this.head + 1) % this.buf.length;
    if (this.count < this.buf.length) this.count++;
  }

  get length() {
    return this.count;
  }

  values(): number[] {
    const out: number[] = new Array(this.count);
    const start = (this.head - this.count + this.buf.length) % this.buf.length;
    for (let i = 0; i < this.count; i++) out[i] = this.buf[(start + i) % this.buf.length];
    return out;
  }

  clear() {
    this.head = 0;
    this.count = 0;
  }
}

/** Nearest-rank percentile of a numeric list; 0 for an empty list. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank];
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

export class FrameProfiler {
  private stages = new Map<string, RingBuffer>();
  private open = new Map<string, number>();
  private frameTimes: RingBuffer;
  private frameStamps: RingBuffer;
  private window: number;
  private measureCount = 0;
  /** Emit performance.measure entries as well (debug panel / capture tool). */
  public measure = false;

  constructor(window = DEFAULT_WINDOW, private now: () => number = () => performance.now()) {
    this.window = window;
    this.frameTimes = new RingBuffer(window);
    this.frameStamps = new RingBuffer(window);
  }

  begin(stage: string) {
    this.open.set(stage, this.now());
  }

  end(stage: string) {
    const start = this.open.get(stage);
    if (start === undefined) return;
    this.open.delete(stage);
    const end = this.now();
    let ring = this.stages.get(stage);
    if (!ring) {
      ring = new RingBuffer(this.window);
      this.stages.set(stage, ring);
    }
    ring.push(end - start);
    if (this.measure && typeof performance !== 'undefined' && typeof performance.measure === 'function') {
      try {
        performance.measure(`realism:${stage}`, { start, end });
        if (++this.measureCount >= this.window * 8) {
          this.measureCount = 0;
          performance.clearMeasures();
        }
      } catch {
        // Older runtimes without the options form of performance.measure: timings still live here.
      }
    }
  }

  /** Records one whole frame: its duration and the time it ended (for FPS). */
  frame(durationMs: number, endedAt: number = this.now()) {
    this.frameTimes.push(durationMs);
    this.frameStamps.push(endedAt);
  }

  reset() {
    this.frameTimes.clear();
    this.frameStamps.clear();
    for (const ring of this.stages.values()) ring.clear();
    this.open.clear();
  }

  summary(): ProfileSummary {
    const frames = this.frameTimes.values();
    const stamps = this.frameStamps.values();
    const span = stamps.length >= 2 ? stamps[stamps.length - 1] - stamps[0] : 0;
    const fps = span > 0 ? ((stamps.length - 1) * 1000) / span : 0;
    const stages: Record<string, StageSummary> = {};
    for (const [name, ring] of this.stages) {
      const v = ring.values();
      stages[name] = { avgMs: round2(mean(v)), p95Ms: round2(percentile(v, 95)), samples: v.length };
    }
    return {
      fps: round2(fps),
      frameP50Ms: round2(percentile(frames, 50)),
      frameP95Ms: round2(percentile(frames, 95)),
      frameAvgMs: round2(mean(frames)),
      frames: frames.length,
      stages,
    };
  }
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
