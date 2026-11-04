import React from 'react';
import { X, Film, Download, Trash2, ShieldCheck } from 'lucide-react';
import { RecordedClip } from '../types/index.ts';

interface RecordingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  recordings: RecordedClip[];
  onDeleteRecording: (id: string) => void;
}

export const RecordingsModal: React.FC<RecordingsModalProps> = ({
  isOpen,
  onClose,
  recordings,
  onDeleteRecording,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-xl w-full max-w-2xl overflow-hidden shadow-2xl flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-amber-950 border border-amber-800 flex items-center justify-center text-amber-400">
              <Film className="w-4 h-4" />
            </div>
            <div>
              <h2 className="font-semibold text-base text-slate-100">Permitted Session Recordings</h2>
              <p className="text-xs text-slate-400">
                Audited video archives with C2PA digital provenance watermarks
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
        <div className="flex-1 overflow-y-auto p-6 space-y-3">
          {recordings.length === 0 ? (
            <div className="text-center py-12 space-y-2">
              <Film className="w-10 h-10 text-slate-600 mx-auto" />
              <p className="text-slate-400 text-xs">No recordings stored yet</p>
              <p className="text-slate-500 text-[11px]">
                Click "Record" on the studio toolbar to capture the transformed output as a WebM video.
              </p>
            </div>
          ) : (
            recordings.map((rec) => (
              <div
                key={rec.id}
                className="bg-slate-950 p-4 rounded-xl border border-slate-800 flex items-center justify-between gap-4"
              >
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-lg bg-slate-900 border border-slate-800 flex items-center justify-center text-slate-400 shrink-0">
                    <Film className="w-6 h-6 text-sky-400" />
                  </div>
                  <div className="min-w-0">
                    <h4 className="font-medium text-slate-200 text-xs truncate">{rec.title}</h4>
                    <div className="flex items-center gap-2 mt-1 text-[11px] text-slate-400">
                      <span>Persona: <strong className="text-slate-300">{rec.personaUsed}</strong></span>
                      <span>•</span>
                      <span>{rec.durationSeconds}s</span>
                      <span>•</span>
                      <span>{rec.sizeMb} MB</span>
                    </div>
                    <div className="flex items-center gap-1.5 mt-1 text-[10px] text-emerald-400">
                      <ShieldCheck className="w-3 h-3" />
                      <span>C2PA Synthetic Watermark Certified</span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <a
                    href={rec.downloadUrl}
                    download={`${rec.title}.${rec.mimeType?.includes('mp4') ? 'mp4' : 'webm'}`}
                    className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-sky-300 text-xs flex items-center gap-1.5 transition-colors"
                    title="Download Permitted Recording"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Export</span>
                  </a>
                  <button
                    onClick={() => onDeleteRecording(rec.id)}
                    className="p-2 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-rose-950/30 transition-colors"
                    title="Purge recording from local ledger"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
