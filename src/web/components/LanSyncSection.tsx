// LAN sync, at the bottom of the Accounts panel, where the accounts it is
// about already are.
//
// WHAT IT IS FOR, in one sentence a reader needs before any of the controls
// make sense: a login dies on the machine that has not used it while the same
// account stays alive on the machine that has, and the fix used to be a blob
// copied out of one deck and pasted into another.
//
// PAIRING, NOT A PASSPHRASE, AND THAT REVERSES AN EARLIER DECISION. The first
// version put every deck holding one group passphrase in one group. The
// argument was that a fleet of n decks should not cost n² pairings, and it was
// answering the wrong question. What two people hit on real hardware was this:
// a passphrase that differs by one character produces a closed socket and no
// other symptom, on both machines — and a secret is the one value a panel must
// never print, so neither of them can check theirs against the other's.
//
// So a deck is reached by address, and the deck at that address asks its own
// owner to accept. The trust decision is a named machine at a named address on
// somebody's screen, rather than a string nobody can see.
//
// AND THEN AN INVITE, which is that decision made in advance. Whoever mints one
// has already chosen who to send it to, so the deck that pastes it is paired on
// arrival and nobody presses anything. The two routes are not alternatives:
// `ask to pair` is for a deck you can SEE, an invite for one you cannot — and
// only the invite works when the machine that cannot be seen is this one, since
// an invite is dialled by whoever pastes it. What decides that is not in this
// file; see lan-reach.mjs.
//
// WHAT THIS SECTION IS NOW. An instrument: is it on, who is paired, what
// happened, and who is asking. Every DECISION moved into LanSetupModal, because
// configuration is something you do twice and looking is something you do every
// day.
//
// WHAT IT REFUSES TO SAY. Not "sharing is revocable". Unpairing stops what has
// not happened yet; a refresh token that has left this machine is gone, and the
// only real revocation is a re-login at Anthropic, which kills the session on
// every machine at once.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { checkedLabel, type DeckRow, deckRows, entryLine, rowSource, sectionState } from "../lan-roster";
import type { LanAccount, LanTailscale } from "../lan-types";
import { armedPress } from "../panel-press";
import { useLanSection } from "../use-lan-section";
import GuideModal from "./GuideModal";
import { LAN_STEPS, LanIntroArt } from "./guide-art";
import LanAddDeckModal from "./LanAddDeckModal";
import LanDeckList from "./LanDeckList";
import LanPeek from "./LanPeek";
import LanPeerModal from "./LanPeerModal";
import LanReachNote from "./LanReachNote";
import LanSetupModal from "./LanSetupModal";

// What the status route reports is described in lan-types.ts, what a round
// says in lan-round.ts, who is on the list in lan-roster.ts, and what passes
// between two decks in lan-exchange.ts; the poll's cadence and the sentence for
// a write that did not land live with the section's writes, in
// use-lan-section.ts. These are the names the dialogs and the pair-request hook
// have always imported from here, passed through so that none of them had to
// change with the move.
export type { DeckAbout, LanAccount, LanReach, LanStatus, LanStranger, LanTailscale } from "../lan-types";
export { roundLabel, roundWhy, seenLabel, silenceNote } from "../lan-round";
export { askedLabel, type DeckRow, type RowSource, withAliases } from "../lan-roster";
export { exchangeLanes, type Lane, versionOrder } from "../lan-exchange";
export { LAN_POLL_OFF_MS, LAN_POLL_ON_MS, writeFailure } from "../use-lan-section";

/** The shortest gap between arming `unpair` and confirming it that counts as
 *  two decisions. A double-click on the right end of a row armed the verb and
 *  confirmed it in one gesture, and its second press lands before anybody
 *  could have read `confirm` — so a press sooner than this is not an answer. */
export const CONFIRM_GAP_MS = 400;

/**
 * An address somebody typed, or null.
 *
 * Deliberately strict about the PORT and loose about the host: a host can be a
 * name, an IPv4, or a bracketed IPv6, and this side cannot tell a typo from a
 * hostname it has never heard of — the network will. A port is a number in a
 * known range, and getting that wrong means dialling nothing forever, which is
 * a row that reports an error every minute and can never come right.
 *
 * The last colon splits, not the first, so `[fe80::1]:5000` keeps its address.
 */
