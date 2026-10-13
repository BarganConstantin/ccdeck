# Tool Activity — simplicity-first redesign

Historical iteration. The current Direction A report and executed validation are
recorded in [tool-activity-report.md](tool-activity-report.md).

## Critique and architecture

The scatter-first view requires decoding identities, clusters, shapes, clock
qualifiers and scales before finding an operation. Two chart controls compete
with the ranking selector; the chart displaces immediately useful names/values.
The hybrid could reveal frequency/interval relationships but has no demonstrated
additional value for the owner's primary jobs and tested comprehension needs.

| Approach | First action | Comprehension | Technical depth |
| --- | --- | --- | --- |
| Scatter-first | Decode plot, hover identity, inspect | Requires axes/cluster/shape explanations | Many controls before exact evidence |
| Optional advanced scatter | Choose a navigation layer | Still introduces duplicated comparisons and maintenance | No proven primary-job advantage |
| Single visual ranking | Read name/value, choose one of four comparisons | Familiar ordered names with proportional bars | Existing contextual inspector |

Choose the single visual ranking. Remove the unused map, helper, tests and QA
runner rather than retaining an unproven advanced view. Preserve the local
collector/aggregation and existing detailed inspection.

## Direction contract — code-led established world

**THESIS:** familiar comparison first; technical explanations on demand.
**OWN-WORLD:** CCDeck instrument-panel surfaces/tokens, native filters, system
labels, monospace operation names and tabular values, restrained blue bars.
**STORY:** choose Most used / Most measured time / Slowest P95 / Reported failures,
read the ordered operations, select an identity for detailed evidence.
**FIRST VIEWPORT:** compact filters and three workload summaries, coverage
 disclosure, one four-mode control, top eight named operations with exact values.
**FORM:** simple ranking inside the incumbent modal, contextual side inspector
only after selection; inline inspection on narrow screens. No empty panel.
**FINISH:** unreviewed and undocumented is unfinished; this build ends with the
finish review, the verdict, and DESIGN.md.

**QUALITY BAR:** unfamiliar users can identify the first operation immediately;
metric switching changes one chart's order, bars, values and explanation. Zero
is measured; unknown is visibly unavailable. No chart legend, scale selector,
scatter symbols, decorative analytics or unsupported runtime/cost conclusions.

## Data contract

Counts are containing-call memberships, not independent executions and not
additive across operations. Operation intervals are shared containing-call
observations. Cumulative intervals may overlap and are not wall-clock time.
Claude receipt clocks differ from Codex rollout clocks. P95 requires 20 measured
samples; unsupported rows stay available with an explicit missing-sample label.
Failures are reported containing-call outcomes, not confirmed inner-command
failures. Search filters operations; provider/period scope call-wide summaries.
Inspector preserves median, P95, maximum, timing coverage, provider counts,
sanitized observations and full measurement definitions. No backend change.

## Rendered critique and refinement

Pass one replaced the primary scatter with a four-mode bar ranking and removed
its implementation. It restored eight named operations in the desktop viewport.
The first batched render showed that four mobile mode buttons consumed space
without adding understanding; the summary was also too tall at 320×568.

Pass two uses one native mobile Compare selector and shorter cumulative caption,
hides the redundant phone outcome denominator, removes unexplained shared-call
glyphs from rows, and puts View all beside the ranking heading. Coverage, freshness
and definitions now share one collapsed disclosure. Full definitions, shared-call
qualifiers and exact technical values remain in accessible descriptions/inspection.
No values or telemetry definitions were changed for spacing.

## Executed validation

- 217 tests in seven relevant suites pass: collector/aggregation/pairing,
  independent frequency/cumulative/P95/failure rankings, unavailable-versus-zero
  timing, sample floors, focus/portals/shortcuts and contrast.
- TypeScript and production build pass. Existing >500KB chunk warnings remain.
- Deterministic Brave QA passes at 1440×900, 1280×950, 1024×768, 800×600,
  390×844 and 320×568, including all nine themes, all four modes, exact bar
  proportions, unsupported P95 labels/empty bars, search, selection across modes,
  refresh, filters/custom dates, dense/sparse/unmeasured data and
  partial/no-failures/empty/error/loading/reduced-motion states.
- Live contrast checks across nine themes cover placeholders ≥4.5:1 and blue/
  reported-failure comparison fills ≥3:1. Keyboard entry and selected inspector
  preservation after 390/320/1024/1280px resizing pass.
- Live read-only Codex inspection passed at 1,287 observed/measured calls and 105
  operation identities in the final capture, including sanitized details and
  local history settings. Those counts describe that snapshot, not all history.
- The detector ran once: seven intentional local typography advisories, zero
  nonadvisory findings. No dependencies were added. No backend files changed.

Captured evidence is local under `.impeccable/review/tool-explorer-simple/`;
previous iteration evidence remains separate. `scripts/qa-tool-explorer.cjs`
and `scripts/qa-tool-explorer-a11y.cjs` use an external Playwright harness;
synthetic fixtures never enter the collector journal.

A five-second comprehension review is an expert heuristic, not a claim about
real participant research. Contrast/browser checks are not accessibility
certification. Native Windows/Linux, Safari/Firefox, live Claude capture and
screen-reader usability remain unverified. PR #2125 remains draft for owner
review; no merge, release or deployment.

## Independent finish gate

Arendt (`01a1350a-9ef0-7c52-9a3c-21f593f6f6a5`) inspected 22 required captures
individually and returned **SHIP** at the scoped simplicity/visual gate. It confirmed
eight named desktop operations versus two ranking rows below the former map.
The review identified a nonblocking mobile Reset row appearing on metric changes.
That row now depends only on changed filters; the same reviewer's verdict pass
scored the fix **RESOLVED / PASS** from replacement phone captures and browser
regressions. Documentation follows the final source, not the discarded scatter.
