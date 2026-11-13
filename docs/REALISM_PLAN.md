# PersonaLive — Realism Pass (instructions for Claude Code)

> **How to use**
> 1. Save this file as `docs/REALISM_PLAN.md`.
> 2. Put the four "before" screenshots in a gitignored `realism-review/before/` folder.
> 3. Open Claude Code at the repo root and say:
>    "Read docs/REALISM_PLAN.md and the screenshots in realism-review/before/, then plan and execute Phase R0. Stop and report at the end of the phase."

---

## Goal

Make the live persona look like a real person on camera, not a filter.

Line references are for commit `cbdca42`; search for the quoted code if they've drifted.

### What the screenshots show (720p/540p webcam, persona photo warped onto the wearer)

| # | Symptom | Root cause in the code |
|---|---|---|
| 1 | **Mouth:** puffy, lilac-grey lips; a flat row of identical white teeth; near-black lip corners. | `drawRealisticPostPass` (`facialEngine.ts` ~876) calls `OralCavityRenderer.renderOralCavity`, which paints procedural teeth, tongue, AO gradients (0.92 alpha corners) and lip strokes over the wearer's real mouth. Separately, the persona photo has a closed mouth, so its lips get stretched over an open mouth. `applySpeechAnatomy` (`faceMesh.ts` ~282) also moves the upper-lip vertices away from the tracked lips, so the warped lips no longer line up with the mouth hole. |
| 2 | **Skin colour:** orange/red cast; face doesn't match the ears and neck; flat "painted" shading. | The fragment shader (`meshWarpRenderer.ts` ~105–137) adds an invented warm "subsurface" tint (`lit * vec3(1.10, 0.94, 0.86)`) and a bluish "sebum" specular. Lighting adaptation (`updateLightingGain` ~746) is a multiplicative gain from five points of a 24×24 `getImageData` readback, clamped to 0.5–1.8. It can't reproduce the room's real shading, and it stalls the GPU every 5 frames. |
| 3 | **Texture:** face softer than the hair and shirt; plastic look, worst on head turns. | The default Arshad photo is only 689×886 and WhatsApp-compressed; the "2400 × 3200 px" on its persona card is hard-coded in `mockPersonas.ts`, not measured. So the face is upsampled and soft at 720p+. Other references are sampled in WebGL1 with `LINEAR` minification and no mipmaps (~190, ~349), and a fixed-offset unsharp mask (`vec2(0.0011, 0.0011)`) can't fix either problem. The persona has none of the webcam's noise or blur, so it reads as pasted on. |
| 4 | **Hairline:** semi-transparent "ghost" hair strand on the left forehead. | The persona is painted over the wearer's own fringe. `cranialFalloff = smoothstep(0.0, 0.15, vNormPos.y)` and `CranialBoundaryBlender` fade by geometry, with no knowledge of where hair actually is. |
| 5 | **Head turn:** stretched far cheek; visible soft band between persona skin and real beard/cheek. | A single frontal photo is stretched over turned geometry. `applyPerspectiveForeshortening` moves vertices off the tracked landmarks. The bank's `secondary` keyframe and blend weight are ignored (only `primary` is used, ~690–712), and the boundary blend is a single-band alpha feather. |
| 6 | **Eyes:** fake white catchlight dots; reddish, heavy persona eyelids around the real eyes. | `drawRealisticPostPass` draws fixed catchlights that ignore the room's lights. The persona's periocular skin isn't colour-matched to the real eyelids. |
| 7 | **Performance:** Arshad persona 20 FPS / 49 ms vs Marcus 30 FPS / 33 ms. | Not texture size (both photos are small). Profile before fixing. Likely suspects: the per-frame `ctx.filter = 'blur(4px)'` in `CranialBoundaryBlender.softenHairlineEdges`, the `getImageData` readback, multiple full-frame `drawImage` / `destination-out` passes per frame, and `bufferData` re-uploads on every keyframe switch. This is why the user drops to 540p, which itself blurs the face. |
| 8 | **Forehead:** two-tone forehead (orange persona lower half fading into the wearer's pinkish real upper forehead); a bright band across the forehead on the Marcus persona; the forehead slides and doesn't line up with the hairline as the head nods. | **(a) The mesh stops below the hairline.** MediaPipe's face oval tops out at landmarks 10/109/338, well below most people's hairline, so the upper forehead is always the wearer's own skin. **(b) Four fades are stacked** — the 4-ring mesh feather (`faceMesh.ts` ~110–116), the shader `cranialFalloff` (top 15% of the face box), `harmonizeForeheadBoundary` (erases up to 22% alpha over a band 35% of forehead height), and `softenHairlineEdges`. Together they make a long vertical cross-dissolve placed by face-box geometry, not by the real hairline, so any tone mismatch shows as a gradient band. **(c) The reference bank's keyframes are fake.** `MultiReferenceBank.synthesizeSuiteFromMaster` builds the yaw, pitch, viseme and smile "keyframes" by shifting the persona's texture coordinates of the same single photo with `deformLandmarksForPose`, which assumes the face is centred at (0.5, 0.5) in the photo. When the bank switches keyframes on a nod or turn, the forehead texture slides inside the mesh. **(d) Vertices move off the tracked points.** `applyPerspectiveForeshortening`'s pitch term shifts forehead vertices every frame. **(e) Persona studio lighting is baked in** (e.g. the forehead highlight on the Marcus photo), and nothing replaces it with the room's light. |

### The principle behind this pass

- **Don't invent pixels the camera didn't see:** no procedural teeth, catchlights or skin "beautification".
- **Keep the warp exactly on the tracked landmarks.**
- **Take illumination, noise and sharpness from the wearer's real frame. Take identity detail from the persona.**

---

## Working rules

1. One phase at a time, in order.
   - Start each phase with a short plan: files, risks, how you'll verify.
   - End each phase with the report format at the bottom. Wait for my "go" before the next phase.
2. Branch per phase: `realism/rN-<slug>`. Small conventional commits.
   - Never push, tag, or rewrite history.
   - Never commit face photos, videos, or screenshots.
3. **Every visual change ships behind a setting or flag, so before/after can be compared live.**
   - Defaults change only after the comparison in the phase report shows it's better.
4. **Never delete, skip or weaken existing tests.**
   - Add unit tests for all new pure logic: mask weights, colour maths, keyframe blending, noise estimation.
5. Verify current API docs before using anything new: MediaPipe Tasks image segmenter, WebGL2 extensions, `requestVideoFrameCallback`.
6. Verification after every phase:

   ```bash
   npm ci && npm test && npm run lint && npm run build
   ```

   Then the realism review below.
7. **Metric targets are relative to the wearer, not absolute.** Sharpness and skin tone pass when they sit within a tolerance of the driver's own value on the same frames (see the metrics table). Report the driver value, the output value and the gap.
8. **Phase acceptance criteria apply to the median and the worst 10% of personas in the persona test set, and no persona may regress** (R0 review, 2026-11-05). My webcam clips stay the driver set; the personas vary.

### Guardrails — unchanged by this pass, enforce them

- **Watermark:**
  - The visible "AI-TRANSFORMED" watermark is drawn on every output frame, in every view mode, composited last.
  - It's still conditional (`if (settings.watermarkMandatory)` at `facialEngine.ts` ~547). Make it unconditional in R0 and remove the setting.
  - Scale it so its text is ≥ 3% of frame height (minimum 14 px), and stays legible after a video-call app downscales to 360p.
  - Drop the "C2PA" text from the live badge; live frames carry no C2PA.
  - Realism work never moves, shrinks, blurs or hides it.
- **No anti-detection work:**
  - Optimise for how it looks to a person viewing the video.
  - Never use deepfake-detector scores as a target.
  - Never add features meant to defeat liveness/KYC checks.
- **Consent gate:** adding a persona still requires the consent attestation.
- **On-device:** no frames or faces leave the machine.
- **Untrack `references/`:**
  - It still contains real-person photos and a video (`git rm -r --cached references/` and gitignore it; keep the files locally).
  - In the R0 report, give me the `git filter-repo` commands to purge them from history; don't run them.

---

## Realism review protocol (used in every phase)

### R0 builds the tooling for this

**Replayable driver clip**
- Add a dev-only "Video file" source next to webcam and demo.
- The same clip can then be replayed frame-for-frame.
- Clips live in gitignored `realism-review/clips/`.

**Clips I'll record**
- **A:** frontal talking, 20 s
- **B:** slow head turns to ±40° yaw and ±20° pitch
- **C:** hand touching the chin and pushing hair onto the forehead
- **D:** a desk lamp switched on and off
- **E:** forehead check — hair pushed back off the forehead, frontal for 3 s, then slow nods (±20° pitch) and slow tilts (±15° roll)

**Capture script**
- `npm run realism:capture -- --clip A --flags <...>` renders a clip through the engine headlessly (Playwright + Chromium, GPU enabled).
- It saves PNG frames at fixed timestamps to `realism-review/out/<run>/`.
- It also writes a contact sheet with face crops at 2× for side-by-side review.

**Metrics** (`report.json`; trends matter more than absolutes)

| Metric | How to compute it |
|---|---|
| Skin-tone match | CIEDE2000 ΔE between a persona cheek patch (output) and the wearer's neck and ear patches (driver), reported next to the wearer's own cheek-vs-neck and cheek-vs-ears ΔE on the same frames. **Passes when both output values are within ±3 ΔE of the driver's own values**; report driver value, output value and gap. Not "lower is better": a real face differs from its own neck and ears. |
| Sharpness match | Laplacian variance inside the face divided by Laplacian variance in a ring just outside it (hair, ears, collar), reported next to the same ratio on the driver frame. **Passes when the output ratio is within ±15% of the driver's own ratio on the same frames**; report driver value, output value and gap. Not ≈ 1.0: a soft webcam frame makes the wearer's own face/ring ratio well below 1. |
| Seam score | Gradient magnitude along the blend boundary versus a band just inside it. Lower is better. |
| Mouth fidelity | Re-run FaceLandmarker on the output and measure lip-landmark error against the driver. Also count frames with synthetic teeth drawn; should be 0. |
| Flicker | Mean frame-to-frame difference inside the face minus the same on the driver. |
| Forehead tone step | ΔE between a band on the wearer's real forehead just above landmark 10 (the top of the warped mesh; trimmed where hair starts, hair-like dark pixels excluded) and a band between the brows and landmark 10 on the output, minus the same on the driver. Should approach 0; a real forehead has no band. Validated on the "before" screenshots with `npm run realism:still` (output-only ΔE 13–15 on the four screenshots where the band is visible). |
| Hairline alignment | Mean pixel distance between the top edge of the persona layer and the wearer's hair-mask boundary, per column across the forehead. Also its frame-to-frame jitter, measured on clip E. |
| Texture slide | Optical-flow residual of the persona forehead texture relative to the wearer's head motion on clip E. Should be ~0; the texture must move with the head, not inside it. |
| Performance | FPS, p50/p95 frame time, per-stage `performance.measure` timings. |

**Persona test set** (photos only; the webcam clips stay as they are)
- Synthetic faces only (people who don't exist): SFHQ-T2I (github.com/SelfishGene/SFHQ-T2I-dataset) or SFHQ, downloaded only as needed. Never photos of real people from the web.
- ~24 frontal, neutral faces in gitignored `realism-review/personas/`, with `manifest.json` recording source, image id, prompt/attributes and licence note. Coverage: at least 8 South Asian faces plus the full range from light to dark skin; men and women; ages from 20s to 60s; beard, moustache and clean-shaven; glasses; a receding hairline and a fringe over the forehead. `npm run realism:personas -- --source <download>` selects them.
- Degraded copies of 4 of them (downscaled to ~700 px and JPEG-compressed like a WhatsApp forward) test low-quality references and the R2 quality gate.
- `npm run realism:capture -- --clip all --personas all` runs every clip × every persona: per-persona metrics, a grid contact sheet (rows = personas, columns = clips), and the median and the worst 3 personas per metric in `report.json`.
- Acceptance criteria apply to the median and the worst 10% of personas; no persona may regress.

**Debug panel**
- Add a dev-only "Realism debug" panel.
- It toggles each stage from this plan live and can show intermediate buffers: masks, low-pass shading, detail layer.

---

## Phase R0 — Tooling and guardrail fixes

- Build the review tooling above, including the persona test set tooling.
- Make the watermark unconditional and legible.
- Untrack `references/`. Move the one bundled real-person portrait out of `public/`: desktop and dev builds load it from the gitignored `references/` folder (with its consent record) or through the upload flow; the Pages build ships only the sample personas. Persona quality metrics are measured from the image, never hard-coded.
- Validate the forehead tone-step metric on the "before" screenshots; fix the patch placement if it does not flag the visible band.
- Record a **baseline** run of clips A–E with the current defaults.
- Commit only `report.json`, never frames.

---

## Phase R1 — Stop drawing fake things (biggest, fastest win)

### 1. Remove the procedural oral cavity and catchlights
- Delete the `OralCavityRenderer` call and the catchlight drawing from `drawRealisticPostPass`.
- If nothing else uses `oralCavityRenderer.ts`, delete it and its tests' dependencies cleanly.
- The inner-mouth hole then shows the wearer's real teeth and tongue, which is the only mouth interior that can look real.

### 2. "Keep my real mouth" (default on), mirroring "Keep My Real Eyes"
- Add a lip ring to the topology in `faceMesh.ts`.
  - Outer lip contour: 61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146.
  - Inner ring: as existing.
- Give vertices a `lipWeight` attribute.
- Shader: `persona alpha *= 1 - lipFade` in the lip band.
  - `lipFade = mix(uLipFadeClosed, 1.0, smoothstep(0.02, 0.10, mar))`.
  - So a closed-mouth persona texture is never stretched over an open mouth.
- Feather the outer lip edge by ~8% of mouth width.
- When the bank has an open-mouth keyframe, use the persona's real lips from that keyframe instead of fading.

### 3. Keep the warp on the tracked landmarks
- Put these behind flags, defaulting off. They move warp vertices away from the real features, misaligning the persona against the real eyes, mouth and jaw:
  - `applySpeechAnatomy`
  - `applyPerspectiveForeshortening`
  - `applyEyelidKinematics` when real eyes are kept
- Warp vertex positions = smoothed tracked landmarks.
- Keep `applySmileBias` only when its slider is non-zero.

### 4. Stop faking reference keyframes
- `MultiReferenceBank.synthesizeSuiteFromMaster` creates "yaw", "pitch", "viseme" and "smile" keyframes by shifting the texture coordinates of the same single photo.
- `deformLandmarksForPose` also assumes the face is centred at (0.5, 0.5) in the image.
- So when the bank switches keyframes, the persona's texture slides inside the mesh: the forehead, brows and jaw land in the wrong place, and the "viseme" keyframe distorts the lips.
- Put the synthetic suite behind a flag, default off. With one photo, the bank holds exactly one real keyframe and the texture never slides.
- Real multi-angle keyframes come only from real photos (the R5 enrollment flow).
- Also correct the hard-coded quality metrics in `mockPersonas.ts` (the "2400 × 3200 px" for a 689×886 photo) to values measured from the actual image.

### 5. Remove shader "beautification"
- Remove the warm subsurface tint and the sebum specular.
- Remove the fixed-offset unsharp mask (R2 replaces it with a resolution-aware version).

### 6. Eyes
- Add an "eye pass-through radius" setting.
  - It expands the eye holes with a feathered ring so the wearer's own lids and lashes show.
  - Default: just past the lash line.

### Acceptance
- No synthetic teeth in any frame.
- Mouth fidelity improves on clip A.
- Texture slide on clip E drops to ~0: the forehead no longer jumps when you nod.
- ΔE improves or holds.
- No regression in the other metrics.

---

## Phase R2 — Texture fidelity: match the camera, not the photo

### 1. WebGL2
- Prefer `webgl2` with GLSL ES 3.00 and `highp`. Fall back to WebGL1, then 2D.

### 2. Reference preprocessing
On every persona/keyframe load:
- Crop to the face-oval bounds × 1.6.
- Resize so the long side is at most 1024 px (setting: 512 / 1024 / 2048).
- Recompute UVs for the crop.
- Upload once with `generateMipmap`, `LINEAR_MIPMAP_LINEAR`, and anisotropic filtering (max 8) when available.

### 3. Reference quality gate
Measure and show in the persona card:
- face height in pixels (recommend ≥ 600)
- blur (Laplacian variance)
- JPEG blockiness (8×8 boundary discontinuity)
- uneven lighting (left/right luminance ratio)
- eyes open, mouth closed, neutral expression

Warn when a photo is a forwarded or messaging-app copy (heavy recompression). Don't block, just explain.

### 4. Camera-matched sharpness and noise
Every ~15 frames:
- Estimate the wearer's face-region sharpness (Laplacian variance) and sensor noise (MAD of a high-pass in flat skin patches: forehead and cheeks).
- Use a downsampled async readback (WebGL2 PBO + fence) so the GPU never stalls.
- Never use the synchronous `getImageData` path.

In the shader:
- Blur or sharpen the persona (texel-size-aware kernel, strength from the estimate) so the sharpness ratio converges to the wearer's own face/ring ratio.
- Add per-frame, temporally varying luminance noise with matching sigma: a hash of pixel coordinate and frame index, plus a small chroma component.

### 5. Default output resolution
- Once R5's performance work lands, default back to 720p. Note in the report whether 540p is still needed on this machine.

### Acceptance
- Sharpness ratio within ±15% of the driver's own face/ring ratio on the same frames, on clips A and B (median persona and worst 10%, no persona regressing).
- Visibly less "pasted" in the contact sheet.

### R2 additions (R1 review, 2026-11-05)
- Controls for two more metrics: the slide metric also runs on the raw driver video and the seam ratio on the driver frame; both report driver, output and gap (slide passes when the gap is ≤ 0.5 px/frame).
- If the controlled slide gap on clip C or E is still > 0.5 px/frame, rigid-pose stabilisation lands in R2, before the texture work and before R4b: `outputFacialTransformationMatrixes` on, landmarks split into rigid head pose + per-landmark expression offsets, rigid pose smoothed with a One Euro filter, forehead and upper-face vertices driven from the rigid pose plus brow offsets only (flag `rigidForehead`).
- Closed-lip outline: with the mouth closed, persona lips are limited to the intersection of the persona and wearer lip rings, feathered (flag `closedLipMask`).
- The R1 persona-grid regressions on neck gap and slide are accepted as measurement shifts from removing the mesh offsets.
- Metric change in R2: an output re-detection counts only when its rigid landmarks agree with the driver's within 10% of face width (`detectionAgrees`); before, one more detected tilted-back frame on clip E could add a 10–25% lip error from a detector misfit. Lip-error and faces-detected values from the R0/R1 grids were recorded without the gate.
- The rigid forehead fades out between 15° and 30° of yaw: on the yaw clip B the canonical model and the frontal shape offset no longer match the wearer's forehead and the rigid points slide against the head (measured 0.3 → 1.2 px/frame on Arshad, 0.28 → 1.0 on grid personas). Settings `rigidPoseMinCutoff`, `rigidPoseBeta`, `rigidShapeOffset` expose the stabiliser for sweeps.

---

## Phase R3 — Lighting and skin tone from the real frame (biggest realism lever)

Replace the 5-point multiplicative gain with frequency-separation relighting on the GPU.

### 1. Driver frame as a texture
- Upload the current video frame to a texture each frame (`texSubImage2D` from the video element).
- Build a low-pass version: downsample to 1/8 resolution, then apply a separable Gaussian.
- Blur radius ≈ 6–10% of face width.
- Make it mask-aware: fill the eye and mouth holes before blurring so dark interiors don't bleed into the shading.

### 2. Persona low-pass
- Use a mip level (or a pre-blurred copy) of the persona crop at the equivalent radius in UV space.

### 3. Shader (all in linear light: sRGB decode → work → encode)

```
detail   = personaRGB / max(personaLowRGB, eps)          // identity detail: pores, brows, stubble, wrinkles
shadeLum = lum(driverLowRGB)                              // the room's real light on the wearer's face
tone     = mix(chroma(personaLowRGB), chroma(driverLowRGB), uToneMatch * toneWeight)
out      = detail * rebuild(shadeLum, tone)
```

- `toneWeight` rises toward the face boundary (≈ 1.0 at the edge, ~0.3 at the centre). Skin then meets the neck and ears without a colour step, while the persona keeps its own complexion in the middle.
- `uToneMatch` becomes a user setting: "Skin tone: persona ↔ match me".

### 4. Remove the old CPU path
- Delete `updateLightingGain`'s `getImageData` path entirely, and its 5-zone uniforms.

### Acceptance
- Cheek-vs-neck and cheek-vs-ears ΔE within ±3 of the driver's own values on the same frames (median persona and worst 10%, no persona regressing).
- Neck gap median and worst 10% across the persona grid must beat the R0 grid values (3.1 and 10.3 ΔE).
- On clip D (lamp on/off), the persona's shading changes in step with the real face.
- On clip B (head turns), the shadowed side of the face is dark like the real one.
- No flicker regression.

### R3 additions (R2 review, 2026-11-06)
- Mouth thresholds per wearer: the resting mouth aperture is learned from the first frontal seconds (10th percentile of MAR over a ~2 s window, recalibrated while frontal) and the lip-fade thresholds sit relative to it (flag `restMouth`, `src/utils/restMouth.ts`). `closedLipMask` is judged on clip A and on three fuller-lip grid personas with contact sheets; with no visible benefit it defaults off (it costs ~0.25% lip error).
- Interior-skin sharpness: the camera-match acceptance metric is the sharpness ratio with the eyes, brows and mouth cut out of the face mask (`targets.sharpnessInterior`); the face/ring ratio stays as a diagnostic.
- Camera-match stability: the blur and noise estimates go through a slow EMA with a dead band and hold during fast head motion (flag `steadyCameraMatch`); directional motion blur proportional to head velocity sits behind `motionBlur`. Flicker and the blur-bias trace are measured on clip B.
- The eye and mouth pass-through fades widen to the camera-match blur radius (flag `softHoles`) so they do not sit sharper than the skin on turned heads.
- Seam metric replaced before R4: ΔE between narrow bands either side of the persona boundary at the jaw and cheeks, minus the wearer's own step at the same place (`targets.seamStep`, gap ≤ 1 ΔE passes). Validated on `realism-review/before/`: it flags the visible edge there (mean 11.7–20.3 ΔE, worst segments 27–55) and the band positions are drawn on the stills.
- Acceptance as agreed: neck-gap median and worst 10% beat the R0 grid (3.1 / 10.3), skin gaps within ±3 ΔE of the driver's own, and on clip D the persona's shading follows the lamp (`summary.shading.slope` ≈ 1); p05's ear gap rise (1.84 → 3.42) explained in the report.
- The 5-zone CPU gain stays in the code while `relight` is off so the r0/r1/r2 presets still reproduce their phases; it is deleted once R3's defaults are accepted (R6 at the latest).
- Measured decisions (2026-11-06, same-session runs on Arshad): the low-pass sigma is 5% of face width, not the 6–10% above: at 8 / 6 / 5% the persona cheeks came out 4.8 / 3.8 / 3.1 L darker than the wearer's (the low pass averages the cheek highlight away) and only 5% keeps the cheek-vs-neck gap inside ±3 ΔE on A, D and E (setting `relightRadius`). `closedLipMask` defaults off (no visible difference on p08/p09/p14, a crisp outline at the vermilion border on A, identical lip error). `motionBlur` defaults off (on B it raised flicker 0.56 → 0.65 and the blur-bias swing 2.85 → 3.34 and pushed the skin sharpness gap to −0.27); `steadyCameraMatch` defaults on (B swing 2.85 → 1.61, mean step 0.105 → 0.062, skin sharpness −0.21 → −0.10). `restMouth`, `softHoles` and `relight` default on.
- Measured decisions, persona grid (2026-11-06, same-session runs): at 5% the relit output still carried the persona's own photo lighting on harshly lit personas (p20 side-shading gap 23 L, p05 purple/green chroma blotches in its half-shadow, p03/p06/p14/p24 cheek-vs-neck gaps −4…−8 ΔE where the r2 preset gave ±1): structures 5–15% of the face wide (nose and cheek shading, eye sockets) pass a 5% low pass as "detail". Two more flags and a smaller radius fix it: `relightGlobalTone` (the relit chroma is the wearer's local low-pass chroma shifted by one persona-mean over wearer-mean skin-tone ratio raised to 1 − tone weight, read back from the 1/4-scale low passes every 3 frames, instead of the persona's local chroma, so its warm key / cold fill no longer leaks), `relightShadowGuard` (the detail term fades to 1 where the persona low pass is nearly black) and `relightRadius` 0.02 with the low passes at 1/4 scale (`RELIGHT_SCALE` 4; at 1/8 scale a 2% sigma sat at the one-texel floor and the bilinear upsampling showed as a sharpness jump on A). Probes on p03/p05/p20 (A, E) and Arshad (A, D): neck gaps −12/−10/−8 → −3.4/−2.1/−5.2 on A and within ±3 on E, side gaps 19/14 → 5/3 L, Arshad A/D neck −2.5/−2.2 → −0.3/−0.3 and lamp slope 0.68/0.93 → 0.96/0.95. The cost is identity: at 2% the persona contributes texture, wrinkles and brows, while all shading at and above cheek scale is the wearer's (the radius stays a setting for the inspector/`--settings`).

### Requirement and intended use (2026-11-06)
- Goal: Person A provides photos from several angles and/or videos, with recorded consent. Person B sits at the camera. Someone watching should recognise A, and the video should look natural on camera. Recognisable as A comes first, natural-looking second; neither may be dropped.
- Intended use: live video calls where all participants know they are seeing a persona.
- Unchanged guardrails: the visible badge on every frame; the consent gate; no features to hide the badge, evade detection or pass identity/liveness verification; on-device by default.
- Identity metric rule: report it in every phase as a delta against the previous phase. It is a trend guide, never a target, and never tuned against face-verification thresholds. Judge by eye on the sheets first ("does this read as A?").
- R3b decisions: `relightRadius` default stays 2% until R3c's loop lands; persona de-light stays off (flag kept for the record); the identity guard stays in every report.

### R3b (identity guard and identity-vs-lighting sweep, 2026-11-06)
- Identity guard: `tools/realism/identity.py` (OpenCV Zoo YuNet + SFace, Apache-2.0) scores every captured frame's output face against the persona photo and against the wearer (cosine) and reports the margin per clip and per grid persona (`summary.identity`, grid metrics `identityToDriver` / `identityMarginDeficit`, compare rows). It is a regression guard so the persona does not fade into the wearer; it is never tuned against face-verification thresholds.
- Measured: on the 28-persona grid the r2 preset gives a median margin of −0.15 (4 personas positive) and the r3 preset −0.50 (none positive; output ↔ wearer 0.49 → 0.71, output ↔ persona 0.38 → 0.24), while the same change took the side-shading gap from 24 L to 0.9 L and the neck gap from 3.7 to 0.8 ΔE. Sweep over Arshad, p03, p05, p06, p10, p12, p14, p20 × clips A/B/D/E × radius 2/4/6/8 % × de-light off/on (`realism-review/out/r3b-sweep/`): each 2 % of radius buys ≈ 0.1 of margin and costs ≈ 2 ΔE of neck gap; softly lit personas (p10, p12, Arshad) reach margin ≈ 0 at 6–8 % with neck gaps 2–3 ΔE, harshly lit ones (p05, p20) leak 12–26 L of side shading there. `personaDelight` (2nd-order shading field divided out at load) changes identity by ≤ 0.03 and no lighting metric beyond noise: default off. No load-time proxy of the photo (mid-band energy, broad-field spread, left/right asymmetry) predicts the leak, so a per-persona radius has to be a runtime loop on the measured side-shading gap.
- Camera match resets to neutral on persona or source change and warm-starts on the first five frames (`cameraMatchDue`); clip D after C now traces 0.06..1.28 instead of 0..4, with the first 2 s kept in the trace. `summary.cpuLightingGainUpdates` (engine counter) is 0 on every run with the default flags: the 5-zone CPU gain and its readback never run.
- R4 additions requested by the user: segment persona photos at load, inpaint glasses and hair-over-face out of the skin texture, and add a quality-gate warning (p03's glasses frames leak into the skin today).

### R3c (identity within the 2D path, 2026-11-06)
- Auto-radius loop (flag `autoRadius`, default on; `src/utils/autoRadius.ts`): each persona starts at 2% and the relight radius rises toward 8% (+0.002 per update) while the output's side-shading excess and cheek-vs-neck excess against the wearer's own stay under 2.0 (L / ΔE), falls (−0.004) above 3.0, and holds in between; the excesses are EMA-smoothed (0.25) from readbacks every 15 frames of the persona layer composited over the driver readback (the raw layer is premultiplied and feathered at the cheek landmarks and read 5–7 L too dark). Measured on the 28-persona grid: identity margin median −0.50 → −0.30 (worst 10% −0.29 → −0.10), 24 personas improve, none worse; settled radius median 4.0% (2.0–6.8%; p03, p05, p06, p18, p01d stay at 2%); neck gap median/worst 10% 1.7/2.4 ΔE, ears 0.8/1.2, side gap 2.2/2.6 L, clip D lamp slope 0.94. Arshad: margin −0.14 → 0.00 on every clip at 3.8–7.2%.
- Symmetric de-light (flag `symmetricDelight`, off): the per-vertex mirror split of the 2%..radius band did not let p05/p20/p03 settle higher (they stay at 2%) and lowered p10's settle point (6.8 → 4.8%); identity within ±0.05.
- Eye pass-through sizes: eyeball-only (`eyePassThroughRadius=0`) and off (`eyeGazeSync=0`) move identity by ≤ 0.03; on the sheets eyes-off gives a fixed stare and eyeball-only leaves the persona lids open while the wearer blinks. Current (radius 1) stays.
- Lips: persona lips at rest are on and aligned (restMouth; zooms `realism-review/out/r3c-variants/mouth-p10|p14.png`, lip error 0.9–1.1% of face width); always-the-wearer's-lips (`lipFadeFloor=1`) moves identity by +0.06 median, within noise. Rest-mouth with floor 0 stays.
- Consent: `ConsentRecord` with status/scope/image hashes and `ConsentForm` (signed by the pictured person; stored locally, JSON for the manifest); pending personas cannot be activated by the library or the auto-selection. `references/personas.json` is pending with the photo's SHA-256 until Arshad signs it; the dev-only review hook loads it flagged pending with a warning (deviation for review).
- Session note: the final runs ran at ~42 fps (other GPU load on the machine, 42 Chrome processes) against 58 earlier, so flicker and texture slide of this session are not comparable with R3's; identity, radius and skin-tone numbers are unaffected.

---

## Phase R4 — Boundaries and occlusion

### 1. Segmentation
- Add the MediaPipe `ImageSegmenter` with the `selfie_multiclass_256x256` model.
  - Categories: 0 background, 1 hair, 2 body-skin, 3 face-skin, 4 clothes, 5 accessories.
- Run it every 2–3 frames (setting).
- Smooth the confidence masks over time with an exponential moving average.
- Upload them as a texture.

### 2. Use the masks in the shader
- Persona alpha:
  - `*= faceSkin`
  - `*= 1 − hair`, which fixes the ghost strand
  - `*= 1 − bodySkin` where a hand covers the face
  - `*= 1 − accessories` for glasses
- Replace the geometric `cranialFalloff` and the `CranialBoundaryBlender` destination-out passes with the hair mask. Keep them only as a fallback when the segmenter is unavailable.

### 3. Two-band boundary blend
- Blend low frequencies over a wide feather (~12% of face width) and high frequencies over a narrow one (~3%).
- Use the R3 low-pass layers; this is cheap.
- This removes the soft band at the cheek and jaw.

### 4. Foreshortened triangles
- Per frame, compare each triangle's screen area with its rest area.
- Fade persona alpha smoothly on strongly compressed or back-facing triangles at the far silhouette during head turns.
- The colour-matched real skin then shows there instead of a smear.

### Acceptance
- No ghost hair on clip C.
- Hand stays in front of the face.
- Seam score improves.
- No stretched far cheek on clip B at ±40°.

### R4 start items (user go after R3c, 2026-11-06)
- Loop budget: the auto-radius thresholds are 1.5 / 2.5 (were 2.0 / 3.0), so the loop stays ~0.5 ΔE inside the skin budget. Arshad neck gaps are all ≤ 2.5 (D −3.21 → −1.82); quick grid (A, D, E): neck |gap| median / worst 10% 1.91 / 3.00 → 1.67 / 2.13, identity per persona median −0.03 (worst −0.10, best +0.01).
- Review-only consent path: a pending consent record can be activated only in `npm run build:review` builds and by the realism review tool. `tools/check-prod-bundle.cjs` fails a production build that carries the path, each use is logged and counted (`report.app.pendingBypassUses`), and a signed record disables it. The 28 grid personas are transient, flagged "synthetic, no real person", and never enter the library.
- Measurement hygiene: every report header records process count, CPU, GPU load (engine counters over all adapters, plus nvidia-smi) and the WebGL adapter. R3 vs R3c re-run on A–E on a clean session: the flicker and texture-slide differences follow frame time (landmarker `track` 17 → 31 ms with 19 vs 8 Chrome processes), not the loop (warp 1.3–2.3 ms).

### R4 results (2026-11-07)
- Segmentation (flag `segmentation`, on): MediaPipe multiclass selfie segmenter in a classic Web Worker (module workers break MediaPipe's importScripts), category mask on a face crop (sharper hand, hair and glasses edges than a full-frame 256² mask), EMA-smoothed, every 4 frames (setting `segmentEvery`; 2 / 3 / 4 gave 47 / 54 / 58 fps, p95 30 / 30 / 25 ms and hand leak 0.015 / 0.023 / 0.017 on C). In the shader, confident hair, body skin and accessories remove the persona and face skin gates only the outer feather band; the cranial destination-out passes remain the fallback without masks. The segmenter loads only when a flag needs it and takes ~10 s to start.
- Foreshortening fade (flag `foreshortenFade`, on): per-triangle screen/rest area ratio with an orientation vote (the tessellation's winding is arbitrary; summing signed areas faded the whole persona on turns). It removes the doubled nose at −40/−52° on B with no identity cost; far-side lashes past the silhouette at ~33° remain.
- Persona inpaint and quality gate (flag `personaInpaint`, on): the persona photo is segmented at load and hair or glasses inside the dilated face oval are filled by a bilinear pull-push; the share replaced feeds the warning "Hair or glasses covered N% of the face skin in this photo …". p03's glasses are gone (+0.15 margin) with faint lower-rim arcs and a top-rim line left; p24 keeps a dark temple-arm line on the cheek; p06 has ~2% replaced.
- Two-band blend (flag `twoBandBlend`, off): the seam-step gap drops to ~0, but the jaw looks the same on the sheets and identity costs ~0.05.
- Acceptance: ghost hair on C 0.00 (already 0 at R3c). Hand in front of the face: leak ≤ 0.003 on A, B, D, E and 0.028 on C (fast, motion-blurred fingers carry the persona for 1–2 frames); B reads 0.00–0.03 across runs with the same settings, since the metric also counts the neck under the jaw on turns. Seam score: the seam-step gap passes on every clip and the grid median / worst 10% go 0.14 / 0.73 → 0.06 / 0.38. Far cheek on B at ±40°: the doubled-nose smear is gone. Head tilted back on B (t16.38): the persona's eyes, nose, moustache and mouth that R3c drew on the underside of the chin are gone; two small dark slivers remain.
- Final runs (frozen build dist-r4j, Intel iGPU, one session): Arshad `r4-final-base` (r3c preset) → `r4-final`: identity margin within ±0.03 on all clips, clip E flicker 2.55 → 1.85, neck, ear and seam-step gaps unchanged. Grid `r4-final-grid-base` → `r4-final-grid`: identity per persona median +0.04 (15 better, 5 worse, worst p21 −0.07), output ↔ wearer 0.63 → 0.62, ears 0.92 → 0.70, interior sharpness 0.20 → 0.16. The grid's flicker (0.78 → 1.02) and slide (0.85 → 1.05) rises are frame spacing: the identical driver's own flicker rose 1.01 → 1.41 at 48 vs 59 fps, and the output/driver flicker ratio moved 1.34 → 1.38.
- Performance: on the Intel iGPU the grid median goes 59 → 48 fps and p95 15 → 37 ms, all in the landmarker `track` stage: the worker's synchronous mask readback stalls the GPU the landmarker shares. The CPU delegate (setting `segmentCpu`) restores 58–60 fps and p95 17–19 ms on A–D (E 47 fps, 25 ms) but needs ~220 ms per mask (clip B neck/hand leak 0.09), so it is not the default; fixing the stall is an R5 item (asynchronous readback, a smaller model, or the landmarker in a worker).
- NVIDIA one-off (`r4-nvidia`, capture `--gpu high`; NVIDIA RTX 500 Ada Generation Laptop GPU, 4 GB, driver 597.13, CUDA 13.2): no visible difference (face-region |Δ| 1.4–4.0 of 255, the same as two Intel runs); fps A 43.6 / B 57.1 / C 50.7 / D 46.8 / E 59.6 against Intel 48.9 / 47.5 / 49.3 / 43.1 / 59.0. The app keeps rendering on the Intel iGPU; the GPU choice is an R5 decision and the NVIDIA VRAM stays free for R7.
- Camera match (found on the grid sheets): R4 lowered the camera-match blur (grid median 1.76 → 1.36; 14 personas lower by > 0.3, none higher). For the glasses personas this is right, since the rims no longer need blurring. Part of it was a measurement bias: the persona side skips pixels below alpha 240, so the foreshortening fade and the segmentation keep factor removed detail-dense, minified areas from the persona statistics only. p20 (elderly, hard side light) already showed orange crease streaks at R3c on A, C and D; with the lower blur they turned crisp and appeared on B as well. Flag `cameraMatchSameMask` measures the camera frame on the same pixels (`pairedFaceStats`; the driver readback is row-flipped against the output and mirrored when the display is). Measured with the flag on (`r4-samemask`, `r4-samemask-grid`; frozen build dist-r4k, which differs from dist-r4j only by this flag, Intel iGPU): Arshad's interior sharpness gap goes 0.50 → −0.03 on A and 0.48 → 0.15 on D (B −0.01 → 0.19) with identity within ±0.02, but the neck gap on D reaches −2.64, over the 2.5 budget (E −1.41 → −2.00). On the grid the interior sharpness gap worst 10% goes 0.41 → 0.18 and face/ring 0.53 → 0.31, but identity is worse for 13 personas and better for 1 (median −0.02; p10 −0.15, p20 −0.09, p13 −0.06) and the margin deficit median / worst 10% goes 0.33 / 0.50 → 0.36 / 0.52. On the sheets p20's streaks go on A and D but those frames then read as the wearer, p13 turns muddy under the hand on C, and the sharpness gains (p03, p06, p23, p24) do not show at tile size. Identity comes first, so the flag stays off; the bias stays open for R5 (measure the persona layer before the keep factor, or cap the blur at the R3c level).
- Roadmap (user, 2026-11-06): R4 → R4b → R5 → R6 with no cloud or external GPU, then R7 locally on this laptop's NVIDIA GPU (sidecar on 127.0.0.1 with a per-session token). Machine: Lenovo ThinkPad P14s Gen 5 (21G2S08E00), Core Ultra 7 155H, 32 GB, Intel Arc iGPU (render baseline) and NVIDIA RTX 500 Ada 4 GB.

---

## Phase R4b — Forehead and hairline alignment

### Goal
- The persona's forehead covers the wearer's whole forehead, from the brows up to the wearer's real hairline.
- It lines up at both ends: brows on brows, persona hairline on the wearer's hairline.
- It moves rigidly with the head.
- There is exactly one transition, at the hairline, where real hair naturally makes an edge, instead of a long fade across bare skin.
- The hair itself stays the wearer's. Transferring the persona's hairstyle is out of scope for the 2D pipeline.

### 1. Calibrate the wearer's hairline once, not every frame
- **When:** the first time the face is held frontal (|yaw| and |pitch| < 10°) for ~1 s.
- **Columns:** cast rays from the upper face-oval points (54, 103, 67, 109, 10, 338, 297, 332, 284) along the local forehead axis.
  - The axis is the direction from glabella (9) to landmark 10, which follows head roll.
- **Measure:** use the R4 hair mask to find where skin turns into hair on each ray.
  - Store that distance as a ratio of the brow-to-landmark-10 distance, so it doesn't depend on head size.
  - Take the median over ~20 frames.
  - Where the mask is ambiguous, interpolate from neighbouring columns; failing that, use a default ratio of 1.4.
- **Every frame:** place the extension vertices from the stored ratios and the current landmarks.
  - The forehead then moves rigidly with the head, with no per-frame hair-mask jitter in the geometry.
  - The per-frame hair mask is used only for occlusion (alpha).
- **Recalibration:**
  - Add a "Recalibrate forehead" button in the inspector.
  - Recalibrate automatically when, while frontal, the projected hairline disagrees with the hair mask by more than 5% of face height for over 3 s.

### 2. Calibrate the persona's hairline once, at load
- Run the segmenter in IMAGE mode on the persona photo and measure the same column ratios.
- **Hair on the persona's forehead (fringe):**
  - Fill those pixels once, at load, from the surrounding forehead skin in the cropped reference, using a small pyramid push-pull fill. No heavy dependencies.
  - Lower persona alpha slightly over the filled area.
- **No visible hairline** (bald, hat, cropped photo): use the default ratio, with the stretch guard below.

### 3. Extend the mesh to the hairline
- **New vertices:** add two rings above the upper face oval as new indices after 478.
  - A mid-forehead ring at 50% of the way to the hairline.
  - A hairline ring at 100%.
- **Temples:** taper the extension to zero towards the temples (oval points 127/162 and 356/389), so the sides of the face don't change.
- **Both sides:** add the new triangles (oval → mid → hairline) to the topology, and add the new vertices to both the persona UV set and the wearer position set. Because the vertex count matches, the persona's brow-to-hairline span maps exactly onto the wearer's.
- **Stretch guard:**
  - Applies per column where the wearer's forehead height is outside 0.75–1.35× the persona's.
  - Clamp the mapping there instead of over-stretching the texture.
  - Let the colour-matched real skin (R3) show in the remaining sliver near the hairline.
- **Feathering:** recompute the feather weights so the forehead is fully opaque between the brows and the hairline ring.

### 4. One transition, at the real hairline
- **Delete the stacked fades:**
  - the shader's `cranialFalloff`
  - `CranialBoundaryBlender.harmonizeForeheadBoundary`
  - `CranialBoundaryBlender.softenHairlineEdges`, including its per-frame `blur(4px)` canvas filter
  - the forehead part of the 4-ring face-oval feather
- **Replace with:** a narrow feather at the hairline ring (~2–3% of face height), multiplied by `1 − hair` from the mask, so individual strands cut cleanly across the skin.
- Delete `cranialBoundaryBlender.ts` if nothing else uses it.

### 5. Forehead lighting
- R3's relighting must cover the extended region.
- The wearer's low-pass shading on the forehead comes from the real forehead. Exclude hair pixels from that blur and fill them from the surrounding skin.
- Result: the persona photo's own forehead highlight (e.g. the studio light on the Marcus photo) is replaced by the room's light, and the upper and lower forehead get one continuous shading.

### 6. Tests
- Unit-test the pure logic with synthetic landmarks and masks:
  - extension geometry for frontal, rolled, pitched and turned faces
  - ratio estimation from masks, including ambiguous columns
  - the stretch clamp
  - no flipped triangles across yaw ±40°, pitch ±25°, roll ±20°

### Acceptance (clip E, plus contact sheets of clips A, B and E)
- Forehead tone step within ΔE 2 of the driver's own.
- Hairline alignment error < 2% of face height, with < 1 px frame-to-frame jitter.
- Texture slide ~0.
- No band across the forehead.
- Brows sit on the wearer's brow line.

### R4b status (2026-11-11): implemented behind a flag, not yet measured
- Superseded for the measurement by the R4b report (2026-11-12) below; this block describes the implementation.
- **Not measured, so nothing above is claimed as met and no default changed.** The checkout this session ran on has no driver clips (`realism-review/clips/`), no persona test set (`realism-review/personas/`), no `references/personas.json` or reference photo, no `realism-review/before/`, and no identity venv or models. `npm run build` also cannot run there: Windows Application Control blocks Tailwind's native binary (`@tailwindcss/oxide-win32-x64-msvc`, "An Application Control policy has blocked this file") and the package's WASM fallback never returns. The policy was left alone. `npm ci`, `npm test` (159 pass) and `npm run lint` pass.
- Flag `foreheadExtension` (off; persona-reload; needs `segmentation` on and WebGL). Preset `r4` = the R4 defaults with this flag off. Settings: `hairlineFeather` (0.025 of face height), `foreheadStretchMin` / `foreheadStretchMax` (0.75 / 1.35), `foreheadRecalibrate` (a counter; the inspector's "Recalibrate forehead" button bumps it and is shown only while the flag is on).
- What it does (`src/utils/foreheadExtension.ts`, pure, 16 unit tests):
  - Hairline ratio per column (54, 103, 67, 109, 10, 338, 297, 332, 284) = (brow → hairline) / (brow → landmark 10) along the glabella-to-10 axis, so the default 1.4 is 40% of that span above the oval; capped at 2.2.
  - Wearer: after 1 s frontal (|yaw|, |pitch| < 10°) the per-column median of 20 hair-mask measurements is stored; a column measured in under half the samples is interpolated from its neighbours, else 1.4. Geometry never reads the mask per frame. While frontal, a median disagreement over 5% of face height for more than 3 s starts a new calibration; the old ratios stay in use until it completes and the rings ease to the new ones (250 ms).
  - Persona: the load-time segmentation (shared with `personaInpaint`) gives the same ratios; a ray that starts in hair (fringe) is ambiguous, hair inside the forehead polygon is filled by the pull-push inpaint and filled hair pixels get alpha 0.85; a photo with no measurable hairline gets a warning and the default.
  - Mesh: vertices 478–486 (mid ring) and 487–495 (hairline ring), 36 triangles, wedges to oval points 21 and 251. Stretch guard per column: the wearer side stops at 1.35× the persona's ratio, the persona side at wearer / 0.75.
  - One transition: with the extension in, the shader drops `cranialFalloff`, the forehead feather is 1 from the brows to the ring (0.6 on columns 54 and 284), and the persona ends in a screen-space feather under the ring, times the existing hair, hand and glasses masks; the two `CranialBoundaryBlender` passes do not run.
  - Lighting: the relight low pass covers the extension, and the driver paint leaves hair pixels out (coverage-weighted blur fills them from skin).
  - The extension grows in over 500 ms once both hairlines are known and collapses onto the oval otherwise (segmenter missing, masks off, bank keyframes present).
- Checked without the app (scratch harness, not in the repo: the renderer bundled with esbuild and run in headless Chrome on SwiftShader, WebGL2 and WebGL1): the programs compile and link with no GL error; extension inactive renders pixel-identical alpha to the base topology at the probe points; active, alpha is 255 from under the oval to mid-extension, 160 inside the feather, 0 above the ring; under a hair mask 0, on skin 255; just under the hairline the relit luma is 118 with hair in the driver low pass and 140 with it left out (interior 140).
- Review tool: `summary.hairlineAlignment` (was a placeholder) = persona top edge at alpha 50% against the hair-mask boundary across the middle of the forehead, mean px and % of face height, on captures with |roll| ≤ 10° and |yaw| ≤ 15°; `summary.forehead` records the calibration; grid and compare rows added.
- Deviations from the plan above:
  - The stacked fades, `cranialFalloff` and `cranialBoundaryBlender.ts` are not deleted: they are the flag-off path and the no-segmenter fallback, so `r0`–`r4` still reproduce their phases. Delete them when this flag's default is accepted (same rule as the 5-zone gain).
  - Far silhouette: from about 30° of yaw the far temple and then the far columns fold behind their inner neighbours, and no triangle attached to a folded oval edge can keep its orientation. A column next to a folded edge loses its extension (`foldWeights`, fading over 0.12 spans of advance), which makes those triangles zero-area. The no-flip test therefore asserts "never the opposite orientation" over yaw ±40°, pitch ±25°, roll ±20°, and strictly positive area up to ±20° of yaw.
  - Temples: the taper is the wedge to 21 / 251 plus the 0.6 feather on the outer columns, not a taper reaching 127/162 and 356/389.
  - Hairline jitter: `stepPx` is the change between capture times. Frame-to-frame jitter needs the overlay and masks in the burst, which the burst does not carry.
  - `twoBandBlend` (off) fades the extension out, since its bands are 0 on the new rings. The Canvas 2D fallback keeps the base mesh.
- To finish the phase on a machine with the review material: `npm run build:review`, then `realism:capture --clip all` with `--flags r4` and with `--flags r4,foreheadExtension=1` (same frozen build, same session), `realism:compare`, the 28-persona grid for both, the identity delta against `r4-final`, and contact sheets of A, B and E. The extension lands about 3 s into a clip (segmenter ready, 1 s frontal, 20 masks), so captures before that show the R4 forehead.

### R4b report (2026-11-12): measured, default stays off
Machine and material differ from R0–R4, so nothing here is a delta against a tracked run: clips A–E were recorded on this machine on 2026-11-12 (720p, 60 fps), the default persona is the synthetic face p12 (pending consent record, review build), the 28-persona set is a fresh `realism:personas` selection (the earlier `--replace` swaps are not reproducible here), and the GPU is an Intel UHD at 20–33 fps with other load. All comparisons are `--flags r4` (before) against `--flags r4,foreheadExtension=1` (after) from the frozen `dist-r4b` build, three runs each (`r4b-base`, `-base2`, `-base3`; `r4b-ext`, `-ext2`, `-ext3`), plus one grid each (`r4b-grid-base`, `r4b-grid-ext`).

**Before → after per clip (three runs each, shown as run 1 / 2 / 3)**

| Clip | Extension active | Hairline alignment over the burst (% face height) | Hairline jitter (px/frame) | Forehead tone step Δ vs driver (ΔE) | Texture slide (px/frame) |
|---|---|---|---|---|---|
| A | yes, all runs | 27.0 / 26.9 / 26.9 → 2.6 / 2.6 / 2.5 | 0.26 / 0.16 / 0.13 → 0.28 / 0.34 / 0.21 | −0.26 / −0.25 / −0.29 → −0.06 / 0.15 / 0.19 | 0.18 / 0.13 / 0.12 → 0.23 / 0.13 / 0.15 |
| B | never | no upright burst frames | not measured | −0.44 / −0.20 / −0.30 → −0.23 / −0.33 / −0.40 | 2.09 / 1.37 / 0.89 → 1.36 / 1.37 / 1.58 |
| C | yes, all runs | 26.5 / 26.6 / 26.1 → 2.4 / 4.3 / 3.1 | 2.41 / 2.87 / 2.87 → 1.36 / 4.13 / 2.14 | −0.18 / −0.37 / −0.15 → −0.67 / −0.38 / −0.19 | 2.71 / 2.45 / 3.21 → 2.46 / 2.56 / 2.06 |
| D | yes, all runs | 29.7 / 29.7 / 29.2 → 1.8 / 1.6 / 1.8 | 0.46 / 0.23 / 0.35 → 0.23 / 0.17 / 0.39 | −0.30 / −0.38 / −0.28 → −1.15 / −1.05 / −1.16 | 0.30 / 0.24 / 0.33 → 0.32 / 0.28 / 0.36 |
| E | never | extension inactive | extension inactive | 0.03 / −0.08 / −0.35 → −0.14 / −0.07 / −0.02 | 3.47 / 3.08 / 5.51 → 0.96 / 2.38 / 2.52 (driver's own 3.49 / 2.49 / 4.20 → 0.33 / 2.37 / 2.32) |

Alignment over the eight capture times is higher than over the burst (A 6.0, C 13.0, D 2.2–4.6) because the first capture falls before the extension lands and C has the hand and hair over the forehead.

**Acceptance**
- Forehead tone step within ΔE 2 of the driver's own: met on every clip, with and without the flag (largest gap −1.16 on D). It does not separate the two configurations; on D the flag moves it from −0.3 to −1.1.
- Hairline alignment < 2% with < 1 px jitter: met on D (1.6–1.8%, 0.17–0.39 px); A misses the alignment (2.5–2.6%) and meets the jitter; C misses both. Not measurable on B and E.
- Texture slide ~0 on clip E: **not measured**. The extension never became active on E in any run, so E shows the R4 forehead in both configurations and its slide differences are run-to-run noise.
- No band across the forehead, brows on the wearer's brow line: by eye on the A and D sheets, yes once the extension is in; not measured.

**Identity guard (trend only; r4 → flag on, three runs each)**

| Clip | Margin (persona − wearer) | Output ↔ persona |
|---|---|---|
| A | 0.14 / 0.11 / 0.14 → 0.12 / 0.20 / 0.21 | 0.55 / 0.53 / 0.55 → 0.51 / 0.55 / 0.56 |
| B | −0.10 / −0.16 / −0.15 → −0.23 / −0.32 / −0.34 | 0.40 / 0.39 / 0.39 → 0.33 / 0.28 / 0.26 |
| C | 0.05 / 0.01 / 0.06 → 0.08 / 0.13 / 0.13 | 0.50 / 0.47 / 0.50 → 0.49 / 0.53 / 0.53 |
| D | 0.10 / 0.13 / −0.04 → 0.18 / 0.11 / 0.18 | 0.55 / 0.56 / 0.49 → 0.57 / 0.54 / 0.57 |
| E | −0.28 / −0.03 / −0.24 → −0.02 / 0.04 / −0.12 | 0.27 / 0.45 / 0.28 → 0.46 / 0.50 / 0.39 |

Where the extension is in (A, C, D) the margin is level or a little higher. On B it is lower in all three runs with no overlap. E spans 0.25 within one configuration, so it shows nothing. No delta against `r4-final` exists (different clips and persona).

**Grid, 28 personas × 5 clips (one run each; means include B and E, where the extension is inactive)**

| Metric | Median | Worst 10% |
|---|---|---|
| Hairline alignment (% face height) | 26.5 → 14.7 | 27.1 → 15.8 |
| Hairline jitter (px/frame) | 1.64 → 1.40 | 2.19 → 2.17 |
| Forehead tone step Δ (ΔE) | −0.16 → −0.57 | −0.06 → 0.05 |
| Texture slide (px/frame) | 1.28 → 1.44 | 1.63 → 1.74 |
| Identity margin deficit | 0.33 → 0.25 | 0.50 → 0.48 |
| Output ↔ wearer cosine | 0.61 → 0.55 | 0.72 → 0.68 |
| Sharpness gap, interior skin | 0.29 → 0.30 | 0.52 → 2.70 |

"No persona may regress" is not met: `realism:compare` lists 60 persona-metric regressions. Its noise thresholds come from the earlier machine and are too tight for this one, but three are far outside any noise: interior sharpness gap p21 −0.27 → 8.90, p04 −0.10 → 2.46, p01d 1.15 → 2.39. Hairline jitter rises on p09 (1.80 → 3.56), p04, p19 and p23.

**Contact sheets** (local, not tracked): `realism-review/out/r4b-sheets/A-base-vs-ext.png`, `B-base-vs-ext.png`, `B-base3-vs-ext3.png`, `E-base-vs-ext.png` (r4 left, flag on right); per-clip sheets under each run folder.

**What still looks fake (ranked, by eye)**
1. Flag on, extension not yet calibrated: the persona is visibly fainter and blurrier than with the flag off (all of clip B; the first capture of clip A). The camera-match blur bias runs higher (B mean 3.1–3.6 against 2.0–2.4). Cause not established.
2. The persona is harder and darker than the soft webcam frame (deep eye sockets, strong beard edge) in both configurations.
3. With the extension in, the hairline edge has an irregular notch on one side of the forehead (clip A from 12.9 s).
4. Clip B at 20–36° yaw: eyes and nose smear in both configurations.
5. Clip E: the hand on the head and a face close to the camera; the R4 forehead band stays because the extension never lands.

**Findings and deviations**
- Calibration is too strict for this setup: it needs about 3 s of unbroken frontal hold (1 s dwell plus 20 masks at ~10 masks/s) inside ±10° yaw and pitch. The resting pitch here reads −6° to −10°, clip B starts turning at once and on clip E a hand covers the hairline. It never completed on B or E in three runs. Likely causes, not confirmed by a trace.
- The upright filter in the hairline metric rejected every frame (the app's roll is the eye-line angle, ±180° upright in a mirrored frame); fixed with `uprightFrontal` and a unit test.
- Frame-to-frame jitter is now measured: burst frames carry the persona layer and masks (`summary.hairlineJitter`, grid and compare rows, unit test). The compare noise value for it (0.3 px) is a placeholder; A and D repeat within ~0.2 px, C within ~2.8 px.
- `realism-review/before/` was skipped as agreed. The SFHQ-T2I files were fetched from the public Kaggle endpoint without a login.
- Verification: `npm test` 161 pass, `npm run lint` clean, `npm run build` and `npm run build:review` complete.

**Recommendation: keep `foreheadExtension` off.** Where it activates it does what it was built for (alignment from ~27% to 1.6–2.6% of face height on A and D, jitter under 0.4 px). Three things block a default-on: the persona is degraded whenever the flag is on and the calibration has not completed, the calibration does not complete on two of five clips, and the clip E criterion is unmeasured. Sharpness outliers on three grid personas need an explanation too. Proposed before a re-measure: find and fix the pre-calibration softening, relax the calibration (wider pitch band or a pitch offset learned at rest, fewer samples, tolerate brief breaks), re-record clip E without the hand on the hairline.

### R4b fixes and re-measure (2026-11-12, later): default still off
Fixes in `c6caf2d`, measured from the rebuilt frozen `dist-r4b`: `--flags r4` → `--flags r4,foreheadExtension=1`, three runs each on clips A, B and the re-recorded E (`r4c-base1..3`, `r4c-ext1..3`) and on personas p21, p04, p01d (`r4c-pg-base1..3`, `r4c-pg-ext1..3`). Same machine and caveats as the report above. Clip E is a new 36.9 s recording (a hand still rests on the top of the head in it, clear of the hairline).

**What was fixed**
- Inactive extension renders as r4: the foreshortening weights come from the base triangles only (the collapsed extension triangles had zero screen area against a non-zero UV area and faded the upper oval, i.e. the persona's forehead); the hair exclusion in the driver low pass scales with the extension strength; the lowered alpha on filled hair applies only above the oval. Unit test: weights equal the r4 weights collapsed, half grown, grown, and at ±25° / ±40° yaw.
- Calibration: pitch band ±18° (yaw ±10°), 400 ms dwell, 12 samples; up to 250 ms outside the band and measurements with fewer than 5 columns pause the collection instead of restarting it.
- Contour: `smoothHairlineRatios` (3-tap median, then no interior column more than 0.05 below the mean of its neighbours, ends at most 0.4 below their neighbour) on the wearer and persona ratios. Clip A's column 5 went from 1.33 to 1.55.

**Before → after per clip (run 1 / 2 / 3)**

| Clip | Extension active | Hairline alignment (% face height), captures | Over the burst | Jitter (px/frame) | Forehead tone step gap vs driver (ΔE) | Texture slide (px/frame), gap vs driver in brackets |
|---|---|---|---|---|---|---|
| A | 3 of 3 | 27.0 / 27.0 / 27.0 → 2.0 / 2.4 / 2.3 | 27.1 / 27.3 / 26.9 → 2.1 / 2.2 / 2.0 | 0.14 / 0.21 / 0.10 → 0.21 / 0.15 / 0.14 | −0.27 / −0.24 / −0.27 → −0.61 / −0.65 / −0.79 | 0.20 / 0.16 / 0.06 → 0.12 / 0.06 / 0.11 (0.01 / 0.00 / 0.00 → −0.04 / −0.01 / −0.04) |
| B | 2 of 3 | 18.6 / 20.3 / 18.7 → 25.2 (inactive) / 5.0 / 5.4 | no upright burst frames | not measurable | −0.07 / −0.34 / −0.48 → −0.34 / −0.79 / −0.46 | 1.37 / 1.81 / 1.91 → 3.48 / 1.52 / 1.89 (0.83 / 0.55 / 1.43 → 0.96 / 0.98 / 1.15) |
| E | 3 of 3 | 31.7 / 31.7 / 31.6 → 1.7 / 1.9 / 1.9 | 32.1 / 32.4 / 32.2 → 1.3 / 1.1 / 1.2 | 0.35 / 0.53 / 0.63 → 0.36 / 0.21 / 0.17 | 0.11 / 0.14 / 0.08 → −1.73 / −1.77 / −1.60 | 0.78 / 0.59 / 0.53 → 0.87 / 0.85 / 0.85 (0.29 / 0.09 / 0.00 → 0.28 / 0.29 / 0.40) |

**Acceptance (clip E)**
- Forehead tone step within ΔE 2 of the driver's own: met (−1.6 to −1.8), but it moved from about +0.1 and now sits near the limit.
- Hairline alignment < 2%, jitter < 1 px: met in all three runs (1.7–1.9% over the captures, 1.1–1.3% over the burst; 0.17–0.36 px). Clip A is at 2.0–2.4%.
- Texture slide ~0: the output slides 0.85–0.87 px/frame against the driver's own 0.45–0.60, a gap of 0.28–0.40 px (r4: 0.00–0.29). Inside the tool's 0.5 px tolerance, not zero, and slightly up.
- No band across the forehead: met on A and E by eye. Brows on the brow line: yes by eye.

**Identity guard (trend only; run 1 / 2 / 3)**
- A: margin 0.13 / 0.14 / 0.14 → 0.14 / 0.26 / 0.18.
- E: 0.03 / 0.04 / 0.04 → 0.16 / 0.15 / 0.15.
- B: −0.38 / −0.48 / −0.22 → −0.14 / −0.28 / −0.09; inside the clip's own bistable range (below), so no conclusion.

**p21, p04, p01d: interior sharpness gap (run 1 / 2 / 3)**

| Persona | Clip A | Clip B | Clip E |
|---|---|---|---|
| p21 | 6.29 / 8.87 / 3.07 → 2.04 / 15.03 / 0.01 | −0.09 / −0.08 / −0.24 → −0.09 / −0.34 / −0.30 | −0.50 / 0.27 / −0.47 → 3.00 / −0.41 / 0.67 |
| p04 | −0.03 / −0.11 / −0.16 → −0.19 / 0.19 / 0.04 | −0.13 / −0.14 / −0.33 → −0.13 / −0.11 / 0.02 | −0.33 / −0.47 / −0.37 → −0.11 / −0.16 / −0.53 |
| p01d | 1.60 / 1.29 / 1.91 → 1.45 / 0.88 / −0.33 | −0.22 / −0.24 / −0.26 → −0.32 / −0.31 / −0.28 | −0.35 / −0.30 / −0.37 → −0.26 / −0.41 / −0.13 |

The spikes are not caused by the flag: p21 on clip A spikes in r4 in all three runs (3.1–8.9), and p01d on clip A sits at 1.3–1.9 in r4. p04 shows no spike in either configuration. p21 is unstable in both (0.01 to 15.0 with the flag, one 3.0 on clip E). On these personas the extension was active in 9 of 9 runs on A and E, 8 of 9 on B; hairline alignment 2.5–3.1% on A, 1.8–2.6% on E, jitter 0.14–0.52 px.

**Clip A notch (from 12.9 s)**: gone. The top edge of the persona layer is level across the forehead where it had a raised corner and a dip. A step of a few pixels remains about a third of the way across.

**What still looks fake (ranked, by eye)**
1. Flag on, clip E: an orange patch on the upper middle of the forehead near the hairline in about half the captures. It is the persona's filled forehead (p12's hair covers five of nine columns, so that skin is invented by the fill) stretched over a tall wearer forehead (hairline ratio 2.0 against the persona's 1.6).
2. A faint vertical tone seam in the persona's forehead where filled skin meets photographed skin (clip A).
3. The persona is harder and darker than the soft webcam frame in both configurations.
4. Clip B at 20–36° yaw: eyes and nose smear in both configurations.

**Logged for R5/R6: camera-match blur is bistable on clip B (R4, not R4b)**
Over 30 extra runs of clip B (r4 on the new build, r4 on the previous commit, flag on, flag on without the hair exclusion) every configuration fell into one of two states: blur bias near 2 with identity margin about −0.2, or blur pinned at 4.0 with margin about −0.55. r4 on the previous commit gave −0.64 / −0.52 / −0.56 in the afternoon against −0.10 to −0.16 in the morning. The "flag is worse on B" result in the report above was this, not the flag. Trigger not found; the loop was not changed. p21's sharpness instability on clip A may be related.

**Deviations**
- The 28-persona grid was not rerun on the fixed build; the grid numbers in the report above are from the unfixed build.
- Calibration still missed on clip B in 2 of 12 runs (the head starts turning about 1.5 s in); the output is then the r4 forehead.
- The dev server cannot run the segmenter, so diagnostic variants were separate builds, since deleted.
- Verification: `npm test` 163 pass, `npm run lint` clean, `npm run build` and `npm run build:review` complete.

**Recommendation: not yet.** The measured blockers are cleared: an inactive extension equals r4, calibration completes on A and E every time, clip E meets alignment, jitter and tone step, the notch is gone and the sharpness spikes are pre-existing. Two things remain before the default changes: the orange patch on the upper forehead on clip E (item 1, a by-eye failure of "natural"), and the rule that a default changes only after a grid comparison, which has not been run on the fixed build.

---

## Phase R5 — Head turns, references, and performance

### 1. Use the secondary keyframe
- This only applies to real keyframes: separate photos from the enrollment flow (item 2). The synthetic ones are off since R1.
- Each real keyframe gets its own forehead calibration (R4b).
- Upload one texture per keyframe once; never call `texImage2D` on a switch.
- Render with two samplers and two UV sets, cross-fading by the bank's weight over ~150 ms.
- Add a test that switching keyframes uploads nothing.

### 2. Guided persona enrollment (better references and stronger consent)
- **Who and how:** the person whose face will be used sits at the webcam, reads and accepts the consent text, and is guided through capturing the reference set:
  - neutral frontal
  - ±25° yaw
  - ±15° pitch
  - open mouth ("aah")
  - smile
- **Quality checks:** each shot is checked live for pose, blur and exposure.
- **Why this matters for realism:** the references are captured with the same kind of camera and lighting, which beats forwarded phone photos.
- **Consent record:** store the attestation with the image hashes, locally. This works alongside photo upload; it doesn't replace it.

### 3. Frame pacing
- Drive the loop with `requestVideoFrameCallback`, so each camera frame is processed exactly once. Fall back to rAF with a changed-frame check.

### 4. Single GL pipeline
- Composite base frame, persona and masks in one WebGL2 pass.
- This replaces drawing the WebGL canvas into 2D canvases and the overlay-layer passes.
- The watermark is still drawn last (it may stay a 2D-canvas pass on the final frame).

### 5. Use MediaPipe's head pose
- Enable `outputFacialTransformationMatrixes`.
- Use its pose for keyframe selection, with a unit-tested matrix→Euler conversion.

### Acceptance
- 30 FPS at 720p with p95 frame time < 40 ms on this machine, for both personas.
- No visible pop when keyframes switch on clip B.

### R5 status (2026-11-12): implemented behind flags (measured in the report below)
Branch `realism/r5-keyframes-perf`. `foreheadExtension` stays off (R4b decision); the upper-forehead orange patch and the camera-match bistability on clip B are carried into R5/R6 as open items. Nothing below changes a default: all five flags are off and `--flags r4` renders as before.

- **Flags:** `keyframeCrossfade` (persona-reload), `guidedEnrollment`, `videoFramePacing`, `singleGlComposite`, `matrixHeadPose`. Every preset (`r0`…`r4`) sets them to 0.
- **§1 Secondary keyframe (`keyframeCrossfade`)**
  - `src/utils/keyframeBlend.ts`: `KeyframeTextureCache` (one GPU resource per keyframe source, uploaded on first use, counted) and `KeyframeCrossfader` (150 ms smoothstep from the old keyframe to the new one; a switch back reverses the running fade, a third keyframe fades from the dominant one).
  - Renderer: `setKeyframePair(a, b, mix)`, `warmKeyframes`, `clearKeyframes`, `keyframeUploads`. The fragment shader samples `uTexture`/`uTexture2` with `vUv`/`vUv2` and mixes by `uKeyMix`; each keyframe has its own relight low pass (render-to-texture), mixed the same way. A switch binds textures and a small UV buffer; no `texImage2D`.
  - Engine: a persona's `references` (enrollment shots) become bank keyframes through the same crop and de-light as the persona photo; all are uploaded when the persona is prepared.
  - Tests: "switching keyframes uploads nothing" (cache plus fader over 500 frames), fade shape, reversal. Scratch GL check (headless Chrome, WebGL2 and WebGL1): 3 uploads at warm-up, 0 over 60 switches with and without relight, mix 0 / 0.5 / 1 gives the expected colours, no GL error.
- **§2 Guided enrollment (`guidedEnrollment`)**
  - Library → "Guided capture at the webcam". Consent first (name, scope, "I am the person at this camera"), then seven shots: frontal, yaw ±25°, pitch ±15°, open mouth, smile. Each is checked live for pose (relative to the frontal shot), expression, blur (Laplacian variance of the face crop) and exposure, and taken after a 600 ms still hold. Saving signs a consent record listing the SHA-256 of all seven photos and stores it locally; photo upload is unchanged.
  - Only a live webcam qualifies (`getEnrollmentFrame` returns nothing for a clip or the demo image).
  - `src/utils/enrollment.ts` is pure and unit-tested: steps, `evaluateShot`, `ShotHold`, image statistics, `buildEnrollmentConsent` (throws without the attestation, a name, live-call consent or a hash), `enrollmentPersona` (throws when the record does not cover every shot).
  - Not exercised end to end: it needs a person at a webcam.
- **§3 Frame pacing (`videoFramePacing`)**: `src/utils/framePacing.ts` (`FramePacer`): `requestVideoFrameCallback` when present, otherwise `requestAnimationFrame` with a changed-frame check; a 250 ms watchdog keeps the loop alive when no video frame arrives. Unit-tested with a fake browser (30 camera frames at a 60 Hz display → 30 ticks).
- **§4 Single GL composite (`singleGlComposite`)**: `compositeBase` draws the camera frame under the persona in the WebGL canvas (destination-over, after the persona-layer readbacks), then one `drawImage` to the output and the watermark last. Plain transformed view only; split, side-by-side and picture-in-picture keep the 2D path, as does a frame that needs the geometric hairline passes. Scratch GL check against the 2D compositing: ±1/255 at 1:1 scale, up to 9/255 at hard edges where the camera frame is rescaled.
- **§5 Head pose (`matrixHeadPose`)**: `src/utils/headPose.ts` (`matrixToEuler`, R = Ry·Rx·Rz, scale removed, both storage orders, gimbal lock; `driverPoseFromMatrix` in the display convention). Unit-tested against `eulerToMatrix` round trips and the quaternion path of `rigidPose`. Used for keyframe selection; enrollment stores both poses per shot.
- **Review tool:** captures carry `matrixPose`, `keyframeSecondaryId`, `keyframeMix`; `summary.r5` records keyframe uploads, pacing mode, skipped ticks and whether the single GL path ran; `loadPersona` accepts `references`.
- **Verification:** `npm test` 191 pass, `npm run lint` clean, `npm run build` and `npm run build:review` complete (review build kept in `dist-r5/`, `dist/` is the production build).
- **Smoke run only (clip A, once, flags off and on; not a measurement):** no page errors; `videoFramePacing` and `singleGlComposite` engage. Two things to look at first in the capture suite:
  - With all four runtime flags on the loop processed 383 frames against 741 (17 against 35 fps). The suspect is `requestVideoFrameCallback` on the hidden video element; the flags have to be measured one at a time.
  - Tracking takes about 24 ms of a 26 ms frame on this GPU; compositing is about 0.3 ms. The single GL pass therefore cannot move the frame time much here, and the 40 ms p95 target depends on the tracker.
  - Matrix and landmark pose agree in sign for yaw and pitch on the four frames checked (small angles only); roll is 0 for an upright head where the landmark estimate reads ±180°.
- **Deviations**
  - The cross-fade is time-based on a switch (150 ms), not driven by the bank's blend weight: that weight never drops below 0.65, which would leave a permanent ghost of the second keyframe.
  - Real keyframes skip the persona inpaint and the per-keyframe forehead calibration (R4b is off); they get the crop and de-light only.
  - The keyframe path cannot be captured headlessly yet: there is no persona with enrollment shots on this machine.
  - In the single GL path the debug panel's "persona layer" preview is refreshed only on captured frames.

---

### R5 report (2026-11-12, later): measured, all five flags stay off
Build `dist-r5/` (review build of this branch), Chrome on the Intel UHD adapter, clips A–E, two passes of six configurations (`r4` alone and `r4` plus each flag: `videoFramePacing`, `singleGlComposite`, `matrixHeadPose`, `keyframeCrossfade`, `keyframeCrossfade` with `matrixHeadPose`). Runs `r5-<cfg>-1` and `r5-<cfg>-2` under `realism-review/out/`. Pass 1 began on battery (reports carry `app.system.power`), so every timing below is from pass 2, on mains. The persona in all runs is the exported enrollment (below): six shots of the wearer himself, review-only.

**Before → after per clip (pass 2, `r4` → `r4` + flag; A / B / C / D / E)**

| | `r4` | + `videoFramePacing` | + `singleGlComposite` | + `matrixHeadPose` | + `keyframeCrossfade` | + keyframes and matrix pose |
|---|---|---|---|---|---|---|
| fps | 31.0 / 27.3 / 30.3 / 29.9 / 31.3 | 18.5 / 19.1 / 16.8 / 18.5 / 17.2 | 31.0 / 27.8 / 30.2 / 29.4 / 30.9 | 31.0 / 28.7 / 30.8 / 30.8 / 31.3 | 29.9 / 29.5 / 34.1 / 30.4 / 30.4 | 32.7 / 29.3 / 30.9 / 31.1 / 34.3 |
| frame p95 (ms) | 62 / 81 / 75 / 76 / 66 | 89 / 60 / 78 / 56 / 95 | 71 / 83 / 80 / 79 / 73 | 70 / 81 / 72 / 76 / 72 | 75 / 65 / 54 / 74 / 75 | 70 / 89 / 76 / 70 / 56 |
| frames processed | 632 / 468 / 637 / 860 / 1032 | 400 / 314 / 354 / 535 / 592 | 691 / 473 / 593 / 841 / 1073 | 641 / 477 / 623 / 870 / 1039 | 650 / 488 / 647 / 868 / 1060 | 683 / 471 / 631 / 903 / 1090 |
| frame time outside the tracker (ms, mean) | 2.2 / 2.1 / 1.9 / 1.9 / 2.1 | 2.1 / 2.0 / 2.0 / 2.0 / 2.0 | 1.8 / 1.8 / 1.8 / 1.9 / 1.8 | 2.0 / 1.9 / 1.9 / 1.9 / 1.9 | 2.0 / 2.3 / 2.1 / 1.9 / 2.0 | 2.0 / 1.9 / 2.0 / 1.9 / 2.0 |
| keyframe uploads | 0 | 0 | 0 | 0 | 6 on every clip | 6 on every clip |
| sharpness gap (output against driver, ±0.15) | −0.14 / 0.49 / 0.31 / −0.29 / −0.26 | −0.18 / 1.42 / 1.99 / −0.23 / −0.08 | −0.16 / 0.91 / 0.25 / −0.33 / −0.26 | −0.23 / 0.32 / 0.26 / −0.21 / −0.18 | 0.11 / 0.63 / 0.17 / −0.23 / −0.19 | −0.07 / 0.68 / 0.76 / −0.30 / −0.25 |
| seam step gap (ΔE, ≤ 1) | −0.04 / 0.45 / −0.07 / −0.03 / 0.04 | −0.01 / 0.28 / −0.07 / −0.01 / 0.03 | 0.05 / 0.35 / 0.60 / 0.01 / −0.04 | −0.03 / 0.15 / −0.12 / −0.03 / 0.06 | −0.05 / 0.09 / −0.15 / −0.09 / 0.05 | −0.01 / 0.04 / −0.14 / −0.03 / 0.06 |
| texture slide gap (px/frame, ≤ 0.5) | 0.01 / 0.43 / −0.15 / 0.00 / −0.14 | 0.02 / 0.22 / −0.19 / −0.01 / −0.09 | 0.05 / 1.39 / −0.27 / 0.24 / 0.15 | 0.02 / 0.79 / 0.10 / −0.01 / −0.06 | −0.01 / 1.18 / 0.01 / 0.01 / 0.06 | 0.01 / 0.43 / −0.01 / 0.02 / −0.08 |

- **Identity (SFace), delta against `r4`:** output↔persona 0.94 / 0.63 / 0.82 / 0.91 / 0.81 for `r4`; with keyframes and the matrix pose 0.94 / 0.69 / 0.81 / 0.91 / 0.81 (delta 0.00 / +0.06 / −0.01 / 0.00 / 0.00); with `keyframeCrossfade` alone 0.93 / 0.63 / 0.77 / 0.91 / 0.78 (C and E lower in both passes). The other three flags are within ±0.01 except clip B, which moves by up to 0.08 between passes of the same configuration. The persona here is the wearer himself, so the margin against the wearer says nothing in this phase (−0.01 to −0.19 in every configuration).
- **Persona grid (median and worst 10%):** not run. The 28 synthetic personas have one photo each, so the keyframe path cannot run on them; the three other runtime flags showed no quality change on the clips. A grid pass for `matrixHeadPose` and `singleGlComposite` is still owed before either default could change.
- **Contact sheets** (local, not tracked): `realism-review/out/r5-sheets/B-switch-1.60.png`, `B-switch-5.86.png`, `B-switch-9.67.png` (12 frames at 40 ms around three keyframe switches; rows driver / `r4` / keyframes) and `A-`, `B-`, `C-base-vs-keyframes.png`.

**Acceptance**
- **30 FPS at 720p:** about met on mains. `r4` runs 29.9–31.3 fps on A, C, D, E and 27.3 on B; no flag changes that except `videoFramePacing`, which lowers it to 17–19.
- **p95 < 40 ms:** not met. p95 is 62–81 ms for `r4` and 54–89 ms with the flags; the median frame is 20–23 ms. The tracker is the whole of it: its p95 is 60–79 ms, and everything else in the frame averages 2 ms. No R5 flag touches the tracker.
- **No visible pop on a keyframe switch (clip B):** met on the sheets and the numbers. The dense frames catch each fade midway (mix 1.00 → 0.89 → 0.65 → 0.20 → 0 at 1.60 s; similar at 5.86 s and 9.67 s) with no step between neighbours. Flicker gap across the switch: 0.45 / 0.25 / 0.67 with keyframes against 0.53 / 0.65 / −0.11 for `r4` at the same times. Zero texture uploads on a switch: 6 at load, 6 at the end of every clip (12 switches on clip B).
- **Clip A (expressions):** nothing to judge. Clip A never leaves the frontal keyframe, and the smile shot is never selected on any clip (on clip C the smile at 17.4 s falls on the chin-up shot); there is no open-mouth shot.

**Per flag**
- **`videoFramePacing`: a real throttle, not duplicate removal.** A probe with its own `requestVideoFrameCallback` on clip A: flag off, 477 frames processed with a median gap of 33 ms; flag on, 317 processed with a median gap of 67 ms (on battery, same conditions for both). On mains the suite shows 400 against 632 frames on clip A. The engine's skipped-tick counter is 0, and at 31 fps on a 30 fps clip the plain loop has at most a few percent of duplicate ticks to remove, so duplicates explain almost none of the loss. Cause: the callback is requested again only after a frame has been processed, and a 20–30 ms frame makes it miss every other video frame. A loop that keeps processing on animation frames and uses the video callback only to mark "new frame" would avoid this; not done in R5. On this machine the frame costs more than one display refresh, so even a correct version has little to save.
- **`singleGlComposite`: correct but no measurable gain.** Compositing falls from 0.3 to 0.1–0.2 ms and the frame outside the tracker from about 2.1 to 1.8 ms, inside the run-to-run noise of a 20–30 ms frame.
- **`matrixHeadPose`: needed for keyframes, no effect alone.** With keyframes on clip B the matrix pose selects the matching shot at every turn (12 switches). With the landmark pose the selection is wrong on the pitch moves: the turned-left shot is chosen at 38° chin-up and alternates with the chin-down shot four times within 0.6 s. The matrix pose keeps tracking where the landmark estimate clamps (yaw past 55°, pitch past 45°); the two agree in sign throughout clip B, with the matrix pitch about 10° above the landmark pitch.
- **`keyframeCrossfade` (with `matrixHeadPose`): works and looks better on turns, not ready as a default.** On the turned frames the eye region is cleaner than the single-photo render. Open points: the output is sharper than the driver on clip B (+0.63 to +0.79 in all four keyframe runs, with the camera-match blur bias at 0.00 in all of them, where `r4` moves between −0.25 and +0.49); the reference set is six frozen frames from clips, not a held-pose enrollment; identity cannot be judged with the wearer as persona.
- **`guidedEnrollment`: exercised end to end by automation, one bug fixed, one shot refused.** See below.

**Guided enrollment, automated (`npm run realism:enroll`)**
- Chrome's fake camera plays `realism-review/enroll/camera.y4m`: seven frames cut from clips B, A and C, each frozen for 3 s. The clips contain no held poses (clip B sweeps through ±25° and ±15°), so frozen frames stand in for them. A `.mjpeg` stream did not advance past its first frame; `.y4m` does.
- The dialog refused to start without a name and without the attestation, then took six shots itself, each passing every check: frontal (yaw 6.5°, pitch −2.2°, sharpness 29.6), turn right (36.5°, 9.8), turn left (−22.1°, 11.6), chin up (−18.0°, 36.3), chin down (17.5°, 14.1), smile (score 0.68, 39.2). Exposure passed on all (mean luma 91–117, clipped 0%).
- **Open mouth was refused, correctly.** The widest mouth in any clip is 0.27 (clip A, speech) against the 0.30 the step asks for; the dialog showed "Open your mouth wider." and did not offer saving the incomplete set. The threshold was not lowered. So the sign-and-save step, and the hash check behind it, have still not run end to end.
- **Bug found and fixed:** the studio stopped its tracker whenever a dialog was open, so the enrollment's checks read frozen tracking and could never pass after the first shot, for a person at the webcam as much as for the automation. The tracker now keeps running while the enrollment dialog is open, and a stopped engine reports no enrollment frame (`src/utils/enrollmentSource.ts`, unit-tested).
- **Export bridge:** the dialog publishes its state to the realism hook (`enrollment()`); the tool writes the shots and `enrollment.json` to `realism-review/enrolled/<name>/` (gitignored) and `realism:capture --enrolled <dir>` loads them as a persona with reference keyframes. The export is marked review-only and carries no consent record: the attestation the script ticks is not a person's consent, so the persona loads with a pending record, which only a review build activates (`tools/realism/enrollExport.ts`, unit-tested).

**What still looks fake (ranked)**
1. Ring-shaped ghost around the eyes on clip B in `r4` (visible on all three switch sheets); weaker with the turned keyframes.
2. Keyframe output sharper than the camera on clip B (see above).
3. Carried from R4b: orange patch on the upper forehead (clip E), camera-match bistability on clip B (blur bias 0.25 and 0.71 for `r4` in the two passes).

**Deviations**
- Pass 1 timings are not used (battery, then mains from the third configuration on). `systemLoad` now records mains or battery in every report.
- Two passes, not three; no persona grid.
- Enrollment incomplete (6 of 7) and from frozen clip frames; the persona is the wearer.
- The frontal step accepts up to 18° of pitch before a baseline exists: in one automated attempt it took the chin-down frame (17.4°) as the frontal shot. The script now starts on a straight face, as a person would; the band itself is unchanged and should be reviewed in R6.
- Clip metadata: the clips are in a 60 fps container with about 30 distinct frames per second.

**Recommendation: no default changes.**
- `videoFramePacing`: off; redesign in R6 or drop.
- `singleGlComposite`: off; no benefit measured.
- `matrixHeadPose` and `keyframeCrossfade`: the pair to turn on next, after a live guided enrollment with held poses (which also completes the save path), a second person as persona so identity can be read, and the sharpness on clip B understood.
- `guidedEnrollment`: off until a person has completed it at a webcam.
- The p95 target needs work on the tracker (R6): input size, delegate, or tracking every frame on a worker.

## Phase R6 — Tuning pass

- With all flags available, run clips A–E across a small grid of the main parameters:
  - `uToneMatch`
  - blur/noise strength
  - lip fade
  - eye pass-through radius
  - boundary feather widths
  - hairline feather width and the forehead stretch-guard limits
- Pick defaults from the metrics plus the contact sheets.
- Present 2–3 candidate presets with their contact sheets, and let me choose.
- Collapse the debug flags into a few user-facing settings with sensible names.

### R6 Part 1 report (2026-11-13): R5/R4b blockers, measured; no default changed
Branch `realism/r6-tuning`, build `dist-r6/` (review build), Chrome on the Intel UHD adapter. The persona in every run is the automated enrollment `realism-review/enrolled/r6-auto` (seven shots of the wearer himself, review-only). Verification: two passes of six configurations on clips A–E (`r6v-<cfg>-1`, `r6v-<cfg>-2`); the laptop was on battery for most of pass 1, so the timings below are pass 2, on mains. The tracker experiments (`r6-t0…t6`) ran on battery and are used only for comparisons within that set.

**Before → after per clip (pass 2, on mains; A / B / C / D / E)**

| | `r4` | + `cameraMatchMedian` | + keyframes and matrix pose | + keyframes, matrix pose, median | `r4` with the segmenter on CPU | + `videoFramePacing` |
|---|---|---|---|---|---|---|
| fps | 30.9 / 27.9 / 22.0 / 31.6 / 30.5 | 28.7 / 32.4 / 28.9 / 31.8 / 29.8 | 30.3 / 31.4 / 30.6 / 30.3 / 29.9 | 30.1 / 29.5 / 32.2 / 30.8 / 34.8 | 35.5 / 37.1 / 35.2 / 36.2 / 41.1 | 25.9 / 23.8 / 24.6 / 24.7 / 26.0 |
| frame p95 (ms) | 72 / 79 / 91 / 73 / 71 | 76 / 72 / 81 / 70 / 77 | 72 / 73 / 74 / 74 / 76 | 74 / 75 / 69 / 72 / 58 | 30 / 31 / 31 / 30 / 29 | 60 / 84 / 82 / 82 / 68 |
| sharpness gap (output against driver, ±0.15) | −0.14 / 0.26 / 0.43 / −0.11 / −0.21 | −0.24 / 0.01 / 0.15 / −0.35 / −0.27 | −0.05 / 0.77 / 0.68 / −0.30 / −0.23 | −0.10 / 0.11 / 0.07 / −0.33 / −0.26 | −0.24 / 0.21 / 0.19 / −0.29 / −0.25 | −0.17 / 1.24 / 0.14 / −0.26 / −0.21 |
| output↔persona (SFace) | 0.94 / 0.67 / 0.81 / 0.91 / 0.81 | 0.94 / 0.65 / 0.83 / 0.91 / 0.81 | 0.91 / 0.68 / 0.82 / 0.91 / 0.80 | 0.91 / 0.68 / 0.82 / 0.91 / 0.81 | 0.94 / 0.69 / 0.83 / 0.91 / 0.81 | 0.94 / 0.70 / 0.82 / 0.91 / 0.81 |
| masks delivered over the clip | 172 / 363 / 559 / 784 / 1115 | 175 / 383 / 604 / 893 / 1222 | 183 / 386 / 611 / 898 / 1225 | 174 / 380 / 598 / 892 / 1226 | 69 / 143 / 227 / 330 / 444 | 146 / 260 / 400 / 598 / 830 |

All four fixes together (`videoFramePacing`, keyframes, matrix pose, `cameraMatchMedian`, segmenter on CPU), clips A / B only: 29.3 / 29.2 fps, frame p95 27 / 31 ms, sharpness gap −0.17 / −0.14, output↔persona 0.91 / 0.71.

- **Identity delta against `r4`:** within ±0.03 for every configuration on every clip (the persona is the wearer, so the margin against the wearer still says nothing).
- **Persona grid (median, worst 10%):** not run in Part 1; it belongs to the Part 2 sweep.
- **Contact sheets:** none new in Part 1; the R5 sheets stand for the keyframe switches.

**1. `videoFramePacing`: fixed**
- The video callback now only marks "new frame" and re-arms itself at once; the loop stays on `requestAnimationFrame` and processes a tick only when a frame is marked (`src/utils/framePacing.ts`). With the flag on, the video element stays in the layout at 1 px instead of `display:none`.
- Probe on clip A (flag off → on): median gap between processed frames 33 ms → 33 ms (R5: 33 → 67); 628 distinct frames processed and 370 duplicate ticks skipped, against 767 ticks with the flag off.
- With the GPU segmenter the flag still processes fewer frames than `r4` (555 against 659 on clip A, 24–26 fps): during a 70 ms tracker stall Chrome announces only the newest frame. With the segmenter on CPU the stalls are gone and the paced loop runs at the clip's rate: 29.6 / 29.4 fps on A / B with 511 / 1369 duplicate ticks skipped.
- Tests: the existing pacing tests were adapted to the new contract (a frame is processed on the animation frame after it is announced) with the same counts asserted, and two were added (a loop slower than the camera processes a frame on every tick; the listener re-arms before the frame is processed).

**2. Keyframe sharpness on clip B: the camera-match loop, not the keyframes**
- Trace on clip B with keyframes: just after the persona loads, the loop reads the output as four times softer than the camera (4.2 against 16.7). Its two slow averages are seeded by those readings; at one update per 15 frames, with holds during head motion, the error stays negative for about 9 s while the sharpen control integrates to its limit (1.50). Meanwhile the single readings show the output 5–19 times sharper than the camera (102.9 against 12.2 at 9.6 s).
- The same seeding, with the opposite sign, is the clip B bistability logged in R4b: whether the first readings push toward blur or sharpen decides the rest of the clip.
- Fix behind `cameraMatchMedian` (off): the error is the median of the last seven readings; a control moves only while the newest reading agrees with the median (anti-windup); no reading is taken for 45 frames after a persona or source change, and the consecutive-frame warm start is not used. Unit tests replay the traced sequence against both loops.
- Result: with keyframes the gap on B / C falls from 0.77 / 0.68 to 0.11 / 0.07 (pass 1: 0.20 / 0.74 → 0.10 / 0.07); without keyframes from 0.26 / 0.43 to 0.01 / 0.15 (pass 1: 0.56 / 1.60 → 0.12 / 0.15).
- Open: on A, D and E the median loop leaves the output 0.24–0.37 softer than the camera, the soft end of what the old loop gives there (−0.33 to +0.19 across the R5 and R6 runs). The loop's own readback and the review metric disagree by that much on those clips; this is for the Part 2 sweep, and the reason the flag stays off.

**3. Guided enrollment gates**
- Frontal pitch band 18° → 9.5° (10° itself would also pass the chin steps' band of 15° ± 5°; a new test checks that no pitch is both frontal and a chin shot). Open-mouth threshold 0.30 → 0.26.
- Automated run (`realism:enroll`, new `--start-pose`): 7 of 7 shots, every gate passed, and the dialog signed and saved for the first time end to end. Open mouth was taken at 0.27–0.28 (a frozen frame of speech from clip A; with 0.26 a held speech-wide mouth passes, the 600 ms still hold is what separates it from talking).

**4. Tracker p95: the segmentation model on the integrated GPU**
- Experiments on clips A / B (battery, frame p95): `r4` 140 / 138 ms; segmentation off 40 / 43; segmenter on CPU 38 / 40; tracker on CPU 127 / 172; segmentation every 4th frame 137 / 132; tracker and segmenter on CPU 45 / 44.
- Each mask occupies the GPU for 60–90 ms; the tracker's own GPU sync on the main thread waits behind it. It is not the readback call: a non-blocking readback (pixel buffer and fence, masks byte-identical) left p95 at 75 ms. Moving only the tracker to CPU does not help, and segmenting less often does not either, because every mask still stalls a frame. Both experiment flags were removed again.
- With the existing setting `segmentCpu=1` on mains: 35–41 fps and frame p95 29–31 ms on all five clips; **both performance targets are met**. Cost: a mask every ~300 ms instead of every 60–110 ms (about 40% as many). On these clips the mask metrics do not move (ghost hair 0.00 everywhere; hand leak 0.01 on B and 0.04 on C against 0.00 and 0.03), and tone, seam, lip and identity are within noise. None of the clips has a fast occlusion (a hand crossing the face quickly), which is where slower masks would show.

**What still looks fake (ranked)**: unchanged from R5 (eye-ring ghost on clip B in `r4`; orange forehead patch on clip E), plus the output being softer than the camera on A, D and E with the median loop.

**Deviations**
- Pass 1 timings unused (battery). `kf` in pass 2 was started while the power state read "battery" for a moment; its frame times match the other mains runs.
- Two passes; the all-fixes configuration and pacing with the CPU segmenter were run once, on clips A and B only.
- The R6 tracker experiment reports `r6-t2`, `r6-t5` and `r6-t6` name flags that no longer exist.

**Recommendation for Part 2 (nothing changed yet)**
- Sweep on top of: `segmentCpu=1`, `videoFramePacing`, `matrixHeadPose`, `keyframeCrossfade`, `cameraMatchMedian`.
- Before `segmentCpu` becomes a default: one clip with a fast occlusion, and a decision whether the delegate should be chosen per machine (GPU where a mask takes under about 15 ms).
- A live seven-shot enrollment by a second person is still needed to read identity with keyframes.

### R6 Part 2 report (2026-11-13): sweep and three candidate presets; no default changed yet
Branch `realism/r6-tuning`, review build `dist-r6/`, Chrome on the Intel UHD adapter, mains power for every run. Wearer: the clip author on clips A–F (F, new: 14.7 s with a hand crossing the face fast). Persona for the clip runs: a second person, enrolled live at the webcam with the guided enrollment (`realism:enroll --live`, seven shots, every gate passed, signed and saved in the dialog; exported review-only to `realism-review/enrolled/brother`; his real open mouth measured 0.87, far above the 0.26 gate). Cross-identity check: the 28-persona single-photo grid on clips A and B.

The machine ran at about 19 fps instead of 29 from 16:50 to about 18:25 with nothing else using the CPU (power plan Balanced, mains; most likely thermal or power limiting after five hours of runs). Timings from that window are not used: the frame-time rows below come from a separate check on clips A and B after it had passed (`r6t-*`), and the Balanced grid was run again (`r6h-bal-2`).

**Before → after per clip (`r4` = mean of two passes; presets one pass; A / B / C / D / E / F)**

| | `r4` | Balanced | Identity-forward | Camera-matched |
|---|---|---|---|---|
| fps (A / B, timing check) | 26.0 / 30.2 | 29.3 / 29.5 | 29.3 / 29.6 | 29.8 / 29.5 |
| frame p95 ms (A / B, timing check) | 103 / 68 | 33 / 31 | 31 / 31 | 29 / 30 |
| tracker p95 ms (A / B) | 101 / 65 | 30 / 28 | 27 / 28 | 27 / 27 |
| output↔persona (SFace) | .51 / .37 / .45 / .50 / .43 / .52 | .42 / .37 / .43 / .49 / .43 / .51 | .42 / .36 / .45 / .52 / .43 / .52 | .37 / .30 / .36 / .42 / .36 / .44 |
| identity margin (persona − wearer) | −.15 / −.33 / −.19 / −.17 / −.20 / .01 | −.29 / −.34 / −.23 / −.17 / −.20 / −.10 | −.28 / −.30 / −.19 / −.11 / −.21 / .01 | −.41 / −.48 / −.35 / −.33 / −.38 / −.26 |
| sharpness gap (±0.15) | −.24 / .26 / .40 / −.18 / −.09 / .62 | −.03 / .52 / .43 / −.22 / −.12 / 1.65 | .09 / .10 / .23 / −.07 / .08 / .11 | .06 / 1.49 / 1.32 / −.17 / −.06 / −.32 |
| neck ΔE gap (±3) | −2.00 / −.55 / −1.53 / −1.89 / −2.32 / −1.82 | −.96 / −1.31 / −1.29 / −1.97 / −1.96 / −2.42 | −1.00 / −1.27 / −1.65 / −2.41 / −1.64 / −2.24 | −.64 / −.37 / −.93 / −1.59 / −1.24 / −1.42 |
| ears ΔE gap (±3) | .78 / .08 / −.27 / −.29 / −.38 / .16 | .53 / .18 / −.67 / −.23 / −.33 / .40 | .80 / .23 / −.44 / −.46 / −.05 / .11 | .29 / .01 / −.46 / −.12 / −.28 / .21 |
| seam-step gap (±1) | −.30 / −.04 / −.20 / −.23 / .07 / .10 | −.07 / .18 / −.16 / −.22 / .04 / .01 | −.05 / .06 / −.25 / −.27 / .09 / .07 | −.05 / −.02 / −.07 / −.08 / .06 / −.04 |
| texture slide gap px | .02 / .43 / −.04 / .00 / .01 / −.01 | −.02 / .05 / −.06 / .06 / −.06 / −.01 | .02 / −.08 / .00 / .00 / −.02 / −.19 | .03 / .20 / −.05 / .00 / .12 / −.03 |

The preset clip runs fell in the slow window (18–19 fps), which the camera-match and relight loops see as fewer updates; their sharpness on B and C swings between runs (Identity-forward B: 0.10 here, 2.06 in the timing check; Camera-matched B: 1.49 here, 0.07 in the timing check). Treat single sharpness values on B/C as ±1.

- **Identity delta against `r4` (same persona, same wearer; Part 1 used the wearer as their own persona, so there is no carried-over baseline):** Balanced −0.09 on A, within ±0.02 elsewhere; Identity-forward −0.09 on A, −0.01 to +0.02 elsewhere; Camera-matched −0.07 to −0.14 on every clip. The A loss is shared by every configuration on the new base (also −0.06/−0.07 with the median loop), so it comes from the base (keyframe choice on a frontal clip is the first suspect), not from the presets; by eye every row on the A sheet reads as the persona.
- **Persona grid (28 personas, A + B; median / worst 10%):**

| | `r4` | Balanced | Identity-forward | Camera-matched | Balanced on the median loop (dropped) |
|---|---|---|---|---|---|
| fps / frame p95 ms (median) | 27.2 / 85 | 29.5 / 29 (slow run: 19.0 / 59) | 29.2 / 32 | 29.4 / 30 | 29.4 / 31 |
| output↔persona per persona-clip (higher better) | .234 / .106 | .237 / .093 (.226 / .074) | .225 / .078 | .204 / .074 | .259 / .126 |
| identity margin deficit (lower better) | .364 / .516 | .377 / .532 (.407 / .617) | .413 / .561 | .442 / .622 | .372 / .492 |
| output↔wearer (lower better) | .594 / .717 | .624 / .699 (.654 / .757) | .635 / .730 | .652 / .746 | .611 / .682 |
| identity per persona against `r4` (median; better / worse by > 0.02) | – | 0.000 (5 / 7) | −0.012 (2 / 11) | −0.031 (2 / 17) | +0.007 (8 / 4) |
| \|sharpness gap\| face/ring | .182 / 1.015 | .290 / 3.052 (.173 / 1.457) | .246 / 1.760 | .226 / .983 | 1.321 / 3.358 |
| \|sharpness gap\| interior | .184 / .996 | .250 / 2.844 (.224 / 1.344) | .274 / 1.253 | .261 / 1.085 | 1.094 / 3.875 |
| \|neck ΔE\| | 1.353 / 2.467 | 1.501 / 2.291 (1.370 / 2.314) | 1.512 / 2.338 | 1.428 / 2.153 | 1.688 / 2.761 |
| \|ears ΔE\| | .641 / 1.925 | .705 / 2.039 (.642 / 1.491) | 1.034 / 2.489 | .575 / 1.253 | .725 / 2.114 |
| seam-step gap | .051 / .475 | .062 / .407 (.032 / .287) | .074 / .481 | .067 / .188 | .094 / .521 |
| texture slide gap px | .329 / .598 | .005 / .203 (.021 / .106) | .027 / .125 | .010 / .142 | .056 / .190 |
| flicker delta | −.081 / .334 | .032 / .207 (−.043 / .239) | .006 / .212 | −.020 / .160 | .032 / .196 |
| ghost hair share | .001 / .001 | .002 / .024 (.031 / .096) | .003 / .053 | .002 / .022 | .003 / .039 |
| hand leak share | .000 / .000 | .001 / .002 (.000 / .108) | .001 / .008 | .001 / .001 | .001 / .002 |
| lip error % | 1.15 / 2.23 | 1.24 / 2.07 (1.48 / 2.43) | 1.43 / 2.12 | 1.27 / 2.17 | 1.28 / 3.32 |

  Balanced: `r6h-bal-2` at full speed, the slow-window run `r6h-bal` in brackets. Identity-forward's grid ran partly in the slow window (10th-percentile fps 18.4); the slow Balanced run lost 0.01 of per-persona identity against the full-speed one, so part of Identity-forward's −0.012 may be that. The worst 10% of the sharpness gap is set by a few sharp photos and moves by 2× between runs (p21 alone reads 28.8 in `r6h-bal-2`). The median-loop Balanced run is the most recognisable (+0.007, 8 better / 4 worse) because its output is sharper than the camera (gap 1.32): on this grid sharpness buys recognisability at the cost of the face looking pasted on.
- **Contact sheets** (gitignored): `realism-review/out/r6-sheets/clip-A.png` … `clip-F.png` (rows: driver, `r4`, Balanced, Identity-forward, Camera-matched, Balanced on the median loop) and `grid-A-1…4.png`, `grid-B-1…4.png` (rows: personas; columns: `r4`, Balanced, Identity-forward, Camera-matched).

**1. The median camera-match loop is dropped from the base**
- On the grid every preset built on `cameraMatchMedian` left the output far sharper than the camera: face/ring gap median 0.80–1.43 against 0.18 for `r4`, worst 10% 2.5–4.2 against 1.0.
- One factor at a time on six personas (p01, p02, p04, p09, p21, p23; clips A, B; `r6i-*`), median \|gap\| / fps / frame p95: `r4` 0.21 / 29.2 / 75; + median loop 0.59 / 31.6 / 74; + pacing 0.64 / 24.5 / 78; + CPU segmenter 0.16 / 36.5 / 30; + CPU segmenter and pacing 0.14 / 29.6 / 30; + CPU segmenter and median loop 1.95.
- The median loop fails on sharp single photos (p04, p09, p21, p01), mostly on clip B: it restarts from no blur after every source change, waits 45 frames, and its anti-windup holds whenever the newest reading disagrees with the median, which on these personas is often; it ends at blur ~2 where they need ~4. Pacing alone loses frames to the GPU segmenter's stalls (Part 1) and is fine with the CPU segmenter.
- The steady loop stays, with its clip B bistability on enrolled personas (Part 1 §2) still open; the flag stays off. A loop that converges fast on sharp photos and does not wind up on soft first readings is an R7-or-later item.

**2. One-at-a-time sweep (`r6s-*`, clips A–E, persona `r6-auto` = the wearer, on the median-loop base)**
- Run-to-run noise between two identical base runs: sharpness up to 0.25, neck 0.1 ΔE.
- `skinToneMatch` 0.5 / 0.75 (1): neck median −0.84 / −1.05 (−1.00); 0.5 helps E (−1.00 → −0.39) and costs D's ears (−0.84 → −1.60).
- `cameraMatchSharpness` 1.25 / 1.5: median gap −0.17 → −0.12 / −0.07, C overshoots to +0.33 / +0.43. Dropped with the median loop (on the steady loop it would only sharpen further).
- `cameraMatchNoise` 0.5 / 1.5: 1.5 lifts the sharpness metric (median −0.17 → +0.07, C +0.64); 0.5 no change.
- `lipFadeFloor` 0.3 / 0.6 and `eyePassThroughRadius` 0 / 2: no metric difference beyond noise; radius 2 adds texture slide on B (+0.29 against −0.05).
- `boundaryFeather` 0.6 / 1.5: 1.5 nearly halves the neck gap on C and D (−1.10 → −0.66, −1.65 → −0.97), ears and seam better, output softer (median sharpness −0.17 → −0.37); 0.6 worse on every tone metric (dropped).
- fps 29.2–29.7 everywhere except three runs (`eye2`, `feather60`, `feather150` clip A) at ~19 fps while clip F was being recorded on the same machine.
- Not swept: `hairlineFeather` and the forehead stretch limits act only with `foreheadExtension`, which stays off.

**3. Clip F (fast occlusion) and the CPU segmenter**
- Masks delivered over clip F alone (runs with F first): 41 with the CPU segmenter (one every ~360 ms) against 99 with the GPU segmenter on the same base (`r6c-bal-3F`, `r6c-balgpu-1`); the GPU run drops to 25 fps with frame p95 64 ms (CPU: 29.6 fps, 33 ms).
- Hand leak on F: 0.1–0.4% of the face (CPU, normal speed) against 0.3–1.1% for `r4` and 0 for the GPU segmenter on the new base; ghost hair 0 everywhere. On B the CPU masks leave 0.5–1.6% hand leak and up to 0.3% ghost hair (timing check) against 0 for `r4`. In the slow window, with masks arriving half as often, B reached 17% hand leak in one run: the CPU segmenter needs the machine at full speed.
- On the F sheet the thumb at 4.8 s is covered by the persona only in the Balanced run that fell in the slow window; the other presets show it.

**What still looks fake (ranked)**
1. Mouth on turns and look-ups (B 5.8 s, 9.8 s, 11.8 s; E 12.1 s): a vertical cut through the moustache and lip, and a magenta lip over a dark chin, on Balanced and Identity-forward; less on Camera-matched, much weaker in `r4` at the same times. Keyframe crossfade between references whose mouths differ is the suspect (not verified).
2. Frontal speech (A 15.6–18.2 s): a darker, doubled moustache band on all three presets, the wearer's lips showing through under the persona's moustache.
3. Single-photo grid personas, the same in every column: warped eye region (p03, p05), orange crease streaks (p13), white sclera at strong yaw on B.
4. Output sharpness on clip B with the enrolled persona swings between runs (steady loop).
Better than `r4`: its orange nose and cheeks on A and E are much weaker in all three presets.

**Deviations**
- The approved sweep base included `cameraMatchMedian`; the grid showed it breaks sharp single-photo personas, so the presets were re-run without it (§1). The candidate runs on the median base (`r6c-*`, `r6g-bal|idf|cam`) are kept as evidence.
- The machine slowed down from 16:50 to about 18:25 (see top); preset clip runs are one pass and fell in that window; the timing check covers A and B only.
- The sweep used the wearer as their own persona (the second person enrolled afterwards), so its identity rows say nothing about recognisability.
- `skinToneMatch` 0.75 and `eyePassThroughRadius` 0 (Identity-forward) were chosen from the sweep, where neither moved identity beyond noise.

**Candidate presets (for the user's choice; nothing collapsed or changed yet)**
- Common base: flags `r4` + `videoFramePacing`, `matrixHeadPose`, `keyframeCrossfade` (steady camera-match loop, `cameraMatchMedian` off); setting `segmentCpu=1`.
- **Balanced:** the base alone.
- **Identity-forward:** base + `skinToneMatch=0.75`, `eyePassThroughRadius=0`.
- **Camera-matched:** base + `boundaryFeather=1.5`, `lipFadeFloor=0.3`.
- **Recommendation: Balanced as the default.** Against `r4` it keeps identity on the grid (per-persona median 0.000) and on the enrolled clips except A (−0.09, shared by every preset), takes frame p95 from 68–103 ms to 29–33 ms at the clip's frame rate, cuts texture slide (grid 0.33 → 0.005 px) and the seam step, and leaves skin tone within budget (grid neck worst 10% 2.47 → 2.29; median 1.35 → 1.50). Identity-forward is not measurably more recognisable than Balanced (enrolled clips −0.01 to +0.03 against Balanced; grid −0.012 against `r4`) and its ears are worse. Camera-matched has the best tone and seam numbers but costs identity everywhere (−0.07 to −0.14 on the enrolled clips, 17 of 28 grid personas worse), so it fails "recognisable first" as a default; it could be offered as an opt-in "blend into the camera" setting.
- Before any default changes: the clip A identity loss of the new base (keyframe choice on a frontal clip is the first suspect), the mouth cut on turns, and a per-machine segmenter delegate (GPU where a mask takes under about 15 ms; CPU masks need the machine at full speed).
- After the choice: collapse the debug flags into a few user-facing settings (the plan's last R6 item).

---

## Phase R7 — Neural renderer (separate approval required)

**Why it's separate:** after R1–R6 the 2D warp should look convincing at video-call size with steady framing. It still can't create pixels the reference photos don't contain, so large head turns and big expressions will show the limits. Getting past that needs a neural portrait-animation model (LivePortrait class). That runs in real time only with TensorRT on an NVIDIA GPU, so it can't run in the browser.

**Before starting:** ask me first, then write `docs/sidecar-design.md` and wait for approval.

### Design constraints (summary)
- **Server:** an optional local Python sidecar, bound to `127.0.0.1` with a per-session token. No disk writes, no outbound network.
- **Data flow:**
  - The renderer sends a face crop plus landmarks.
  - The sidecar returns only a face crop, never a finished frame.
  - All compositing, R3 relighting, R4 masks, the R4b forehead extension and the watermark stay in the app.
- **Fallback:** automatic, to the R1–R6 pipeline when the sidecar is missing or slow.
- **Models:** never committed. Each model's licence is recorded in `MODEL_LICENSES.md`. InsightFace pretrained models are non-commercial; prefer permissive alternatives.

---

## Phase report format

```
## Phase RN report
Branch / commits:
What changed (file paths):
Flags/settings added and their defaults:
Metrics, baseline → now (clips A–E; driver value, output value, gap):
Persona grid: median / worst 10% / worst 3 per metric, personas that regressed:
Contact sheets: realism-review/out/<run>/ (paths)
What still looks fake, ranked:
Deviations from plan and why:
Manual steps for me:
```
