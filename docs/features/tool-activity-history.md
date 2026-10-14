# Tool Activity: integrated inspection and daily history

Implemented on `feat/2122-tool-audit`, draft PR #2125. This extends the existing
full-page report and replaces desktop overlay inspection. No collector,
classification, retention, persisted record schema, raw arguments/outputs or
external analytics service changed. No new dependency, merge or deployment.

## Findings and chosen composition

Product UI Craft B for the inspector and A for daily history, Impeccable established-surface refinement,
and the existing Animate feedback conventions apply. No validated installed
`ccdeck-data-viz` skill was available. Existing project tokens, components,
measurement documentation and primary-source research in
[the earlier refinement](tool-activity-principal-refinement.md) informed the work.

The main problems were chart obstruction, a disconnected modal inspector,
viewport-only chart sizing, dense repetitive explanations and weak contextual
navigation. The selected structure addresses those specific problems:

- Closed: centered report, existing 1360px maximum content measure, no empty pane.
- At ≥960px: real CSS Grid with a flexible report and a 360px inspector. A subtle
  separator joins the surfaces; the workspace can use the full viewport.
- At 701–959px: two integrated rows with independent scroll, allocating roughly
  55% of the available height to the report and 45% to inspection. A narrow split
  would leave two poor reading columns; stacking keeps the analytical context.
- At ≤700px: a genuine modal dialog, focus-protected and portalled through the
  existing infrastructure. Desktop/intermediate inspection is a named `aside`
  and never claims `aria-modal` or traps Tab separately from the report.
- The report column is an inline-size container. Charts stack below 760px of
  available report width; below 600px the existing compact table presentation is
  adapted to the column. These conditions react to inspector width, not merely
  viewport width. All four comparisons, provider/period/search and sorting remain.

Selection stores the clicked entry's visual offset. After reflow, the report
restores that anchor, clamping it into view if the stacked region becomes shorter.
Closing preserves the current analytical anchor and returns focus to the original
entry, another exact identity match or the report's Back action. Report and pane
scroll independently. A sticky name/close header remains reachable in the pane.
Keyboard selection focuses the operation heading immediately; pointer selection
keeps the source available for further investigation. Escape dismisses help/hints
first, then inspection. A removed operation closes with a provider/period notice;
refresh retains an existing selection. Similar operation names are not conflated.

The pane uses the inherited 160ms opacity entrance with the house curve. Keyboard
and reduced-motion entrances are immediate; closing does not delay focus return.
Grid geometry is resolved once before painting, rather than repeatedly animating
width or temporarily covering charts. No negative margins or transform-based
layout offsets are used. The Tool Activity rail glyph is now a house-style wrench,
replacing the terminal symbol the owner identified as misleading.

## Inspector hierarchy

Name, verified purpose, providers and close action establish identity. Average,
Median, eligible P95 and Maximum lead; Performance over time follows directly.
Activity/outcome counts, cumulative associated intervals, compact recorded calls
and Definitions & coverage follow. Detailed semantics are disclosed once. Missing
measurements, small outcome samples, mixed clocks and incomplete retained history
remain visibly qualified where relevant. Outcomes use text and glyphs; reported
failures receive the existing error token, while successful calls remain calm.

Interval help now explains all four statistics. Average uses valid timings only;
missing timing never becomes zero. Cumulative intervals remain explicitly
nonadditive/overlapping and not elapsed wall-clock time. Historical requests return
summary measurements and daily data from the same worker snapshot, plus a detail
cut-off timestamp, avoiding a newer trend beside an older inspector mean.

## Daily API design

Existing endpoint: `/api/tool-audit`. Daily data is opt-in through
`operation=rg&history=1&timeZone=Europe%2FChisinau`, alongside the existing provider,
period or custom UTC range. Invalid flags, missing operation, oversized operation
names/ranges and invalid IANA zones are rejected. UTC is the API default; the UI
passes the browser's IANA display timezone and labels it explicitly.

The existing worker reads retained daily journals and pairs starts/outcomes with
its existing duplicate handling and duration validation. The same loop populates
selected-operation daily buckets. No reconstruction from the 20 slowest or 30
recent samples occurs. Responses contain at most 92 calendar buckets, stable in
ascending ISO-date order, and no per-day raw records or duration arrays. Existing
worker cancellation, 500,000-call/64MiB-per-file capacity and memory limits remain.

An operation row gains additive `averageMs`. With history enabled, operation
`details` additionally includes `capturedAt`, `measurements` (the same snapshot's
operation row), and `history: { timeZone, days }`. Legacy details retain their
original shape when history is not requested. A daily record contains date,
containing-call count, valid timing count, shared membership count, provider
counts, partial-day flag, state, Average, Median, Maximum and eligible P95.

Timezone policy:

- Bucket by the **observed start** (`start.t`), consistently with period filtering.
  The measured interval still uses its existing source clock (`start.at/end.at`).
- IANA calendar dates are obtained with Intl; day labels advance as calendar
  dates, independent of offset changes. DST days may contain 23 or 25 hours.
- A call crossing midnight belongs once to its observed start day, with its full
  valid containing-call interval. No invented inner executions or split durations.
- Rolling ranges can include partial first/final calendar days. Custom date ranges
  continue to filter UTC as before, so local buckets can be partial at either end.
- Retained history starts at the later of recording start and the existing UTC
  journal-retention boundary. Local days before it are outside history; the
  boundary day is marked partial when appropriate. Complete UTC calendar ranges
  are not automatically marked partial.

