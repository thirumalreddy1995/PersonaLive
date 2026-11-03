import React from 'react';
import { X, Download, Monitor, CheckCircle2, ExternalLink, ArrowRight, Sparkles, Laptop } from 'lucide-react';

interface InstallAppModalProps {
  isOpen: boolean;
  onClose: () => void;
  onTriggerInstall: () => Promise<boolean>;
  isInstallable: boolean;
  onOpenFullGuide: () => void;
}

export const InstallAppModal: React.FC<InstallAppModalProps> = ({
  isOpen,
  onClose,
  onTriggerInstall,
  isInstallable,
  onOpenFullGuide,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 select-none animate-in fade-in duration-150">
      <div className="bg-slate-900 border border-slate-800 rounded-xl w-full max-w-lg overflow-hidden shadow-2xl flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/70">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-sky-500/10 border border-sky-500/30 flex items-center justify-center text-sky-400">
              <Download className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-semibold text-base text-slate-100 flex items-center gap-2">
                Install PersonaLive as Desktop App
              </h2>
              <p className="text-xs text-slate-400">
                Run in a dedicated, distraction-free window on Windows & macOS
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-200 p-1.5 rounded-lg hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-5 text-xs text-slate-300">
          {/* Main Action if browser prompt ready */}
          {isInstallable && (
            <div className="bg-sky-950/40 border border-sky-800/80 rounded-xl p-4 space-y-3">
              <div className="flex items-center gap-2 text-sky-400 font-semibold">
                <Sparkles className="w-4 h-4" />
                <span>1-Click OS Installation Ready</span>
              </div>
              <p className="text-slate-300">
                Your browser is ready to install PersonaLive Studio directly to your Windows Start Menu, Taskbar, or macOS Dock.
              </p>
              <button
                onClick={async () => {
                  const success = await onTriggerInstall();
                  if (success) onClose();
                }}
                className="w-full py-2.5 px-4 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 font-bold text-xs flex items-center justify-center gap-2 transition-all shadow-md"
              >
                <Download className="w-4 h-4" />
                <span>Install PersonaLive to Desktop Now</span>
              </button>
            </div>
          )}

          {/* Step-by-step browser instructions (Microsoft Edge / Chrome) */}
          <div className="space-y-3">
            <h3 className="font-semibold text-slate-200 flex items-center gap-2">
              <Laptop className="w-4 h-4 text-emerald-400" />
              <span>How to Install in Microsoft Edge or Google Chrome:</span>
            </h3>

            <div className="grid grid-cols-1 gap-2.5">
              <div className="bg-slate-950 p-3 rounded-lg border border-slate-800 flex items-start gap-3">
                <div className="w-5 h-5 rounded-full bg-sky-500/20 text-sky-400 font-bold flex items-center justify-center shrink-0 text-[11px]">
                  1
                </div>
                <div className="space-y-1">
                  <p className="font-medium text-slate-200">
                    Via Microsoft Edge Address Bar:
                  </p>
                  <p className="text-slate-400">
                    Look at the right side of your Edge URL bar for the <strong>App icon (⊕ or square with plus)</strong>, then click <strong>"Install PersonaLive"</strong>.
                  </p>
                </div>
              </div>

              <div className="bg-slate-950 p-3 rounded-lg border border-slate-800 flex items-start gap-3">
                <div className="w-5 h-5 rounded-full bg-sky-500/20 text-sky-400 font-bold flex items-center justify-center shrink-0 text-[11px]">
                  2
                </div>
                <div className="space-y-1">
                  <p className="font-medium text-slate-200">
                    Via Edge or Chrome Menu:
                  </p>
                  <p className="text-slate-400">
                    Click the <strong>three dots (`...`)</strong> in the top-right corner of your browser &rarr; click <strong>Apps</strong> &rarr; click <strong>"Install PersonaLive Desktop Studio"</strong>.
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Benefits summary */}
          <div className="bg-slate-950 p-3 rounded-lg border border-slate-800 space-y-1.5">
            <span className="font-semibold text-slate-300">Why install as a desktop app?</span>
            <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-400">
              <div className="flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span>Dedicated window (no tabs)</span>
              </div>
              <div className="flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span>Direct GPU acceleration</span>
              </div>
              <div className="flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span>Pinned to Windows Taskbar</span>
              </div>
              <div className="flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span>Automatic push updates</span>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 border-t border-slate-800 bg-slate-950/70 flex items-center justify-between">
          <button
            onClick={() => {
              onClose();
              onOpenFullGuide();
            }}
            className="text-xs text-sky-400 hover:text-sky-300 transition-colors flex items-center gap-1"
          >
            <span>Learn about Native Electron & GitHub CI/CD</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium transition-colors"
          >
            Got It
          </button>
        </div>
      </div>
    </div>
  );
};
