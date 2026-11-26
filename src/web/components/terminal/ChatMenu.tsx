// Chat's actions, as rows of the pane's ⋯ (StageHeader.tsx PaneMore): what the
// deck can do for the session Chat shows. The stage decides each one and the
// words it says (chat-actions.ts says what each is, and whose); this draws them.
//
// ONE MENU, NO NEW ROW. The header keeps its one measured row: in Chat the ⋯
// is drawn at every width, and these lead its menu. Where the header is too
// narrow for its controls, the ⋯ carries those after them, as it always did.
//
// A ROW THAT CANNOT GO NOW SAYS WHY. Compact while a turn is at work, while a
// compaction runs, or on a session nothing can be sent to stays an item the
// arrows reach and a screen reader names unavailable (aria-disabled), with the
// reason under its word; a press does nothing and the menu stays open. A
// disabled button would be skipped by the arrows, and the reason with it.
//
// SESSION DETAILS fold under one row (aria-expanded), closed until opened and
// then kept open in this browser. Each detail is a sentence the arrows reach
// and a screen reader reads, drawn as the menu's note: there is nothing to
// press in it. A figure the deck does not have is not a row.
import { useId, useState } from "react";
import { useT } from "../../i18n";
import { readDetailsOpen, writeDetailsOpen } from "../../chat-actions";
import { KitIcon } from "../kit-icons";

export interface ChatMenuView {
  /** Claude Code's /compact, for a session whose compaction the deck can
   *  follow; `blocked` is why it cannot go now, null when it can. */
  compact?: { blocked: string | null; run(): void };
  /** Puts the last reply on the clipboard; left out while there is none. */
  copy?(): void;
  /** The Board, with this session's card brought into view. */
  board?(): void;
  /** The pane's own switch to Term. */
  term(): void;
  /** Session details, a sentence a row; with none, no fold is drawn. */
  details: readonly string[];
}

/** How a row is pressed: the ⋯ takes the focus back and the menu closes
 *  before the action runs, so what it opens or moves hands the focus on from there. */
export type MenuPick = (run: () => void) => void;

export default function ChatMenuRows({ view, pick }: { view: ChatMenuView; pick: MenuPick }) {
  const t = useT();
  const id = useId();
  const [open, setOpen] = useState(readDetailsOpen);
  const compact = view.compact;
  const why = `${id}-why`;
  return (
    <>
      {compact && (
        <button type="button" role="menuitem" className="ap-menu-item ts-act" data-act="compact"
          aria-disabled={compact.blocked ? true : undefined}
          aria-describedby={compact.blocked ? why : undefined}
          title={t("board.chat.compose.cmd.compact")}
          onClick={() => { if (!compact.blocked) pick(compact.run); }}>
          <span className="ts-act-word">{t("board.chat.actions.compact")}</span>
          {compact.blocked && <span id={why} className="ts-act-why">{compact.blocked}</span>}
        </button>
      )}
      {view.copy && (
        <button type="button" role="menuitem" className="ap-menu-item" data-act="copy" onClick={() => pick(() => view.copy?.())}>
          {t("board.chat.actions.copyReply")}
        </button>
      )}
      {view.board && (
        <button type="button" role="menuitem" className="ap-menu-item" data-act="board" title={t("board.chat.actions.boardTip")}
          onClick={() => pick(() => view.board?.())}>
          {t("board.chat.actions.board")}
        </button>
      )}
      <button type="button" role="menuitem" className="ap-menu-item" data-act="term" onClick={() => pick(view.term)}>
        {t("board.chat.showTerm")}
      </button>
      {view.details.length > 0 && (
        <>
          <div role="separator" className="ap-menu-sep" />
          <button type="button" role="menuitem" className="ap-menu-item ts-act-fold" data-act="details" aria-expanded={open}
            onClick={() => { const next = !open; setOpen(next); writeDetailsOpen(next); }}>
            <span className="ts-act-chevron" aria-hidden="true"><KitIcon name="chevron-right" /></span>
            {t("board.chat.actions.details")}
          </button>
          {open && view.details.map(row => (
            <button key={row} type="button" role="menuitem" className="ap-menu-item ap-menu-note ts-act-detail" aria-disabled="true">
              {row}
            </button>
          ))}
        </>
      )}
    </>
  );
}
