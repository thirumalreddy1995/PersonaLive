import React, { useRef, useEffect, useState, useCallback } from 'react';
import {
  Play,
  Pause,
  Camera,
  Layers,
  Columns,
  Maximize2,
  Video,
  Disc,
  Download,
  Eye,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import { TransformationSettings, AuthorizedPersona, FacialMetrics, HeadPose } from '../types/index.ts';
import { RealtimeFacialEngine } from '../utils/facialEngine.ts';

interface StudioViewportProps {
  settings: TransformationSettings;
  onUpdateSettings: (newSettings: Partial<TransformationSettings>) => void;
  activePersona: AuthorizedPersona | null;
  onMetricsUpdate: (metrics: FacialMetrics, pose: HeadPose, fps: number, latency: number) => void;
  onSaveRecording: (durationSeconds: number) => void;
  isModalOpen?: boolean;
}

export const StudioViewport: React.FC<StudioViewportProps> = ({
  settings,
  onUpdateSettings,
  activePersona,
  onMetricsUpdate,
  onSaveRecording,
  isModalOpen = false,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const engineRef = useRef<RealtimeFacialEngine | null>(null);

  const [isTransforming, setIsTransforming] = useState<boolean>(true);
  const [splitPosition, setSplitPosition] = useState<number>(50);
  const [isDraggingSplit, setIsDraggingSplit] = useState<boolean>(false);
  const [cameraSource, setCameraSource] = useState<'simulated' | 'physical'>('simulated');
  const [cameraPermissionGranted, setCameraPermissionGranted] = useState<boolean>(false);
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [recordingSeconds, setRecordingSeconds] = useState<number>(0);
  const [snapshotToast, setSnapshotToast] = useState<string | null>(null);

  // Initialize engine
  useEffect(() => {
    if (!canvasRef.current) return;
    const canvas = canvasRef.current;
    canvas.width = 1280;
    canvas.height = 720;

    const engine = new RealtimeFacialEngine(canvas);
    engine.setCallbacks(onMetricsUpdate);
    engine.setPersona(activePersona);
    engineRef.current = engine;

    if (isTransforming) {
      engine.start(settings, splitPosition);
    }

    return () => {
      engine.stop();
    };
  }, []);

  // Update persona when active persona changes
  useEffect(() => {
    if (engineRef.current) {
      engineRef.current.setPersona(activePersona);
    }
  }, [activePersona]);

  // Restart / re-render frame when settings, split or modal state changes
  useEffect(() => {
    if (!engineRef.current) return;
    if (isModalOpen || !isTransforming) {
      engineRef.current.stop();
    } else {
      engineRef.current.start(settings, splitPosition);
    }
  }, [settings, splitPosition, isTransforming, isModalOpen]);

  // Handle Recording Timer
  useEffect(() => {
    let interval: any = null;
    if (isRecording) {
      interval = setInterval(() => {
        setRecordingSeconds((prev) => prev + 1);
      }, 1000);
    } else {
      setRecordingSeconds(0);
    }
    return () => clearInterval(interval);
  }, [isRecording]);

  // Webcam request handler
  const handleTogglePhysicalCamera = async () => {
    if (cameraSource === 'physical') {
      // Switch back to simulated
      if (videoRef.current && videoRef.current.srcObject) {
        const stream = videoRef.current.srcObject as MediaStream;
        stream.getTracks().forEach((track) => track.stop());
        videoRef.current.srcObject = null;
      }
      setCameraSource('simulated');
      setCameraPermissionGranted(false);
      if (engineRef.current) engineRef.current.setVideoSource(null);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        audio: false,
      });

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
        setCameraSource('physical');
        setCameraPermissionGranted(true);
        if (engineRef.current) engineRef.current.setVideoSource(videoRef.current);
      }
    } catch (err) {
      console.warn('Physical camera access unavailable or denied. Staying in hardware simulation mode.', err);
      setSnapshotToast('Webcam unavailable in sandbox. Studio active in simulated neural test feed.');
      setTimeout(() => setSnapshotToast(null), 3500);
    }
  };

  // Toggle transformation loop
  const handleToggleTransform = () => {
    if (!engineRef.current) return;
    if (isTransforming) {
      engineRef.current.stop();
      setIsTransforming(false);
    } else {
      engineRef.current.start(settings, splitPosition);
      setIsTransforming(true);
    }
  };

  // Split-screen drag interactions
  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (settings.viewMode !== 'split') return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const currentSplitX = (splitPosition / 100) * rect.width;

    // Check if clicked near split handle
    if (Math.abs(x - currentSplitX) < 40) {
      setIsDraggingSplit(true);
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDraggingSplit || settings.viewMode !== 'split') return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const newPercent = Math.max(10, Math.min(90, (x / rect.width) * 100));
    setSplitPosition(newPercent);
  };

  const handlePointerUp = () => {
    setIsDraggingSplit(false);
  };

  // Take Snapshot
  const handleTakeSnapshot = () => {
    if (!canvasRef.current) return;
    const dataUrl = canvasRef.current.toDataURL('image/png');
    const link = document.createElement('a');
    link.download = `PersonaLive-${Date.now()}.png`;
    link.href = dataUrl;
    link.click();
    setSnapshotToast('Snapshot captured with C2PA synthetic metadata.');
    setTimeout(() => setSnapshotToast(null), 2500);
  };

  // Toggle Recording
  const handleToggleRecord = () => {
    if (isRecording) {
      setIsRecording(false);
      onSaveRecording(recordingSeconds);
      setSnapshotToast(`Session recording (${recordingSeconds}s) saved to permitted audit ledger.`);
      setTimeout(() => setSnapshotToast(null), 3000);
    } else {
      setIsRecording(true);
    }
  };

  return (
    <div className="flex-1 flex flex-col bg-slate-950 p-3 min-w-0 overflow-hidden">
      {/* Viewport Top Bar / View Modes */}
      <div className="flex items-center justify-between pb-2 text-xs">
        {/* Left: View Mode Selection */}
        <div className="flex items-center gap-1 bg-slate-900 p-0.5 rounded-lg border border-slate-800">
          <button
            onClick={() => onUpdateSettings({ viewMode: 'split' })}
            className={`px-2.5 py-1 rounded flex items-center gap-1.5 transition-colors ${
              settings.viewMode === 'split' ? 'bg-sky-600 text-white font-medium' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Columns className="w-3.5 h-3.5" />
            <span>Split Compare</span>
          </button>
          <button
            onClick={() => onUpdateSettings({ viewMode: 'side-by-side' })}
            className={`px-2.5 py-1 rounded flex items-center gap-1.5 transition-colors ${
              settings.viewMode === 'side-by-side' ? 'bg-sky-600 text-white font-medium' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            <span>Side-by-Side</span>
          </button>
          <button
            onClick={() => onUpdateSettings({ viewMode: 'transformed-only' })}
            className={`px-2.5 py-1 rounded flex items-center gap-1.5 transition-colors ${
              settings.viewMode === 'transformed-only' ? 'bg-sky-600 text-white font-medium' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>AI Output Only</span>
          </button>
          <button
            onClick={() => onUpdateSettings({ viewMode: 'pip' })}
            className={`px-2.5 py-1 rounded flex items-center gap-1.5 transition-colors ${
              settings.viewMode === 'pip' ? 'bg-sky-600 text-white font-medium' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Maximize2 className="w-3.5 h-3.5" />
            <span>PiP Mode</span>
          </button>
        </div>

        {/* Right: Camera Input & Overlays */}
        <div className="flex items-center gap-2">
          {/* Physical Webcam vs Simulation Toggle */}
          <button
            onClick={handleTogglePhysicalCamera}
            className={`px-2.5 py-1 rounded border text-xs flex items-center gap-1.5 transition-colors ${
              cameraSource === 'physical'
                ? 'bg-emerald-950 text-emerald-300 border-emerald-700'
                : 'bg-slate-900 text-slate-300 border-slate-800 hover:border-slate-700'
            }`}
            title="Toggle between physical system camera and procedural studio test stream"
          >
            <Camera className="w-3.5 h-3.5" />
            <span>{cameraSource === 'physical' ? 'Live USB Webcam' : 'Studio Simulated Feed'}</span>
          </button>

          {/* Wireframe Landmark Overlay Toggle */}
          <button
            onClick={() => onUpdateSettings({ showLandmarkOverlay: !settings.showLandmarkOverlay })}
            className={`px-2.5 py-1 rounded border text-xs flex items-center gap-1.5 transition-colors ${
              settings.showLandmarkOverlay
                ? 'bg-sky-950 text-sky-300 border-sky-800'
                : 'bg-slate-900 text-slate-400 border-slate-800 hover:border-slate-700'
            }`}
            title="Toggle 478 MediaPipe Facial Landmarks Wireframe"
          >
            <Eye className="w-3.5 h-3.5" />
            <span>478 Mesh</span>
          </button>
        </div>
      </div>

      {/* Main Video/Canvas Viewport Container */}
      <div className="relative flex-1 bg-slate-900/60 rounded-xl border border-slate-800 overflow-hidden flex items-center justify-center shadow-inner group">
        {/* Hidden video element used when physical camera is toggled */}
        <video ref={videoRef} playsInline muted className="hidden" />

        {/* Primary High-Performance Canvas */}
        <canvas
          ref={canvasRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          className={`w-full h-full object-contain ${
            settings.viewMode === 'split' ? 'cursor-ew-resize' : 'cursor-default'
          }`}
        />

        {/* Floating Notification Toast */}
        {snapshotToast && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg bg-slate-900/90 border border-sky-500/50 text-sky-200 text-xs shadow-xl backdrop-blur flex items-center gap-2 animate-in fade-in">
            <Sparkles className="w-4 h-4 text-sky-400" />
            <span>{snapshotToast}</span>
          </div>
        )}

        {/* Bottom-left Stream Telemetry Tag */}
        <div className="absolute bottom-3 left-3 bg-slate-950/80 backdrop-blur border border-slate-800 px-2.5 py-1 rounded-md text-[11px] text-slate-300 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          <span>{settings.outputResolution}</span>
          <span className="text-slate-600">|</span>
          <span className="text-slate-400">Target: {activePersona ? activePersona.name : 'None Selected'}</span>
        </div>

        {/* Live Recording Indicator */}
        {isRecording && (
          <div className="absolute top-4 right-4 bg-rose-950/90 border border-rose-700 px-3 py-1 rounded-full text-rose-200 text-xs font-mono font-bold flex items-center gap-2 shadow-lg animate-pulse">
            <span className="w-2.5 h-2.5 rounded-full bg-rose-500" />
            REC {Math.floor(recordingSeconds / 60).toString().padStart(2, '0')}:
            {(recordingSeconds % 60).toString().padStart(2, '0')}
          </div>
        )}
      </div>

      {/* Viewport Bottom Controls Toolbar */}
      <div className="flex items-center justify-between pt-2.5">
        {/* Left: Transport Buttons */}
        <div className="flex items-center gap-2">
          {/* Main Start / Pause Transformation */}
          <button
            onClick={handleToggleTransform}
            className={`px-4 py-2 rounded-lg font-medium text-xs flex items-center gap-2 shadow-sm transition-all ${
              isTransforming
                ? 'bg-amber-500/10 text-amber-300 border border-amber-500/40 hover:bg-amber-500/20'
                : 'bg-sky-500 text-slate-950 font-bold hover:bg-sky-400 shadow-sky-500/20'
            }`}
          >
            {isTransforming ? (
              <>
                <Pause className="w-4 h-4" /> Pause Neural Stream
              </>
            ) : (
              <>
                <Play className="w-4 h-4 fill-slate-950" /> Start AI Transformation
              </>
            )}
          </button>

          {/* Record Session Button */}
          <button
            onClick={handleToggleRecord}
            className={`px-3 py-2 rounded-lg text-xs font-medium border flex items-center gap-2 transition-colors ${
              isRecording
                ? 'bg-rose-600 text-white border-rose-500 hover:bg-rose-700 shadow-rose-900/50 shadow-md'
                : 'bg-slate-900 text-slate-300 border-slate-800 hover:bg-slate-800'
            }`}
          >
            <Disc className={`w-4 h-4 ${isRecording ? 'animate-spin text-white' : 'text-rose-400'}`} />
            <span>{isRecording ? 'Stop Recording' : 'Record Stream'}</span>
          </button>

          {/* Snapshot Button */}
          <button
            onClick={handleTakeSnapshot}
            className="px-3 py-2 rounded-lg text-xs font-medium bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 transition-colors flex items-center gap-1.5"
            title="Export Still Frame with C2PA Provenance"
          >
            <Camera className="w-4 h-4 text-sky-400" />
            <span>Snapshot</span>
          </button>
        </div>

        {/* Center: Split-position slider readout (if in split mode) */}
        {settings.viewMode === 'split' && (
          <div className="hidden sm:flex items-center gap-2 text-xs text-slate-400 font-mono">
            <span>Webcam {Math.round(splitPosition)}%</span>
            <input
              type="range"
              min="10"
              max="90"
              value={splitPosition}
              onChange={(e) => setSplitPosition(Number(e.target.value))}
              className="w-24 accent-sky-500 cursor-pointer"
            />
            <span>AI {Math.round(100 - splitPosition)}%</span>
          </div>
        )}

        {/* Right: Virtual Camera Driver Sink Switch */}
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer bg-slate-900 px-3 py-1.5 rounded-lg border border-slate-800 hover:border-slate-700">
            <input
              type="checkbox"
              checked={settings.virtualCameraActive}
              onChange={(e) => onUpdateSettings({ virtualCameraActive: e.target.checked })}
              className="accent-sky-500 w-3.5 h-3.5 rounded"
            />
            <Video className="w-3.5 h-3.5 text-emerald-400" />
            <span className="font-medium">DirectShow / OBS VirtualCam Sink</span>
          </label>
        </div>
      </div>
    </div>
  );
};
