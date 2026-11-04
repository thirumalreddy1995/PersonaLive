# PersonaLive – Repository Gap Analysis

- **Branch:** `chore/code-quality-gap-fixes-20261104` (from `main` @ `d010fef`)
- **Date:** 2026-11-04
- **Scope:** entire repository – Vite/React/TypeScript studio (`src/`), Electron shell (`electron/`), PWA assets (`public/`), CI workflows, Python research pipeline (`*.py`), packaging.

## Baseline (before any change)

| Check | Result |
| --- | --- |
| `npm run lint` (`tsc --noEmit`) | 0 errors (but `strict` is off) |
| `tsc --strict --noUnusedLocals --noUnusedParameters` | 31 errors in 13 files (unused imports/locals/params) |
| `npm test` | 23 / 23 pass |
| `npm run build` | OK; 1 warning (main chunk 546 kB > 500 kB) |
| `npm audit` | cannot run – **no `package-lock.json`** |
| GitHub Actions | both workflows run `npm ci`, which requires a lockfile → failing since commit `799a7c4` (last successful Pages deploy is `ac892ca`) |
| Python | `ast.parse` OK on all 4 modules; no tests; deps not installed locally (`main_stream.py` cannot even be imported, see GAP-041) |

## Results after remediation

| Check | Before | After |
| --- | --- | --- |
| `npm run lint` | 0 errors, `strict` off | 0 errors with `strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch` |
| `npm test` | 23 / 23 pass | 39 / 39 pass (5 new suites: asset URLs, image statistics, contrast scoring, Electron path containment) |
| `npm run build` | OK, 1 chunk-size warning | OK, same warning (GAP-035 deferred) |
| `npm audit` | cannot run (no lockfile) | runs; 29 advisories, all transitive through the Electron build toolchain (GAP-040) |
| `npm ci` | fails (no lockfile) | succeeds from the committed `package-lock.json` (validated in a clean directory) |
| CI runtime | Node 20 (EOL) | Node 22 |
| Python | `main_stream.py` raises `NameError` on import | all four modules compile; entry point imports |

## Summary

| Severity | Count | Fixed | Deferred | Blocked | Needs Decision |
| --- | --- | --- | --- | --- | --- |
| Critical | 1 | 1 | 0 | 0 | 0 |
| High | 5 | 5 | 0 | 0 | 0 |
| Medium | 24 | 17 | 2 | 0 | 5 |
| Low | 11 | 7 | 2 | 0 | 2 |
| **Total** | **41** | **30** | **4** | **0** | **7** |

| Category | Count |
| --- | --- |
| Correctness & bugs | 9 |
| Error handling & resilience | 8 |
| Security | 4 |
| Performance | 3 |
| Concurrency | 1 |
| Code quality & maintainability | 7 |
| Compiler / analyzer warnings | 1 |
| Logging & observability | 1 |
| Testing gaps | 1 |
| Dependencies & configuration | 6 |

Status legend: **Fixed** / **Deferred** (recommendation recorded, not applied) / **Blocked** / **Needs Decision** (requires an API, contract, product or data decision).

---

## Findings

### Critical

#### GAP-001 · Dependencies & configuration · Critical · **Fixed**
- **Where:** `package.json`, `.github/workflows/deploy-pages.yml:31`, `.github/workflows/desktop-release.yml:32`
- **Problem:** `package-lock.json` was deleted in `799a7c4` ("configure dev server…"). Both workflows run `npm ci`, which aborts without a lockfile, so no Pages deploy or desktop release has succeeded since. `npm audit` cannot run either.
- **Fix:** regenerate and commit `package-lock.json` (lockfile v3) from the resolved tree; `npm ci --ignore-scripts` from the committed files was verified in a clean directory.
- **Risk:** none (restores reproducible installs).

### High

