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

## Final refinement — 2026-10-09

Independent critique identified oversized rows, repeated limitations, stale copy
feedback, misleading Clear messages naming and inconsistent controls. A browser
pass additionally reproduced hidden overflow regions escaping the modal focus
trap. All are fixed; the baseline critique is persisted under
`.impeccable/critique/2026-10-09T12-57-44Z__src-web-components-trafficradar-tsx.md`.
Its 28/40 score describes the starting UI, not an invented final score.

RadarSelect preserves native option and keyboard behavior with authored chevrons.
Rows use `--tr-row-gap` (4px) and `--tr-selection` (theme-derived selected surface).
Inspector copy feedback resets on observation selection and expires after two
seconds. Clear history requires the existing armed-press convention, ignores
rapid double presses, and disarms on blur or after five seconds. New technical
disclosures retain the complete capture explanation without repeating it in every
row. No capture/protocol/backend changes were made.

The finish reviewer found one mobile keyboard defect: synthetic arrow clicks
moved focus to the inspector. Arrow/Home/End now select directly and preserve row
focus. Explicit activation still reveals the inspector. The final browser pass
verified consecutive navigation and Enter at 320px in both themes.

Verification: 139 tests across 11 files; TypeScript; build; git diff --check.
Brave covered Rider Black and White Contrast at 1280, 1235, 900, 390 and 320px,
including monitoring start/stop, pause/arrivals/resume, filters/session selection,
local JSONL, decoded overview/tree/raw/copy, 2,000-message bounded rendering,
partial listener state, modal Tab/Shift+Tab wraps, copy reset/expiry, clear history
confirmation, reduced motion and mobile keyboard activation. No package lint
script is available. No full screen-reader or packaged Electron test was run in
this refinement. Screenshots and logs live in `/private/tmp/ccdeck-rail-qa/`
(`radar-polish-*`) and `/private/tmp/ccdeck-radar-polish-*`.

Real capture remains one listening destination, two connection observations and
zero decoded messages. Decoded fixture tests are not evidence of real Claude
payload decoding. Server and capture history were preserved while rebuilding UI.

Independent finish review: **ship** after the scored mobile keyboard fix. The
reviewer’s verdict covers that fix; it is not a fresh whole-app certification.

## Stronger visual composition — 2026-10-09

The user rejected the prior polish as too sterile. This pass expands the
incumbent world rather than removing more useful information. Compact identity
and purpose share the header; About Radar joins the segmented navigation and
session selector. Destinations sit with listener state in a single toolbar.
The preferred window is 1060 × 740px, with a 34% feed and a wider inspector.
Themed surface roles separate activity from reading; authored event-type icons,
outlined selection, aligned facts and a composed neutral diagnostic establish
hierarchy. Capture logic, paused-list semantics, history and all existing views
are preserved. Phone About becomes an accessible icon control to avoid a spare
full-width navigation row.

Verification: 192 combined Radar/account tests across 11 files, TypeScript and
build passed at the pre-finish checkpoint. Brave passed the complete Radar
interaction matrix in Rider Black, Light and White Contrast at desktop, laptop,
390px and 320px. Captures: `/private/tmp/ccdeck-rail-qa/radar-premium-*`.
Real local state still reports two observations and zero decoded messages;
decoded evidence is from isolated fixtures. No packaged Electron or full
screen-reader run was performed. No repository lint script exists.

Independent finish-review disposition: **ship** for the stronger composition.
No material fixes remain. A separate layout assessment noted mobile density as
a non-blocking future refinement; all current controls and inspection paths remain
reachable, with 40px targets and no unintended horizontal overflow.

## Focused final review — 2026-10-09

Preserved the incumbent composition, palette and split panes. Pause list and Clear
history now use existing neutral button edges so they read as controls before
hover. Pause exposes its pressed state and changes its tooltip when resuming.
Monitoring limits gains the same neutral hover/open feedback as other disclosures.
No capture behavior, layout, protocol or data retention changes.

Verification: build, typecheck, 129 tests across nine relevant files and diff check
passed. Brave checked Light and Rider Black at desktop, laptop, 390px and 320px:
empty/stopped/error states, partial destinations, filters, selection, pause arrivals,
clear confirmation, 2,000-event batching, long addresses, nested JSON pagination,
raw JSON and exact copy. Keyboard focus and disclosure activation were checked;
reduced motion remains respected. Sampled metadata text contrast exceeded 4.5:1
in Light, Rider Black and White Contrast (minimum 5.33:1). This is a sampled check,
not a full accessibility certification. Captures: `/private/tmp/ccdeck-rail-qa/`.
Live capture still has two observations and no decoded messages; decoded tests
use isolated fixtures. No packaged Electron or screen-reader run. No lint script;
build retains the existing large-chunk warning.
