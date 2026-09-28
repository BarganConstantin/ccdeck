// An account's ⋯ in the accounts panel: which one is open and what it is
// showing, everything a press inside it is holding — a name being typed, a
// slot being proposed, an armed remove, a share, the refusal under the control
// that was pressed — and the requests those presses make.
//
// Lifted out of AccountsPanel.tsx unchanged apart from where the popover's
// markup wrote the state itself. That markup read some thirty of the panel's
// names, eight of them setters; the setters are private to this file now, and
// the markup asks for what it means — start a rename, pick a slot, press
// Remove, copy the share. The one fact here that is drawn outside the popover
// is the note a swap leaves on a row, and it lives here because
// manageAfterMove re-keys it together with the popover's own state, in one
// step, after every move.
//
// The panel keeps what the popover sits among: the issue popover it never
// stands beside, the effects that drop it when the panel leaves or its account
// does, and the auto-switch POST, which says its refusal here through
// `sayInMenu` when the press came from the menu.
import { useCallback, useRef, useState } from "react";

import { explainFailure } from "./admin-failure";
import { type SwapNote, manageAfterMove } from "./account-move";
import { type Failure } from "./accounts-reload";
import { aliasSave } from "./alias-save";
import { copyText } from "./copy-text";
import { armedPress, focusDropped } from "./panel-press";
import { type PickerCommit } from "./picker-commit";
import { CONFIRM_GAP_MS } from "./components/LanSyncSection";

/** What an account's ⋯ is showing. Rename and Move are forms; Share is its
 *  answer — the text to copy. */
export interface AccountMenu {
  num: number;
  view: "menu" | "rename" | "move" | "share";
  /** Which end of the menu focus lands on when it opens. */
  start?: "first" | "last";
}

// How long the "a second account moved too" line stands on the moved row. Long
// enough to read a sentence the user did not ask for, short enough that it does
// not keep reporting a move from ten minutes ago. Same shape as the panel's
// other transient states — `copied` at 1.8s, an armed remove at 4s.
const SWAP_NOTE_MS = 8_000;
// How long a share's `Copy` stands as `Copied`. The same 1.8s as the
// threshold's `saved`, for the same reason, and the same length
// ShareAccountsDialog gives its own copy.
const COPIED_MS = 1_800;
// How long Remove stays armed before it stands down on its own. The bar that
// drains along its foot is timed to this in styles.css (`ap-disarm 4000ms`),
// so the two change together or the bar lies about the window.
const REMOVE_ARMED_MS = 4_000;

export interface AccountMenuDeps {
  /** The panel's one request slot — see use-request-slot.ts. */
  claim: (tag: string) => boolean;
  release: () => void;
  /** Read the roster again, the way the header's ↻ does. */
  load: (force?: boolean) => Promise<void>;
  /** Take down the refusal at the foot of the panel, which a new request
   *  supersedes. */
  clearFailure: () => void;
  /** Focus the nearest control that outlived the press — see the panel. */
  rescueFocus: (row: number | null) => void;
}

