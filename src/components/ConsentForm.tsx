import React, { useEffect, useState } from 'react';
import { ShieldCheck, Download } from 'lucide-react';
import { AuthorizedPersona, ConsentRecord, CONSENT_FORM_VERSION } from '../types/index.ts';

/**
 * Consent record form (R3c item 6). The person in the photo fills this in themselves: signer,
 * date, scope (live calls, cloud processing, recordings) and the SHA-256 of the photo(s) the
 * consent covers. The record is stored locally (localStorage, keyed by persona id) so the gate
 * opens on this machine, and offered as JSON to paste into references/personas.json. Until it is
 * signed the persona stays "pending" and cannot be used.
 */

export const CONSENT_STORAGE_PREFIX = 'pl_consent_';

/** SHA-256 hex of an image URL's bytes (null when it cannot be fetched or hashed). */
export async function hashImageUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    const buf = await res.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return null;
  }
}

export function loadSignedConsent(personaId: string): ConsentRecord | null {
  try {
    const raw = localStorage.getItem(CONSENT_STORAGE_PREFIX + personaId);
    if (!raw) return null;
    const rec = JSON.parse(raw) as ConsentRecord;
    return rec && rec.status === 'signed' ? rec : null;
  } catch {
    return null;
  }
}

interface ConsentFormProps {
  persona: AuthorizedPersona;
  onSigned: (record: ConsentRecord) => void;
  onCancel: () => void;
}

export const ConsentForm: React.FC<ConsentFormProps> = ({ persona, onSigned, onCancel }) => {
  const [signerName, setSignerName] = useState(persona.consent.signerName || '');
  const [liveCalls, setLiveCalls] = useState(persona.consent.scope?.liveCalls ?? true);
  const [cloudProcessing, setCloudProcessing] = useState(persona.consent.scope?.cloudProcessing ?? false);
  const [recordings, setRecordings] = useState(persona.consent.scope?.recordings ?? false);
  const [isSubject, setIsSubject] = useState(false);
  const [hash, setHash] = useState<string | null>(persona.consent.imageHashes?.[0] ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void hashImageUrl(persona.imageUrl).then((h) => {
      if (!cancelled && h) setHash(h);
    });
    return () => {
      cancelled = true;
    };
  }, [persona.imageUrl]);

  const submit = () => {
    if (!signerName.trim()) return setError('Enter the name of the person in the photo.');
    if (!isSubject) return setError('Only the person in the photo can sign this record.');
    if (!hash) return setError('The photo could not be hashed; try again.');
    const expected = persona.consent.imageHashes?.[0];
    if (expected && expected !== hash) return setError('This photo does not match the hash on the pending record.');
    const signedAt = new Date().toISOString();
    const scope = { liveCalls, cloudProcessing, recordings };
    const usage = [liveCalls && 'live video calls where all participants know they see a persona', cloudProcessing && 'opt-in cloud processing of face crops (no frames stored)', recordings && 'recordings of such calls']
      .filter(Boolean)
      .join('; ');
    const record: ConsentRecord = {
      status: 'signed',
      signerName: signerName.trim(),
      authorizedUsage: usage || 'no usage granted',
      timestamp: signedAt,
      signedAt,
      scope,
      imageHashes: [hash],
      formVersion: CONSENT_FORM_VERSION,
      signatureHash: `sha256:${hash.slice(0, 16)}@${signedAt.slice(0, 10)}`,
      verified: liveCalls,
    };
    try {
      localStorage.setItem(CONSENT_STORAGE_PREFIX + persona.id, JSON.stringify(record));
    } catch {
      /* storage may be unavailable; the download below still carries the record */
    }
    onSigned(record);
  };

  const download = () => {
    const record = { id: persona.id, consent: { ...persona.consent, signerName, scope: { liveCalls, cloudProcessing, recordings }, imageHashes: hash ? [hash] : [] } };
    const blob = new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${persona.id}-consent.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="mt-3 p-3 rounded-lg border border-amber-700/60 bg-amber-950/20 text-[11px] text-slate-300 space-y-2" data-testid="consent-form">
      <div className="flex items-center gap-2 text-amber-300 font-semibold">
        <ShieldCheck className="w-3.5 h-3.5" /> Consent record for {persona.name}
      </div>
      <p className="text-slate-400">
        To be completed by the person in the photo. The record covers the photo whose SHA-256 is{' '}
        <span className="font-mono text-[10px] text-slate-500 break-all">{hash ?? 'computing…'}</span>.
      </p>
      <label className="block">
        <span className="text-slate-400">Your name (as the person pictured)</span>
        <input value={signerName} onChange={(e) => setSignerName(e.target.value)} className="mt-1 w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-slate-100" />
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
      <label className="flex items-center gap-2 text-slate-200">
        <input type="checkbox" checked={isSubject} onChange={(e) => setIsSubject(e.target.checked)} className="accent-amber-500" /> I am the person in this photo and I am signing this myself.
      </label>
      {error && <p className="text-rose-400">{error}</p>}
      <div className="flex items-center gap-2 pt-1">
        <button onClick={submit} className="px-3 py-1.5 rounded bg-amber-500 text-slate-950 font-semibold hover:bg-amber-400">
          Sign ({new Date().toISOString().slice(0, 10)})
        </button>
        <button onClick={download} className="px-2 py-1.5 rounded bg-slate-800 text-slate-200 hover:bg-slate-700 flex items-center gap-1" title="Download the record as JSON to paste into references/personas.json">
          <Download className="w-3 h-3" /> JSON
        </button>
        <button onClick={onCancel} className="px-2 py-1.5 rounded text-slate-400 hover:text-slate-200">
          Cancel
        </button>
      </div>
    </div>
  );
};
