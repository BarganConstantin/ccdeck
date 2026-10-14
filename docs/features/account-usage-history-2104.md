# Account quota snapshots (#2104)

## Agreed product behavior

Claude account snapshots are enabled by default. Settings → Account history can pause recording, show the file's actual disk size, clear all snapshots with confirmation, and select 30, 60 or 90 days of retention (30 by default). Shortening retention explicitly warns before older readings are removed. Retention still applies while recording is paused. Removed accounts keep their historical readings until retention or an explicit clear removes them.

Account capacity retains Accounts and Reset calendar, and adds History. Choose an account and inspect its reported five-hour and seven-day usage separately. The initial period is seven days; longer periods follow configured retention. The observation selector provides keyboard-accessible timestamps and values. All dates use the browser's local timezone.

## Sources and boundaries

The sampler reads claude-swap's `sequence.json` and schema-2 `cache/usage.json` passively once per minute while the backend runs. It never calls the provider, invokes a collector, signs in or touches credentials. Identity matching uses the existing `rowIsFor` guard, and a stable hash of email plus organization UUID names the history account. Slot reuse or account reordering must never transfer another account's readings.

New fresh observations are folded into fifteen-minute observation-time buckets, keeping the most recent point in a bucket. A changed reported reset window starts a separate point even in the same bucket. Raw claude-swap observation times are Unix seconds; the sampler reuses the roster's `observedMs` conversion to milliseconds before capture. Stored timestamps distinguish the original provider observation from the local save. Failed, future, missing or older-than-fifteen-minute observations are not new samples. Missing individual windows remain null, never zero.

A reported reset time is not a confirmed capacity renewal. Historical percentages remain measured values even after that time passes. Plot lines break across changed reset windows or more than thirty minutes between observations; missing individual windows also break their series. Dashed markers denote reported reset timestamps. No estimate of token consumption is derived from percentage changes.

No samples are fabricated while the backend is stopped or after restart. New snapshots use available observations; this feature does not make inactive accounts collect more frequently. Existing cost/token Usage history and the active-provider quota history are separate and unchanged.

## Persistence and failure behavior

`account-usage-history.json` lives in ccdeck's platform data directory, beside its preferences. Writes reuse atomic temporary-file/fsync/rename machinery. One queue serializes capture, retention, reads and clear. A persisted clear cutoff prevents pre-clear observations from reappearing after restart. A failed save preserves the prior capture state and reports failure; corrupt or unsupported history is not silently overwritten. The file is limited to 32 MiB; storage errors must not fail live quota collection.

The history GET endpoint is a guarded private data read. The clear POST requires the existing mutation gate and explicit `confirm: true`. Snapshots store account labels and hashes, usage values and timestamps; never login tokens, credential payloads, transcripts or prompts.

## Verification

Automated tests cover identity, deduplication, partial/missing/stale observations, cycle changes, paused retention, removed accounts, clear/restart, corrupt files, actual file persistence, schema-2 passive reading, no fetch calls, protected route membership and clock-driven sampler shutdown. Existing calendar, capacity, preference-route and settings tests are included.

Optional browser runner: `scripts/verify-account-history.mjs`. Start Vite on port 4569 (`npm run dev:web -- --host 127.0.0.1 --port 4569 --strictPort`), then run the script with an existing Playwright installation. `CCDECK_BROWSER_MODULE` may name that installation's module URL; `PLAYWRIGHT_EXECUTABLE_PATH` optionally selects an existing browser. No Playwright dependency was added. `CCDECK_REVIEW_ORIGIN` and `CCDECK_SCREENSHOT_DIR` override the default local origin and screenshot destination.

The runner mounts real components through `src/web/__tests__/fixtures/account-history-browser.tsx`, using synthetic non-private observations and mocked APIs. It verifies account and period selection, both windows, removed/partial accounts, desktop/narrow/short bounds, dark/light themes, observation selection fallback after account/range changes, Escape/focus restoration, pause, retention confirmation, clear/cancel, empty state and failed-read retry/recovery. This is browser interaction evidence, not live provider verification.

