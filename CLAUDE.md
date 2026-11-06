# PersonaLive — working rules

## Requirement and intended use
- **Goal:** Person A provides photos from several angles and/or videos, with recorded consent. Person B sits at the camera. Someone watching should recognise A, and the video should look natural on camera. Recognisable as A comes first, natural-looking second; neither may be dropped.
- **Intended use:** live video calls where all participants know they are seeing a persona.
- **Unchanged guardrails:**
  - the visible badge on every frame;
  - the consent gate;
  - no features to hide the badge, evade detection or pass identity/liveness verification;
  - on-device by default (any remote mode is opt-in and clearly labelled).

## Identity metric rule
The identity guard (`tools/realism/identity.py`, OpenCV Zoo YuNet + SFace) is reported in every phase as a delta against the previous phase. It is a trend guide, never a target, and is never tuned against face-verification thresholds. Judge by eye on the contact sheets first: "does this read as A?"

## Realism pass
- Plan and phase reports: `docs/REALISM_PLAN.md`. One phase per branch `realism/rN-<slug>`; stop at the end of each phase and wait for "go".
- Every visual change sits behind a realism flag (`src/realism/flags.ts`); defaults change only after a measured comparison on the persona test set (median and worst 10%).
- Reports lead with before → after per clip, then the identity delta, grid median and worst 10%, contact sheets, what still looks fake (ranked) and deviations.
- Never commit photos, videos, screenshots, model weights or `references/`; only `report.json`, `stills.json` and small text tables under `realism-review/out/` are tracked.
- Never push, tag or rewrite history unless asked. Never delete, skip or weaken tests; add unit tests for new pure logic.
- Verification before a report: `npm ci` (falls back to `npm install` on the lightningcss EPERM), `npm test`, `npm run lint`, `npm run build`, then the realism review.
