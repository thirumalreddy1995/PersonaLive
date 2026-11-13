# Realism review tooling

Headless before/after review for the persona pipeline. See `docs/REALISM_PLAN.md` for the plan,
the metric definitions and the phase protocol this serves.

## Record clips

Put driver clips in `realism-review/clips/` (gitignored), named after the plan's labels:

| Clip | Content | File |
|---|---|---|
| A | frontal talking, 20 s | `realism-review/clips/A.mp4` |
| B | slow head turns to ±40° yaw and ±20° pitch | `realism-review/clips/B.mp4` |
| C | hand touching the chin, hair pushed onto the forehead | `realism-review/clips/C.mp4` |
| D | desk lamp switched on and off | `realism-review/clips/D.mp4` |
| E | hair pushed back, frontal 3 s, then slow nods and tilts | `realism-review/clips/E.mp4` |

Any of `.webm`, `.mp4`, `.mov`, `.mkv` works. WebM/VP9 plays in every Chromium; H.264 `.mp4`
needs the Chrome channel (the default), because Playwright's bundled Chromium has no H.264 decoder.
Record at the resolution and frame rate of the webcam you use (720p/30 is typical), in the same
room light, and keep the face roughly where it sits during a call.

## Capture a run

```bash
npm run build                                   # the capture replays through the production build
npm run realism:capture -- --clip all --run baseline          # clips A–E, default persona
npm run realism:capture -- --clip A --flags oralCavity=0,catchlights=0 --run r1-candidate
npm run realism:capture -- --clip E --run baseline --times 1,2,3,4,6,8,10 --burst 5:24
```

Each run folder gets, per clip, the captured frames (`t<sec>-output.png`, `-driver.png`,
`-overlay.png`), a `contact.png` with 2x face crops (driver, output, persona layer over a
checkerboard), and one `report.json` for the whole run with the metrics of every clip. Only
`report.json` is tracked by git; frames and sheets stay local.

Targets are relative to the wearer: `summary.targets` holds, for skin tone (cheek vs neck, cheek
vs ears) and sharpness, the driver's own value, the output value, the gap and whether it passes
(±3 ΔE, ±15%). Since R3 the sharpness acceptance is `targets.sharpnessInterior` (the Laplacian
ratio over the skin interior: the 90% oval minus the eyes, brows and mouth, where the camera match
works); `targets.sharpness` (the whole face over the ring) stays as a diagnostic. `targets.seamStep`
is the ΔE between a narrow band just inside and one just outside the persona boundary at the jaw
and cheeks, minus the wearer's own step at the same place (gap ≤ 1 ΔE passes); the old
boundary/inside gradient ratio stays as `seamRatio`. `summary.shading` tracks the persona's cheek
lightness against the wearer's across the captured frames (slope ≈ 1 when the shading follows the
lamp on clip D; `sideGap` is the left-minus-right cheek difference against the wearer's, for the
shadowed side on clip B). `summary.cameraMatchTrace` holds the camera-match blur bias after every
loop update (`series`) with its min, max, std and mean step, and `summary.restMar` the learned
resting mouth aperture when `restMouth` is on.

`--flags r0` and `--flags r1` are presets that reproduce the end-of-R0 / end-of-R1 behaviour whatever
the current defaults are (see `R0_FLAG_STRING` / `R1_FLAG_STRING` in `src/realism/flags.ts`); later
tokens override them, e.g. `--flags r1,rigidForehead=1`; `--flags r2` reproduces the end-of-R2
defaults. R2 flags: `closedLipMask`, `rigidForehead`, `webgl2` (engine-restart), `personaCrop`
(persona-reload, size from `--settings personaTextureSize=1024`), `cameraMatch` (needs `webgl2`).
R3 flags: `relight` (frequency-separation relighting from the real frame; the tone match toward
the wearer at the face boundary is `--settings skinToneMatch=0..1` and the low-pass radius as a
share of face width `relightRadius=0.02`), `restMouth` (lip-fade
thresholds relative to the learned resting aperture), `softHoles` (pass-through fades widened to
the camera-match blur radius), `steadyCameraMatch` (slow EMA, dead band, hold during fast motion)
and `motionBlur` (directional blur along the head velocity); `relightGlobalTone` (one mean
persona-over-wearer skin-tone ratio on the wearer's local chroma instead of the persona's local
chroma) and `relightShadowGuard` (no detail amplification where the persona low pass is nearly
black) are the grid fixes. `--regions` writes `t<sec>-regions.png`
with the metric patches and the seam-step bands (magenta inside, white outside) drawn on driver
and output next to the measured values.

