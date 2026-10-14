# Tool Activity — report, integrated inspector and daily history

Latest inspector/history architecture: [implemented contract](../../docs/features/tool-activity-history.md). It supersedes the earlier desktop overlay/focus-trap passages below; those record previous iterations.

Issue #2122. **Mode: Operate. World: established ccdeck instrument panel.**
This is the scoped durable record for the full-page report, superseding the
centered four-mode ranking. It does not change the global design system.

Implemented source is authoritative: `src/web/components/ToolAuditModal.tsx`,
`ToolAuditComparison.tsx`, `ToolAuditIntervalPlot.tsx`, `ToolAuditOperations.tsx`,
`ToolAuditDrawer.tsx`, `ToolAuditInspector.tsx`, `ToolAuditOperationButton.tsx`
and `ToolAuditMetricHelp.tsx`, together with `src/web/tool-audit-report.ts`,
`src/web/operation-glossary.ts`, `src/web/tool-audit-education.ts`, `src/web/tool-audit.ts`
and `src/web/styles/tool-audit.css`. Shared `AnchoredPopover` dismissal-layer and
`useHint` focused-anchor behavior are opt-in; existing consumers retain defaults.
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
requested one table accessible-name qualification fix; the same reviewer
resolved it in the final **disposition: ship** verdict with no further material fix
or regression. User handoff recommendation is **SHIP WITH LIMITATIONS**. No additional parent polish is owed. This scoped documentation completes the
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
  `ToolAuditComparison.tsx` reuses it for accessible button names and unknown
  operations’ fallback native titles. Verified operations use the shared purpose
  hint, with precise P95 values and the general-purpose/arguments qualification;
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
  context. Small raw rates receive an immediate sample-size/descriptive-rate
  qualification beside Activity & outcomes; overview rates remain withheld.
  Inspector P95 uses the existing `auditMetricValue` eligibility helper, so fewer
  than 20 valid measured calls cannot display an eligible P95. Slowest/Recent shows up to 20 measured or 30 recent
  sanitized containing calls from a separately fetched fresh snapshot, including
  loading/error/empty states.
- **Access and motion:** inherited nine themes, native controls/color scheme,
  visible focus and forced-color marks/selection remain. Main coarse-pointer
  actions and education Help have 44px targets. Report keyboard/reduced entry
  is immediate; the inherited report pointer entrance remains 200ms. Pointer
  drawer entry fades from 0.6 opacity over 160ms with the house curve
  `cubic-bezier(0.23, 1, 0.32, 1)`. Keyboard/reduced drawer entry and closing
  are immediate. Help keeps the existing shared 120ms pointer entrance with
  immediate keyboard/reduced entry. Reduced motion disables refresh glyph and
  loading rotation. There is no chart/filter choreography. Titles/values and endpoint shapes carry meaning
  without color; loading never invents progress.

## Verified purposes and progressive education

The [education record](../../docs/features/tool-activity-education.md) identifies
five resolved comprehension findings: unexplained operation identities,
statistical vocabulary in Median/P95, native-title-only teaching, collapsed
small-sample qualifications and abrupt pointer inspection. The refinement keeps
Direction A's full page, four chart encodings/colors, complete explorer and data.

`operation-glossary.ts` contains exactly fourteen verified general-purpose entries:

| Exact identity | Purpose | Verification basis |
| --- | --- | --- |
| `rg` | Search for matching text across files. | ripgrep maintainer README |
| `cat` | Read and combine file contents or input into output. | GNU Coreutils manual |
| `sed` | Filter and transform text using editing rules. | GNU sed manual |
| `head` | Show the beginning of a file or text input. | GNU Coreutils manual |
| `tail` | Show the end of a file or text input. | GNU Coreutils manual |
| `git diff` | Show differences between code versions or working changes. | Official Git diff manual |
| `git status` | Show staged, unstaged and untracked Git working-tree changes. | Official Git status manual |
| `git commit` | Record staged changes in Git history. | Official Git commit manual |
| `sleep` | Wait for a specified duration. | GNU Coreutils manual |
| `write_stdin` | Send input to, or read more output from, an existing process. | Installed callable-tool contract, 2026-10-14 |
| `view_image` | Inspect an image stored in a local file. | Installed callable-tool contract, 2026-10-14 |
| `apply_patch` | Apply structured changes to files. | Installed callable-tool contract, 2026-10-14 |
| `multi_agent_v1__wait_agent` | Wait for one or more agents to reach a final status. | Installed callable-tool contract, 2026-10-14 |
| `shell (unclassified)` | A shell command whose concrete operation could not be reliably identified. | Project classifier fallback |

