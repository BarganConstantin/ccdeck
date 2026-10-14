# Tool Activity — built Direction A report

Issue #2122. **Mode: Operate. World: established ccdeck instrument panel.**
This is the scoped durable record for the full-page report, superseding the
centered four-mode ranking. It does not change the global design system.

Implemented source is authoritative: `src/web/components/ToolAuditModal.tsx`,
`ToolAuditComparison.tsx`, `ToolAuditIntervalPlot.tsx`, `ToolAuditOperations.tsx`,
`ToolAuditDrawer.tsx` and the existing `ToolAuditInspector.tsx`, together with
`src/web/tool-audit-report.ts`, `src/web/tool-audit.ts` and `src/web/styles/tool-audit.css`.
The [Direction A contract](../../docs/features/tool-activity-report.md) records
quality bar, visualization research and executed validation. The
[verified data audit](../../docs/features/tool-explorer-design.md) remains the
measurement authority; its older architecture is historical, not current layout.

## Direction and quality bar

**THESIS:** a device-local report compares frequency, associated intervals and
reported outcomes simultaneously, then opens precise evidence on demand.
**OWN-WORLD:** existing theme surfaces, system sans controls, mono operation
identities, tabular values, fine rules and blue/amber/violet/red measurements.
**STORY:** read unique call totals, compare five usage/time leaders, inspect
three tail/failure leaders, then search/sort all operations and open recorded calls.
**FIRST VIEWPORT:** persistent Back/Refresh header, compact filters and summaries,
paired primary comparisons, subordinate median–P95 and failures; mobile stacks.
**FORM:** full application viewport overlay, one report body scroll, contextual
portal drawer; no route, metric mode switching or empty inspector reservation.
**FINISH:** two bounded rendered passes complete; fresh independent finish review
returns **disposition: ship** with no material fixes; user handoff recommendation
is **SHIP WITH LIMITATIONS**. No additional parent polish is owed. This scoped documentation completes the
assigned persistence handoff; parent owns other documentation and PR work.

**QUALITY BAR:** purpose and frequency leader should be apparent within five
seconds, with time comparison beside it on desktop. Names and exact values lead;
hue is supplementary. Long identities stay readable and every operation is
reachable in the searchable/sortable table. Refresh retains the previous snapshot
and communicates refresh/error state. The supplied reference is conceptual,
not a pixel-approved comp. Five-second comprehension is an expert heuristic,
not an executed participant study.

## Built composition and interaction

- **Entry and shell:** independent rail action below Usage history, More on phones,
  separate from Usage. Viewport overlay inherits background/panel/text tokens.
  Header Back to workspace and Refresh remain reachable while the body scrolls.
  Content has a centered 1360px maximum border-box width, including desktop 40px
  side padding. Header is 64px minimum (60px on phones). Fine rules and flat
  surfaces structure the report without giant KPI cards or decorative framing.
- **Summary and scope:** provider, period, search and optional custom UTC dates
  precede incomplete-history notices. Unique observed calls, cumulative intervals,
  reported failures and timing coverage retain provider/period scope during
  search. Search narrows charts/table with explicit scope text. Collapsed Coverage
  & definitions retains exact timed denominator and Observed starts, then
  requested dates, retained start, snapshot timestamp, latest observed call start, provider counts,
  unmatched outcomes and measurement definitions. Rounded coverage percentages
  always have an exact denominator; 100% can represent display rounding.
- **Usage and interval comparisons:** each shows five eligible leaders, descending
  order, full identities and exact values. Linear zero-origin bars scale to the
  largest eligible value across searched rows, including undisplayed rows. Blue
  denotes usage (`--usage-blue`); amber associated intervals (`--warn`). Counts
  overlap and associated intervals are explicitly not wall-clock time.
- **Median–P95 comparison:** three eligible P95 leaders, hollow median and solid
  P95 endpoints connected on one shared linear zero-origin scale. Ceiling rounds
  through 1/2/5/10 steps, with zero/midpoint/ceiling ticks in milliseconds or seconds.
  Exact median, P95 and measured sample count remain visible; timed counts sit
  under identity so long phone labels wrap coherently. Violet (`--usage-purple`)
  distinguishes the question. Endpoints are not min/max or a full distribution.
  Missing median is not synthesized; equal/zero endpoints stay visible. P95 needs
  ≥20 valid measured calls; unknown values never become zero. The pure comparison
  description in `src/web/tool-audit-report.ts` preserves precise recorded
  milliseconds (including fractions/zero), measured sample count, the P95
  definition/sample floor and named median/P95 endpoints.
  `ToolAuditComparison.tsx` reuses it for native title and accessible button name;
  compact visible interval labels remain rounded without inventing measurements.
