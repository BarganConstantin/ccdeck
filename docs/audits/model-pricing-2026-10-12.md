# Model pricing audit — 2026-10-12

Compared ccdeck development `4bb6eefa` with ccusage main
`11fa0056175332e69d7fdce37e66a744b1079b42`, including its models.dev snapshot.
Scope: Claude Code and Codex model recognition, API-equivalent token costs,
request tiers, cache TTLs, provider spellings and context-window defaults.
ccusage also covers other coding tools; its entire provider catalog is not a
list of models supported by Claude Code or Codex.

## Confirmed changes

| Model | Before | Correct behavior |
| --- | --- | --- |
| Haiku 5.5 | Unpriced; 200K context fallback | $0.10 input / $0.50 output, $0.01 cache read, $0.125 5m write / $0.20 1h write per million tokens; 1M context |
| Haiku 5.5 request over 100K prompt tokens | No request tier | 5x all five rates for that request, including output; input + cache reads + cache writes determines the threshold |
| Sonnet 5.5 cache read | $0.20/M | $0.10/M; Sonnet 5 stays $0.20/M |
| GPT-5.3 Chat latest | Unpriced; 400K fallback | Historical $1.75 input / $14 output / $0.175 cached input; 128K context |
| GPT-5.6 Luna/Terra/Cyber named siblings | Inherited base rates | Unknown siblings such as `-pro` stay unpriced until independently verified |

Haiku's tier is observed per request in both transcript readers and retained as
an optional subset of per-model usage. Streaming snapshots are refunded when a
final record replaces them, even when the tier changes. Copies, subagent bucket
merges, wire conversion, card tooltips and Projects totals preserve that subset.
Projects' ccusage calibration removes the day's tier premium before applying
its drift, so a short-request project does not inherit another project's premium.
Persisted Projects tally format advances from version 6 to 7 and rebuilds from
transcripts; the previous heartbeat still fences off downtime.

## Existing coverage and discrepancies

The current Fable/Mythos 5 and 5.1, Opus 4.5–4.8/5/5.5, Sonnet 4.5/4.6/5,
Haiku 3.5/4.5 and standard GPT-5/5.1/5.2/5.4/5.5/5.6 and GPT-6 families were
compared against the snapshot. Current GPT-6 Astra/Sol/Luna and GPT-6.1 Sol are
already covered. No new standard rate discrepancy was found in these families
apart from Sonnet 5.5 cache reads. Snapshot `gpt-5-codex` cache rate $0.13 is a
rounding difference from the authored $0.125, not a new model.

ccusage's models.dev fallback lists Opus 5.5 Fast at $9.60/$48 and Opus 4.8 Fast
at $12/$60. Anthropic's official pricing page still states $8/$40 and $10/$50.
Keep ccdeck's official rates; catalog disagreement alone does not justify a change.

`gpt-5.6-sol-pro` is in the fallback snapshot but not the official pricing page
or model list inspected. Keep it unpriced. Likewise, deprecated Daybreak aliases,
provider-specific spellings and rates, chat aliases outside the supported CLI
model families, and non-Claude/non-Codex tools are not copied wholesale.
Unknown future versions remain unpriced rather than inheriting a sibling's rate.

Aggregate usage from an older server has no request-tier evidence. Keep its
existing base-rate estimate; do not infer long context from cumulative tokens.
Codex's existing long-context limitation remains: its cumulative session total
cannot establish an individual request's pricing tier. Regional/data-residency
multipliers and negotiated provider prices remain outside the base API estimate.

## Primary sources

- [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [Anthropic model IDs and context limits](https://platform.claude.com/docs/en/models/overview)
- [Haiku 5.5](https://platform.claude.com/docs/en/models/haiku-5-5/overview)
- [OpenAI pricing](https://developers.openai.com/api/docs/pricing)
- [GPT-5.3 Chat](https://developers.openai.com/api/docs/models/gpt-5.3-chat-latest)
- [ccusage snapshot inspected](https://github.com/ccusage/ccusage/blob/11fa0056175332e69d7fdce37e66a744b1079b42/rust/crates/ccusage-core/src/models-dev-pricing.json)

## Validation

Regression tests cover the exact 100K boundary, cached input and cache writes in
the prompt, short/long mixtures, both streaming-tier transitions, incremental
scans, copies and merges, uncalibrated and calibrated Projects, provider IDs,
unknown model guards, unchanged Fast pricing, old tally rebuilds and existing
model-switch/TTL handling. All 379 tests across 17 relevant files passed on
Node 22. Typecheck and production build passed. Browser
QA uses synthetic Haiku usage in isolated light/dark contexts; it proves display
and tooltip behavior, not a live vendor billing reconciliation.
