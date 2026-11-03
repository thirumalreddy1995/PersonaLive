import React from 'react';
import { Video, ShieldCheck, ScanFace, HelpCircle, Cpu, Activity } from 'lucide-react';
import { TelemetryStats, HeadPose, FacialMetrics, EngineStatus } from '../types/index.ts';

interface TelemetryBarProps {
  telemetry: TelemetryStats;
  pose: HeadPose;
  metrics: FacialMetrics;
  status: EngineStatus | null;
  virtualCamActive: boolean;
  onOpenVirtualCamHelp?: () => void;
  onOpenGuide?: () => void;
}

export const TelemetryBar: React.FC<TelemetryBarProps> = ({
  telemetry,
  pose,
  metrics,
  status,
  virtualCamActive,
  onOpenVirtualCamHelp,
  onOpenGuide,
}) => {
  const tracking = status?.model === 'ready';
  const faceOk = tracking && status?.faceDetected;
  const fmt = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(0)}°`;

  return (
    <footer className="h-9 bg-slate-950 border-t border-slate-800 flex items-center justify-between px-4 text-xs text-slate-400 select-none z-20">
      {/* Left: tracking state */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <span
            className={`w-2.5 h-2.5 rounded-full ${
              faceOk
                ? 'bg-emerald-400 animate-pulse shadow-sm shadow-emerald-500/50'
                : tracking
                  ? 'bg-amber-400'
                  : status?.model === 'error'
                    ? 'bg-rose-500'
                    : 'bg-slate-500'
            }`}
          />
          <span className="text-slate-200 font-medium text-xs">
            {faceOk ? 'Face Tracked' : tracking ? 'No Face in Frame' : status?.model === 'error' ? 'Tracker Error' : 'Loading Tracker'}
          </span>
        </div>

        <div className="h-3.5 w-px bg-slate-800" />

        <div className="flex items-center gap-1.5 font-mono text-[11px]">
          <Activity className="w-3.5 h-3.5 text-sky-400" />
          <span className="text-slate-200">{telemetry.fps.toFixed(1)}</span>
          <span className="text-slate-500">FPS</span>
          <span className="text-slate-700">·</span>
          <span className="text-slate-200">{telemetry.latencyMs.toFixed(1)}</span>
          <span className="text-slate-500">ms</span>
        </div>

        <div className="hidden md:flex items-center gap-1.5 text-[11px]">
          <Cpu className="w-3.5 h-3.5 text-slate-500" />
          <span className="text-slate-400">{telemetry.inferenceEngine}</span>
        </div>

        {faceOk && (
          <div className="hidden xl:flex items-center gap-1.5 font-mono text-[11px] text-slate-500">
            <ScanFace className="w-3.5 h-3.5 text-slate-500" />
            <span>
              Y {fmt(pose.yaw)} · P {fmt(pose.pitch)} · R {fmt(pose.roll)}
            </span>
          </div>
        )}
      </div>

      {/* Centre: expression chips */}
      <div className="hidden sm:flex items-center gap-2 text-xs">
        {metrics.isSpeaking && (
          <span className="px-2 py-0.5 rounded-full bg-emerald-950/80 text-emerald-400 border border-emerald-800/80 font-medium text-[11px] flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            Speaking
          </span>
        )}
        {metrics.isBlinking && (
          <span className="px-2 py-0.5 rounded-full bg-sky-950/80 text-sky-400 border border-sky-800/80 font-medium text-[11px]">
            Blinking
          </span>
        )}
        {metrics.isSmiling && (
          <span className="px-2 py-0.5 rounded-full bg-amber-950/80 text-amber-400 border border-amber-800/80 font-medium text-[11px]">
            Smiling
          </span>
        )}
        {metrics.eyebrowElevation > 0.45 && (
          <span className="px-2 py-0.5 rounded-full bg-violet-950/80 text-violet-300 border border-violet-800/80 font-medium text-[11px]">
            Brows Raised
          </span>
        )}
      </div>

      {/* Right: virtual cam & privacy */}
      <div className="flex items-center gap-3">
        <div
          onClick={onOpenVirtualCamHelp}
          className="flex items-center gap-1.5 cursor-pointer hover:text-slate-200 transition-colors"
          title="How to use the output in Zoom, Teams, Meet or OBS"
        >
          <Video className={`w-3.5 h-3.5 ${virtualCamActive ? 'text-emerald-400' : 'text-slate-500'}`} />
          <span className={virtualCamActive ? 'text-emerald-300 font-medium' : 'text-slate-400'}>
            {virtualCamActive ? 'Virtual Camera On' : 'Virtual Camera Off'}
          </span>
        </div>

        <div className="h-3.5 w-px bg-slate-800" />

        <div className="flex items-center gap-1 text-[11px] text-slate-500">
          <ShieldCheck className="w-3.5 h-3.5 text-sky-400" />
          <span>On-device · Watermarked</span>
        </div>

        <button
          onClick={onOpenGuide}
          className="flex items-center gap-1 text-[11px] text-slate-500 hover:text-sky-300 transition-colors"
          title="Open the user guide"
        >
          <HelpCircle className="w-3.5 h-3.5" />
          <span className="hidden lg:inline">Help</span>
        </button>
      </div>
    </footer>
  );
};
