# Radio Explorer — production readiness, 2026-10-13

**Recommendation: SHIP WITH KNOWN LIMITATIONS.** No confirmed P0, P1 or P2 remains
in the audited feature. This is a bounded release-readiness assessment, not a
certification of every broadcaster, platform or assistive technology.

Audited baseline: `5911141a`, branch `feat/radio-built-in-stations`. Used installed
Impeccable audit/harden/craft-floor procedures, AGENTS.md, DESIGN.md, existing
feature documentation and previous Radio reviews. The user's explicit instruction
to fix verified defects takes precedence over audit's report-only default.
Preserved the visual design, player layout, modal and map geometry. Independent
player review by Aquinas confirmed the fixes and independently reran all 16
lifecycle regressions; no additional player regression was established.

## Findings and resolution

| Priority | Verified defect | Resolution and regression evidence |
| --- | --- | --- |
| P2 | A YouTube request and buffering state claimed playback; silent embeds could remain active indefinitely. | Only state 1 confirms playback; state 3 is buffering. Startup/stall has a 15s deadline, not extended by repeated buffering or volume changes. Lifecycle tests cover expiry, recovery, cancellation, switch and unmount. Browser checks cover real React scheduling and iframe messages. |
| P2 | Blocked YouTube autoplay was ignored; the next press could pause the unstarted session. | Blocked playback returns to idle with the probe retained. Next press arms playback. Unit and browser regressions passed. |
| P2 | YouTube error 153 was parsed but never handled. | Release the session, reset flags, mark unavailable and allow retry. Unit and browser regressions passed. |
| P3 | Failed custom YouTube probes retained contradictory armed/playing flags. | Clear all playback flags for HTTP failure, empty response and rejected fetch. Three lifecycle tests passed. |
| P2 | Choosing a station from a cluster removed the focused button and lost keyboard focus. | Return focus to the map before dismissing the chooser. Browser regression passed; inspection alone still does not interrupt audio. |
| P2 | Filters' Done button was partly clipped at 320px and actual 200% browser zoom. | Scroll the overview within the bounded popover, keeping its footer visible. Browser assertions verify the complete button lies inside the popover at all six viewports and four zoom levels. |
| P1 | No-match country filtering left an invalid listbox containing only a status message. Axe reported aria-required-children. | Render the status separately from option-list semantics and collapse the combobox's option relationship when empty. Two semantic regressions and rendered axe checks passed. |

