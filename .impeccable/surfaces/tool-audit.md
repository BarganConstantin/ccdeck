# Tool activity explorer

Issue #2122. **Mode: Operate. World: established ccdeck instrument panel.**
Targets: `src/web/components/ToolAuditModal.tsx`, `ToolAuditInspector.tsx` beside
it, `src/web/styles/tool-audit.css`, `src/web/App.tsx` and `src/web/rail-items.tsx`.
Source is authoritative over this record and the earlier table brief.

## Pinned autonomous brief and decision

The user explicitly authorized a substantial explorer redesign while preserving
the existing global ccdeck design, chose the established identity, and requested
three concepts evaluated independently with autonomous selection. Local component
documentation updates are approved; global identity replacement is not.
This is a precise-request, code-led exemption: the requested three-way audit
governs composition. No seed, roll, decision-page choice or approved image comp
was produced or is claimed. The contract below carries the visual and behavioral
ambition, with source ground truth winning over intention.

[The concept audit](../../docs/features/tool-explorer-design.md) weighs:

- **A — Overview + ranking:** quickest comparison of frequency, cumulative
  intervals and tails; progressive detail preserves technical metrics.
- **B — Analytics workspace:** advanced comparison, but adds navigation and
  dashboard implications unsupported by available timing/bucket data.
- **C — Operations table + inspector:** precise audit, but many columns recreate
  the narrow-screen scanning problem.

Chosen: **A with C's contextual inspector**, one ranked explorer with exact values
and relative bars. Signature interaction: **rank-to-inspect**, selecting an
operation without losing ranking context, then examining sanitized containing
calls. No duplicate chart/table view or competing provider benchmark.

## Direction contract

**THESIS:** Rank observed operations by frequency, cumulative interval or tails;
inspect the evidence without a wide numeric table.

**OWN-WORLD:** Inherit ccdeck's theme surfaces, tight chrome, SVG icons, monospace
names, tabular values and semantic status colors.

**STORY:** Scope device history, distinguish calls from memberships, inspect an
operation's intervals and reported outcomes.

**FIRST VIEWPORT:** Header actions; provider/period/search; incomplete warning
before summary; coverage and ranking controls; exact-value bars beside a 330px
desktop inspector. Select a row to inspect. Phones insert detail inline.

**FORM:** A, first of three independently audited concepts, with C's inspector.
Precise user brief; code-led. No seed key, roll or approved comp exists.

**FINISH:** unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md

## Audience, task and constraints

One operator inspects device-wide Claude/Codex activity on demand to find what is
frequent, accumulates intervals, has high tails or reports failures. Concrete
operations such as `git status` and `git commit` stay distinct; variable arguments
are grouped. High frequency alone does not mean poor performance.

Only new observed events are collected; no historical import or synchronization.
General Settings owns 30/60/90-day retention, actual storage bytes and clear with
inline destructive confirmation. Report computation/loading is on demand.
No new dependencies, fonts or CSS custom properties were introduced by this
component; existing theme tokens remain normative in `DESIGN.md`. No sidecar
change is required for this scoped documentation update.

## QUALITY_BAR

- **Entry and first read:** independent Tool activity SVG rail action next to
  Radio; More on phones, with no Usage header entry. Header Refresh/Close remain
  reachable. A dropped/corrupt/unwritable history notice precedes the summary so
  totals cannot look complete before their qualification is read.
- **Geometry and capacity:** width `min(1160px, 96vw)`, max-height
  `min(880px, 92dvh)`. At ≥960px, outer body scrolling carries the ranking beside
  a contextual 330px inspector, sticky at zero, with independent vertical scroll
  and max-height `calc(92dvh - 90px)`. Below 960px, detail follows its selected row
  in one body scroller; selection hidden by search/limit remains available below
  results. Long names wrap; no horizontal table scroll is needed.
- **Ranking:** Most called, Cumulative time, Slow tails · P95 and Reported failures
  are primary above phone widths. More metrics exposes Typical latency (median),
  Slowest single call (maximum) and Reported failure rate; at ≤600px Reported
  failures also moves to More, and primary labels shorten to Cumulative/P95 tails.
  Exact values accompany proportional bars. Unknown values are unavailable;
  P95 needs 20 measured calls, failure-rate ranking 20 completed outcomes. Render
  50 rows initially with Show 50 more.