The education record links the primary manuals and records contract/classifier
verification. Exact own-property lookup excludes prototype keys, arbitrary MCP
suffix matches and argument interpretation. The unconfirmed single-underscore
`multi_agent_v1_wait_agent` is not an alias. No network lookup or AI interpretation
is added. Unknown names keep neutral identities; the inspector explicitly says
no verified purpose is available (including an unverified MCP-purpose fallback).
Every persistent purpose carries `operationPurposeNote`: “General purpose only;
recorded arguments and outputs are not available.” This describes a tool in
general, never what a particular recorded call accomplished.

- **Mouse and keyboard:** `ToolAuditOperationButton` reuses the existing chrome
  hint on pointer rest and focus. P95 hints retain exact raw Median/P95
  milliseconds and measured sample count, including valid zero/fractional values.
  Shared `useHint` optionally follows a focused visible anchor during scrolling,
  flips and clamps to available space. Other consumers retain existing defaults.
  No repeated purpose paragraph is added beneath each ranking row.
- **Accessible parity and touch:** charts and table use verified purpose plus
  the same qualification in accessible names. Unknown table names retain the exact
  identity. Both expose selected `aria-expanded` and the common
  `tool-operation-inspector` panel target. Touch selection opens the persistent
  purpose in the same inspector, with existing evidence and focus protection.
- **Focused metric help:** one Help beside Slowest P95 and the same component in
  inspector Measured intervals reuse `AnchoredPopover`. Initial focus goes to
  the h4 so short help starts at its beginning; Escape or the Got it completion
  control returns to the anchor. Placement is viewport-bounded with internal
  scrolling as needed. Optional layer 1103 dismisses help before its enclosing
  report/drawer; other shared consumers keep defaults.
- **Plain definitions:** Median means half of measured containing-call intervals
  were this long or shorter. P95 means approximately 95% were this long or shorter;
  the slowest 5% may take longer. The existing 20-valid-measurement display floor
  is stated separately from percentile definition and does not guarantee
  confidence. Whole containing-call intervals can include waits; they do not
  isolate inner-command runtime. The generic nine-entry metric guide appears
  only when explicitly opened within Coverage & definitions, preserving snapshot
  and observed-data facts ahead of teaching copy.
- **Immediate sample honesty:** raw inspector rates below 20 completed outcomes
  immediately name the sample size and say the rate describes this sample, not
  reliability. Overview rate comparisons remain withheld below their existing
  floor. Inspector P95 validates through the existing eligibility helper;
  aggregation, null/zero and provider timing semantics remain unchanged.

The parent bounded critique and confirmation are complete. The large guide was
moved behind its explicit disclosure and help starts at its focused heading.
A tooltip beneath a stationary automated pointer caused Playwright actionability
scrolling; the native point-click regression moved the pointer away and clicked
visible screen coordinates, confirming report scroll preservation. The existing
shared focus hook remains unchanged. Keyboard focus scrolling required only the
opt-in focused-anchor hint behavior. No further polish is owed.

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

The independent [education finish review](../review/tool-activity-education/finish-review.md)
returned **disposition: fix** for one table accessible-name omission: the purpose
was present without the qualification carried by chart names and visible hints.
`ToolAuditOperations` now appends the same `operationPurposeNote`. Actual known
purpose/qualification and unchanged unknown-name browser checks passed in
`/tmp/ccdeck-education-parity.log`. The same reviewer's
[finish verdict](../review/tool-activity-education/finish-verdict.md) scores
**fix 1 RESOLVED**, final **disposition: ship**, with no further material fix or
fix-induced regression. It reopens the retained 25 before/after captures and
scores the sole correction; it does not constitute a new whole-surface browser
review or formal screen-reader certification. Recommendation remains
**SHIP WITH LIMITATIONS**. Parent bounded critique and confirmation are complete;
this documentation handoff owes no further polish.

