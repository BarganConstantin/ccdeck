# Integrations and the Jira panel

Issue #2178. **Mode: Operate. World: the established ccdeck instrument panel.**
The task is to glance at the ticket behind the work an agent is doing,
without leaving the deck. It is not a Jira client: it reads, never writes,
and hands anything more to *Open in Jira*.

Source:
- Server: `src/server/integrations/` (core and `jira.mjs`).
- Web core: `src/web/integrations/`, `IntegrationsSection.tsx`,
  `IntegrationConnectionForm.tsx`, `IntegrationModal.tsx`,
  `IntegrationSplit.tsx`, `IntegrationAvatar.tsx`.
- Jira panel: `JiraPanel.tsx`, `JiraBacklog.tsx`, `JiraIssueDetail.tsx`,
  `JiraParts.tsx`, `JiraTokenHelp.tsx`, `src/web/jira-board.ts`,
  `jira-html.tsx`, `use-jira-board.ts`.
- Styles: `src/web/styles/integrations.css`, `jira.css`.

## Thesis

The first screen answers **what is in this sprint and what is mine**. One
press answers **what does this ticket say**. Jira's own Backlog page is the
reference for order, grouping and totals, so nothing has to be learned twice.

## Rules

- **The host owns the frame.** The modal shell, its header (mark, name, which
  connection, Close), the split and the drill-in Back belong to the host. A
  provider draws only its panel. #2179's GitHub and GitLab panels use the same
  frame.
- **Group like Jira's Backlog page:**
  - active sprints open, future sprints and the backlog closed, closed sprints
    on demand;
  - kanban boards get To Do, In Progress and the last fortnight's Done.
- **Each issue once.** A sub-task sits under its parent; a parent outside the
  results is a muted context row, never a duplicate.
- **Totals by status category,** in time or points as the board estimates,
  and written the way Jira writes them ("1w 3h").
- **Selection is a quiet `--accent-dim` fill.** No coloured edge stripes
  (owner, 2026-10-13).
- **Shared controls only:**
  - `btn` and `glyph-btn`, `sm-select`, `ap-manage-input`, the global focus
    ring;
  - `.jr-open` is the anchor twin of `btn`.
  - Chips are `btn` with `aria-pressed`.
- **No SVG from the tracker reaches the page.** Icons Jira serves as SVG are
  the panel's own drawn glyphs.
- **Images come through the asset route, or not at all.** A failed image
  becomes initials, a link, or the emoticon's text.
- **The page never sees a token.** It sees `tokenSaved`. The form explains
  the token where it is typed.
- **Phone:**
  - the detail is its own screen;
  - the toolbar steps aside behind Back;
  - the filter chips are one row that scrolls sideways;
  - Jira is under More.

## Verified 2026-10-19

- Linux, headless Chromium, with an isolated deck and the mock Jiras
  (`scripts/mock-jira.mjs`), Server 9.0.0 and Cloud.
- 1280, 900, 390 and 320px, in Rider Black, light, black-contrast and
  white-contrast, and in forced colours with reduced motion.
- Connecting and the rail control; I, Escape order and focus return; the Tab
  path into the rows and arrow keys inside; the detail beside the list and as
  its own screen.
- Boards, kanban, filters, the Cloud switch, and the 401/403/429/500 states
  with Reconnect.
- No page-level horizontal overflow at any width.
