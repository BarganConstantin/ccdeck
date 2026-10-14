# Account quota snapshots (#2104)

Current built behavior and handoff — 14 October 2026.

## Product behavior

Claude account snapshots are enabled by default. Settings → Account history can pause recording, show actual file size, clear snapshots with confirmation, and select 30/60/90-day retention (30 by default). Shortening retention warns before older readings are removed; retention still applies while paused. Removed accounts retain readings until pruning or clear.

Account capacity retains Accounts and Reset calendar and adds History. The built History view is a comparative studio: one visible 5-hour or 7-day plot, an adjacent account rail and a period selector. It defaults to All accounts, the 5-hour window and seven days; longer periods follow retention. The rail shows each account’s latest recorded usage percentage and observation time for the active window within the period, independently of the zoomed interval. Missing readings show a dash; removed accounts are labeled. These values do not claim current or fresh capacity. Clicking an account isolates it; clicking again or choosing All accounts restores comparison. Account colors remain consistent between windows.

Only one window is visible at a time; the shared absolute-time zoom survives switching between them. This reduces scrolling for comparison while requiring a window switch to inspect the other quota. No new dependencies or major product/brand changes were introduced, and the source collection, persistence, retention and usage business logic is unchanged.

## Inspection and navigation

The History dialog is up to 1240px wide, constrained to the viewport. The chart height follows the viewport (320–540px on desktop, 320px on narrow screens); its SVG coordinates follow the measured height. It displays **capacity used**, with 0% at the bottom and 100% (exhausted) at the top. Sidebar, header and tooltip values use the same reported usage measure. An immediate custom tooltip shows the account, actual observation time, usage percentage and reported reset or unknown reset. A crosshair and marker track the actual observation and dim other series; hover does not invent interpolated readings.

The secondary “Inspect recorded readings” details disclosure contains a labeled keyboard-accessible native observation selector. It lists actual readings within the visible interval, retaining percentage used, and keyboard selection tracks the same point and account highlight. Keys include account identity and timestamp; unavailable selections fall back to the latest visible reading. A disappeared account selection falls back to All accounts. “About these readings” preserves uncertainty in progressive disclosure. Dates use browser local time with timezone context.

The period is a maximum lookback, not forced chart width. The axis fits observations with 5% padding (at least 15 minutes per edge); a single reading is centered in a 30-minute view. Both windows share wheel zoom around the pointer, horizontal wheel pan, drag-to-pan while zoomed and double-click reset. Touch double-tap enters a bounded 2× zoom; horizontal drag pans and another double-tap resets, with vertical touch scrolling available. Keyboard chart controls are +/−, left/right and 0/Home; visible focus underlines the chart heading. The range is bounded to available history with a five-minute minimum, resets on account/period changes and is preserved/clamped on refresh. Outside-plot scrolling scrolls the dialog. Visible-range status and no-reading intervals are explicit.

The desktop account rail is 220px wide beside the plot. Below 700px it follows the plot in two columns, below 380px in one. Short dialogs scroll, and narrow/light states preserve the same task order. Loading, read errors with Retry, storage errors and empty/paused history retain explicit feedback.

## Sources and boundaries

The sampler reads claude-swap's `sequence.json` and schema-2 `cache/usage.json` passively once per minute while the backend runs. It never calls the provider, invokes a collector, signs in or touches credentials. Identity matching uses the existing `rowIsFor` guard, and a stable hash of email plus organization UUID names the history account. Slot reuse or account reordering must never transfer another account's readings.

New fresh observations are folded into fifteen-minute observation-time buckets, keeping the most recent point in a bucket. A changed reported reset window starts a separate point even in the same bucket. Raw claude-swap observation times are Unix seconds; the sampler reuses the roster's `observedMs` conversion to milliseconds before capture. Stored timestamps distinguish the original provider observation from the local save. Failed, future, missing or older-than-fifteen-minute observations are not new samples. Missing individual windows remain null, never zero.

A reported reset time is not a confirmed capacity renewal. Historical percentages remain measured values even after that time passes. Plot lines break across materially changed reset windows or more than thirty minutes between observations; missing individual windows also break their series. Reset timestamp precision differences up to one second relative to the segment’s first reset are tolerated without cumulative drift; stored timestamps are unchanged. Dashed markers denote reported reset timestamps. No estimate of token consumption is derived from percentage changes.

No samples are fabricated while the backend is stopped or after restart. New snapshots use available observations; this feature does not make inactive accounts collect more frequently. Existing cost/token Usage history and the active-provider quota history are separate and unchanged.

## Persistence and failure behavior

`account-usage-history.json` lives in ccdeck's platform data directory, beside its preferences. Writes reuse atomic temporary-file/fsync/rename machinery. One queue serializes capture, retention, reads and clear. A persisted clear cutoff prevents pre-clear observations from reappearing after restart. A failed save preserves the prior capture state and reports failure; corrupt or unsupported history is not silently overwritten. The file is limited to 32 MiB; storage errors must not fail live quota collection.

The history GET endpoint is a guarded private data read. The clear POST requires the existing mutation gate and explicit `confirm: true`. Snapshots store account labels and hashes, usage values and timestamps; never login tokens, credential payloads, transcripts or prompts.

## Verification and review evidence

The parent reports the latest completed checks:

- **68 tests / four files passed**: snapshot unit, passive integration, settings and axis coverage.
- **Typecheck and production build passed.**
- **Browser runner passed**: normal workflows, window switching, native CDP touch gestures, keyboard tracked marker, 12 accounts, empty/error/retry and short/narrow/light states.
- Reviewer’s initial two material findings—touch initialization and keyboard tracking—both scored **PASS after fixes**, at source/screenshot scope. The parent separately confirmed **native CDP touch runtime PASS**.

The browser runner (`scripts/verify-account-history.mjs`) mounts real components through `src/web/__tests__/fixtures/account-history-browser.tsx`, using controlled mocked APIs and synthetic accounts. No Playwright dependency was added. This establishes the tested interactions, not live-provider truth or whole-product certification. Native hardware touch, Safari and full screen-reader sessions remain unverified. This documentation pass did not run tests, a detector or another visual review, and does not imply a published release.

Capture directory: `.impeccable/review/2104/`. Current evidence: `desktop.png`, `hover.png`, `weekly.png`, `many-accounts.png`, `bottom.png`, `keyboard-inspection.png`, `mobile.png`, `narrow.png`, `light.png`. `before-redesign.png` captures the prior git HEAD at the same 1280×900 viewport. Direction and alternatives are recorded in `redesign-notes.md`; current surface guidance is `.impeccable/surfaces/account-usage-history.md`.

## Earlier iterations

The original surface stacked two charts with a top legend, native SVG-title inspection and primary observation selectors. Subsequent work added fitted time extents, reset-jitter tolerance, shared direct zoom and remaining-capacity orientation. The current comparative studio supersedes that composition, its 290px/240px chart sizing and its earlier unverified-touch status. Earlier test totals describe earlier scopes; the latest verification above is the current handoff evidence.

Owner refinement: widened History only, enlarged the responsive plot and restored usage-consumed orientation. Browser checks verify the wider desktop dialog, responsive bounds, 100% at the top and consistent tooltip/rail values; TypeScript and production build passed. Existing comparison, gestures and data logic remain intact.
