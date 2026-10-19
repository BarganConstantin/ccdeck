# Cost report accuracy

ccdeck reads ccusage's unified daily/session JSON without adding recorded costs
on top of its totals. In ccusage 20.0.35+, `storedCost` identifies the portion of a
model's `cost` taken from the log. History and the model table show that portion
as **Recorded in logs**, and the remainder as **other reported cost**. Older
reports without provenance do not acquire an invented recorded/calculated split.
A log's stored cost is not evidence of an invoice.

`missingPricing: true` survives aggregation across days, including days with
nonzero cost for the same model. An entirely unpriced model says **not priced**;
a partly priced model and its history total carry **+** and an explanation.
Claude Code and Codex use the same report handling.

## Live Codex estimates

The existing bounded Codex enrichment read also folds cumulative token increases
by model and recorded `thread_settings_applied.thread_settings.service_tier`.
Standard/default, Fast/priority and Flex are recognized. A tier change applies
only to increases observed after it. Duplicate totals add nothing, a counter
reset clears the old split, and a skipped byte range clears tier evidence and
rebases on its first subsequent total. No unobserved usage is assigned the latest
tier. Unclassified tokens retain the existing standard-rate estimate.

The bounded scanner refreshes on watcher and hook activity, with its existing
2.5-second throttle. Refused reads stay queued behind one timer per session until
a read starts; activity supersedes older scans, and eviction/shutdown invalidates
them. Synthetic events preserve the watcher's log-writer election. Flat live
token events preserve the last snapshot's model/tier split;
an explicit empty snapshot or counter reset clears it. No extra process, full
transcript read, config-file parser or runtime dependency was added.

Fast (2x) and Flex (0.5x) estimates are supported for the GPT-6 Astra, GPT-6 Sol,
GPT-6.1 Sol and GPT-6 Luna families already present in the rate table. The source
is OpenAI's short-context pricing, checked 2026-10-19:
https://developers.openai.com/api/docs/pricing
Unknown model/tier combinations stay unpriced. Anthropic fast pricing is unchanged.
Tooltips state that recorded settings do not confirm the served tier. These are
API-equivalent estimates; they need not match a subscription invoice or ccusage's
fallback to the current Codex config for unmarked usage.

## Upstream feature withdrawn

The ccusage changelog mentions originator breakdowns, but that implementation
was reverted before the current release. ccusage 20.0.36 rejects `--by-source`
for both unified daily and Codex daily reports. ccdeck therefore does not send
that flag or offer an unavailable breakdown.

- Added: https://github.com/ccusage/ccusage/commit/34c697b214
- Reverted: https://github.com/ccusage/ccusage/commit/21c7f68571
- Stored costs: https://github.com/ccusage/ccusage/releases/tag/v20.0.35
- Compressed Codex histories: https://github.com/ccusage/ccusage/releases/tag/v20.0.33

Compressed histories remain supported by ccusage. ccdeck's separate Codex token
window reader requires Node 22.15+ for Zstandard decompression; its existing
terminal warning on older Node releases is unchanged.