- **Context and interaction:** provider/period filters replace the dataset;
  selection survives sort, search and refresh if the operation still exists, and
  clears when absent from the replacement dataset. Search changes ranking only,
  with overview totals explicitly retaining provider/period scope. Keyboard row
  selection focuses the detail heading; inspector close restores row focus or
  falls back to modal Close. Escape restores the invoking rail/More control.
- **Detail:** containing-call and measured counts, cumulative/median/P95/maximum
  intervals, reported failures/rate and provider membership; up to 20 slowest and
  30 recent sanitized calls in a separately fetched fresh detail snapshot. Retain
  only operation/tool, provider, timestamp, interval, outcome and shared flag;
  no arguments, outputs, messages, error text, file contents or full traces.
- **Data honesty:** operation counts are containing-call memberships, not inner
  shell executions. Shared operations inherit the containing interval/outcome;
  do not sum operation totals. Call-wide totals count each measured call once
  but still overlap parallel/nested calls and are not wall time. Claude receipt
  intervals and Codex rollout timestamps have different clocks and can include
  approval/delivery/orchestration waits; provider filters do not establish a
  benchmark. Reported failure is not exhaustive error detection. Zero is measured;
  unknown timing/no outcome is not failure. Requested dates, retained start and
  observed endpoints stay distinct; endpoints do not prove continuous coverage.
  Periods select starts and count matched intervals in full. No fake trends,
  distributions, cost inference, latency scores or bottleneck badges.
- **Finish and accessibility:** all nine themes, theme fonts/platform fallbacks,
  native control color scheme and status colors are inherited. SVG glyphs carry
  accessible names; values/states remain intelligible without bars/color. Coarse
  pointers get 44px controls/actions; reduced motion and keyboard opening skip
  entry animation. Loading is real indeterminate work; empty, search-zero,
  error/retry, incomplete and shared-data states explain limits and next actions.
  Forced colors preserve tracks/selection. Desktop, phone, laptop and short-height
  layouts keep controls, results and detail usable.
- **Local contrast roles:** toolbar input placeholders use `--text-secondary`
  with `opacity: 1`; ranking tracks use `--bg-soft` behind `--usage-blue` fills.
  Readable text/placeholders must clear 4.5:1 and fills against tracks 3:1 in all
  nine themes. These local assignments add no tokens or global identity changes.

## Review disposition and verification handoff

The same finish reviewer scored **all three fixes resolved**, disposition
**ship at fix scope**. This verdict scores the following fixes; it is not a fresh
whole-surface gate and does not certify the subsequent contrast corrections:

1. Move the incomplete-history warning upfront: landed in source before the
   call-wide summary, confirmed in source and the latest supplied QA.
2. Persist the current layout: recorded in `DESIGN.md` and this brief.
3. Persist the direction contract: recorded above with the precise-request and
   code-led exemption, without fabricated seed/roll/comp provenance.

Supplied latest QA passed **217 tests**, all nine themes at desktop **1280×950**
and mobile **320×780**, plus **1024×768**, **390×844** and **1280×540**, including
the warning before the overview, provider/custom-date filters, Reset, refresh
bursts and 210 operations. Latest supplied strict readable-text checks passed
4.5:1 across all nine themes. Typecheck passed; the main thread verified the
final post-contrast production build (4.58s), with the existing bundle-size warning.

Additional live accessibility/resize QA found a Dark placeholder at 3.98:1 and
fill/line-track contrast at 2.21:1 in Black Contrast and 1.54:1 in White Contrast.
The local roles above correct those defects without other layout changes.
The completed `/tmp/ccdeck-explorer-a11y.log`, read during this documentation pass,
reports all nine themes passing: minimum placeholder contrast approximately
6.98:1 and minimum fill/track contrast approximately 5.93:1. It also passes instant keyboard entry and
selected-inspector preservation through 390/320/1024/1280px resizing.

Manual runners are `scripts/qa-tool-explorer.cjs` (isolated fixtures) and
`scripts/qa-tool-explorer-a11y.cjs` (live, read-only). They use an external
Playwright test-harness environment, adding no runtime dependency. This inline
documentation pass inspected source and the completed log; it did not rerun QA.
Native Windows/Linux execution and real Claude capture remain unverified.
