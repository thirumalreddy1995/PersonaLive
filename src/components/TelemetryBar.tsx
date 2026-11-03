import React from 'react';
import { Video, ShieldCheck, CheckCircle2, Sparkles, HelpCircle } from 'lucide-react';
import { TelemetryStats, HeadPose, FacialMetrics } from '../types/index.ts';

interface TelemetryBarProps {
  telemetry: TelemetryStats;
  pose: HeadPose;
  metrics: FacialMetrics;
  virtualCamActive: boolean;
  onOpenVirtualCamHelp?: () => void;
  onOpenGuide?: () => void;
}

export const TelemetryBar: React.FC<TelemetryBarProps> = ({
  telemetry,
  pose,
  metrics,
  virtualCamActive,
  onOpenVirtualCamHelp,
  onOpenGuide,
}) => {
  return (
    <footer className="h-9 bg-slate-950 border-t border-slate-800 flex items-center justify-between px-4 text-xs text-slate-400 select-none z-20">
      {/* Left: Friendly Status Indicator */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse shadow-sm shadow-emerald-500/50" />
          <span className="text-slate-200 font-medium text-xs">Studio Live</span>
        </div>

        <div className="h-3.5 w-px bg-slate-800" />

        <div className="flex items-center gap-1.5 text-slate-400">
          <Sparkles className="w-3.5 h-3.5 text-sky-400" />
          <span>Smooth Real-Time AI Transformation</span>
        </div>
      </div>

      {/* Center: Friendly Expression Status */}
      <div className="hidden sm:flex items-center gap-2 text-xs">
        {metrics.isSpeaking && (
          <span className="px-2 py-0.5 rounded-full bg-emerald-950/80 text-emerald-400 border border-emerald-800/80 font-medium text-[11px] flex items-center gap-1 animate-pulse">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            Speaking &amp; Lip-Syncing
          </span>
        )}
        {metrics.isBlinking && (
          <span className="px-2 py-0.5 rounded-full bg-sky-950/80 text-sky-400 border border-sky-800/80 font-medium text-[11px]">
            Blinking
          </span>
        )}
        {metrics.isSmiling && !metrics.isSpeaking && (
          <span className="px-2 py-0.5 rounded-full bg-amber-950/80 text-amber-400 border border-amber-800/80 font-medium text-[11px]">
            Smiling
          </span>
        )}
      </div>

      {/* Right: Friendly Virtual Cam & Help link */}
      <div className="flex items-center gap-3">
        <div
          onClick={onOpenVirtualCamHelp}
          className="flex items-center gap-1.5 cursor-pointer hover:text-slate-200 transition-colors"
          title="Click to view Zoom & Teams connection instructions"
        >
          <Video className={`w-3.5 h-3.5 ${virtualCamActive ? 'text-emerald-400' : 'text-slate-500'}`} />
          <span className={virtualCamActive ? 'text-emerald-300 font-medium' : 'text-slate-400'}>
            {virtualCamActive ? 'Virtual Camera Connected' : 'Virtual Camera Off'}
          </span>
        </div>

        <div className="h-3.5 w-px bg-slate-800" />

        <div className="flex items-center gap-1 text-[11px] text-slate-500">
          <ShieldCheck className="w-3.5 h-3.5 text-sky-400" />
          <span>Private &amp; Verified</span>
        </div>
      </div>
    </footer>
  );
};
