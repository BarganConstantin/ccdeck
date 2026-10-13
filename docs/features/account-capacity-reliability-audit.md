# Account Capacity reliability audit

2026-10-13 · branch `fix/account-capacity-reliability` · base development
`b37be6c505c347798fa3b209920b3978fe9466f4` (merged capacity redesign, PR #2123).
No UI redesign, account mutation, credentials edit, dependency addition, or merge.

## Recommendation

**READY WITH FOLLOW-UPS** for the scoped application fixes. The tested data
transformations and refresh transitions are reliable under controlled inputs.
This is not certification of live provider responses or every supported runtime.
The runtime timezone limitation below must be considered before promising exact
local times around Chisinau DST on older browsers/desktop runtimes.

## Data flow and sources of truth

`claude-swap` collects provider observations into schema-2 `cache/usage.json`.
`sequence.json` supplies managed accounts, slot order and active account number.
`claude-accounts.mjs` joins those files using email + organization UUID, produces
normalized lanes, then `/api/claude-accounts` supplies `useAccountRoster`.
The hook publishes a validated, latest-request snapshot. Accounts, Usage Report
and Reset Calendar consume that same roster. Calendar grouping is a pure
transformation of the weekly lane and the current local calendar date.

| Field | Source and contract |
| --- | --- |
| Identity / current account | Sequence identity and active slot; UUID + email protects stored readings from slot reuse. Alias and organization display name are presentation only. |
| Used percentage | Last successful observation's `pct` in the managed store; OAuth `utilization` is a percentage, not a fraction. Five-hour, weekly and scoped windows remain distinct. |
| Remaining / headroom | Derived from observed usage; no token limits or pooled quota are available. Usable headroom becomes unknown if any observed window's reported reset has elapsed. |
| Reset time | Store/provider `resets_at`, parsed to epoch seconds. Reported, not a confirmed renewal; missing, invalid and elapsed times are never replaced with guessed schedules. |
| Observation / attempt time | Store epoch seconds become API epoch milliseconds. A failed attempt does not become a successful observation. |
| Freshness | Roster stale flag plus the frontend clock's 15-minute observation threshold; stopped collection/auth issues are additional trust signals. |
| Availability | Report states reflect latest observed two-window usage, subject to missing/auth-blocked data. Ready is not a live provider admission guarantee; old readings remain explicitly marked. |
| Calendar counts | One overall weekly reset per account, not every capacity window. Fresh in-week, older in-week and other (unknown/elapsed/later) entries form a complete partition. |

The active Usage quota has a separate fallback pipeline in `quota.mjs`: recent
managed-store reading, bounded OAuth request, then supported CLI fallback. Its
last-good reading, identity generation, deadlines and cooldowns have existing
regression coverage. The shared `quota-shape.mjs` normalization is covered here.
Account Capacity's roster is Claude-specific; Codex quota is a separate feature.

The roster coalesces backend reads and has a five-second cache/forced-read floor.
Collector nudges and per-account observation plans are delegated to claude-swap;
frontend refresh is not a promise of an immediate provider observation. Existing
collector cadence, rate-limit cooldowns and provider request budgets are preserved.

## Findings and fixes

Severity: P0 critical corruption/security; P1 wrong usage/availability/identity;
P2 edge-case recovery; P3 minor maintenance. No P0 defect was confirmed.

| Severity | Layer / confirmed problem | Evidence and impact | Fix / regression |
| --- | --- | --- | --- |
| P1 | Report manufactured zero usage after elapsed reset | Exhausted 100/100 became Ready without another observation; failing renewal test. | Retain observed usage and uncertainty; `account-capacity-reliability`, report rendering and browser reset-boundary assertions. |
| P1 | Headroom discarded an exhausted elapsed window | Failing test returned 99% free when the elapsed window had reported 100% used. | Return unknown headroom; reliability and `accounts-lapsed-window` tests. Backend switching policy is unchanged. |
| P1 | Weekly-only quota appeared as five-hour usage | Provider/store contract tests failed with an invented session value. | Independent window mapping; `account-capacity-provider`, `quota-source`, `quota-own-sources`. |
| P1 | Frontend identity used organization display names | Same email and equal display names collided despite different UUIDs; failing identity tests. | Stable UUID key; server refuses unknown-email cache matches; identity and persisted slot-reuse tests. |
| P1 | Older roster response could overwrite a newer response | Actual Chromium hook test published older active account after newer one. | Request generation guard before all publication; browser response-order regression. |
| P2 | Impossible observation dates could look fresh | Invalid-date test failed on an extreme timestamp. | Normalize server stamps and validate frontend observations; runtime contract and reliability tests. |
| P2 | Corrupt/incomplete persistence hid accounts or trusted malformed rows | Three failing store tests: duplicate/missing sequence entries, array rows, impossible stamp. | Unique complete roster order, supported object schema, bounded percentages; `capacity-store-reliability`. |
| P2 | Confirmed empty roster retained a removed account | Browser empty-roster regression still found a ghost in another category. | Accept authoritative `[]`, retain only missing/failed snapshots; browser removal regression. |
| P2 | Overlapping polls and unmounted requests | Browser pending-read test observed another request before completion. | Coalesce polls, abort on unmount, reject obsolete failures; browser timer/lifecycle regression. |
| P2 | Malformed API body could replace usable state | Runtime contract rejects missing arrays, bad lanes, duplicate slots and invalid timestamps. | Focused guard with no new dependency; browser malformed JSON/schema and HTTP recovery tests. |
| P2 | Repeated local DST times had ambiguous tooltips | Local time alone cannot distinguish two UTC instants in a repeated hour. | Include offset and UTC instant; repeated-hour rendering assertions preserve instant ordering. |

Historical tests that deliberately expected zero after expiry or a weekly value
in the five-hour field were updated to the corrected observed-data contract.
Source-shape checks were updated for the additional validation/failure branch;
real-browser assertions cover its behavior rather than relying on text searches.

## Verified invariants

- No reset timestamp alone renews capacity or clears observed exhaustion.
- Missing/unreadable usage stays unknown. Percentages and meters derive from
  the same bounded value; 99.6% is not displayed as confirmed 100% exhaustion.
- Store matching rejects a reused slot with a different identity. UUID-based
  frontend keys survive slot moves and organization renames.
- Only the latest active roster request publishes data, failure or loading state.
  Pending background reads do not cause an overlapping poll; unmount aborts reads.
- HTTP/network/JSON failures retain the last usable observation. Confirmed removal
  and a confirmed empty roster remove accounts instead of retaining ghost entries.
- Calendar day totals and categories count weekly account entries consistently.
  Stale in-week entries are excluded from Upcoming; unknown/elapsed/later dates
  remain discoverable in Other rather than acquiring fabricated future dates.
- Calendar arithmetic uses local dates, not fixed 24-hour increments. Epoch
  ordering/countdowns survive DST, midnight, leap-day, month and year boundaries.
- Passing freshness/reset boundaries is clock-driven; no new polling timer or
  provider retry policy was added. Date selection survives roster updates.

## Test evidence

Node **22.14.0** was used for the repository checks. Commands and final results:

| Check | Result |
| --- | --- |
| `npm run typecheck` | Exit 0 |
| `npm run build` | Exit 0; existing Vite chunk-size warning remains |
| `node node_modules/vitest/vitest.mjs run <94 relevant files> --maxWorkers=4 --minWorkers=2` | Exit 0; **1,205 tests, 94 files passed** |
| `node scripts/verify-account-capacity.mjs http://localhost:5192` | Exit 0; actual Chromium/React hook and modal regressions passed |
| `git diff --check` | Exit 0 |

The 94-file selection covers account/quota/lane/reset/roster/cswap tests plus
shared modal/focus/overflow/control regressions. This is not the entire app suite.
Intermediate red/green logs and final command output are in
`/tmp/ccdeck-capacity-audit-*.log` for this session.

Browser reproduction uses an already-installed Playwright module and Chromium:

```sh
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
PLAYWRIGHT_EXECUTABLE=/path/to/chromium \
node scripts/verify-account-capacity.mjs http://localhost:5192
```

Start the existing Vite dev server first; pass its URL. The development-only
fixture imports the actual roster hook and modal. All account API routes are
intercepted in an isolated browser context; no external account operation occurs.
Tests cover response races, active identity changes, stale/fresh recovery,
reported reset expiry, counts, removal, 401/403/429/500, offline, timeout, malformed
JSON/schema, recovery, empty-day selection persistence, expansion, Escape/focus
return, pending polls and unmount cancellation. Persisted-store tests cover
corrupt-cache recovery, identity reuse and module-restart restoration; they do
not claim to exercise a complete desktop process restart.

Rendered captures were inspected at 1280×900, 390×650 and 900×480, including
expanded long identifiers and reachable bottom content. Artifacts:
`/tmp/ccdeck-capacity-audit-browser/{reported-future,recovered,viewport-390x650,viewport-900x480}.png`.
Fixtures use synthetic identifiers. No broad UI accessibility certification is
claimed; this audit verified the relevant focus/keyboard recovery regressions.

## Real source verification and remaining limits

A read-only comparison of **17 actual persisted usage rows** through the pure
`quotaFromStore` mapper found **zero window-percentage mismatches**. Only aggregate
counts were printed; no identities, credentials or tokens were logged. This
verifies stored-source normalization, not live OAuth/provider truth, identity
mapping of those particular live rows, or their rendered values. Live endpoints,
real account switching and paid operations were not invoked.

**Runtime timezone follow-up:** the tested Node 22 runtime has ICU 76.1 / tz 2024b.
The tested Chromium also formats `2026-10-25T00:30:00Z` as Chisinau 02:30 GMT+2;
Node 24.19.0 / tz 2026b formats it as 03:30 GMT+3. The newer result reflects
[IANA's 2026a correction](https://data.iana.org/time-zones/tzdb/NEWS) to Moldova's
transition rules. Application arithmetic remains instant-based; a stale runtime
database can still supply an incorrect local label during the transition hour.
Use up-to-date browser/desktop timezone data and verify the packaged Electron
runtime before promising that local-label guarantee. No hardcoded Moldova offset
or replacement timezone library was introduced. UTC details remain unambiguous.

Other limits: provider schedule changes/future failures cannot be predicted;
computer-clock skew is not corrected; an unknown identity has only a slot fallback;
legacy responses without UUID retain display-name identity fallback. UUID adoption
may reset an older saved presentation order once rather than reuse an ambiguous
identity. Real provider restart/auth recovery, Safari, Windows/Linux and packaged
Electron were not exercised in this Mac/Chromium audit.
