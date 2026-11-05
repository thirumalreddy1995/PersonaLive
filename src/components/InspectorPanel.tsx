import React from 'react';
import {
  Sliders,
  Sparkles,
  ShieldCheck,
  Eye,
  Smile,
  Sun,
  Plus,
  Check,
  Loader2,
  AlertTriangle,
  ScanFace,
  Cpu,
} from 'lucide-react';
import {
  AuthorizedPersona,
  TransformationSettings,
  TelemetryStats,
  EngineStatus,
  PersonaCategory,
  CATEGORY_LABEL,
} from '../types/index.ts';
import { UserRound } from 'lucide-react';

interface InspectorPanelProps {
  activePersona: AuthorizedPersona | null;
  personas: AuthorizedPersona[];
  onSelectPersona: (persona: AuthorizedPersona) => void;
  settings: TransformationSettings;
  telemetry: TelemetryStats;
  status: EngineStatus | null;
  subjectCategory: PersonaCategory;
  onChangeSubjectCategory: (category: PersonaCategory) => void;
  onUpdateSettings: (newSettings: Partial<TransformationSettings>) => void;
  onOpenLibrary: () => void;
  onOpenConsentLogs: () => void;
}

export const InspectorPanel: React.FC<InspectorPanelProps> = ({
  activePersona,
  personas,
  onSelectPersona,
  settings,
  status,
  subjectCategory,
  onChangeSubjectCategory,
  onUpdateSettings,
  onOpenLibrary,
}) => {
  const personaState = status?.persona ?? 'none';
  const matchingPersonas = personas.filter((p) => p.category === subjectCategory);
  const hiddenCount = personas.length - matchingPersonas.length;

  return (
    <aside className="w-80 bg-slate-950 border-l border-slate-800 flex flex-col h-full overflow-y-auto text-xs text-slate-300 divide-y divide-slate-800 select-none">
      {/* 0. Who is at the camera */}
      <div className="p-4 space-y-2">
        <span className="font-semibold text-slate-100 flex items-center gap-1.5">
          <UserRound className="w-3.5 h-3.5 text-sky-400" />
          Who is at the camera?
        </span>
        <div className="grid grid-cols-2 gap-1.5">
          {(['women', 'men'] as const).map((c) => (
            <button
              key={c}
              onClick={() => onChangeSubjectCategory(c)}
              className={`py-2 rounded-lg text-xs font-semibold border transition-colors ${
                subjectCategory === c
                  ? 'bg-sky-500 text-slate-950 border-sky-400 shadow-sm'
                  : 'bg-slate-900 text-slate-300 border-slate-800 hover:border-slate-600'
              }`}
            >
              {CATEGORY_LABEL[c].one}
            </button>
          ))}
        </div>
        <p className="text-[10px] text-slate-500">
          Only {CATEGORY_LABEL[subjectCategory].plural.toLowerCase()} can be mapped onto a {CATEGORY_LABEL[subjectCategory].one.toLowerCase()}.
        </p>
      </div>

      {/* 1. Persona switcher */}
      <div className="p-4 bg-slate-900/40 space-y-3">
        <div className="flex items-center justify-between">
          <span className="font-semibold text-slate-100 flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5 text-sky-400" />
            Choose Your Face
          </span>
          <button
            onClick={onOpenLibrary}
            className="text-[11px] text-sky-400 hover:text-sky-300 font-medium flex items-center gap-1 hover:underline"
          >
            <Plus className="w-3 h-3" />
            Upload Photo
          </button>
        </div>

        {matchingPersonas.length === 0 && (
          <div className="rounded-xl border border-dashed border-slate-700 p-3 text-[11px] text-slate-400 text-center">
            No {CATEGORY_LABEL[subjectCategory].plural.toLowerCase()} yet.{' '}
            <button onClick={onOpenLibrary} className="text-sky-400 hover:underline font-medium">
              Upload one
            </button>
          </div>
        )}
        <div className="grid grid-cols-4 gap-2">
          {matchingPersonas.slice(0, 4).map((p) => {
            const isSelected = activePersona?.id === p.id;
            return (
              <button
                key={p.id}
                onClick={() => onSelectPersona(p)}
                className={`relative rounded-xl p-1 border flex flex-col items-center gap-1 transition-all ${
                  isSelected
                    ? 'bg-sky-950/60 border-sky-400 shadow-md shadow-sky-950 ring-1 ring-sky-400/50'
                    : 'bg-slate-900 border-slate-800 hover:border-slate-700 opacity-75 hover:opacity-100'
                }`}
                title={p.name}
              >
                <img src={p.imageUrl} alt={p.name} className="w-12 h-12 rounded-lg object-cover" />
                <span className="text-[10px] text-slate-200 font-medium truncate w-full text-center">
                  {p.name.split(' ')[0]}
                </span>
                {isSelected && (
                  <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-sky-500 text-slate-950 flex items-center justify-center shadow">
                    <Check className="w-2.5 h-2.5 stroke-[3]" />
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {hiddenCount > 0 && (
          <p className="text-[10px] text-slate-500">
            {hiddenCount} {hiddenCount === 1 ? 'face is' : 'faces are'} hidden because {hiddenCount === 1 ? 'it belongs' : 'they belong'} to the other group.
          </p>
        )}

        {activePersona && (
          <div className="bg-slate-900/80 rounded-xl border border-slate-800/80 p-2.5 flex items-center gap-2.5">
            <img
              src={activePersona.imageUrl}
              alt={activePersona.name}
              className="w-10 h-10 rounded-lg object-cover border border-slate-700"
            />
            <div className="min-w-0 flex-1">
              <h4 className="font-semibold text-slate-100 text-xs truncate">{activePersona.name}</h4>
              <p className="text-[10px] text-slate-400 truncate">{activePersona.role}</p>
              <div className="flex items-center gap-1 text-[10px] mt-0.5">
                {personaState === 'ready' ? (
                  <span className="flex items-center gap-1 text-emerald-400">
                    <ShieldCheck className="w-3 h-3" /> Authorized · Face mapped
                  </span>
                ) : personaState === 'preparing' ? (
                  <span className="flex items-center gap-1 text-sky-300">
                    <Loader2 className="w-3 h-3 animate-spin" /> Mapping 478 landmarks…
                  </span>
                ) : personaState === 'no-face' || personaState === 'error' ? (
                  <span className="flex items-center gap-1 text-rose-400">
                    <AlertTriangle className="w-3 h-3" /> {personaState === 'no-face' ? 'No face found in photo' : 'Photo unusable'}
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-slate-500">
                    <Loader2 className="w-3 h-3 animate-spin" /> Waiting for tracker
                  </span>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 2. Transformation controls */}
      <div className="p-4 space-y-4">
        <div className="flex items-center gap-1.5 text-slate-100 font-semibold">
          <Sliders className="w-3.5 h-3.5 text-sky-400" />
          <span>Face Transformation Controls</span>
        </div>

        <div className="space-y-1.5">
          <div className="flex justify-between">
            <span className="text-slate-200 font-medium">Transformation Strength</span>
            <span className="font-mono text-sky-400 font-bold">{settings.blendStrength}%</span>
          </div>
          <input
            type="range"
            min="30"
            max="100"
            value={settings.blendStrength}
            onChange={(e) => onUpdateSettings({ blendStrength: Number(e.target.value) })}
            className="w-full accent-sky-500 cursor-pointer h-2 bg-slate-800 rounded-lg"
          />
          <div className="flex justify-between text-[10px] text-slate-500">
            <span>Subtle blend</span>
            <span>Full replacement</span>
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="flex justify-between">
            <span className="text-slate-200 font-medium">Movement Smoothness</span>
            <span className="font-mono text-sky-400 font-bold">{settings.temporalSmoothing}%</span>
          </div>
          <input
            type="range"
            min="20"
            max="100"
            value={settings.temporalSmoothing}
            onChange={(e) => onUpdateSettings({ temporalSmoothing: Number(e.target.value) })}
            className="w-full accent-sky-500 cursor-pointer h-2 bg-slate-800 rounded-lg"
          />
          <div className="flex justify-between text-[10px] text-slate-500">
            <span>Instant response</span>
            <span>Steady, no jitter</span>
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="flex justify-between">
            <span className="text-slate-200 font-medium flex items-center gap-1">
              <Smile className="w-3.5 h-3.5 text-amber-400" />
              <span>Smile &amp; Expression Warmth</span>
            </span>
            <span className="font-mono text-sky-400 font-bold">
              {settings.manualSmileBias > 0
                ? `+${Math.round(settings.manualSmileBias * 100)}%`
                : `${Math.round(settings.manualSmileBias * 100)}%`}
            </span>
          </div>
          <input
            type="range"
            min="-0.5"
            max="0.5"
            step="0.05"
            value={settings.manualSmileBias || 0}
            onChange={(e) => onUpdateSettings({ manualSmileBias: Number(e.target.value) })}
            className="w-full accent-amber-500 cursor-pointer h-2 bg-slate-800 rounded-lg"
          />
          <div className="flex justify-between text-[10px] text-slate-500">
            <span>Serious</span>
            <span>Neutral</span>
            <span>Warm smile</span>
          </div>
        </div>

        <div className="pt-2 space-y-2.5">
          <label className="flex items-center justify-between cursor-pointer p-2 rounded-lg bg-slate-900/60 hover:bg-slate-900 transition-colors">
            <span className="flex items-center gap-2 text-slate-200">
              <Eye className="w-3.5 h-3.5 text-sky-400" />
              <span>
                Keep My Real Eyes
                <span className="block text-[10px] text-slate-500 font-normal">Natural blinking &amp; eye contact</span>
              </span>
            </span>
            <input
              type="checkbox"
              checked={settings.eyeGazeSync}
              onChange={(e) => onUpdateSettings({ eyeGazeSync: e.target.checked })}
              className="accent-sky-500 w-4 h-4 rounded cursor-pointer"
            />
          </label>

          {settings.eyeGazeSync && (
            <div className="px-2 pb-1 space-y-1">
              <div className="flex items-center justify-between text-[10px] text-slate-500">
                <span>Eye pass-through (lids &amp; lashes)</span>
                <span className="text-slate-300">{settings.eyePassThroughRadius.toFixed(2)} rings</span>
              </div>
              <input
                type="range"
                min="0"
                max="2"
                step="0.25"
                value={settings.eyePassThroughRadius}
                onChange={(e) => onUpdateSettings({ eyePassThroughRadius: Number(e.target.value) })}
                className="w-full accent-sky-500 cursor-pointer h-1.5 bg-slate-800 rounded-lg"
              />
            </div>
          )}

          <label className="flex items-center justify-between cursor-pointer p-2 rounded-lg bg-slate-900/60 hover:bg-slate-900 transition-colors">
            <span className="flex items-center gap-2 text-slate-200">
              <Smile className="w-3.5 h-3.5 text-rose-400" />
              <span>
                Keep My Real Mouth
                <span className="block text-[10px] text-slate-500 font-normal">Your own lips, teeth and tongue while you talk</span>
              </span>
            </span>
            <input
              type="checkbox"
              checked={settings.keepRealMouth}
              onChange={(e) => onUpdateSettings({ keepRealMouth: e.target.checked })}
              className="accent-rose-500 w-4 h-4 rounded cursor-pointer"
            />
          </label>

          <label className="flex items-center justify-between p-2 rounded-lg bg-slate-900/60">
            <span className="text-slate-200">
              Persona texture size
              <span className="block text-[10px] text-slate-500 font-normal">Face crop resolution uploaded to the GPU</span>
            </span>
            <select
              value={settings.personaTextureSize}
              onChange={(e) => onUpdateSettings({ personaTextureSize: Number(e.target.value) as 512 | 1024 | 2048 })}
              className="bg-slate-950 border border-slate-800 rounded px-2 py-1 text-xs text-slate-200"
            >
              <option value={512}>512 px</option>
              <option value={1024}>1024 px</option>
              <option value={2048}>2048 px</option>
            </select>
          </label>

          <label className="flex items-center justify-between cursor-pointer p-2 rounded-lg bg-slate-900/60 hover:bg-slate-900 transition-colors">
            <span className="flex items-center gap-2 text-slate-200">
              <Sun className="w-3.5 h-3.5 text-amber-400" />
              <span>
                Match My Room Lighting
                <span className="block text-[10px] text-slate-500 font-normal">Adapts skin tone to your camera</span>
              </span>
            </span>
            <input
              type="checkbox"
              checked={settings.lightingAdaptation}
              onChange={(e) => onUpdateSettings({ lightingAdaptation: e.target.checked })}
              className="accent-sky-500 w-4 h-4 rounded cursor-pointer"
            />
          </label>
        </div>
      </div>

      {/* 3. Output quality */}
      <div className="p-4 space-y-2.5">
        <label className="text-slate-200 font-semibold block">Video Quality</label>
        <div className="grid grid-cols-3 gap-1.5">
          {(['1080p', '720p', '540p'] as const).map((res) => (
            <button
              key={res}
              onClick={() => onUpdateSettings({ outputResolution: res })}
              className={`py-2 rounded-lg text-center font-medium text-xs border transition-colors ${
                settings.outputResolution === res
                  ? 'bg-sky-500 text-slate-950 font-bold border-sky-400 shadow-sm'
                  : 'bg-slate-900 text-slate-400 border-slate-800 hover:text-slate-200 hover:border-slate-700'
              }`}
            >
              {res === '1080p' ? 'Full HD' : res === '720p' ? 'HD (Best)' : 'Fast'}
            </button>
          ))}
        </div>
        <p className="text-[10px] text-slate-500">720p HD is recommended for 30 FPS video calls with the lowest latency.</p>
      </div>

      {/* 4. Tracking engine */}
      <div className="p-4 space-y-2">
        <div className="flex items-center gap-1.5 text-slate-200 font-semibold">
          <ScanFace className="w-3.5 h-3.5 text-sky-400" />
          <span>Tracking Engine</span>
        </div>
        <div className="grid grid-cols-2 gap-1.5 text-[11px]">
          <div className="rounded-lg bg-slate-900/70 border border-slate-800 p-2">
            <p className="text-slate-500">Landmarks</p>
            <p className="text-slate-200 font-medium">478 points · 52 expressions</p>
          </div>
          <div className="rounded-lg bg-slate-900/70 border border-slate-800 p-2">
            <p className="text-slate-500">Compute</p>
            <p className="text-slate-200 font-medium flex items-center gap-1">
              <Cpu className="w-3 h-3 text-slate-500" />
              {status?.backend === 'GPU' ? 'GPU (WebGL)' : status?.backend === 'CPU' ? 'CPU (WASM)' : '—'}
            </p>
          </div>
          <div className="rounded-lg bg-slate-900/70 border border-slate-800 p-2">
            <p className="text-slate-500">Face</p>
            <p className={`font-medium ${status?.faceDetected ? 'text-emerald-400' : 'text-slate-400'}`}>
              {status?.faceDetected ? 'Tracked' : status?.model === 'ready' ? 'Not in frame' : 'Loading…'}
            </p>
          </div>
          <div className="rounded-lg bg-slate-900/70 border border-slate-800 p-2">
            <p className="text-slate-500">Renderer</p>
            <p className="text-slate-200 font-medium">{status?.renderer === 'canvas2d' ? 'Canvas 2D' : 'WebGL warp'}</p>
          </div>
        </div>
      </div>

      {/* 5. Privacy */}
      <div className="p-4 space-y-1.5 mt-auto bg-slate-900/30 text-[11px] text-slate-400">
        <div className="flex items-center gap-1.5 text-slate-300 font-semibold text-xs">
          <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
          <span>100% Private On-Device</span>
        </div>
        <p className="leading-relaxed">
          Tracking and rendering run entirely in this window. No webcam frames or face data leave your computer, and every
          output frame carries the AI-transformed watermark.
        </p>
      </div>
    </aside>
  );
};
