# Account capacity redesign

Mode: Operate. Scope: Account capacity and its weekly reset calendar; keep ccdeck's visual system and the existing roster, calculation, clock, sorting and modal behavior.

## Product evidence

- `claude-accounts.mjs` converts claude-swap's stored `resets_at` ISO timestamps into Unix seconds. These are provider-reported times from a usage observation, not completion receipts or schedules inferred by ccdeck.
- Account readings carry their own `fetchedAt`; the panel reads the store every 15 seconds, which does not imply every account was freshly collected. The shared panel clock ticks every 30 seconds.
- Calendar “outdated” means a retained failed read, missing/over-15-minute observation, server-stale/stopped/stale-copy state, or an issue blocking switching. Those entries do not contribute to upcoming counts. The capacity report deliberately uses last readings and estimates for elapsed windows; its Ready status is not proof of a fresh observation.
- Day selection already filters both the recent-reading agenda and old-reading disclosure. Today is underlined independently; nothing is selected initially. A zero day does not mean all accounts have zero usage.
- Percentages describe each account's observed consumption of its own window. They are not token totals, and 100% weekly use says the weekly limit was reached, not that login failed.
- Elapsed timestamps move to Other reset times. No future recurrence is invented. The capacity report retains its existing zero-capacity-use estimate for a lapsed window; the UI must identify that estimate instead of implying successful collection.
- Accounts may report 5-hour, overall weekly and model-specific lanes. The calendar remains the overall weekly lane; both primary windows remain in Accounts.
- Dates use the browser's current local timezone and locale. Calendar days are local date arithmetic, including DST, not fixed 24-hour intervals. No hardcoded Chisinau offset or new clock is required.
- Preserve `useModalDismiss`, `useScrimDismiss`, `SortHead`, `holdOrder`, `usageReport`, existing theme tokens, Current/held-out labels and native disclosures. No new fetching, dependency or account mutation.

## Five highest-impact problems

1. The next weekly reset is styled like metadata and lacks a visible relative time; the primary planning answer has weak priority.
2. Seven tall bars and large counts dominate sparse weeks without helping users choose an account.
3. Today, selected day and count semantics are too subtle; the selected day must explicitly name the agenda and have an always-available All days path.
4. “Outdated” conceals materially different causes. Older observations should be described as needing a fresh reading, with the actual reason retained.
5. The compact header hides its title on phones, while the account table requires a second scroll axis. Reduce summary weight and adapt the detailed rows structurally.

## Concept evaluation

| Approach | Hierarchy / scanning | Interaction cost | Responsive fit | Complexity |
| --- | --- | --- | --- | --- |
| A. Compact calendar + agenda | Fast day lookup and grouped identities; next event needs a dedicated lead | One day press; All days clears | Seven compact dates, stacked agenda | Low; reuses schedule model |
| B. Next reset + timeline | Strong next-event answer; weak direct access to empty/later days | Scroll to date | Good on narrow/short windows | Low, but date navigation still needed |
| C. Account-centric overview | Best for availability and comparisons; mixed reset dates scan slowly | Sort/search account | Good with responsive row details | Higher duplication of the existing Accounts view |

Selected: A/B hybrid. A restrained next-weekly-reset lead precedes a compact seven-day navigator and chronological agenda. Accounts remains the familiar sortable capacity view; average remaining capacity is explicitly labeled and visually secondary. One mode per existing job, no three-concept switcher. The calendar always states the active day versus All days, and uncertain schedules remain accessible without masquerading as upcoming totals.

## Implementation and verification

Implemented on `feat/account-capacity-redesign`, based on development `78b862a8`.

- Next reported weekly event leads with a local date/time and existing-clock countdown. Exact timestamp ties lead with an account count, leaving names in the agenda.
- Compact seven-day counts replace tall bars. Selecting a day filters the agenda; All days stays available and retains focus. Today, selection and keyboard focus have separate treatments. Selection and sorting survive view changes.
- Chronological rows align time, identity and observed weekly use. Native account disclosures show both primary windows and explain that a weekly reset does not remove the 5-hour limit.
- Coverage links expose older readings and unknown, elapsed or later times without inflating upcoming totals. Causes remain visible; failed reads retain the roster and recovery restores the schedule.
- Accounts keeps all sortable columns and calculations. On narrow screens it becomes grouped rows with visible field labels and one vertical scroll region. Average remaining is explicit; elapsed-window estimates say Estimated unused and Awaiting read, including account details.
- Shared theme, control edges, focus/dismissal hooks, count-up behavior, polling and panel clock remain. No backend changes, dependency, new timer or account mutation.

### Impeccable critique and refinement

Independent Assessments A and B reviewed data confidence, hierarchy, day-selection continuity, keyboard behavior and narrow-window density. Assessment B's targeted CLI detector returned zero findings; rendered review still identified usability work, so detector output was not treated as design approval.

After implementation, the first additional critique/fix pass qualified elapsed estimates, exposed uncertainty counts, grouped simultaneous events, separated hover from selection and reduced short-viewport density. The second pass corrected mobile summary wrapping, promoted tied-account counts and removed repeated names from the lead. The independent finish reviewer inspected source and final captures and returned **ship for the scored fixes**, without claiming a fresh whole-surface audit or independently rerunning the workflow harness.

### Verification — 2026-10-13

