/**
 * Helpers for referencing files that live in `public/`.
 *
 * Vite rewrites asset URLs it can see (HTML attributes, CSS, imports) to honour the configured
 * `base`, but plain string literals in TypeScript are left untouched. A hard-coded
 * `/assets/foo.jpg` therefore 404s when the app is served from a sub-path such as GitHub Pages
 * (`/PersonaLive/`). Always go through {@link publicAssetUrl} instead.
 */

/** Joins a `public/`-relative path onto a base URL, normalising slashes. */
export function resolvePublicAssetUrl(relativePath: string, baseUrl: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const path = relativePath.replace(/^\/+/, '');
  return `${base}${path}`;
}

/** Resolves a `public/`-relative path against Vite's `import.meta.env.BASE_URL`. */
export function publicAssetUrl(relativePath: string): string {
  const baseUrl = (import.meta.env?.BASE_URL as string | undefined) ?? '/';
  return resolvePublicAssetUrl(relativePath, baseUrl);
}
