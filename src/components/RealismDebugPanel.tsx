import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Bug, ChevronDown, ChevronUp, RotateCcw } from 'lucide-react';
import { REALISM_FLAG_DEFS, RealismFlagKey, describeRealismFlags, realismFlags } from '../realism/flags.ts';
import {
  RealismBufferName,
  RealismDebugState,
  RealismEngineDebugApi,
  getRealismEngine,
  subscribeRealismEngine,
} from '../realism/debug.ts';

/**
 * Dev-only "Realism debug" panel (docs/REALISM_PLAN.md). Toggles each pipeline stage live, shows
 * the frame profiler, and previews intermediate buffers. Mounted only when realism debugging is on.
 */

const BUFFERS: Array<{ id: RealismBufferName; label: string }> = [
  { id: 'output', label: 'Output' },
  { id: 'overlay', label: 'Persona layer (alpha)' },
  { id: 'warp', label: 'Warp (raw)' },
  { id: 'driver', label: 'Driver' },
];

const GROUP_LABELS: Record<string, string> = {
  mesh: 'Mesh vertex offsets',
  overlay: 'Overlay boundary passes',
  post: 'Painted post-pass',
  bank: 'Reference bank',
  shader: 'Shader beautification',
  'mouth-eyes': 'Real mouth and eyes',
  texture: 'Texture fidelity',
};

function useFlags() {
  return useSyncExternalStore(
    (cb) => realismFlags.subscribe(() => cb()),
    () => realismFlags.get(),
    () => realismFlags.get()
  );
}

function useEngineApi(): RealismEngineDebugApi | null {
  return useSyncExternalStore(subscribeRealismEngine, getRealismEngine, getRealismEngine);
}

