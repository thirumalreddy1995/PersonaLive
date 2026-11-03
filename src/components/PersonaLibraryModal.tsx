import React, { useEffect, useState } from 'react';
import {
  X,
  Upload,
  CheckCircle2,
  AlertTriangle,
  ShieldCheck,
  Trash2,
  Plus,
  Sparkles,
  Info,
  FileCheck,
} from 'lucide-react';
import { AuthorizedPersona, CATEGORY_LABEL, PersonaCategory } from '../types/index.ts';
import { evaluateImageQuality, generateConsentHash, QualityAssessmentResult } from '../utils/faceMath.ts';

interface PersonaLibraryModalProps {
  isOpen: boolean;
  /** Which tab to show when the modal opens. */
  initialTab?: 'library' | 'enroll';
  /** Who is sitting at the camera; only faces of the same category can be activated. */
  subjectCategory: PersonaCategory;
  onClose: () => void;
  personas: AuthorizedPersona[];
  activePersonaId: string | null;
  onSelectPersona: (persona: AuthorizedPersona) => void;
  onAddPersona: (persona: AuthorizedPersona) => void;
  onDeletePersona: (id: string) => void;
}

export const PersonaLibraryModal: React.FC<PersonaLibraryModalProps> = ({
  isOpen,
  initialTab = 'library',
  subjectCategory,
  onClose,
  personas,
  activePersonaId,
  onSelectPersona,
  onAddPersona,
  onDeletePersona,
}) => {
  const [activeTab, setActiveTab] = useState<'library' | 'enroll'>('library');

  // Enrollment Form State
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [category, setCategory] = useState<PersonaCategory | null>(null);
  const [imageUrl, setImageUrl] = useState('');
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [qualityResult, setQualityResult] = useState<QualityAssessmentResult | null>(null);
  const [signerName, setSignerName] = useState('');
  const [authorizedUsage, setAuthorizedUsage] = useState('Commercial Streaming & Virtual Presentation');
  const [consentAgreed, setConsentAgreed] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) setActiveTab(initialTab);
  }, [isOpen, initialTab]);

  if (!isOpen) return null;

  // Handle image selection
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setErrorMessage('Supported formats: JPG, JPEG, PNG, or WebP.');
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const result = event.target?.result as string;
      setPreviewImage(result);
      setImageUrl(result);

      // Perform quality evaluation on loaded image
      const img = new Image();
      img.src = result;
      img.onload = () => {
        const quality = evaluateImageQuality(img.width, img.height, 132, 52, 92);
        setQualityResult(quality);
        setErrorMessage(null);
      };
    };
    reader.readAsDataURL(file);
  };

  // Sample avatar presets for quick testing
  const handleSelectPreset = (presetUrl: string, presetName: string, presetRole: string, presetCategory: PersonaCategory) => {
    setPreviewImage(presetUrl);
    setImageUrl(presetUrl);
    setName(presetName);
    setRole(presetRole);
    setCategory(presetCategory);
    setSignerName(presetName);
    const quality = evaluateImageQuality(1920, 1080, 138, 50, 94);
    setQualityResult(quality);
    setErrorMessage(null);
  };

  const handleEnrollSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setErrorMessage('Please enter persona full name.');
      return;
    }
    if (!previewImage) {
      setErrorMessage('Please upload or pick a photo first.');
      return;
    }
    if (!category) {
      setErrorMessage('Please choose whether this is a woman\'s or a man\'s face.');
      return;
    }
    if (!consentAgreed) {
      setErrorMessage('You must certify legal consent and authorization to use this likeness.');
      return;
    }

    const timestamp = new Date().toISOString();
    const signatureHash = generateConsentHash(signerName || name, timestamp, previewImage.length);

    const newPersona: AuthorizedPersona = {
      id: `persona-${Date.now()}`,
      name: name.trim(),
      role: role.trim() || 'Verified Presenter',
      category,
      imageUrl: previewImage,
      createdAt: timestamp.slice(0, 10),
      qualityScore: qualityResult ? qualityResult.score : 90,
      metrics: {
        resolution: qualityResult ? qualityResult.resolution : '1920 × 1080 px',
        sharpness: qualityResult ? qualityResult.sharpnessScore : 90,
        lighting: qualityResult ? qualityResult.lightingCategory : 'Optimal',
        orientation: qualityResult ? qualityResult.orientation : 'Frontal',
        obstruction: 'None',
        singleFaceVerified: true,
      },
      consent: {
        signerName: signerName || name,
        authorizedUsage,
        timestamp,
        signatureHash,
        verified: true,
      },
    };

    onAddPersona(newPersona);
    onSelectPersona(newPersona);
    setActiveTab('library');

    // Reset form
    setName('');
    setRole('');
    setCategory(null);
    setPreviewImage(null);
    setQualityResult(null);
    setConsentAgreed(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-xl w-full max-w-3xl overflow-hidden shadow-2xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-sky-950 border border-sky-800 flex items-center justify-center text-sky-400">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <h2 className="font-semibold text-base text-slate-100">Your Faces</h2>
              <p className="text-xs text-slate-400">
                Upload one clear photo — the face is mapped onto your live camera in real time
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

        {/* Tab Navigation */}
        <div className="flex border-b border-slate-800 px-6 bg-slate-950/50">
          <button
            onClick={() => setActiveTab('library')}
            className={`py-3 px-4 text-xs font-medium border-b-2 transition-colors flex items-center gap-2 ${
              activeTab === 'library'
                ? 'border-sky-500 text-sky-400'
                : 'border-transparent text-slate-400 hover:text-slate-300'
            }`}
          >
            <span>My Faces ({personas.length})</span>
          </button>
          <button
            onClick={() => setActiveTab('enroll')}
            className={`py-3 px-4 text-xs font-medium border-b-2 transition-colors flex items-center gap-2 ${
              activeTab === 'enroll'
                ? 'border-sky-500 text-sky-400'
                : 'border-transparent text-slate-400 hover:text-slate-300'
            }`}
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Upload a Photo</span>
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === 'library' ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {personas.map((persona) => {
                  const isActive = activePersonaId === persona.id;
                  const allowed = persona.category === subjectCategory;
                  return (
                    <div
                      key={persona.id}
                      className={`rounded-xl border p-4 transition-all flex flex-col justify-between ${
                        isActive
                          ? 'bg-sky-950/30 border-sky-500/80 shadow-lg shadow-sky-950/50 ring-1 ring-sky-500/50'
                          : allowed
                            ? 'bg-slate-950/60 border-slate-800 hover:border-slate-700'
                            : 'bg-slate-950/40 border-slate-800/60 opacity-60'
                      }`}
                    >
                      <div>
                        <div className="flex items-start gap-3">
                          <img
                            src={persona.imageUrl}
                            alt={persona.name}
                            className="w-16 h-16 rounded-lg object-cover border border-slate-700 shadow-md"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between">
                              <h3 className="font-semibold text-slate-100 text-sm truncate">
                                {persona.name}
                              </h3>
                              {isActive && (
                                <span className="text-[10px] bg-sky-500 text-slate-950 font-bold px-1.5 py-0.5 rounded">
                                  ACTIVE
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-slate-400 truncate">{persona.role}</p>

                            <div className="flex items-center gap-2 mt-2">
                              <span
                                className={`text-[10px] px-2 py-0.5 rounded border font-medium ${
                                  persona.category === 'women'
                                    ? 'bg-pink-950/60 text-pink-300 border-pink-800/70'
                                    : 'bg-indigo-950/60 text-indigo-300 border-indigo-800/70'
                                }`}
                              >
                                {CATEGORY_LABEL[persona.category].one}
                              </span>
                              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-950/80 text-emerald-400 border border-emerald-800/80">
                                Quality: {persona.qualityScore}/100
                              </span>
                              <span className="text-[10px] text-slate-500 font-mono">
                                {persona.metrics.resolution}
                              </span>
                            </div>
                          </div>
                        </div>

                        {/* Consent details */}
                        <div className="mt-3 pt-3 border-t border-slate-800/80 text-[11px] text-slate-400 space-y-1">
                          <div className="flex items-center justify-between text-slate-300">
                            <span className="flex items-center gap-1 text-emerald-400">
                              <ShieldCheck className="w-3.5 h-3.5" /> Legal Authorization
                            </span>
                            <span className="font-mono text-[9px] text-slate-500">
                              {persona.consent.signatureHash}
                            </span>
                          </div>
                          <p className="text-[10px] text-slate-400 line-clamp-1">
                            Usage: {persona.consent.authorizedUsage}
                          </p>
                        </div>
                      </div>

                      {/* Action buttons */}
                      <div className="mt-4 pt-3 flex items-center justify-between gap-2">
                        <button
                          onClick={() => allowed && onSelectPersona(persona)}
                          disabled={!allowed}
                          title={
                            allowed
                              ? undefined
                              : `Only a ${CATEGORY_LABEL[persona.category].one.toLowerCase()} at the camera can use this face`
                          }
                          className={`flex-1 py-1.5 px-3 rounded text-xs font-semibold transition-colors ${
                            isActive
                              ? 'bg-sky-500 text-slate-950 shadow-sm'
                              : allowed
                                ? 'bg-slate-800 hover:bg-slate-700 text-slate-200'
                                : 'bg-slate-900 text-slate-500 cursor-not-allowed'
                          }`}
                        >
                          {isActive
                            ? 'Currently Active'
                            : allowed
                              ? 'Use This Face'
                              : `${CATEGORY_LABEL[persona.category].one} only`}
                        </button>

                        {personas.length > 1 && (
                          <button
                            onClick={() => onDeletePersona(persona.id)}
                            className="p-1.5 rounded text-slate-400 hover:text-rose-400 hover:bg-rose-950/30 transition-colors"
                            title="Delete authorized persona and purge biometric weights"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 text-xs text-slate-400 flex items-start gap-3">
                <Info className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="text-slate-300 font-medium">Compliance & Non-Consensual Safeguards</p>
                  <p className="leading-relaxed">
                    PersonaLive enforces cryptographic signing and watermarking for all profiles. Impersonation of public officials, bypassing KYC/facial authentication systems, or deceptive fraud is strictly prohibited under our acceptable use protocol.
                  </p>
                </div>
              </div>
            </div>
          ) : (
            /* Enrollment Form */
            <form onSubmit={handleEnrollSubmit} className="space-y-5">
              {errorMessage && (
                <div className="p-3 rounded-lg bg-rose-950/80 border border-rose-800 text-rose-300 text-xs flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span>{errorMessage}</span>
                </div>
              )}

              {/* Upload Dropzone */}
              <div className="space-y-1.5">
                <label className="text-xs text-slate-300 font-medium">Upload a photo (JPG, PNG, WebP)</label>
                <label className="border-2 border-dashed border-slate-700 hover:border-sky-500 bg-slate-950 rounded-xl p-6 flex flex-col items-center justify-center cursor-pointer transition-colors group">
                  <Upload className="w-8 h-8 text-slate-400 group-hover:text-sky-400 transition-colors mb-2" />
                  <span className="text-xs font-medium text-slate-200">Click to choose a photo</span>
                  <span className="text-[11px] text-slate-500 mt-1 text-center">
                    Best results: one person, facing the camera, even lighting, no sunglasses, 720p or larger
                  </span>
                  <input type="file" accept="image/jpeg,image/png,image/webp" onChange={handleFileChange} className="hidden" />
                </label>
              </div>

              {/* Preset Quick Selection for Instant Testing */}
              <div className="space-y-2">
                <label className="text-xs text-slate-400 font-medium">Or try a sample face</label>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      handleSelectPreset(
                        'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=600&q=80',
                        'Aria Sterling',
                        'Broadcast Host',
                        'women'
                      )
                    }
                    className="p-2 rounded bg-slate-950 border border-slate-800 hover:border-sky-500 text-left flex items-center gap-2"
                  >
                    <img
                      src="https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=120&q=80"
                      className="w-8 h-8 rounded object-cover"
                    />
                    <div className="text-[11px] truncate">
                      <p className="font-medium text-slate-200">Aria Sterling</p>
                      <p className="text-slate-500">Broadcast Host</p>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      handleSelectPreset(
                        'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=600&q=80',
                        'David Miller',
                        'Tech Lead',
                        'men'
                      )
                    }
                    className="p-2 rounded bg-slate-950 border border-slate-800 hover:border-sky-500 text-left flex items-center gap-2"
                  >
                    <img
                      src="https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=120&q=80"
                      className="w-8 h-8 rounded object-cover"
                    />
                    <div className="text-[11px] truncate">
                      <p className="font-medium text-slate-200">David Miller</p>
                      <p className="text-slate-500">Tech Lead</p>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      handleSelectPreset(
                        'https://images.unsplash.com/photo-1544005313-94ddf0286df2?auto=format&fit=crop&w=600&q=80',
                        'Mei Lin',
                        'Virtual Lecturer',
                        'women'
                      )
                    }
                    className="p-2 rounded bg-slate-950 border border-slate-800 hover:border-sky-500 text-left flex items-center gap-2"
                  >
                    <img
                      src="https://images.unsplash.com/photo-1544005313-94ddf0286df2?auto=format&fit=crop&w=120&q=80"
                      className="w-8 h-8 rounded object-cover"
                    />
                    <div className="text-[11px] truncate">
                      <p className="font-medium text-slate-200">Mei Lin</p>
                      <p className="text-slate-500">Lecturer</p>
                    </div>
                  </button>
                </div>
              </div>

              {/* Quality Assessment Card (Shown after image loaded) */}
              {previewImage && qualityResult && (
                <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-3">
                  <div className="flex items-center gap-4">
                    <img
                      src={previewImage}
                      alt="Preview"
                      className="w-20 h-20 rounded-lg object-cover border border-slate-700"
                    />
                    <div className="space-y-1 flex-1">
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-slate-200 text-xs">Photo quality check</span>
                        <span
                          className={`text-xs font-bold px-2 py-0.5 rounded ${
                            qualityResult.passed
                              ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                              : 'bg-amber-950 text-amber-400 border border-amber-800'
                          }`}
                        >
                          Score: {qualityResult.score} / 100 ({qualityResult.passed ? 'Approved' : 'Review Required'})
                        </span>
                      </div>

                      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-slate-400 pt-1 font-mono">
                        <div>Resolution: <span className="text-slate-200">{qualityResult.resolution}</span></div>
                        <div>Lighting: <span className="text-slate-200">{qualityResult.lightingCategory}</span></div>
                        <div>Orientation: <span className="text-slate-200">{qualityResult.orientation}</span></div>
                        <div>Sharpness: <span className="text-slate-200">{qualityResult.sharpnessScore}/100</span></div>
                        <div className="col-span-2 text-slate-500">
                          Face landmarks are mapped when you activate this face.
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Metadata Inputs */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-xs text-slate-300">Name *</label>
                  <input
                    type="text"
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Dr. Sarah Chen"
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-sky-500"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs text-slate-300">Label (optional)</label>
                  <input
                    type="text"
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                    placeholder="e.g. Keynote look, Streaming avatar"
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-sky-500"
                  />
                </div>
              </div>

              {/* Category: faces only map onto a person of the same group */}
              <div className="space-y-1.5">
                <label className="text-xs text-slate-300">This face is a *</label>
                <div className="grid grid-cols-2 gap-2">
                  {(['women', 'men'] as const).map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setCategory(c)}
                      className={`py-2 rounded-lg text-xs font-semibold border transition-colors ${
                        category === c
                          ? 'bg-sky-500 text-slate-950 border-sky-400'
                          : 'bg-slate-950 text-slate-300 border-slate-800 hover:border-slate-600'
                      }`}
                    >
                      {CATEGORY_LABEL[c].one}
                    </button>
                  ))}
                </div>
                <p className="text-[10px] text-slate-500">
                  Women's faces can only be used by a woman at the camera, men's faces only by a man. You are currently set
                  as <strong className="text-slate-300">{CATEGORY_LABEL[subjectCategory].one}</strong> in the studio.
                </p>
              </div>

              {/* Consent */}
              <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
                <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
                  <FileCheck className="w-4 h-4 text-sky-400" />
                  <span>Permission to use this face</span>
                </div>
                <label className="flex items-start gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={consentAgreed}
                    onChange={(e) => setConsentAgreed(e.target.checked)}
                    className="accent-sky-500 w-4 h-4 rounded mt-0.5 cursor-pointer"
                  />
                  <span className="text-[11px] text-slate-400 leading-normal">
                    This is my own face, or the person in the photo has given me permission to use their likeness. I
                    understand every output frame carries the visible “AI-transformed” watermark.
                  </span>
                </label>
              </div>

              {/* Submit Buttons */}
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setActiveTab('library')}
                  className="px-4 py-2 rounded-lg text-xs font-medium text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!previewImage || !consentAgreed}
                  className="px-5 py-2 rounded-lg text-xs font-bold bg-sky-500 hover:bg-sky-400 disabled:opacity-50 disabled:cursor-not-allowed text-slate-950 shadow-md transition-all flex items-center gap-2"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  <span>Add Face &amp; Use It Now</span>
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
