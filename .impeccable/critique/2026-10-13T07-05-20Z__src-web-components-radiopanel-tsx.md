---
timestamp: 2026-10-13T07-05-20Z
slug: src-web-components-radiopanel-tsx
---
# Radio Explorer — focused craftsmanship, 2026-10-13

Independent Impeccable assessments: A/Halley (visual, code, live browser) and
B/James (detector/browser evidence), baseline b281b058, without shared conversation
or cross-assessment findings. Read DESIGN.md and polish/critique/craft-floor.
No prior matching stored critique existed. Four selected fixes:

1. Responsive focus restoration: resizing from desktop to phone hid the original
Radio launcher and Escape left BODY focused. Opt-in fallback now restores visible
Radio or dock More; ordinary restoration and other modal callers keep their behavior.
2. Map header overflow:622px content in606px on smaller desktop;591px in254px on
320px. Only region choices now scroll; title/coverage remain readable, with regions
on their own narrow-layout row.
3. Hover and selected tabs computed identical backgrounds. Selected surface stays;
hover uses foreground feedback without suggesting a second selected collection.
4. Desktop coordinate counts repeated. Map owns coverage on desktop, while results
retain it on narrow layouts where the map is hidden.

Map framing is unchanged: aspect-preserving world fit explains vertical space.
Zooming to fill it would crop geography. Player alignment, typography, rows,
source disclosure and audio lifecycle did not justify churn or a fifth change.
A heuristic scores (0–4): status3, real-world4, freedom3, consistency3, prevention3,
recognition3, efficiency3, minimalism3, recovery3, help3. Detector ran once: eight
legacy font-ramp advisories, not demonstrated readability defects. B measured
representative text contrast: Rider Black5.78–8.28:1; White Contrast9.43–15.13:1.
This is measured evidence, not blanket WCAG certification.

Final main-thread verification: TypeScript/build passed;152 tests in nine suites
passed (radio geometry/source semantics, control contrast/edges, overflow, popover
placement, modal dismiss/focus trap). Browser checks passed for region reachability,
cluster hover/focus, zoom/Home and full-world viewBox; header/count bounds;
selected versus hover; no opening search autofocus; Filters/Escape/focus;
search/combined filters/clear; shared favorites/recent persistence; source disclosure,
empty/error states, buffering/pause/resume/workspace Retry. A real silent-WAV media
instance advanced without another play call through search/filter/tab/empty states
and source collapse. Directory fixtures and failed probes were synthetic.

Layout checked at1440x1000,1100x800,390x844,320x568,1100x540 atDPR2, including
300 entries with127 coordinates and multilingual long names. Before captures:
/tmp/radio-craft-before-{desktop,smaller,mobile,narrow,short}.png. After captures:
/tmp/radio-craft-map-{width}-{height}.png and
/tmp/radio-craft-catalogue-catalogue-{width}-{height}.png, plus tab-hover/filter
captures. Main thread opened representative desktop, smaller,390 and320 captures,
compared composition, and recaptured settled map reset after asserting world
viewBox width>=360,height>=170. Responsive focus passed at390 and320 for
desktop→More, More→More and More→desktop; search never autofocused.

Limits: external station availability and VoiceOver/NVDA not manually verified.
B checked200% zoom using equivalent720x500 reflow; actual browser zoom was not
exercised. Existing build chunk-size warning remains. Final resolution checks were
in-thread, not an independent whole-surface ship verdict. Questions skipped:
owner authorized autonomous work and preserved direction; no missing input.
