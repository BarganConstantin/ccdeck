# Account capacity — final quality gate

2026-10-13 · `feat/account-capacity-redesign`

**Verdict: SHIP WITH FOLLOW-UPS.** No significant outstanding UI/UX blocker was found in the tested Chromium states. Cross-browser and assistive-technology coverage remains a follow-up, rather than a claim of certification.

## Actual Impeccable workflow

Installed version: **4.1.1**. Commands are Markdown instruction workflows and supporting scripts; nonexistent slash-command shell executables were not invoked. The session context and incumbent design system were already loaded, and were reused.

- **critique:** independent assessment A inspected incumbent desktop/mobile screenshots and source without detector input. It found one optical issue: the countdown caption stranded “reset” on its second line. Calendar selection and today treatment were already clear.
- **audit:** independent assessment B ran the deterministic detector exactly once, unscoped, against `src/web/components/AccountResetCalendar.tsx`: exit 0, JSON `[]`, zero findings. Manual review nevertheless exposed an invalid-date rendering crash and potential focus loss on clock-driven reclassification.
- **typeset / clarify:** keep the countdown and numeric roles; shorten its visible caption to “reported reset”, retaining “until ” for assistive technology. It fits on one line without increasing the card.
- **harden:** exclude dates outside JavaScript’s representable range from report timestamps. Restore focus to the active category when a focused account control is removed by a data/clock update, only when no other control has acquired focus; prevent scrolling.
- **polish:** inspect before/after, selected/hover/keyboard states, mobile, short-window bottom and expanded details. Preserve the existing layout, geometry, palette and 48–49px closed rows. No benefit justified further visual changes.

Questions skipped: the user authorized autonomous final verification; no destructive or unresolved product decision arose.

## Confirmed fixes

1. **Invalid timestamp:** calendar classification already guarded invalid dates, but account disclosures used report timestamps that only checked finiteness. A finite `1e20` reached `toISOString()` and threw. Both report windows now reject unrepresentable dates, display unknown reset time, and have a rendering regression test.
2. **Focus recovery:** an expiring reset or aging observation can remove the focused Upcoming disclosure. Browser checks now explicitly advance the existing clock across both boundaries and verify focus returns to the selected category, rather than the document body. No extra timer or duplicated data state.
3. **Countdown caption:** single-line visible qualifier; complete spoken phrase remains. The reported-time uncertainty is preserved.

## Preserved semantics and interactions

Today uses `aria-current="date"` and an underline; selection uses `aria-pressed`, tinted fill and accent edge. Hover is neutral; keyboard focus uses the shared focus-visible ring. Pointer category/date interactions do not show that keyboard ring. Zero-reset days still select an empty filtered agenda with an explicit zero count; All days restores the full list.

The three category counts, selected states, filtering and return navigation remain consistent. Needs fresh data counts in-week schedules excluded for freshness; Other may also contain stale observations. Usage is reported capacity used, not a software error: the existing amber threshold at 70% also applies to 100%; blue remains below that threshold. Unknown values remain unknown.

Reported times remain provider observations, not confirmed renewed capacity. Existing local timezone formatting, DST-aware calendar boundaries, sorting, roster refresh, retained failed readings, native expansion, both usage windows and modal dismissal are preserved.

## Verification actually run

- `npm run typecheck`: **PASS**.
- `npm run build`: **PASS**, 18.09s; existing >500kB chunk warning remains.
- Targeted Vitest suite: **263 tests / 15 files PASS**, including reset calendar, report semantics/order, countdowns, focus trap/dismissal, control contrast, motion, text tiers and panel overflow.
- Chromium browser batch: **PASS**. All/selected/empty day; all categories; account expansion/current account; tied resets; low/high usage; long identifiers; initial empty/loading/failure/recovery; all-stale/no-upcoming; view/sort retention; modal Tab/Escape/opener restoration; normal/reduced motion; expired/stale focused-account recovery; malformed reset disclosure.
- Nine supported themes checked with settled computed text contrast; sampled minimum **4.89:1**. Forced-colors meter track and selected-control behavior checked. These are targeted checks, not a full WCAG certification.
- Bounds and scrolling: 1280×900, 1024×500, 390×844, 320×568 and 320×360. Narrow targets and reachable short-window bottom verified. Closed scheduled rows remain 48–49px.
- No lint script is configured. No page errors were reported by the successful browser run.

Real source components were compiled by Vite and rendered with synthetic example account data/API responses. No private telemetry was exposed. Temporary fixture source was removed. The first new harness attempt stopped on an asynchronous locator assertion; after waiting for roster replacement, the complete batch passed. This was a harness timing issue, not a product failure.

## Screenshots and local reproduction

Before and after at identical viewport sizes:

- `/tmp/ccdeck-capacity-gate/before/calendar-desktop.png`
- `/tmp/ccdeck-capacity-gate/after/calendar-desktop.png`
- `/tmp/ccdeck-capacity-gate/before/calendar-320.png`
- `/tmp/ccdeck-capacity-gate/after/calendar-320.png`

Additional captures include `calendar-hover`, `calendar-keyboard-focus`, `selected-day`, `empty-day`, `other-expanded`, `older-expanded`, `many-top/middle/bottom`, `calendar-320-short-bottom`, `elapsed-focus-restored`, `stale-focus-restored` and `invalid-reset-safe`. Baseline countdowns differ because captures were made at different real times; viewport geometry is identical.

Harness: `/tmp/ccdeck-radio-browser/capacity-gate.mjs`. Logs: `/tmp/ccdeck-capacity-gate-{browser,tests,typecheck,build}.log`. These are local temporary artifacts, not durable repository assets.

## Remaining follow-ups / stop decision

Safari/Firefox, a full screen-reader session, physical touch, actual browser 200% zoom and repeated-hour DST display disambiguation were not verified. Local calendar boundary/DST unit coverage passed, but does not establish all timezone-display edge cases. Broadcaster/playback concerns are outside this feature.

Independent final visual confirmation returned **SHIP** after inspecting desktop, selected-day, keyboard-focus and narrow/short captures; it did not rerun the parent’s checks. Overall sign-off retains platform verification follow-ups.

Final review found no justification for another composition, palette or density change. Stop here; retain the design and perform the remaining platform-specific checks during release QA.
