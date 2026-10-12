# Account reset calendar

Local extension for #2105, within Account capacity. The existing Accounts view
opens by default; Reset calendar shares its dialog, roster, clock and retained
readings. Switching views preserves the account table's chosen sort order.

The first viewport shows seven local dates, each with an explicit scheduled
reset count, followed by an agenda grouped by date. Each agenda row carries the
account name, exact local reset time and weekly percentage used. Current and
held-out accounts keep the report's existing labels. This uses the overall
`seven_day` lane; five-hour resets and historical usage charts are separate work.

Use reported Unix timestamps, never rounded countdowns or guessed recurrences.
Advance by local calendar dates rather than fixed 24-hour intervals. Old, paused,
unread or retained failed-poll readings are labeled outdated and excluded from
scheduled counts. Unknown, passed and out-of-range reset times remain visible
under Other accounts. Daily counts describe account resets, not token amounts.

Inherit ccdeck's theme tokens, compact report typography and modal focus behavior.
Desktop uses seven overview columns and aligned agenda rows. At 520px and below,
the overview wraps to four columns and agenda rows stack without truncating
account names. View buttons have 40px minimum height on these widths. Pressed
state is exposed through `aria-pressed` and receives a forced-colors outline.

## Verification — 2026-10-12

Chrome covered Rider Black at 1280, 390 and 320px and White Contrast at 1280 and
390px, with isolated synthetic account fixtures. Table sorting survives view
changes; polling updates reset dates and usage while the dialog remains open;
failed polling retains visibly outdated readings and recovery restores the
schedule. Tab navigation and Escape restore the modal's existing focus behavior.
No unintended horizontal overflow was observed.

Regression tests cover timestamp ordering, local midnight, 23/25-hour DST days,
unknown and invalid dates, stale and held readings, weekly-only selection, usage
availability and rendered content. These fixtures do not establish the capture
of real account telemetry. A full screen-reader session was not performed.

Inline finish review (no independent reviewer tool available): **ship**. The
review preserves the incumbent visual world; no new palette, assets or motion
are introduced. No material visual findings remain.
