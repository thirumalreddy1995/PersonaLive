/**
 * Personas that live outside the repository.
 *
 * Photos of real people never ship with the web app. `references/personas.json` (gitignored, see
 * `references/README.md`) lists local photos together with their consent records; the Vite plugin
 * in `vite.config.ts` injects that manifest as `__PL_LOCAL_PERSONAS__` and serves the listed files
 * under `references/` for the dev server, the local production build and the desktop build. On
 * GitHub Pages the folder does not exist, so the build ships only the sample personas.
 *
 * Quality metrics are measured from the actual image at load time, never typed into the manifest.
 */
import { AuthorizedPersona, PersonaCategory } from '../types/index.ts';
import { loadSignedConsent } from '../components/ConsentForm.tsx';
import { publicAssetUrl } from './assetUrl.ts';
import { assessPhoto } from './photoAssessment.ts';

export interface LocalPersonaManifestEntry {
  id: string;
  name: string;
  role?: string;
  category: PersonaCategory;
  /** Path served by the app (relative to the base URL), set by the Vite plugin. */
  file: string;
  consent: AuthorizedPersona['consent'];
}

declare const __PL_LOCAL_PERSONAS__: LocalPersonaManifestEntry[] | undefined;

function manifest(): LocalPersonaManifestEntry[] {
  try {
    return typeof __PL_LOCAL_PERSONAS__ === 'undefined' ? [] : __PL_LOCAL_PERSONAS__;
  } catch {
    return [];
  }
}

/** Shown until the photo has been measured. */
export const UNMEASURED_RESOLUTION = 'measuring…';

/** Local personas with placeholder metrics; call {@link measureLocalPersona} to fill them in. */
export function localPersonas(): AuthorizedPersona[] {
  return manifest().map((entry) => ({
    id: entry.id,
    name: entry.name,
    role: entry.role ?? 'Verified Presenter',
    category: entry.category,
    imageUrl: publicAssetUrl(entry.file),
    createdAt: entry.consent.timestamp.slice(0, 10),
    qualityScore: 0,
    metrics: {
      resolution: UNMEASURED_RESOLUTION,
      sharpness: 0,
      lighting: 'Acceptable',
      orientation: 'Frontal',
      obstruction: 'None',
      singleFaceVerified: true,
    },
    consent: loadSignedConsent(entry.id) ?? entry.consent,
  }));
}

/** Replaces the placeholder metrics with values measured from the image itself. */
export async function measureLocalPersona(persona: AuthorizedPersona): Promise<AuthorizedPersona> {
  const q = await assessPhoto(persona.imageUrl, false);
  return {
    ...persona,
    qualityScore: q.score,
    metrics: {
      ...persona.metrics,
      resolution: q.resolution,
      sharpness: q.sharpnessScore,
      lighting: q.lightingCategory,
      orientation: q.orientation,
    },
  };
}
