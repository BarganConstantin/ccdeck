# Account capacity and reset calendar

Current surface brief — 2026-10-13, product composition refinement. Inherit ccdeck's theme, typography, control
edges, focus tokens and native dialog behavior; this is scheduling and capacity
decision support, not a pooled-quota analytics dashboard.

Accounts opens by default. Reset calendar shares its modal, roster, retained
readings and 30-second panel clock. Switching views preserves sorting and the
selected date. No extra fetch, timer, dependency or account mutation.

## Hierarchy and interactions

One persistent planning header combines the next reported weekly event, account
or simultaneous-account count, local date/time, countdown and observation basis.
Three direct category controls show Upcoming, Need fresh readings and Other reset
times. Uncertainty is reachable without scrolling through upcoming accounts.
Category, date and sort state survive switching between the two existing views.

The seven-day navigator is a temporal strip, without repeated bordered boxes.
Empty dates are quiet; populated dates have stronger numerals and an activity mark
with a numeric count. Today is underlined; selected dates use accent edging and
aria-pressed. Full-date/count accessible labels and shared focus rings remain.
A date selects Upcoming and filters its agenda; All days clears the filter.
Category controls show all days in their category; the next event stays global.

Compact date/time metadata groups accounts by exact reported timestamp, sharing
one time/countdown. Account identity and observed weekly use share a native
disclosure summary, supported by a small meter; clicking capacity also inspects
the account. The accessible day heading stays separate from the visual metadata.
The agenda and All days action share a 760px boundary. Desktop summaries are
48–49px; single-account groups are 59px instead of the old 84px date-rail minimum. Capacity limits use warning ink in the calendar, not error ink.
Native disclosures in all three categories reveal both primary windows, estimate
basis and the separate-limit caveat. Older readings also carry their confidence
inside expanded details; they never regain current-reading wording there.

Explicit category/day changes return the single agenda scroller to its start.
Polling and clock updates preserve scroll. No programmatic focus jump is needed;
category buttons retain focus and expose pressed state.

Use provider-reported Unix timestamps, local calendar arithmetic and browser
locale/timezone. Never infer recurring schedules or confirmed renewal from elapsed
time. Older/paused/unread/failed-poll readings are excluded from upcoming counts;
actual reasons and last observations remain accessible. Unknown, elapsed and
out-of-range timestamps stay in Other reset times. The capacity report preserves
its calculation but names elapsed estimates Estimated unused and Awaiting read.
Ready can be based on last readings; held-out accounts remain included in capacity
but excluded from automatic rotation. Summary percentages are per-account averages.

## Responsive behavior

Viewport-constrained modal, maximum 900px wide; calendar has stable maximum 740px
height and one agenda scroller beneath the fixed planning header. Accounts retains
its responsive grouped rows and every sortable field without a horizontal table
scroller. Long identifiers wrap in rows; the next-event identifier uses two visual
lines at most while retaining its accessible text.

At 320px the seven dates form a 4+3 instrument with 44px targets. Narrow headers
recompose the summary and category controls; short phones visually condense basis
labels while retaining accessible context and a complete first agenda entry.
Mobile account summaries and All days have 44px hit areas. No decorative animation;
date/category feedback respects reduced motion and meters use transforms.

## Verification and limits

Independent design and detector assessments informed the revised composition.
The targeted detector returned zero findings, not a visual approval. Two focused
critique/fix passes corrected short-phone density, stale-detail wording and scope
navigation; independent finish review scored the specified fixes as ship.

261 tests across 15 relevant files, TypeScript and production build passed. Chromium
fixtures covered both themes, 1280px desktop, 390px, 320×568 and 1024×500, including
loading, failed-read retention/recovery, empty/all-old rosters, 24-account schedules,
category/day selection, current/older/other account inspection, sorting retention,
keyboard activation, reduced motion, Tab trapping and Escape focus restoration.
The fixed overview stayed in place during agenda scrolling; explicit scope actions
returned the results to the start. Before/after and top/middle/bottom captures are
under /tmp/ccdeck-capacity-refinement, with synthetic identifiers only.

Real telemetry collection, physical touch, Safari and a full screen-reader session
remain unverified. Provider-reported times never guarantee renewed capacity.
See docs/features/account-capacity-redesign-review.md for comparison, product
truth, audit provenance, implementation decisions and artifact locations.


### Visual roles and refinement

Preserve the compact planning workspace. Next-reset timing and selection use the
existing accent; freshness attention and consumed capacity use warning ink;
unknown/historical metadata stay neutral. The inset next-reset surface and native
expanded account body use bg-soft. A single clock follows the shared glyph spec.
Activity dates have a quiet tint; selected dates add an accent edge and numeral.
Accurate 64×4px meters accompany monospace usage values. Native disclosure targets
remain 48–49px on representative desktop rows. Feedback transitions are 140ms,
removed with reduced motion; never add ambient pulses to account predictions.

Final visual pass: independent A/B critique, zero deterministic findings, rendered
refinement, 261 tests/15 files, TypeScript/build and Chromium workflow checks passed.
Settled sampled text contrast was at least 4.89:1 in tested dark/light states.
Before/after fixtures: /tmp/ccdeck-capacity-visual. See the review document for
scope, measured evidence and retained verification limitations.
