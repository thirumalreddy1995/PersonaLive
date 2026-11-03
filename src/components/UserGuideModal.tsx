import React, { useState } from 'react';
import {
  X,
  BookOpen,
  Camera,
  Sparkles,
  Video,
  ShieldCheck,
  Cpu,
  Code,
  Terminal,
  Layers,
  Sliders,
  CheckCircle2,
  ChevronRight,
  ExternalLink,
  Download,
  RefreshCw,
  GitBranch,
  Laptop,
} from 'lucide-react';

interface UserGuideModalProps {
  isOpen: boolean;
  onClose: () => void;
  onStartDemo: () => void;
}

export const UserGuideModal: React.FC<UserGuideModalProps> = ({
  isOpen,
  onClose,
  onStartDemo,
}) => {
  const [activeTab, setActiveTab] = useState<'quickstart' | 'features' | 'virtualcam' | 'developer' | 'desktop_install'>('quickstart');

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 select-none">
      <div className="bg-slate-900 border border-slate-800 rounded-xl w-full max-w-4xl overflow-hidden shadow-2xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/70">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-sky-500/10 border border-sky-500/30 flex items-center justify-center text-sky-400">
              <BookOpen className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-semibold text-base text-slate-100 flex items-center gap-2">
                PersonaLive Studio: End-to-End User & Developer Guide
                <span className="text-[10px] bg-sky-950 text-sky-400 font-mono px-2 py-0.5 rounded border border-sky-800">
                  Desktop Edition v2.4
                </span>
              </h2>
              <p className="text-xs text-slate-400">
                Operating manual, facial retargeting setup, virtual camera routing, and code architecture
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                onClose();
                onStartDemo();
              }}
              className="px-3 py-1.5 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 text-xs font-bold transition-all shadow-sm flex items-center gap-1.5"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>Launch Live Demo</span>
            </button>
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-slate-200 p-1.5 rounded-lg hover:bg-slate-800 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="flex border-b border-slate-800 px-6 bg-slate-950/40 text-xs">
          <button
            onClick={() => setActiveTab('quickstart')}
            className={`py-3 px-4 font-medium border-b-2 transition-colors flex items-center gap-2 ${
              activeTab === 'quickstart'
                ? 'border-sky-500 text-sky-400'
                : 'border-transparent text-slate-400 hover:text-slate-300'
            }`}
          >
            <CheckCircle2 className="w-4 h-4" />
            <span>1. Quick Start Walkthrough</span>
          </button>
          <button
            onClick={() => setActiveTab('features')}
            className={`py-3 px-4 font-medium border-b-2 transition-colors flex items-center gap-2 ${
              activeTab === 'features'
                ? 'border-sky-500 text-sky-400'
                : 'border-transparent text-slate-400 hover:text-slate-300'
            }`}
          >
            <Sliders className="w-4 h-4" />
            <span>2. Kinematics & Tuning Knobs</span>
          </button>
          <button
            onClick={() => setActiveTab('virtualcam')}
            className={`py-3 px-4 font-medium border-b-2 transition-colors flex items-center gap-2 ${
              activeTab === 'virtualcam'
                ? 'border-sky-500 text-sky-400'
                : 'border-transparent text-slate-400 hover:text-slate-300'
            }`}
          >
            <Video className="w-4 h-4" />
            <span>3. Virtual Camera (Zoom/OBS/Teams)</span>
          </button>
          <button
            onClick={() => setActiveTab('developer')}
            className={`py-3 px-4 font-medium border-b-2 transition-colors flex items-center gap-2 ${
              activeTab === 'developer'
                ? 'border-sky-500 text-sky-400'
                : 'border-transparent text-slate-400 hover:text-slate-300'
            }`}
          >
            <Code className="w-4 h-4" />
            <span>4. Developer Architecture</span>
          </button>
          <button
            onClick={() => setActiveTab('desktop_install')}
            className={`py-3 px-4 font-medium border-b-2 transition-colors flex items-center gap-2 ${
              activeTab === 'desktop_install'
                ? 'border-sky-500 text-sky-400'
                : 'border-transparent text-slate-400 hover:text-slate-300'
            }`}
          >
            <Laptop className="w-4 h-4" />
            <span className="font-semibold text-emerald-400">5. Desktop Install & Auto-Updates</span>
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-6 text-xs text-slate-300 space-y-6">
          {/* TAB 1: QUICK START */}
          {activeTab === 'quickstart' && (
            <div className="space-y-6">
              <div className="bg-sky-950/30 border border-sky-800/60 rounded-xl p-4 flex items-start gap-3">
                <Sparkles className="w-5 h-5 text-sky-400 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <h3 className="font-semibold text-slate-100 text-sm">Welcome to PersonaLive Desktop Studio</h3>
                  <p className="text-slate-300 leading-relaxed">
                    PersonaLive is a real-time facial appearance transformation studio. It uses a single authorized reference photograph to retarget your live facial expressions, head movements, blinks, and speech onto an approved identity representation without facial flickering or unnatural distortions.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-2">
                  <div className="flex items-center gap-2 text-sky-400 font-semibold text-sm">
                    <span className="w-5 h-5 rounded-full bg-sky-950 border border-sky-800 flex items-center justify-center text-xs">1</span>
                    <span>Camera Activation</span>
                  </div>
                  <p className="text-slate-400 leading-relaxed">
                    By default, the studio operates in <strong>Studio Simulated Feed</strong> mode, allowing full testing of head rotation, eye blinks, and lip movements without needing a physical camera connected. To use your real camera, click <strong>"Studio Simulated Feed"</strong> in the top toolbar to switch to your physical webcam.
                  </p>
                </div>

                <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-2">
                  <div className="flex items-center gap-2 text-sky-400 font-semibold text-sm">
                    <span className="w-5 h-5 rounded-full bg-sky-950 border border-sky-800 flex items-center justify-center text-xs">2</span>
                    <span>Persona Selection & Enrollment</span>
                  </div>
                  <p className="text-slate-400 leading-relaxed">
                    Click <strong>"Library"</strong> in the title bar or <strong>"Change"</strong> in the right inspector. Select from pre-verified personas (Dr. Sarah Chen, Marcus Vance, Elena Rostova, Aria Sterling) or upload your own reference photograph with automatic multi-point quality evaluation and legal consent attestation.
                  </p>
                </div>

                <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-2">
                  <div className="flex items-center gap-2 text-sky-400 font-semibold text-sm">
                    <span className="w-5 h-5 rounded-full bg-sky-950 border border-sky-800 flex items-center justify-center text-xs">3</span>
                    <span>Dual Viewport Comparison</span>
                  </div>
                  <p className="text-slate-400 leading-relaxed">
                    Use the <strong>"Split Compare"</strong> slider to drag the boundary between your original webcam feed (left) and the AI-transformed output (right). Alternatively, select <strong>"Side-by-Side"</strong>, <strong>"AI Output Only"</strong>, or <strong>"PiP Mode"</strong>.
                  </p>
                </div>

                <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-2">
                  <div className="flex items-center gap-2 text-sky-400 font-semibold text-sm">
                    <span className="w-5 h-5 rounded-full bg-sky-950 border border-sky-800 flex items-center justify-center text-xs">4</span>
                    <span>Virtual Camera & Recording</span>
                  </div>
                  <p className="text-slate-400 leading-relaxed">
                    Keep the <strong>"DirectShow / OBS VirtualCam Sink"</strong> checkbox checked to expose your transformed appearance as a system-wide webcam to Zoom, Teams, and OBS. Click <strong>"Record Stream"</strong> or <strong>"Snapshot"</strong> to save high-fidelity recordings with embedded C2PA provenance credentials.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: KINEMATICS & TUNING */}
          {activeTab === 'features' && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-2">
                  <h4 className="font-semibold text-slate-100 flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-sky-400" />
                    Identity Blend Strength (20% – 100%)
                  </h4>
                  <p className="text-slate-400 leading-relaxed">
                    Controls the projection weight of the reference face onto the target facial geometry. 90%+ delivers full identity transformation, while lower values blend subtle reference features while retaining more of the original face contours.
                  </p>
                </div>

                <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-2">
                  <h4 className="font-semibold text-slate-100 flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-emerald-400" />
                    1-Euro Temporal Smoothing (0% – 100%)
                  </h4>
                  <p className="text-slate-400 leading-relaxed">
                    Casiez 1-Euro adaptive low-pass filter eliminates camera sensor noise and facial landmark micro-jitter. Set to 80%–90% for studio streaming stability without introducing perceptible input lag during quick head turns.
                  </p>
                </div>

                <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-2">
                  <h4 className="font-semibold text-slate-100 flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-rose-400" />
                    Lip-Sync Sensitivity (MAR: 0.5x – 2.0x)
                  </h4>
                  <p className="text-slate-400 leading-relaxed">
                    Calibrates Mouth Aspect Ratio sensitivity. When speaking, the oral cavity articulates with realistic internal oral depth and upper teeth synthesis, matching speaking cadence and phonemes without black void artifacts.
                  </p>
                </div>

                <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-2">
                  <h4 className="font-semibold text-slate-100 flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-amber-400" />
                    Eye Gaze & Eyelid Retargeting (EAR)
                  </h4>
                  <p className="text-slate-400 leading-relaxed">
                    Monitors Eye Aspect Ratio in real time. Rather than superimposing cartoon pupils, the engine preserves the authentic photographic eyes of the reference image and executes smooth eyelid closure only during physical blinks.
                  </p>
                </div>
              </div>

              <div className="p-4 bg-slate-950 rounded-xl border border-slate-800 space-y-2">
                <h4 className="font-semibold text-slate-200">Hardware Inference Backend Options</h4>
                <div className="grid grid-cols-4 gap-2 pt-1 font-mono text-[11px]">
                  <div className="p-2 rounded bg-slate-900 border border-slate-800">
                    <p className="text-sky-400 font-bold">ONNX DirectML</p>
                    <p className="text-slate-500 text-[10px]">DirectX 12 FP16 (Universal Windows)</p>
                  </div>
                  <div className="p-2 rounded bg-slate-900 border border-slate-800">
                    <p className="text-emerald-400 font-bold">TensorRT RTX</p>
                    <p className="text-slate-500 text-[10px]">NVIDIA CUDA INT8/FP16 (Sub-15ms)</p>
                  </div>
                  <div className="p-2 rounded bg-slate-900 border border-slate-800">
                    <p className="text-purple-400 font-bold">Apple CoreML</p>
                    <p className="text-slate-500 text-[10px]">Apple Silicon Neural Engine (M1-M4)</p>
                  </div>
                  <div className="p-2 rounded bg-slate-900 border border-slate-800">
                    <p className="text-slate-300 font-bold">Safe CPU AVX2</p>
                    <p className="text-slate-500 text-[10px]">Zero dGPU Fallback Mode</p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: VIRTUAL CAM */}
          {activeTab === 'virtualcam' && (
            <div className="space-y-4">
              <div className="bg-slate-950 p-5 rounded-xl border border-slate-800 space-y-3">
                <h3 className="font-semibold text-slate-100 text-sm flex items-center gap-2">
                  <Video className="w-4 h-4 text-emerald-400" />
                  Routing PersonaLive to Video Calling Applications
                </h3>
                <p className="text-slate-400 leading-relaxed">
                  PersonaLive Desktop provides an active Virtual Camera Sink driver. The rendered output stream is continuously written to a shared memory DirectShow buffer (Windows), CoreMediaIO DAL plugin (macOS), or v4l2loopback sink (Linux).
                </p>

                <div className="space-y-3 pt-2">
                  <div className="p-3 bg-slate-900 rounded-lg border border-slate-800 space-y-1">
                    <h5 className="font-semibold text-slate-200">Zoom Setup:</h5>
                    <p className="text-slate-400 text-[11px]">
                      Open Zoom &gt; Settings &gt; Video &gt; Camera dropdown &gt; Select <strong>"PersonaLive Virtual Camera"</strong> or <strong>"OBS Virtual Camera"</strong>. Uncheck "Mirror my video" for proper text watermark alignment.
                    </p>
                  </div>

                  <div className="p-3 bg-slate-900 rounded-lg border border-slate-800 space-y-1">
                    <h5 className="font-semibold text-slate-200">OBS Studio Integration:</h5>
                    <p className="text-slate-400 text-[11px]">
                      Add a new source &gt; Select <strong>"Video Capture Device"</strong> &gt; Select <strong>"PersonaLive Virtual Camera"</strong>. Set resolution to 1280x720 or 1920x1080 at 30/60 FPS.
                    </p>
                  </div>

                  <div className="p-3 bg-slate-900 rounded-lg border border-slate-800 space-y-1">
                    <h5 className="font-semibold text-slate-200">Microsoft Teams & Discord:</h5>
                    <p className="text-slate-400 text-[11px]">
                      Go to User Settings &gt; Voice & Video &gt; Video Settings &gt; Camera &gt; Select <strong>"PersonaLive Virtual Camera"</strong>. Test preview to verify smooth lip-syncing.
                    </p>
                  </div>
                </div>
              </div>

              <div className="p-3.5 bg-amber-950/40 border border-amber-800/80 rounded-xl text-amber-300 flex items-start gap-3">
                <ShieldCheck className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <p className="leading-relaxed">
                  <strong>Mandatory Ethical Safeguard:</strong> The output stream carries the immutable <strong>[● AI-TRANSFORMED PERSONA C2PA]</strong> badge. Bypassing, cropping, or injecting into identity verification or biometric KYC systems is strictly prohibited.
                </p>
              </div>
            </div>
          )}

          {/* TAB 4: DEVELOPER ARCHITECTURE */}
          {activeTab === 'developer' && (
            <div className="space-y-4 font-sans">
              <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-2">
                <h4 className="font-semibold text-slate-100 flex items-center gap-2">
                  <Terminal className="w-4 h-4 text-sky-400" />
                  Codebase Layout & Modules
                </h4>
                <div className="bg-slate-900 p-3 rounded-lg font-mono text-[11px] text-slate-300 space-y-1">
                  <div>├── <span className="text-sky-400">src/types/index.ts</span> (Data contracts for Personas, Blendshapes, HeadPose, Telemetry)</div>
                  <div>├── <span className="text-sky-400">src/utils/faceMath.ts</span> (EAR, MAR, Head Pose Rodrigues, OneEuroFilter, Quality Evaluator)</div>
                  <div>├── <span className="text-sky-400">src/utils/faceMath.test.ts</span> (Node built-in unit test suite via npx --yes tsx --test)</div>
                  <div>├── <span className="text-sky-400">src/utils/facialEngine.ts</span> (Real-time Canvas 60 FPS transformation & kinematic pipeline)</div>
                  <div>├── <span className="text-sky-400">src/components/StudioViewport.tsx</span> (Split compare slider, camera toggle, record & snapshot)</div>
                  <div>├── <span className="text-sky-400">src/components/InspectorPanel.tsx</span> (Tuning sliders, hardware engine, biometrics policy)</div>
                  <div>├── <span className="text-sky-400">src/components/PersonaLibraryModal.tsx</span> (Reference photo upload, quality assessment, consent)</div>
                  <div>└── <span className="text-sky-400">src/components/VirtualCamDialog.tsx</span> (Virtual camera driver documentation & sink state)</div>
                </div>
              </div>

              <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-2">
                <h4 className="font-semibold text-slate-100 flex items-center gap-2">
                  <Cpu className="w-4 h-4 text-emerald-400" />
                  Running Tests & Packaging as Desktop Binary
                </h4>
                <div className="space-y-2 text-slate-400 leading-relaxed">
                  <p>
                    <strong>1. Run Pure-Logic Unit Tests:</strong>
                  </p>
                  <pre className="bg-slate-900 p-2.5 rounded font-mono text-[11px] text-sky-300">
npx --yes tsx --test src/utils/faceMath.test.ts
                  </pre>
                  <p>
                    <strong>2. Compiling the Production Bundle:</strong>
                  </p>
                  <pre className="bg-slate-900 p-2.5 rounded font-mono text-[11px] text-sky-300">
npm run build
                  </pre>
                  <p>
                    <strong>3. Packaging with Electron or Tauri:</strong>
                  </p>
                  <p className="text-[11px]">
                    The codebase is designed for plug-and-play encapsulation inside Electron or Tauri. The canvas output directly interfaces with C++ DirectShow addons (`virtual-cam-sink`) via native N-API IPC buffers.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* TAB 5: DESKTOP INSTALLATION & AUTO-UPDATES */}
          {activeTab === 'desktop_install' && (
            <div className="space-y-6">
              {/* Intro Banner */}
              <div className="bg-emerald-950/30 border border-emerald-800/60 rounded-xl p-4 flex items-start gap-3">
                <Laptop className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <h3 className="font-semibold text-slate-100 text-sm">Installing as a Desktop App & Automatic Push Updates</h3>
                  <p className="text-slate-300 leading-relaxed">
                    PersonaLive Desktop Studio supports two industry-standard deployment methods for desktop installation and automated continuous updating when you push code changes.
                  </p>
                </div>
              </div>

              {/* METHOD 1: DESKTOP PWA */}
              <div className="bg-slate-950 p-5 rounded-xl border border-slate-800 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="w-7 h-7 rounded-lg bg-sky-500/10 border border-sky-500/30 flex items-center justify-center text-sky-400 font-bold text-xs">
                      A
                    </div>
                    <div>
                      <h4 className="font-semibold text-slate-100 text-sm flex items-center gap-2">
                        Method 1: Instant Desktop App (PWA) with Background Push Auto-Updates
                        <span className="text-[10px] bg-sky-950 text-sky-400 font-mono px-2 py-0.5 rounded border border-sky-800">
                          Zero Friction (Recommended)
                        </span>
                      </h4>
                      <p className="text-[11px] text-slate-400">Installs directly to Windows Desktop/Start Menu or macOS Dock as a dedicated OS window</p>
                    </div>
                  </div>
                  <Download className="w-5 h-5 text-sky-400 shrink-0" />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-[11px]">
                  <div className="bg-slate-900/80 p-3.5 rounded-lg border border-slate-800/80 space-y-2">
                    <span className="font-semibold text-sky-300 flex items-center gap-1.5">
                      <Download className="w-3.5 h-3.5" /> Step 1: Install to Your Desktop
                    </span>
                    <ol className="list-decimal list-inside space-y-1 text-slate-300">
                      <li>Open PersonaLive in <strong>Chrome</strong>, <strong>Edge</strong>, or <strong>Brave</strong>.</li>
                      <li>Click the <strong>"Install Desktop App"</strong> button in the Studio Titlebar (or click the install icon ⊕ in the browser address bar).</li>
                      <li>Click <strong>Install</strong> when prompted by the operating system.</li>
                      <li>PersonaLive now launches in its own native standalone window with its own icon in your Windows Taskbar, Start Menu, or macOS Dock.</li>
                    </ol>
                  </div>

                  <div className="bg-slate-900/80 p-3.5 rounded-lg border border-slate-800/80 space-y-2">
                    <span className="font-semibold text-emerald-300 flex items-center gap-1.5">
                      <RefreshCw className="w-3.5 h-3.5" /> Step 2: How It Auto-Updates on Push
                    </span>
                    <ol className="list-decimal list-inside space-y-1 text-slate-300">
                      <li>When you push code changes to git and redeploy (or restart), the built-in <strong>Service Worker (<code className="text-sky-300">/sw.js</code>)</strong> immediately detects the new assets in the background.</li>
                      <li>The desktop window displays a gold <strong>"Update Ready — Restart"</strong> badge in the titlebar.</li>
                      <li>Clicking the button (or restarting the app) instantly activates the new release. No reinstall or manual download is ever required!</li>
                    </ol>
                  </div>
                </div>
              </div>

              {/* METHOD 2: NATIVE ELECTRON + GITHUB CI/CD */}
              <div className="bg-slate-950 p-5 rounded-xl border border-slate-800 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="w-7 h-7 rounded-lg bg-purple-500/10 border border-purple-500/30 flex items-center justify-center text-purple-400 font-bold text-xs">
                      B
                    </div>
                    <div>
                      <h4 className="font-semibold text-slate-100 text-sm flex items-center gap-2">
                        Method 2: Native Electron Binary (.exe / .dmg) with GitHub Actions CI/CD
                        <span className="text-[10px] bg-purple-950 text-purple-400 font-mono px-2 py-0.5 rounded border border-purple-800">
                          Native Binary
                        </span>
                      </h4>
                      <p className="text-[11px] text-slate-400">Distributes standalone Windows & macOS installers that automatically update via GitHub Releases</p>
                    </div>
                  </div>
                  <GitBranch className="w-5 h-5 text-purple-400 shrink-0" />
                </div>

                <div className="space-y-3 text-[11px] text-slate-300">
                  <p>
                    We have pre-configured the complete Electron architecture in your repository:
                  </p>
                  <ul className="list-disc list-inside space-y-1 text-slate-400 font-mono text-[10px]">
                    <li><span className="text-purple-300">electron/main.cjs</span>: Hardware-accelerated Electron main process with <code className="text-sky-300">electron-updater</code></li>
                    <li><span className="text-purple-300">electron/preload.cjs</span>: Safe IPC bridge connecting the UI to auto-update events</li>
                    <li><span className="text-purple-300">.github/workflows/desktop-release.yml</span>: GitHub Actions CI/CD workflow</li>
                  </ul>

                  <div className="space-y-2">
                    <p className="font-semibold text-slate-200">How pushing new changes triggers automatic updates:</p>
                    <div className="bg-slate-900 p-3 rounded-lg border border-slate-800 space-y-2 text-slate-300">
                      <p><strong>1. Push your changes and tag a new version in git:</strong></p>
                      <pre className="bg-slate-950 p-2 rounded font-mono text-emerald-400 text-[11px]">
git add .
git commit -m "Update facial retargeting engine"
git tag v2.5.0
git push origin main --tags
                      </pre>
                      <p><strong>2. GitHub Actions automatically builds the installers:</strong></p>
                      <p className="text-slate-400">
                        The workflow in <code className="text-sky-300">.github/workflows/desktop-release.yml</code> runs on Windows and macOS virtual machines, runs your unit tests (<code className="text-sky-300">npx tsx --test src/utils/faceMath.test.ts</code>), compiles the binary, and publishes a new release on GitHub.
                      </p>
                      <p><strong>3. Users' desktop apps auto-download the new release:</strong></p>
                      <p className="text-slate-400">
                        When users launch PersonaLive Desktop on their PC or Mac, <code className="text-sky-300">electron-updater</code> checks your GitHub repository releases, silently downloads the delta update in the background, and prompts to restart with the new version!
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
