// One account's ⋯ in the accounts panel: the menu it opens over the column,
// and the three small forms an item turns it into — a name, a slot, a share.
//
// Lifted out of AccountsPanel.tsx unchanged. The panel still decides which
// account the popover hangs from and what box it closes against; what it
// draws is here. Everything it holds and every request pressed in it is the
// hook's (use-account-menu.ts), handed in whole as `accountMenu`, so the
// markup asks for what it means and writes no state of its own. The two items
// that reach past the menu — the Projects report, and holding the account out
// of rotation, which is the auto-switch route's — are callbacks the panel
// spells.
import AnchoredPopover from "./AnchoredPopover";
import { slotChoices } from "../account-move";
import { sentence } from "../account-issue";
import { ALIAS_MAX_LENGTH } from "../alias-save";
import { PRODUCT } from "../brand";
import { type Account } from "../claude-accounts";
import { slotChoiceLabel, slotCommit, slotShowing } from "../picker-commit";
import { shareExpiry } from "../share-bundle";
import { type useAccountMenu } from "../use-account-menu";
import { type useRequestSlot } from "../use-request-slot";
import { useT } from "../i18n";

type AccountMenuState = ReturnType<typeof useAccountMenu>;
type RequestSlot = ReturnType<typeof useRequestSlot>;

interface Props {
  a: Account;
  /** Every slot the store holds, for the move picker's choices. */
  slots: number[];
  nowSec: number;
  /** The box the account's row scrolls in. */
  boundaryId: string;
  /** Which menu is open, what it holds, and the presses — see the hook. */
  accountMenu: AccountMenuState;
  busy: RequestSlot["busy"];
  pressProps: RequestSlot["pressProps"];
  /** Open this account's Projects report, closing the menu behind it. */
  onProjects: () => void;
  /** Hold this account out of rotation, or put it back. */
  onRotation: () => void;
  /** This account is Auto-switch's home. */
  home: boolean;
  /** Make this account home, or stop it being home. */
  onHome: () => void;
}

