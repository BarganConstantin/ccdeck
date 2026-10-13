# Account capacity and reset calendar

Current surface brief — 2026-10-13. Inherit ccdeck's theme, typography, control
edges, focus tokens and native dialog behavior; this is scheduling and capacity
decision support, not a pooled-quota analytics dashboard.

Accounts opens by default. Reset calendar shares its modal, roster, retained
readings and 30-second panel clock. Switching views preserves sorting and the
selected date. No extra fetch, timer, dependency or account mutation.

## Hierarchy and interactions

The next reported weekly event leads with its account or simultaneous-account
count, local date/time and countdown. Individual identities remain in the agenda.
A compact seven-day navigator shows reset counts, not usage. Today is underlined;
selection uses accent edging and aria-pressed; hover remains neutral and focus
uses the shared visible ring. Selecting a date filters the agenda. The always
available All days button clears selection without discarding keyboard focus.

Agenda rows align reset time, expandable identity and observed weekly use.
Native account disclosures expose both 5-hour and weekly windows, held-out status
and the separate-limit caveat. Coverage links open and focus native disclosures
for older readings and other reset times. Explanations remain progressive rather
than obscuring the main schedule.

Use provider-reported Unix timestamps, local calendar arithmetic and browser
locale/timezone. Never infer recurring schedules or confirmed renewal from elapsed
time. Older/paused/unread/failed-poll readings are excluded from upcoming counts;
actual reasons and last observations remain accessible. Unknown, elapsed and
out-of-range timestamps stay in Other reset times. The capacity report preserves
its calculation but names elapsed estimates Estimated unused and Awaiting read.
Ready can be based on last readings; held-out accounts remain included in capacity
but excluded from automatic rotation. Summary percentages are per-account averages.

## Responsive behavior

Viewport-constrained modal, maximum 900px wide, with a single vertical body scroller.
Narrow Accounts retains every field and sorting control in grouped two-column rows,
without a horizontal table scroller. Long identifiers wrap. Calendar rows stack
metadata deliberately; at 320px dates form a 4+3 grid with 44px targets. Short
viewports compact the lead and header so the first complete agenda entry remains
visible. The dialog title stays visible on phones. No decorative motion; date
transitions respect reduced motion, and usage meters use transforms.

## Verification and limits

Two independent assessments, two focused critique/fix iterations and an independent
finish scoring pass informed implementation. Final disposition: ship for the scored
fixes after mobile summary wrapping, tied-reset hierarchy and short-viewport fixes.

258 relevant tests, TypeScript and production build passed. Chromium fixtures
covered both incumbent themes, 1280px desktop, 390px, 320×568 and 1024×500, including
loading, failed-read retention/recovery, selection, details, sort retention, keyboard
activation, reduced-motion transitions, Tab trapping and Escape focus restoration.
Fixtures use synthetic identifiers. Real telemetry collection, physical touch,
Safari and a full screen-reader session remain unverified.

See docs/features/account-capacity-redesign-review.md for concept evaluation,
product evidence, implementation decisions and artifact locations.
