# Tool activity explorer — iteration two

Issue #2122. **Mode: Operate. World: established ccdeck instrument panel.**
Targets: `src/web/components/ToolAuditModal.tsx`, `ToolAuditInspector.tsx` beside
it, `src/web/styles/tool-audit.css`; existing entry wiring in `src/web/App.tsx`
and `src/web/rail-items.tsx`. Implemented source wins over this brief.

## Pinned autonomous brief and decision

The precise autonomous request preserves the established world and evaluates two
composition options. [Current direction](../../docs/features/tool-explorer-iteration-two.md)
compares ranking-first expandable detail with an adaptive workspace: inline detail
is strong on phones but interrupts desktop comparison; the adaptive workspace
keeps full-width ranking at rest and opens a side inspector only on selection.
Chosen: adaptive ranking-first workspace, with rank-to-inspect as the signature.
This is code-led work in an established identity. No new identity, image comp,
seed, roll or tournament was produced or is claimed. Local documentation is
explicitly authorized; global YAML, tokens and identity remain unchanged, with
no sidecar required because no global truth changed.

## Direction contract (code-led, established world)

**THESIS:** compare first, inspect on demand; no empty inspector or report scaffolding.
**OWN-WORLD:** CCDeck theme surfaces, system UI typography, monospaced operation
identities and measured values, existing blue comparison bars and control geometry.
**STORY:** choose a provider/period, compare one metric, inspect an operation, return.
**FIRST VIEWPORT:** compact filters, three asymmetric summary metrics, one coverage
disclosure, one Rank by control; full-width aligned rows. A selected operation opens
a bounded side inspector on desktop or inline detail on narrow screens.
**FORM:** adaptive ranking-first workspace, chosen from the two user-requested
alternatives. Precise autonomous brief; no new identity, seed or generated comp.
**FINISH:** unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md.

**QUALITY BAR:** native developer-tool controls, every region earns its space;
frequency, cumulative intervals and P95 remain distinct. Exact values accompany
bars; unknown is different from zero. No wall-clock, cost or provider-speed claims.

## Audience, task and measurement boundaries

One operator scopes device-wide Claude/Codex history to compare frequency,
cumulative intervals, tails and reported outcomes, then inspect sanitized calls.
Concrete operations stay distinct while variable arguments are grouped. High
frequency alone does not imply poor performance.

[Measurement contract](../../docs/features/tool-explorer-design.md): operations
are containing-call memberships, not observed inner shell executions. Shared
operations inherit their containing call's full interval/outcome; operation totals
are not additive. Call-wide cumulative intervals count each measured call once
but still overlap parallel/nested work and are not wall time. Claude hook receipt
intervals and Codex rollout timestamps can include approval, delivery and
orchestration waits; provider filters do not establish a speed benchmark. Reported
failure is not exhaustive detection or proof every inner command failed. Zero is
measured; missing timing and unmatched outcome are not failure. P95 needs 20 timed
calls; failure-rate ranking needs 20 outcomes. Periods select observed starts and
count matched intervals in full. Requested dates, retained start and observed
endpoints are distinct; endpoints do not establish continuous coverage. No fake
trends, distributions, cost inference, latency scores or bottleneck badges.

New observed events only; no historical import or synchronization. General
Settings owns 30/60/90-day retention, actual bytes and clear with inline destructive
confirmation. Reports load on demand. Collectors, backend, aggregation and storage
semantics have no changes in this iteration; no dependencies, fonts or global tokens
are added.

## QUALITY_BAR — implemented ground truth

- **Entry and hierarchy:** independent SVG rail action next to Radio, More on
  phones. Header Refresh/Close remain reachable. Incomplete-history warning
  precedes the call-wide summary. Provider/period/search and custom dates scope
  the request; three workload summaries precede a compact native Coverage &
  freshness disclosure. Its summary shows observed endpoints and timed count;
  expansion gives exact requested range, retained start and refresh timestamp.
- **Geometry:** width `min(1080px, 96vw)`, max-height `min(820px, 92dvh)`.
  Full-width ranking at rest, no empty placeholder. At ≥960px, selected detail
  adds a 340px inspector, sticky at `top: 0`, with independent vertical scrolling,
  `box-sizing: border-box` and max-height
  `clamp(220px, calc(min(820px, 92dvh) - 380px), 480px)`. Ranking uses the outer
  body scroller. Below 960px detail is inline after its row, or below results
  when search/limit hides selection. At ≤600px summaries stay three compact
  columns and bars sit below names/values. Long names wrap; no horizontal table
  scroll. Short desktop heights reduce context spacing.
