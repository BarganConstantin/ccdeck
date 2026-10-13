# Tool activity explorer — data and UX audit

## Measurement contract

- One call is one unique observed start identity (device/generation/provider/session/tool-use ID), paired with at most one outcome. Replay/peer enrichment are excluded and duplicate start/end records are discarded.
- Operation counts are **call memberships**, not shell execution counts. A compound shell command or Codex `exec` wrapper can identify several distinct operations in one call. Each operation appears once per containing call, even if repeated. Conditional branches and inner repetitions are not independently observed.
- Live baseline on 2026-10-13: 480 calls, 64 operations, 1,344 operation memberships, zero duplicate records. This difference follows from shared calls; it is not evidence of duplicate aggregation. Screenshot values are illustrative and were not used as telemetry fixtures.
- Shared timing assigns the containing call's complete interval to each identified operation. Summing operation totals double-counts these intervals. A call-wide summary must sum each measured call once; even this cumulative interval total overlaps parallel/nested calls and is not wall-clock execution time.
- Period filters use observed start receipt times. A matched completed interval is counted in full, including an outcome outside the chosen range.
- Median is the midpoint of valid completed intervals; P95 is nearest-rank percentile, available with at least20 samples; maximum is the largest recorded interval. Zero is measured; missing/negative/source-less timing stays unknown. High frequency alone is not poor performance.
- Failure counts come from `PostToolUseFailure`. Claude provides a hook outcome. Codex translation recognizes wrapper `Script failed` or a nonzero leading `Exit code`; otherwise it reports success. Consequently this is **reported failure**, not exhaustive command-error analysis. A failed containing call is attributed to every member operation, not proof that each command failed. No error text is retained.
- Claude uses received hook intervals; Codex uses rollout source timestamps. Both can include waits, delivery and orchestration. Provider call membership is trustworthy; cross-provider latency is not an equivalent execution benchmark. Use provider filters to inspect rather than label a provider faster.
- Collection started with this feature, not seven days ago. The old `since` value clamped the requested period to collection start. Expose requested period, known recording start/retention boundary and earliest/latest observed matching starts separately; sparse observed endpoints never prove continuous coverage.
- Individual detail retains only sanitized tool/operation, provider, timestamp, interval, outcome and shared flag:20 slowest and30 recent containing calls. No arguments, outputs, messages, file contents or full traces are retained.
- Journal timestamps could support future time buckets, but current API offers no reliable bucket series. Do not fabricate trends/distributions. Unclassified rows mean dynamic/control-flow syntax, absent inputs or unsupported wrappers; they do not imply failure.

## Bounded UX critique

1. Numeric-only columns obscure the three distinct questions: frequency, cumulative interval time and tail latency.
2. Requested dates and observed coverage are conflated; shared totals/errors can look additive.
3. Vertically stacked filters consume working space and detail selection below the table loses context.
4. Wide columns force horizontal scrolling before explaining which operation deserves inspection.
5. Tool analysis belongs in its own rail entry next to Radio, independent of quota/cost Usage.

## Three architectures

| Concept | Strength | Cost / fit |
| --- | --- | --- |
| A. Overview + ranking | Fastest frequency/time/tail comparison, compact horizontal bars with exact values | Needs progressive detail to preserve technical metrics |
| B. Analytics workspace | Strong advanced filtering and comparison | Adds navigation and dashboards unsupported by bucketed/provider-compatible timings |
| C. Operations table + inspector | Dense audit, efficient exact comparisons | Many columns and narrow screens recreate the existing scanning problem |

Select **A with C's contextual inspector**: one ranked operation explorer, not redundant chart/table views. A small call-wide summary, compact provider/period toolbar, separate search and metric controls, exact values plus bars, and an adjacent desktop inspector (inline on narrow screens). All metrics remain accessible in the inspector. Selection survives sort/search/refresh when the operation still exists; filters replace the dataset and discard an absent selection. P95 and qualified reported failure-rate ranking disclose sample requirements (20 measured /20 completed outcomes). No cost inference, latency score, bottleneck badge, fake trend, or competing provider benchmark.

## Verification plan

Deterministic collector and display checks cover shared memberships vs unique summaries, requested/observed bounds, overlaps, missing/zero values, P95/rate eligibility, provider attribution and stable sorting. Render a few/dense/long-name datasets, high-frequency fast vs rare slow, high cumulative with low median, high tails, failures/no failures, incomplete data, empty/search-zero, provider filters and refresh selection. Inspect desktop/laptop/390/320 and short height, all themes, keyboard focus/restore and reduced motion. Two meaningful critique/fix rounds, bounded; report native OS execution separately from browser evidence.
