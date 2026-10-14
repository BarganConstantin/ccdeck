# Account usage history

Current built surface — 2026-10-14, #2104. **Mode: Operate.** History is a comparative studio inside the existing Account capacity dialog, alongside Accounts and Reset calendar. It inherits ccdeck’s visual system; no new dependencies or major product/brand changes were introduced.

## Direction and hierarchy

“Capacity over time” and Period lead into recording/retention context, one large plot with a 5-hour/7-day window switch, and an adjacent account rail. All accounts is the default; the initial period is seven days, with 30/60/90-day choices bounded by retention. The tradeoff is deliberate: only one window is visible at a time, while both retain the same absolute-time zoom range when switching.

The account rail combines identity, series color, latest recorded remaining capacity and observation time for the active window within the selected period. These values are recorded observations, never a claim of fresh or current capacity; they need not fall inside the zoomed interval. Unknown readings show a dash. Removed accounts remain selectable and labeled. Clicking a rail entry isolates its account; clicking again or choosing All accounts restores comparison. Colors identify accounts, not quota health.

Direct inspection is primary. An immediate custom tooltip identifies the account, actual observation timestamp, remaining percentage and reported reset/unknown reset. A crosshair and point marker track the observation and other account series dim. The tooltip chooses actual observations rather than interpolated values. “Inspect recorded readings” is a secondary details disclosure with a labeled native selector; keyboard selection also tracks the point and highlights its account. Observation identity includes account and timestamp; unavailable selections fall back to the latest visible reading, and missing account selections return to All accounts. “About these readings” consolidates measurement caveats.

## Plot interaction and measurement truth

The SVG is 360px high, with a 310px vertical data range. Capacity remaining is 100 minus recorded usage: 100% at the top, zero at the bottom. The inspector retains reported percentage used. Dashed reset markers describe reported times, never confirmed renewal or token consumption. Local dates carry timezone context. Missing windows remain unknown; lines break across missing readings, gaps exceeding 30 minutes and materially changed reset windows. Subsecond reset precision is tolerated up to one second relative to the segment’s first reset, without cumulative drift or changed stored timestamps. Rounded joins do not interpolate new readings.

The selected period is a maximum lookback; the time extent fits available observations with 5% padding, at least 15 minutes per edge. A single observation is centered in a 30-minute view. Both windows share zoom: wheel zooms around the pointer, horizontal wheel pans, drag pans when zoomed, and double-click resets. Touch double-tap enters a bounded 2× zoom; horizontal drag pans while zoomed and another double-tap resets. Vertical touch scrolling remains available. The focusable chart supports +/− zoom, left/right pan and 0/Home reset; keyboard focus underlines its heading. Zoom stays within available history with a five-minute minimum. Account/period changes reset it; refresh preserves and clamps the chosen absolute range. Scrolling outside the plot scrolls the dialog. Clipping and inspection preserve actual observations; visible-range status and empty intervals are explicit.

## Visual and responsive rules

The desktop studio uses a flexible plot column and a 220px account rail separated by a quiet divider. Below 700px the rail follows the chart with two account columns; below 380px it becomes one column. Workspace padding reduces to 12px below 600px. The chart retains its height, and short dialogs scroll. Light and dark share the hierarchy.

Use incumbent panel/background/text tokens. Controls use `--ctl-edge`; guides and dividers use `--line`. Measurements use `--font-mono` with tabular numerals. The workspace heading is 18px, chart headings 14px, and supporting text stays subordinate. Selected window and account controls use the existing soft background and control edge; selectors, disclosure summaries and buttons have visible keyboard focus. No new global design rules are established here.

## Settings and unchanged business logic

Settings → Account history controls snapshots (enabled by default), 30/60/90-day retention (30 by default), actual disk bytes and Clear history. Shortening retention and clearing require confirmation with Cancel. Pausing preserves history while retention pruning continues; removed-account history lasts until pruning or clear.

Collection passively reuses fresh existing observations in 15-minute observation-time buckets, with separate points for changed reset windows and seconds converted to milliseconds before capture. It adds no provider requests or downtime reconstruction. Persistence survives restart, clear blocks pre-clear observations from returning, and credentials are not stored. The comparative studio changes presentation and interaction only; source business logic is unchanged.

## Evidence and disposition

Current source: `src/web/components/AccountHistoryView.tsx` and `account-history.css`. Direction record: `.impeccable/review/2104/redesign-notes.md`; feature contract: `docs/features/account-usage-history-2104.md`.

Captures in `.impeccable/review/2104/`: `desktop.png`, `hover.png`, `weekly.png`, `many-accounts.png`, `bottom.png`, `keyboard-inspection.png`, `mobile.png`, `narrow.png`, `light.png`. `before-redesign.png` records the prior git HEAD at the same 1280×900 viewport. Captures use real components with controlled mocked APIs and synthetic accounts; they are not live-provider truth.

Parent-reported verification: **68 tests / four files passed** (snapshot unit, passive integration, settings and axis), **typecheck and build passed**, and **browser runner passed** normal workflows, window switching, native CDP touch gestures, keyboard tracked marker, 12 accounts, empty/error/retry and short/narrow/light states. The reviewer’s two initial material findings—touch initialization and keyboard tracking—both scored **PASS after fixes**, at source/screenshot scope. The parent additionally confirmed **native CDP touch runtime PASS**. This documentation handoff did not rerun checks or reopen visual review. Native touch hardware, Safari and full screen-reader sessions remain unverified.

## Superseded design history

Earlier iterations stacked both charts, used a top legend and native SVG titles, and exposed observation selectors as primary inspection. Later refinements introduced fitted time axes, connected observations, shared direct zoom and remaining-capacity orientation. The comparative studio described above supersedes those layouts, the earlier 290px/240px chart dimensions and old touch-verification caveats; measurement and persistence safeguards remain.