YouTube's documented buffering, autoplay-blocked and error-153 behavior was checked
against the [official IFrame API reference](https://developers.google.com/youtube/iframe_api_reference#Events).
The direct postMessage integration remains the incumbent implementation; no new
iframe API dependency was introduced.

## Verification executed

- Node 22.14.0: **431 tests passed in 22 suites**, including directory/server
  integration, normalization, persistence, metadata refresh, failover, geometry,
  mixed-source filtering, shared favorites, FM lifecycle and modal/popover rules.
  New behavioral lifecycle tests exercise the actual bundled hook with controlled
  React/media stubs; they are not a substitute for browser tests.
- TypeScript and production build passed. `themes:check` passed for all nine JSON
  themes. `git diff --check` and preserved QA script syntax checks passed. There
  is no dedicated lint/formatter command in package.json.
- **25/25 main browser checks passed**, using the built production UI in isolated
  Chrome on macOS: list/map playback, pause/resume, previous/next, Surprise me,
  volume/mute/favorite, close/reopen continuity, rapid switching, stale callbacks,
  reload without autoplay, failed streams/recovery, map camera/regions/wheel/
  double-click/drag/keyboard/clusters, iframe states/errors, responsive controls,
  modal keyboard trap and no opening Search autofocus.
- The discovery workflow passed separately: both-source search, combined country/
  genre/language filters, clear/reset, keyboard selection, Escape/focus, shared
  Favorites/Recent persistence, Global without a directory request, source-aware
  counts, disclosure, empty/error states, Retry and light-theme presentation.
  A genuine silent WAV audio instance continued advancing without new play calls
  through searches, filters, tabs and source collapse.
- Actual extensionless HLS **AAC decoding passed via native HLS and hls.js/MSE**.
  A locally generated 30s fixture and routed manifest/segments were used; these
  are controlled delivery tests, not real HLS-broadcaster availability checks.
- Live directory returned 300 entries. **RMC FR, Classic Vinyl HD and Lofi Girl
  relax/study reached confirmed playback through the actual application** without
  media/YouTube routes. This samples three sources, not the entire directory.
  Hardware audibility and long uninterrupted listening were not measured.
- Viewports: **1440×900, 1280×800, 1024×768, 800×600, 390×844, 320×568**.
  Dialog bounds, horizontal containment, player/search/filter reachability,
  popover bounds and complete Done-button visibility passed. Narrow Map/Stations
  switching and map controls passed. Long CJK/Arabic station metadata was used.
- **Actual browser zoom 100%,125%,150%,200%** passed through chrome.tabs.setZoom in
  a disposable Chrome-for-Testing extension/profile. Checked effective CSS widths
  were1440,1152,960,720px. These are real browser zoom checks, not CSS zoom or
  viewport-only equivalents. Earlier DPR2 geometry checks remain supplementary.
- Synthetic two-pointer CDP pinch passed. Physical touch-device behavior was not
  exercised. Missing coordinates remain in results, not on invented locations.
- Twenty open/close plus region-interaction cycles passed the bounded DOM/listener
  growth checks after garbage collection: nodes3490→2283, listeners782→659.
  Stale media callbacks and watchdog/listener cleanup are separately covered.
  This is not a long-duration heap-leak proof. Whole-app long tasks up to455ms
  occurred under concurrent QA load; no feature-specific bottleneck was isolated,
  so no speculative performance rewrite was made. Local result filtering was
  observed at55ms; this does not measure completion of the debounced API request.

## Accessibility and Impeccable audit

Axe4.10.3 WCAG A/AA checks reported **zero violations** for the dialog/filter
interface at all six sizes after corrections, and for empty directory, country
options/no options, Favorites/Recent empty states and light workspace content.
Keyboard checks covered modal containment/restoration, responsive launcher
fallback, search clear, tabs, option navigation, popover Escape and map/cluster
focus. Reduced-motion contexts were exercised; focus styles were preserved.
Contrast/edge suites passed, with dark and light rendered checks.

Axe's incomplete items were reviewed explicitly: the Filters trigger's controlled
popup ID exists in the live DOM (all ARIA references checked); partially obscured
country options are outside the option scroller's visible region. These are not
reported as automated failures or as screen-reader certification.

| Impeccable dimension | Score /4 | Evidence / limit |
| --- | --- | --- |
| Accessibility | 3 | Keyboard and axe/contrast checks passed; native screen readers untested. |
| Performance | 3 | Bounded results, lazy HLS, cleanup and lifecycle checks; existing bundle warning and whole-app long tasks. |
| Responsive | 3 | Six sizes and four actual zoom levels passed; physical device coverage remains limited. |
| Theming | 4 | Existing tokens preserved, nine-theme consistency and contrast tests, rendered light/dark. |
| Implementation integrity | 4 | Coherent incumbent system, truthful state/counts and source boundaries; no new dependency or visual-world replacement. |
| Total | **17/20 — Good** | Scope-specific assessment, not blanket WCAG certification. |

The detector returned eight advisory font-ramp mismatches already present in
radio.css (exit2). They were reviewed against the incumbent density/type system;
no new typography values were introduced and no demonstrated readability defect
justified mechanical font changes. They remain recorded rather than suppressed.

## Remaining issues and limitations

- **P0/P1/P2: none confirmed and unresolved in this audit.**
- **P3:** pre-existing production warning for large JavaScript chunks. Radio and
  hls.js remain lazy loaded; no unrelated bundle refactor undertaken.
- Not verified: VoiceOver/NVDA, Firefox/WebKit/Safari, current Windows/Electron
  execution, physical touch/gesture devices, audible hardware output, sustained
  overnight listening or long-duration heap behavior.
- Buffering and media interruption recovery used controlled waiting/stalled/player
  events and deadlines. Directory network abort/recovery was real browser request
  routing. Sustained real broadcaster network loss was not independently tested.
- Broadcaster availability, CORS, supported codecs and YouTube policy remain
  external dependencies. A successful sample cannot guarantee every station.

## Evidence and replay

[Tracked evidence](../../.impeccable/qa/radio-production-2026-10-13/README.md)
contains final logs, baseline defect evidence, axe output, responsive captures and
replay scripts. Original larger captures/fixtures remain in
`/tmp/ccdeck-radio-production-qa/`. This audit authorizes a local readiness
recommendation; it does not publish, merge or deploy the branch.
