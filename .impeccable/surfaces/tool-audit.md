# Tool activity explorer — built iteration three

Issue #2122. **Mode: Operate. World: established ccdeck instrument panel.**
Primary target: `src/web/components/ToolAuditModal.tsx`. Related ground truth:
`src/web/components/ToolAuditMap.tsx`, `src/web/tool-audit-map.ts`,
`src/web/components/ToolAuditInspector.tsx`, `src/web/styles/tool-audit.css`.
Entry wiring remains in `src/web/App.tsx` and `src/web/rail-items.tsx`.
Implemented source wins over this brief; later CSS overrides determine geometry.

## Direction contract and decision

[Iteration-three direction and QUALITY BAR](../../docs/features/tool-explorer-iteration-three.md)
compared scatter, advanced ranking and hybrid. The built choice is the hybrid:
a primary frequency × observed-interval SVG map, seven-metric exact rankings and
selection-linked detail. Phone Performance map/Operations views share state.
This replaces the v2 ranking-first composition while preserving the established
identity and [verified measurement contract](../../docs/features/tool-explorer-design.md).
The older audit's architecture recommendation is historical; its data limits remain
binding. No new identity, seed, generated image comp or tournament is claimed.
This documentation refresh is explicitly scoped to the Tool activity subsection
of DESIGN.md and this surface; global tokens and other sections are unchanged.

**THESIS:** reveal operation relationships, then inspect evidence.
**OWN-WORLD:** ccdeck theme surfaces, system UI and mono data typography, fine
SVG grids, blue operation points, reported-failure diamonds and native controls.
**STORY:** scope provider/period, locate a frequency/interval combination, select
from map or exact operations, inspect recorded evidence and return with context.
**FIRST VIEWPORT:** compact filters, call-wide summary and coverage disclosure;
primary axis-labelled map with legend. Exact rankings follow; selection reveals
an inspector. Phones switch between map and operations without resetting context.
**FORM:** hybrid, chosen from three concepts; code-led work in the existing world.
**FINISH:** built, reviewed and documented; scoped verdict below records the two
material corrections and the limits of the evidence.

**QUALITY BAR:** meaningful relationships, truthful axes, exact values, keyboard
selection, bounded point details, visible missing/P95 exclusions. No unsupported
thresholds, trends, additive time shares, isolated-command or provider-speed claims.

## Audience, history and measurement boundaries

One operator scopes device-wide Claude/Codex history to compare frequency,
cumulative intervals, median/tails and reported outcomes, then inspect sanitized
containing calls. Concrete operations stay distinct; variable arguments are grouped.
High frequency or a large interval is exploratory evidence, not a diagnosis.

- One call is a unique observed start identity paired with at most one outcome;
  replay/peer enrichment and duplicate start/end records are excluded.
- Operations are containing-call memberships, once per operation per containing
  call. Compound commands and wrappers can identify several operations; conditional
  branches and repetitions are not independently observed or proof of execution.
- Shared operations inherit the containing call's full interval/outcome. Operation
  totals are not additive. The call-wide cumulative summary counts each measured
  call once, but overlapping parallel/nested intervals are still not wall time.
- Claude uses hook receipt intervals; Codex uses rollout timestamps. Approval,
  delivery and orchestration waits can be included. Mixed provider clocks cannot
  establish a speed benchmark; filter Provider to inspect a single clock.
- Median is the midpoint, P95 the nearest-rank percentile with at least 20 valid
  timings, maximum the largest. Zero is measured; missing/negative/source-less
  timing stays unknown. Failure-rate ranking requires 20 completed outcomes;
  the inspector can show the raw small-sample rate with a qualification.
- Reported failure reflects observed containing-call outcomes, not exhaustive
  detection or proof each inner command failed. Claude supplies hook outcomes;
  Codex translation recognizes wrapper failure/nonzero leading exit status.
  Missing timing and unmatched outcomes do not imply failure; no error text is kept.
- Periods filter observed starts and count matched intervals in full, even if the
  outcome falls outside the range. Requested dates, retained start and observed
  endpoints differ; sparse endpoints do not prove continuous coverage.
- History is forward-only and device-local: new observed events, no old-session
  import or synchronization. General Settings owns 30/60/90-day retention, actual
  stored bytes and clear with inline destructive confirmation. Reports load on
  demand; custom UTC dates cover at most 90 calendar days inclusive.
- Detail retains only sanitized tool/operation, provider, timestamp, interval,
  outcome and shared flag: up to 20 slowest measured and 30 recent containing
  calls. No arguments, outputs, messages, error text, file contents or full traces.
  No bucket series, distribution, cost, latency score or bottleneck badge is inferred.

