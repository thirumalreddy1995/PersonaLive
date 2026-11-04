# PersonaLive Desktop Studio

> Real-time face transformation that runs entirely on your computer. Upload one clear photo of a face, turn on your webcam, and that face is mapped onto yours live: it follows your head turns, your mouth as you speak, your blinks and your eyebrows.

---

## How it works

Every frame goes through this on-device pipeline:

1. **Tracking** – MediaPipe Face Landmarker detects 478 facial landmarks plus 52 expression blendshapes on the live webcam frame (GPU via WebGL, with automatic CPU/WASM fallback).
2. **Smoothing** – every landmark coordinate is filtered with a 1-Euro filter. The *Movement Smoothness* slider retunes the filter live.
3. **Kinematics** – eye aspect ratio (blink), mouth aspect ratio (speech), head yaw/pitch/roll and iris gaze are derived from the landmarks.
4. **Persona mapping** – when you pick a face, the same landmarker runs once on the photo. Its landmark positions become texture coordinates.
5. **GPU mesh warp** – the photo is drawn through the 852-triangle face tessellation with your landmarks as vertex positions (piecewise-affine warp in WebGL). Eyes and the inner mouth are holes in the mesh, so your real eyes and teeth show through: blinking, eye contact and lip-sync are natural, not synthesised.
6. **Blending** – soft feathering at the face outline, luminance/colour adaptation to your room lighting, adjustable transformation strength and a smile-warmth deformation.
7. **Compositing** – split compare, side-by-side, output-only or picture-in-picture, and the mandatory **AI-TRANSFORMED PERSONA** watermark on every frame.

No webcam frames or face data leave the machine. The model file (3.7 MB) is downloaded once and cached locally; the WASM runtime is bundled with the app.

---

## Quick start

### Prerequisites
- Node.js 20 or later
- A Chromium-based browser (Chrome, Edge, Brave) or the Electron desktop app
- A webcam (the app also ships with a built-in demo subject so you can see the transformation without one)

### Run in the browser
```bash
npm install
npm run dev
```
Open http://localhost:3000, sign in with the demo credentials (`admin@personalive.ai` / `admin123` or the 1-click button), then:

1. The studio opens on the **demo subject** with the first sample face already mapped.
2. Click **Turn On My Webcam** and allow camera access.
3. Choose **Who is at the camera** (Woman / Man) on the right. Then click **Upload Photo** to add a face photo, tag it as a woman's or a man's face, tick the permission box and click **Add Face & Use It Now**. Only faces of the same group as the person at the camera can be used.
4. Drag the split handle, or switch to **AI Output Only**, to see the result. Toggle **478 Mesh** to see the live tracking.

### Controls
| Control | What it does |
| --- | --- |
| Transformation Strength | Opacity of the mapped face (subtle blend → full replacement) |
| Movement Smoothness | 1-Euro filter cutoff: responsive ↔ steady |
| Smile & Expression Warmth | Lifts or lowers the mapped mouth corners |
| Keep My Real Eyes | Leaves the eye holes open so your own eyes/blinks show (off = persona eyes are painted in) |
| Match My Room Lighting | Adapts the persona's brightness and colour cast to your camera |
| Video Quality | Output canvas size: 1920×1080, 1280×720 or 960×540 |
| Record / Snapshot | Records the output canvas to WebM (download from **Recordings**) or saves a PNG |

---

## Tests
```bash
npm test
```
Runs the pure-logic suites with the Node test runner: facial math (EAR, MAR, head pose, 1-Euro filter, quality scoring), face-mesh topology (triangle extraction from the MediaPipe tessellation, eye/mouth holes, feather weights, kinematics, smile deformation), the neural pipeline audit (identity bank, cranial blending, oral aperture), photo statistics (luminance, contrast, sharpness), base-path asset resolution, and the Electron `app://` path containment check.

Type-check with `npm run lint` (TypeScript `strict` plus unused-code checks are enforced).

---

## Production build
```bash
npm run build      # static bundle + MediaPipe WASM runtime in dist/
npm run preview
```

---

## Desktop app (Electron)

```bash
npm run build          # produce dist/
npm run desktop:run    # launch the desktop window against dist/
npm run desktop:dev    # launch against the Vite dev server (run `npm run dev` first)
npm run desktop:build  # build an installer into release/ (NSIS .exe on Windows, .dmg on macOS)
```

The desktop shell serves the bundle over an `app://` scheme so WebGL, the WASM runtime, model caching and the service worker behave exactly as in the browser, and works offline after the first launch. Camera permission is granted to the studio window only.

Tagged pushes (`v*`) trigger `.github/workflows/desktop-release.yml`, which runs the tests, builds, and publishes installers to GitHub Releases; installed apps pick up new versions through `electron-updater`.

### Installable web app (PWA) and automatic updates on other computers

The studio is published to **GitHub Pages on every push to `main`** by `.github/workflows/deploy-pages.yml`:

```
https://thirumalreddy1995.github.io/PersonaLive/
```

On any computer, open that URL in Chrome or Edge and click **Install Desktop App** in the title bar. From then on:

1. You push a change to `main` (or merge a pull request).
2. The workflow runs the tests, builds the app and deploys it (about 2 minutes).
3. The installed app checks for a new build on launch and every 15 minutes while open. When one is found it shows a gold **Update Ready — Restart** button in the title bar; clicking it (or simply relaunching) loads the new version. The version badge next to the app name shows the build's commit id so you can confirm which build is running.

Only apps installed *from that URL* update this way. An app installed from `http://localhost:3000` is tied to that computer's local dev server, so uninstall it and reinstall from the Pages URL.

---

## Using the output in video calls

Browsers and Electron cannot register a system-wide virtual camera by themselves. To use the transformed output in Zoom, Teams, Meet or Discord, capture the studio window with OBS Studio (Window Capture → **Start Virtual Camera**) and select *OBS Virtual Camera* in the call app. The **AI-TRANSFORMED PERSONA** watermark is rendered into every frame and is intentionally not removable: anyone on the call can see the video is synthetic.

---

## Responsible use

PersonaLive is built for consented likeness use (your own face, or a person who has agreed). Adding a face requires that confirmation, and the watermark is mandatory. Do not use it to impersonate someone without their permission or to defeat identity checks.

**Same-group rule.** Every face is tagged *Woman* or *Man* when it is added, and the studio asks who is at the camera. Women's faces can only be mapped onto a woman and men's faces onto a man; faces from the other group are hidden in the picker and locked in the library. This is an explicit setting (not automatic gender detection), so nobody is misclassified or locked out by a wrong guess.

---

## Project layout
```
src/utils/faceTracker.ts       MediaPipe Face Landmarker wrapper (video + image modes, model caching)
src/utils/faceMesh.ts          Pure mesh topology + kinematics helpers (unit-tested)
src/utils/meshWarpRenderer.ts  WebGL piecewise-affine warp (Canvas 2D fallback)
src/utils/facialEngine.ts      Per-frame pipeline, compositing, overlays, status reporting
src/utils/faceMath.ts          EAR / MAR / head pose / 1-Euro filter / quality scoring
src/utils/imageStatistics.ts   Pixel statistics (luminance, contrast, sharpness) for the photo quality check
src/utils/assetUrl.ts          Base-path-safe URLs for files in public/ (GitHub Pages sub-path)
src/components/StudioViewport  Canvas, camera control, recording, guidance overlays
src/components/InspectorPanel  Face picker and transformation controls
electron/main.cjs              Desktop shell (app:// scheme, camera permission, auto-update)
vite.config.ts                 Serves/copies the MediaPipe WASM runtime at /mediapipe/wasm
```
