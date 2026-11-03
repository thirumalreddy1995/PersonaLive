import React from 'react';
import {
  Sliders,
  Sparkles,
  Video,
  ShieldCheck,
  Eye,
  Smile,
  Sun,
  Plus,
  Check,
} from 'lucide-react';
import { AuthorizedPersona, TransformationSettings, TelemetryStats } from '../types/index.ts';

interface InspectorPanelProps {
  activePersona: AuthorizedPersona | null;
  personas: AuthorizedPersona[];
  onSelectPersona: (persona: AuthorizedPersona) => void;
  settings: TransformationSettings;
  telemetry: TelemetryStats;
  onUpdateSettings: (newSettings: Partial<TransformationSettings>) => void;
  onOpenLibrary: () => void;
  onOpenConsentLogs: () => void;
}

export const InspectorPanel: React.FC<InspectorPanelProps> = ({
  activePersona,
  personas,
  onSelectPersona,
  settings,
  telemetry,
  onUpdateSettings,
  onOpenLibrary,
}) => {
  return (
    <aside className="w-80 bg-slate-950 border-l border-slate-800 flex flex-col h-full overflow-y-auto text-xs text-slate-300 divide-y divide-slate-800 select-none">
      {/* 1. Fast 1-Tap Persona Switcher */}
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

        {/* 1-Tap Avatar Row */}
        <div className="grid grid-cols-4 gap-2">
          {personas.slice(0, 4).map((p) => {
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
                <img
                  src={p.imageUrl}
                  alt={p.name}
                  className="w-12 h-12 rounded-lg object-cover"
                />
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

        {/* Active Face Summary Card */}
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
              <div className="flex items-center gap-1 text-[10px] text-emerald-400 mt-0.5">
                <ShieldCheck className="w-3 h-3" />
                <span>Authorized &amp; Verified</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 2. Simple, Friendly Sliders */}
      <div className="p-4 space-y-4">
        <div className="flex items-center gap-1.5 text-slate-100 font-semibold">
          <Sliders className="w-3.5 h-3.5 text-sky-400" />
          <span>Face Transformation Controls</span>
        </div>

        {/* Transformation Strength */}
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
            <span>Natural Blend (30%)</span>
            <span>Complete Transformation (100%)</span>
          </div>
        </div>

        {/* Motion Smoothness */}
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
            <span>Responsive</span>
            <span>Ultra Steady &amp; Stable</span>
          </div>
        </div>

        {/* Friendly Expression Bias */}
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
            <span>Warm Smile</span>
          </div>
        </div>

        {/* Simple Checkbox Toggles */}
        <div className="pt-2 space-y-2.5">
          <label className="flex items-center justify-between cursor-pointer p-2 rounded-lg bg-slate-900/60 hover:bg-slate-900 transition-colors">
            <span className="flex items-center gap-2 text-slate-200">
              <Eye className="w-3.5 h-3.5 text-sky-400" />
              <span>Follow My Blinking &amp; Eyes</span>
            </span>
            <input
              type="checkbox"
              checked={settings.eyeGazeSync}
              onChange={(e) => onUpdateSettings({ eyeGazeSync: e.target.checked })}
              className="accent-sky-500 w-4 h-4 rounded cursor-pointer"
            />
          </label>

          <label className="flex items-center justify-between cursor-pointer p-2 rounded-lg bg-slate-900/60 hover:bg-slate-900 transition-colors">
            <span className="flex items-center gap-2 text-slate-200">
              <Sun className="w-3.5 h-3.5 text-amber-400" />
              <span>Adapt to Room Lighting</span>
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

      {/* 3. Output Quality Selection */}
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
        <p className="text-[10px] text-slate-500">
          * 720p HD is recommended for 30 FPS video calls with lowest latency.
        </p>
      </div>

      {/* 4. Privacy & Consent Notice */}
      <div className="p-4 space-y-1.5 mt-auto bg-slate-900/30 text-[11px] text-slate-400">
        <div className="flex items-center gap-1.5 text-slate-300 font-semibold text-xs">
          <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
          <span>100% Private On-Device</span>
        </div>
        <p className="leading-relaxed">
          Your video is processed directly on your computer. No webcam footage or personal face data is ever sent to external cloud servers.
        </p>
      </div>
    </aside>
  );
};
