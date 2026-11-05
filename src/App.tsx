import React, { useState, useCallback, useEffect } from 'react';
import {
  AuthorizedPersona,
  EngineStatus,
  FacialMetrics,
  PersonaCategory,
  HeadPose,
  RecordedClip,
  TelemetryStats,
  TransformationSettings,
  UserAccount,
} from './types/index.ts';
import { INITIAL_PERSONAS } from './utils/mockPersonas.ts';
import { LoginPage } from './components/LoginPage.tsx';
import { DesktopTitlebar } from './components/DesktopTitlebar.tsx';
import { StudioViewport, RecordingResult } from './components/StudioViewport.tsx';
import { InspectorPanel } from './components/InspectorPanel.tsx';
import { TelemetryBar } from './components/TelemetryBar.tsx';
import { PersonaLibraryModal } from './components/PersonaLibraryModal.tsx';
import { AccountAuthModal } from './components/AccountAuthModal.tsx';
import { RecordingsModal } from './components/RecordingsModal.tsx';
import { VirtualCamDialog } from './components/VirtualCamDialog.tsx';
import { UserGuideModal } from './components/UserGuideModal.tsx';

const RESOLUTION_LABEL: Record<TransformationSettings['outputResolution'], string> = {
  '1080p': '1920 × 1080',
  '720p': '1280 × 720',
  '540p': '960 × 540',
};

