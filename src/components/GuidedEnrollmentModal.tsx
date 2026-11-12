import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, CheckCircle2, RotateCcw, ShieldCheck, X } from 'lucide-react';
import { AuthorizedPersona, CATEGORY_LABEL, PersonaCategory } from '../types/index.ts';
import { CONSENT_STORAGE_PREFIX } from './ConsentForm.tsx';
import { getEnrollmentFrame, setEnrollmentActive, type EnrollmentFrame } from '../utils/enrollmentSource.ts';
import { publishEnrollment } from '../realism/debug.ts';
import {
  ENROLLMENT_STEPS,
  ENROLL_ANALYSIS_WIDTH,
  EnrollmentShot,
  ShotEvaluation,
  ShotHold,
  buildEnrollmentConsent,
  enrollmentComplete,
  enrollmentPersona,
  evaluateShot,
  exposureStats,
  laplacianVariance,
  toLuma,
} from '../utils/enrollment.ts';

/**
 * Guided persona enrollment (R5 §2, flag guidedEnrollment). The person whose face will be used
 * sits at the webcam: they read and accept the consent text first, then are guided through the
 * reference shots, each checked live for pose, expression, blur and exposure. Saving builds a
 * persona whose signed consent record lists the SHA-256 of every shot. Nothing leaves the machine.
 */

interface GuidedEnrollmentModalProps {
  isOpen: boolean;
  /** Category of the person at the camera when the studio already knows it. */
  defaultCategory: PersonaCategory | null;
  onClose: () => void;
  onComplete: (persona: AuthorizedPersona) => void;
}

