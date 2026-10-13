# Visual Tool Activity — iteration three

Historical record. The scatter implementation was removed by the
[simplicity-first redesign](tool-explorer-simplicity.md); its verification below
describes that earlier iteration, not the current interface.

## Data and visual audit

The initial live snapshot has 939 unique Codex calls and 86 operations. Frequencies span
1–274; median observed intervals span 68–30,007.5ms. P95 is available for 26
operations, not all 86. The previous view ranks one dimension but hides relationships.
Operation counts are memberships; shared intervals and cumulative intervals overlap.
No new collector, provider distribution or trend data is needed or invented.

| Concept | Analytical value | Tradeoff |
| --- | --- | --- |
| Scatter | Reveals frequency versus median/P95 relationships | Cannot precisely navigate missing timings or coincident points alone |
| Advanced ranking | Exact frequency/cumulative bars and interval dots | Still hides relationships between frequency and intervals |
| Hybrid | Relationship map plus exact ranking and contextual detail | Needs compact controls and alternate phone views |

Choose the hybrid. Use a primary frequency/observed-interval SVG map, seven-metric
exact operation ranking and selection-linked inspector. On phones Map/Operations
views share state. Larger intervals are exploratory, not automatic diagnoses.

## Implementation contract

**THESIS:** reveal operation relationships, then inspect evidence; a bar list alone
cannot carry the experience.
**OWN-WORLD:** inherit CCDeck surfaces, system UI and mono data typography, fine
grids, blue operation points; reported failures also use a diamond shape.
**STORY:** locate an interesting frequency/interval combination, select it in the
map or list, inspect its recorded statistics without resetting context.
**FIRST VIEWPORT:** compact filters and workload summary; a primary, axis-labelled
performance map. Exact rankings follow it; selection reveals a desktop side
inspector. Phones can switch between map and exact operations.
**FORM:** hybrid, selected from three user-requested concepts in the established
world. Autonomous code-led brief; no new identity, seed or image comp.
**FINISH:** unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md.

**QUALITY BAR:** meaningful relationships, truthful axes, exact values, keyboard
selection, responsive tooltips, visible missing/P95 exclusions and no unsupported
thresholds, trends, additive time shares or provider-speed claims.

## Chart architecture and semantics

No direct chart library is installed. CCDeck already draws bounded SVG graphics;
React Flow's transitive d3 dependencies are not a stable charting API. A small SVG
component with pure tested axis/mapping helpers avoids a new runtime dependency.
It implements no general-purpose pan/zoom/chart engine.

X is containing-call memberships. Y is the existing median or eligible P95 of
containing-call intervals. Both-provider aggregates are explicitly qualified as
mixed clocks, never a provider benchmark. Use the Provider filter for a single
clock. Zero is plotted at zero; unknown and insufficient P95 are disclosed outside
the map and remain accessible in the list.

Linear X keeps frequency distances proportional. Auto Y chooses log1p(ms) only
when positive intervals span at least 100×; zero remains valid. The axis reports
the chosen scale, with exact duration ticks. Users can choose linear/log directly.
This is a readability decision, not a good/bad threshold. Points do not vary in
size by an unexplained metric. Nearby screen-space points can be grouped with
an explicit member count; the member chooser exposes exact metrics without jitter
or losing access to operations. No quadrants, trend line or time-share percentage.

## Critique and corrections

The first implementation replaced the repeated bars as the primary view with a
relationship map, retaining exact ranks and contextual detail. Rendered round one
exposed clipped phone charts and a tooltip escaping its frame. The correction
compacted short-screen controls, bounded tooltips and kept measured zero distinct.
Browser regression testing also found focus lost when inspector closure caused
SVG regrouping; restoration now waits for layout and has a dialog-local fallback.

The fresh finish reviewer identified two material visual fixes: neighbouring grid
clusters still collided in real data, and the 800×600 first viewport clipped the
frequency axis. A spatial index now merges intersecting rendered footprints in
nearest pairs, recomputing centroids until no intersections remain. Pairing avoids
collapsing an entire proximity chain into one badge. Exact member values are never
combined or discarded. Height-aware chart composition now extends to short desktop
and tablet viewports, retaining both axes and the legend.

## Executed validation

- 227 tests across eight relevant suites pass: aggregation, pairing/sample rules,
  chart mappings, cross-cell clustering, dense membership retention, focus,
  portals/shortcuts and contrast. Ten of those tests exercise the new map helpers.
- TypeScript, production build and whitespace checks pass. The existing >500KB
  chunk warning remains; no chart dependency or collector change was introduced.
- Deterministic Brave map QA passes at 1440×900, 1280×950, 1024×768, 800×600,
  390×844 and 320×568. It checks hover/list linking, keyboard selection/member
  chooser, inspector focus, refresh, provider qualification, search highlighting,
  median/P95, zero-safe log, exact ranks and sparse/dense/unmeasured datasets.
- Legacy regression passes at 1280×950, 1024×768, 390×844, 320×780 and 1280×540;
  all seven rankings, custom dates, filters/search, all nine themes, refresh burst
  deduplication, partial/empty/error/loading states and reduced motion remain covered.
- All nine themes pass live SVG text/placeholder contrast ≥4.5:1 and SVG marks/
  comparison fills ≥3:1. Keyboard entry and selected inspector resizing pass.
- Live read-only Codex verification passes with 1,158 calls, 1,157 measured and
  101 operation identities at the final capture. This is a changing local snapshot,
  not demonstration data or a claim about the user's complete history.
- Detector ran once on changed UI targets: nine advisory literal typography
  findings, no nonadvisory failures. Local existing metric/header steps are
  intentional and recorded by the scoped documenter.

Reproducible scripts: `scripts/qa-tool-explorer-map.cjs`,
`scripts/qa-tool-explorer.cjs`, `scripts/qa-tool-explorer-a11y.cjs` use an external
Playwright harness; fixtures never write collector history. Screenshots are local
under `.impeccable/review/tool-explorer-v3/`; v2 evidence is preserved separately.

These are targeted browser/contrast checks, not accessibility certification or a
screen-reader usability study. Native Windows/Linux, Safari/Firefox and a live
Claude hook stream remain unverified. Provider clocks remain incomparable; no
time series, isolated inner-command duration, trend, cost, or provider benchmark
is inferred. Historical coverage remains forward-only and device-local.

## Scoped finish verdict

Fresh reviewer Harvey (`01a134d0-8926-76e3-bfbc-450b17525d94`) inspected the
required rendered states and returned **fix** for neighbouring cluster collisions
and the clipped 800×600 axis. After the targeted batch and same-path recaptures,
the verdict pass returned **ship**, scoring both findings resolved. Documentation
is refreshed from the final implementation. This is approval of the scoped visual
fixes and contract, not platform certification or authorization to merge/deploy.
PR #2125 remains draft for owner review.
