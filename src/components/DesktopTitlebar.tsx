import React, { useState } from 'react';
import { Camera, ShieldCheck, UserCheck, Video, Settings as SettingsIcon, Film, Sparkles, BookOpen, LogOut, Download, RefreshCw, Monitor } from 'lucide-react';
import { UserAccount, AuthorizedPersona } from '../types/index.ts';
import { usePWAInstall } from '../hooks/usePWAInstall.ts';
import { InstallAppModal } from './InstallAppModal.tsx';

interface DesktopTitlebarProps {
  account: UserAccount;
  activePersona: AuthorizedPersona | null;
  onOpenLibrary: () => void;
  onOpenAccount: () => void;
  onOpenRecordings: () => void;
  onOpenVirtualCamHelp: () => void;
  onOpenGuide: () => void;
  onLogout: () => void;
  isTransforming: boolean;
  virtualCamActive: boolean;
}

export const DesktopTitlebar: React.FC<DesktopTitlebarProps> = ({
  account,
  activePersona,
  onOpenLibrary,
  onOpenAccount,
  onOpenRecordings,
  onOpenVirtualCamHelp,
  onOpenGuide,
  onLogout,
  isTransforming,
  virtualCamActive,
}) => {
  const { isInstallable, isInstalled, hasUpdate, install, applyUpdate } = usePWAInstall();
  const [showInstallModal, setShowInstallModal] = useState(false);

  return (
    <header className="h-11 bg-slate-950 border-b border-slate-800 flex items-center justify-between px-3 select-none z-30">
      {/* Left: Window Controls (macOS/Windows style) & App Title */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5 mr-2">
          <div className="w-3 h-3 rounded-full bg-rose-500/80 hover:bg-rose-500 cursor-pointer transition-colors" title="Close Studio" />
          <div className="w-3 h-3 rounded-full bg-amber-500/80 hover:bg-amber-500 cursor-pointer transition-colors" title="Minimize" />
          <div className="w-3 h-3 rounded-full bg-emerald-500/80 hover:bg-emerald-500 cursor-pointer transition-colors" title="Maximize" />
        </div>

        <div className="h-4 w-px bg-slate-800" />

        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded bg-sky-500 flex items-center justify-center text-slate-950 font-black text-xs shadow-sm">
            PL
          </div>
          <span className="font-semibold text-sm tracking-tight text-slate-100 flex items-center gap-2">
            PersonaLive Desktop
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700">
              v2.5.0 · {__PL_BUILD_ID__.slice(0, 7)}
            </span>
          </span>
        </div>

        {/* Live Transformation Status Badge */}
        <div className="ml-3 hidden sm:flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full border ${
              isTransforming
                ? 'bg-sky-950/80 text-sky-400 border-sky-800 animate-pulse'
                : 'bg-slate-900 text-slate-400 border-slate-800'
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${isTransforming ? 'bg-sky-400' : 'bg-slate-500'}`} />
            {isTransforming ? 'Face Tracking Live' : 'Waiting for Face'}
          </span>

          {virtualCamActive && (
            <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-emerald-950/80 text-emerald-400 border border-emerald-800">
              <Video className="w-3 h-3" /> Virtual Camera On
            </span>
          )}

          {isInstalled && (
            <span className="hidden xl:inline-flex items-center gap-1 text-[11px] font-medium text-emerald-400 bg-emerald-950/60 px-2 py-0.5 rounded border border-emerald-800/80">
              <Monitor className="w-3 h-3" /> Desktop App
            </span>
          )}
        </div>
      </div>

      {/* Right: Quick Action Controls */}
      <div className="flex items-center gap-2">
        {/* New Version Auto-Update Banner (triggers when push detected) */}
        {hasUpdate && (
          <button
            onClick={applyUpdate}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs shadow-md transition-all animate-bounce"
            title="A new update was pushed! Click to restart and apply."
          >
            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            <span>Update Ready — Restart</span>
          </button>
        )}

        {/* Desktop PWA Install Button - Always accessible in browser mode */}
        {!isInstalled && (
          <button
            onClick={async () => {
              if (isInstallable) {
                const accepted = await install();
                if (!accepted) setShowInstallModal(true);
              } else {
                setShowInstallModal(true);
              }
            }}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-sky-500 hover:bg-sky-400 text-slate-950 font-bold text-xs shadow-md transition-all shrink-0"
            title="Install PersonaLive as a Standalone Desktop Application"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Install Desktop App</span>
          </button>
        )}

        {/* Active Persona Pill */}
        <button
          onClick={onOpenLibrary}
          className="flex items-center gap-2 px-2.5 py-1 rounded bg-slate-900 hover:bg-slate-800 border border-slate-800 text-xs text-slate-200 transition-colors"
          title="Switch or Upload Authorized Persona"
        >
          <Sparkles className="w-3.5 h-3.5 text-sky-400" />
          <span className="max-w-[130px] truncate font-medium">
            {activePersona ? activePersona.name : 'Select Persona'}
          </span>
          <span className="text-[10px] text-sky-400 font-mono">Library</span>
        </button>

        {/* Virtual Camera Setup button */}
        <button
          onClick={onOpenVirtualCamHelp}
          className="px-2.5 py-1 rounded bg-slate-900 hover:bg-slate-800 border border-slate-800 text-xs text-slate-300 transition-colors flex items-center gap-1.5"
          title="Virtual Camera Integration (Zoom, OBS, Teams)"
        >
          <Video className="w-3.5 h-3.5 text-emerald-400" />
          <span className="hidden md:inline">Virtual Cam</span>
        </button>

        {/* Saved Recordings */}
        <button
          onClick={onOpenRecordings}
          className="px-2.5 py-1 rounded bg-slate-900 hover:bg-slate-800 border border-slate-800 text-xs text-slate-300 transition-colors flex items-center gap-1.5"
          title="View Permitted Recordings"
        >
          <Film className="w-3.5 h-3.5 text-amber-400" />
          <span className="hidden md:inline">Recordings</span>
        </button>

        {/* User Guide & Manual */}
        <button
          onClick={onOpenGuide}
          className="px-2.5 py-1 rounded bg-sky-950/70 hover:bg-sky-900 border border-sky-800/80 text-xs text-sky-300 transition-colors flex items-center gap-1.5"
          title="End-to-End User & Developer Guide"
        >
          <BookOpen className="w-3.5 h-3.5 text-sky-400" />
          <span className="font-medium">User Guide</span>
        </button>

        {/* Account / Subscription Pill */}
        <button
          onClick={onOpenAccount}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-slate-900 hover:bg-slate-800 border border-slate-800 text-xs text-slate-200 transition-colors"
          title="Account & Subscription"
        >
          <ShieldCheck className="w-3.5 h-3.5 text-sky-400" />
          <span className="hidden sm:inline font-medium">{account.fullName}</span>
        </button>

        {/* Sign Out Button */}
        <button
          onClick={onLogout}
          className="p-1 rounded bg-slate-900 hover:bg-rose-950/40 hover:text-rose-400 border border-slate-800 text-xs text-slate-400 transition-colors flex items-center gap-1"
          title="Sign Out"
        >
          <LogOut className="w-3.5 h-3.5" />
          <span className="hidden lg:inline pr-1">Exit</span>
        </button>
      </div>

      <InstallAppModal
        isOpen={showInstallModal}
        onClose={() => setShowInstallModal(false)}
        onTriggerInstall={install}
        isInstallable={isInstallable}
        onOpenFullGuide={onOpenGuide}
      />
    </header>
  );
};