export default function AccountMenuPopover({
  a, slots, nowSec, boundaryId, accountMenu, busy, pressProps, onProjects, onRotation,
  home, onHome,
}: Props) {
  const {
    menu, menuError, aliasDraft, confirmRemove, share, shareCopied, slotDraft,
    dropMenu, closeMenu, startRename, typeAlias, doAlias, startMove, pickSlot, doSlot,
    makeShare, copyShare, pressRemove,
  } = accountMenu;
  // The panel draws this only while a menu is open; this is for the type.
  const t = useT();
  if (!menu) return null;
  const titleId = `ap-pop-title-${a.num}`;
  // Under the control that was pressed, in every view. The popover
  // stays open on a refusal, holding what the user had done.
  const refusal = menuError && (
    <p className="ap-pop-error" role="alert" title={menuError.raw || undefined}>{menuError.text}</p>
  );
  return (
    <AnchoredPopover
      anchorId={`ap-more-${a.num}`}
      // The box the ⋯ scrolls in. Scrolled out of it, the popover
      // closes rather than float over a row nobody can see.
      boundaryId={boundaryId}
      id={`ap-menu-${a.num}`}
      className="ap-pop"
      role={menu.view === "menu" ? "menu" : "dialog"}
      labelledBy={menu.view === "menu" ? `ap-more-${a.num}` : titleId}
      start={menu.start}
      onClose={dropMenu}
    >
      {menu.view === "menu" && (
        <>
          {/* Four words, where the block drew three forms and five
              controls before anything was chosen. Each item that
              needs more than a press turns this same surface into
              the one form it needs. The arrows walk the items, and
              Tab leaves the menu instead of stepping through it. */}
          <button type="button" role="menuitem" className="ap-menu-item"
            onClick={() => startRename(a.num, a.alias)}>{t("accounts.menu.rename")}</button>
          <button type="button" role="menuitem" className="ap-menu-item"
            onClick={() => startMove(a.num)}>{t("accounts.menu.moveSlot")}</button>
          <button type="button" role="menuitem" className="ap-menu-item"
            {...pressProps(`share-${a.num}`)}
            /* It leads with what the reader is about to put on their
               clipboard, and describes the ten minutes as what they
               are: how long the OTHER deck will still take it. The
               share is plain text with the account's token inside and
               an expiry nothing signs. */
            title={t("accounts.menu.shareTip", { product: PRODUCT })}
            onClick={() => makeShare(a.num)}
          >{busy === `share-${a.num}` ? t("accounts.menu.sharing") : t("accounts.menu.share")}</button>
          {/* Where this account spent its work, per project. Opens a
              full modal — the report is a chart and a list, not a
              menu-sized thing — so the popover closes behind it. */}
          <button type="button" role="menuitem" className="ap-menu-item"
            title={t("accounts.menu.projectsTip")}
            onClick={() => onProjects()}
          >{t("accounts.menu.projects")}</button>
          {/* Holding an account out is offered on every account but the
              one in use, with Auto-switch on or off: it is set up before
              the switch is turned on, and claude-swap keeps it either way.
              Putting one BACK is offered whenever an account is out
              (#519): the row says `held out`, and this is the one way to
              undo it. A menu item rather than a word on every row — it is
              a preference flipped a few times a year. */}
          {(!a.active || a.disabled) && (
            <button type="button" role="menuitem" className="ap-menu-item"
              {...pressProps(`rot-${a.num}`)}
              title={a.disabled
                ? t("accounts.menu.putBackTip")
                : t("accounts.menu.holdOutTip")}
              onClick={() => onRotation()}
            >{a.disabled ? t("accounts.menu.putBack") : t("accounts.menu.holdOut")}</button>
          )}
          {/* Home, by the rotation item's rule: set it with Auto-switch on
              or off — a tick only reads it while the switch is on — and
              remove it whenever there is one: the row's ⌂ says so, and this
              is the one way to undo it. A preference set once, so a word
              here rather than a control on every row. */}
          {(home || a.email) && (
            <button type="button" role="menuitem" className="ap-menu-item"
              {...pressProps(`home-${a.num}`)}
              title={home
                ? t("accounts.menu.removeHomeTip")
                : t("accounts.menu.setHomeTip")}
              onClick={() => onHome()}
            >{home ? t("accounts.menu.removeHome") : t("accounts.menu.setHome")}</button>
          )}
          <div role="separator" className="ap-menu-sep" />
          {/* Two presses, and the second one expires. There is no
              confirmation dialog anywhere in this deck and removing an
              account cannot be undone, so the item is its own
              confirmation: the first press arms it and leaves the
              menu open, the four seconds it stays armed drain along
              its foot, and only a press inside them removes. It arms
              to the word unpair arms to in the LAN section (#839);
              the name spells out what is being confirmed for a reader
              who cannot see the row it replaced. */}
          <button
            type="button"
            role="menuitem"
            className={`ap-menu-item danger${confirmRemove === a.num ? " armed" : ""}`}
            {...pressProps(`rm-${a.num}`)}
            aria-label={confirmRemove === a.num ? t("accounts.menu.confirmRemove") : undefined}
            title={confirmRemove === a.num
              ? t("accounts.menu.removeArmedTip")
              : t("accounts.menu.removeTip")}
            onClick={() => pressRemove(a.num)}
          >{busy === `rm-${a.num}` ? t("accounts.menu.removing") : confirmRemove === a.num ? t("accounts.confirm") : t("accounts.menu.remove")}</button>
          {refusal}
        </>
      )}

      {menu.view === "rename" && (
        /* A form, so Enter is Save the way it is in every field —
           and never in the middle of an IME composition, which a
           keydown listener for Enter gets wrong. The title is the
           field's label: one line that says what the form is for and
           names the field, where the block had a hidden label and a
           placeholder doing the naming. */
        <form className="ap-pop-form" onSubmit={e => { e.preventDefault(); doAlias(a.num, a.alias); }}>
          <label className="ap-pop-title" id={titleId} htmlFor={`ap-alias-${a.num}`}>{t("accounts.menu.renameTitle")}</label>
          <input
            id={`ap-alias-${a.num}`}
            className="ap-manage-input"
            type="text"
            value={aliasDraft}
            onChange={e => typeAlias(e.target.value)}
            /* The store's own bound, stated where the typing happens
               rather than discovered from a `bad_value` after a
               round trip. See ALIAS_MAX_LENGTH. */
            maxLength={ALIAS_MAX_LENGTH}
            /* An example, not a narration of the empty state: "no
               alias" reads as a field whose value is those two words. */
            placeholder={t("accounts.menu.aliasPlaceholder")}
            spellCheck={false}
            autoComplete="off"
            /* The keyboard lands in the field, with the name that is
               there selected, so typing replaces it and an arrow key
               edits it instead. */
            autoFocus
            onFocus={e => e.currentTarget.select()}
          />
          {refusal}
          <div className="ap-pop-actions">
            <button type="button" className="btn" onClick={() => closeMenu()}>{t("accounts.cancel")}</button>
            <button type="submit" className="btn primary" {...pressProps(`alias-${a.num}`)}
              title={t("accounts.menu.aliasTip")}>
              {busy === `alias-${a.num}` ? "…" : t("accounts.save")}
            </button>
          </div>
        </form>
      )}

      {/* The picker and the press that acts on it (#516). A
          `<select>` fires `change` for a keystroke as readily as for
          a pick, so one letter once matched an option by type-ahead
          and moved an account — and into a taken slot, a second one
          nobody pointed at. Nothing is sent until the button is
          pressed, and the button says which of the two it will do:
          `Swap` for exactly the options marked `· swap`. */}
      {menu.view === "move" && (() => {
        const choices = slotChoices(slots, a.num);
        const picked = slotShowing(choices, slotDraft, a.num);
        const commit = slotCommit(choices, picked, a.num, t);
        return (
          // Not a form: with no text field in it there is nothing for
          // Enter to submit from, and the one way to send is the
          // press on the button — which is the point of #516.
          <div className="ap-pop-form">
            <label className="ap-pop-title" id={titleId} htmlFor={`ap-slot-${a.num}`}>{t("accounts.menu.moveTitle")}</label>
            <span className="ap-field">
              <select
                id={`ap-slot-${a.num}`}
                value={String(picked)}
                {...pressProps(`move-${a.num}`)}
                onChange={e => pickSlot(Number(e.target.value))}
                autoFocus
              >
                {/* The consequence rides on the option that carries
                    it, and the one harmless move is visible as the
                    exception — see slotChoices. */}
                {choices.map(c => <option key={c.slot} value={c.slot}>{slotChoiceLabel(c, t)}</option>)}
              </select>
            </span>
            {refusal}
            <div className="ap-pop-actions">
              <button type="button" className="btn" onClick={() => closeMenu()}>{t("accounts.cancel")}</button>
              <button type="button" className="btn primary" {...pressProps(`move-${a.num}`)}
                title={commit.title}
                onClick={() => doSlot(a.num, picked, commit)}
              >{busy === `move-${a.num}` ? "…" : sentence(commit.label)}</button>
            </div>
          </div>
        );
      })()}

      {menu.view === "share" && share?.num === a.num && (() => {
        const exp = shareExpiry(share.expiresAt, nowSec, t);
        const dead = exp.tone === "gone";
        return (
          <div className="ap-pop-form">
            <p className="ap-pop-title" id={titleId}>{t("accounts.menu.shareTitle")}</p>
            {/* The text keeps its ink past the expiry (#1289): it used to fade
                to --dim-stale, 1.93:1 on the dark panel, through an `expired`
                class on this form that was there for nothing else. The
                countdown beside it says "expired" in --err and the primary
                becomes "Make a new share", so the state is in words, at full
                contrast. */}
            <code className="ap-share-blob">{share.blob}</code>
            {/* The warning belongs to what the text IS, and the
                countdown is not what keeps anyone out — so the warning
                carries the colour, and the full explanation is one
                hover away rather than a paragraph in a popover. */}
            <p className="ap-pop-note"
              title={t("accounts.menu.blobTip")}>
              <span className="ap-share-warn">{t("accounts.menu.isPassword")}</span>
              {" · "}
              <span className={`ap-share-expiry ${exp.tone}`}>{exp.text}</span>
            </p>
            {refusal}
            <div className="ap-pop-actions">
              <button type="button" className="btn" onClick={() => closeMenu()}>{t("accounts.done")}</button>
              {/* Past the expiry the import dialog on the other deck
                  refuses this text, so offering to copy it is offering
                  a dead end — see shareExpiry. */}
              <button type="button" className="btn primary" {...pressProps(`share-${a.num}`)} autoFocus
                onClick={async () => {
                  if (dead) { await makeShare(a.num); return; }
                  await copyShare(share.blob);
                }}>
                {dead ? t("accounts.menu.makeNew") : shareCopied ? t("accounts.copied") : t("accounts.copy")}
              </button>
            </div>
          </div>
        );
      })()}
    </AnchoredPopover>
  );
}
