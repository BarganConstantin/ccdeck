# Tool Activity Report

## Direction contract — code-led, user-pinned report

THESIS: A device-local analytical report makes frequency, associated intervals and recorded failures comparable simultaneously; it replaces the centered, single-mode ranking.
OWN-WORLD: ccdeck theme surfaces, existing sans/mono pairing, blue usage, amber intervals, violet P95 and red reported outcomes. No new dependencies or global tokens.
STORY: Read unique call totals, compare five usage/time leaders, examine compact tail/failure evidence, then search/sort all operations and inspect sanitized calls.
FIRST VIEWPORT: Full application-integrated report, persistent Back/Refresh header, compact filters and summary, paired primary comparisons, subordinate P95/failures. Desktop content capped at 1360px; mobile stacks naturally.
FORM: Executive Analytics Report, user-pinned structure and supplied conceptual reference (not a pixel-approved final comp). Signature interaction: any chart/table selection opens the same contextual drawer without moving report scroll. One restrained inherited entrance; reduced-motion/keyboard entry immediate.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md

## Alternatives

| Concept | Comprehension / comparison | Density / responsiveness | Engineering |
| --- | --- | --- | --- |
| Executive analytics report | Four distinct questions visible together, names and exact values | Usage/time lead; smaller P95/failure modules, complete explorer below; one report scroll | Existing portal/focus lifecycle, CSS comparisons, no router/library |
| Observability workspace | One dominant metric with secondary summaries; still requires mode switching | Inspector reduces analytical space; crowded on short/narrow screens | Reuses old ranking but preserves its navigation cost |

Choose the executive report: the user's primary complaint is repeated metric switching and modal constraints. A viewport report is an overlay with a clear return to the unchanged canvas, not a new route. Contextual drawer is independently focus-protected; no empty inspector or surprising document scrolling.

## Data contract

The authoritative audit is [tool-explorer-design.md](tool-explorer-design.md). Summary counts distinct observed starts; operation counts are nonadditive containing-call memberships. Summary intervals count each measured call once but still overlap; operation intervals are shared, nonadditive associated sums. Neither is elapsed wall-clock time. Claude receipt and Codex rollout clocks are qualified, not benchmarked. P95 requires 20 measurements; unknown remains unknown and measured zero remains zero. Failure membership uses reported containing-call outcomes, with completed-outcome denominator. Search narrows charts/table, not provider/period summary. Requested, retained and observed endpoints stay distinct. No new collector, traces, arguments, outputs, trends or error-text disclosure.

## Quality bar

Within five seconds the report must show its purpose and frequency leader, with time comparison visible beside it at desktop width. Four hue families distinguish questions but titles/values carry meaning without color. Long names remain readable; selected evidence preserves exact identity. No default scatter, metric-navigation stack, giant KPI cards, empty side panel or invented insights. Every operation remains reachable through the searchable/sortable explorer. Refresh keeps the previous snapshot visible and clearly identifies refresh/error state.

## Verification

Two bounded rendered critique/fix passes; deterministic sparse/dense/failure/missing/partial/empty/unavailable fixtures, all metric mappings and interaction state, six requested viewports, zoom, theme contrast, keyboard/reduced-motion and real local API output. Final actual results and limitations follow after execution.


## Rendered refinement

The first review batch exposed overlong first-viewport composition and weak narrow-screen refresh feedback. The final batch aligns filters to the report reading edge, reduces primary comparisons to five leaders, tightens chart geometry while preserving long full identities, replaces the mobile filter label stack with accessible compact controls, and condenses the mixed-clock qualifier. Secondary charts show three eligible leaders. Refresh retains the previous snapshot and exposes status plus a rotating existing refresh glyph, disabled for reduced motion. The contextual drawer owns its focus/scroll; Escape closes evidence first. Mobile sorting has both metric and direction controls. Real resize QA revealed that the desktop entry may disappear into More; returning from the report now restores a visible entry after resizing.

## Actual validation

- Node22 TypeScript check and production build passed; inherited >500KB main/HLS chunk warning remains. No dependency added.
- 224 tests across eight suites passed: collector/aggregation/privacy, Codex watcher, new comparison eligibility/scale/null/zero/sort tests, modal trap/portal, shortcut surfaces and existing theme contrast suites.
- Isolated Brave browser fixture matrix passed at 1440×900,1280×800,1024×768,800×600,390×844,320×568. Four simultaneous metric mappings, precise scales, search/no matches, ascending/descending sorting, drawer keyboard trap/close/restore, provider/custom-period/reset, refresh burst coalescing and retained snapshot, sparse/210-type dense/missing/no-failures/empty/unavailable/partial/loading states, reduced motion and125% zoom were exercised.
- All nine themes: visible report text≥4.5:1 and nonzero marks in all four chart sections≥3:1 in the deterministic fixture. The live pass additionally checked all nine search-placeholder colors≥4.5:1.
- Read-only live Codex snapshot:1,400 observed calls,1,400 measured,105 operations,13 reported failures. Call memberships exceed unique calls as expected; observed collection is narrower than requested history. Real classification/detail, selected-refresh and320/390 drawer resizing and focus restoration passed. This is a snapshot, not a static expectation.
- Detector ran once:14 local typography advisories, no non-advisory findings. Local report type steps intentionally distinguish header, summary, compact metadata and exact measurements; the scoped design record will be updated after independent review.

