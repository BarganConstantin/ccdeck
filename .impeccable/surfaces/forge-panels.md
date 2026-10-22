# The GitHub and GitLab panels

Issue #2179. **Mode: Operate. World: the established ccdeck instrument panel.**
The task is to see where the code behind an agent's work stands (its branch,
its merge request, its pipeline, its issue) without leaving the deck. It is
not a forge client: it reads, never writes, and hands anything more to *Open
in GitHub* or *Open in GitLab*.

Source:
- Server: `src/server/forge-http.mjs`, `github-api.mjs`, `gitlab-api.mjs`,
  `forge-routes.mjs`, `src/server/integrations/forge.mjs`.
- Web: `src/web/components/forge/`, `src/web/components/ForgeHtml.tsx`,
  `src/web/forge-panel.ts`, `forge-lists.ts`, `forge-detail.ts`,
  `forge-html.ts`, `forge-types.ts`, `use-forge-read.ts`.
- Styles: `src/web/styles/forge-panel.css`, `forge-lists.css`,
  `forge-detail.css`.

## Thesis

The first screen answers **which branches moved, and where their merge
requests and pipelines stand**. One press answers **why the pipeline failed**
or **what the review says**. GitLab's own screens are the reference for order,
grouping and words: the project's Branches page, the Merge requests dashboard,
a merge request's page, Pipelines and Issues. GitHub is drawn in the same
screens with its own nouns, so nothing has to be learned twice.

## Rules

- **The host owns the frame** (#2178): the modal, its header, the split and
  the drill-in Back. The panel draws the toolbar, the tabs, the search, the
  lists and the item pages.
- **One panel, two forges.** The words come from `forgeWords`: Pull requests /
  Merge requests, Actions / Pipelines, Repository / Project, `#` / `!`.
- **A state is a mark and a word,** never a colour alone. The marks are one
  family of the panel's own, drawn on a 14-unit grid in `currentColor`
  (`GLYPHS` in `forge-panel.ts`, `StateGlyph` in `ForgeGlyphs.tsx`): passed,
  failed, running, pending, canceled, skipped, manual, no pipeline, open,
  draft, merged, closed, approved, changes requested, commented, review
  pending, warning. Never Octicons or GitLab's own drawings; merged is never
  purple.
  - Tones: ok `--ok`, bad `--err`, busy `--accent`, warn `--warn` (a GitLab
    failure that was allowed), idle `--muted`; the word is
    `--text-secondary`.
  - A badge is a 999px pill on a `--line` edge, its tone's edge mixed at 45%.
- **Selection is the integrations' shared row** (`ig-row` with
  `data-selected`, `integrations.css`): a fill of its own, distinct from the
  `--ctl-fill` hover, every word on it in `--text`, and a 600 title. A
  badge's word takes the row's ink while its mark keeps its tone. Forced
  colours outline it in Highlight. No coloured edge stripes.
- **A forge's colour is data, drawn small.** A label's colour is only a 7px dot
  (lists) or an 8px swatch (pages); its words stay in the theme's ink. A
  scoped label shows `scope | value`.
- **Shared controls only:**
  - `uh-range` strips: the tabs and a change's sections as tablists
    (`aria-selected`, the accent fill with the word in `--bg`), the filters
    as pressed segments (`aria-pressed`) with their counts.
  - `btn`, `glyph-btn`, `ap-manage-input`, `AnchoredPopover`, the global
    focus ring (offset `-2px` inside a row).
  - `.ig-open` is the link out to the forge (*Open in …*, *Full log*,
    *Create merge request*): `--accent`, underlined on hover, with the
    outward glyph.
