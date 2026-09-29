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
import { useEffect, useState, type ReactNode } from "react";
import { checkedLabel, deckRows, entryLine, rowSource, sectionState, viewRows } from "../lan-roster";
import type { LanAccount } from "../lan-types";
import { useHoverPeek } from "../use-hover-peek";
import { useLanSection } from "../use-lan-section";
import { useRowUnpair } from "../use-row-unpair";
import GuideModal from "./GuideModal";
import { LAN_STEPS, LanIntroArt } from "./guide-art";
import LanAddDeckModal from "./LanAddDeckModal";
import LanAsks from "./LanAsks";
import LanDeckList from "./LanDeckList";
import LanDiscoveryNotes from "./LanDiscoveryNotes";
import LanEntryRow from "./LanEntryRow";
import LanNetworkMap from "./LanNetworkMap";
import LanPeerModal from "./LanPeerModal";
import LanSetupModal from "./LanSetupModal";
import LanViewHeader from "./LanViewHeader";
import { SettingsFailureLine } from "./SettingsFailureLine";

// The peek's timing lives in use-hover-peek.ts and the gap an arm-then-confirm
// press needs in panel-press.ts, beside the rule that reads it. The fold at
// the foot of the accounts, the account menu's Remove and the custom sounds'
// Delete have always imported those from here, and are passed them through so
// that none of them had to change with the move. Every other name that used
// to pass through here is imported from the module that owns it.
export { PEEK_DELAY_MS, PEEK_GRACE_MS } from "../use-hover-peek";
export { CONFIRM_GAP_MS } from "../panel-press";

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
  // The peek beside the way-in row, and the one timer that opens and shuts it.
  // Held here rather than in the row, which the view takes away with it.
  const hoverPeek = useHoverPeek();
  /** Whether the decks that are not on are showing. Shut by default and kept
   *  for the session only: which decks are off changes while you watch, and a
   *  remembered fold would be about a list that no longer exists. */
  const [foldOpen, setFoldOpen] = useState(false);
  // What the deck says about the network, and every write this section makes
  // to it. Switching the network on is the one write that opens something
  // here: the setup dialog, on the press that did it.
  const {
    status, manual, now, busy, failure, dismissFailure, answerGiveBack, pressProps, load,
    toggle, answer, dropAddress, rename, checkOne, checkNow,
  } = useLanSection(onChanged, () => setSetupOpen(true));
  // Which paired row's unpair is armed, and what a press on one means. Held
  // here rather than in the list, which the view takes away with it.
  const { armed, pressUnpair } = useRowUnpair(answer);
  /** Which deck's own dialog is open, by the fingerprint its row is keyed on.
   *  A key rather than a row, so the dialog redraws from every poll — and a
   *  deck that changes kind under it, asked and then paired, stays open on the
   *  same machine. */
  const [peerOpen, setPeerOpen] = useState<string | null>(null);
  /** The network map, over whichever of the two presentations opened it.
   *  A deck's own dialog opens over the map rather than instead of it, so
   *  closing that dialog lands back on the picture it was opened from. */
  const [mapOpen, setMapOpen] = useState(false);

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
  // The requests, and the rest split at the fold — see viewRows.
  const { asks, rest, live, folded, troubled, shown, paired } = viewRows(rows, foldOpen);
  const state = sectionState(status, now);
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

      {mapOpen && (
        <LanNetworkMap
          status={status}
          rows={rows}
          accounts={accounts}
          now={now}
          covered={!!openRow}
          onOpenDeck={setPeerOpen}
          onClose={() => setMapOpen(false)}
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
          // The row's own verb, through the row's own call — see LanDeckList.
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
    return (
      <div className="ap-foot">
        <LanEntryRow entry={entry} rows={rows} onOpen={onOpen} onMap={on ? () => setMapOpen(true) : undefined} {...hoverPeek} />
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
      <LanViewHeader on={on} status={status} paired={paired} busy={busy} pressProps={pressProps}
        checkNow={checkNow} setAddOpen={setAddOpen} setSetupOpen={setSetupOpen} setMapOpen={setMapOpen} onBack={onBack}
        closeButton={closeButton} />
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

          <LanDiscoveryNotes on={on} status={status} />

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

            <SettingsFailureLine line={failure} onDismiss={dismissFailure} onAnswer={answerGiveBack} />

            {on && (
              <>
                {/* THE REQUEST, AND IT COMES FIRST. Somebody dialled this deck without
                    an invite and is waiting; until this is answered nothing moves
                    between them. Announced, because it arrives while the reader is
                    three sections up looking at a quota — and it also arrives as a
                    dialog in front of the canvas, for the reader who is not in this
                    panel at all. */}
                {asks.length > 0 && <LanAsks asks={asks} pressProps={pressProps} answer={answer} />}

                {/* EVERY OTHER MACHINE, ON ONE LIST. Paired, nearby, and the ones
                    already said no to — one row each, with the sentence that says
                    what is happening and the one control that changes it. They were
                    three lists in two surfaces, and the question a reader has is one
                    question. See deckRows. */}
                {shown.length > 0 && (
                  <LanDeckList
                    rows={shown}
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