Evidence: `.impeccable/review/tool-activity-report/final-*`. Complete report image is a stitch of actual body scroll captures (same fixed viewport, offsets retained in `final-live-slices.json`), not a different rendering. Individual desktop/mobile/details captures remain authoritative for layout.

Limitations: no native Windows/Linux execution, Safari/Firefox, live Claude stream, screen-reader certification or formal user comprehension study. The known provider timing-source limitation remains deliberately visible. Review verdict and durable scoped DESIGN/surface record follow the final independent handoff.

## Premium refinement — Direction A retained

The owner explicitly selected Direction A and requested refinement, not another replacement. Impeccable polish and Product UI Craft C preserve the full report, data semantics and navigation.

### Five bounded findings

1. The P95 bars communicate rank but conceal the already-available median; a normally fast operation with a slow tail looks the same as one consistently taking that interval.
2. Failure counts and denominators require mental division; meaningful existing failure rates and small-sample qualification are absent from the overview.
3. The max-width includes internal padding, leaving an effective desktop comparison area narrower than the requested1280–1360px target.
4. Deep operation-table scrolling loses sortable column labels.
5. Search-empty charts use period-empty language even while the complete explorer correctly says no matches.

### Visualization choice and evidence

- **Usage and cumulative associated intervals:** retain ordered zero-origin bars. They answer magnitude/ranking, including long names, without suggesting additive time shares.
- **P95:** evaluate unchanged bars against a median-to-P95 dumbbell. Select the latter because it exposes an actual second measurement, not stylistic variety: hollow median and solid P95 endpoints, exact median/P95 and measured count, one shared zero-origin linear scale. Endpoints are explicitly median/P95, never min/max or a full distribution. Missing median is not synthesized; equal/zero endpoints remain truthful.
- **Failures:** compare raw count bars,100%-rate bars and count lollipops with outcome/rate text. Select count lollipops: order and visual length both remain failed containing-call count, while the separate rate adds denominator context. Rate requires the existing20-completed-outcome floor; smaller samples show count/denominator and “small sample,” with no confidence claim.100%-rate bars were rejected because count order with rate length creates conflicting encodings.
- **Key Findings:** omit; repeating the four visible chart leaders does not add information.

