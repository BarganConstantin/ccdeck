# Tool activity explorer — built simple ranking

Issue #2122. **Mode: Operate. World: established ccdeck instrument panel.**
Primary target: `src/web/components/ToolAuditModal.tsx`. Related ground truth:
`src/web/components/ToolAuditInspector.tsx`, `src/web/styles/tool-audit.css`,
`src/web/tool-audit.ts`. Entry wiring is in `src/web/App.tsx` and
`src/web/rail-items.tsx`. Implemented source wins; later CSS overrides determine
responsive geometry.

## Direction and quality bar

The [simplicity contract](../../docs/features/tool-explorer-simplicity.md) chooses
one visual ranking over scatter-first and optional advanced scatter. Exact
identities and values answer the operator's primary questions immediately;
technical evidence remains in the contextual inspector. The v3 hybrid displaced
useful rows with axes, clusters and competing controls without demonstrated
additional value for these jobs. Its [historical record](../../docs/features/tool-explorer-iteration-three.md)
is explicitly superseded. The [verified data audit](../../docs/features/tool-explorer-design.md)
remains the measurement authority; its older architecture and verification plan
are not claims about current implementation or executed checks.

**THESIS:** familiar comparison first; technical explanations on demand.
**OWN-WORLD:** existing ccdeck surfaces/tokens, native filters, system labels,
monospace operation names, tabular values and restrained blue comparison bars.
**STORY:** choose Most used / Most measured time / Slowest P95 / Reported failures,
read ordered identities and values, select an operation for recorded evidence.
**FIRST VIEWPORT:** compact filters, three workload summaries, collapsed coverage,
one comparison control and top eight named operations; no empty inspector.
**FORM:** ranking within the incumbent modal; side detail on wide screens and
inline detail below the selected row on narrow screens.
**FINISH:** built and independently reviewed at the scoped simplicity/visual gate;
final source and existing validation are recorded below.

**QUALITY BAR:** identify the leading operation without decoding a chart. Mode
switching changes one ranking's order, bars, values and explanation. Zero is
measured; unknown remains unavailable. No legend, scale selector, scatter marks,
decorative analytics or unsupported runtime/cost diagnosis. A five-second
comprehension review is an expert heuristic, not real participant research.

## Built composition and interaction

- **Entry and shell:** independent rail action next to Radio, More on phones,
  separate from Usage. Width `min(1040px, 96vw)` and max-height
  `min(800px, 92dvh)` inherit panel/radius/shadow. Header Refresh/Close stay
  reachable and the body scrolls. No inspector column exists until selection.
- **Hierarchy:** Provider, Period, operation search and optional custom UTC dates;
  incomplete-history notice; Observed tool calls, Cumulative intervals and
  Reported failures. These three summaries retain provider/period scope during
  search. Coverage & definitions is collapsed by default and includes requested
  dates, retained start, observed endpoints, refresh timestamp, provider counts,
  unmatched outcomes and measurement definitions. Timed count stays visible.
  Active comparison qualifiers remain beside the ranking; Metric definition
  separately reveals that metric's explanation.
- **Single ranking:** one desktop button group offers exactly Most used, Most
  measured time, Slowest P95 and Reported failures. At ≤600px one native Compare
  select replaces it. Each mode updates order, exact values and linear bars in
  the same list. Bars scale to the largest eligible value across searched rows,
  including undisplayed rows; unknown has no fill. Existing `--usage-blue` fills
  comparisons and `--err` fills reported failures. Names wrap and values use
  mono/tabular numbers. No repeated count units, unexplained shared-call glyphs,
  interval dots or legend. Shared context remains in accessible descriptions and
  detail. The scatter component/helper/map tests/map QA runner are deleted; no
  advanced map remains.
- **Bounded overview:** eight initial rows. View all beside Operations opens the
  first 50; Show 50 more adds 50; Top 8 restores the overview. Changing mode or
  search returns to eight. Unavailable timings show Not measured; P95 below 20
  timings shows `n / 20 timed`, never a fabricated zero. Exact measured zero
  remains zero. Ties sort by operation name.
