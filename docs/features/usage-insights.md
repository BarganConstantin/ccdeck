# Usage insights — issue #2121

Issue: https://github.com/BarganConstantin/ccdeck/issues/2121

Usage now exposes **Quota history** and the existing **Cost history** report.
Quota history shows recorded remaining quota, the original capture age and a
window selector. The dashed even-use reference is a guide, not a forecast.
Observations stop at the last actual capture; gaps longer than ten minutes are
not joined. Recorded readings can be inspected as a table.

Successful existing Claude/Codex quota reads append history asynchronously.
Opening or refreshing history reads the local snapshot only: it does not call
providers, refresh OAuth or run the quota CLI. Duplicate captures, stale/failure
responses and invalid windows are not observations. Small reset timestamp jitter
is tolerated; actual reset episodes and providers remain separate.

Account identity is stored as an opaque SHA-256 key. Claude email and organization
identify its scope; Codex account ID/email identify its scope. History is displayed
only after a current reading identifies the active account. Changing accounts
cannot place the previous account's curve next to the new account's quota.
Unknown identity leaves the report empty. Emails and credentials are not written
to history.

The file is `quota-history.json` in `deckDataDir()` (`CCDECK_HOME` is honored),
written through the existing atomic writer. Retention is bounded to 35 days,
32 account/window/reset series, 2,048 observations per series and 16,384 total.
An input file over 2 MiB is rejected. Invalid persisted entries are discarded.
Storage errors preserve readings in memory and are disclosed in the report;
recording never fails the provider's quota request. Each running deck maintains
its own in-memory snapshot; this first version does not merge simultaneous
writers sharing the same data directory. The isolated preview uses its own home.

Session usage adds **Cached input reuse**. Both ccusage provider reports normalize
`inputTokens` to non-cached input. Reuse is therefore
`cacheReadTokens / (inputTokens + cacheReadTokens + cacheCreationTokens)`.
Output/reasoning do not enter the denominator. All three counters must be present,
finite and nonnegative for a record to be measured; the UI reports measured
coverage. Missing values are unavailable, a measured zero is 0%, and zero input
has no percentage. Claude coverage counts usage records; Codex coverage counts
model groups. Raw Codex `input_tokens`, which includes cached input, must not be
substituted for ccusage's normalized report.

Normalization reference: ccusage/ccusage,
`rust/adapters/codex/src/report.rs`, `non_cached_input_tokens`:
https://github.com/ccusage/ccusage/blob/main/rust/adapters/codex/src/report.rs

## Validation, 2026-10-13

- 266 targeted Vitest tests across 22 files passed: history retention/identity,
  duplicate/stale/invalid captures, storage failure, cache semantics, quota account
  switches, existing quota sources, route deadlines, modal focus/portals, guarded
  reads, usage history and pinned builds after self-update.
- TypeScript and production build passed.
- Isolated Brave QA at 1280, 390 and 320 px covered all nine themes, provider/window
  selection, readings disclosure, Cost history, Escape/focus restoration, empty,
  load error and storage-error states, and measured/zero/missing cache.
- Ten synchronous Refresh activations under a delayed history response produce
  one request and finish normally; the control retains focus.
- A separate live Brave check read actual Claude/Codex history from the updated
  backend and rendered both charts without page errors. Populated visual fixtures
  were browser intercepts only; synthetic observations were not saved to disk.

## Owner preview

Worktree: `/Users/constantin/Desktop/ccdeck-usage-insights`.
Branch: `feat/2121-usage-insights`, based on development `a467d552`.
Frontend: http://127.0.0.1:4525/ (Vite).
Backend: http://127.0.0.1:4526/.
Preview home: `/tmp/ccdeck-usage-insights-preview`; the installed app on 4317 remains
separate. Open Usage → Quota history; history begins with observed readings,
without reconstructing earlier provider quotas from tokens or costs.

The Playwright QA scripts and screenshots are local verification artifacts,
under `/tmp/ccdeck-character-browser/usage-insights-qa.cjs` and
`.impeccable/review/usage-insights/`. Windows execution was not required for this
web/server change; no RDP build was run. Predictive exhaustion alerts and request
latency/throughput remain outside this issue.