#### GAP-002 · Correctness · High · **Fixed**
- **Where:** `src/utils/mockPersonas.ts:9`, `src/components/PersonaLibraryModal.tsx:369,378`
- **Problem:** The bundled persona photo is referenced by the absolute path `/assets/aistudio/…jpeg`. Vite only rebases URLs it processes (HTML, CSS, imports); string literals are left as-is. Verified with `VITE_BASE=/PersonaLive/`: `index.html` links become `/PersonaLive/…` but the bundle still contains `/assets/aistudio/…`. On GitHub Pages the default “men” persona (the one selected at first launch) 404s and the studio shows “Could not load the persona photo”.
- **Fix:** add `publicAssetUrl()` (`src/utils/assetUrl.ts`) that prefixes `import.meta.env.BASE_URL`; use it for the two references. Unit-tested.
- **Risk:** none at `/`; fixes Pages/`/<repo>/` deployments.

#### GAP-003 · Correctness / UX · High · **Fixed** (behaviour change)
- **Where:** `public/sw.js:18`, `src/hooks/usePWAInstall.ts:47-75`
- **Problem:** The service worker calls `self.skipWaiting()` during `install`, so a new build activates immediately, `controllerchange` fires and the page **force-reloads in the middle of a session** (e.g. during a live call). Because the worker never enters the `waiting` state, the documented “Update Ready — Restart” button almost never appears.
- **Fix:** remove the install-time `skipWaiting()`; the worker already honours the `SKIP_WAITING` message that the button sends.
- **Risk / behaviour change:** updates now apply when the user clicks the button or relaunches, exactly as README describes, instead of reloading unexpectedly.

#### GAP-004 · Error handling & resilience · High · **Fixed**
- **Where:** `src/utils/meshWarpRenderer.ts:170-240`, `src/utils/facialEngine.ts:140-170`
- **Problem:** `initGL()` throws on shader compile/link failure. The throw escapes `RealtimeFacialEngine`'s constructor and the `useEffect` in `StudioViewport`, unmounting the whole React tree (blank screen). WebGL context loss (`webglcontextlost`) is not handled: every frame then throws, `console.error` is spammed at 60 Hz and the overlay never comes back.
- **Fix:** catch GL initialisation failures and fall back to the Canvas 2D path; listen for `webglcontextlost`/`webglcontextrestored`, skip rendering while lost and rebuild program, buffers and texture on restore.
- **Risk:** none on healthy GPUs.

#### GAP-005 · Correctness · High · **Fixed** (behaviour change)
- **Where:** `src/components/PersonaLibraryModal.tsx:82,98`, `src/utils/faceMath.ts:165-231`
- **Problem:** The “Photo quality check” card shows Lighting/Sharpness values that are never measured: `evaluateImageQuality(w, h, 132, 52, 92)` passes constants, and presets pass `1920×1080`. `contrastStdDev` is accepted but ignored. Users are told a dark/blurry photo is “Optimal”.
- **Fix:** add `measureImageStatistics()` (mean luminance, contrast σ, Laplacian-variance sharpness mapped to 0–100) computed on a down-sampled canvas; use it for uploads and presets; make `contrastStdDev` apply a small low-contrast penalty.
- **Risk / behaviour change:** quality scores now reflect the actual image, so some photos previously “Approved” may show “Review Required” (enrolment is still allowed). The sharpness→score mapping is a documented heuristic. **[QUESTION]** calibrate thresholds against real reference photos.

#### GAP-041 · Correctness (Python) · High · **Fixed**
- **Where:** `main_stream.py:18,294`
- **Problem:** `run_stream(self, source: Any = 0, …)` is annotated with `Any`, which was never imported. Annotations are evaluated when the class body executes, so `python main_stream.py` (or any import of the module) raised `NameError: name 'Any' is not defined` before doing anything: the Python pipeline entry point could not start.
- **Fix:** import `Any`; drop the unused `sys` import. Committed together with GAP-020.
- **Risk:** none.

### Medium

