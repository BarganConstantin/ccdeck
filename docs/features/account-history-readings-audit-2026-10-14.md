# Account History: zero readings and two-axis inspection

Owner-requested follow-up to the History quality gate. No provider settings, credentials or stored readings were changed.

## Zero-reading audit

Read-only checks traced existing claude-swap usage cache → `passiveRoster` → stable account identity hash → persisted snapshots → history API and the account-panel API. Outputs were aggregate counts, without account names, emails or credentials.

| Window | Matched cache/snapshot accounts | Source readings at 0% | Snapshot readings at 0% | Latest panel/history comparison |
|---|---:|---:|---:|---|
| 5-hour | 12 of 12 | 4 | 4 | 12 of 12 equal; no zero/nonzero mismatch |
| 7-day | 12 of 12 | 1 | 1 | 12 of 12 equal; no zero/nonzero mismatch |

An earlier panel sample differed from saved snapshots for three nonzero 5-hour values and one nonzero weekly value; none was a false-zero mismatch. A later synchronized comparison matched all twelve accounts in both windows. History and the live panel can reflect different observation times. The interface now states that the live panel may have newer readings; sidebar timestamps remain explicit.

Code inspection confirms missing or non-finite usage is not converted to zero: passive normalization emits no lane, snapshot windows remain null, and UI displays unknown/no reading. Reported zero is retained as zero. Selecting 5-hour versus 7-day compares different quotas; both must be compared against the corresponding panel lane. These checks establish local-cache/API consistency, not direct provider correctness or the validity of every historical observation.

## Implemented interaction changes

- History opens on **7-day window**, still using the existing Last 7 days lookback.
- Wheel zoom affects time and usage around the pointer; drag pans both axes. Window switching shares both viewports.
- Usage navigation remains inside 0–100%, with a five-percentage-point minimum visible span. Time retains the five-minute minimum.
- Keyboard arrows navigate both axes; double-click or 0/Home resets both. Account/period changes reset both.
- Native touch double-tap zoom, diagonal drag and reset are verified with Chrome CDP. Zoomed plots own both touch axes; unzoomed plots retain vertical page scrolling.
- Accessible descriptions follow the actual displayed usage bounds. Inspector selection pans the usage range to reveal the chosen real reading, without changing its percentage.
- Hover-readable areas show a pointer cursor; dragging keeps the grabbing cursor.

## Verification

- Axis navigation, snapshots and passive integration: **39 tests / 3 files passed**, `npm run test -- src/web/__tests__/account-history-axis.test.ts src/web/__tests__/account-snapshot-history.test.ts src/web/__tests__/account-snapshot-passive.test.ts`.
- `npm run typecheck` and `npm run build`: passed.
- Existing optional Playwright runner: passed, including weekly default, X/Y zoom, keyboard vertical pan, diagonal mouse/native touch pan, reset, dynamic accessible bounds, inspector point visibility and prior workflows. `default-weekly.png` and `zoomed.png` record the new views.
- Independent scoped review scored its two findings—static accessible bounds and vertical-touch gesture ownership—resolved after fixes and browser confirmation.

No direct provider response, physical touch device, Safari/Firefox or full screen-reader session was verified. Existing quality-gate evidence remains historical; this follow-up does not claim another full repository or 269-test run.