- **Reported failures:** up to three leaders ordered and sized by failed
  containing-call count. Red (`--err`) count lollipops retain exact count and
  completed-outcome denominator. Separate rate text requires ≥20 completed
  outcomes; smaller samples say “Small sample · rate not compared.” No rate-length
  encoding, rate ranking or confidence claim. Shared containing-call outcomes
  remain explicitly qualified. Visible values name completed outcomes; the same
  title/accessibility description states exact failed/completed proportion,
  count ranking rather than rate, and the qualified rate or small-sample guard.
- **Visualization choice:** retain magnitude bars and use native responsive SVG
  where a second measured endpoint or count endpoint earns its geometry. Exact
  accessible button labels carry all measurements; decorative SVG is hidden from
  assistive technology. The feature contract records FT Visual Vocabulary and
  Datawrapper guidance, and evaluation of Recharts/visx. Neither library is added:
  these small plots do not remove filtering, focus or semantic complexity. No
  new data-visualization skill was installed; the optional `ccdeck-data-viz` skill
  was not found in installed roots/worktree. Key Findings remains omitted because
  it would duplicate visible chart leaders; no distribution or provider-performance
  claim is added.
- **All operations:** exact desktop table contains identity/provider, calls,
  associated intervals, median, P95 and failures. Fifty rows initially; Show 50
  more adds fifty. Sortable headers stay sticky within the report scroll; unknown
  metrics stay last ascending or descending, with stable identity ties. Explore
  focuses/scrolls to the table and selects its corresponding descending sort.
  Phone rows retain identity/provider and calls/intervals/failures. The table
  `data-sort` in `ToolAuditOperations.tsx` lets the ≤700px rules reveal median
  only for median sorting, or P95 only for P95 sorting. Those rows arrange four
  values—calls, intervals, active timing and failures—in a two-by-two grid. Other
  sorts keep the three-value density; both timings remain available in the drawer.
  Native phone metric and direction controls preserve sorting after desktop
  headers disappear. Keyboard-focused rows receive the existing hover background
  through `:focus-within`, keeping the focus-visible outline.
- **Responsive layout:** two desktop chart columns place frequency/time above
  smaller tail/failure evidence. At ≤700px analyses stack, filters occupy two
  columns with full-width search, summary retains three compact columns and
  timing coverage remains in the disclosure. Filter captions become visually
  hidden while accessible labels remain. Names wrap without horizontal document
  scrolling; at ≤360px content side padding is 16px. The short 800×600 and
  320×568 captures are authoritative adaptations, not scaled desktop screenshots.
- **Refresh and selection:** repeated requests are coalesced while report/detail
  work is active. Same-query refresh retains the previous snapshot with status
  and error feedback; changed provider/period replaces data. Selection survives
  search, sort and refresh while its identity remains, clearing when replacement
  data lacks it. Reset appears only for changed filters/search and restores all
  providers, seven days, empty search, descending calls and fifty rows.
- **Snapshot and observed starts:** header Snapshot names report `capturedAt`,
  the backend cutoff passed into aggregation, not the last tool event or completed
  generation. Coverage labels Observed starts and latest observed call start;
  `observedUntil` is the maximum start in the selected provider/period. Outcomes
  may be later. Refresh rereads saved observations and can advance snapshot time
  without new starts. No collection-health warning is inferred from inactivity.
- **Duration precision:** `auditDuration` values ≥1 hour round total minutes to
  the nearest minute, then derive integer hours and remaining minutes with correct
  carry. 3,720,000ms renders `1 h 2 min`; exact hours remain `1 h`. Sub-hour,
  unavailable and zero branches are unchanged. At ≤700px the hour-summary role
  alone uses 18px to keep the compound value readable at 320px.
- **Contextual drawer:** chart/table selections share one independently scrolling,
  focus-protected portal drawer, width `min(440px, 100%)`. It overlays the report
  without changing report scroll or reserving empty space. Keyboard selection
  focuses the operation heading; pointer entry focuses Close. Escape closes
  evidence first. Drawer close restores connected origin, matching operation
  button or report Back fallback. Report close restores a visible rail entry or
  More after resizing. Selection/details survive viewport changes.