The iteration introduces no collector, aggregation or storage changes, chart
library, runtime dependency, font or global token. The bounded SVG map uses pure
axis/mapping helpers rather than a general pan/zoom engine.

## Built composition and interaction

- **Entry and shell:** independent SVG rail action next to Radio, More on phones;
  separate from Usage. Effective width `min(1180px, 96vw)`, max-height
  `min(860px, 94dvh)`, existing panel/radius/shadow. Header Refresh/Close remain
  reachable. There is no reserved inspector at rest. The outer body scrolls.
- **Hierarchy:** Provider, Period, operation search and optional custom dates;
  incomplete-history notice before three call-wide workload summaries; native
  Coverage & freshness disclosure. The summary exposes timed count and, outside
  the compact phone presentation, observed endpoints. Expansion gives exact
  requested dates, retained start, refresh time, unmatched and provider counts.
- **Axes and eligibility:** X is linear containing-call memberships, scoped to all
  dataset operations including unplotted ones. Y offers median or eligible P95.
  Auto chooses labelled `log(1 + ms)` when positive values span at least 100×;
  explicit Linear/Log are available, both retaining measured zero. Exact duration
  ticks, the nonadditive X label and legend explain the map. Missing medians or
  ineligible P95 stay outside it in a counted native disclosure with selectable
  operations and timed/call counts; they remain in exact operations.
- **Marks and clusters:** blue circles for operations; red diamonds encode reported
  failure by shape as well as color. Numbered clusters expose neighbour count,
  with a diamond flag when a member has a reported failure. Initial screen-space
  buckets are followed by rendered-footprint checks across cell boundaries.
  Intersections merge in nearest pairs, centroids are recomputed and checked again
  until footprints no longer intersect. This avoids a single transitive proximity
  chain swallowing a distribution. No jitter or synthesized combined metric:
  every exact member/value remains accessible in the bounded scrollable chooser.
- **Responsive geometry:** at ≥960px selection adds a 320px inspector with 20px
  gap, sticky at `top: 0`, independent scrolling, border-box sizing and max-height
  `min(700px, calc(94dvh - 300px))`. Below 960px detail follows the map. At ≤600px
  Performance map/Operations buttons switch the visible analytical region;
  Operations detail follows the selected row or results if search/limit hides it.
  The three-column phone summary and wrapping operation names avoid horizontal
  table scrolling. Normal SVG height is 310px, or 240px below 450px frame width;
  viewport height ≤650px uses 210/170px respectively. Height-aware spacing covers
  short desktop/tablet as well as phones; 800×600 retains both axes and legend in
  the first viewport. ResizeObserver recomputes map width and proximity groups.
- **Exact rankings:** one native Rank by select offers calls, cumulative interval,
  P95, reported failures, median, maximum and failure rate. Median/P95/maximum
  render dots on tracks; other metrics use bars, with exact mono/tabular values.
  Missing values show requirements, outcome metrics show denominators, shared
  calls retain their marker and accessible explanation. Active qualifiers remain
  visible; Metric definition reveals deeper context. Fifty initial rows and
  Show 50 more bound rendering. Reported failures use `--err`; row selection uses
  neutral control fill and an inset accent edge.
- **Scope and persistence:** provider/period replace report data. Search narrows
  exact rankings only, dims nonmatches on the full retained map and puts matching
  cluster members first; summary totals and axes keep provider/period scope.
  Rank by does not change the map's independent median/P95 or Y-scale controls.
  Selection survives rank/search/refresh and phone view changes while the operation
  exists, clearing when replacement data lacks it. Reset restores all providers,
  seven days, empty search, Calls rank and the row limit; it does not reset map
  metric/scale/view. Hover/focus links rows and map marks. Refresh guards prevent
  duplicate report/detail work.
- **Keyboard and focus:** SVG nodes are named buttons with tab stops. Arrows
  traverse rendered node order with wrap; Home/End reach first/last, not geometric
  neighbours. Enter/Space selects a single operation or opens a cluster and
  focuses its first exact member. Keyboard selection focuses the inspector heading;
  narrow selection scrolls it into view. Inspector closure first focuses modal
  Close, waits for resize/regrouping and restores a visible origin, row or
  containing map node where available, with a dialog-local Close fallback.
  Modal focus/dismissal handling keeps focus inside and Escape restores the invoker.
  Point details have a named Dismiss control; no separate tooltip Escape behaviour
  is claimed.
- **Inspector:** Activity & outcomes and Measured intervals group statistics;
  Definitions & coverage is native progressive disclosure. Slowest/Recent buttons
  select a separately fetched fresh snapshot, with loading, error and empty states.
  Shared/overlapping intervals, sample limits and provider clocks remain qualified.