Screenshots are under `.impeccable/review/2104/`: baseline-accounts, desktop, mobile, narrow, short, removed-account, settings and empty. Initial capture/test harness errors were corrected before the successful complete run. Real provider data, native Windows/Linux, Safari/Firefox and screen-reader sessions have not been verified by this work.

## Final evidence (14 October 2026)

- Targeted Vitest command (snapshot history/passive integration, preference route fields, settings surface, boot module graph, capacity reliability, reset calendar and active quota history): **141 tests / eight files passed**.
- `npm run typecheck`: **passed**.
- `npm run build`: **passed**, final build 6.52s. Existing large-chunk warning remains. The first build used a shared dependency directory missing codec tools; `npm ci --ignore-scripts` in this worktree resolved it without changing dependencies or lockfile.
- `node scripts/verify-account-history.mjs` with the available Playwright module/browser: **passed**, including dark/light captures, older-observation account/range fallback and controlled API failure/retry; no page errors.
- Impeccable detector ran once. Its 14px advisory conflicts with DESIGN.md's explicitly documented small-heading size; 14px is retained. The independent finish reviewer scored all four material fixes resolved: source timestamp units, control/guide edges, measurement typography and observation selection fallback. This was a scoped verdict pass, not whole-product certification.
- Screenshot capture timing and browser-runner sequencing defects were corrected before final successful runs.

**SHIP WITH FOLLOW-UPS**, at the tested scope. No live private account/provider operations were performed. Native platform, Safari/Firefox and full assistive-technology sessions remain unverified. Feature branch is separate from development/main; this report does not imply a published release.

## All-account comparison (owner refinement)

History now defaults to All accounts, overlaying each account on the same time axis in both windows. A shared legend names the accounts and matches line colors. Clicking a legend entry isolates that account; clicking it again or selecting All accounts restores the combined view. Colors name accounts, not quota health, and remain consistent between the two windows and single-account filtering. Observation keys include both account identity and timestamp, keeping simultaneous readings distinct.

Browser checks cover the default combined series, legend filtering/restoration, account and period changes, missing windows and narrow/light/short states. Historical snapshots, collection and retention are unchanged.

## Interactive chart inspection

The time axis fits available readings within the selected lookback. Short histories display local times; a single observation is centered with viewing padding. Subsecond precision changes in reported reset times do not split otherwise continuous lines, while missing readings and real cycle changes remain breaks.

Both windows share zoom and pan. Scroll inside a plot to zoom around the pointer, drag when zoomed to pan, and double-click to reset. Horizontal trackpad scrolling pans. Scrolling outside the plots still scrolls the modal. The plots are keyboard-focusable: +/− zoom, left/right arrows pan, and 0 or Home resets. The visible range is bounded to available history, has a five-minute minimum and resets on account/period changes. No chart dependency was added. Clipping preserves original data and the observation selector lists actual readings in the visible interval.

Latest checks: 32 focused Vitest tests passed, TypeScript passed, production build passed, and browser interaction checks passed (keyboard zoom/reset, synchronized axes, pan, wheel zoom, drag without text selection, double-click reset, account hover hit-testing and 290px plot height, plus existing workflows). Updated renders include `zoomed.png`. Independent scoped review found no material issue. Native touch and full screen-reader verification remain follow-ups.

Owner refinement: plots are 290px high (240px data area). Line hover identifies the account using SVG titles and a transparent 12px hit target; point hover retains exact observation details. The visible zoom toolbar was removed in favor of direct gestures and keyboard equivalents.

The vertical axis now shows **capacity remaining**, derived as 100 minus reported usage: full capacity is at the top and exhausted capacity is at the bottom. Observation controls retain the provider's usage-consumed values; point tooltips name both measures. This changes presentation only, not readings, freshness or renewal classification. Chart focus uses a heading underline for keyboard navigation instead of a rectangular frame. Browser assertions verify exhausted accounts at the bottom, axis labels, no outline and visible keyboard focus; TypeScript and build passed.