- **The host's shared pieces, never a local copy:** the freshness line and
  Refresh (`IntegrationFreshness`), the failure note
  (`IntegrationFailureNote`), the search field (`IntegrationSearch`, which
  Escape empties first), the skeleton rows (`IntegrationSkeleton`), the faces
  (`IntegrationPerson`, `IntegrationAvatar`, `IntegrationAvatarStack`, the
  reader's own ringed), and an item's top line (`IntegrationDetailBar`, with
  `IntegrationCopy` for every copy button).
- **One press target per row.** A row is one button. A branch row's button is
  stretched under it (`.fgl-hit`) so its copy button and *Create merge
  request ↗* stay controls of their own; never a control inside a button.
- **The pane decides, not the window.** Container queries on the list
  (`fg-list`, `fgl`) and on the page (`fd`), because the reader sets the
  pane's width with the splitter.
- **No markup from the forge reaches the page.** Descriptions and titles go
  through `forge-html.ts`'s allow-list into React elements.
- **Images come through the asset route, or not at all.** An avatar falls back
  to its initials; a description's image to its link.
- **Reads are kept, never polled.** Refresh asks again; a failed refresh keeps
  the last answer, says "Not updated" in `--warn`, and puts one compact line
  over the list.
- **The page never sees a token.** It sees `tokenSaved`. The form explains the
  token where it is typed, asking for read access only.
- **The keyboard:** Escape goes popover or search, then the open item, then
  the modal, at every width, and focus returns to the item's row. A list is
  one Tab stop walked with the arrows (`useRovingRows`): Up, Down, Home, End,
  Right to open or enter a group, Left to fold it or go up to it; a row's
  own controls are stops on that row only. A job's log and a description's
  code block are stops of their own, so the keyboard can scroll them.
- **Phone:**
  - the item is its own screen with Back;
  - the tab strip is one row that scrolls sideways, the chosen tab kept in
    view; a change's sections are one row, each label over its count;
  - a narrow list's filters are one row: the state strip, the scope as a menu
    button, the sort as its glyph;
  - a row's facts wrap inside their own column and never run under the time;
    on a phone-narrow list the time's verb is for a screen reader only;
  - the gutters are 16px, and the panel is under More.

## Measurements

- **Panel:** 13px text. Toolbar, tabs and search at 20px gutters (16px under
  640px), 12px apart. Refresh is a 36px `glyph-btn`; it spins while loading.
- **Tabs:** 28px segments. Under a 520px list: one row of whole names that
  scrolls sideways.
- **Search:** the shared field; on a narrow list its placeholder is
  "Search, or paste a … link". *Open* appears beside it for a link.
- **Rows:** a bordered `--panel` body on `--r-panel`, rows divided by
  `--line-soft`, at least 48px, 8px 14px. Title and facts over meta and time;
  under a 520px list the facts wrap in their own column beside the time. A
  press deepens the row's tone a step (`--text` at 10%) and nothing moves.
- **Branch rows:** the name in mono 13px/500 with copy (24px, 32px on touch);
  behind | ahead with a 1px rule and the pipeline in fixed widths
  (`calc(8ch + 14px)` and 6.5em) so they line up down the list. Three
  layouts: wide, beside an open page (under 820px), narrow (under 520px).
- **Pipeline rows:** the status in an 8.5em column, the duration in mono
  under it, the title clamped to two lines.
- **Reviewers:** 20px shared faces, each with a 13px badge carrying its
  state's glyph (`--ok` approved, `--err` changes requested). Assignees are
  the shared stack: three faces, then "+N".
- **Labels:** a dot in the label's colour and its name; a scoped label as
  `scope | value`, the value cut first.
- **Picker:** a `btn` naming the group quietly (`--text-secondary`, cut first)
  and the project whole (600). Its popover is `min(400px, 100vw - 24px)`,
  portalled into its own span inside the dialog; options 38px (44px on
  touch), the current one checked in `--accent`; the list scrolls at
  `min(380px, 52dvh)`.
- **Item page (`.fd`):** 12px 20px 40px padding.
  - The top line is the shared detail bar, sticky on `--panel` across the
    page's padding (`--ig-detail-pad` on `.fd`): the reference in mono 12px,
    its path `--muted` and cut first, its number `--text` and never cut; the
    copy button; the link out; and Close on a wide window only.
  - Title 16px/600. The byline is a 12px `--muted` sentence at line-height 2,
    with branch chips in mono 11px on `--ctl-fill`.
  - `.fd-jump` links to another item: 28px, fills `--ctl-fill` on hover, its
    fill 8px past the text, a › at the end.
  - Side facts: a 216px column with 11px uppercase labels from a 700px pane;
    under that, a bordered box above the page with a 104px label column
    (84px under 480px).
  - Sections: under a 480px pane one row, each label over its count.
  - A link inside a title is underlined.
- **Threads:** bordered `--panel` cards; the head on `--ctl-fill` with
  `path:line` and an *outdated* badge, its quiet words lifted to
  `--text-secondary` on that fill (as a hovered file row's are); comment
  bodies indented 26px.
- **Files:** a status tag (added `--ok`, deleted `--err`) and a mono +/−
  (`--ok` / `--err`, `--muted` at zero). Never a diff.
- **Jobs:** 40px rows with chevron, state, name, *allowed to fail* (a `--warn`
  edge) and the time in mono; the body indented 32px under the state.
- **Log:** a `<pre>` on `--bg` with a `--line` edge, mono 12px/1.5, never
  wrapped (it scrolls sideways, so a line number stays by its line), at most
  `min(360px, 55vh)`, drawn from its end, and a keyboard stop named after its
  job. Error lines `--err`, warnings `--warn`.
- **Descriptions (`.forge-html`):** headings 18, 16 and 14px (the 16px one
  underlined in `--line`), code and `pre` on `--ctl-fill`, a 3px `--line`
  quote edge, tables in a scroller, links in `--accent`. A task list's boxes
  are drawn marks named "done" or "to do", never inputs.
- **Failures:** a box on `--panel` with an `--err` edge at 35%; the compact
  line over kept rows has a `--warn` edge.
- **Avatars:** the shared face: a picture, or two initials in `--text` that
  grow with the text size; the reader's own face ringed in `--accent`.
- **Forced colours:** the chosen tab and section fill with Highlight and
  HighlightText; the filter segments take the deck's `aria-pressed` rule.
- **Motion:** a chosen tab's or section's content fades in over 100ms;
  nothing slides.
- **Reduced motion:** no fades, press scales or row transitions; Refresh does
  not spin.

## Verified 2026-10-19

- Linux, headless Chromium, with an isolated deck, against GitHub and GitLab.
- 1440, 390 and 320px, in Rider Black and light.