Research applied: [Financial Times Visual Vocabulary](https://github.com/Financial-Times/chart-doctor/blob/main/visual-vocabulary/README.md) distinguishes ordered magnitude/ranking bars, lollipops and comparison dots. [Datawrapper chart-selection guide](https://www.datawrapper.de/blog/chart-types-guide) starts with the intended question; its [range-plot guidance](https://www.datawrapper.de/academy/customizing-your-range-plot) supports named endpoints, numeric labels and rounded shared axes. These guide our design choices; they do not validate telemetry.

Library evaluation: neither Recharts nor visx is installed. [Recharts](https://recharts.github.io/en-US/) provides composable React/SVG charts and D3-backed facilities; [visx](https://github.com/airbnb/visx) provides low-level visualization building blocks. For two existing CSS comparisons plus three two-endpoint SVG rows and three count lollipops, neither removes material complexity in filtering, drawer focus or exact semantic disclosure. Retain tested native buttons and simple responsive SVG, no new dependencies, no estimated bundle-size claim. No dedicated installed data-visualization skill is present; the installed UI/design skills and primary-source visualization guidance supply the relevant workflow.

Before captures: `.impeccable/review/tool-activity-report/final-*`. Premium after captures use `.impeccable/review/tool-activity-premium/`; final executed validation follows the new bounded review.


### Premium executed validation

- 226 tests across eight suites passed, including new linear interval-axis,
  missing-median/zero endpoint and chart eligibility/ordering regressions.
- TypeScript and production build passed. No dependencies changed. Relative to
  the immediately preceding full-report build, main JS increased from1,263.39KB
  (411.98KB gzip) to1,266.94KB (412.95KB gzip):3.55KB raw /0.97KB gzip.
  Existing large main/HLS chunk warning remains; this is not a library estimate.
- Brave fixture matrix passed at all six requested sizes, with all nine themes,
 125% zoom, keyboard traps/restoration, sorting/search/provider/custom period,
  refresh coalescing/retained snapshot, selected detail and dense210-type paging.
  All four chart mappings were checked; SVG endpoints and failure lollipops
  participate in the>=3:1 graphical check, with report text>=4.5:1.
- Separate live read-only Codex pass:1,466 observed starts,1,466 measured calls,
 105 operations,13 reported failures at API read time. Screenshots may precede
  that snapshot by an ongoing call. Sanitized detail, resize, selected-refresh,
  console and nine-theme placeholder checks passed.
- Sparse, missing measurements, no failures, zero intervals, empty, unavailable,
  partial coverage, no search matches and tiny failure sample scenarios were
  rendered. Tiny samples show count/denominator without comparing their rate.
- Refinement batch one replaced redundant P95/failure bars with actual endpoint
  and outcome context. Confirmation exposed a320px sample-label wrap; batch two
  moved measured sample size under operation identity and confirmed the same
  states. Parent polishing stops here; independent finish review follows.
- Detector ran once for this premium task:19 local typography advisories,
  no non-advisory findings. Report-local type hierarchy is intentional.

Before: `.impeccable/review/tool-activity-report/final-*`.
After: `.impeccable/review/tool-activity-premium/final-*`.
`final-live-complete-report.png` is stitched from actual body scroll slices plus
its original fixed header; individual viewport captures remain layout evidence.

Limits remain live Claude, native Windows/Linux, Safari/Firefox, screen-reader
certification and formal comprehension study. Automated contrast and keyboard
checks are scoped evidence, not full accessibility certification.

### Premium finish gate

Fresh independent review returned **disposition: ship** with all five contract
sections and no material implementation fixes. It opened all21 named premium
captures individually, both before captures and the conceptual owner reference;
the scoped DESIGN/surface record was then updated from the built implementation.
This is implementation sign-off at the stated evidence scope, not permission
to merge or deploy. PR #2125 remains draft for owner preview review.
Review: `.impeccable/review/tool-activity-premium/finish-review.md`.


## Final quality refinement — architecture preserved

Product UI Craft final gate / Impeccable polish retains Direction A. The optional
`ccdeck-data-viz` skill was not found in the installed skill roots or worktree;
existing UI skills, verified contract and prior primary-source chart research
remain the authority. No new collectors, aggregation, dependencies or charts.

Bounded findings and changes:
- Narrow rows hid median/P95 even while that metric determined the sort. The
  active timing column now remains visible, with a compact two-by-two numeric
  grid only for those phone sorts; default density is unchanged.
- Compact display intentionally rounds intervals. Native tooltip and accessible
  operation name now supplement it with precise recorded milliseconds, sample
  counts, percentile definition and the distinction from min/max endpoints.
  Null remains unavailable and zero remains measured; no inferred values.
- Failure comparison now explicitly names completed outcomes and provides its
  exact failed numerator/denominator in tooltip and accessible name. Count
  ranking remains distinct from the separately qualified rate; tiny rates are
  not promoted. Keyboard-focused table rows also receive the existing hover
  surface, while their focus-visible outline remains.
- P95 shared linear scale, hollow median/solid P95 shapes and exact visible
  measurements work for close, equal/zero and separated values. No added axes
  or chart controls were justified. Key Findings would repeat visible leaders
  and remains omitted.
- Requested period (control and disclosure), observed start endpoints (coverage)
  and snapshot timestamp (header/disclosure) retain separate labels. Membership,
  overlap, source-clock and containing-call outcome qualifications remain.

Rendered pass one exposed an orphaned failure cell when the phone timing column
was revealed. The second batch groups four values into two columns and confirms
identical states. A sticky-header check initially used a short table which could
not scroll far enough to activate sticking; the corrected test uses100 visible
rows from210 operation types and verifies actual header position at deep scroll.
This test correction is not a discovered application sticky-header defect.

Before: `.impeccable/review/tool-activity-premium/final-*`.
After: `.impeccable/review/tool-activity-final/final-*`.
Final executed checks and independent finish disposition follow below.


### Final refinement executed checks

- 229 tests across eight suites passed: exact fractional/zero/missing interval
  descriptions, P95 definition/sample qualifications, failure count/denominator
  and tiny-sample rate guards supplement the existing chart/data contracts.
- TypeScript and production build passed; no dependency change. The existing
  large-chunk warning remains.
- Brave fixture passes at1440×900,1280×800,1024×768,800×600,390×844,320×568;
  all nine themes retain computed text>=4.5:1 and actual chart marks>=3:1.
  Added assertions verify precise tooltip/accessibility text, visible phone
  median/P95 sorting values and actual sticky header geometry with100 rows.
  Existing search/filter/refresh/focus/selection/210-type paging, zero/missing,
  no-failure/tiny-sample/empty/unavailable/partial states, reduced motion and
 125% zoom checks also passed.
- Separate live read-only Codex pass:1,581 observed/measured calls,105 operations,
 14 reported failures at API-read time. Counts change as collection continues;
  this is not a static screenshot expectation. Keyboard/resize/selected refresh,
  nonadditive memberships, partial history and theme-placeholder checks passed.
- One detector pass:19 unchanged local typography advisories, no nonadvisory
  findings. Scope-specific type decisions are already documented.
- Evidence `.impeccable/review/tool-activity-final/final-*`; complete image is a
  stitch of captured body scroll slices plus original header. Use individual
  viewport screenshots for layout and scrolling judgment.

Limits: no live Claude stream, native Windows/Linux, Safari/Firefox,
screen-reader certification or formal comprehension participants. Automated
keyboard/contrast tests do not certify full accessibility. Independent final
review and scoped documentation handoff follow; no merge/deployment authorized.

Fresh independent file-only finish review, using the installed Impeccable
finish-reviewer fallback, returned **disposition: ship** with no material fixes.
It opened all25 required individual captures and the conceptual reference;
review evidence is `tool-activity-final/finish-review.md`. This scoped verdict
does not authorize merge/deployment or certify untested platforms.


## Product quality closeout — 2026-10-14

Focused final gate, preserving Direction A, four comparisons, themes and table.
Source investigation confirmed `capturedAt` is the server's report snapshot
cut-off passed into aggregation; it is not the last tool event or completion of
rendering. `observedUntil` is the maximum retained **start** timestamp among
calls in the provider/period query; outcomes may occur later. The header now says
Snapshot, coverage says Observed starts and separately names the latest observed
call start. Refresh may advance snapshot time without new starts. Neither sparse
endpoints nor this time difference establish continuous capture or collector
failure/health; only actual persisted-record quality flags trigger incomplete
history notices. No new heartbeat or collector semantics were introduced.

Duration review reproduced3,720,000ms formatting as1h with the old one-decimal
hour formatter. Values at least an hour now show integer hours plus remaining
minutes, rounded to the nearest minute with hour carry; the example is1h2min.
Exact integer hours remain compact. Sub-hour/ms, null and zero behavior is
unchanged; precise P95 raw-ms tooltip/accessibility descriptions are retained.
The first rendered batch exposed an orphaned min unit at320px; only the mobile
hour-summary role uses18px to keep the compound value readable. Confirmation
preserves the existing hierarchy and page composition.

P95, failure attribution, nonadditive memberships, shared/overlapping intervals,
provider-clock qualifications and intentional wait/sleep names are unchanged.
No speculative performance diagnosis or redundant findings block was added.
No installed validated data-visualization skill was found; Impeccable polish and
Product UI Craft final-gate workflow apply within the incumbent design.

Executed verification:
-231 tests/eight suites passed, including hour/minute precision/carry and all
 existing collector, eligible P95, exact descriptions, failure samples and sorts.
-TypeScript and production build passed; no dependency change. Existing
 large-chunk warning remains.
-Brave deterministic matrix passed six sizes and nine themes, with existing
 computed text>=4.5:1/actual marks>=3:1, keyboard/focus/selection, provider/period,
 search, refresh, sticky dense table, incomplete/missing/zero/no-failure states,
 reduced motion and125% zoom. Added hour and idle fixtures assert advancing
 snapshot with unchanged start endpoints and no invented collection warning.
-Read-only local Codex report check passed:1,653 observed/measured calls,
 105 operations,14 reported failures at API read time. This validates retained
 report integration, not proof of a continuously active external event stream.
-One detector pass:20 scoped typography advisories, no nonadvisory findings.
 The added18px role is narrow and deliberate; global typography unchanged.

Before: `.impeccable/review/tool-activity-final/final-*`.
After: `.impeccable/review/tool-activity-quality/final-*`.
Individual viewport captures establish layout; complete-report image is an
actual body-scroll stitch with original header, for content continuity only.

Limits remain live Claude, native Windows/Linux, Firefox/Safari, certified
screen-reader usability and formal comprehension study. No health heartbeat
exists; timestamp gaps alone cannot certify collector health. Independent finish
review and durable scoped documentation follow; PR #2125 stays draft, no merge.

Fresh independent finish review opened the required individual captures and
returned **disposition: ship**, no material fixes. Handoff recommendation:
**SHIP WITH LIMITATIONS** at the stated platform/integration/accessibility scope.
Evidence: `.impeccable/review/tool-activity-quality/finish-review.md`.
The durable scoped DESIGN/surface record now reflects the verified build; no merge.
