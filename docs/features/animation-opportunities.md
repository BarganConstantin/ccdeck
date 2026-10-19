# Animation opportunities in ccdeck

Reviewed 2026-10-19 in `fix/radar-undecoded-connections`.
Scope: missing motion that helps users understand waiting or a state change.
This is an inspection of local source and existing motion tests, not measured
production frequency. Frequency estimates follow the entry points. Existing
Radio, Usage History and Tool Activity improvements are already implemented.

## Prioritized opportunities

| # | Location / current behavior | Purpose | Frequency | Suggested motion | Function / reduced motion | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `src/web/components/AccountProjectsModal.tsx:283`: initial report is a bare “Loading…” line | State indication; prevent a jarring change | Occasional, from an account menu | A decorative document-to-project-folders drawing; one scan travels 12px at 1600ms, `cubic-bezier(0.4, 0, 0.2, 1)`; content entry opacity .65→1 over 140ms, `cubic-bezier(0.16, 1, 0.3, 1)` | Only during initial loading; leave existing reports visible on refresh; no fictional project names or metrics. Pause while hidden. Static scan under Reduce Motion. | Done locally |
| 2 | `src/web/components/SessionUsageModal.tsx:79`: “Reading local session usage…” appears alone | State indication | Occasional, inspecting one session | A compact document-reading indicator, 6px indeterminate travel/opacity at 1400ms; result opacity .7→1 over 120ms, `cubic-bezier(0.16, 1, 0.3, 1)` | Do not animate token counts or pricing changes; no minimum wait. Pause while hidden; static indicator under Reduce Motion. | Done locally |
| 3 | `src/web/components/QuotaHistoryModal.tsx:123`: text-only initial history read | State indication | Occasional, opening quota history | Recorded-history icon with an indeterminate traveling dot, 16px over 1600ms; results fade in over 120ms, `cubic-bezier(0.16, 1, 0.3, 1)` | Never move a quota needle or percentage before data exists. Preserve refresh/error/missing-account distinctions; static icon under Reduce Motion. | Done locally |
| 4 | `src/web/components/ProcessListModal.tsx:293`: text-only first process read | State indication | Occasional initial opening; updates are frequent | Small scan indicator, 8px translate/opacity over 1200ms; reveal artwork only after 150ms (text immediate), to avoid fast-load flashes | Initial read only; process rows and polling must stay immediate. Pause while hidden; static icon under Reduce Motion. | Done locally |
| 5 | `src/web/components/SectionHistoryModal.tsx:348`: “Reading…” before sensor history | State indication | Occasional first history read | Small history icon, 8px indeterminate travel at 1400ms, delayed 150ms; result opacity .7→1 over 120ms, `cubic-bezier(0.16, 1, 0.3, 1)` | Do not animate live chart readings or fabricate samples. No delay to showing data. Static indicator under Reduce Motion. | Done locally |

Each candidate passes the four gates: occasional exposure, an explicit waiting
or continuity purpose, immediate interaction with arrivals below 300ms, and no
movement of functional data. Loop duration is an indeterminate waiting cadence,
not an entrance duration. Implement and verify one surface at a time. These
recipes are proposals, not a requirement to reuse an identical loader everywhere.

## Deliberately rejected

- `SettingsModal.tsx` section navigation: keyboard-heavy navigation must stay
  immediate. **Frequency/input gate.** No generic page fade on every keypress.
- `MachinePanel.tsx` and `ProcessListModal.tsx` live rows: CPU, memory, ordering
  and process counters are functional data. **Function/frequency gate.** No
  animated counting, animated reordering, or decorative chart drawing.
- `BrowserWatchModal.tsx:135`: already has an animated indeterminate loading
  bar (`browser-watch.css:408`). **No missing state indication.** No second loop.
- `EmptyHero.tsx`: already has an intentional cursor motion. **Function gate.**
  No extra orbiting or pulsing decoration on the daily workspace.
- Shared dialog openings, rail controls and switches: existing modal entrance
  and press conventions are covered by `canvas-motion.test.ts`. **No missing
  feedback.** Avoid a competing animation system.

## Completion

All five identified opportunities are implemented locally. Each uses the existing
theme and modal conventions, adds no runtime dependency and never delays data
arrival. Projects and Session Usage have their own document-reading artwork;
Quota History, Processes and Sensor History share `ReadActivity` with distinct
illustrations and cadences. No animation is attached to polling rows or chart
paths.

The final source sweep also checked `ToolAuditInspector.tsx`, `LazyDialog.tsx`,
`DeckDialogs.tsx`, Radio and the remaining modal loading branches. Tool details
are frequently changed while reading the report, so their inline status stays
quiet. Tool Activity already has an initial skeleton; lazy chunk failures use
the shared modal feedback. Radar's waiting state can remain open continuously,
so an indefinite decorative loop there would add distraction. The removed File
tab's unused component is outside this shipped surface. No further animation
was justified in this pass.

## Verification for item 1

- 54 relevant tests passed; TypeScript and the production build passed.
- Chromium: 1440px Rider Black, 390px White Contrast, 320px Rider Black,
  plus 1440px White Contrast with Reduce Motion.
- Checked motion across time, pause/resume on hidden tabs, a delayed report,
  a report arriving while ccusage is still pending, period changes retaining
  the previous report, immediate responses, error and Escape dismissal.
- Browser responses for project activity were isolated fixtures; no claim that
  the illustration reports real project counts or scan progress.


## Verification for item 2

- 43 relevant tests passed; TypeScript and production build passed.
- Chromium at 1440px Rider Black, 390px White Contrast, 320px Rider Black,
  and 1440px White Contrast with Reduce Motion.
- Checked movement over time, hidden-tab pause/resume, delayed success,
  refresh failure/not-found, fast replies, Codex pricing scenario changes,
  Escape/Close, and closing before a pending read completes.
- Session responses and the session list were isolated browser fixtures.
  The existing parsing, billing estimates and network behavior are unchanged.


## Verification for items 3–5 and final pass

- 94 relevant quota/process/sensor/modal/motion tests passed, followed by 56
  Projects, Session Usage, Usage History and Tool Activity regression tests.
  TypeScript, the production build and `git diff --check` passed.
- Chromium fixtures at 1440px Rider Black, 390px White Contrast, 320px Rider
  Black and 1440px White Contrast with Reduce Motion verified the three new
  loaders over time, hidden-tab pause, success, empty results, errors where the
  surface supports them, dismissal and layout without horizontal overflow.
- Quota checks covered refresh, empty history, failed read and provider changes.
  Process checks covered initial success, a subsequent unsuccessful poll retaining
  existing rows, and an unsuccessful first read showing the retry message.
  Sensor checks covered initial charts, empty history and closing while pending.
  A separate desktop check crossed the 20-second sensor poll: the result DOM
  stayed mounted and its entrance animation did not replay.
- All browser fixtures are isolated and are not claims about the owner's quota,
  processes, billing or real sensor measurements. Existing retry/error semantics
  remain in place; no backend lifecycle or collection changes were needed.