Daily states distinguish `outside-history`, `no-calls`, `missing-timing` and
`measured`. No-call counts describe retained observations, not continuous capture.
Null Average/Median/Maximum/P95 remain unavailable. Measured zero is zero. Daily
P95 independently requires 20 valid measurements and uses the existing nearest-rank
rule. Provider filtering precedes bucketing. Shared memberships remain nonadditive;
Claude receipt and Codex rollout intervals are not provider speed benchmarks.

## Chart and interaction

Average and Median are the default lines. The comparison control can show Average
alone or substitute Maximum/P95 for Median; four overlapping series never appear.
Average has solid blue marks; comparison has hollow violet marks and a dashed
line. Both have text labels, so color is not their only distinction. The zero-origin
scale repeats units, preserves fractional millisecond ticks and shows a neutral
empty state when no valid timings exist. Nulls break segments; isolated valid days
remain points. Dense 60/90-day series retain all data but reduce unnecessary dots.

A separate small count plot provides sample context on its own count scale.
Pointer inspection updates a persistent selected-day panel; a labelled range
control and Previous/Next buttons expose the same dates through keyboard/touch.
Inspection starts on the latest day with recorded calls, including days with
missing timing, rather than an empty final date. The panel provides all four
intervals, calls, valid timings, provider mix, shared
counts, partial-day and missing/eligibility context. Fractional subsecond statistics retain up to three decimal places; positive
values below 0.001ms are labelled as such, rather than zero. Exact milliseconds supplement
compact display in accessible labels and native value titles. A polite live region
announces changed day evidence. Date identity survives refresh when the range moves. Shared counts are labelled
as calls, including calls whose timing has not yet been recorded.

No efficiency score, automatic regression diagnosis, fabricated intermediate
numbers, connection across missing timings or unsupported cross-provider comparison
was added. Comparing two operations is deliberately deferred.

## Verified calculation examples

These are deterministic test fixtures, not claimed ccdeck production observations.

| Valid intervals | Containing calls / valid timings | Average | Median | Maximum | P95 |
| --- | --- | --- | --- | --- | --- |
| 0, 100, 100, 1000ms; one unknown timing | 5 / 4 | 300ms | 100ms | 1000ms | Unavailable |
| Integer intervals 0 through 19ms | 20 / 20 | 9.5ms | 9.5ms | 19ms | 18ms |
| 0ms, twenty-eight 160ms intervals, 1500ms | 30 / 30 | 199.33333333333334ms | 160ms | 1500ms | 160ms |

## Actual verification

- TypeScript and production build passed. Existing main/HLS >500kB warnings remain.
- Node 22.14: 219 tests across ten suites passed. New daily/line tests cover valid
  and missing timings, zero, outliers, per-day P95, all periods, midnight, spring
  and autumn DST, retention/partial boundaries, provider/exact-operation filtering,
  shared memberships, legacy response behavior, validation and 10,000 calls beyond
  truncated evidence lists. Existing collector, Codex watcher, comparison/sort,
  glossary, placement, contrast, focus and shortcut tests passed.
- Final Brave matrix passed 1728×1000, 1440×900, 1280×800, 1024×768, 800×600,
  390×844 and 320×568. Closed/open report, rg, time-selected operation, long name,
  thirty recent calls, missing timings, reported failures, close/switch, selected
  refresh, 30/60/90 days, short-height resize and reduced motion were exercised.
  Actual region geometry confirms no overlap or accidental horizontal overflow.
- Keyboard checks verified heading focus, nonmodal desktop Tab access, mobile
  modal behavior, day arrows/Home, interval help and Done restoration, exact daily
  values, sticky close, retained filter focus, provider removal and date identity across midnight refresh.
  A separate actual 320px touch-tap check passed operation opening, modal semantics,
  no hover hint, reduced motion, 44px day steps, date change and close/focus return.
- Nine palettes passed sampled composited text ≥4.5:1 and series/count marks ≥3:1.
  Text/marks were tested on the actual new inspector, not only token constants.
- CSS layout scaling at 125%, 150%, 200% passed geometry with inspection open.
  Native browser-menu zoom was not exercised.
- Read-only retained Codex integration passed. A separate real daily API check
  verified summed daily memberships/timings against the operation summary,
  weighted averages against its total, P95 eligibility and nulls. No actual data
  was inserted into journals. Live statistics/captures remain local evidence.
- One Impeccable source scan reported 13 local type-ramp findings, primarily
  established report display roles; its exit 2 is not a clean detector pass. One
  unused 14px role reported by that scan was subsequently removed. New inspector
  name/interval sizes are deliberate local roles; global typography is unchanged.
- `git diff --check` passed. No new dependency or backend collector change.

Pass A reviewed composition, axes, grouping and responsive states. Pass B reviewed
focus, scroll anchoring, resize, selection, theme contrast and day inspection.
Observed corrections included retaining the selected entry in the shorter stacked
region, neutral no-timing axes, date-based selection during rolling refresh,
matching detail/history snapshots and removing an undefined local font reference.
These were bounded defect fixes, not an open-ended aesthetic loop.

[Local screenshot/test index](../../.impeccable/review/tool-activity-history/index.md).
Before captures use the earlier deterministic report fixture; after captures are
built from sanitized synthetic journal records through the actual aggregator.
Compare layout, not numeric performance changes. Live captures use retained data.

Disposition: **SHIP WITH FOLLOW-UPS** at this scope. Formal screen-reader and
participant testing, live Claude collection, Safari/Firefox and native Windows/Linux
remain unverified. Previous shared modal inventory tests have a documented inherited
failure; the full repository suite was not claimed green. Sparse retained history
cannot establish continuous recording or performance regression. PR #2125 stays draft.
