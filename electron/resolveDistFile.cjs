// Maps an app:// request path onto a file inside the built web bundle, refusing anything that
// would escape the bundle directory. Kept dependency-free so it can be unit-tested with node:test.
const path = require('path');

/**
 * @param {string} rootDir absolute directory that holds the built bundle (dist/)
 * @param {string} requestPath decoded URL pathname from the app:// request
 * @returns {string | null} absolute file path inside rootDir, or null when the path escapes it
 */
function resolveDistFile(rootDir, requestPath) {
  const root = path.resolve(rootDir);
  let pathname = requestPath || '/';
  if (pathname === '/' || pathname === '') pathname = '/index.html';
  // Strip any leading separators so path.join cannot treat the request as absolute on Windows.
  const relativeRequest = pathname.replace(/^[/\\]+/, '');
  const candidate = path.resolve(root, relativeRequest);
  const relative = path.relative(root, candidate);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return candidate;
}

module.exports = { resolveDistFile };
