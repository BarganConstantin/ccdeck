# Account capacity redesign

Mode: Operate. Scope: Account capacity and its weekly reset calendar; keep ccdeck's visual system and the existing roster, calculation, clock, sorting and modal behavior.

## Product evidence

- `claude-accounts.mjs` converts claude-swap's stored `resets_at` ISO timestamps into Unix seconds. These are provider-reported times from a usage observation, not completion receipts or schedules inferred by ccdeck.
- Account readings carry their own `fetchedAt`; the panel reads the store every 15 seconds, which does not imply every account was freshly collected. The shared panel clock ticks every 30 seconds.
- Calendar “outdated” means a retained failed read, missing/over-15-minute observation, server-stale/stopped/stale-copy state, or an issue blocking switching. Those entries do not contribute to upcoming counts. The capacity report deliberately uses last readings and estimates for elapsed windows; its Ready status is not proof of a fresh observation.
- Day selection already filters both the recent-reading agenda and old-reading disclosure. Today is underlined independently; nothing is selected initially. A zero day does not mean all accounts have zero usage.
- Percentages describe each account's observed consumption of its own window. They are not token totals, and 100% weekly use says the weekly limit was reached, not that login failed.
- Elapsed timestamps move to Other accounts. No future recurrence is invented. The capacity report retains its existing zero-capacity-use estimate for a lapsed window; the UI must identify that estimate instead of implying successful collection.
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

Pending. Screenshots and browser fixtures use synthetic identities only; never copy personal account names into review artifacts.
