import React from 'react';
import { X, Video, ShieldAlert, ExternalLink } from 'lucide-react';

const OBS_DOWNLOAD_URL = 'https://obsproject.com/';

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
              <h2 className="font-semibold text-base text-slate-100">Virtual Camera via OBS</h2>
              <p className="text-xs text-slate-400">Send the studio output to Zoom, Teams, Meet or Discord</p>
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
              <span className="font-medium text-slate-200 text-sm">Virtual camera status badge</span>
              <p className="text-slate-400 text-[11px]">
                Shows “Virtual Camera On” in the title and telemetry bars while you stream the studio through OBS.
                PersonaLive does not install a camera driver of its own.
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
              {virtualCamActive ? 'Badge shown' : 'Show badge'}
            </button>
          </div>

          <div className="space-y-2">
            <h4 className="font-semibold text-slate-200">How to use the output in a video call:</h4>
            <p className="text-slate-400 leading-relaxed">
              Browsers and Electron cannot register a system-wide webcam, so the studio window is captured with the free
              OBS Studio virtual camera.
            </p>
            <ol className="list-decimal list-inside space-y-2 text-slate-400 leading-relaxed bg-slate-950 p-4 rounded-xl border border-slate-800">
              <li>
                Install{' '}
                <a
                  href={OBS_DOWNLOAD_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sky-400 hover:underline inline-flex items-center gap-1"
                >
                  OBS Studio <ExternalLink className="w-3 h-3" />
                </a>{' '}
                (Windows, macOS, Linux).
              </li>
              <li>
                <strong className="text-slate-200">Keep PersonaLive running</strong> with AI Transformation enabled and a persona selected.
              </li>
              <li>
                In OBS add a <strong className="text-slate-200">Window Capture</strong> source for the PersonaLive window, then click{' '}
                <strong className="text-slate-200">Start Virtual Camera</strong>.
              </li>
              <li>
                In <strong className="text-slate-200">Zoom, Teams, Meet or Discord</strong> open <span className="font-mono text-sky-400">Settings &gt; Video</span> and
                choose <strong className="text-sky-300">“OBS Virtual Camera”</strong>.
              </li>
            </ol>
          </div>

          <div className="p-3 bg-amber-950/40 border border-amber-800/80 rounded-lg text-amber-300 flex items-start gap-2.5">
            <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
            <p className="text-[11px] leading-relaxed">
              <strong>Mandatory Disclosure:</strong> Every frame carries the persistent AI-Transformed watermark, so call participants can see the video is synthetic. Removing the watermark or using the output for deceptive impersonation violates the application EULA.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
