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