- **Responsive geometry:** at ≥960px selection adds a 320px inspector and 24px
  gap. It is sticky at `top: 0`, independently scrollable, border-box sized and
  bounded by `max-height: clamp(220px, calc(min(820px, 92dvh) - 380px), 480px)`.
  This actual CSS bound differs from the modal's 800px maximum. Below 960px
  detail follows its selected row or the results when search/limit hides it.
  At ≤600px bars move below the name/value line, summaries stay three compact
  columns, visible filter captions recede while accessible labels remain, and
  only the phone summary hides the outcome denominator. Observed endpoints are
  available inside disclosure. Height ≤650px compacts toolbar/summary/ranking
  spacing at ≥960px; final 800×600 and phone captures document the other short
  layouts. There are no map heights, axes or mobile map/operations views.
- **State and persistence:** provider/period replace the report; search only
  narrows operations. Selection survives mode/search/refresh while its identity
  remains in report data, clearing when replacement data lacks it. Reset appears
  only for changed provider, period or search; metric changes alone leave it
  hidden. Clicking Reset restores all providers, seven days, empty search,
  Most used and eight rows. Refresh guards avoid duplicate report/detail work.
- **Focus and inspection:** row buttons expose selection and exact accessible
  value/context. Keyboard selection focuses the inspector heading; narrow
  selection scrolls detail into view. Closing restores the connected originating
  button, matching visible row or modal Close fallback. Modal focus stays inside;
  Escape restores the invoker. Activity & outcomes and Measured intervals retain
  median/P95/maximum/raw failure rate, provider and timing coverage. Definitions &
  coverage stays collapsed. Slowest calls/Recent calls show up to 20 measured or
  30 recent sanitized observations from a separately fetched fresh snapshot,
  with loading, error and empty states.
- **Access and resilience:** all nine themes, native color scheme and existing
  system/mono fonts remain. Main actions/controls have 44px coarse-pointer targets;
  forced colors preserve tracks and selection. Keyboard opening and reduced
  motion skip the 200ms entry animation. Loading is indeterminate. Incomplete,
  empty/search-zero, few/dense, unknown/zero, no-failures and error states use
  truthful text rather than invented values.

## Measurement and privacy boundaries

One operator compares device-wide Claude/Codex observations, not independently
benchmarked commands. A call is a unique observed start paired with at most one
outcome; replay/peer enrichment and duplicate records are excluded. Operations
are memberships once per containing call. Compound commands/wrappers may identify
several operations; conditional branches and repetitions are not independently
observed proof of execution.

Shared operations inherit the full containing-call interval/outcome, so operation
totals are not additive. The call-wide cumulative summary counts each measured
call once, but parallel/nested intervals overlap and are not wall-clock time.
Claude uses hook receipt intervals; Codex uses rollout timestamps. Approval,
delivery and orchestration waits may be included. Mixed clocks cannot establish
provider speed; Provider isolates the observation source.

Median is the midpoint, P95 the nearest-rank percentile requiring ≥20 valid
timings, and maximum the largest. Measured zero is valid; missing, negative or
source-less timing stays unknown. Failure counts describe reported containing-call
outcomes, not exhaustive error detection or proof each inner command failed.
Claude supplies hook outcomes; Codex recognizes specific wrapper failure/nonzero
leading exit-status markers. Missing timing/unmatched outcomes do not imply
failure. Inspector raw failure rate uses completed outcomes and qualifies small
samples; failure rate, median and maximum are not additional comparison modes.

Periods filter observed starts and count matched intervals in full, including
outcomes outside the range. Requested dates, retained start and observed endpoints
are distinct; sparse endpoints do not establish continuous coverage. History is
forward-only and device-local, without old-session import or synchronization.
General Settings owns 30/60/90-day retention, actual stored bytes and clear with
inline destructive confirmation. Custom UTC dates cover at most 90 calendar days
inclusive; reports load on demand.

