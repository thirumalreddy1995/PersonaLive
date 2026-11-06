/// <reference types="vite/client" />

/** Build identifier injected by vite.config.ts (git SHA in CI, timestamp locally). */
declare const __PL_BUILD_ID__: string;
/** App version injected by vite.config.ts from package.json. */
declare const __PL_APP_VERSION__: string;
/** Local personas (references/personas.json) injected by vite.config.ts; absent on GitHub Pages. */
declare const __PL_LOCAL_PERSONAS__: import('./utils/localPersonas.ts').LocalPersonaManifestEntry[] | undefined;

/** True in vite dev and `npm run build:review`; false (and the pending-consent review path compiled out) in every other build. */
declare const __PL_REVIEW_BUILD__: boolean;