#### GAP-006 · Security · Medium · **Fixed**
- **Where:** `electron/main.cjs:42-43`
- **Problem:** `file.startsWith(DIST_DIR)` has no trailing separator, so a sibling directory such as `dist-old/` would pass the containment check.
- **Fix:** use `path.relative()` and reject paths that start with `..` or are absolute.
- **Risk:** none.

#### GAP-007 · Error handling · Medium · **Fixed**
- **Where:** `electron/main.cjs:96,113-114`
- **Problem:** `autoUpdater.checkForUpdatesAndNotify()` rejects when offline or when no release exists → unhandled promise rejection in the main process. The `check-for-updates` IPC handler returns an `UpdateCheckResult` containing non-serialisable objects.
- **Fix:** catch and log updater errors; return a plain `{status, version}` object over IPC.
- **Risk:** none.

#### GAP-008 · Concurrency · Medium · **Fixed**
- **Where:** `src/utils/faceTracker.ts:159-168`
- **Problem:** `detectImage()` lazily creates the IMAGE-mode landmarker with `if (!this.imageLandmarker) this.imageLandmarker = await …`. Two quick persona switches race and create two landmarkers; one leaks.
- **Fix:** memoise the creation promise; clear it in `dispose()`.
- **Risk:** none.

#### GAP-009 · Performance · Medium · **Fixed**
- **Where:** `src/utils/facialEngine.ts:580,620,667`
- **Problem:** `computeKinematics()` runs twice per frame on identical input (metrics + overlay), allocating ~20 objects each; `warp.updateUVs()` re-uploads the UV buffer to the GPU every frame even when the selected keyframe is unchanged.
- **Fix:** compute kinematics once per frame and pass it down; track the active keyframe id and upload UVs only on change.
- **Risk:** none (pure refactor).

#### GAP-010 · Resource disposal · Medium · **Fixed**
- **Where:** `src/hooks/usePWAInstall.ts:43-75`, `src/components/StudioViewport.tsx:76-79`
- **Problem:** The 15-minute update poll is cleared only on `beforeunload`, never on unmount; the `controllerchange` listener is never removed; `install()` does not handle `prompt()` rejections. The toast timer is not tracked, so an old timer dismisses a newer toast and `setState` runs after unmount.
- **Fix:** clear interval/listeners in effect cleanup; track the toast timer in a ref; wrap `prompt()` in try/catch.
- **Risk:** none.

#### GAP-011 · Error handling · Medium · **Fixed**
- **Where:** `src/components/PersonaLibraryModal.tsx:72-88`
- **Problem:** `img.onload` is assigned **after** `img.src`; no `onerror` on `FileReader` or `Image`; no file-size guard. A corrupt or oversized file fails silently.
- **Fix:** assign handlers before `src`, surface errors in the existing error banner, cap uploads at 25 MB.
- **Risk:** none.

#### GAP-012 · Error handling · Medium · **Fixed**
- **Where:** `src/components/StudioViewport.tsx:224-261`
- **Problem:** `MediaRecorder` has no `onerror`; an encoder failure leaves the UI in “recording” state with the capture stream still running.
- **Fix:** handle `onerror`, stop tracks, reset state and show an error toast.
- **Risk:** none.

#### GAP-013 · Resilience (offline) · Medium · **Fixed**
- **Where:** `public/sw.js:43-69`
- **Problem:** When offline and the request is not cached, `caches.match()` resolves `undefined`, `respondWith(undefined)` throws and the browser shows a network error instead of the cached app shell. `cache.put()` runs outside `event.waitUntil()` so the worker may be terminated before the write finishes.
- **Fix:** fall back to cached `index.html` for navigation requests, return a 504 `Response` otherwise, and wrap cache writes in `waitUntil`.
- **Risk:** none.