Retained [education verification](../../docs/features/tool-activity-education.md#executed-verification)
records the following actual checks, read for this handoff rather than rerun:

- **265 tests across 13 suites passed** in `/tmp/ccdeck-education-tests.log`:
  exact glossary identities/prototype safety, unknown namespaces/argument
  rejection, teaching semantics, collector/P95/failure contracts, focus/portal/
  shortcuts/contrast and shared hint/popover regressions. Typecheck and production
  build passed; inherited large main/HLS chunk warnings remain. No dependency or
  backend change.
- **Six Brave sizes:** 1440×900, 1280×800, 1024×768, 800×600, 390×844 and
  320×568. `/tmp/ccdeck-education-browser.log` retains the passed matrix;
  the education record details mouse/focus purposes, raw P95 hints, help heading
  focus/trap/Escape/return, 390/320 touch inspector/help, expanded selection and
  common target, scope/search/sorting/filter/refresh, dense 210-operation paging,
  P95 eligibility, unknown/null/zero, sparse/missing/partial/empty/error/tiny
  failures, sticky headers, native point-click scroll preservation and 125% zoom.
  All nine themes include help text in sampled **≥4.5:1** checks and original
  nonzero marks across four charts in **≥3:1** checks. This is sampled scoped
  evidence, not every theme at every viewport or certified accessibility.
- **Motion:** keyboard report help and inspector animation-none checks pass.
  `/tmp/ccdeck-education-motion.log` confirms reduced pointer Help, Inspector and
  Inspector Help have no animation in the 320px touch context. Existing reduced
  report checks remain passed. Closing returns focus immediately.
- **Read-only retained Codex integration:** `/tmp/ccdeck-education-live.log`
  records **1,796 observed/measured calls, 105 operations and 14 reported
  failures**, plus nonadditive memberships, partial history, keyboard trap/return,
  resize and selected refresh. These are read-time snapshot observations;
  screenshot moments can differ. Retained integration does not establish
  continuously active collection or complete requested history.
- **Single detector record:** 20 existing scoped typography advisories and zero
  nonadvisory findings. No typography/global-theme change or claim that advisories
  were cleared. This handoff does not rerun the detector.

The prior quality closeout's 231-test/eight-suite and 1,653-call snapshot remain
historical in the [report contract](../../docs/features/tool-activity-report.md#product-quality-closeout--2026-10-14)
and [quality review](../review/tool-activity-quality/finish-review.md). Older final
and premium review evidence remains historical as well; it is not the current
education verdict.

These six required education captures were opened individually for this handoff:

- [Operation hover, 1280×800](../review/tool-activity-education/final-operation-hover-1280-800.png)
- [Operation focus and raw P95 hint, 800×600](../review/tool-activity-education/final-operation-focus-800-600.png)
- [P95 help, 1280×800](../review/tool-activity-education/final-p95-help-1280-800.png)
- [Persistent touch purpose and inspector help, 390×844](../review/tool-activity-education/final-touch-description-390-844.png)
- [Details, 320×568](../review/tool-activity-education/final-details-320-568.png)
- [Light education help, 1280×800](../review/tool-activity-education/final-theme-education-light-1280-800.png)

The focus capture is a scrolled report section; phone drawer/help captures show
contextual, independently scrollable evidence. Individual viewport captures
establish layout and scrolling. The complete live report stitch establishes
content continuity only, including repeated sticky headers; it is not geometry
or scroll proof. Synthetic fixtures remain separate from retained collector
history. Screenshots cannot prove accessible names; source and the retained
computed-name parity check establish that correction.

Live Claude hook collection, native Windows/Linux execution, Safari/Firefox,
formal screen-reader usability/certification and participant comprehension studies
remain unverified. Five-second comprehension remains an expert heuristic.
No health heartbeat exists; timestamp gaps alone cannot certify collector health.
This handoff updates only the Tool Activity subsection of `DESIGN.md` and this
surface record, checks scope/whitespace/local links, and inspects retained evidence.
It performs no source edit, context/detector/QA rerun, git commit/push/merge or
publication; parent owns other documentation and PR work.