export function useAccountMenu({ claim, release, load, clearFailure, rescueFocus }: AccountMenuDeps) {
  // Which account's ⋯ is open, and what it is showing: the menu, or the one
  // small form an item turned it into. One at a time — opening a second
  // account's menu closes the first. It lies over the column rather than
  // opening the row, so nothing held here decides any row's height.
  const [menu, setMenu] = useState<AccountMenu | null>(null);
  const menuFor = menu?.num ?? null;
  // The same fact for a handler that returns after a render. A rename that
  // lands after the reader has opened another account's menu must close its
  // own popover, not theirs.
  const menuRef = useRef(menu);
  menuRef.current = menu;
  // Why the last press in the popover did not work, said in the popover under
  // the control that was pressed. A popover that closed on a refusal would
  // look exactly like one that closed on success, so it stays open instead,
  // holding the draft, and this is the line that says why.
  const [menuError, setMenuError] = useState<Failure | null>(null);
  const [aliasDraft, setAliasDraft] = useState("");
  // Removal is irreversible, and there is no confirmation dialog anywhere in
  // this deck. The button becomes its own confirmation and gives up after a
  // few seconds, so a stray click can never be the second one.
  const [confirmRemove, setConfirmRemove] = useState<number | null>(null);
  // When Remove was armed, so a double-click cannot be its own confirmation —
  // the rule the LAN section's unpair already keeps (CONFIRM_GAP_MS). It
  // matters more in the menu than it did on the row: an open menu lies over
  // the next account's ⋯, and Remove, last in the list, is what a press aimed
  // at that ⋯ lands on.
  const removeArmedAt = useRef(0);
  const [share, setShare] = useState<{ num: number; blob: string; expiresAt: number } | null>(null);
  const [shareCopied, setShareCopied] = useState(false);
  // A move into an occupied slot relocates an account the user never picked.
  // Nothing else on screen says so — both accounts simply appear where they
  // were not — so the moved row says it, in its own freshness line.
  const [swapNote, setSwapNote] = useState<SwapNote | null>(null);
  // What the slot picker is SHOWING, which is no longer what the store holds.
  // A select fires `change` on any keystroke that matches an option, so a
  // single `s` used to move an account and, into a taken slot, a second one
  // with it (#516). The picker proposes now and the button under it commits.
  // Null is the account's own slot, which is where the picker opens; only one
  // popover is ever open, so one draft covers the panel.
  const [slotDraft, setSlotDraft] = useState<number | null>(null);

  /** Every store-changing action is one POST to the same route — and every one
   *  of them is pressed inside an account's ⋯ popover, so its refusal is said
   *  there, under the control that was pressed, rather than at the foot of a
   *  panel the popover is lying over. */
  const admin = useCallback(async (body: Record<string, unknown>, tag: string) => {
    if (!claim(tag)) return null;
    clearFailure();
    setMenuError(null);
    try {
      const res = await fetch("/api/claude-accounts/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const out = await res.json().catch(() => null);
      // The admin route composes its `detail` with failureText(), so here the
      // server's own words are the message and explainFailure ranks them first.
      if (!out?.ok) setMenuError({ text: explainFailure(out, "command failed", res.status) });
      return out;
    } catch {
      setMenuError({ text: "server unreachable" });
      return null;
    } finally {
      release();
    }
  }, [claim, release, clearFailure]);

  /** Forget the popover and everything it was holding: an armed remove, a
   *  share, a refusal. All three belonged to the account they were made on. */
  const dropMenu = useCallback(() => {
    setMenu(null);
    setMenuError(null);
    setConfirmRemove(null);
    setShare(null);
    setShareCopied(false);
  }, []);

  /** Open an account's ⋯ on its menu, closing any other one first. */
  const showMenu = (num: number, start: "first" | "last" = "first") => {
    dropMenu();
    setSlotDraft(null);
    setMenu({ num, view: "menu", start });
  };

  /**
   * Close the popover and hand focus back to the ⋯ it came from.
   *
   * Only when focus was inside it, which is about to go, or has already
   * fallen to <body> — a reader who moved on while a request was out is left
   * where they put themselves, the rule panel-press.ts writes for every rescue
   * in this panel. `only` is for a request that finished late: it closes its
   * own account's popover and never one opened since.
   */
  const closeMenu = useCallback((only?: number) => {
    const open = menuRef.current;
    if (!open || (only != null && open.num !== only)) return;
    const pop = document.getElementById(`ap-menu-${open.num}`);
    if (pop?.contains(document.activeElement) || focusDropped(document.activeElement?.tagName ?? null)) {
      document.getElementById(`ap-more-${open.num}`)?.focus();
    }
    dropMenu();
  }, [dropMenu]);

  /** Say why a press in the popover did not work, or take the reason down.
   *  For the one request pressed here that is not the store's — holding an
   *  account out of rotation, which is the auto-switch route's. */
  const sayInMenu = useCallback((f: Failure | null) => setMenuError(f), []);

  /** Turn the menu into the rename form, holding the name the store has. */
  const startRename = (num: number, stored: string | null) => {
    setAliasDraft(stored ?? "");
    setMenuError(null);
    setMenu({ num, view: "rename" });
  };
  /** What the rename field says, as the reader types it. */
  const typeAlias = (text: string) => setAliasDraft(text);

  /** Turn the menu into the move form, the picker on the account's own slot. */
  const startMove = (num: number) => {
    setSlotDraft(null);
    setMenuError(null);
    setMenu({ num, view: "move" });
  };
  /** What the picker is showing. A proposal: nothing is sent until the button
   *  under it is pressed (#516). */
  const pickSlot = (slot: number) => setSlotDraft(slot);

  /**
   * Make a share for this account and turn the popover into it. Also what
   * `Make a new share` does once the one on screen has expired.
   */
  const makeShare = async (num: number) => {
    setShareCopied(false);
    const out = await admin({ action: "share", account: num }, `share-${num}`);
    // Closed while the request was out: the share is not shown to anybody.
    if (!out?.ok || menuRef.current?.num !== num) return;
    setShare({ num, blob: out.blob, expiresAt: out.expiresAt });
    setMenu({ num, view: "share" });
  };

  /** Put the share on the clipboard, and say `Copied` for as long as the word
   *  is worth reading. */
  const copyShare = async (blob: string) => {
    if (await copyText(blob)) {
      setShareCopied(true);
      window.setTimeout(() => setShareCopied(false), COPIED_MS);
    }
  };

  /**
   * Store the alias in the field, then close.
   *
   * A draft that already matches the store is not a failure and not a no-op
   * the user should have to detect — it is an alias that is saved — so it
   * closes without a round trip, and a draft that differs closes once the
   * store has it. The row is the confirmation: it is showing the name. A
   * refusal leaves the form open on the draft, with the reason under it.
   */
  const doAlias = async (num: number, stored: string | null) => {
    const { commit, alias } = aliasSave(aliasDraft, stored);
    if (commit) {
      const out = await admin({ action: "alias", account: num, alias }, `alias-${num}`);
      await load(true);
      if (!out?.ok) return;
    }
    closeMenu(num);
  };

  /**
   * Send an account to another slot, then close the popover and follow the
   * account with focus.
   *
   * The reload alone is not enough: `cswap move` into an occupied slot is a
   * swap, so the slot numbers this panel keys everything by change hands
   * underneath it. manageAfterMove decides what survives that; a refused move
   * returns null and nothing here is touched, leaving the form open and armed
   * exactly as the user left it, with the refusal under it to say why.
   */
  const doMove = async (from: number, to: number) => {
    const out = await admin({ action: "move", account: from, slot: to }, `move-${from}`);
    const next = manageAfterMove(
      { menuFor: menuRef.current?.num ?? null, confirmRemove, shareFor: share?.num ?? null, swapNote },
      from,
      out,
    );
    // The roster first, then the popover, and never the other way round: the
    // two disagree about who holds a slot for exactly as long as one has moved
    // on and the other has not, and that disagreement IS the bug — a form
    // aimed at a row belonging to somebody else.
    await load(true);
    if (next) {
      // Focus goes to the account's ⋯, wherever the move put it — handed over
      // BEFORE the popover goes, because the popover hands focus back to the ⋯
      // it was opened from as it leaves, and after a swap that ⋯ is the
      // displaced account's (#1540). Which of the two got there first was a
      // race. Only when focus was in the popover, or had already fallen; a ⋯
      // the new roster has not drawn yet is left to the rescue below.
      if (next.menuFor != null) {
        const pop = document.getElementById(`ap-menu-${from}`);
        const target = document.getElementById(`ap-more-${next.menuFor}`);
        if (target && (pop?.contains(document.activeElement) || focusDropped(document.activeElement?.tagName ?? null))) {
          target.focus();
        }
      }
      // The account is where the picker said, so the form has nothing left to
      // do. It closes rather than chase the row down the column; the row
      // answers instead, by being in its new place and, after a swap, by
      // saying so.
      if (menuRef.current?.num === from) dropMenu();
      setConfirmRemove(next.confirmRemove);
      if (next.shareFor == null) { setShare(null); setShareCopied(false); }
      setSwapNote(next.swapNote);
      const note = next.swapNote;
      if (note) window.setTimeout(() => setSwapNote(n => (n === note ? null : n)), SWAP_NOTE_MS);
      // A refused move keeps the draft: the form stays open on the pick the
      // user made, ready to be pressed again under the refusal.
      setSlotDraft(null);
      // The popover that held focus is gone, and the account now sits on a
      // different row. When that row's ⋯ was not drawn yet above — a move into
      // an empty slot — focus has fallen, and lands on it once it is.
      rescueFocus(next.menuFor);
    }
    return out;
  };

  /**
   * Act on the slot showing in the picker, because the user said so.
   *
   * This is the whole of #516. A `<select>` changes value on a keystroke and
   * fires `change` for it, so the picker cannot be the thing that acts — one
   * `s` matched `slot 3 · swap` by type-ahead and traded two accounts with no
   * confirmation and no undo. The press is the decision now, and slotCommit
   * decides what the press means from the choice alone.
   *
   * Both endings close the form, which is what `Save` does for a name: a pick
   * that is already where the account lives has nothing to send and is not a
   * failure — the account IS there — and a pick that moved it closes once the
   * move has landed.
   */
  const doSlot = async (from: number, to: number, commit: PickerCommit) => {
    if (!commit.sends) { closeMenu(from); return; }
    await doMove(from, to);
  };

  /** A press on Remove: the first arms it, and only a second one inside the
   *  window removes. See the item in the panel for why it asks twice. */
  const pressRemove = (num: number) => {
    const now = Date.now();
    const press = armedPress({
      armedFor: confirmRemove, target: num,
      armedAt: removeArmedAt.current, now, gapMs: CONFIRM_GAP_MS,
    });
    if (press === "arm") {
      setConfirmRemove(num);
      removeArmedAt.current = now;
      window.setTimeout(() => setConfirmRemove(c => (c === num ? null : c)), REMOVE_ARMED_MS);
      return;
    }
    // A double-click is one decision, not two: its second press lands before
    // anybody could have read `Confirm`.
    if (press === "ignore") return;
    setConfirmRemove(null);
    admin({ action: "remove", account: num }, `rm-${num}`).then(out => {
      load(true);
      // Refused: the menu stays open and says why.
      if (!out?.ok) return;
      if (menuRef.current?.num === num) dropMenu();
      // The row this lived on is going, so there is no local anchor left and
      // focus falls to the panel reload — see rescueSelectors in panel-press.ts.
      rescueFocus(null);
    });
  };

  return {
    menu, menuFor, menuError, aliasDraft, confirmRemove, share, shareCopied, slotDraft, swapNote,
    showMenu, dropMenu, closeMenu, sayInMenu,
    startRename, typeAlias, doAlias,
    startMove, pickSlot, doSlot,
    makeShare, copyShare,
    pressRemove,
  };
}