export const RealismDebugPanel: React.FC = () => {
  const flags = useFlags();
  const api = useEngineApi();
  const [open, setOpen] = useState<boolean>(true);
  const [state, setState] = useState<RealismDebugState | null>(null);
  const [buffer, setBuffer] = useState<RealismBufferName>('output');
  const previewRef = useRef<HTMLCanvasElement | null>(null);

  // Poll the engine state twice a second; it is cheap (ring-buffer summaries).
  useEffect(() => {
    if (!api) {
      setState(null);
      return;
    }
    const tick = () => setState(api.getState());
    tick();
    const id = window.setInterval(tick, 500);
    return () => window.clearInterval(id);
  }, [api]);

  // Buffer preview at ~10 fps.
  useEffect(() => {
    if (!api || !open) return;
    let raf = 0;
    let last = 0;
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (now - last < 100) return;
      last = now;
      const canvas = previewRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const W = canvas.width;
      const H = canvas.height;
      ctx.clearRect(0, 0, W, H);
      if (buffer === 'overlay') {
        // Checkerboard so the persona layer's alpha is visible.
        const cell = 8;
        for (let y = 0; y < H; y += cell) {
          for (let x = 0; x < W; x += cell) {
            ctx.fillStyle = ((x / cell + y / cell) & 1) === 0 ? '#1e293b' : '#334155';
            ctx.fillRect(x, y, cell, cell);
          }
        }
      } else {
        ctx.fillStyle = '#0b1220';
        ctx.fillRect(0, 0, W, H);
      }
      const video = buffer === 'driver' ? api.getVideo() : null;
      const source: CanvasImageSource | null = video && video.readyState >= 2 ? video : api.getBuffer(buffer);
      if (!source) return;
      const sw = source instanceof HTMLVideoElement ? source.videoWidth : source.width;
      const sh = source instanceof HTMLVideoElement ? source.videoHeight : source.height;
      if (!sw || !sh) return;
      const scale = Math.min(W / sw, H / sh);
      const dw = sw * scale;
      const dh = sh * scale;
      ctx.drawImage(source, (W - dw) / 2, (H - dh) / 2, dw, dh);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [api, buffer, open]);

  const toggle = useCallback((key: RealismFlagKey) => realismFlags.set({ [key]: !realismFlags.get()[key] }), []);

  const profile = state?.profile;
  const stageNames = profile ? Object.keys(profile.stages) : [];

  return (
    <div className="fixed bottom-3 left-3 z-50 w-[300px] max-h-[85vh] overflow-y-auto rounded-lg border border-amber-700/60 bg-slate-950/95 text-[11px] text-slate-300 shadow-xl shadow-black/50 backdrop-blur">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-3 py-2 text-amber-300 font-semibold"
        title="Dev-only realism tooling. See docs/REALISM_PLAN.md"
      >
        <span className="flex items-center gap-1.5">
          <Bug className="w-3.5 h-3.5" /> Realism debug
        </span>
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-3">
          {/* Flags */}
          <div className="space-y-2">
            {(['mesh', 'overlay', 'post', 'bank', 'shader', 'mouth-eyes', 'texture'] as const).map((group) => (
              <div key={group}>
                <div className="uppercase tracking-wider text-[9px] text-slate-500 mb-1">{GROUP_LABELS[group]}</div>
                {REALISM_FLAG_DEFS.filter((d) => d.group === group).map((def) => (
                  <label key={def.key} className="flex items-start gap-2 py-0.5 cursor-pointer" title={def.description}>
                    <input type="checkbox" className="mt-0.5 accent-amber-400" checked={flags[def.key]} onChange={() => toggle(def.key)} />
                    <span className={flags[def.key] === def.defaultValue ? '' : 'text-amber-200'}>
                      {def.label}
                      {def.appliesOn === 'persona-reload' && <span className="text-slate-500"> (reloads persona)</span>}
                    </span>
                  </label>
                ))}
              </div>
            ))}
            <div className="flex items-center justify-between gap-2">
              <code className="text-[10px] text-slate-500 truncate" title="Pass to npm run realism:capture -- --flags">
                {describeRealismFlags(flags)}
              </code>
              <button
                onClick={() => realismFlags.reset()}
                className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-slate-700 text-slate-400 hover:text-slate-200"
                title="Restore the shipped defaults"
              >
                <RotateCcw className="w-3 h-3" /> Defaults
              </button>
            </div>
          </div>

          {/* Profile */}
          <div>
            <div className="uppercase tracking-wider text-[9px] text-slate-500 mb-1">Frame profile</div>
            {!profile ? (
              <p className="text-slate-500">No engine registered.</p>
            ) : (
              <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-[10px]">
                <span className="text-slate-500">fps</span>
                <span>{profile.fps.toFixed(1)}</span>
                <span className="text-slate-500">frame p50 / p95</span>
                <span>
                  {profile.frameP50Ms.toFixed(1)} / {profile.frameP95Ms.toFixed(1)} ms
                </span>
                {stageNames.map((name) => (
                  <React.Fragment key={name}>
                    <span className="text-slate-500">{name}</span>
                    <span>
                      {profile.stages[name].avgMs.toFixed(1)} ms <span className="text-slate-600">p95 {profile.stages[name].p95Ms.toFixed(1)}</span>
                    </span>
                  </React.Fragment>
                ))}
                <span className="text-slate-500">synthetic teeth</span>
                <span>{state?.syntheticTeethFrames ?? 0} frames</span>
                <span className="text-slate-500">keyframe</span>
                <span className="truncate">
                  {state?.keyframeId ?? 'master'} ({state?.keyframeCount ?? 0})
                </span>
                <span className="text-slate-500">pose / mar</span>
                <span>
                  {state ? `${state.pose.yaw.toFixed(0)}° ${state.pose.pitch.toFixed(0)}° ${state.pose.roll.toFixed(0)}° · ${state.mar.toFixed(2)} · lip fade ${state.lipFade.toFixed(2)}` : "-"}
                </span>
                <span className="text-slate-500">source</span>
                <span>
                  {state?.source ?? '-'}
                  {state?.videoTime !== null && state?.videoTime !== undefined ? ` · ${state.videoTime.toFixed(2)}s` : ''}
                </span>
              </div>
            )}
            <button
              onClick={() => api?.resetPerf()}
              disabled={!api}
              className="mt-1 px-1.5 py-0.5 rounded border border-slate-700 text-slate-400 hover:text-slate-200 disabled:opacity-40"
            >
              Reset counters
            </button>
          </div>

          {/* Buffers */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="uppercase tracking-wider text-[9px] text-slate-500">Buffer</span>
              <select
                value={buffer}
                onChange={(e) => setBuffer(e.target.value as RealismBufferName)}
                className="bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[10px] text-slate-200"
              >
                {BUFFERS.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
              </select>
            </div>
            <canvas ref={previewRef} width={272} height={153} className="w-full rounded border border-slate-800 bg-slate-900" />
          </div>
        </div>
      )}
    </div>
  );
};
