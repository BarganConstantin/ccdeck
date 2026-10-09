# Telemetry Radar

Mode: Operate. Scope: `src/web/components/TrafficRadar.tsx`, `TelemetryCapture.tsx`, `TelemetryFile.tsx` and their styles.

Direction: a compact network inspector within ccdeck’s established theme system. Replace the explanatory stack with a monitoring toolbar and destination strip. Distinguish local listener readiness, observed traffic, decoded exports and collector receipt. Socket observations are never called decoded messages.

FIRST VIEWPORT: identity and subdued Beta at the top; one-line purpose and disclosed help; Monitor / Configuration / File navigation; listener status beside Start/Stop; active collector address; a narrow activity feed and wider contextual inspector. The feed reports decoded-message and connection-observation counts explicitly. Unreadable observations show time, destination, source and capture limitation at the top of the inspector rather than in a centered blank field.

Signature interaction: selection stays fixed while new activity arrives. Pause list freezes visible entries while capture continues and reports arrivals; Resume reveals new entries without stopping monitoring. Keyboard arrows move within the feed. Filters reset the inspection deliberately. Long histories are rendered in bounded batches.

Motion grammar: 120–140ms control feedback, restrained press feedback, no ambient pulse or blinking, reduced-motion support. Existing colors and fonts remain; semantic successes use `--ok`, real errors `--err`, actionable partial readiness `--warn`; unreadable contents use neutral text.

Review passes: (1) UX/state architecture, (2) actual light/dark desktop/mobile visual review, (3) interaction, keyboard, retention and performance verification. Browser fixtures are isolated from production traffic. Preserve the collector capture protocol and backend.

## Implemented ground truth — 2026-10-09

Code-led redesign within the incumbent visual world. About Radar is disclosed;
the settings summary now lives in Configuration. The combined activity timeline
orders decoded exports and observations newest first, with separate counts.
Initial and explicit selection are pinned; session/type/destination filters reset
selection. Mobile selection focuses and scrolls to the inspector. File retains
original local JSON/JSONL; it does not use the decoded-message tree or prove delivery.

Both scored finish-review fixes are implemented: partial readiness is amber with
an explicit listening count and per-address Listening / Not listening labels;
decoded Event / Metric / Trace labels are neutral metadata. Full readiness may
use `--ok` without implying any export was decoded or accepted.

`JsonInspector.tsx` renders closed branches lazily through native details, expands
children in batches of 50, and limits raw syntax highlighting to 200,000 characters
without truncating raw JSON. `radar-monitor-state.ts` derives capture state as a
pure helper. Scoped CSS owns `--tr-inset` (16px; 14px at ≤640px),
`--tr-control-h` (32px minimum; 40px mobile) and `--tr-radius` (6px).
Backend and capture protocol are unchanged.

## Finish-review handoff

Disposition: **ship**, after the two scored fixes above. Supplied verification:
216 tests across 11 files passed; TypeScript and final build passed. Brave covered
White Contrast and Rider Black at 1280, 1235, 900, 390 and 320px: Start/Stop,
pause with arrivals, stable initial/explicit selection, filters and sessions,
local JSONL, JSON tree/raw/copy, keyboard tabs/rows, 2,000-event history bounded
to 100 then 200 visible entries, missing/custom destinations, permission/error
states and failed-read retry. These checks were completed before this documentation
pass; they were not rerun here.

Screenshot evidence in `/private/tmp/ccdeck-rail-qa/`: `radar-redesign-live.png`,
`radar-redesign-white-contrast-observed.png`,
`radar-redesign-white-contrast-decoded.png`,
`radar-redesign-rider-black-partial.png` and
`radar-redesign-white-contrast-320.png`. Decoded and partial-state screens use
isolated fixtures. The real local capture snapshot listens on one address,
`192.168.88.16:4317`, with **0 decoded messages and 2 observations**. Genuine
Claude JSON capture remains unverified; do not present fixtures as that proof.
