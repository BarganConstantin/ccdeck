# Tool activity

Issue #2122. **Mode: Operate. World: the established ccdeck instrument panel.**
Redesigned 2026-10-15 at the owner's request: "a much better and more useful
experience for the people who use it, without complicated things" — replace
the old look if needed. The earlier report (four comparison charts, a full
operations table, P95/median endpoints, interval and coverage vocabulary, a
metric glossary and help popovers) is the anti-reference: it answered the same
four questions several times in words a user had to learn first.

Source: `src/web/components/ToolAuditModal.tsx`, `ToolAuditDrawer.tsx`,
`ToolAuditInspector.tsx`, `ToolAuditHistory.tsx`, `ToolAuditSettings.tsx`,
`src/web/tool-audit-report.ts` (orders, findings, summary, dates),
`src/web/operation-glossary.ts` (descriptions), `src/web/tool-audit.ts` (types,
formatting, fetch) and `src/web/styles/tool-audit.css`. The collector, the API
and its numbers are unchanged.

## Thesis

Read the page top to bottom and stop when the question is answered:
**how much** (one sentence), **what is worth a look** (up to three findings),
**which tools** (one list, four orders), **what one tool did** (details).

## Rules

- The summary is a sentence, not a row of tiles. Numbers in it are the only
  emphasis.
- A finding is a fact off the rows with a sample floor (see
  `docs/features/tool-audit.md`); none is shown rather than a weak one.
- One list. Orders are Most used, Most time, Slowest (median), Failures; the
  sorted column is the bright one and draws the bar. No second view of the same
  numbers on the page.
- Words a user already has: calls, total time, usually, failed, longest. No P95,
  interval, containing call, coverage or snapshot.
- Unknown tools get no description rather than "unverified". MCP tools show their
  own name with the server as the description.
- Honesty lives in "How this is counted", six plain lines, folded.
- Selection is a quiet fill; no coloured edge stripes (owner, 2026-10-13).
- The details width is the reader's: a draggable, focusable splitter (owner
  request, 2026-10-15), remembered per browser, never squeezing the list under
  420px.
- Shared controls only: `uh-range` strips, `btn`, `sm-select`, the global focus
  ring.

## Verified 2026-10-15

Linux, Chrome via DevTools, isolated `CCDECK_HOME` with a seeded 8-day journal
(1,742 calls, Claude and Codex): 1440, 1280, 390 and 320px; dark (Rider Black)
and light; list orders and search; findings opening details; details beside the
list and as a phone sheet; no horizontal overflow at 320px.

## Large modal — 2026-10-19

Owner direction: show Tool activity as a large modal rather than covering the
workspace as a page. The report is centered at 90vw × 90dvh on all screen sizes. It uses the shared modal scrim, rounded border and
contained report/detail scroll regions. The header has a close action instead
of Back to workspace. Escape, focus return and nested tool details keep their
existing behavior; a deliberate click on the outer scrim also closes it.

The report now composes the shared `.modal` surface directly, inheriting its
subtle `--line` border, corner radius, shadow and entrance. Only report sizing
and content layout are specialized; no stronger control border surrounds it.

The Tool activity rail glyph is a simple wrench, without a magnifier. It uses
the existing 14-unit viewBox, 1.4 stroke, round caps/joins, muted currentColor
and standard 17px desktop rail size. No separate sizing or colour override.

The first visible tool is selected automatically once after report data arrives
on opening. Closing its details leaves them closed; polling and sorting do not
force them open again. Reopening the report selects its first tool afresh.

## Details motion — 2026-10-19

The first tool selection is committed with the first report response, so no
unselected report frame flashes before its inspector. The desktop workspace
keeps three tracks and transitions its detail allocation over 220ms on open,
180ms on close using exponential easing. Drag resizing bypasses the transition.
The integrated inspector's content enters with a 6px horizontal/opacity motion
for 140ms on operation changes; the previous animation cancels on interruption.
No row stagger, counters, chart entrances or new dependencies are added.
Reduced motion disables these spatial effects. The mobile sheet retains its
existing arrival and focus handling. All report controls remain usable during
transitions.

## Skills tab — 2026-10-19 (#2181)

Owner direction: skill usage beside Tool activity, for both Claude and Codex.
Source: `SkillActivity.tsx`, `SkillInspector.tsx`, `src/web/skill-activity.ts`;
the server side is `tool-audit-skills.mjs` and `codex-skills.mjs`.

- A Tools | Skills tablist in the header switches views under the same filters;
  the open tab is a fill bar under its word, never a border. Opening the modal
  shows Tools, as before.
- The Skills view is the Tools view's grammar again — summary sentence, one
  list, details beside it — so nothing new has to be learned. Its thesis: which
  skills ran, how often, how lately.
- Repeats (`/loop` ticks) are named in the sentence and on the row, never
  counted as uses. A period that starts before counting did says so instead of
  showing quiet days as unused.
- A latest use links to its session only while that session is on the canvas;
  otherwise it says "not on the canvas" rather than linking to nothing.
- The Tools view's `Skill` row offers "See which skills ran →", since the row
  alone cannot say which.
