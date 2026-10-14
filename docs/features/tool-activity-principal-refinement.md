# Tool Activity craftsmanship refinement — 2026-10-14

This is Product UI Craft C (polish), Impeccable polish and Animate feedback,
continuing `feat/2122-tool-audit` / draft PR #2125. The current full-page
architecture, 1360px reading width, four comparisons, searchable/sortable
explorer and contextual inspector remain. No server, collector, aggregation,
metric formatting or dependency changed. No merge or deployment.

## Audit and decisions

The baseline was rendered in Brave with isolated browser fixtures, then compared
with working changes at matching viewports. Previous education/report work was
inspected rather than rebuilt. No installed validated `ccdeck-data-viz` skill
was found in the project, internal skills or installed skill roots.

| Highest-impact finding | Implemented decision | Preserved behavior |
| --- | --- | --- |
| Sample counts, axes, failure denominators and table context use 10–11px text | Supporting roles use 12px; desktop operation identities use 13px; inspector heading and measurements use 16px | Existing typefaces, tabular numerals, wrapping, row padding, summary proportions |
| P95 caption assumes the reader already understands the statistic | Plain-language caption, direct P95 value label, 20+ sample legend and a hypothetical 3-second example in help | Shared linear zero-origin scale, hollow median/solid P95, exact recorded-ms accessible text, 20 valid samples |
| Cumulative time/failures/freshness mainly depend on native titles or the technical disclosure | Dotted-underlined summary labels open the existing anchored dialog; snapshot opens concise freshness help | Main report stays concise; coverage disclosure remains; no repeated info icons |
| Inspector failure attribution and missing measurements are too deeply disclosed | Immediate containing-call failure explanation, missing-timing count when present and P95 eligibility reason | Raw recorded metrics, small-sample rate qualification, sanitized call evidence |
| Unknown operations only have native hover titles | Same pointer/focus hint with explicitly unverified purpose; matching accessible name; touch opens persistent inspector text | Exact identity only; no namespace/suffix guessing or argument interpretation |

The verified glossary now includes `git add`: stage file changes for the next
commit, checked against the [official Git manual](https://git-scm.com/docs/git-add).
The existing verified entries remain; unknown Claude/MCP/custom identities keep
an explicit unverified description. A general purpose never establishes what a
particular recorded call did.

## Research translated into decisions

- [IBM chart anatomy and interaction](https://www.ibm.com/design/language/data-visualization/design/basics/): readable direct values, visible core meaning, a shared scale and marker shapes supplement color.
- [Datawrapper text](https://www.datawrapper.de/blog/text-in-data-visualizations): explain at the point of reading; retain units and numeric alignment, raise annotation readability.
- [Datawrapper chart choice](https://www.datawrapper.de/blog/chart-types-guide): retain simple horizontal comparisons and the compact paired-point interval display; no new chart type or redundant insight block.
- [NN/g progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/): main chart labels explain the question, optional help supplies definitions/examples, inspector provides operation evidence.
- [Atlassian motion](https://atlassian.design/foundations/motion): 100ms hover/selection background feedback confirms the target. Existing pointer inspector entrance remains 160ms. Chart geometry/numbers never animate through artificial intermediate measurements.
- [W3C tooltip pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tooltip/): operation hints never receive focus or contain controls; Escape dismisses the hint first. Shared hints intentionally expose equivalent content through the button's accessible name. Interactive help uses a focus-managed dialog with Escape/Done restoration.

## Bounded rendered refinement

Pass A reviewed the full composition, chart labels, popovers and inspector.
Pass B reviewed keyboard/focus, touch, selection, reduced motion and themes.
The typography improvements preserve original density rather than enlarging all
components. A hidden snapshot help button introduced by the first pass is now
removed from the narrow-screen focus order; narrow snapshot information remains
in Coverage & definitions. Touch receives no sticky hover feedback. Keyboard row
focus and reduced-motion state changes are immediate.

Unknown-operation keyboard hints correctly consume Escape before the report.
The fixture harness now explicitly closes the report between unrelated datasets;
it still verifies hint-first Escape, drawer Escape and focus restoration.
No shared dismiss hook was changed to accommodate automation.

## Executed verification

- `npm run typecheck`: passed.
- `npm run build`: passed. Existing main/HLS chunks exceed Vite's 500kB warning.
- Node 22.14: six suites / 133 tests passed (glossary, chart comparisons,
  collector/aggregation, Codex watcher, theme contrast floors, popover placement).
- Additional shared modal tests: 16 pass; the static backdrop inventory fails.
  An isolated copy of unchanged HEAD reproduces the identical failure because
  its expected list omits QuotaHistoryModal, ToolAuditModal and ToolAuditDrawer.
  This baseline failure is recorded, not presented as a passing check.
- Final Brave fixture matrix passed 1440×900, 1280×800, 1024×768, 800×600,
  390×844 and 320×568. It covers frequency/time/P95/failure mappings, exact
  accessibility text, pointer/focus hints, all new help types where visible,
  Escape focus return, touch inspection, no click scroll jump, search,
  sorting, provider/period/reset, refresh, dense 210-operation paging and sticky
  header geometry, missing/zero/partial/empty/error/no-failure/tiny-sample states.
- Nine palette checks passed sampled composited text ≥4.5:1 and chart marks
  ≥3:1, including timing help. Light, Rider Black and alternate palette captures
  are retained. This is sampled verification, not accessibility certification.
- CSS layout scaling at 125%, 150% and 200% passed geometry checks at 1280×800.
  This approximates zoom/reflow; native browser-menu zoom was not exercised.
- Reduced motion verified report, inspector, educational dialog animation=none
  and chart transition duration=0, including a 320px touch context.
- Read-only retained local report integration passed: 1,955 calls, 1,954 measured,
  115 operations, 15 reported failures at API read time. Nonadditive memberships,
  history endpoints, resize, selected refresh and focus restoration passed.
  Counts can change during collection; this does not certify continuous capture.
- One Impeccable source detector scan reported 11 type-ramp findings for the
  existing report-specific heading/summary sizes. They are retained intentional
  local roles documented in DESIGN.md; detector exit 2 is not claimed as a pass.
- `git diff --check`: passed.

## Comprehension walkthrough

This is a design walkthrough, not a participant study. `rg` meaning is available
on pointer/focus and persists after touch selection. The Most used and Most
measured time leaders have visible names and exact compact values. P95's visible
caption gives its meaning; help separates the example, 20-sample eligibility and
containing-call semantics. Cumulative time explicitly says not wall-clock time
in the chart and summary help. Failure help and inspector explain attribution.
All chart/table entries open the same details, preserving report position; the
close action returns focus. Precise values remain directly scannable.

## Evidence and limits

[Capture index](../../.impeccable/review/tool-activity-principal/index.md) contains
before/after overview, P95, hints/help, selection/inspector, table, mobile and theme
images, plus actual command logs. The complete-report image joins actual scroll
slices with the original header; individual viewport images establish geometry.
Fixture records never enter the collector. Live captures use retained local data.

SHIP WITH FOLLOW-UPS for this scoped refinement: the inherited modal inventory
failure and large-chunk warning remain. No formal participant comprehension or
screen-reader study, live Claude collection, Safari/Firefox, native Windows/Linux
or full accessibility certification ran. No new recording/health capability is
implied. PR #2125 stays draft.
