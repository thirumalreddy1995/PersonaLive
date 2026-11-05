# Realism review tooling

Headless before/after review for the persona pipeline. See `docs/REALISM_PLAN.md` for the plan,
the metric definitions and the phase protocol this serves.

## Record clips

Put driver clips in `realism-review/clips/` (gitignored), named after the plan's labels:

| Clip | Content | File |
|---|---|---|
| A | frontal talking, 20 s | `realism-review/clips/A.webm` |
| B | slow head turns to ±40° yaw and ±20° pitch | `realism-review/clips/B.webm` |
| C | hand touching the chin, hair pushed onto the forehead | `realism-review/clips/C.webm` |
| D | desk lamp switched on and off | `realism-review/clips/D.webm` |
| E | hair pushed back, frontal 3 s, then slow nods and tilts | `realism-review/clips/E.webm` |

Any of `.webm`, `.mp4`, `.mov`, `.mkv` works. WebM/VP9 plays in every Chromium; H.264 `.mp4`
needs the Chrome channel (the default), because Playwright's bundled Chromium has no H.264 decoder.
Record at the resolution and frame rate of the webcam you use (720p/30 is typical), in the same
room light, and keep the face roughly where it sits during a call.

## Capture a run

```bash
npm run build                                   # the capture replays through the production build
npm run realism:capture -- --clip A             # defaults → realism-review/out/<date>-defaults/
npm run realism:capture -- --clip A --flags oralCavity=0,catchlights=0 --run r1-candidate
npm run realism:capture -- --clip E --run baseline --times 1,2,3,4,6,8,10 --burst 5:24
```

Each run folder gets, per clip, the captured frames (`t<sec>-output.png`, `-driver.png`,
`-overlay.png`), a `contact.png` with 2x face crops (driver, output, persona layer over a
checkerboard), and one `report.json` for the whole run with the metrics of every clip. Only
`report.json` is tracked by git; frames and sheets stay local.

Options: `--persona <name>` clicks a persona card first; `--url http://host:port/` reuses a running
app instead of starting `vite preview`; `--browser chromium|msedge`; `--software` forces SwiftShader
(numbers are then not representative of GPU performance); `--headed` shows the window.

## How it works

1. The app is opened with `?realism=1` (and `&rf=<flags>` for overrides). That turns on the dev-only
   surface: the "Video File" source, the Realism debug panel and `window.__personaLiveRealism`.
2. The clip is loaded through the Video File input, so it runs through exactly the live pipeline
   (mirrored like a webcam), with the temporal filters seeing a continuous stream.
3. The engine copies the output, the driver frame and the persona layer when the clip passes each
   capture time, and records a short burst of consecutive half-size frames for flicker and
   texture-slide. It then re-detects landmarks on each output frame.
4. `tools/realism/metrics.ts` computes the numbers from the pixels and landmarks (pure functions,
   unit-tested in `metrics.test.ts`).

## Live comparison

`npm run dev` (or any build with `?realism=1`) shows the Realism debug panel: toggle each pipeline
stage, watch the frame profile and preview the persona layer or the raw warp. The flag string shown
in the panel can be passed straight to `--flags`.
