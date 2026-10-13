# Account reset calendar

Local extension for #2105, within Account capacity. The existing Accounts view
opens by default; Reset calendar shares its dialog, roster, clock and retained
readings. Switching views preserves the account table's chosen sort order.

The first viewport names the next reset and its account, then shows a seven-day
bar chart with explicit daily scheduled-reset counts. Clicking a day filters
the agenda; Show all days or pressing the same day restores the whole week. Each agenda row carries the
account name, exact local reset time and weekly percentage used. Current and
held-out accounts keep the report's existing labels. This uses the overall
`seven_day` lane; five-hour resets and historical usage charts are separate work.

Use reported Unix timestamps, never rounded countdowns or guessed recurrences.
Advance by local calendar dates rather than fixed 24-hour intervals. Old, paused,
unread or retained failed-poll readings are labeled outdated and excluded from
scheduled counts. Unknown, passed and out-of-range reset times remain visible
under Other accounts. Daily counts describe account resets, not token amounts.

Inherit ccdeck's theme tokens, compact report typography and modal focus behavior.
The chart retains all seven columns at every width. Below 520px, dates use
compact day numbers and agenda rows stack without truncating account names.
Desktop aligns reset times, account names and weekly usage; a small usage bar
backs the percentage. Older readings and Other accounts use native disclosures
closed by default, keeping the main agenda focused on current schedules. View buttons have 40px minimum height on these widths. Pressed
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


## Scanability refinement — 2026-10-12

The owner's real-data screenshot showed a long agenda dominated by outdated
readings. The refinement separates their last reported times from the main
schedule, puts the next current reset first, and uses proportional daily bars
with visible zero counts. No account readings or schedules were changed; the
chart counts the same reported weekly resets as the original implementation.
Unknown, passed and out-of-range accounts remain available in Other accounts.

Verification: 272 relevant tests across eight files, TypeScript and production
build passed. Isolated Chrome fixtures covered both themes, 1280/390px, and Rider
Black at 320px: day filtering and clearing, zero-reset days with old readings,
native disclosures, table-sort retention, keyboard activation and Escape,
failed-poll retention/recovery, updated next-reset selection and no horizontal
overflow. The rendered bar heights are tested against unequal daily counts.
No new chart library or runtime dependency was needed for seven data points.

Inline finish review: **ship** for this refinement after reviewing the owner's
screenshot and the new desktop/mobile captures. No independent reviewer tool was
available. Existing theme, typography and date semantics are retained; the
current-schedule hierarchy and disclosure behavior are the durable changes.


## Compact view selector — 2026-10-12

Accounts / Reset calendar is now a text selector inside the modal header, with
an accent underline for the active view and no separate navigation row. At phone
widths, the dialog title stays in the accessibility tree while the selector and
Close share the visible header. Keyboard order follows that row; the existing
modal dismissal and restored launch-button focus are preserved.

Chrome verified both views, table-sort retention, chart filtering, keyboard and
Escape at desktop, 390px and 320px in the existing themes. 238 tests across ten
files, TypeScript and build passed after synchronizing the current development
baseline. The new chart and text disclosures are included in motion and overflow
censuses; their selection/expansion feedback preserves text and chart geometry.
