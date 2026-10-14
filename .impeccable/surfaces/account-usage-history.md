# Account usage history

Final surface brief — 2026-10-14, #2104. **Mode: Operate.** Established local extension of ccdeck’s native Account capacity dialog and Settings. Ground truth: committed implementation at `a7c5ab32` (following `c571835b`) and the actual fixture screenshots below. Inherit the incumbent visual system.

## Direction and hierarchy

Account capacity retains Accounts and Reset calendar and adds History within the same dialog. The first view presents Account and Period selectors, recording/retention context, then separate 5-hour and 7-day charts. Account choices come from persisted known readings; removed accounts remain selectable and carry “Removed account”. The initial period is seven days; 30/60/90-day choices follow configured retention.

Each chart pairs its window heading with the inspected percentage, followed by a 0–100% plot, a native “Inspect observation” selector, and observation/reset context. Inspection works through labelled keyboard-operable selects with visible focus. When the selected observation disappears after an account or period change, inspection falls back to the latest available reading; account selection similarly falls back to an available recorded account.

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
