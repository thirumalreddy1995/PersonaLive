import React from 'react';
import { X, Video, ShieldAlert } from 'lucide-react';

interface VirtualCamDialogProps {
  isOpen: boolean;
  onClose: () => void;
  virtualCamActive: boolean;
  onToggleVirtualCam: () => void;
}

export const VirtualCamDialog: React.FC<VirtualCamDialogProps> = ({
  isOpen,
  onClose,
  virtualCamActive,
  onToggleVirtualCam,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-xl w-full max-w-xl overflow-hidden shadow-2xl flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-emerald-950 border border-emerald-800 flex items-center justify-center text-emerald-400">
              <Video className="w-4 h-4" />
            </div>
            <div>
              <h2 className="font-semibold text-base text-slate-100">Virtual Camera Integration</h2>
              <p className="text-xs text-slate-400">System-wide video feed routing (Zoom, Teams, OBS, Discord)</p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-200 p-1.5 rounded-lg hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-4 text-xs text-slate-300">
          <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-between">
            <div className="space-y-0.5">
              <span className="font-medium text-slate-200 text-sm">DirectShow / CoreMedia Virtual Sink</span>
              <p className="text-slate-400 text-[11px]">
                Exposes transformed frame buffer as an OS webcam device
              </p>
            </div>
            <button
              onClick={onToggleVirtualCam}
              className={`px-3 py-1.5 rounded-lg font-semibold transition-colors ${
                virtualCamActive
                  ? 'bg-emerald-500 text-slate-950'
                  : 'bg-slate-800 hover:bg-slate-700 text-slate-200'
              }`}
            >
              {virtualCamActive ? 'Sink Active (Streaming)' : 'Activate Sink'}
            </button>
          </div>

          <div className="space-y-2">
            <h4 className="font-semibold text-slate-200">How to use in third-party software:</h4>
            <ol className="list-decimal list-inside space-y-2 text-slate-400 leading-relaxed bg-slate-950 p-4 rounded-xl border border-slate-800">
              <li>
                <strong className="text-slate-200">Keep PersonaLive Desktop running</strong> in the background with AI Transformation enabled.
              </li>
              <li>
                In <strong className="text-slate-200">Zoom, Microsoft Teams, or Discord</strong>, navigate to <span className="font-mono text-sky-400">Settings &gt; Video</span>.
              </li>
              <li>
                In the Camera dropdown list, select <strong className="text-sky-300">"PersonaLive Virtual Camera"</strong> or <strong className="text-sky-300">"OBS Virtual Camera"</strong>.
              </li>
              <li>
                The real-time transformed face with synchronized lip-sync and eye movement will automatically broadcast to call participants with mandatory synthetic disclosure badge.
              </li>
            </ol>
          </div>

          <div className="p-3 bg-amber-950/40 border border-amber-800/80 rounded-lg text-amber-300 flex items-start gap-2.5">
            <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
            <p className="text-[11px] leading-relaxed">
              <strong>Mandatory Disclosure:</strong> Output streams contain the persistent AI-Transformed watermark. Any attempt to modify drivers to bypass identity verification or facilitate deceptive impersonation violates the application EULA.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
