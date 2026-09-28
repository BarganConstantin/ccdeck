// The foot of a deck's own dialog: the one verb the row behind it offers,
// through the row's own call, and the check that asks that deck now.
//
// Lifted out of LanPeerModal.tsx unchanged. Whatever the row's one button does,
// this does, under the same busy tag, so a press here lights the row behind it
// and the row's own press lights this. The unpair's arming is the dialog's, in
// use-peer-unpair.ts; the check and every other verb go through the dialog's
// own `run`, so what went wrong is said in the dialog.
import type { DeckRow, RowSource } from "../lan-roster";
import type { LanStatus } from "../lan-types";

export default function LanPeerFoot({
  row, paired, peer, status, busy, press, checkNow, armed, pressOwn, run, onVerb, onInvite,
}: {
  row: DeckRow;
  paired: boolean;
  /** The peer the row was built from, when it is one. */
  peer: RowSource["peer"];
  status: LanStatus;
  /** The section's one busy tag — see pressState. */
  busy: string | null;
  /** The dialog's press state for a control, by busy tag. */
  press: (tag: string) => { disabled: boolean; "aria-busy": boolean };
  /** Ask that deck now, and draw the lanes again when it answers. */
  checkNow: () => void;
  /** Whether the dialog's own unpair is armed. */
  armed: boolean;
  pressOwn: () => void;
  /** The dialog's way of running one of the section's calls. */
  run: (act: () => Promise<string | null>) => Promise<boolean>;
  /** The row's own verb, through the row's own call. */
  onVerb: () => Promise<string | null>;
  /** The one way to pair a nearby machine while this deck pairs only by invite. */
  onInvite?: () => void;
}) {
  return (
    // A ROW CAN CHANGE KIND UNDER AN OPEN DIALOG. A nearby deck that
    // sends its request on the next poll comes back as `asks`, which has
    // no verb here — the request is answered in its own dialog, where the
    // fingerprint is shown and has to be read before anybody says yes, and
    // that is not a decision to duplicate onto a bar at the bottom of a
    // details panel. Before this, the bar drew itself empty: 51px of
    // border and nothing in it, in the one state where the reader most
    // needs telling what changed.
    <footer className="lan-peer-foot">
      {row.kind === "asks" && (
        <p className="lan-foot-note">This deck is now asking to pair. Answer it from the panel behind this.</p>
      )}
      {/* Not drawn for a deck that only calls in, rather than drawn dead:
          there is no address here to call it on, the note above says so,
          and a button that can never be pressed is a question with no
          answer. */}
      {paired && !peer?.waiting && (
        <button type="button" className="btn" {...press(`check:${row.fp}`)}
          onClick={checkNow}
          title="Ask this deck now instead of waiting for the next round">
          {busy === `check:${row.fp}` ? "Checking…" : "Check now"}
        </button>
      )}
      {row.kind === "paired" && (
        <button type="button" className={`btn danger lan-peer-verb${armed ? " armed" : ""}`}
          {...press(`unpair:${row.fp}`)}
          // A HELD KEY IS ONE DECISION TOO. The clock in pressOwn is the
          // rule for a mouse, where the second press cannot arrive before
          // the hand can mean it; a keyboard repeats at around half a
          // second, which clears that bar while the finger has never come
          // up. The repeat never reaches the click at all.
          onKeyDown={e => { if (e.repeat) e.preventDefault(); }}
          onClick={() => pressOwn()}
          // The row's own unpair names the machine; this one said only
          // "Unpair", and it is the same irreversible verb.
          aria-label={armed ? `Confirm unpairing ${row.name}` : `Unpair ${row.name}`}
          title={armed
            ? "Press again to stop talking to this deck. Logins it already has stay with it."
            : "Stop talking to this deck from now on"}>
          {busy === `unpair:${row.fp}` ? "Unpairing…" : armed ? "Confirm unpair" : "Unpair"}
        </button>
      )}
      {row.kind === "nearby" && status.pairingMode !== "invite" && (
        <button type="button" className="btn primary lan-peer-verb" {...press(`accept:${row.fp}`)}
          onClick={() => void run(onVerb)}
          title="Send it a request. Somebody at that machine has to accept it before anything is shared.">
          {busy === `accept:${row.fp}` ? "Asking…" : "Ask to pair"}
        </button>
      )}
      {row.kind === "dialling" && (
        <button type="button" className="btn lan-peer-verb" {...press(`drop:${row.fp}`)}
          onClick={() => void run(onVerb)}
          title="Stop trying this address. Nothing was ever paired here.">
          {busy === `drop:${row.fp}` ? "Stopping…" : "Stop dialling"}
        </button>
      )}
      {row.kind === "declined" && status.pairingMode !== "invite" && (
        <button type="button" className="btn lan-peer-verb" {...press(`allow:${row.fp}`)}
          onClick={() => void run(onVerb)}
          title="Take the no back. That deck is still trying, so its request comes round again on its own.">
          {busy === `allow:${row.fp}` ? "Allowing…" : "Let it ask again"}
        </button>
      )}
      {/* INVITE-ONLY LEAVES THIS FOOTER ONE VERB, not none. Without it a
          nearby or declined machine opened here showed a border with
          nothing in it — the state the comment on this footer says was
          fixed — at the moment the reader came here to pair it. */}
      {(row.kind === "nearby" || row.kind === "declined") && status.pairingMode === "invite" && onInvite && (
        <button type="button" className="btn primary lan-peer-verb"
          onClick={onInvite}
          title="This deck pairs only by invite. Make one and send it to whoever is at that machine.">
          Invite to pair
        </button>
      )}
    </footer>
  );
}