#### GAP-014 · Dependencies · Medium · **Fixed** (partially – see GAP-034)
- **Where:** `package.json`
- **Problem:** Build tooling (`vite`, `@vitejs/plugin-react`, `@tailwindcss/vite`) is listed under `dependencies`; electron-builder packages production dependencies, so the desktop installer ships the Vite toolchain. `motion` and `autoprefixer` are unused (Tailwind v4 does not need autoprefixer). `express`, `dotenv`, `@google/genai`, `@types/express` are unused Gemini-server scaffolding (`metadata.json` still declares `SERVER_SIDE_GEMINI_API`).
- **Fix:** move build tooling to `devDependencies`; remove `motion` and `autoprefixer`; lockfile regenerated. The Gemini/express group is **Needs Decision** (GAP-034).
- **Risk:** none for the web bundle (verified by build + tests). Run `npm prune` locally once to drop the now-extraneous packages from `node_modules`.

#### GAP-015 · Dependencies / CI · Medium · **Fixed**
- **Where:** `.github/workflows/*.yml`
- **Problem:** Workflows pin Node 20, which reached end-of-life on 2026-04-30. Vite 8 requires `^20.19 || >=22.12`.
- **Fix:** use Node 22 in both workflows and declare `engines.node` in `package.json`.
- **Risk:** low; same toolchain, supported runtime.

#### GAP-016 · Compiler & analyzer warnings · Medium · **Fixed**
- **Where:** `tsconfig.json`, 13 source files
- **Problem:** `strict` is not enabled (no `strictNullChecks`), and unused-code checks are off: 31 unused imports, state setters, parameters and private members (full list in the baseline run).
- **Fix:** enable `strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`; remove the dead code. `npm run lint` now enforces it.
- **Risk:** none at runtime.

#### GAP-017 · Maintainability · Medium · **Fixed**
- **Where:** `src/components/DesktopTitlebar.tsx:54` (`v2.5.0`), `LoginPage.tsx:182` (`Version 2.4.1`), `UserGuideModal.tsx:52` (`v2.4`), `package.json` (`2.5.0`)
- **Problem:** The version string is duplicated in three components and already diverges.
- **Fix:** inject `__PL_APP_VERSION__` from `package.json` in `vite.config.ts` and use it everywhere.
- **Risk:** displayed text changes from the stale `2.4.x` strings to the real version.

#### GAP-018 · Code quality · Medium · **Fixed**
- **Where:** `index.html:19-31`, `src/main.tsx:4-17`
- **Problem:** The same `console.error` filter for MediaPipe INFO logs is implemented twice (inline script + module). The inline script also complicates any future CSP.
- **Fix:** keep the typed implementation in `src/main.tsx`, delete the inline copy.
- **Risk:** none.

#### GAP-019 · Correctness · Medium · **Fixed**
- **Where:** `src/utils/facialEngine.ts:260,212-222`
- **Problem:** `updateSettings()` indexes `RESOLUTIONS[...]` without the fallback the constructor uses → `TypeError` on an unexpected value. Image `onload` callbacks (demo subject, persona) can fire after `dispose()` and emit status to an unmounted component.
- **Fix:** shared `resolveResolution()` with fallback; `disposed` flag checked in callbacks.
- **Risk:** none.

#### GAP-020 · Error handling (Python) · Medium · **Fixed**
- **Where:** `blender.py:281-283`, `mouth_render.py:522`, `main_stream.py:57-93`
- **Problem:** `except Exception as e: pass` silently discards Poisson-clone failures; the optical-flow fallback swallows errors without a trace; `warp_triangle()` calls `cv2.getAffineTransform` on possibly degenerate (zero-area) triangles and raises `cv2.error`, which aborts the whole stream.
- **Fix:** log exceptions with context at `warning`/`debug` level; skip degenerate triangles.
- **Risk:** none (fallback paths unchanged).