export function parseAddress(raw: string): { addr: string; port: number } | null {
  const s = (raw ?? "").trim();
  const at = s.lastIndexOf(":");
  if (at <= 0 || at === s.length - 1) return null;
  const addr = s.slice(0, at).trim();
  const port = Number(s.slice(at + 1).trim());
  if (!addr || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  // AN UNBRACKETED IPv6 ADDRESS SPLITS ON THE WRONG COLON. `fe80::1` parsed as
  // the host `fe80:` on port 1 — a well-formed entry pointing at nothing, which
  // the list then reports as a failure every minute and no correction can fix,
  // because there is nothing visibly wrong with what was typed. Refused here so
  // the dialog can say which of the two forms this deck dials.
  if (addr.includes(":") && !(addr.startsWith("[") && addr.endsWith("]"))) return null;
  return { addr, port };
}

/** Two lists of account keys, same members or not. Order is not meaning here:
 *  the server stores what it is sent, and the panel sends a Set. */
export function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const seen = new Set(a);
  return b.every(k => seen.has(k));
}

/**
 * The list one tick in "Share these accounts" sends.
 *
 * Built from what the dialog last SENT while that is still unconfirmed, and
 * from the server's list otherwise. `status.shared` only moves once a write has
 * landed AND the poll after it has returned, so a second tick inside that window
 * built from the server's list would silently drop the first one's account.
 */
export function nextShared(
  pending: readonly string[] | null, server: readonly string[], key: string, checked: boolean,
): string[] {
  const next = new Set(pending ?? server);
  if (checked) next.add(key); else next.delete(key);
  return [...next];
}

/**
 * What the share boxes draw from after news arrives: the list last sent, or —
 * as null — the server's own.
 *
 * `lastWrite` is the answer to the newest share write, or null when the news
 * is only a fresh read of the server's list. Three outcomes:
 *
 *   * REFUSED, or never answered: the deck stored nothing, so the server's list
 *     is the truth again and the boxes go back to it (#1175). Keeping what was
 *     sent drew an unticked login as not offered while the deck went on
 *     offering it — and the next tick re-sent the refused state with it.
 *   * The server's list MATCHES what was sent: it has caught up, and the
 *     optimistic copy is retired.
 *   * Accepted but not matching yet: kept. The server stores the list it is
 *     sent as it is, so a list that still differs after an accepted write is a
 *     read that left before the write landed — and going back to it would let
 *     the next tick build from it, which is the race `nextShared` exists for.
 *
 * Hands back the very list it was given when it keeps it, so a caller can tell
 * by identity whether a newer tick has replaced it since.
 */
export function settlePending<T extends readonly string[]>(
  pending: T | null, server: readonly string[], lastWrite: { ok: boolean } | null,
): T | null {
  if (pending == null) return null;
  if (lastWrite != null && !lastWrite.ok) return null;
  if (sameKeys(pending, server)) return null;
  return pending;
}