Identity guard (R3b): every capture also writes un-mirrored face crops of the output and driver
frames to `<clip>/identity/` and runs `tools/realism/identity.py` (OpenCV Zoo YuNet + SFace,
Apache-2.0, from `realism-review/.venv` with the models in `realism-review/models/`, both
gitignored) against the persona photo (`--personaPhoto`, default: the first entry of
`references/personas.json`; grid personas use their own file). `summary.identity` holds the cosine
similarity output ↔ persona, output ↔ wearer and the margin: a regression guard so the persona does
not fade into the wearer, never a score to maximise or a verification threshold. `--no-identity`
skips it. (Reports before R6 also carry `summary.cpuLightingGainUpdates`, the run count of the 5-zone
CPU lighting gain; that path was removed in R6.)
`npx tsx tools/realism/sweep.ts` turns the `r3b-sweep-r<radius>-d<0|1>` runs into per-persona
side-by-side sheets and a table (`realism-review/out/r3b-sweep/`).

Review builds (R4): the local persona's consent record is pending until the pictured person
signs it, so the review needs `npm run build:review` (sets `PERSONALIVE_REVIEW=1`, compiling the
review-only activation path in; `npm run build` refuses to carry it). Every such activation is
logged and counted (`app.pendingBypassUses` in report.json); a signed record on the machine
disables it automatically. Review personas never enter the app's library. Every run also records
process count, CPU and GPU load at start and end (`app.system`) for the report header.

R4 flags: `segmentation` (MediaPipe multiclass masks from a Web Worker every `--settings segmentEvery=4`
frames, the default; `segmentCpu=1` (the default since R6) runs the segmenter on the CPU: no GPU stall,
but ~220 ms per mask; the persona is removed under the wearer's hair, hand and glasses, captures carry the masks and
`summary.ghostHairShare` / `handLeakShare` / `glassesLeakShare` measure what still leaks),
`twoBandBlend`, `foreshortenFade`, `personaInpaint` (persona-reload; `summary.personaInpaintShare`),
`cameraMatchSameMask` (the camera match measures the camera frame only on the pixels where the
persona layer is opaque, so faded or removed persona areas do not lower the blur).

R4b flag: `foreheadExtension` (off by default; persona-reload; needs `segmentation`). The mesh is
extended from the upper face oval to the wearer's hairline, calibrated once from the hair mask
during a frontal hold; `--flags r4` is the R4 defaults with it off, `--flags r4,foreheadExtension=1`
turns it on. Settings: `hairlineFeather=0.025` (share of face height), `foreheadStretchMin=0.75`,
`foreheadStretchMax=1.35`, `foreheadRecalibrate=<n>` (any change starts a new calibration).
`summary.forehead` holds the wearer and persona hairline ratios, the ratios after the stretch guard
and how far the extension has grown in; `summary.hairlineAlignment` is the distance between the
persona layer's top edge and the hair-mask boundary across the forehead (px and % of face height,
upright frontal captures only; `stepPx` is the change between capture times, not video frames).
The extension lands about 3 s into a clip, so earlier captures show the R4 forehead.

