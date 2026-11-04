import React, { useRef, useEffect, useState, useCallback } from 'react';
import {
  Play,
  Pause,
  Camera,
  CameraOff,
  Layers,
  Columns,
  Maximize2,
  Video,
  Disc,
  Eye,
  Sparkles,
  Loader2,
  AlertTriangle,
  RefreshCw,
  ScanFace,
  UserRound,
  X,
} from 'lucide-react';
import { TransformationSettings, AuthorizedPersona, FacialMetrics, HeadPose, EngineStatus } from '../types/index.ts';
import { RealtimeFacialEngine } from '../utils/facialEngine.ts';

export interface RecordingResult {
  durationSeconds: number;
  blob: Blob;
  mimeType: string;
}

interface StudioViewportProps {
  settings: TransformationSettings;
  onUpdateSettings: (newSettings: Partial<TransformationSettings>) => void;
  activePersona: AuthorizedPersona | null;
  onMetricsUpdate: (metrics: FacialMetrics, pose: HeadPose, fps: number, latency: number) => void;
  onStatusUpdate: (status: EngineStatus) => void;
  onSaveRecording: (result: RecordingResult) => void;
  isModalOpen?: boolean;
}

type CameraState = 'off' | 'starting' | 'on' | 'denied';

export const StudioViewport: React.FC<StudioViewportProps> = ({
  settings,
  onUpdateSettings,
  activePersona,
  onMetricsUpdate,
  onStatusUpdate,
  onSaveRecording,
  isModalOpen = false,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const engineRef = useRef<RealtimeFacialEngine | null>(null);
  const metricsCbRef = useRef(onMetricsUpdate);
  const statusCbRef = useRef(onStatusUpdate);
  metricsCbRef.current = onMetricsUpdate;
  statusCbRef.current = onStatusUpdate;

  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [isTransforming, setIsTransforming] = useState<boolean>(true);
  const [splitPosition, setSplitPosition] = useState<number>(50);
  const [isDraggingSplit, setIsDraggingSplit] = useState<boolean>(false);
  const [cameraState, setCameraState] = useState<CameraState>('off');
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [demoBannerDismissed, setDemoBannerDismissed] = useState<boolean>(false);
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [recordingSeconds, setRecordingSeconds] = useState<number>(0);
  const [toast, setToast] = useState<{ text: string; tone: 'info' | 'error' } | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordChunksRef = useRef<Blob[]>([]);
  const recordStartRef = useRef<number>(0);

  const toastTimerRef = useRef<number | null>(null);
  const showToast = useCallback((text: string, tone: 'info' | 'error' = 'info', ms = 3000) => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    setToast({ text, tone });
    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = null;
      setToast(null);
    }, ms);
  }, []);
  useEffect(
    () => () => {
      if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    },
    []
  );

  // ---------------------------------------------------------------------------------------
  // Engine lifecycle
  // ---------------------------------------------------------------------------------------
  useEffect(() => {
    if (!canvasRef.current) return;
    const engine = new RealtimeFacialEngine(canvasRef.current, settings);
    engineRef.current = engine;
    engine.setCallbacks(
      (m, p, fps, latency) => metricsCbRef.current(m, p, fps, latency),
      (s) => {
        setStatus(s);
        statusCbRef.current(s);
      }
    );
    engine.loadDemoSubject();
    // Persona, settings and split position are pushed by their own effects below, which run
    // right after this one on mount.
    void engine.init();
    engine.start();

    return () => {
      engine.dispose();
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    engineRef.current?.setPersona(activePersona);
  }, [activePersona]);

  useEffect(() => {
    engineRef.current?.updateSettings(settings);
  }, [settings]);

  useEffect(() => {
    engineRef.current?.setSplitPosition(splitPosition);
  }, [splitPosition]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    if (isModalOpen || !isTransforming) engine.stop();
    else engine.start();
  }, [isTransforming, isModalOpen]);

  // Recording timer
  useEffect(() => {
    if (!isRecording) {
      setRecordingSeconds(0);
      return;
    }
    const interval = window.setInterval(() => {
      setRecordingSeconds(Math.round((performance.now() - recordStartRef.current) / 1000));
    }, 500);
    return () => window.clearInterval(interval);
  }, [isRecording]);

  // ---------------------------------------------------------------------------------------
  // Camera
  // ---------------------------------------------------------------------------------------
  const stopCamera = useCallback(() => {
    const video = videoRef.current;
    if (video?.srcObject) {
      (video.srcObject as MediaStream).getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    }
    engineRef.current?.setVideoSource(null);
    setCameraState('off');
  }, []);

  const startCamera = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraState('denied');
      setCameraError('This browser cannot access cameras. Try Chrome, Edge or the desktop app.');
      return;
    }
    setCameraState('starting');
    setCameraError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, facingMode: 'user' },
        audio: false,
      });
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play();
      engineRef.current?.setVideoSource(video);
      setCameraState('on');
      setDemoBannerDismissed(true);
      stream.getVideoTracks()[0]?.addEventListener('ended', () => stopCamera());
    } catch (err) {
      const name = err instanceof DOMException ? err.name : '';
      const message =
        name === 'NotAllowedError'
          ? 'Camera permission was denied. Allow camera access in your browser and try again.'
          : name === 'NotFoundError'
            ? 'No camera was found on this computer.'
            : name === 'NotReadableError'
              ? 'The camera is in use by another application.'
              : 'Could not start the camera.';
      setCameraState('denied');
      setCameraError(message);
      showToast(message, 'error', 4500);
    }
  }, [showToast, stopCamera]);

  useEffect(() => () => stopCamera(), [stopCamera]);

  // ---------------------------------------------------------------------------------------
  // Split handle drag
  // ---------------------------------------------------------------------------------------
  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (settings.viewMode !== 'split') return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const currentSplitX = (splitPosition / 100) * rect.width;
    if (Math.abs(x - currentSplitX) < 40) {
      setIsDraggingSplit(true);
      e.currentTarget.setPointerCapture(e.pointerId);
    }
  };
  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDraggingSplit || settings.viewMode !== 'split') return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    setSplitPosition(Math.max(10, Math.min(90, (x / rect.width) * 100)));
  };
  const handlePointerUp = () => setIsDraggingSplit(false);

  // ---------------------------------------------------------------------------------------
  // Snapshot & recording
  // ---------------------------------------------------------------------------------------
  const handleTakeSnapshot = () => {
    if (!canvasRef.current) return;
    const link = document.createElement('a');
    link.download = `PersonaLive-${Date.now()}.png`;
    link.href = canvasRef.current.toDataURL('image/png');
    link.click();
    showToast('Snapshot saved with the AI-transformed watermark.');
  };

  const handleToggleRecord = () => {
    if (isRecording) {
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas || typeof MediaRecorder === 'undefined') {
      showToast('Recording is not supported in this browser.', 'error');
      return;
    }
    const mimeType =
      ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find((m) =>
        MediaRecorder.isTypeSupported(m)
      ) ?? '';
    try {
      const stream = canvas.captureStream(30);
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 6_000_000 } : undefined);
      recordChunksRef.current = [];
      let failed = false;
      const releaseRecorder = () => {
        stream.getTracks().forEach((t) => t.stop());
        recorderRef.current = null;
        setIsRecording(false);
      };
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordChunksRef.current.push(e.data);
      };
      recorder.onerror = (event) => {
        // An encoder failure also fires "stop"; flag it so no partial clip is saved.
        failed = true;
        const error = (event as Event & { error?: unknown }).error;
        console.error('Recording failed', error ?? event);
        recordChunksRef.current = [];
        releaseRecorder();
        showToast('Recording stopped because the video encoder reported an error.', 'error', 4500);
      };
      recorder.onstop = () => {
        if (failed) return;
        releaseRecorder();
        const blob = new Blob(recordChunksRef.current, { type: recorder.mimeType || mimeType || 'video/webm' });
        const duration = Math.max(1, Math.round((performance.now() - recordStartRef.current) / 1000));
        onSaveRecording({ durationSeconds: duration, blob, mimeType: blob.type });
        showToast(`Recording saved (${duration}s). Open Recordings to download it.`);
      };
      recorder.start(1000);
      recorderRef.current = recorder;
      recordStartRef.current = performance.now();
      setIsRecording(true);
    } catch (err) {
      console.error(err);
      showToast('Could not start recording.', 'error');
    }
  };

  // ---------------------------------------------------------------------------------------
  // Derived UI state
  // ---------------------------------------------------------------------------------------
  const modelLoading = !status || status.model === 'idle' || status.model === 'loading';
  const modelError = status?.model === 'error';
  const trackingReady = status?.model === 'ready';
  const hasSource = status?.source === 'webcam' || status?.source === 'demo';
  const showDemoBanner = trackingReady && status?.source === 'demo' && cameraState !== 'on' && !demoBannerDismissed;
  const faceMissing = trackingReady && hasSource && !status?.faceDetected;
  const personaNotice =
    status?.persona === 'preparing'
      ? { tone: 'info' as const, text: 'Analysing persona photo…' }
      : status?.persona === 'no-face' || status?.persona === 'error'
        ? { tone: 'error' as const, text: status.personaMessage ?? 'Persona photo could not be used.' }
        : status?.persona === 'none'
          ? { tone: 'info' as const, text: 'Choose a face on the right to start the transformation.' }
          : null;

  const viewModes: Array<{ id: TransformationSettings['viewMode']; label: string; icon: React.ReactNode }> = [
    { id: 'split', label: 'Split Compare', icon: <Columns className="w-3.5 h-3.5" /> },
    { id: 'side-by-side', label: 'Side-by-Side', icon: <Layers className="w-3.5 h-3.5" /> },
    { id: 'transformed-only', label: 'AI Output Only', icon: <Sparkles className="w-3.5 h-3.5" /> },
    { id: 'pip', label: 'PiP Mode', icon: <Maximize2 className="w-3.5 h-3.5" /> },
  ];

  return (
    <div className="flex-1 flex flex-col bg-slate-950 p-3 min-w-0 overflow-hidden">
      {/* Viewport Top Bar / View Modes */}
      <div className="flex items-center justify-between pb-2 text-xs gap-2">
        <div className="flex items-center gap-1 bg-slate-900 p-0.5 rounded-lg border border-slate-800">
          {viewModes.map((m) => (
            <button
              key={m.id}
              onClick={() => onUpdateSettings({ viewMode: m.id })}
              className={`px-2.5 py-1 rounded flex items-center gap-1.5 transition-colors ${
                settings.viewMode === m.id ? 'bg-sky-600 text-white font-medium' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {m.icon}
              <span>{m.label}</span>
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          {/* Webcam toggle */}
          <button
            onClick={cameraState === 'on' ? stopCamera : startCamera}
            disabled={cameraState === 'starting'}
            className={`px-3 py-1 rounded border text-xs flex items-center gap-1.5 transition-colors font-medium ${
              cameraState === 'on'
                ? 'bg-emerald-950 text-emerald-300 border-emerald-700 hover:bg-emerald-900'
                : cameraState === 'denied'
                  ? 'bg-rose-950/60 text-rose-300 border-rose-800 hover:bg-rose-950'
                  : 'bg-sky-500 text-slate-950 border-sky-400 hover:bg-sky-400 shadow-sm shadow-sky-500/30'
            }`}
            title={cameraError ?? (cameraState === 'on' ? 'Turn the webcam off and return to the demo subject' : 'Use your webcam as the live source')}
          >
            {cameraState === 'starting' ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : cameraState === 'on' ? (
              <CameraOff className="w-3.5 h-3.5" />
            ) : (
              <Camera className="w-3.5 h-3.5" />
            )}
            <span>
              {cameraState === 'on'
                ? 'Webcam Live · Turn Off'
                : cameraState === 'starting'
                  ? 'Starting Camera…'
                  : cameraState === 'denied'
                    ? 'Retry Webcam'
                    : 'Turn On My Webcam'}
            </span>
          </button>

          {/* Source indicator */}
          <span className="hidden lg:inline-flex items-center gap-1.5 px-2 py-1 rounded border border-slate-800 bg-slate-900 text-slate-400">
            <UserRound className="w-3.5 h-3.5" />
            {status?.source === 'webcam' ? 'Source: Your Webcam' : status?.source === 'demo' ? 'Source: Demo Subject' : 'No Source'}
          </span>

          {/* Landmark mesh toggle */}
          <button
            onClick={() => onUpdateSettings({ showLandmarkOverlay: !settings.showLandmarkOverlay })}
            className={`px-2.5 py-1 rounded border text-xs flex items-center gap-1.5 transition-colors ${
              settings.showLandmarkOverlay
                ? 'bg-sky-950 text-sky-300 border-sky-800'
                : 'bg-slate-900 text-slate-400 border-slate-800 hover:border-slate-700'
            }`}
            title="Show the live 478-point face mesh and head orientation"
          >
            <Eye className="w-3.5 h-3.5" />
            <span>478 Mesh</span>
          </button>
        </div>
      </div>

      {/* Main Canvas Viewport */}
      <div className="relative flex-1 bg-slate-900/60 rounded-xl border border-slate-800 overflow-hidden flex items-center justify-center shadow-inner">
        <video ref={videoRef} playsInline muted className="hidden" />

        <canvas
          ref={canvasRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          className={`w-full h-full object-contain ${settings.viewMode === 'split' ? 'cursor-ew-resize' : 'cursor-default'}`}
        />

        {/* Model loading card */}
        {modelLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm">
            <div className="w-80 rounded-2xl border border-slate-800 bg-slate-900/95 p-5 shadow-2xl space-y-3">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-sky-950 border border-sky-800 flex items-center justify-center">
                  <ScanFace className="w-5 h-5 text-sky-400" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-slate-100">Preparing face tracking</p>
                  <p className="text-[11px] text-slate-400">{status?.modelMessage ?? 'Starting…'}</p>
                </div>
              </div>
              <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
                <div
                  className="h-full bg-sky-500 transition-all duration-300"
                  style={{ width: `${Math.round((status?.modelProgress ?? 0) * 100)}%` }}
                />
              </div>
              <p className="text-[10px] text-slate-500">
                The 478-point landmark model is downloaded once and cached on this device. Everything runs locally.
              </p>
            </div>
          </div>
        )}

        {/* Model error card */}
        {modelError && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm">
            <div className="w-96 rounded-2xl border border-rose-900 bg-slate-900/95 p-5 shadow-2xl space-y-3">
              <div className="flex items-center gap-3">
                <AlertTriangle className="w-6 h-6 text-rose-400 shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-slate-100">Face tracking could not start</p>
                  <p className="text-[11px] text-slate-400">{status?.modelMessage}</p>
                </div>
              </div>
              <p className="text-[11px] text-slate-500">
                The first launch needs an internet connection to download the landmark model (3.7 MB). After that it works offline.
              </p>
              <button
                onClick={() => void engineRef.current?.init()}
                className="w-full py-2 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 text-xs font-bold flex items-center justify-center gap-2"
              >
                <RefreshCw className="w-3.5 h-3.5" /> Try Again
              </button>
            </div>
          </div>
        )}

        {/* Demo banner */}
        {showDemoBanner && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 max-w-[92%] px-3 py-2 rounded-xl bg-slate-900/95 border border-sky-500/40 text-slate-200 text-xs shadow-xl backdrop-blur flex items-center gap-3">
            <Sparkles className="w-4 h-4 text-sky-400 shrink-0" />
            <span>
              You're watching the <strong className="text-sky-300">demo subject</strong>. Turn on your webcam to transform your own face in real time.
            </span>
            <button
              onClick={startCamera}
              className="px-2.5 py-1 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 font-bold flex items-center gap-1.5 shrink-0"
            >
              <Camera className="w-3.5 h-3.5" /> Turn On Webcam
            </button>
            <button
              onClick={() => setDemoBannerDismissed(true)}
              className="p-1 rounded hover:bg-slate-800 text-slate-400 shrink-0"
              title="Dismiss"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Toast */}
        {toast && (
          <div
            className={`absolute top-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg bg-slate-900/95 border text-xs shadow-xl backdrop-blur flex items-center gap-2 ${
              toast.tone === 'error' ? 'border-rose-500/50 text-rose-200' : 'border-sky-500/50 text-sky-200'
            }`}
          >
            {toast.tone === 'error' ? <AlertTriangle className="w-4 h-4 text-rose-400" /> : <Sparkles className="w-4 h-4 text-sky-400" />}
            <span>{toast.text}</span>
          </div>
        )}

        {/* Bottom-centre guidance pills */}
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1.5 pointer-events-none">
          {faceMissing && !modelLoading && (
            <span className="px-3 py-1 rounded-full bg-amber-950/90 border border-amber-700/70 text-amber-200 text-[11px] flex items-center gap-1.5">
              <ScanFace className="w-3.5 h-3.5" /> Looking for a face — centre yourself in the frame with good lighting
            </span>
          )}
          {personaNotice && !modelLoading && (
            <span
              className={`px-3 py-1 rounded-full border text-[11px] flex items-center gap-1.5 ${
                personaNotice.tone === 'error'
                  ? 'bg-rose-950/90 border-rose-700/70 text-rose-200'
                  : 'bg-slate-900/90 border-slate-700 text-slate-300'
              }`}
            >
              {personaNotice.tone === 'error' ? <AlertTriangle className="w-3.5 h-3.5" /> : <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {personaNotice.text}
            </span>
          )}
        </div>

        {/* Bottom-left status tag */}
        <div className="absolute bottom-3 left-3 bg-slate-950/80 backdrop-blur border border-slate-800 px-2.5 py-1 rounded-md text-[11px] text-slate-300 flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${status?.faceDetected ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500'}`} />
          <span>{settings.outputResolution}</span>
          <span className="text-slate-600">|</span>
          <span className="text-slate-400">Persona: {activePersona ? activePersona.name : 'None selected'}</span>
        </div>

        {/* Recording indicator */}
        {isRecording && (
          <div className="absolute top-4 right-4 bg-rose-950/90 border border-rose-700 px-3 py-1 rounded-full text-rose-200 text-xs font-mono font-bold flex items-center gap-2 shadow-lg animate-pulse">
            <span className="w-2.5 h-2.5 rounded-full bg-rose-500" />
            REC {Math.floor(recordingSeconds / 60).toString().padStart(2, '0')}:
            {(recordingSeconds % 60).toString().padStart(2, '0')}
          </div>
        )}

        {!isTransforming && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-950/40 pointer-events-none">
            <span className="px-4 py-2 rounded-full bg-slate-900/90 border border-amber-500/40 text-amber-200 text-xs font-medium">
              Paused — press Resume to continue
            </span>
          </div>
        )}
      </div>

      {/* Bottom Toolbar */}
      <div className="flex items-center justify-between pt-2.5 gap-2">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsTransforming((v) => !v)}
            className={`px-4 py-2 rounded-lg font-medium text-xs flex items-center gap-2 shadow-sm transition-all ${
              isTransforming
                ? 'bg-amber-500/10 text-amber-300 border border-amber-500/40 hover:bg-amber-500/20'
                : 'bg-sky-500 text-slate-950 font-bold hover:bg-sky-400 shadow-sky-500/20'
            }`}
          >
            {isTransforming ? (
              <>
                <Pause className="w-4 h-4" /> Pause
              </>
            ) : (
              <>
                <Play className="w-4 h-4 fill-slate-950" /> Resume Transformation
              </>
            )}
          </button>

          <button
            onClick={handleToggleRecord}
            className={`px-3 py-2 rounded-lg text-xs font-medium border flex items-center gap-2 transition-colors ${
              isRecording
                ? 'bg-rose-600 text-white border-rose-500 hover:bg-rose-700 shadow-rose-900/50 shadow-md'
                : 'bg-slate-900 text-slate-300 border-slate-800 hover:bg-slate-800'
            }`}
            title="Record the output canvas to a WebM video"
          >
            <Disc className={`w-4 h-4 ${isRecording ? 'animate-spin text-white' : 'text-rose-400'}`} />
            <span>{isRecording ? 'Stop Recording' : 'Record'}</span>
          </button>

          <button
            onClick={handleTakeSnapshot}
            className="px-3 py-2 rounded-lg text-xs font-medium bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 transition-colors flex items-center gap-1.5"
            title="Save a PNG of the current frame"
          >
            <Camera className="w-4 h-4 text-sky-400" />
            <span>Snapshot</span>
          </button>
        </div>

        {settings.viewMode === 'split' && (
          <div className="hidden sm:flex items-center gap-2 text-xs text-slate-400 font-mono">
            <span>Original {Math.round(splitPosition)}%</span>
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

        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer bg-slate-900 px-3 py-1.5 rounded-lg border border-slate-800 hover:border-slate-700">
            <input
              type="checkbox"
              checked={settings.virtualCameraActive}
              onChange={(e) => onUpdateSettings({ virtualCameraActive: e.target.checked })}
              className="accent-sky-500 w-3.5 h-3.5 rounded"
            />
            <Video className="w-3.5 h-3.5 text-emerald-400" />
            <span className="font-medium">Virtual Camera Output</span>
          </label>
        </div>
      </div>
    </div>
  );
};