- **Ranking:** one native Rank by select owns all seven dimensions: calls,
  cumulative interval, P95, reported failures, median, maximum and failure rate.
  No duplicated titles, button stack or More metrics. Rows prioritize operation,
  relative bar and exact value without repeated visible calls/timing labels;
  retain sample requirements, outcome denominators and shared-call markers.
  Required context qualifies the active metric; native Metric definition reveals
  deeper explanation. Initially 50 rows; Show 50 more preserves bounded rendering.
- **Interaction:** provider/period replaces the dataset; selection survives sort,
  search and refresh while the operation exists, clearing if absent in replacement
  data. Search narrows operations while qualified summary totals keep provider/
  period scope. Keyboard row selection focuses the detail heading; inspector close
  returns focus to its row or modal Close. Escape restores the invoking rail/More
  control. Refresh guards prevent duplicate work.
- **Inspector:** Activity & outcomes groups containing/timed calls and reported
  failures/rate; Measured intervals groups cumulative/median/P95/maximum. Shared
  and overlapping interval limits remain visible; Definitions & coverage is native
  progressive disclosure. Separately fetched fresh detail exposes up to 20 slowest
  measured and 30 recent containing calls: only sanitized operation/tool, provider,
  timestamp, interval, outcome and shared flag, without arguments, outputs,
  messages, error text, file contents or full traces.
- **States and access:** inherit all nine themes, system/platform font fallbacks,
  native control color scheme and named SVG controls. Values and states remain
  intelligible without bars/color. Coarse pointers get 44px main controls/actions;
  reduced motion and keyboard opening skip entry animation. Forced colors preserve
  tracks/selection. Real indeterminate loading, empty, search-zero, retry/error,
  incomplete and shared-data states explain limits and next actions. Placeholder
  `--text-secondary` at opacity 1 and `--usage-blue` fills on `--bg-soft` tracks
  reuse existing tokens; floors are 4.5:1 for placeholders and 3:1 for fills/tracks.

## Finish disposition and executed evidence

Fresh independent finish reviewer **Singer
`01a134ad-05b0-7a40-9729-ae9f241b30e1`** returned all five review sections with
**disposition: SHIP**, no material fixes, after inspecting all 14 required final
screenshots in [the review captures](../review/tool-explorer-v2/). This is the full
scoped second-iteration gate, replacing the earlier iteration-one fix-scope
record. It confirmed nine complete desktop ranking rows versus six before,
despite the smaller modal. Owner review remains pending; no merge is authorized
or claimed.

Completed evidence read during this documentation pass (QA was not rerun):

- `/tmp/ccdeck-explorer-v2-tests.log`: 217 tests passed across seven suites,
  covering aggregation/timing/source pairing, rank/sample semantics, focus/portal/
  shortcuts and contrast. `/tmp/ccdeck-explorer-v2-typecheck.log` and
  `/tmp/ccdeck-explorer-v2-build.log`: passed; existing >500KB chunk warning remains.
- `/tmp/ccdeck-explorer-v2-browser-final.log`: final Brave fixture checks passed at
  1280×950, 1024×768, 390×844, 320×780 and 1280×540. Supplied browser QA covers all
  nine themes, all seven metrics, provider/custom-date/search, refresh, selection/
  focus, dense 210-operation lists and missing/zero/incomplete/empty/error/loading/
  reduced-motion states. Fixture captures are synthetic and not collector history.
- `/tmp/ccdeck-explorer-v2-a11y.log`: all nine themes pass placeholder ≥4.5:1
  (minimum about 6.98:1) and fill/track ≥3:1 (minimum about 5.93:1); instant keyboard
  entry and selected-inspector preservation across 390/320/1024/1280px resizing pass.
- `/tmp/ccdeck-explorer-v2-detector.json`: one detector run, empty findings (`[]`).
- `/tmp/ccdeck-explorer-v2-live.log`: actual Codex snapshot has 862 measured calls
  and 86 operation types; report, classification, sanitized detail and local storage
  settings passed without browser errors. These counts describe that snapshot.

QA runners `scripts/qa-tool-explorer.cjs` and
`scripts/qa-tool-explorer-a11y.cjs` use an external Playwright harness without a
runtime dependency. Native Windows/Linux execution and a live Claude hook stream
remain unverified. Contrast/browser checks are not accessibility certification;
the SHIP verdict does not certify those untested platforms or authorize merging.