- **Existing inspector:** Activity & outcomes and Measured intervals retain raw
  failure rate, exact median/P95/maximum, provider/timing counts and shared-call
  context. Small raw rates are qualified in Definitions & coverage even though
  overview rates are withheld. Slowest/Recent shows up to 20 measured or 30 recent
  sanitized containing calls from a separately fetched fresh snapshot, including
  loading/error/empty states.
- **Access and motion:** inherited nine themes, native controls/color scheme,
  visible focus and forced-color marks/selection remain. Main coarse-pointer
  actions have 44px targets. Keyboard and reduced-motion entry are immediate;
  otherwise the inherited entrance is 200ms. Reduced motion disables refresh
  glyph and loading rotation. Titles/values and endpoint shapes carry meaning
  without color; loading never invents progress.

## Measurement and privacy boundaries

A call is one unique observed start paired with at most one outcome. Replay/peer
enrichment and duplicate records are excluded. Operation counts are memberships
once per containing call, not independent shell executions. Compound commands and
wrappers can identify several operations; conditional branches and repetitions
are not independently observed proof that each command ran.

Shared operations inherit the complete containing-call interval and outcome;
operation counts, interval sums and failures are nonadditive. The call-wide
cumulative summary counts each measured call once, but parallel/nested intervals
still overlap and are not wall-clock time. Claude hook receipt and Codex rollout
clocks can include approval, delivery and orchestration waits. Mixed sources are
qualified when both have measured observations, not compared as provider speed.

Median is the midpoint; P95 is nearest rank with ≥20 valid timings; maximum is
largest observed interval. Measured zero is valid; missing, negative or source-less
timing remains unavailable. Failure counts are reported containing-call outcomes,
not exhaustive error detection or proof each inner command failed. Claude hook
outcomes and recognized Codex wrapper/nonzero leading exit-status markers are the
sources. Missing timing/unmatched outcomes never imply failure. Rate denominators
are completed outcomes, not all starts.

Periods filter observed starts and count matched intervals in full even when the
outcome is outside the range. Requested, retained and observed dates stay distinct;
sparse endpoints do not establish continuous coverage. Source inspection of
`src/server/tool-audit.mjs` and `src/server/tool-audit-report.mjs` confirms the
snapshot/start contract above; both are unchanged. Timestamp gaps establish
neither collector health nor failure; no health heartbeat exists. Only actual
persisted-record quality flags trigger incomplete-history notices. Forward-only device-local
history has no old-session import/synchronization. General Settings owns
30/60/90-day retention, stored bytes and confirmed clear. Custom UTC dates allow
at most 90 calendar days inclusive; reports load on demand.

Only sanitized tool/operation, provider, timestamp, interval, outcome and shared
flag are retained for evidence. No arguments, outputs, messages, error text, file
contents or full traces. No trends, cost, latency score or bottleneck badge is
inferred. This report adds no collectors, backend storage behavior, dependencies
or global tokens.

## Local typography exceptions

These values are observed Tool Activity roles in `tool-audit.css`, not additions
to the global type ramp or permission to reuse hero steps on other surfaces.

| Role | Actual local values |
| --- | --- |
| Report title | 17px/600; 16px at ≤700px, 15px at ≤360px |
| Comparison / explorer headings | 15px/600 / 16px/600 |
| Summary values | 26px/500; primary 32px/600; coverage 20px |
| Phone summary values | 22px/500; primary 28px/600; hour-duration summary alone 18px at ≤700px |
| Controls, table data, operation identities | 12px; context/labels 11px; identities 11px at ≤360px |
| Exact chart / inspector values and inspector heading | 13px mono; chart values 12px at ≤360px |
| Qualifiers, timed sample counts, axes, table provider metadata | 10px |

System sans remains the UI voice; mono identities/exact measurements and tabular
numbers keep the instrument character. Larger sans summary values establish glance
priority; compact sample/axis roles support dense evidence. The premium and preceding final refinement detector passes each recorded
**19 local typography advisories and zero nonadvisory findings**. The single
2026-10-14 quality closeout pass recorded **20 local typography advisories and zero
nonadvisory findings**. The additional 18px mobile hour-summary role is intentional
and narrowly scoped; it does not change the global type ramp. Preserve all existing
role exceptions. This documentation handoff does not rerun the detector or claim
its advisories cleared.