#### GAP-021 · Logging & observability (Python) · Medium · **Fixed**
- **Where:** all `*.py`
- **Problem:** Diagnostics use bare `print()`, so there are no levels, timestamps or a way to silence library modules when imported.
- **Fix:** module-level `logging.getLogger(__name__)`; `main_stream.py` configures `logging.basicConfig` and keeps the interactive key-binding help on stdout.
- **Risk:** log line format changes (now prefixed with level and module).

#### GAP-022 · Packaging · Medium · **Fixed**
- **Where:** `package.json` `build.files`, `electron/main.cjs:67`
- **Problem:** The window icon is loaded from `../public/pwa-512x512.png`, but `public/` is not in `build.files`, so the packaged app has no window icon.
- **Fix:** add `public/pwa-512x512.png` to `build.files`.
- **Risk:** none.

#### GAP-023 · Rendering correctness · Medium · **Needs Decision** [QUESTION]
- **Where:** `src/utils/cranialBoundaryBlender.ts:95-161`, `src/utils/facialEngine.ts:142`
- **Problem:** `harmonizeForeheadBoundary()` fills a band with `globalCompositeOperation = 'destination-out'` on the main output context, which was created with `{ alpha: false }`. On an opaque canvas “erasing” darkens pixels toward black rather than revealing the driver frame underneath; the band is also applied over the already-composited video, so it darkens the user's own forehead too. The `opts` argument (`blendStrength`, `colorGain`) is unused.
- **Recommendation:** apply the feather on the warp layer (`MeshWarpRenderer.canvas`, which has alpha) before compositing, or drop the pass in favour of the shader's `cranialFalloff`. Visual tuning requires review on real footage, so not changed here.

#### GAP-024 · Security (authentication) · Medium · **Needs Decision**
- **Where:** `src/components/LoginPage.tsx:9-10,25-34`, `src/components/AccountAuthModal.tsx:33-51`, `src/App.tsx:53-61`
- **Problem:** Login pre-fills `admin@personalive.ai / admin123`, accepts any non-empty credentials, and persists `pl_auth=true` in `localStorage`; OTP verification accepts any 6-character input; a licence key is hard-coded. This is clearly a demo gate, but it reads like real authentication.
- **Recommendation:** either label the screen as a demo and remove the pre-filled password, or replace it with real auth. Both change user-visible contracts, so left for product decision.

#### GAP-025 · Product claim / UX · Medium · **Needs Decision**
- **Where:** `src/components/VirtualCamDialog.tsx:45-59`, `README.md` (“Using the output in video calls”)
- **Problem:** The dialog claims a “DirectShow / CoreMedia Virtual Sink” that “exposes the transformed frame buffer as an OS webcam device”, but `virtualCameraActive` only toggles a boolean badge; README correctly says OBS Virtual Camera is required.
- **Recommendation:** reword the dialog to the OBS workflow (as README) or implement a real virtual camera in the Electron shell. Copy/feature decision.

#### GAP-026 · Repository hygiene / sensitive data · Medium · **Needs Decision**
- **Where:** `.aistudio/artifacts/**/.tempmediaStorage/*` (20 screenshots/photos), `public/assets/aistudio/` (30 MB `.webm` live session, 0.8 MB `.mp4`, 5 unreferenced images)
- **Problem:** Temporary tool media is committed; `public/` content is copied into every web build and Pages deploy (≈33 MB per deploy). The folder holds photos and a recorded session of a real person; the only consent record is the mock entry in `mockPersonas.ts`. The Python pipeline uses the same folder as its default `--ref_dir`.
- **Recommendation:** add `.aistudio/**/.tempmediaStorage/` to `.gitignore` and remove it from history; move Python reference media out of `public/` (e.g. `references/`, Git LFS) and keep only the one photo the web app needs; confirm consent for the stored likeness. Deleting data is left to you.