Detail retains only sanitized tool/operation, provider, timestamp, interval,
outcome and shared flag. Arguments, outputs, messages, error text, file contents
and full traces are not retained. No trends, distribution, cost, latency score or
bottleneck badge is inferred. Collectors, backend aggregation/storage, dependencies
and global tokens were unchanged by this redesign.

## Local typography and verified finish

Intentional local roles are 11/12px data, labels and context; 13px exact values
and inspector/ranking headings; 14px modal headers; 16px phone secondary metrics;
18/24px desktop/primary workload metrics; 10px small qualifiers/result counts.
These are actual CSS roles, not a new global ramp. The detector ran once and
reported seven typography **ADVISORY** findings, zero nonadvisory findings.

Independent reviewer **Arendt `01a1350a-9ef0-7c52-9a3c-21f593f6f6a5`** read 22
individual captures and returned full **SHIP** at the scoped simplicity/visual
gate, with no blockers. It confirmed eight named desktop operations versus two
ranking rows below the former map. A nonblocking mobile Reset row appeared on
metric changes. The one-line filter-only visibility fix was followed by fresh
phone captures of the same four modes and browser regressions; the same reviewer's
scoped follow-up returned **VERDICT RESOLVED / PASS**. This is not platform or
accessibility certification, participant research or merge/deploy authorization.
PR #2125 remains draft for owner review.

Existing final evidence, read for this documentation refresh:

- `/tmp/ccdeck-tool-simple-tests.log`: **217 tests in seven suites passed**,
  including aggregation/pairing, four independent rankings, unknown/zero timing,
  sample floors, focus/portals/shortcuts and contrast.
- `/tmp/ccdeck-tool-simple-typecheck.log` and
  `/tmp/ccdeck-tool-simple-build.log`: passed; the existing >500KB chunk warning
  remains.
- `/tmp/ccdeck-tool-simple-browser-final.log`: six sizes passed — 1440×900,
  1280×950, 1024×768, 800×600, 390×844 and 320×568. The runner covers four modes,
  paging, dense/few/missing data, exact 17.25% relative-bar fixture, unknown P95
  and its 20-sample floor, selection across modes/refresh, filters/custom dates,
  search, empty/partial/error/loading/no-failures, reduced motion and focus.
  Nine-theme fixture checks at 1280×950 and 320×568 include visible text ≥4.5:1;
  the six-size/nine-theme evidence is not a claim of every theme at every size.
- `/tmp/ccdeck-tool-simple-a11y.log`: actual nonzero blue **and red** fills ≥3:1
  and placeholders ≥4.5:1 across all nine themes. Instant keyboard entry and
  selected-inspector preservation after 390/320/1024/1280px resizing passed.
- `/tmp/ccdeck-tool-simple-live.log`: read-only actual Codex inspection passed
  with **1,287 observed/measured calls and 105 operation identities**, sanitized
  detail, operation classification and local storage settings; no page errors.
  These counts describe that snapshot, not complete history.
- `/tmp/ccdeck-tool-simple-detector.json`: the single run's seven intentional
  typography advisories and zero nonadvisory findings, as qualified above.

[Final captures](../review/tool-explorer-simple/) include `final-W-H`, cumulative,
P95, failures, selected `final-detail`, dense/few/missing and live overview/detail.
Fixture screenshots are synthetic and never enter collector history. The existing
`scripts/qa-tool-explorer.cjs` and `scripts/qa-tool-explorer-a11y.cjs` use an
external Playwright harness without a runtime dependency. Earlier captures remain
historical evidence, not current behavior.

Native Windows/Linux execution, Safari/Firefox, live Claude hook collection and
screen-reader usability remain unverified. This pass updates only this brief and
DESIGN.md's Tool activity subsection; it runs a whitespace check, without rerunning
QA, changing implementation or merging/deploying.