## Verified finish and evidence

The fresh independent [quality finish review](../review/tool-activity-quality/finish-review.md)
returns **disposition: ship**, with **no material fixes**; user handoff recommendation
is **SHIP WITH LIMITATIONS**. It is a fresh file-only review of all 25 required
quality captures, the preceding before captures and conceptual reference, using
retained source and validation evidence. It does not independently recertify
browser measurements. Two bounded quality passes are complete: the first exposed
an orphaned minute unit at 320px; the second confirmed the narrow 18px mobile
hour-summary correction. No more parent polish is required.

Existing [Product quality closeout](../../docs/features/tool-activity-report.md#product-quality-closeout--2026-10-14)
records:

- **231 tests across eight suites passed**, including nearest-minute hour precision
  and carry, unchanged exact-hour/sub-hour/null/zero formatting, and existing
  collector, precise fractional/zero/null P95 descriptions, ≥20 eligibility,
  simple linear axis, containing-call failure numerator/denominator and sample
  guards. TypeScript and production build passed; the inherited large-chunk warning
  remains. No dependencies or backend change.
- Brave fixtures passed at **1440×900, 1280×800, 1024×768, 800×600, 390×844 and
  320×568**, with nine themes, 125% zoom, keyboard/focus/restoration, reduced
  motion, provider/period/search, refresh coalescing/retained snapshot, selected
  detail, resize and dense 210-type paging. Computed visible text met **≥4.5:1**;
  actual marks across four charts met **≥3:1**. New inactive fixtures assert
  snapshot advances while observed starts stay unchanged without an invented
  collection warning; hour fixtures assert `1 h 2 min` in summary and chart.
  Previous active phone median/P95 sorting and actual sticky-header geometry with
  100 visible rows still pass. This is scoped evidence, not every theme at every
  viewport or formal accessibility certification.
- Sparse/missing/no-failures/zero/empty/unavailable/partial/no-search-match/tiny
  failure samples retain truthful rendered states. P95, failure attribution,
  nonadditive memberships, shared/overlapping intervals and provider-clock
  qualifications are unchanged. Intentional wait/sleep names stay descriptive,
  without inferred performance problems.
- Read-only retained Codex API snapshot: **1,653 observed/measured calls,
  105 operation identities and 14 reported failures**. This validates retained
  report integration, not continuously active external capture or complete
  requested history; counts are snapshot observations, not fixed expectations.
- One closeout detector pass recorded **20 local typography advisories and zero
  nonadvisory findings**. The additional local 18px role is intentional. No source
  edits or QA/context/detector reruns accompany this documentation handoff.

The preceding 229-test / 1,581-call / 19-advisory finish remains historical evidence
in the [prior final review](../review/tool-activity-final/finish-review.md); the
226-test / 1,466-call premium baseline remains in the feature contract and
[premium review](../review/tool-activity-premium/finish-review.md).
Current required quality captures were opened individually for this handoff:

- [Inactive coverage, 1280×800](../review/tool-activity-quality/final-inactive-coverage-1280-800.png)
- [Inactive coverage, 320×568](../review/tool-activity-quality/final-inactive-coverage-320-568.png)
- [Compound hour summary, 320×568](../review/tool-activity-quality/final-hours-320-568.png)
- [Secondary comparisons, 1280×800](../review/tool-activity-quality/final-secondary-1280-800.png)
- [Light theme, 1280×800](../review/tool-activity-quality/final-theme-light-1280-800.png)
- [Retained live overview, 1440px](../review/tool-activity-quality/final-live-overview-1440.png)

Secondary/operations/coverage captures are scrolled sections; drawer captures show
contextual evidence. The complete live report is a body-scroll stitch with the
original header, useful for content continuity only; individual viewport captures
establish layout and scrolling. Synthetic fixtures are separate from collector
history. Native titles supplement visible values/qualifications; their presence
does not establish touch or screen-reader usability.

Live Claude hook collection, native Windows/Linux execution, Firefox/Safari,
formal screen-reader usability/certification and participant comprehension research
remain unverified. No health heartbeat exists; timestamp gaps alone cannot certify
collector health. This handoff updates only the Tool Activity subsection of
`DESIGN.md` and this surface record, checks scope/whitespace/local links, and does
not rerun context, detector or QA. No source edit, git commit/push/merge or
publication; parent owns other documentation and PR work.