- 258 tests across 15 relevant files passed: schedule/date/DST boundaries (including Europe/Chisinau's 23/25-hour days), calculation, estimate wording, sorting, spoken cell content, control edges, motion inventory, modal focus, overflow and portal behavior.
- TypeScript and production build passed. Build reports the existing large-chunk warning. No lint command is configured.
- Isolated Chromium rendered the real report and AccountsPanel with synthetic identities only. Workflows passed: panel loading to report, day selection/empty days/All days focus, keyboard Enter selection and focus-visible, native details, tied resets, sorting/selection retention, coverage navigation, failed-read retention/recovery, modal Tab trapping and Escape/restored launcher focus.
- Rider Black and White Contrast captures cover desktop and 390px; Rider Black additionally covers 320×568 and 1024×500. Bounds checks found no dialog horizontal overflow; 320px date controls meet 44×44 targets. A complete first calendar entry is visible at both short sizes. Reduced-motion date transitions were verified as disabled.
- Before and after captures: `/tmp/ccdeck-capacity-review/before/` and `/tmp/ccdeck-capacity-review/after/`. Browser fixtures were temporary and removed after execution; artifacts contain no real account identifiers.

### Limits

Provider timestamps describe reported reset times at an observation, not confirmation that capacity renewed. The existing readiness calculation can include last readings, held-out accounts and elapsed-window estimates; its UI now states that basis. Telemetry collection accuracy, physical touch hardware, Safari and a full screen-reader session were not verified. Browser fixtures validate application behavior rather than real-account collection. No recurrence is invented and no account is switched or refreshed by these tests.


## Product composition refinement — 2026-10-13

The owner's follow-up identified a real decision-support gap: recent schedules and accounts requiring fresh readings had similar significance, but lived in separate scrolling sections. The supplied reference is illustrative; the implementation continues to use actual provider observations, not its invented schedule.

Method: independent Assessment A (Hubble, 01a133ad-15f2-77f0-9a0a-092867f6a411) and Assessment B (Singer, 01a133ad-173d-7441-b47f-f415d9bbf32d). A identified fragmented planning context, buried reliability meaning, duplicate simultaneous times, generic date boxes and unclear global versus selected scope (provisional 23/40 Nielsen score). B's targeted detector ran once with zero findings; source review still found confidence wording inconsistencies and small secondary touch targets. Questions skipped: the owner authorized autonomous implementation and no unresolved product choice required input.

### Alternatives

| Composition | Scanning / discovery | Interaction / responsive cost | Decision |
| --- | --- | --- | --- |
| Unified planning header + category views | Next event, week distribution and observation coverage are together; one press reaches affected accounts | One stable reading order; header remains visible above one agenda scroller | Selected |
| Context rail beside agenda | Good desktop glanceability but splits temporal and reliability context | Rail stacks or collapses on phones, recreating the distance problem | Rejected |

### Implemented outcome

- Persistent planning header combines next reported event, exact local time, existing-clock countdown, observation basis and three direct category controls: Upcoming, Need fresh readings, Other reset times. Counts remain disjoint according to the existing schedule model; older in-range schedules are excluded from upcoming, while unknown/elapsed/later timestamps retain their own causes.
- Seven dates are one quiet temporal instrument, without repeated bordered boxes. Populated dates have stronger numerals and a small activity mark with an explicit numeric count; empty dates are quieter. Today and selected/focused dates remain distinct, with full-date/count screen-reader labels.
- Chronological date rails group accounts by exact reported timestamp, showing a shared time/countdown once. Account identity and observation percentage lead each compact row; the small meter is secondary. Depleted capacity uses warning ink in this calendar, not error ink.
- Older observations have their actual collection reason beside Last read usage; their expanded details also qualify the reading and show Last reported reset rather than a current countdown. Every category, including unknown and elapsed times, provides native account inspection for both windows.
- Category and date changes return the agenda to its beginning, while polling and clock updates retain the user's scroll position. Category, selected day and table sort survive switching to Accounts and back. Clicking a date selects Upcoming; category controls return to all days, and the global next event remains explicitly global.
- One scroll region beneath the planning header; stable viewport-constrained calendar height. On narrow/short screens the header rearranges into a compact instrument, retaining data category counts and a complete first agenda entry. Account rows, date targets and All days meet 44px mobile hit-area sizing. Supplementary basis copy is visually condensed on short phones and remains available to screen readers/details.

### Two critique/fix passes and finish review

Pass one corrected the mobile header consuming the whole viewport and removed repetitive stale-row phrasing; grouped timestamp events substantially reduce agenda height. Pass two adjusted the narrow summary hierarchy, moved incidental labels into accessible detail at short heights, corrected whole-identifier wrapping, and stabilized the scope workspace. The independent finish reviewer found two concrete workflow gaps: unknown/elapsed account inspection and retained scroll on category changes; both were fixed with the existing disclosure and explicit-event scroll reset.

Final artifacts: `/tmp/ccdeck-capacity-refinement/before/`, `/tmp/ccdeck-capacity-refinement/pass1/`, `/tmp/ccdeck-capacity-refinement/pass2/`, `/tmp/ccdeck-capacity-refinement/after/`. Final captures include top/middle/bottom of a 24-account schedule, selected/empty dates, expanded current/older/other accounts, all-old/no-upcoming rosters, loading/error recovery, dark/light and desktop/320/390/short layouts. Synthetic identifiers only.

Validation for this refinement: 260 tests across 15 files, TypeScript and production build passed; only the existing large-chunk build warning remains. Chromium workflows passed, including category state retention, older/other-account inspection, fixed header during 24-account scrolling and explicit category scroll reset. Independent finish review (Erdos, 01a133b5-b890-74f2-9f1f-9870ffe52958) scored both specified fixes as ship; its source review did not independently rerun the browser harness. Provider timestamp, readiness-estimate and telemetry limitations described above remain; no new data collection, recurrence, clock or dependency was introduced.
