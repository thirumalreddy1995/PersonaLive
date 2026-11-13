# Phase R7 — Local neural renderer: sidecar design

**Status:** design for review, 2026-11-13. Nothing is implemented. Implementation starts only after approval, beginning with the benchmark gate in §11.

## 1. Why

The R6 visual audit (`docs/REALISM_PLAN.md`) found that the 2D pipeline's output reads as the **wearer**, not the persona. Some causes are 2D bugs that can be fixed, chiefly relighting that copies the wearer's albedo. Others are the ceiling of a 2D mesh warp onto the wearer's landmarks:
- face and head silhouette;
- jaw and cheek volume;
- persona features beyond the face oval, such as a full beard;
- turns past the enrollment poses;
- eyelids and the mouth interior;
- expression-dependent shape.

A neural portrait-animation model of the LivePortrait class animates the **persona's own head**, including its shape, beard and hairline, with the wearer's motion and expression. That addresses the ceiling. It needs an NVIDIA GPU with TensorRT or CUDA, so it cannot run in the browser. It runs as a separate local process, the **sidecar**.

## 2. Hardware reality check (read first)

- **Development laptop** (HP EliteBook 640 G9): it has no NVIDIA GPU (i5-1235U, Intel UHD Graphics only). Device Manager shows no NVIDIA device, there is no NVIDIA driver and no `nvcuda.dll`. The sidecar cannot run there; on that machine the app always uses the R1–R6 pipeline.
- **Target GPU, RTX 500 Ada Laptop:** 2,048 CUDA cores, 64 Tensor cores, 4 GB GDDR6 on a 64-bit bus (roughly 96–128 GB/s), 35–60 W. It is presumably in the ThinkPad P14s used for R0–R4; this needs confirming.
- **For comparison:** the RTX 4090 that LivePortrait's own timings come from has 8× the cores and about 8–10× the memory bandwidth.
- **Application Control:** on the development laptop, Windows Application Control blocks unsigned executables at the "Enterprise signing level" (it blocked `electron.exe` and earlier Tailwind's native binary).
  - Before any work, check whether the target machine has the same policy, and whether it would block Python, the CUDA and TensorRT DLLs, or a self-built TensorRT plugin DLL (§9).
  - Where the policy blocks something, ask the machine's administrator. Never work around it.

## 3. Guardrails (unchanged)

- **Visible badge:** the badge is drawn by the app on every output frame, after everything else. The sidecar never produces a finished frame, so it cannot produce an unbadged one.
- **Consent gate:** the sidecar only renders persona images the app hands it after the app's consent gate. It also checks that their SHA-256 hashes appear in the consent record the app sends (§6).
- **Nothing for evasion:** no features to hide the badge, evade detection or pass identity or liveness verification. The sidecar has no virtual-camera output and no frame output.
- **On-device by default:** the sidecar is local (`127.0.0.1`) and **opt-in**, labelled in the UI as "Neural renderer (this computer's GPU)". There is no remote mode.
- **No disk writes, no outbound network:** see §10.

## 4. Architecture

```
 Browser or Electron app (unchanged R1–R6 pipeline)              Sidecar (Python, local)
 ───────────────────────────────────────────────────            ─────────────────────────────
 camera → MediaPipe landmarks (app)                               ws://127.0.0.1:<port>  (loopback only)
       → aligned driver face crop 256×256 + landmarks ──────────►  motion extractor (driver)
                                                                   relative motion → persona keypoints
                                                                   + stitching
                                                                   warping module → SPADE generator
       ◄────────────── animated persona head crop 512×512 + alpha  (appearance features of the persona
                                                                    cached in GPU memory per session)
       → place crop (inverse alignment) in the WebGL pipeline
       → R3 relight (illumination only, see §8) → R4 masks (hair, hands)
       → feather into the camera frame → watermark/badge (last)
```

- **Crop and landmarks come from the app.** The crop alignment uses the app's MediaPipe landmarks, so the sidecar needs **no InsightFace detector**, whose models are non-commercial (§12).
- **The sidecar returns only the animated persona head crop and its alpha.** All compositing, relighting, masks, the forehead extension and the watermark stay in the app, as the plan requires.

## 5. Session and authentication

- **Network binding:**
  - The sidecar binds to `127.0.0.1` only, never `0.0.0.0` or `::`.
  - It picks a free port, or uses a fixed default (`47815`) if free.
  - One client at a time; a second connection is refused.
- **Session token:**
  - At start the sidecar draws a 256-bit random token from the OS CSPRNG. It is held in memory only.
  - **Electron:** the main process spawns the sidecar, if allowed, and passes the token on the child's stdin. The preload hands the token to the renderer, and nothing is written to disk.
  - **Browser:** the user starts the sidecar from a terminal. It prints a short pairing code (eight characters, valid for 2 minutes, single use), which the user types into the app. The app exchanges it for the session token over the socket.
- **WebSocket upgrade checks:**
  - **Origin allow-list:** `app://personalive`, `http://localhost:<dev/preview port>`, and the published GitHub Pages origin. Anything else is closed.
  - **Host header:** must be `127.0.0.1:<port>` or `localhost:<port>`, against DNS rebinding.
  - **Token:** must arrive in the first message, not in the URL, so it never reaches logs. A wrong token closes the socket, and repeated failures back off.
- **Lifetime:**
  - The session ends on disconnect, after 60 s idle, or when the app sends `bye`.
  - Persona features and frames are then freed (§10), and the token becomes invalid.
- **Pages build:** browsers may ask the user for permission before a public website (the Pages build) can reach `127.0.0.1`. The local and Electron builds are on loopback or `app://` and are not affected. Test this in R7.3.

## 6. Protocol (binary WebSocket, little-endian)

| Message | Direction | Content |
|---|---|---|
| `hello` | app → sidecar | protocol version, app build id, token |
| `ready` | sidecar → app | model id and version, precision, GPU name, free VRAM, measured ms per frame, supported output sizes |
| `setPersona` | app → sidecar | persona id; consent record (signer, scope, image SHA-256 list); 1–7 reference images (PNG or JPEG bytes) with their landmarks and pose |
| `personaReady` | sidecar → app | persona id, ms to extract features, per-reference pose |
| `calibrate` | app → sidecar | one neutral frontal driver crop (the wearer's rest pose for relative motion) |
| `frame` | app → sidecar | seq, capture timestamp, 256×256 driver crop (RGB8, or JPEG q90), landmarks in crop coordinates, head pose matrix, flags |
| `result` | sidecar → app | seq, capture timestamp, 512×512 persona crop RGBA8 (alpha = head region), reference used, inference ms |
| `error` | sidecar → app | code (`no-gpu`, `oom`, `consent`, `busy`, `version`), message |
| `bye` | either | — |

- **Consent check on `setPersona`:** the sidecar hashes each image and refuses (`consent`) unless every hash is in the record's list, and the record's scope includes live calls. The real gate stays in the app; this is a consistency check, so the sidecar never animates an image that the app's consent record does not cover.
- **Backpressure:** at most one `frame` in flight plus one queued; a newer frame replaces the queued one, and the app never waits on the sidecar. Results arriving later than 250 ms after capture are dropped.
- **Size limits:** frames over 1 MB and personas over 8 images or 20 MB are refused.

## 7. Rendering in the sidecar

- **Model:** LivePortrait. Its modules are:
  - an appearance feature extractor, run once per reference image;
  - a motion extractor, run on every driver frame;
  - a warping module;
  - a SPADE generator, at 512×512;
  - stitching and retargeting MLPs.
- **Relative motion keeps the persona's shape.** The driver's keypoint and expression change from the `calibrate` frame is applied to the persona's own source keypoints. The output therefore has the persona's face shape, beard and hairline, not the wearer's.
- **Multi-reference source:** appearance features of all enrollment shots stay cached on the GPU (about 4 MB each in FP16). Each frame uses the shot nearest the driver's pose as the source, which reduces large warps on turns. Switching sources uses the same 150 ms cross-fade idea as R5.
- **Landmarks:**
  - The app's MediaPipe landmarks drive cropping and the eye and lip retargeting ratios.
  - LivePortrait's own `landmark.onnx` and the InsightFace models are not used (§12).
- **Alpha:** the returned alpha is the animated head region, LivePortrait's paste-back mask warped with the output. The app feathers it and applies R4 masks on top, so hands and the wearer's hair stay in front.

## 8. Compositing in the app

- **Placement:** the returned crop is a new texture source in the WebGL pipeline, drawn at the inverse of the alignment transform. Its region extends past the face oval over the jaw, chin and the top of the neck, which is what lets a persona's beard and jaw appear.
- **Relighting prerequisite:**
  - R3 relighting must be the **illumination-only** version from the visual audit (item a).
  - Today's relight would copy the wearer's albedo onto the neural crop exactly as it does onto the 2D warp, and undo the identity gain.
  - This 2D fix is a prerequisite for R7 and is useful on its own.
- **Kept from R4 and R6:** the R4 masks (hair, hands, glasses), the feather and the skin-tone blend (audit item b: tint the wearer's neck and ears toward the persona) apply unchanged. The watermark is drawn last.
- **Temporal hybrid, expected to be needed on the RTX 500 Ada:**
  - Neural frames arrive at whatever rate the GPU sustains (§11). For the camera frames in between, the app warps the **latest neural crop** with the R1–R6 mesh warp, from the landmarks of the frame it was made for to the current landmarks.
  - Consecutive neural crops cross-fade over 2 frames.
  - Motion therefore stays in step with the camera at 30 fps, while appearance updates at the neural rate.
- **UI:**
  - A status chip shows: "Neural renderer: on (N fps)", "Neural renderer: off (reason)", or "Neural renderer: fallback (reason)".
  - The setting is off by default and clearly labelled as local.

## 9. Automatic fallback

The app falls back to the R1–R6 pipeline within one frame. Triggers:
- no sidecar, or the handshake fails;
- `error`, a socket close, or `oom`;
- the median round trip goes over 150 ms for 1 s;
- the neural rate stays under 6 fps for 2 s;
- a persona without a consent record covering its images.

Recovery has hysteresis: neural output resumes after 3 s of healthy results. Falling back never changes the badge or the consent state.

## 10. Security and privacy in the sidecar

- **No disk writes:**
  - Models load read-only from a folder the user chose at setup, outside the repository.
  - No frames, persona images, features or tokens are written.
  - Logs carry only timings and error codes, to stderr, with no image data and no persona names.
- **No outbound network:**
  - The sidecar never opens an outbound socket.
  - Model download is a separate, explicit `setup` command run once by the user. It records each file's SHA-256 and licence in `MODEL_LICENSES.md` (§12).
  - The render server refuses to start if model hashes don't match that file.
- **Memory hygiene:** persona images and features are dropped on `bye`, disconnect or idle timeout, and GPU buffers are released, with best effort to overwrite host buffers.
- **Hardening:** strict message parsing with size limits, a pinned protocol version, no code or model paths accepted from the client, and no eval of any kind.

## 11. Performance: estimate and benchmark gate

Public numbers:
- **Official LivePortrait timings, RTX 4090** (PyTorch with `torch.compile`, per frame): appearance extractor 0.8 ms, motion extractor 0.8 ms, warping module 5.2 ms, SPADE generator 7.6 ms, stitching 0.3 ms. That is about 15 ms in total, for about 130 M parameters (about 500 MB in FP32).
- **TensorRT ports:** FasterLivePortrait reports 30+ fps on an RTX 3090. A community benchmark reports 27–37 ms per frame on an RTX 4070 Ti, against 118–124 ms with ONNX Runtime on GPU.

Estimate for the RTX 500 Ada:
- **Scaling:** about 1/4 of a 4070 Ti's cores and about 1/4–1/5 of its memory bandwidth. The warping module's 3D grid sample is bandwidth-bound.
- **Expected rate:** about 100–150 ms per frame at 512×512 with TensorRT FP16, that is **7–10 fps**. Real-time 30 fps is not expected; this is why the temporal hybrid in §8 is part of the design.
- **VRAM:** about 1.5–2.5 GB (FP16 weights about 250 MB, TensorRT workspace and activations). This should fit in 4 GB, because the app's WebGL normally runs on the Intel iGPU of a hybrid laptop.
- **Uncertainty:** these are estimates from other GPUs, not measurements.

**Gate R7.0 (before any app work, on the RTX 500 Ada machine):**
1. Install the NVIDIA driver, CUDA, and ONNX Runtime with the CUDA execution provider. Check that each loads under the machine's Application Control policy.
2. Run LivePortrait's speed script with ONNX Runtime CUDA FP16, then the FasterLivePortrait TensorRT path. Note: it needs TensorRT 8.x (10.x is stated as incompatible) and a self-built `grid_sample` plugin, so check the signing policy for that DLL.
3. Record:
   - ms per module (median and p95);
   - peak VRAM;
   - fps over 10 minutes on mains, with GPU temperature and clocks;
   - output at 512 and at 256.
4. **Go** if, for at least one size, all of these hold:
   - ≥ 8 fps sustained at 512 or ≥ 15 fps at 256;
   - peak VRAM ≤ 3 GB;
   - no thermal throttling below those rates.
   Otherwise stop, report, and decide: 256 output, INT8, a smaller animation model, or no R7 on this GPU.

## 12. Models and licences (`MODEL_LICENSES.md`, created in R7.1)

| Component | Licence | Use |
|---|---|---|
| LivePortrait code (KwaiVGI) | MIT | reference implementation |
| LivePortrait weights (Hugging Face `KlingTeam/LivePortrait`: appearance, motion, warping, SPADE, stitching) | MIT per the model card metadata; to be re-checked at download | used |
| InsightFace `buffalo_l` (`det_10g.onnx`, `2d106det.onnx`), shipped with LivePortrait | non-commercial research only (LivePortrait's LICENSE says to replace them for commercial use) | **not used**: the app's MediaPipe landmarks replace them |
| LivePortrait `landmark.onnx` | not stated | **not used** until its licence is confirmed |
| FasterLivePortrait (warmshao) | MIT code; its downloaded models carry their own licences | reference for ONNX and TensorRT export only |
| NVIDIA driver, CUDA, TensorRT | NVIDIA licence agreements | runtime, installed by the user, not redistributed |
| ONNX Runtime | MIT | runtime |
| MediaPipe (in the app) | Apache-2.0 | already used |

Weights are never committed. The setup command downloads them into a user-chosen folder and writes their hashes and licences into `MODEL_LICENSES.md`, which records licences and hashes only, no weights.

## 13. Review and metrics for R7

- **Review flag:** a new flag `neuralRenderer` (off) and a setting. The review tool gets `--flags neuralRenderer=1` and a `--sidecar <url>`, and records the sidecar's model, precision and timings in `report.json`.
- **Persona photo in every review:** sheets always carry the persona photo next to the outputs. This is the lesson of the R6 audit, where sheets compared configurations with each other but never with the persona.
- **Identity guard:** reported as a delta, as before, and also with its absolute output↔wearer and output↔persona values. It stays a trend guide, never a target, and is never tuned against verification thresholds.
- **Comparison set:** the same pairs as the audit, in both directions (clips A, B, C, E and `G.mp4`), plus the 28-persona grid on clips A and B.

## 14. Work plan (each step on its own branch, stop for "go" after each)

| Step | What | Done when |
|---|---|---|
| R7.0 | Benchmark gate on the RTX 500 Ada machine (§11) | numbers reported; go or no-go |
| R7.1 | Sidecar MVP with ONNX Runtime CUDA, offline: renders the audit pairs from clips through the review tool, no app integration | sheets of both pairs next to the 2D output and the persona photo; first verdict "reads as A?" |
| R7.2 | TensorRT FP16 engine, real-time loop, protocol and authentication (§5–6) | sustained rate and latency on the target GPU |
| R7.3 | App integration: flag, setting, status chip, compositing (§8), fallback (§9); Electron spawning where allowed | live on the target machine; fallback tested by killing the sidecar |
| R7.4 | Temporal hybrid (neural frames plus mesh warp in between) | 30 fps output motion with neural appearance; no pops |
| R7.5 | Measured report in the phase format | before → after per clip, identity, grid, sheets, ranked "what still looks fake" |

**Prerequisite, independent of R7:** audit item a (illumination-only relight) and item b (tinting the neck and ears toward the persona). Both are needed for the neural crop too, and both help the 2D path on their own.

## 15. Risks

- **Hardware:** the development laptop has no NVIDIA GPU, and the target GPU is about 8–10× slower than the GPUs behind the public numbers.
- **Application Control:** the target machine may block Python packages' DLLs, TensorRT, or a self-built plugin. Handled by asking the administrator, never by working around it.
- **TensorRT pinning:** the FasterLivePortrait path needs TensorRT 8.x and a custom plugin. Engines are bound to the GPU, driver and TensorRT version, and must be rebuilt on that machine.
- **Quality unknowns:**
  - LivePortrait has a known weakness on large turns and occluding hands.
  - With a 4 GB, 35–60 W laptop GPU, 256 output may be the practical size, which is softer at 720p.
  - How a full beard animates under talking motion is untested for these pairs.
- **Latency:** the end-to-end delay includes a JPEG round trip and inference. The hybrid hides it for motion, but appearance lags by one neural frame.
