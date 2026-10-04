// THE BAR'S THREE LEAST-OPENED CONTROLS, FOLDED INTO ONE AT A PHONE'S WIDTH.
//
// The topbar's controls do not shrink (#849): the readout group gives first,
// from the left, so what a narrow bar loses is the wordmark and never a way
// in. At a phone's width that stopped holding once Feedback joined the bar
// (#1853). Nine controls are 314px, and the bar at 360 has 340 inside its
// padding, so the readout group came down to a sliver and the waiting pill —
// the one light the bar exists to show — was cut off its left edge; at 320 the
// last control went off the right one. Under 480px, History, Browser watch and
// Feedback — the three that open a dialog rarely wanted on a phone — leave the
// bar for this ⋯ and the menu it opens, which gives the pill its room back.
// The three buttons are still drawn above 480px and the ⋯ is not: the sheet
// swaps them (`.tb-fold`, `.tb-more`, topbar.css).
//
// A menu like an account's ⋯ (AnchoredPopover): Up and Down walk it, Escape
// and a press elsewhere close it. Each item opens its dialog with focus handed
// back to the ⋯ first, so the dialog gives it back there when it closes.
import { useState, type Dispatch, type SetStateAction } from "react";
import AnchoredPopover from "./AnchoredPopover";

type Toggle = Dispatch<SetStateAction<boolean>>;

const MORE_ID = "tb-more";
const MENU_ID = "tb-more-menu";

export default function TopbarMore({ watchUnseen, setUsageHistoryOpen, setBrowserWatchOpen, onFeedback }: {
  /** Browser Watch's unread findings, which the ⋯ carries while its button is folded. */
  watchUnseen: number;
  setUsageHistoryOpen: Toggle;
  setBrowserWatchOpen: Toggle;
  onFeedback: () => void;
}) {
  /** Which end the open menu's focus started at, or null while it is shut. */
  const [menu, setMenu] = useState<"first" | "last" | null>(null);
  const open = menu !== null;
  const pick = (show: () => void) => () => {
    document.getElementById(MORE_ID)?.focus();
    setMenu(null);
    show();
  };
  return (
    <>
      <button
        id={MORE_ID}
        className="btn icon-btn tb-more"
        onClick={() => setMenu(open ? null : "first")}
        onKeyDown={e => {
          // Down opens at the first item and Up at the last, the way the
          // accounts' ⋯ and a native menu button do.
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          e.preventDefault();
          setMenu(e.key === "ArrowUp" ? "last" : "first");
        }}
        title="More — usage history, Browser watch and feedback"
        aria-label={`More: usage history, Browser watch, feedback${watchUnseen > 0 ? `, ${watchUnseen} unread` : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? MENU_ID : undefined}
      >
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="2.8" cy="7" r="0.7" />
          <circle cx="7" cy="7" r="0.7" />
          <circle cx="11.2" cy="7" r="0.7" />
        </svg>
        {watchUnseen > 0 && <span className="bw-badge" aria-hidden>{watchUnseen}</span>}
      </button>
      {open && (
        <AnchoredPopover
          anchorId={MORE_ID}
          id={MENU_ID}
          className="ap-pop"
          role="menu"
          labelledBy={MORE_ID}
          start={menu}
          onClose={() => setMenu(null)}
        >
          <button type="button" role="menuitem" className="ap-menu-item"
            onClick={pick(() => setUsageHistoryOpen(true))}>Usage history</button>
          <button type="button" role="menuitem" className="ap-menu-item"
            onClick={pick(() => setBrowserWatchOpen(true))}
          >{watchUnseen > 0 ? `Browser watch · ${watchUnseen} unread` : "Browser watch"}</button>
          <button type="button" role="menuitem" className="ap-menu-item"
            onClick={pick(onFeedback)}>Send feedback</button>
        </AnchoredPopover>
      )}
    </>
  );
}
