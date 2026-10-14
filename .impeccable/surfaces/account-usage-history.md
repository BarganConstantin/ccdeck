# Account usage history

Final surface brief — 2026-10-14, #2104. **Mode: Operate.** Established local extension of ccdeck’s native Account capacity dialog and Settings. Ground truth: committed implementation at `a7c5ab32` (following `c571835b`) and the actual fixture screenshots below. Inherit the incumbent visual system.

## Direction and hierarchy

Account capacity retains Accounts and Reset calendar and adds History within the same dialog. The first view presents Account and Period selectors, recording/retention context, then separate 5-hour and 7-day charts. Account choices come from persisted known readings; removed accounts remain selectable and carry “Removed account”. The initial period is seven days; 30/60/90-day choices follow configured retention.

Each chart pairs its window heading with the inspected percentage, followed by a 0–100% plot, a native “Inspect observation” selector, and observation/reset context. Inspection works through labelled keyboard-operable selects with visible focus. When the selected observation disappears after an account or period change, inspection falls back to the latest available reading; an account selection that no longer exists returns to All accounts.

**Measured readings stay measured.** Percentages mean reported capacity used. Dashed markers denote reported reset times, never guaranteed renewal or token consumption. Dates use browser local time with timezone context on observations. Missing windows remain unknown; series break across missing readings, changed reset windows, or gaps exceeding 30 minutes. Partial accounts can show a point in one window and “No observations” in the other. Empty periods explain accumulation or direct paused recording to Settings → Account history. Loading, read failures with Retry, and storage failures have explicit status/alert text.

## Visual and responsive rules

Use existing panel/background/text tokens and accent plot strokes. **Control edges and chart guides have separate roles:** selectors use `--ctl-edge`; grid guides, separators and confirmation dividers use `--line`. Reported reset markers use dashed `--text-dim` strokes. Measurements—chart values, axes and storage size—use `--font-mono` with tabular numerals. Window, settings and empty-state headings are 14px; supporting copy stays quiet and readable.

Charts stack vertically inside the dialog’s scrolling workspace. Desktop selectors share a row; below 600px the account selector takes a full row, padding reduces from 16px 24px to 12px, and axis labels increase from 11px to 12px. Mobile preserves the same chart/inspection order. Dark and light screenshots show the same hierarchy with theme-resolved edges and series colors.

## Settings and persistence

Settings adds Account history: usage snapshots enabled by default, retention of 30 days by default with 60/90-day options, actual disk bytes formatted as B/KB/MB, and Clear history. Reduced retention and clearing require explicit confirmation and offer Cancel. Pausing preserves history while retention pruning continues. Removed-account history lasts until pruning or an explicit clear.

Recording passively reuses fresh existing observations in 15-minute observation-time buckets; it adds no provider requests. Changed reset windows can retain a separate point within a bucket. Provider observation seconds are converted to milliseconds before capture. No readings are reconstructed for downtime. Local persistence survives restart; clear prevents pre-clear observations from returning. Credentials are not stored.

## Evidence and disposition

Source: `src/web/components/{AccountsUsageReport,AccountHistoryView,AccountHistorySettings,SettingsModal}.tsx`, `src/web/components/account-history.css`, `src/web/account-history.ts`, and `src/server/{account-usage-history,claude-accounts,deck-prefs}.mjs`. Specification reference: `docs/features/account-usage-history-2104.md`.

Inspected screenshots in `.impeccable/review/2104/`: `desktop.png`, `mobile.png`, `light.png`, `settings.png`, `empty.png`, and `removed-account.png`. These are real component renders with synthetic observations and mocked APIs; Settings depicts paused recording, while enabled-by-default behavior is established by committed preferences.

Reviewer disposition supplied by the parent: **ship on the four scored fixes**—timestamp conversion, control edges, measurement typography and selection fallback. This is scoped review evidence, not whole-surface certification. Parent reports 141 tests, typecheck, build and browser fixtures all passed; this documentation pass did not rerun them. Live providers, screen-reader sessions and native Windows/Linux were not tested; Safari/Firefox also remain unverified.

Not canonized: fixture launcher buttons and sample account identities are review scaffolding; the limited ship disposition establishes no new global visual or accessibility rules.

## All-account comparison (owner refinement)