type Phase = 'consent' | 'capture' | 'review';

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function dataUrlBytes(dataUrl: string): ArrayBuffer {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** Blur and exposure of the face crop of the current camera frame. */
function measureFace(frame: EnrollmentFrame, scratch: HTMLCanvasElement): { sharpness: number; meanLuma: number; clippedShare: number } | null {
  const v = frame.video;
  if (!frame.faceBox || v.videoWidth === 0) return null;
  const [bx, by, bw, bh] = frame.faceBox;
  const sx = Math.max(0, bx * v.videoWidth);
  const sy = Math.max(0, by * v.videoHeight);
  const sw = Math.min(v.videoWidth - sx, bw * v.videoWidth);
  const sh = Math.min(v.videoHeight - sy, bh * v.videoHeight);
  if (sw < 16 || sh < 16) return null;
  const w = ENROLL_ANALYSIS_WIDTH;
  const h = Math.max(16, Math.round((w * sh) / sw));
  scratch.width = w;
  scratch.height = h;
  const ctx = scratch.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(v, sx, sy, sw, sh, 0, 0, w, h);
  const luma = toLuma(ctx.getImageData(0, 0, w, h).data, w, h);
  return { sharpness: laplacianVariance(luma, w, h), ...exposureStats(luma) };
}

export const GuidedEnrollmentModal: React.FC<GuidedEnrollmentModalProps> = ({ isOpen, defaultCategory, onClose, onComplete }) => {
  const [phase, setPhase] = useState<Phase>('consent');
  const [signerName, setSignerName] = useState('');
  const [liveCalls, setLiveCalls] = useState(true);
  const [cloudProcessing, setCloudProcessing] = useState(false);
  const [recordings, setRecordings] = useState(false);
  const [attested, setAttested] = useState(false);
  const [category, setCategory] = useState<PersonaCategory | null>(defaultCategory);
  const [stepIndex, setStepIndex] = useState(0);
  const [shots, setShots] = useState<EnrollmentShot[]>([]);
  const [evaluation, setEvaluation] = useState<ShotEvaluation | null>(null);
  const [holdProgress, setHoldProgress] = useState(0);
  const [cameraReady, setCameraReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const previewRef = useRef<HTMLVideoElement | null>(null);
  const scratchRef = useRef<HTMLCanvasElement | null>(null);
  const holdRef = useRef(new ShotHold());
  const shotsRef = useRef<EnrollmentShot[]>([]);
  const qualityRef = useRef<{ t: number; value: ReturnType<typeof measureFace> }>({ t: 0, value: null });
  const capturingRef = useRef(false);
  const frameSizeRef = useRef({ width: 0, height: 0 });
  const liveRef = useRef<{ yaw: number; pitch: number; mar: number; smile: number; sharpness: number | null; meanLuma: number | null } | null>(null);
  shotsRef.current = shots;

  // A fresh dialog every time it opens.
  useEffect(() => {
    if (!isOpen) return;
    setPhase('consent');
    setSignerName('');
    setLiveCalls(true);
    setCloudProcessing(false);
    setRecordings(false);
    setAttested(false);
    setCategory(defaultCategory);
    setStepIndex(0);
    setShots([]);
    setEvaluation(null);
    setError(null);
    holdRef.current.reset();
  }, [isOpen, defaultCategory]);

  // The studio keeps its tracker running while this dialog is open (it stops behind other dialogs).
  useEffect(() => {
    if (!isOpen) return;
    setEnrollmentActive(true);
    return () => setEnrollmentActive(false);
  }, [isOpen]);

  const step = ENROLLMENT_STEPS[Math.min(stepIndex, ENROLLMENT_STEPS.length - 1)];

  /** Takes the shot for the current step from the raw (un-mirrored) camera frame. */
  const capture = useCallback(
    async (frame: EnrollmentFrame) => {
      if (capturingRef.current) return;
      capturingRef.current = true;
      try {
        const v = frame.video;
        const canvas = document.createElement('canvas');
        canvas.width = v.videoWidth;
        canvas.height = v.videoHeight;
        canvas.getContext('2d')!.drawImage(v, 0, 0);
        frameSizeRef.current = { width: canvas.width, height: canvas.height };
        const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
        const sha256 = await sha256Hex(dataUrlBytes(dataUrl));
        const q = qualityRef.current.value ?? measureFace(frame, scratchRef.current ?? document.createElement('canvas'));
        const current = ENROLLMENT_STEPS[stepIndex];
        const shot: EnrollmentShot = {
          stepId: current.id,
          label: current.label,
          dataUrl,
          sha256,
          pose: { ...frame.pose },
          matrixPose: frame.matrixPose ? { ...frame.matrixPose } : null,
          expression: { mar: frame.mar, smile: frame.smile, browElevation: frame.browElevation },
          quality: q ?? { sharpness: 0, meanLuma: 0, clippedShare: 1 },
        };
        const next = [...shotsRef.current.filter((s) => s.stepId !== current.id), shot];
        setShots(next);
        holdRef.current.reset();
        // The next step still missing, or the review once the set is complete.
        const missing = ENROLLMENT_STEPS.findIndex((s) => !next.some((x) => x.stepId === s.id));
        if (missing < 0) setPhase('review');
        else setStepIndex(missing);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'The shot could not be taken.');
      } finally {
        capturingRef.current = false;
      }
    },
    [stepIndex]
  );

  // Live loop while capturing: read the studio's tracking, check the shot, take it after a still hold.
  useEffect(() => {
    if (!isOpen || phase !== 'capture') return;
    if (!scratchRef.current) scratchRef.current = document.createElement('canvas');
    let raf = 0;
    let stopped = false;
    const tick = (now: number) => {
      if (stopped) return;
      const frame = getEnrollmentFrame();
      setCameraReady(!!frame);
      if (frame) {
        const preview = previewRef.current;
        if (preview && preview.srcObject !== frame.video.srcObject) {
          preview.srcObject = frame.video.srcObject;
          void preview.play().catch(() => undefined);
        }
        // Blur and exposure are measured a few times a second, not every frame.
        if (now - qualityRef.current.t > 150) qualityRef.current = { t: now, value: measureFace(frame, scratchRef.current!) };
        const q = qualityRef.current.value;
        // The matrix pose is in true degrees; the landmark estimate is the fallback. The baseline uses the same source.
        const live = frame.matrixPose ?? frame.pose;
        const frontal = shotsRef.current.find((s) => s.stepId === 'frontal');
        const baseline = step.id === 'frontal' || !frontal ? null : frame.matrixPose && frontal.matrixPose ? frontal.matrixPose : frontal.pose;
        const sample = {
          faceVisible: frame.faceVisible,
          yaw: live.yaw,
          pitch: live.pitch,
          mar: frame.mar,
          smile: frame.smile,
          sharpness: q ? q.sharpness : null,
          meanLuma: q ? q.meanLuma : null,
          clippedShare: q ? q.clippedShare : null,
        };
        const ev = evaluateShot(step, sample, baseline ? { yaw: baseline.yaw, pitch: baseline.pitch } : null);
        liveRef.current = { yaw: sample.yaw, pitch: sample.pitch, mar: sample.mar, smile: sample.smile, sharpness: sample.sharpness, meanLuma: sample.meanLuma };
        setEvaluation(ev);
        const fire = holdRef.current.push(ev.ok, { yaw: live.yaw, pitch: live.pitch }, now);
        setHoldProgress(holdRef.current.progress(now));
        if (fire) void capture(frame);
      } else {
        setEvaluation(null);
        setHoldProgress(0);
        holdRef.current.reset();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
  }, [isOpen, phase, step, capture]);

  if (!isOpen) return null;

  // Review tools read the dialog's state through the realism hook (a no-op without ?realism).
  publishEnrollment({
    phase,
    stepId: phase === 'capture' ? step.id : null,
    shots,
    checks: phase === 'capture' && evaluation ? evaluation.checks : null,
    hint: phase === 'capture' && evaluation && !evaluation.ok ? (evaluation.hints[0] ?? null) : null,
    live: phase === 'capture' ? liveRef.current : null,
    savedPersonaId: null,
    error,
  });

  const startCapture = () => {
    if (!signerName.trim()) return setError('Enter your name as the person who will be pictured.');
    if (!liveCalls) return setError('Consent to live video calls where every participant knows they are seeing a persona is required.');
    if (!attested) return setError('Only the person at the camera can give this consent.');
    setError(null);
    setPhase('capture');
  };

  const retake = (stepId: string) => {
    setShots((prev) => prev.filter((s) => s.stepId !== stepId));
    setStepIndex(ENROLLMENT_STEPS.findIndex((s) => s.id === stepId));
    holdRef.current.reset();
    setPhase('capture');
  };

  const save = () => {
    if (!category) return setError('Choose whether this is a woman’s or a man’s face.');
    if (!enrollmentComplete(shots)) return setError('The reference set is incomplete.');
    setBusy(true);
    try {
      const signedAt = new Date().toISOString();
      const consent = buildEnrollmentConsent({ signerName, attested, scope: { liveCalls, cloudProcessing, recordings }, signedAt }, shots);
      const id = `persona-enroll-${Date.now()}`;
      const persona = enrollmentPersona({ id, name: signerName, category, width: frameSizeRef.current.width, height: frameSizeRef.current.height }, shots, consent);
      try {
        localStorage.setItem(CONSENT_STORAGE_PREFIX + id, JSON.stringify(consent));
      } catch {
        /* storage may be unavailable; the persona still carries the record for this session */
      }
      publishEnrollment({ phase: 'saved', stepId: null, shots, checks: null, hint: null, live: null, savedPersonaId: id, error: null });
      onComplete(persona);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The persona could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  const check = (ok: boolean | undefined, label: string) => (
    <span className={`px-2 py-0.5 rounded-full border text-[10px] ${ok ? 'border-emerald-700 text-emerald-300 bg-emerald-950/40' : 'border-slate-700 text-slate-400 bg-slate-900'}`}>
      {ok ? '✓' : '·'} {label}
    </span>
  );

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4" data-testid="guided-enrollment">
      <div className="bg-slate-900 border border-slate-800 rounded-xl w-full max-w-2xl overflow-hidden shadow-2xl flex flex-col max-h-[92vh]">
        <div className="px-5 py-3 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2 text-slate-100 font-semibold text-sm">
            <Camera className="w-4 h-4 text-sky-400" /> Guided capture at the webcam
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-200 p-1 rounded hover:bg-slate-800" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 overflow-y-auto text-xs text-slate-300 space-y-3">
          {phase === 'consent' && (
            <div className="space-y-3" data-testid="enrollment-consent">
              <div className="flex items-center gap-2 text-amber-300 font-semibold">
                <ShieldCheck className="w-4 h-4" /> Consent of the person being pictured
              </div>
              <p className="text-slate-400">
                This must be done by the person whose face will be used, sitting at this camera. You will be asked for seven
                photos: looking straight ahead, turned right and left, chin up and down, mouth open, and smiling. The photos and
                this record stay on this computer.
              </p>
              <p className="text-slate-400">
                Your face may then be shown on another person in live video calls. Every frame carries a visible badge saying it
                is AI-transformed, and every participant of the call is to be told they are seeing a persona.
              </p>
              <label className="block">
                <span className="text-slate-400">Your name</span>
                <input value={signerName} onChange={(e) => setSignerName(e.target.value)} className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-slate-100" data-testid="enrollment-name" />
              </label>
              <div className="space-y-1">
                <span className="text-slate-400">I allow my likeness to be used for:</span>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={liveCalls} onChange={(e) => setLiveCalls(e.target.checked)} className="accent-amber-500" /> live video calls where every participant knows they are seeing a persona
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={cloudProcessing} onChange={(e) => setCloudProcessing(e.target.checked)} className="accent-amber-500" /> opt-in cloud processing of face crops (never stored; compositing and the badge stay local)
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={recordings} onChange={(e) => setRecordings(e.target.checked)} className="accent-amber-500" /> recordings of such calls
                </label>
              </div>
              <label className="flex items-center gap-2 text-slate-100">
                <input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} className="accent-amber-500" data-testid="enrollment-attest" /> I am the person at this camera, the photos will be of me, and I am giving this consent myself.
              </label>
            </div>
          )}

          {phase === 'capture' && (
            <div className="space-y-3" data-testid="enrollment-capture">
              <div className="flex items-center justify-between">
                <span className="text-slate-100 font-semibold">
                  Shot {stepIndex + 1} of {ENROLLMENT_STEPS.length}: {step.label}
                </span>
                <span className="text-slate-500">{shots.length} taken</span>
              </div>
              <p className="text-sky-200 text-sm">{step.instruction}</p>
              <div className="relative rounded-lg overflow-hidden bg-black aspect-video border border-slate-800">
                {/* Mirrored like a mirror; the stored photo is the un-mirrored camera frame. */}
                <video ref={previewRef} muted playsInline className="w-full h-full object-cover" style={{ transform: 'scaleX(-1)' }} />
                {!cameraReady && (
                  <div className="absolute inset-0 flex items-center justify-center text-center text-slate-300 bg-slate-950/80 p-6">
                    The webcam is not running. Close this dialog, start the camera in the studio, and open the guided capture again.
                  </div>
                )}
                <div className="absolute left-0 bottom-0 h-1 bg-emerald-400 transition-[width]" style={{ width: `${Math.round(holdProgress * 100)}%` }} />
              </div>
              <div className="flex flex-wrap gap-1.5">
                {check(evaluation?.checks.face, 'face')}
                {check(evaluation?.checks.pose, 'pose')}
                {check(evaluation?.checks.expression, 'expression')}
                {check(evaluation?.checks.sharpness, 'sharp')}
                {check(evaluation?.checks.exposure, 'exposure')}
              </div>
              <p className="min-h-[1.25rem] text-amber-200" data-testid="enrollment-hint">
                {evaluation ? (evaluation.ok ? 'Hold still…' : evaluation.hints[0] ?? 'Measuring…') : ''}
              </p>
              <div className="flex flex-wrap gap-2">
                {ENROLLMENT_STEPS.map((s, i) => {
                  const shot = shots.find((x) => x.stepId === s.id);
                  return (
                    <button
                      key={s.id}
                      onClick={() => {
                        setStepIndex(i);
                        holdRef.current.reset();
                      }}
                      className={`w-16 text-[10px] rounded border ${i === stepIndex ? 'border-sky-500' : 'border-slate-700'} overflow-hidden bg-slate-950`}
                      title={shot ? `${s.label}: taken (click to retake)` : s.label}
                    >
                      <div className="aspect-video bg-slate-900 flex items-center justify-center">
                        {shot ? <img src={shot.dataUrl} alt={s.label} className="w-full h-full object-cover" style={{ transform: 'scaleX(-1)' }} /> : <span className="text-slate-600">{i + 1}</span>}
                      </div>
                      <div className="px-1 py-0.5 truncate text-slate-400">{s.label}</div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {phase === 'review' && (
            <div className="space-y-3" data-testid="enrollment-review">
              <div className="flex items-center gap-2 text-emerald-300 font-semibold">
                <CheckCircle2 className="w-4 h-4" /> All seven shots are taken
              </div>
              <div className="grid grid-cols-4 gap-2">
                {ENROLLMENT_STEPS.map((s) => {
                  const shot = shots.find((x) => x.stepId === s.id);
                  return (
                    <div key={s.id} className="rounded border border-slate-700 overflow-hidden bg-slate-950">
                      <div className="aspect-video bg-slate-900">{shot && <img src={shot.dataUrl} alt={s.label} className="w-full h-full object-cover" style={{ transform: 'scaleX(-1)' }} />}</div>
                      <div className="flex items-center justify-between px-1.5 py-1 text-[10px] text-slate-400">
                        <span className="truncate">{s.label}</span>
                        <button onClick={() => retake(s.id)} className="text-slate-400 hover:text-sky-300" title="Retake this shot">
                          <RotateCcw className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div>
                <span className="text-slate-400">This face is a</span>
                <div className="mt-1 flex gap-2">
                  {(['women', 'men'] as PersonaCategory[]).map((c) => (
                    <button key={c} onClick={() => setCategory(c)} className={`px-3 py-1.5 rounded border ${category === c ? 'border-sky-500 text-sky-300 bg-sky-950/40' : 'border-slate-700 text-slate-300'}`}>
                      {CATEGORY_LABEL[c].one}
                    </button>
                  ))}
                </div>
              </div>
              <p className="text-slate-400">
                Saving signs the consent record as <span className="text-slate-200">{signerName.trim()}</span> for these seven photos (their SHA-256 hashes are stored with it).
              </p>
            </div>
          )}

          {error && (
            <p className="text-rose-400" data-testid="enrollment-error">
              {error}
            </p>
          )}
        </div>

        <div className="px-5 py-3 border-t border-slate-800 flex items-center justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded text-slate-400 hover:text-slate-200 text-xs">
            Cancel
          </button>
          {phase === 'consent' && (
            <button onClick={startCapture} className="px-3 py-1.5 rounded bg-amber-500 text-slate-950 font-semibold hover:bg-amber-400 text-xs" data-testid="enrollment-start">
              I agree — start the capture
            </button>
          )}
          {phase === 'review' && (
            <button onClick={save} disabled={busy} className="px-3 py-1.5 rounded bg-sky-500 text-slate-950 font-semibold hover:bg-sky-400 disabled:opacity-50 text-xs" data-testid="enrollment-save">
              Sign and save this face
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
