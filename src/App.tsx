import React, { useState, useCallback } from 'react';
import {
  AuthorizedPersona,
  FacialMetrics,
  HeadPose,
  RecordedClip,
  TelemetryStats,
  TransformationSettings,
  UserAccount,
} from './types/index.ts';
import { INITIAL_PERSONAS } from './utils/mockPersonas.ts';
import { LoginPage } from './components/LoginPage.tsx';
import { DesktopTitlebar } from './components/DesktopTitlebar.tsx';
import { StudioViewport } from './components/StudioViewport.tsx';
import { InspectorPanel } from './components/InspectorPanel.tsx';
import { TelemetryBar } from './components/TelemetryBar.tsx';
import { PersonaLibraryModal } from './components/PersonaLibraryModal.tsx';
import { AccountAuthModal } from './components/AccountAuthModal.tsx';
import { RecordingsModal } from './components/RecordingsModal.tsx';
import { VirtualCamDialog } from './components/VirtualCamDialog.tsx';
import { UserGuideModal } from './components/UserGuideModal.tsx';

export default function App() {
  // Authentication state (default false to show login page first as requested)
  const [isLoggedIn, setIsLoggedIn] = useState<boolean>(() => {
    return localStorage.getItem('pl_auth') === 'true';
  });

  // User Account state
  const [account, setAccount] = useState<UserAccount>({
    email: 'admin@personalive.ai',
    phone: '+1 (555) 839-2041',
    fullName: 'Administrator',
    tier: 'Pro Creator',
    licenseKey: 'PL-DESKTOP-PRO-9842-8819',
    expiresAt: '2027-11-01',
    isAuthenticated: true,
  });

  // Authorized Personas Catalog
  const [personas, setPersonas] = useState<AuthorizedPersona[]>(INITIAL_PERSONAS);
  const [activePersona, setActivePersona] = useState<AuthorizedPersona | null>(INITIAL_PERSONAS[0]);

  // Transformation Settings
  const [settings, setSettings] = useState<TransformationSettings>({
    blendStrength: 90,
    temporalSmoothing: 85,
    expressionGain: 1.1,
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
    watermarkMandatory: true,
  });

  // Real-Time Kinematics & Performance Telemetry
  const [pose, setPose] = useState<HeadPose>({ yaw: 0, pitch: 0, roll: 0 });
  const [metrics, setMetrics] = useState<FacialMetrics>({
    eyeAspectRatioLeft: 0.31,
    eyeAspectRatioRight: 0.31,
    mouthAspectRatio: 0.14,
    mouthWidthRatio: 1.0,
    eyebrowElevation: 0.5,
    isBlinking: false,
    isSmiling: false,
    isSpeaking: false,
    gazeX: 0,
    gazeY: 0,
  });
  const [telemetry, setTelemetry] = useState<TelemetryStats>({
    fps: 31.8,
    latencyMs: 27.4,
    frameDrops: 0,
    gpuUsagePercent: 36,
    cpuUsagePercent: 14,
    vramMb: 1420,
    resolution: '1280 × 720',
    inferenceEngine: 'ONNX DirectML (FP16)',
  });

  // Recorded Sessions Catalog
  const [recordings, setRecordings] = useState<RecordedClip[]>([
    {
      id: 'rec-1',
      title: 'Studio Keynote Rehearsal - Sarah Chen Persona',
      timestamp: '2026-11-02 18:22:10',
      durationSeconds: 45,
      personaUsed: 'Dr. Sarah Chen',
      sizeMb: 18.4,
      c2paVerified: true,
      downloadUrl: '#',
    },
  ]);

  // Modal Dialog Open States
  const [isLibraryOpen, setIsLibraryOpen] = useState(false);
  const [isAccountOpen, setIsAccountOpen] = useState(false);
  const [isRecordingsOpen, setIsRecordingsOpen] = useState(false);
  const [isVirtualCamOpen, setIsVirtualCamOpen] = useState(false);
  const [isGuideOpen, setIsGuideOpen] = useState(false);

  // Auth Handlers
  const handleLogin = (userEmail: string, userName: string) => {
    setAccount((prev) => ({
      ...prev,
      email: userEmail,
      fullName: userName,
      isAuthenticated: true,
    }));
    setIsLoggedIn(true);
    localStorage.setItem('pl_auth', 'true');
  };

  const handleLogout = () => {
    setIsLoggedIn(false);
    localStorage.removeItem('pl_auth');
  };

  // Handlers
  const handleUpdateSettings = useCallback((newSettings: Partial<TransformationSettings>) => {
    setSettings((prev) => ({ ...prev, ...newSettings }));
  }, []);

  const handleMetricsUpdate = useCallback(
    (newMetrics: FacialMetrics, newPose: HeadPose, fps: number, latency: number) => {
      setMetrics(newMetrics);
      setPose(newPose);
      setTelemetry((prev) => ({
        ...prev,
        fps,
        latencyMs: latency,
      }));
    },
    []
  );

  const handleSaveRecording = (durationSeconds: number) => {
    const newClip: RecordedClip = {
      id: `rec-${Date.now()}`,
      title: `Live Session - ${activePersona ? activePersona.name : 'Transformed Persona'}`,
      timestamp: new Date().toISOString().replace('T', ' ').slice(0, 19),
      durationSeconds: Math.max(durationSeconds, 3),
      personaUsed: activePersona ? activePersona.name : 'Authorized Persona',
      sizeMb: Number(((durationSeconds * 0.42) || 1.8).toFixed(1)),
      c2paVerified: true,
      downloadUrl: '#',
    };
    setRecordings((prev) => [newClip, ...prev]);
  };

  const handleAddPersona = (persona: AuthorizedPersona) => {
    setPersonas((prev) => [persona, ...prev]);
  };

  const handleDeletePersona = (id: string) => {
    setPersonas((prev) => prev.filter((p) => p.id !== id));
    if (activePersona?.id === id) {
      setActivePersona(personas.find((p) => p.id !== id) || null);
    }
  };

  // If user is not logged in, render the clean login screen with default credentials
  if (!isLoggedIn) {
    return <LoginPage onLogin={handleLogin} />;
  }

  return (
    <div className="flex flex-col h-screen w-screen bg-slate-950 text-slate-100 font-sans overflow-hidden select-none">
      {/* 1. Desktop Title Bar */}
      <DesktopTitlebar
        account={account}
        activePersona={activePersona}
        onOpenLibrary={() => setIsLibraryOpen(true)}
        onOpenAccount={() => setIsAccountOpen(true)}
        onOpenRecordings={() => setIsRecordingsOpen(true)}
        onOpenVirtualCamHelp={() => setIsVirtualCamOpen(true)}
        onOpenGuide={() => setIsGuideOpen(true)}
        onLogout={handleLogout}
        isTransforming={true}
        virtualCamActive={settings.virtualCameraActive}
      />

      {/* 2. Main Studio Workstation Body */}
      <main className="flex-1 flex min-h-0 overflow-hidden">
        {/* Center: Live Camera & Transformed Viewport */}
        <StudioViewport
          settings={settings}
          onUpdateSettings={handleUpdateSettings}
          activePersona={activePersona}
          onMetricsUpdate={handleMetricsUpdate}
          onSaveRecording={handleSaveRecording}
          isModalOpen={isLibraryOpen || isAccountOpen || isRecordingsOpen || isVirtualCamOpen || isGuideOpen}
        />

        {/* Right: Friendly Face Selector & Transformation Knobs */}
        <InspectorPanel
          activePersona={activePersona}
          personas={personas}
          onSelectPersona={setActivePersona}
          settings={settings}
          telemetry={telemetry}
          onUpdateSettings={handleUpdateSettings}
          onOpenLibrary={() => setIsLibraryOpen(true)}
          onOpenConsentLogs={() => setIsLibraryOpen(true)}
        />
      </main>

      {/* 3. Bottom Status Bar (Clean, Friendly, Zero CPU percentages) */}
      <TelemetryBar
        telemetry={telemetry}
        pose={pose}
        metrics={metrics}
        virtualCamActive={settings.virtualCameraActive}
        onOpenVirtualCamHelp={() => setIsVirtualCamOpen(true)}
        onOpenGuide={() => setIsGuideOpen(true)}
      />

      {/* 4. Interactive Modals */}
      <PersonaLibraryModal
        isOpen={isLibraryOpen}
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
        onDeleteRecording={(id) => setRecordings((prev) => prev.filter((r) => r.id !== id))}
      />

      <VirtualCamDialog
        isOpen={isVirtualCamOpen}
        onClose={() => setIsVirtualCamOpen(false)}
        virtualCamActive={settings.virtualCameraActive}
        onToggleVirtualCam={() =>
          handleUpdateSettings({ virtualCameraActive: !settings.virtualCameraActive })
        }
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