History now defaults to All accounts, overlaying each account on the same time axis in both windows. A shared legend names the accounts and matches line colors. Clicking a legend entry isolates that account; clicking it again or selecting All accounts restores the combined view. Colors name accounts, not quota health, and remain consistent between the two windows and single-account filtering. Observation keys include both account identity and timestamp, keeping simultaneous readings distinct.

Browser checks cover the default combined series, legend filtering/restoration, account and period changes, missing windows and narrow/light/short states. Historical snapshots, collection and retention are unchanged.

## Adaptive time extent (owner refinement)

The period selector is a maximum lookback filter, not a forced plot width. Both windows share an extent fitted to the selected accounts' visible observations, with 5% padding (at least 15 minutes per edge). A single reading is centered in a 30-minute view; padding never creates observations or implies renewed capacity. Empty periods retain the explicit empty state. Short spans display local times, adding dates across day boundaries; longer spans display dates. No persistence, refresh, retention or usage semantics changed.

Verification: 6 deterministic axis tests and 21 snapshot regression tests passed; TypeScript and production build passed. Browser assertions verify recent readings fill more than 85% of the plot and a single reading is centered, alongside existing selection, settings, empty/error recovery and responsive checks. Updated desktop, single-point and narrow renders were inspected. Evidence remains controlled data, not live-provider certification.

## Connected observations (owner refinement)

Read-only aggregate inspection of the preview found 233 adjacent reset timestamp changes below one second (maximum 0.856 seconds); strict timestamp equality was splitting otherwise continuous observations into isolated dots. Chart segmentation now tolerates one second of reporting precision relative to the segment's first reset timestamp, preventing cumulative drift. Missing windows, gaps over 30 minutes, unknown/known transitions and materially changed reset timestamps still break the line. Stored timestamps remain unchanged. Lines use rounded caps and joins without curved interpolation or invented values.

Regression coverage checks subsecond jitter, cumulative drift, unknown transitions and real cycle boundaries. The controlled browser fixture adds timestamp jitter and verifies that two actual cycles remain exactly two lines with rounded joins. The updated desktop render was inspected; 28 focused unit tests and browser checks passed.

## Shared zoom and time navigation (owner refinement)

Both existing SVG charts share an absolute-time viewport. Keyboard-operable buttons zoom in/out, move earlier/later and reset to available history. Ctrl/Meta + wheel zooms around the pointer; ordinary scrolling continues to scroll the modal. Dragging a zoomed plot pans with pointer capture; axis text is not selectable. Zoom is bounded to the available extent and a five-minute minimum, with no new dependency or provider requests. Account, legend and period changes reset the view. Refresh keeps the chosen absolute range where available and clamps it when the domain changes.

Series are clipped to the plot area without changing raw points or interpolating new observations. Inspect observation lists and account counts refer to observations within the visible interval; both charts retain aligned axes. The visible local-time range is announced and empty zoomed ranges explain that no readings exist there. Desktop, zoomed and mobile renders were inspected, including a fix for accidental text selection during drag. Browser checks cover keyboard zoom, synchronized axes, button pan, modified wheel, normal scrolling, drag and reset in addition to existing workflows. Ten axis/navigation unit tests and 22 snapshot tests passed. Native touch gestures and screen-reader sessions remain unverified; the explicit buttons provide an alternative to pointer gestures.

## Direct plot interaction (supersedes the preceding toolbar)

The owner requested taller graphs and interaction entirely inside the plot. Graphs now have 290px total height and a 240px data area. Wheel zoom needs no modifier; horizontal wheel pans, pointer drag pans while zoomed and double-click resets both windows. The visible button toolbar is removed. Focusable, labeled chart groups retain keyboard equivalents (+/−, left/right, 0/Home), with focus-visible styling. Scrolling outside the plots remains modal scrolling.

Account names appear in SVG titles on lines, with a transparent 12px path for forgiving hit-testing; point titles preserve observation details. Browser assertions verify real line hit-testing, titles, height, direct wheel zoom, keyboard and pointer navigation, shared axes and double-click reset. Thirty-two focused tests, TypeScript, production build and browser verification passed. Updated default and zoomed desktop renders were inspected. Native tooltip appearance/delay, touch hardware and full screen-reader behavior were not visually verified.