export default function App() {
  const [isLoggedIn, setIsLoggedIn] = useState<boolean>(() => localStorage.getItem('pl_auth') === 'true');

  const [account, setAccount] = useState<UserAccount>({
    email: 'admin@personalive.ai',
    phone: '+1 (555) 839-2041',
    fullName: 'Administrator',
    tier: 'Pro Creator',
    licenseKey: 'PL-DESKTOP-PRO-9842-8819',
    expiresAt: '2027-11-01',
    isAuthenticated: true,
  });

  const [personas, setPersonas] = useState<AuthorizedPersona[]>(INITIAL_PERSONAS);

  // Who is sitting at the camera. Faces are only ever mapped onto a person of the same group.
  const [subjectCategory, setSubjectCategory] = useState<PersonaCategory>(() => {
    const saved = localStorage.getItem('pl_subject_category');
    return saved === 'women' || saved === 'men' ? saved : 'men';
  });
  const [activePersona, setActivePersonaState] = useState<AuthorizedPersona | null>(
    () => INITIAL_PERSONAS.find((p) => p.category === subjectCategory) ?? null
  );

  /** Activates a face only when it matches the person at the camera. */
  const setActivePersona = useCallback(
    (persona: AuthorizedPersona | null) => {
      if (persona && persona.category !== subjectCategory) return;
      setActivePersonaState(persona);
    },
    [subjectCategory]
  );

  const handleChangeSubjectCategory = (category: PersonaCategory) => {
    setSubjectCategory(category);
    localStorage.setItem('pl_subject_category', category);
  };

  // When the group changes, drop a mismatching active face and pick the first matching one.
  useEffect(() => {
    if (activePersona && activePersona.category === subjectCategory) return;
    setActivePersonaState(personas.find((p) => p.category === subjectCategory) ?? null);
  }, [subjectCategory, personas, activePersona]);

  const [settings, setSettings] = useState<TransformationSettings>({
    blendStrength: 92,
    temporalSmoothing: 60,
    expressionGain: 1.0,
    lipSyncSensitivity: 1.2,
    manualSmileBias: 0,
    audioReactiveLipSync: true,
    eyeGazeSync: true,
    lightingAdaptation: true,
    preserveFacialHair: true,
    showLandmarkOverlay: false,
    showBoundingBoxes: false,
    outputResolution: '720p',
    viewMode: 'split',
    virtualCameraActive: true,
  });

  const [pose, setPose] = useState<HeadPose>({ yaw: 0, pitch: 0, roll: 0 });
  const [metrics, setMetrics] = useState<FacialMetrics>({
    eyeAspectRatioLeft: 0,
    eyeAspectRatioRight: 0,
    mouthAspectRatio: 0,
    mouthWidthRatio: 1,
    eyebrowElevation: 0,
    isBlinking: false,
    isSmiling: false,
    isSpeaking: false,
    gazeX: 0,
    gazeY: 0,
  });
  const [telemetry, setTelemetry] = useState<TelemetryStats>({
    fps: 0,
    latencyMs: 0,
    frameDrops: 0,
    gpuUsagePercent: 0,
    cpuUsagePercent: 0,
    vramMb: 0,
    resolution: RESOLUTION_LABEL['720p'],
    inferenceEngine: 'MediaPipe Face Landmarker',
  });
  const [engineStatus, setEngineStatus] = useState<EngineStatus | null>(null);

  const [recordings, setRecordings] = useState<RecordedClip[]>([]);

  const [isLibraryOpen, setIsLibraryOpen] = useState(false);
  const [libraryTab, setLibraryTab] = useState<'library' | 'enroll'>('library');
  const openLibrary = (tab: 'library' | 'enroll' = 'library') => {
    setLibraryTab(tab);
    setIsLibraryOpen(true);
  };
  const [isAccountOpen, setIsAccountOpen] = useState(false);
  const [isRecordingsOpen, setIsRecordingsOpen] = useState(false);
  const [isVirtualCamOpen, setIsVirtualCamOpen] = useState(false);
  const [isGuideOpen, setIsGuideOpen] = useState(false);

  const handleLogin = (userEmail: string, userName: string) => {
    setAccount((prev) => ({ ...prev, email: userEmail, fullName: userName, isAuthenticated: true }));
    setIsLoggedIn(true);
    localStorage.setItem('pl_auth', 'true');
  };

  const handleLogout = () => {
    setIsLoggedIn(false);
    localStorage.removeItem('pl_auth');
  };

  const handleUpdateSettings = useCallback((newSettings: Partial<TransformationSettings>) => {
    setSettings((prev) => ({ ...prev, ...newSettings }));
    if (newSettings.outputResolution) {
      setTelemetry((prev) => ({ ...prev, resolution: RESOLUTION_LABEL[newSettings.outputResolution!] }));
    }
  }, []);

  // Metrics arrive every frame; only commit to React state ~10×/s to keep the UI cheap.
  const lastMetricsCommit = React.useRef(0);
  const handleMetricsUpdate = useCallback((newMetrics: FacialMetrics, newPose: HeadPose, fps: number, latency: number) => {
    const now = performance.now();
    if (now - lastMetricsCommit.current < 100) return;
    lastMetricsCommit.current = now;
    setMetrics(newMetrics);
    setPose(newPose);
    setTelemetry((prev) => (prev.fps === fps && prev.latencyMs === latency ? prev : { ...prev, fps, latencyMs: latency }));
  }, []);

  const handleStatusUpdate = useCallback((status: EngineStatus) => {
    setEngineStatus(status);
    setTelemetry((prev) => ({
      ...prev,
      inferenceEngine:
        status.backend === 'GPU'
          ? 'MediaPipe Face Landmarker · GPU'
          : status.backend === 'CPU'
            ? 'MediaPipe Face Landmarker · CPU'
            : 'MediaPipe Face Landmarker',
    }));
  }, []);

  const handleSaveRecording = ({ durationSeconds, blob, mimeType }: RecordingResult) => {
    const newClip: RecordedClip = {
      id: `rec-${Date.now()}`,
      title: `Live Session - ${activePersona ? activePersona.name : 'Transformed Persona'}`,
      timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
      durationSeconds,
      personaUsed: activePersona ? activePersona.name : 'Authorized Persona',
      sizeMb: Number((blob.size / 1_000_000).toFixed(1)),
      c2paVerified: true,
      downloadUrl: URL.createObjectURL(blob),
      mimeType,
    };
    setRecordings((prev) => [newClip, ...prev]);
  };

  const handleDeleteRecording = (id: string) => {
    setRecordings((prev) => {
      const clip = prev.find((r) => r.id === id);
      if (clip?.downloadUrl.startsWith('blob:')) URL.revokeObjectURL(clip.downloadUrl);
      return prev.filter((r) => r.id !== id);
    });
  };

  const handleAddPersona = (persona: AuthorizedPersona) => {
    setPersonas((prev) => [persona, ...prev]);
  };

  const handleDeletePersona = (id: string) => {
    setPersonas((prev) => prev.filter((p) => p.id !== id));
    if (activePersona?.id === id) {
      setActivePersonaState(personas.find((p) => p.id !== id && p.category === subjectCategory) || null);
    }
  };

  if (!isLoggedIn) {
    return <LoginPage onLogin={handleLogin} />;
  }

  const anyModalOpen = isLibraryOpen || isAccountOpen || isRecordingsOpen || isVirtualCamOpen || isGuideOpen;

  return (
    <div className="flex flex-col h-screen w-screen bg-slate-950 text-slate-100 font-sans overflow-hidden select-none">
      <DesktopTitlebar
        account={account}
        activePersona={activePersona}
        onOpenLibrary={() => setIsLibraryOpen(true)}
        onOpenAccount={() => setIsAccountOpen(true)}
        onOpenRecordings={() => setIsRecordingsOpen(true)}
        onOpenVirtualCamHelp={() => setIsVirtualCamOpen(true)}
        onOpenGuide={() => setIsGuideOpen(true)}
        onLogout={handleLogout}
        isTransforming={engineStatus?.model === 'ready' && !!engineStatus.faceDetected}
        virtualCamActive={settings.virtualCameraActive}
      />

      <main className="flex-1 flex min-h-0 overflow-hidden">
        <StudioViewport
          settings={settings}
          onUpdateSettings={handleUpdateSettings}
          activePersona={activePersona}
          onMetricsUpdate={handleMetricsUpdate}
          onStatusUpdate={handleStatusUpdate}
          onSaveRecording={handleSaveRecording}
          isModalOpen={anyModalOpen}
        />

        <InspectorPanel
          activePersona={activePersona}
          personas={personas}
          onSelectPersona={setActivePersona}
          settings={settings}
          telemetry={telemetry}
          status={engineStatus}
          subjectCategory={subjectCategory}
          onChangeSubjectCategory={handleChangeSubjectCategory}
          onUpdateSettings={handleUpdateSettings}
          onOpenLibrary={() => openLibrary('enroll')}
          onOpenConsentLogs={() => openLibrary('library')}
        />
      </main>

      <TelemetryBar
        telemetry={telemetry}
        pose={pose}
        metrics={metrics}
        status={engineStatus}
        virtualCamActive={settings.virtualCameraActive}
        onOpenVirtualCamHelp={() => setIsVirtualCamOpen(true)}
        onOpenGuide={() => setIsGuideOpen(true)}
      />

      <PersonaLibraryModal
        isOpen={isLibraryOpen}
        initialTab={libraryTab}
        subjectCategory={subjectCategory}
        onClose={() => setIsLibraryOpen(false)}
        personas={personas}
        activePersonaId={activePersona?.id || null}
        onSelectPersona={(persona) => {
          setActivePersona(persona);
          setIsLibraryOpen(false);
        }}
        onAddPersona={handleAddPersona}
        onDeletePersona={handleDeletePersona}
      />

      <AccountAuthModal
        isOpen={isAccountOpen}
        onClose={() => setIsAccountOpen(false)}
        account={account}
        onUpdateAccount={(upd) => setAccount((prev) => ({ ...prev, ...upd }))}
      />

      <RecordingsModal
        isOpen={isRecordingsOpen}
        onClose={() => setIsRecordingsOpen(false)}
        recordings={recordings}
        onDeleteRecording={handleDeleteRecording}
      />

      <VirtualCamDialog
        isOpen={isVirtualCamOpen}
        onClose={() => setIsVirtualCamOpen(false)}
        virtualCamActive={settings.virtualCameraActive}
        onToggleVirtualCam={() => handleUpdateSettings({ virtualCameraActive: !settings.virtualCameraActive })}
      />

      <UserGuideModal
        isOpen={isGuideOpen}
        onClose={() => setIsGuideOpen(false)}
        onStartDemo={() => {
          handleUpdateSettings({ viewMode: 'split' });
        }}
      />
    </div>
  );
}