/** A countdown a person reads while somebody else is reading the token out. */
export function leftLabel(expiresAt: number, now: number): string {
  const s = Math.max(0, Math.round((expiresAt - now) / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

/** How long the pointer has to stay on the way-in row before the peek opens.
 *  A pointer crossing the foot of the panel on its way to something else is not
 *  asking a question, and a card that flashes at every crossing is noise. */
export const PEEK_DELAY_MS = 160;
/** How long the card outlives the pointer leaving it, or the row. Enough to
 *  cross the 4px between the two and to leave by the shortest way without the
 *  card blinking; short enough that a card nobody wants is gone before it is
 *  noticed. */
export const PEEK_GRACE_MS = 140;

/**
 * What to say when this machine sends its local network through a tunnel. The
 * Tailscale case is named, with the setting that fixes it; any other VPN is
 * said generally. Exported for the suite.
 */
export function tunnelNote(s: { tailscale?: LanTailscale | null }): string {
  if (s.tailscale?.exitNode) {
    return "Tailscale sends this machine's local network through an exit node, so decks on this network cannot find this one. Turn on Allow local network access in Tailscale's exit node menu to bring them back.";
  }
  return "This machine sends its local network through a VPN, so decks on this network cannot find this one. Allowing local network access in the VPN brings them back.";
}

export default function LanSyncSection({ accounts, onChanged, view, onOpen, onBack, closeButton }: {
  accounts: LanAccount[];
  /** The roster changed under us — a healed account is a different row. */
  onChanged: () => void;
  /** Whether this section has the column — its own header, its switch and its
   *  list — or is one row at the foot of the accounts view. */
  view: boolean;
  /** The row was pressed: give this section the column. */
  onOpen: () => void;
  /** Back was pressed: give the column back to the accounts. */
  onBack: () => void;
  /** The panel's close, drawn in this view's header as it is in the accounts'. */
  closeButton?: ReactNode;
}) {
  const [setupOpen, setSetupOpen] = useState(false);
  /** Which unpair is armed. The account rows above have made an irreversible
   *  press cost a second deliberate one since the panel was written; this row
   *  is the same act against a different noun. */
  const [armed, setArmed] = useState<string | null>(null);
  /** When `armed` was set, so a double-click cannot be its own confirmation —
   *  see CONFIRM_GAP_MS. */
  const armedAt = useRef(0);
  /** The dialog that holds the two ways of reaching a deck the network could
   *  not offer. A DIALOG RATHER THAN A DRAWER IN THIS COLUMN: an address is
   *  monospace, an invite is 140 characters and the firewall block is a
   *  paragraph and a shell command — unfolded in 288px they turned a list of
   *  machines into a form with a list on top of it. */
  // WHICH DOOR the add dialog was opened through: the `+`, or a nearby row's
  // invite — which arrives with one made, because that press already said so.
  const [addOpen, setAddOpen] = useState<false | "add" | "invite">(false);
  /** The four pictures that say what this section is for and what to do on
   *  each machine. Opened from a press only — the card while the section is
   *  off, and the word under an empty list — never from a flag. */
  const [guideOpen, setGuideOpen] = useState(false);
  /** Whether the peek is showing — who is on, beside the way-in row. Only the
   *  accounts view has that row; in this section's own view the list is the
   *  answer and the card would be saying it twice. */
  const [peek, setPeek] = useState(false);
  /** The hover's delay, held so a pointer that leaves before it fires cancels
   *  it rather than opening a card behind the pointer. */
  const peekTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(peekTimer.current), []);
  /** Whether the decks that are not on are showing. Shut by default and kept
   *  for the session only: which decks are off changes while you watch, and a
   *  remembered fold would be about a list that no longer exists. */
  const [foldOpen, setFoldOpen] = useState(false);
  // What the deck says about the network, and every write this section makes
  // to it. Switching the network on is the one write that opens something
  // here: the setup dialog, on the press that did it.
  const {
    status, manual, now, busy, failure, dismissFailure, pressProps, load,
    toggle, answer, dropAddress, rename, checkOne, checkNow,
  } = useLanSection(onChanged, () => setSetupOpen(true));
  /** A press on a paired row's unpair. The row draws the button; the decision
   *  — arm, confirm, or a double-click that is neither — and the state it reads
   *  stay here, so a row armed a moment ago is still armed when the view comes
   *  back inside its four seconds. */
  const pressUnpair = (p: DeckRow) => {
    const now = Date.now();
    const press = armedPress({
      armedFor: armed, target: p.fp, armedAt: armedAt.current, now, gapMs: CONFIRM_GAP_MS,
    });
    if (press === "arm") {
      setArmed(p.fp);
      armedAt.current = now;
      window.setTimeout(() => setArmed(a => (a === p.fp ? null : a)), 4_000);
      return;
    }
    // A double-click is one decision, not two: its second
    // press lands before anybody could have read `confirm`.
    if (press === "ignore") return;
    setArmed(null);
    void answer("unpair", p.fp, "unpair that deck");
  };
  /** Which deck's own dialog is open, by the fingerprint its row is keyed on.
   *  A key rather than a row, so the dialog redraws from every poll — and a
   *  deck that changes kind under it, asked and then paired, stays open on the
   *  same machine. */
  const [peerOpen, setPeerOpen] = useState<string | null>(null);

  const on = status?.enabled === true;
  // Invite-only has no actionable manual pairing requests, including during
  // the brief interval before a refreshed engine status reaches this panel.
  const rows = deckRows(status?.pairingMode === "invite" && status
    ? { ...status, pending: [] } : status, now);
  // The deck whose dialog is open, found again in every poll's rows. When it
  // is gone — unpaired and not heard since, or an address whose answer just
  // gave it an identity — the dialog closes rather than drawing a machine that
  // is no longer on the list.
  // A deck folded into another row is still found: which of a machine's decks
  // leads can change between two polls, and the dialog is about the machine.
  const openRow = peerOpen
    ? rows.find(r => r.fp === peerOpen || r.twins?.some(t => t.fp === peerOpen)) ?? null
    : null;
  useEffect(() => {
    if (peerOpen && status && !openRow) setPeerOpen(null);
  }, [peerOpen, status, openRow]);
  const asks = rows.filter(r => r.kind === "asks");
  const rest = rows.filter(r => r.kind !== "asks");
  // WHAT IS ON, AND THEN EVERYTHING ELSE. The list answers "who can I use right
  // now", and a machine that is off, or nearby and unpaired, or one somebody
  // said no to, is not an answer to that — it is context, and context does not
  // belong at the same size as the thing itself.
  //
  // WHAT IS NOT HIDDEN IS A PROBLEM. A deck that cannot be reached is exactly
  // the row a reader is scanning for, so folding it away silently would undo
  // the whole point of the tone: the fold COUNTS them, in the warning ink, and
  // one press opens it. A count in the right colour is a smaller lie than no
  // count at all — it is not a lie at all.
  const live = rest.filter(r => r.here);
  const folded = rest.filter(r => !r.here);
  const troubled = folded.filter(r => r.tone === "bad").length;
  // Nothing to lead with means nothing to fold behind: an empty list over a
  // `3 more` is a list that has hidden all of itself.
  const showFolded = foldOpen || live.length === 0;
  const state = sectionState(status, now);
  const paired = rest.filter(r => r.kind === "paired").length;
  // What the way in says, from the same rows the list is drawn from.
  const entry = entryLine(status, rows);

  // The dialogs this section owns, which outlive either presentation of it.
  const modals = (
    <>
      {addOpen && status && (
        <LanAddDeckModal
          status={status}
          manual={manual}
          startWith={addOpen === "invite" ? "invite" : undefined}
          onClose={() => setAddOpen(false)}
          onChanged={() => { void load(); onChanged(); }}
        />
      )}

      {guideOpen && (
        <GuideModal
          title="How Local network works"
          steps={LAN_STEPS}
          // The guide ends on the act it was describing, while there is one to
          // do. It goes through the same toggle the switch does, so the setup
          // dialog still opens on the press that puts this deck on the network.
          finish={on ? undefined : { label: "Turn it on", act: () => { setGuideOpen(false); void toggle(); } }}
          onClose={() => setGuideOpen(false)}
        />
      )}

      {setupOpen && status && (
        <LanSetupModal
          status={{ ...status, manualRows: manual }}
          accounts={accounts}
          manual={manual}
          onClose={() => setSetupOpen(false)}
          onChanged={() => { void load(); onChanged(); }}
        />
      )}

      {openRow && status && (
        <LanPeerModal
          row={openRow}
          source={rowSource(status, openRow)}
          status={status}
          accounts={accounts}
          now={now}
          busy={busy}
          onClose={() => setPeerOpen(null)}
          onRename={name => rename(openRow.fp, name)}
          onCheck={() => checkOne(openRow.fp)}
          // The row's own verb, through the row's own call — see the row.
          onVerb={() => {
            switch (openRow.kind) {
              case "paired": return answer("unpair", openRow.fp, "unpair that deck");
              case "nearby": return answer("accept", openRow.fp, "reach that deck");
              case "declined": return answer("allow", openRow.fp, "let that deck ask again");
              case "dialling": return dropAddress(openRow.fp);
              default: return Promise.resolve(null);
            }
          }}
          // What this deck offers is this deck's setting, not that deck's —
          // so the door to it closes this dialog on the way through.
          onSettings={() => { setPeerOpen(null); setSetupOpen(true); }}
          // The same door for an invite-only deck's one way to pair a nearby
          // machine: out of this dialog and into the add dialog, invite made.
          onInvite={() => { setPeerOpen(null); setAddOpen("invite"); }}
          twins={(openRow.twins ?? []).map(t => ({ row: t, peer: rowSource(status, t).peer ?? null }))}
          onUnpair={fp => answer("unpair", fp, "unpair that deck")}
        />
      )}
    </>
  );

  // THE WAY IN. One row at the foot of the accounts view: the name, and the two
  // facts a reader decides on — is it on, is anything wrong. The live region
  // stays with it, so a request or a failure that arrives while the reader is on
  // the accounts is still announced.
  if (!view) {
    // The peek's verbs. One timer does all three, because only one of them can
    // be pending at a time: a pointer arriving cancels a shut, a pointer
    // leaving cancels an open.
    const openPeek = (delay: number) => {
      window.clearTimeout(peekTimer.current);
      peekTimer.current = window.setTimeout(() => setPeek(true), delay);
    };
    // NOT AT ONCE. The card opens 4px from the row, and a pointer moving onto
    // it crosses those 4px of nothing — an immediate shut there closed the card
    // under a pointer that was on its way into it, which is the one move a
    // reader makes after seeing a list appear. The grace is what makes the gap
    // crossable; it is also what lets the pointer leave by the shortest way
    // without the card flickering behind it.
    const shutPeek = () => {
      window.clearTimeout(peekTimer.current);
      peekTimer.current = window.setTimeout(() => setPeek(false), PEEK_GRACE_MS);
    };
    // The pointer is on the card: whatever was pending, it is not wanted.
    const holdPeek = () => window.clearTimeout(peekTimer.current);
    // The press is leaving this view for the section's own. No grace: the card
    // would outlive the view it belongs to.
    const dropPeek = () => { window.clearTimeout(peekTimer.current); setPeek(false); };
    return (
      <div className="ap-foot">
        <button type="button" id="ap-lan-entry" className="ap-nav"
          onClick={() => { dropPeek(); onOpen(); }}
          // Described by the card while the card is there, so a screen reader
          // on this row is read the same names a pointer is shown.
          aria-describedby={peek ? "ap-lan-peek" : undefined}
          // A mouse only. Touch has no hover, and a pointerenter synthesised by
          // a tap would open a card the tap is already replacing with the view.
          onPointerEnter={e => { if (e.pointerType === "mouse") openPeek(PEEK_DELAY_MS); }}
          onPointerLeave={shutPeek}
          // A KEYBOARD'S FOCUS, NOT EVERY FOCUS. The keyboard is owed what the
          // pointer is shown, which is the whole of hover's a11y debt — but
          // `Back` hands focus to this row programmatically, and that hand-back
          // is not somebody asking to see the card. It opened one anyway, with
          // the pointer up in the header where Back was, and it stayed open
          // because nothing was ever going to blur or leave it. `:focus-visible`
          // is the browser's own answer to which of the two happened.
          onFocus={e => { if (e.target.matches(":focus-visible")) openPeek(0); }}
          // AND NO ESCAPE HANDLER. Escape is for a surface a reader is stuck
          // inside; this one holds no focus, takes no pointer and covers
          // nothing that can be pressed — there is nothing to escape from, and
          // App.tsx stays the only place in this app that reads that key.
          onBlur={shutPeek}>
          <svg className="ap-nav-glyph" width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor"
            strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="1.8" y="2.3" width="10.4" height="7.2" rx="1.2" />
            <path d="M5 11.9h4M7 9.5v2.4" />
          </svg>
          <span className="ap-nav-text">
            <span className="ap-nav-name">Local network</span>
            <span className="ap-nav-state" data-tone={entry.tone}>
              {/* The mark, before the count, and only while somebody is there:
                  `online` is a word in the muted tier, read by whoever is
                  already reading the row, and a glance wants the same dot the
                  machines inside wear. */}
              {entry.live && <i className="ap-nav-live" aria-hidden />}
              {entry.text}
            </span>
          </span>
          <svg className="ap-nav-chev" width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor"
            strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M5.6 3.4 9.2 7l-3.6 3.6" />
          </svg>
        </button>
        {peek && <LanPeek anchorId="ap-lan-entry" id="ap-lan-peek" rows={rows} onHold={holdPeek} onLet={shutPeek} />}
        <p className="vis-hidden" role="status">{state.tone === "ok" ? "" : state.text}</p>
        {modals}
      </div>
    );
  }

  // THE VIEW. The column is this section's until Back. Its header is the
  // panel's header shape — a way back, the title, this section's own acts and
  // the panel's close — and the switch is a policy row under it, the shape
  // Auto-switch has at the foot of the accounts.
  return (
    <div className="ap-lan-view">
      <div className="ap-header">
        <button type="button" id="ap-lan-back" className="glyph-btn ap-back" onClick={onBack}
          aria-label="Back to Claude accounts" title="Back to Claude accounts">
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor"
            strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M8.4 3.4 4.8 7l3.6 3.6" />
          </svg>
        </button>
        <h2 id="ap-lan-title">Local network</h2>
        <div className="ap-header-right">
          {/* THE ROUND, BESIDE THE SWITCH. It was a full-width button at the foot
              of the section, under the list it refreshes and under a tooltip that
              covered it — and it is the panel's own idiom for exactly this act:
              the accounts header has carried a `↻` since it was written. A glyph
              up here is also the honest size for it, now that the line under the
              title says when the last one ran and most readers will never need to
              press it at all. */}
          {/* THREE ACTS AND A STATE, and the three are one icon family.
              They were `+`, `↻` and `⚙` — three Unicode codepoints out of three
              different blocks, drawn by whichever installed font happened to
              cover each one. Measured, that is 8.7x7.4, 9.8x9.9 and 7.2x7.2 of
              ink in a row of three 24px buttons: the round a third taller than
              the cog beside it, and two different font-sizes here trying to
              correct for it. An icon is drawn, not typed. These are authored at
              the app's own small-icon spec — 13px on a 14 viewBox, 1.3 stroke,
              round caps — which is what the topbar's five and the browser-watch
              modal's cog already are.

              The add was `+ add a deck` at the foot, in the panel's word-button
              costume, beside settings it has nothing to do with. It became a
              plus, and the check beside it a round: the accounts header's add and
              reload, a few rows up, meaning two other things (#838). So adding a
              deck is a link — pairing is what it starts — and checking the paired
              decks is a broadcast, one ask sent to all of them. */}
          {on && (
            <button type="button" className="glyph-btn ap-lan-plus"
              onClick={() => setAddOpen("add")}
              aria-label="Add a deck"
              title={status?.pairingMode === "invite"
                ? "Send an invite, or use one you were sent. This deck pairs only by invite."
                : "Reach a deck that has not turned up on its own — by address, or with an invite"}>
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor"
                strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M6.1 7.9a2.6 2.6 0 0 0 3.7 0l1.9-1.9a2.6 2.6 0 0 0-3.7-3.7l-.9.9" />
                <path d="M7.9 6.1a2.6 2.6 0 0 0-3.7 0L2.3 8a2.6 2.6 0 0 0 3.7 3.7l.9-.9" />
              </svg>
            </button>
          )}
          {on && paired > 0 && (
            <button type="button" className="glyph-btn ap-lan-check" {...pressProps("check")}
              onClick={() => void checkNow()}
              aria-label={busy === "check" ? "Checking every paired deck" : "Check every paired deck now"}
              title="Ask every paired deck now for anything this deck's expired logins need, instead of waiting for the next round">
              {/* A broadcast: a point and two rings of arcs, one ask sent to every
                  paired deck at once (#838). The round it replaced is the accounts
                  header's reload, two sections up. */}
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor"
                strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <circle cx="7" cy="7" r="1.1" fill="currentColor" stroke="none" />
                <path d="M4.6 4.6a3.4 3.4 0 0 0 0 4.8M9.4 4.6a3.4 3.4 0 0 1 0 4.8" />
                <path d="M2.6 2.6a6.2 6.2 0 0 0 0 8.8M11.4 2.6a6.2 6.2 0 0 1 0 8.8" />
              </svg>
            </button>
          )}
          {/* AND THE SETTINGS, on the same row as the three controls that are also
              about this deck rather than about the machines on the list. It was
              `name & sharing` at the foot — a phrase naming a dialog's two fields,
              which is a caption rather than a control, and the last thing left
              down there beside a timestamp. A cog is what every application on
              this machine uses for the same door. */}
          {on && (
            <button type="button" className="glyph-btn ap-lan-set" {...pressProps("setup")}
              onClick={() => setSetupOpen(true)}
              aria-label="This deck's name and shared logins"
              title="This deck's name on the network, and which of its logins it offers">
              {/* SLIDERS, NOT A COG, and the reason is what came back from the
                  render. The browser-watch modal draws its settings as a circle
                  with eight straight radial spokes, and at 13px that is the
                  universal brightness glyph — a sun, in a row about a network.
                  Reusing it would have been reuse of a drawing that says the
                  wrong thing, next to a plus and a round where the wrong thing is
                  readable. A gear with real teeth is mush at this size; two rails
                  and two knobs is the shape that stays a setting all the way
                  down. */}
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor"
                strokeWidth="1.3" strokeLinecap="round" aria-hidden>
                <path d="M1.8 4.7h10.4M1.8 9.3h10.4" />
                <circle cx="9.1" cy="4.7" r="1.6" fill="var(--panel)" />
                <circle cx="4.9" cy="9.3" r="1.6" fill="var(--panel)" />
              </svg>
            </button>
          )}
          {closeButton}
        </div>
      </div>
      <div className="ap-scroll" id="ap-lan-scroll">
        <div className="ap-lan">
          <div className="ap-policy">
            <h3 className="ap-auto-title">Sync with paired decks</h3>
              {/* A track and a knob, like every other switch in this app — the shape
                  lives on the shared `.switch` (#886), and the reasoning with it. */}
              <button
                type="button"
                className="switch ap-auto-state"
                role="switch"
                aria-checked={on}
                aria-label="Sync with paired decks"
                {...pressProps("switch")}
                onClick={() => void toggle()}
                title={on
                  ? "Stop talking to other decks. Nothing is shared while this is off."
                  : "Let the decks you pair with repair this one's expired logins"}
              >
                <span className="switch-knob" />
              </button>
          </div>

          {/* WHY NOTHING WILL EVER TURN UP, UNDER THE SWITCH THAT TURNED IT ON.
              The verdict has been read off this machine since 3.23.2 and was
              drawn in one place: inside `+ add a deck`, which a reader opens
              only after deciding the feature is broken. So the deck knew, and
              the report that came back was still "I switched it on and nobody
              appeared". It belongs at the moment of the act — above the list it
              explains the emptiness of, and above the status line, because the
              status line says WHAT is happening and this says why it cannot.

              Only while the section is ON: a deck with the sockets down is not
              a deck anything is failing to reach, and the switch below would be
              answering a question nobody has asked yet. */}
          {on && <LanReachNote reach={status?.reach} where="panel" />}
          {/* A DECK THAT CANNOT HEAR IS STILL A DECK. It announces, it is found,
              it pairs and syncs; what it has lost is hearing new decks announce
              themselves, and the one line says so and who has the port. Not the
              warning ink: nothing here is for the reader to do, and the deck
              takes the port back on its own. */}
          {on && status?.deaf && <p className="ap-lan-fine">{status.deaf}</p>}
          {/* THE LOCAL NETWORK GOES THROUGH A TUNNEL HERE, so nothing on it can
              find this deck, and the deck has stopped shouting into the tunnel
              rather than onto somebody else's network. The one line says what
              to change, in the words the VPN's own menu uses. */}
          {on && status?.lanTunneled && <p className="ap-lan-fine">{tunnelNote(status)}</p>}

            {/* WHAT IT IS FOR, WHILE IT IS NOT DOING IT. The sentence answers one
                question — should I turn this on — and a deck that is already on has
                answered it. Left in place it was a line of explanation over a working
                list, on the surface whose whole complaint was that it looked like a
                settings page.

                One verb for one thing, everywhere. The account rows in this panel
                already say `login expired`, so this says expired too — "heal" and
                "dead" were two more words for the same state and a reader scanning
                three of them has to work out that they are one. */}
            {/* AND NOW IT IS A PICTURE AS WELL, and a door. The sentence was the only
                thing a reader deciding whether to turn this on was given, and the
                report was that nobody could tell from it what would happen or what
                to do on the other machine. The drawing says the first half at a
                glance; the press opens the guide that says the rest. */}
            {!on && (
              <button type="button" className="ap-lan-intro" onClick={() => setGuideOpen(true)}
                title="Four pictures: what this does, and what to do on each machine">
                <LanIntroArt />
                <span className="ap-lan-intro-text">Paired machines repair each other&apos;s expired logins.</span>
                <span className="ap-lan-intro-go">See how it works</span>
              </button>
            )}

            {/* WHO IS HERE, IN ONE LINE. Every state this section had was legible only
                by reading the whole thing and working it out. This is the panel's own
                answer, the one the freshness column has made on every account row for
                a year: say the state, at the top, in the words a person would use. */}
            {/* Announced, and it was not: the one line that says whether anything is
                working changes under a reader who is looking at a quota three
                sections up, and a screen reader was told nothing at all. `polite`
                rather than `alert` — the request box beside it is the assertive one,
                and two live regions shouting about one event is one too many. */}
            {/* EMPTY WHEN THERE IS NOTHING WRONG, and empty rather than absent. `N
                decks ready · M away` is the state this feature is in almost all the
                time, and the list underneath says the same thing better: the green
                rows ARE the ready ones and the fold counts the rest. What the line is
                for is every other answer — off, starting, could not start, somebody is
                waiting for you, nothing can be reached — and those are worth a
                sentence.

                The element stays in the DOM with the text taken out, because a live
                region has to exist before its content changes to be announced
                reliably; one inserted at the moment it has something to say is one
                several screen readers say nothing about. An empty <p> draws no line
                box, so it costs no height, and `:empty` takes its margin too. */}
            <p className={`ap-lan-status ${state.tone}`} role="status">
              {state.tone === "ok" ? "" : state.text}
            </p>

            {failure && (
              <div className="ap-failure" role="alert">
                <span className="ap-failure-text">{failure}</span>
                <button type="button" className="ap-failure-x" onClick={dismissFailure}
                  aria-label="Dismiss this message" title="Dismiss">×</button>
              </div>
            )}

            {on && (
              <>
                {/* THE REQUEST, AND IT COMES FIRST. Somebody dialled this deck without
                    an invite and is waiting; until this is answered nothing moves
                    between them. Announced, because it arrives while the reader is
                    three sections up looking at a quota — and it also arrives as a
                    dialog in front of the canvas, for the reader who is not in this
                    panel at all. */}
                {asks.length > 0 && (
                  <div className="ap-lan-asks" role="alert">
                    {asks.map(p => (
                      <div key={p.fp} className="ap-lan-ask">
                        <span className="ap-lan-ask-what">
                          <strong className="ap-lan-peer-name">{p.name}</strong>
                          {" at "}<code className="ap-lan-code">{p.addr}</code>
                          {" wants to pair"}
                        </span>
                        {/* PRINTED, NOT HOVERED. The one security decision in this
                            feature is whether the machine asking is the one you think
                            it is, and the only value that cannot be chosen by whoever
                            is asking is this. It lived in `title=` — a mouse-only,
                            one-second-delayed, screen-reader-silent place — so on the
                            surface that answers most requests it could not be checked
                            at all. The dialog that opens over the deck has printed it
                            since it was written; this is the same fact on the row
                            that does the same job. */}
                        <span className="ap-lan-ask-fp">
                          fingerprint <code className="ap-lan-code">{p.fp}</code>
                        </span>
                        <span className="ap-lan-ask-acts">
                          <button type="button" className="ap-manage-btn" {...pressProps(`accept:${p.fp}`)}
                            onClick={() => void answer("accept", p.fp, "accept that deck")}
                            title={`Talk to this deck from now on. Its fingerprint is ${p.fp} — check it matches the one on their screen before you accept.`}>
                            accept
                          </button>
                          <button type="button" className="ap-manage-btn" {...pressProps(`dismiss:${p.fp}`)}
                            onClick={() => void answer("dismiss", p.fp, "decline that request")}
                            title="Say no. Nothing is shared, and that deck is told rather than left waiting.">
                            decline
                          </button>
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {/* EVERY OTHER MACHINE, ON ONE LIST. Paired, nearby, and the ones
                    already said no to — one row each, with the sentence that says
                    what is happening and the one control that changes it. They were
                    three lists in two surfaces, and the question a reader has is one
                    question. See deckRows. */}
                {(showFolded ? [...live, ...folded] : live).length > 0 && (
                  <LanDeckList
                    // The ones that are on stay at the top when the fold opens.
                    // Sorting the whole list by presence would move a row between
                    // two five-second polls on a lost beacon; sorting the two GROUPS
                    // moves a row only when the thing it reports actually changed.
                    rows={showFolded ? [...live, ...folded] : live}
                    pairingMode={status?.pairingMode}
                    armed={armed}
                    pressProps={pressProps}
                    answer={answer}
                    dropAddress={dropAddress}
                    onUnpair={pressUnpair}
                    onOpenPeer={setPeerOpen}
                    onInvite={() => setAddOpen("invite")}
                  />
                )}

                {/* THE LAST LINE OF THE SECTION, and it holds the two things that are
                    true of the list rather than of any deck on it: how much of it is
                    folded away, and when it was last asked. They were two lines and a
                    boundary apart, each alone on its own row — one word on the left,
                    one figure below it, and nothing between them but sixteen pixels.
                    One row, two ends, and the section stops there. */}
                {((live.length > 0 && folded.length > 0) || (on && paired > 0)) && (
                <div className="ap-lan-tail">
                {/* The count of what is not on, in the ink that says whether any of it
                    matters. A chevron rather than a plus: this is one list with a
                    part of it folded, not a second thing to open. */}
                {live.length > 0 && folded.length > 0 && (
                  <button type="button" className="ap-lan-word ap-lan-more" aria-expanded={foldOpen}
                    onClick={() => setFoldOpen(v => !v)}
                    title={foldOpen
                      ? "Show only the decks that are on"
                      : `Show the ${folded.length} deck${folded.length === 1 ? "" : "s"} that are not responding right now`}>
                    <span className={`ap-lan-chev${foldOpen ? " open" : ""}`} aria-hidden>›</span>
                    {/* Open, the control offers the reverse of what it did — `2 more`
                        over two rows that are already showing is a label describing
                        the press before last. */}
                    {foldOpen ? "fewer" : `${folded.length} more`}
                    {!foldOpen && troubled > 0 && (
                      <span className="ap-lan-more-bad">
                        {" · "}{troubled} not responding
                      </span>
                    )}
                  </button>
                )}
                  {on && paired > 0 && (
                    <span className="ap-lan-checked">{checkedLabel(status?.checkedAt, now, busy === "check")}</span>
                  )}
                </div>
                )}

                {/* Not while it is stalled or cannot hear: the list is empty
                    because of this deck, and "no other deck yet" would blame
                    the network for the line above it. */}
                {rest.length === 0 && asks.length === 0 && !status?.stalled && !status?.deaf && !status?.lanTunneled && (
                  <>
                    <p className="ap-lan-fine">
                      No other deck yet. Decks on one network usually find each other on their own;
                      when that has not happened, the link at the top of this view reaches one
                      by address or by invite.
                    </p>
                    {/* The moment somebody has switched this on and is waiting for a
                        first machine is the moment they most want to know what the
                        other machine has to do. */}
                    <button type="button" className="ap-lan-word ap-lan-how" onClick={() => setGuideOpen(true)}>
                      How it works
                    </button>
                  </>
                )}

              </>
            )}
        </div>
      </div>
      {modals}
    </div>
  );
}