R5 flags (off in `r0`…`r4`; all but `singleGlComposite` are on by default since R6): `keyframeCrossfade` (persona-reload; a persona with enrollment `references` gets one GPU
texture per shot and a 150 ms cross-fade on a switch), `guidedEnrollment` (the capture flow in the library),
`videoFramePacing` (`requestVideoFrameCallback`, else rAF with a changed-frame check), `singleGlComposite`
(camera frame and persona in one WebGL pass, plain transformed view only), `matrixHeadPose` (keyframe
selection by the pose from MediaPipe's matrix). `summary.r5` holds the keyframe uploads (stays at the
keyframe count however often the bank switches), the pacing mode, skipped ticks and whether the single GL
path ran; frames carry `matrixPose`, `keyframeSecondaryId` and `keyframeMix`.

`npm run realism:enroll -- --url <review build> --video <camera.y4m>` drives the guided enrollment dialog end
to end with Chrome's fake camera playing a recording in a loop (`.y4m`; a `.mjpeg` file did not advance past
its first frame here), and exports the shots to `realism-review/enrolled/<name>/` (`enrollment.json` plus one
JPEG per shot, gitignored). The script checks that the dialog refuses to start without a name and without the
attestation, starts once the face is straight and neutral, waits for the dialog to take each shot by itself,
and logs a step whose checks never hold as refused (with the dialog's hints) instead of forcing it. The export
is review-only: no consent record is written, and `realism:capture --enrolled <dir>` loads it with a pending
record, which only a review build activates. A camera stream of held poses can be cut from clips with ffmpeg,
for example seven stills of 3 s each at 15 fps:
`ffmpeg -f concat -i list.txt -vf "fps=15,format=yuv420p" -f yuv4mpegpipe camera.y4m`.

R6 flag (off): `cameraMatchMedian` (the sharpness loop follows the median of its last seven readings, with
anti-windup and a 45-frame settle after a persona or source change; it leaves sharp single photos too
sharp, see the R6 Part 2 report). `summary.r5.framesSkipped` counts duplicate ticks the pacing skipped.

Defaults since the end of R6 ("Balanced"): `--flags r6` = `r4` + `videoFramePacing`, `matrixHeadPose`,
`keyframeCrossfade`, `guidedEnrollment` (the seven-shot capture in the library, next to the photo upload),
and the app setting `segmentCpu` is on (the segmenter runs on the CPU delegate: on an
integrated GPU that removes the 60-90 ms tracker stalls each GPU mask causes, at about 40% of the mask rate).
A run without `--flags` / `--settings` measures these defaults; `--flags r4 --settings segmentCpu=0`
reproduces the R4 defaults. The user-facing `cameraBlend` setting (0..1, `src/utils/look.ts`) moves the
look toward the Camera-matched preset (`boundaryFeather` 1 → 1.5, lip floor at least 0.3 × blend); an
explicit `--settings boundaryFeather=…` overrides its feather.

`--settings temporalSmoothing=20,blendStrength=100` overrides the inspector settings for the run (the
same keys as `TransformationSettings`; `?rs=` on the page URL does the same in a browser). The rigid
forehead can be tuned the same way: `rigidPoseMinCutoff` / `rigidPoseBeta` (One Euro on the head
pose), `rigidShapeOffset=0` (no learned forehead shape); it fades out between 15° and 30° of yaw.
`npm run realism:compare -- <before-run> <after-run> [--clips A,E] [--md]` prints the before → after
table per clip and, when both runs have persona grids, the median / worst-10% comparison and the
personas that regressed beyond the measured run-to-run noise.

Options: `--persona <name>` clicks a built-in persona card first; `--url http://host:port/` reuses a
running app instead of starting `vite preview`; `--browser chromium|msedge`; `--software` forces
SwiftShader (numbers are then not representative of GPU performance); `--headed` shows the window.

## Persona test set

Synthetic faces only. Download SFHQ-T2I from Kaggle (needs a login; see
github.com/SelfishGene/SFHQ-T2I-dataset) into a folder, then:

```bash
npm run realism:personas -- --source ~/Downloads/sfhq-t2i --dry-run   # show the selection and coverage
npm run realism:personas -- --source ~/Downloads/sfhq-t2i             # copy ~24 faces + 4 degraded copies
npm run realism:capture -- --clip all --personas all --run baseline   # every clip × every persona
```

A grid run takes about an hour for 28 personas × 5 clips. To keep editing and rebuilding while it
runs, serve a frozen copy of the build and point the tool at it:

```bash
cp -r dist /tmp/dist-frozen && npx vite preview --outDir /tmp/dist-frozen --port 4777 --strictPort --host 127.0.0.1 &
npm run realism:capture -- --url http://127.0.0.1:4777/ --clip all --personas all --flags r0 --run baseline-grid-r0
```

The selection parses the prompts into attributes and covers at least 8 South Asian faces, light to
dark skin, men and women, ages 20s–60s, beard / moustache / clean-shaven, glasses, a receding
hairline and a fringe. It writes `realism-review/personas/manifest.json` (source, image id, prompt,
attributes, licence note) and `<id>-degraded.jpg` copies (700 px, JPEG q55 twice) for the R2
quality gate. `--personas p01,p05` runs a subset; `--personas <folder>` runs any folder of images.
`npm run realism:personas -- --source <download> --replace p05,p09` swaps named faces for new ones of the
same gender and ethnicity (plan run first, fetch the listed Kaggle paths, run again); swapped-out images
are listed in `excluded.json` and never picked again.

Grid runs write one contact sheet per persona × clip under `personas/<id>/<clip>/` (add `--frames`
for the PNGs), `grid.png` (rows = personas, columns = clips) and `report.grid` with per-persona
summaries plus, per metric, the median, the worst-10% value and the worst three personas.
Acceptance applies to the median and the worst 10%, and no persona may regress.

## Stills

```bash
npm run realism:still -- --image realism-review/before --run before-check
```

Runs the landmarker on screenshots and measures what needs no driver frame: the forehead tone
step (band above landmark 10 on the wearer's real forehead, trimmed at the hairline, versus a band
between the brows and landmark 10), the sharpness ratios (face/ring and interior skin), the seam
score, the R3 seam step with its bands, and the lip fullness (upper plus lower vermilion height over
face height, used to pick fuller-lip personas). It writes the image with the patches, the face
oval, the seam bands and landmarks 9/10 drawn on it, a 3x face zoom, and `stills.json` (tracked by
git, the images are not).

## How it works

1. The app is opened with `?realism=1` (and `&rf=<flags>` for overrides). That turns on the dev-only
   surface: the "Video File" source, the Realism debug panel and `window.__personaLiveRealism`.
2. The clip is loaded through the Video File input, so it runs through exactly the live pipeline
   (mirrored like a webcam), with the temporal filters seeing a continuous stream. Test personas
   are loaded through `loadPersona()` on the hook, which adds them to the library and activates them.
3. The engine copies the output, the driver frame and the persona layer when the clip passes each
   capture time, and records a short burst of consecutive half-size frames for flicker and
   texture-slide. It then re-detects landmarks on each output frame; a re-detection counts (for the
   lip error and the "faces detected" count) only when its eye corners, nose bridge, chin and
   forehead top agree with the driver's within 10% of face width (`detectionAgrees`), so a detector
   misfit on a tilted-back or profile frame is not reported as a mouth error.
4. `tools/realism/metrics.ts` computes the numbers from the pixels and landmarks (pure functions,
   unit-tested in `metrics.test.ts`). `personaSet.ts` and `degrade.ts` hold the pure parts of the
   persona tooling.

## Live comparison

`npm run dev` (or any build with `?realism=1`) shows the Realism debug panel: toggle each pipeline
stage, watch the frame profile and preview the persona layer or the raw warp. The flag string shown
in the panel can be passed straight to `--flags`.