#### GAP-040 · Dependencies · Medium · **Needs Decision**
- **Where:** `package.json` devDependencies `electron@^33.2.1`, `electron-builder@^25.1.8`
- **Problem:** With the lockfile restored, `npm audit` reports 29 advisories (1 critical, 13 high, 15 moderate). Every one is transitive through the Electron build toolchain (`tar`, `minimatch`, `glob`, `extract-zip`, `app-builder-lib`, `@electron/rebuild`, …). None is part of the shipped web bundle or the Electron runtime; they affect the machine that builds installers.
- **Recommendation:** upgrade `electron-builder` to 26.x and `electron` to the current major (45.x). Both are semver-major and change the installer toolchain and Chromium version, so they need a desktop build plus a smoke test of camera access, WebGL and auto-update, which could not be done in this pass.

#### GAP-027 · Security · Medium · **Deferred**
- **Where:** `index.html`, `electron/main.cjs`
- **Problem:** No Content-Security-Policy. The renderer loads WASM (`wasm-unsafe-eval`), blob workers, images from Unsplash and the model from `storage.googleapis.com`.
- **Recommendation:** add a CSP meta tag (`default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; img-src 'self' data: blob: https://images.unsplash.com; connect-src 'self' https://storage.googleapis.com https://images.unsplash.com; media-src blob:`) and verify in-browser; not applied without a runtime check.

#### GAP-028 · Resilience · Medium · **Deferred**
- **Where:** `src/utils/faceTracker.ts:56-79`
- **Problem:** The 3.7 MB model download has no stall detection or retry; a hung connection leaves the loading card at a fixed percentage forever (the “Try Again” button is the only recovery).
- **Recommendation:** abort if no bytes arrive for 30 s and retry once; needs a real-network check before changing the first-run experience.

### Low

#### GAP-029 · Code quality · Low · **Fixed**
- **Where:** `src/components/StudioViewport.tsx:84-106`
- **Problem:** The mount effect calls `setPersona`, `setSplitPosition` and `updateSettings`, and the dedicated effects for those props run immediately afterwards → the persona image is requested twice on mount.
- **Fix:** let the per-prop effects do the initial sync.

#### GAP-030 · Dead code · Low · **Fixed**
- **Where:** `cranialBoundaryBlender.ts:42-55` (`getOffscreen`), `multiReferenceBank.ts:61,91,179` (`secondaryKeyframeId`, `getKeyframeById`), `StudioViewport.tsx:73-74` (`recordingSecondsRef`), `oralCavityRenderer.ts:32,244` (`blendStrength`, `isSmiling` unused), `PersonaLibraryModal.tsx:48` (`imageUrl` state)
- **Fix:** removed with GAP-016.

#### GAP-031 · Code quality · Low · **Fixed**
- **Where:** `src/hooks/usePWAInstall.ts:40`
- **Problem:** `process.env.NODE_ENV` in browser code relies on Vite's compatibility shim; the idiomatic check is `import.meta.env.MODE`.
- **Fix:** switched.

#### GAP-032 · Testing gaps · Low · **Fixed** (partially)
- **Problem:** No coverage for asset-URL resolution, image statistics, electron path containment, `OneEuroFilter.setParams`, `coverLayout`. `facialEngine`/`faceTracker`/`meshWarpRenderer` are DOM/WASM-bound and untested; Python has no tests.
- **Fix:** tests added for every new/changed pure helper (`assetUrl`, `imageStatistics`, `electron/pathContainment`, filter retune). Engine/tracker tests remain **Deferred** (need jsdom + WebGL stubs).

#### GAP-033 · Docs · Low · **Fixed**
- **Where:** `README.md` (Tests section lists 2 suites; 3 exist), `package.json` `test` script lists files explicitly.
- **Fix:** README updated; new test files added to the script.

