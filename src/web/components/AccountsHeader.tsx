// The accounts panel's header: its title, and the controls that act on the
// panel as a whole — add an account, reload, a ⋯ with the rest, close. While
// claude-swap is missing only the close is drawn: + and ↻ would ask a tool
// that is not there, and the body's "Set up" is the way on.
//
// ONE LINE (V4 top-10 #10). Five icons — ⓘ, +, ↗, ↻, × — and the title did not
// fit the column's 264px, so the header wrapped onto two lines. + stays out
// because it is the act this panel is opened for most. ↻ stays out because it
// is the one control here that shows a state: it turns while a reload the
// reader asked for is out, which can be up to 30 seconds of claude-swap, and a
// menu that closed on the press could not show that. × is every panel's close.
// The other two — sharing several accounts, and the panel's video that the ⓘ
// held — are items of a ⋯ menu, the accounts rows' own (AccountMenuPopover.tsx):
// AnchoredPopover's menu, so the arrows, Escape, Tab out and the focus
// hand-back are the ones the row's ⋯ has.
//
// Account capacity (#1707) had a gauge here until it moved to the left stripe
// with its Reset calendar, where users could find both (rail-items.tsx).
//
// Lifted out of AccountsPanel.tsx unchanged. It is drawn while the accounts
// have the column; Local network draws a header of its own, and the one close
// button is the panel's, handed to whichever header is up. It holds one piece
// of state, whether its ⋯ is open: the acts are the panel's, and the reload's
// two attributes come from the panel's one request slot like every other
// control's (#518).
import { useId, useState, type ReactNode } from "react";

import { PRODUCT } from "../brand";
import { FILMS, FILM_SUBJECT } from "../film-links";
import { useT } from "../i18n";
import AnchoredPopover from "./AnchoredPopover";
import { KitIcon } from "./kit-icons";
import { type useRequestSlot } from "../use-request-slot";
import type { AccountsData } from "../claude-accounts";

type RequestSlot = ReturnType<typeof useRequestSlot>;

/** claude-swap is not on this machine yet: not installed, or the deck's own
 *  install still running. Every header act but close would ask it. */
export function swapMissing(data: Pick<AccountsData, "ok" | "reason"> | null | undefined): boolean {
  return data?.ok === false && (data.reason === "no_cswap" || data.reason === "cswap_installing");
}

interface Props {
  /** Whether the store holds any account to share. */
  canShare: boolean;
  onAdd: () => void;
  onShareSet: () => void;
  onReload: () => void;
  pressProps: RequestSlot["pressProps"];
  /** A reload the reader asked for is out — see the panel's `load`. */
  reloading: boolean;
  closeButton: ReactNode;
  /** With both CLIs on this deck: the Claude/Codex switch, which stands where
   *  the title stands. The title stays for a reader, out of sight. */
  switcher?: ReactNode;
  /** claude-swap is not on this machine yet (missing, or still installing). */
  noSwap?: boolean;
}

