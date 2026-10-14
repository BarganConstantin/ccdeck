# Tool Activity: bounded Impeccable review

Reviewed on 2026-10-14 using Impeccable's polish playbook. This refines the
existing report and integrated inspector; collection and aggregation are unchanged.

## Evidence and refinements

The first round inspected the overview, selected `rg`, its daily history and
recorded-call copy in the running application, using Brave through Chrome
DevTools MCP. The five local findings were:

1. Common operations such as `grep`, `ls` and `cut` had no verified description.
   Added their general purposes, plus `git log`, without guessing unknown tools.
2. A single missing timing read “1 calls lack timing”. Singular/plural forms
   now agree in measurement coverage, outcomes and recorded-call summaries.
3. Daily provider/shared counts lacked consistent locale formatting. They now
   use the same numeric formatting as other report measurements.
4. A selected day with zero calls had no visible position in the count chart.
   Both plots now share the date cursor; the caption names chart/day controls.
5. Narrow numeric table cells and daily values had no wrapping fallback for
   unusually long values. Added wrapping without clipping or lowering font sizes.

Manual verification sources: installed macOS `man grep`, `man ls`, `man cut`,
and the [official git-log manual](https://git-scm.com/docs/git-log).
Descriptions explain general purpose, not recorded arguments or per-call effects.

## Confirmation round

Chrome DevTools MCP reported `navigator.brave` present. Inspected the rebuilt
application at 1440×900 and an explicitly emulated 320×568 touch viewport (window
resize alone stops at 500px in this Brave instance). Captured and inspected
the inspector/history and light theme. Verified previous-day selection; Escape
closes help before details and restores focus first to the help trigger, then
to the exact `rg` opener. Keyboard Home selected an outside-history day with
zero counts and unavailable intervals, rather than invented zero durations.
Desktop regions did not overlap; desktop and mobile had no horizontal overflow.
No console warnings/errors were reported in the inspected page.

Additional Brave automation used sanitized journal fixtures through the actual
aggregation module, covering 1728, 1440, 1280, 1024, 800, 390 and 320px; long
identifiers, missing timing, failures, switching, refresh, responsive resizing,
30/60/90-day selection, reduced motion and CSS scaling at 125/150/200%.
The quality harness passed exact daily values, focus preservation, sticky close,
filter removal and midnight date identity. All nine palettes passed its reading
text (4.5:1) and analytical mark (3:1) contrast checks.

## Actual checks

- `npm run typecheck`: passed.
- `npm run build`: passed; existing bundle-size warnings remain.
- Node 22 targeted Vitest: 151 tests in six suites passed (history, audit,
  chart/report correctness, glossary, contrast and popover placement).
- `scripts/qa-tool-activity-history.cjs`: passed all seven sizes.
- `scripts/qa-tool-activity-history-quality.cjs`: passed all checks/nine palettes.
- `git diff --check`: passed.

Local captures are under `.impeccable/review/tool-activity-impeccable-rounds/`:
`before-320.png`, `after-320.png`, `after-desktop.png`, `after-light.png`, and
`after/` for fixture states. Real local usage captures are not published.
This was not a formal screen-reader or cross-browser audit; CSS scaling does
not substitute for every platform's browser-zoom behavior.
