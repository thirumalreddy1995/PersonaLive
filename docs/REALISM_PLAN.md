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

---

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