- **States and accessibility:** real indeterminate loading, retry/error,
  incomplete, empty, search-zero, few/dense, unknown/zero and shared-data states.
  All nine themes, system/platform font fallbacks, native color scheme and named
  SVG controls remain. Coarse-pointer main controls/actions have 44px targets;
  reduced motion and keyboard opening skip entry animation. Forced colors preserve
  ranking tracks/selection and map marks. Values, outcomes and explanations remain
  readable without relying solely on color or bars. Placeholders use existing
  `--text-secondary` at opacity 1; comparison tracks use `--bg-soft`.

## Intentional local typography

This dense analytical surface uses 11/12px data, labels and context, 14px headers
and 18/20/24px workload metric steps. Existing supporting steps are 10px ranking
qualifiers, 13px exact values/inspector headings and compact map title, and 16px
secondary phone metrics. System UI describes controls; mono identifies operations,
ticks and exact values with tabular numbers. These are the actual CSS roles,
including responsive overrides, not a proposed global ramp.

The single detector run reported nine `design-system-font-size` **ADVISORY**
findings because literal local steps are outside global DESIGN.md typography;
there were no nonadvisory findings. The local intent is documented here and in the
Tool activity subsection, without changing global typography/tokens or claiming
the detector is clean.

## Finish disposition and existing evidence

Fresh reviewer **Harvey `01a134d0-8926-76e3-bfbc-450b17525d94`** returned a
full review with **FIX** for two material findings: adjacent cluster collisions
and clipped frequency-axis/legend composition in the 800×600 first viewport.
After the targeted fixes and final same-path recaptures, the follow-up returned
**VERDICT PASS — disposition SHIP**, with both material fixes resolved.
This verdict is scoped to those two fixes and the iteration-three contract;
it is not a new blanket polish audit, platform certification or permission to
merge/deploy. PR #2125 remains draft for owner review. No new polish hunt or test
rerun was performed for this documentation pass.

Existing final screenshots are in [the v3 review captures](../review/tool-explorer-v3/):
overviews at all six map sizes, actual live overview/detail, hover, selected,
median/P95/log, cumulative/failure ranks, provider/search, dense, few and missing
states. The `regression/` captures preserve the five-size/nine-theme checks;
v2 captures remain separate. Fixture screenshots are synthetic and do not write
collector history; live captures reflect observed Codex data.

Final logs read for this refresh:

- `/tmp/ccdeck-explorer-v3-tests.log`: **227 tests, eight suites passed**,
  including aggregation/pairing/sample rules, ten map-helper tests, cross-cell
  clustering/member retention, focus/portals/shortcuts and contrast.
- `/tmp/ccdeck-explorer-v3-typecheck.log` and
  `/tmp/ccdeck-explorer-v3-build.log`: passed; existing >500KB bundle warning remains.
- `/tmp/ccdeck-explorer-v3-map-final.log`: all six sizes passed — 1440×900,
  1280×950, 1024×768, 800×600, 390×844 and 320×568. Map QA covers axes/legend,
  hover/list linking, keyboard selection/member chooser, focus, refresh, search,
  provider qualification, median/P95, zero-safe log, exact ranks and dense/few/
  unmeasured data.
- `/tmp/ccdeck-explorer-v3-regression.log`: passed at 1280×950, 1024×768,
  390×844, 320×780 and 1280×540. Existing regression evidence covers all seven
  metrics, custom dates, filters/search, nine themes, refresh deduplication,
  partial/empty/error/loading and reduced-motion states.
- `/tmp/ccdeck-explorer-v3-a11y.log`: live nine-theme SVG text and placeholder
  contrast ≥4.5:1; SVG marks and ranking bars ≥3:1. Instant keyboard entry and
  selected-inspector preservation across 390/320/1024/1280px resizing pass.
- `/tmp/ccdeck-explorer-v3-live.log`: read-only actual Codex inspection passed
  with **1,158 calls, 1,157 measured, 101 operation identities**, including
  `git status` classification, sanitized detail and local storage settings; no
  page errors. These counts describe that final snapshot, not complete history.
- `/tmp/ccdeck-explorer-v3-detector.json`: one run, nine typography advisories,
  zero nonadvisory findings, as qualified above.

Reproducible QA runners `scripts/qa-tool-explorer-map.cjs`,
`scripts/qa-tool-explorer.cjs` and `scripts/qa-tool-explorer-a11y.cjs` use an
external Playwright harness without adding a runtime dependency. Brave browser
checks are targeted evidence, not accessibility certification. Native
Windows/Linux execution, Safari/Firefox, live Claude hook collection and
screen-reader usability remain unverified.