export default function AccountsHeader({
  canShare, onAdd, onShareSet, onReload, pressProps, reloading, closeButton, switcher, noSwap = false,
}: Props) {
  const t = useT();
  const base = useId();
  const moreId = `${base}-more`;
  const menuId = `${base}-more-menu`;
  // Open at the first item, or (ArrowUp on the ⋯) at the last.
  const [menu, setMenu] = useState<"first" | "last" | null>(null);
  const open = menu !== null;
  const subject = t(FILM_SUBJECT.claudeAccounts);
  // An item hands focus back to the ⋯ before the menu goes, so a dialog it
  // opens (Share) gives focus back there when it closes, not to <body>.
  const choose = (act: () => void) => {
    document.getElementById(moreId)?.focus();
    setMenu(null);
    act();
  };
  return (
    <div className="ap-header">
      {/* h2, under the topbar's h1 — the level every panel title sits at.

          CLAUDE ACCOUNTS, BECAUSE THAT IS WHAT IS IN IT. `Accounts` was
          written when Claude was the only thing this deck watched. The deck
          has drawn Codex sessions on the same canvas for months, and a Codex
          login is NOT in this list and cannot be — claude-swap manages Claude
          credentials, and nothing here reads or switches a Codex one. So a
          panel titled `Accounts` beside a canvas holding both promises a
          place to manage the other one and then never mentions it.

          Sentence case, like `Local network` below and every other caption in
          this sheet, and now identical to the landmark name this panel has
          carried since #381 — a region whose heading and whose accessible
          name are the same string is one thing to a screen reader rather than
          two. */}
      <h2 className={switcher ? "vis-hidden" : undefined}>{t("accounts.header.title")}</h2>
      {switcher}
      <div className="ap-header-right">
        {!noSwap && (<>
          {/* The `+` is one glyph, so `title` was its whole accessible name.
              A last-resort name source that a touch user never sees and that
              some readers are configured to ignore is not a name; this is the
              second and last of the two the #381 sweep found. The tooltip stays
              as the longer hover sentence. */}
          <button type="button" className="glyph-btn ap-add" onClick={() => onAdd()}
            aria-label={t("accounts.header.add")}
            title={t("accounts.header.addTip")}>
            {/* AUTHORED, NOT TYPED. These four were `+`, `↗`, `↻` and `×` —
                four Unicode codepoints out of four different blocks, all set at
                16px and measuring 8.3, 9.1, 10.9 and 7.4 of ink, with the
                reload 78% taller than the close beside it. A row of one-size
                buttons cannot be one size while the glyphs in them come from
                four typefaces. Drawn at the app's own small-icon spec, which is
                what the topbar's five already are. */}
            <KitIcon name="plus" />
          </button>
          {/* #518: this used to be `disabled={reloading}`, which disabled the
              control the press came from and dropped focus to the document
              body on every reload. It is inert while somebody ELSE is working and busy while
              its own request is out — the same two attributes every control in
              the panel takes from pressProps — and the glyph goes on saying
              which of the two it is.
              `reloading` is a second flag rather than the panel request slot
              because a reload is fired by the poll and by every other action
              too, and a reload that took the slot would disable the control
              that had just fired it — which is the defect, one step further
              along. */}
          <button type="button" className="glyph-btn ap-refresh" onClick={() => onReload()}
            {...pressProps("reload", reloading)} aria-label={t("accounts.header.reload")}
            title={t("accounts.header.reloadTip")}>
            <KitIcon name="update" className="refresh-glyph" />
          </button>
          {/* THE REST, behind ⋯: named "More actions" as the rows' ⋯ is, by its
              word and not its glyph, with the tooltip for the pointer. Down
              opens it at the first item and Up at the last, the way a native
              menu button does; Enter and Space are the click. aria-controls
              only while the menu exists: an IDREF to nothing dangles. */}
          <button type="button" id={moreId} className="glyph-btn"
            aria-label={t("accounts.row.more")} title={t("accounts.row.more")}
            aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
            onKeyDown={e => {
              if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
              e.preventDefault();
              setMenu(e.key === "ArrowUp" ? "last" : "first");
            }}
            onClick={() => setMenu(open ? null : "first")}>
            <KitIcon name="more" />
          </button>
          {open && (
            <AnchoredPopover anchorId={moreId} id={menuId} className="ap-pop" role="menu"
              labelledBy={moreId} start={menu} onClose={() => setMenu(null)}>
              {/* Share several accounts at once. Offered only when there is
                  something to share: a menu offering to send accounts from a
                  deck that holds none is an item whose only outcome is an
                  error. Its name and its warning are the ↗ button's, which it
                  was. */}
              {canShare && (
                <button type="button" role="menuitem" className="ap-menu-item"
                  title={t("accounts.header.shareTip", { product: PRODUCT })}
                  onClick={() => choose(onShareSet)}>{t("accounts.header.share")}</button>
              )}
              {/* The panel's video, which the ⓘ held (PanelInfo.tsx): the same
                  plain link out, in the same words, closing once followed. */}
              <a role="menuitem" className="ap-menu-item panel-info-film" href={FILMS.claudeAccounts.href}
                target="_blank" rel="noopener noreferrer" title={t("shell.film.title", { subject })}
                onClick={() => {
                  document.getElementById(moreId)?.focus();
                  // After the link has been followed: a link taken out of the
                  // page during its own click is not followed at all.
                  window.requestAnimationFrame(() => setMenu(null));
                }}>
                {t("shell.film.watchMenu", { duration: t("shell.film.duration") })}
                <span className="vis-hidden">{t("shell.film.hidden", { subject })}</span>
              </a>
            </AnchoredPopover>
          )}
        </>)}
        {closeButton}
      </div>
    </div>
  );
}