#### GAP-034 · Dependencies · Low · **Needs Decision**
- **Where:** `package.json`, `metadata.json`, `.env.example`
- **Problem:** `express`, `dotenv`, `@google/genai`, `@types/express` are unused; `metadata.json` declares a server-side Gemini capability and `.env.example` has `GEMINI_API_KEY`, so they look like intentional AI-Studio scaffolding.
- **Recommendation:** remove all four and the `GEMINI_API_KEY` line if no Gemini server is planned; the `clean` script's `server.js` reference goes with them.

#### GAP-035 · Performance · Low · **Deferred**
- **Where:** build output
- **Problem:** Single 546 kB chunk; modals (`UserGuideModal`, `PersonaLibraryModal`, …) are eagerly bundled.
- **Recommendation:** `React.lazy` for modals and a `react` vendor chunk.

#### GAP-036 · Code quality · Low · **Deferred**
- **Problem:** No ESLint configuration although `eslint-disable-next-line react-hooks/exhaustive-deps` comments exist.
- **Recommendation:** add `eslint` + `typescript-eslint` + `eslint-plugin-react-hooks` and a `lint:eslint` script.

#### GAP-037 · Configuration · Low · **Needs Decision**
- **Where:** `tsconfig.json` (`experimentalDecorators`, `useDefineForClassFields: false`, `allowJs`), `vite.config.ts:81` (`allowedHosts: true`)
- **Problem:** Scaffold leftovers. `useDefineForClassFields: false` changes class-field semantics vs. native ES2022 and no decorators are used. `allowedHosts: true` disables Vite's DNS-rebinding protection in dev (needed by AI Studio per the comment).
- **Recommendation:** drop the three tsconfig flags; keep `allowedHosts` only when `DISABLE_HMR`/AI-Studio is detected.

#### GAP-038 · Correctness · Low · **Fixed**
- **Where:** `src/utils/faceMath.ts:165`
- **Problem:** `contrastStdDev` parameter accepted but never used.
- **Fix:** see GAP-005.

#### GAP-039 · UX · Low · **Fixed**
- **Where:** `src/components/DesktopTitlebar.tsx:40-42`
- **Problem:** Decorative close/minimise/maximise dots have `cursor-pointer` and titles but do nothing.
- **Fix:** marked `aria-hidden` and removed the pointer cursor/titles so they no longer look interactive.

---

## Remediation plan (priority order)

1. **Critical:** GAP-001 lockfile.
2. **High:** GAP-002 asset base path → GAP-003 service-worker update flow → GAP-004 WebGL resilience → GAP-005 real photo-quality measurement.
3. **Medium (code):** GAP-006/007/022 Electron → GAP-008 tracker race → GAP-009/019/029 engine → GAP-010/011/012 React lifecycle → GAP-013 SW offline → GAP-016/030/031/039 strict TypeScript & dead code → GAP-017 version → GAP-018 duplicate filter → GAP-020/021 Python.
4. **Medium (config):** GAP-014 dependencies → GAP-015 Node 22.
5. **Low:** GAP-032 tests, GAP-033 docs.
6. **Needs Decision:** GAP-023, 024, 025, 026, 034, 037, 040. **Deferred:** GAP-027, 028, 035, 036.

Each fix is one commit referencing its GAP id; `npm run lint`, `npm run build` and `npm test` were run before every commit. Nothing was blocked or reverted.

## Behaviour changes to be aware of

| GAP | Change |
| --- | --- |
| GAP-003 | A new build no longer force-reloads an open studio; it waits for the “Update Ready — Restart” click or the next launch. |
| GAP-005 | Photo quality scores are measured from the image. Dark, flat or blurry photos now get lower scores and warnings; enrolment is still permitted. |
| GAP-013 | When offline, uncached navigations show the cached app shell instead of a browser error page. |
| GAP-017 | The login footer and user guide now show the real version (`2.5.0`) instead of the stale `2.4.x` strings. |
| GAP-021 | Python diagnostics are emitted through `logging` (format `time LEVEL module: message`) instead of bare `print()`. |
| GAP-039 | The decorative title-bar dots no longer show a pointer cursor or tooltips. |
