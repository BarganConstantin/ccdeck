// One machine on the network, opened from its row.
//
// THE ROW IS A GLANCE AND THIS IS THE LOOK. The panel's list answers one
// question — who is here, and is anything wrong — in a column 190px wide, and
// everything else it knew about a machine lived in a tooltip: the address, the
// raw error, why a deck that only calls in cannot be repaired from. A tooltip is
// mouse-only, a second late and silent to a screen reader, and it covered the
// rows under it. So the row keeps its one line and this carries the rest.
//
// WHAT IT ADDS that nothing else could show: a name for the machine that is this
// deck's own — the other deck's owner chose theirs, this is the other half — the
// logins that deck offers and what each of them would do here, and, sealed and
// from paired decks only, the version and the operating system it runs.
//
// THE PICTURE BEFORE THE PARTICULARS. What somebody opens this to find out is
// what goes from that machine to this one, what goes back, and which of it is
// broken — and it was answered as eleven lines of label and value and two lists
// to be read against each other. It is drawn now, in the shapes the Local
// network guide already taught: the two machines, the network between them,
// and one lane per login with the state of each copy at its own end and an
// arrow for each way a copy can travel. What is read across machines rather
// than at a glance — the fingerprint, the day it was paired — stays as label
// and value, under the picture.
//
// THE VERB IS THE ROW'S. Whatever the row's one button does, the foot of this
// does, through the same call and the same busy tag — so a press here lights the
// row behind it and the row's own press lights this. Nothing here decides
// anything the row could not.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { peerView, sinceLabel } from "../lan-peer";
import { pressState } from "../panel-press";
import { usePeerUnpair } from "../use-peer-unpair";
import { useModalDismiss } from "./use-modal-dismiss";
import LanPeerMap from "./LanPeerMap";
import LanPeerTwins from "./LanPeerTwins";
import { askedLabel } from "./LanSyncSection";
import type { DeckRow, LanAccount, LanStatus, RowSource } from "./LanSyncSection";

interface Props {
  row: DeckRow;
  /** The peer or stranger the row was built from, out of the same status. */
  source: RowSource;
  status: LanStatus;
  /** This deck's own accounts, to say what each offered login would do here. */
  accounts: LanAccount[];
  now: number;
  /** The section's one busy tag — see pressState. */
  busy: string | null;
  onClose: () => void;
  /** Each of these answers with the sentence to show when it did not work, and
   *  null when it did. */
  onRename: (name: string) => Promise<string | null>;
  onCheck: () => Promise<string | null>;
  onVerb: () => Promise<string | null>;
  /** Close this and open what this deck offers — the one list here that is
   *  not about the machine on the other end. */
  onSettings: () => void;
  /** Close this and open the add dialog with an invite made — the one way a
   *  nearby or declined machine can still be paired while this deck pairs
   *  only by invite. Optional so a caller from before the mode still fits. */
  onInvite?: () => void;
  /** The other decks folded into this row — its name at its address, one
   *  machine running more than one — each with the peer it was built from. */
  twins?: Array<{ row: DeckRow; peer: RowSource["peer"] }>;
  /** Unpair one of those, by fingerprint, through the row's own call. */
  onUnpair?: (fp: string) => Promise<string | null>;
}

/** Drawn at the section's own small-icon spec: 13px on a 14 viewBox, 1.3
 *  stroke, round caps — the plus, the round and the sliders beside the list. */
function Pencil() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor"
      strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9.6 2.4l2 2L5 11l-2.6.6L3 9z" />
      <path d="M8.4 3.6l2 2" />
    </svg>
  );
}

export default function LanPeerModal({
  row, source, status, accounts, now, busy, onClose, onRename, onCheck, onVerb, onSettings, onInvite,
  twins = [], onUnpair,
}: Props) {
  // The keyboard lands on ×, as it does in the tool inspector: this dialog is
  // opened to be read, and the first control in it — the pencil — would put a
  // stray Enter into renaming the machine somebody only came to look at.
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalDismiss(onClose, { focusRef: closeRef });
  /** The name being typed, or null while nobody is renaming. */
  const [draft, setDraft] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  /** Bumped when a check comes back, so the lanes draw themselves again: the
   *  picture that answered the press is visibly a new one. */
  const [drawn, setDrawn] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const editing = draft != null;
  // Selected rather than merely focused: renaming is almost always replacing,
  // and the name that is there is the one being replaced.
  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);

  const press = (tag: string) => {
    const s = pressState(busy, tag);
    return { disabled: s.disabled, "aria-busy": s.busy };
  };
  /** Run one of the section's calls and say what went wrong HERE — the
   *  section's own failure line is behind the scrim. */
  const run = async (act: () => Promise<string | null>) => {
    const said = await act();
    if (alive.current) setFailure(said);
    return said == null;
  };
  // The two unpairs this dialog draws — its own, and one per folded deck —
  // and the one moment of arming they share. See use-peer-unpair.ts.
  const { armed, armedTwin, pressOwn, pressTwin } = usePeerUnpair({ row, run, onVerb, onUnpair });

  // What the dialog says about the machine, decided in lan-peer.ts from the
  // row, the peer or stranger behind it and this deck's own status.
  const view = peerView({ row, source, status, accounts, now });
  const { peer, stranger, paired, own, canRename, fp } = view;
  // Whether this deck is asking that one right now, which the network's line
  // shows in the accent while the check is out.
  const asking = busy === `check:${row.fp}`;

  const saveName = async (typed: string) => {
    // Its own name, typed back, is no alias: the row would draw the same word
    // and the file would hold a name nobody can see.
    const name = typed.trim() === own ? "" : typed;
    if (await run(() => onRename(name))) setDraft(null);
  };

  const copy = async () => {
    if (!fp) return;
    try {
      await navigator.clipboard.writeText(fp);
      if (!alive.current) return;
      setCopied(true);
      window.setTimeout(() => { if (alive.current) setCopied(false); }, 1_600);
    } catch {
      if (alive.current) setFailure("Could not copy it — select the fingerprint and copy it by hand.");
    }
  };

  // What is read across machines rather than at a glance: when the pairing
  // was made, and the fingerprint to compare with the other screen.
  const facts: Array<{ label: string; value: ReactNode; tone?: "quiet" | "meta" }> = [];
  if (paired && peer?.pairedAt) {
    facts.push({ label: "Paired", value: sinceLabel(peer.pairedAt, now), tone: "meta" });
  } else if (row.kind === "declined" && stranger) {
    facts.push({ label: "Paired", value: `no · you said no ${askedLabel(stranger.at, now)}`, tone: "meta" });
  }
  facts.push({
    label: "Fingerprint",
    value: fp
      ? (
        <span className="lan-fp">
          <code className="ap-lan-code">{fp}</code>
          <button type="button" className="ap-lan-word lan-copy" onClick={() => void copy()}
            aria-label={copied ? "Fingerprint copied" : "Copy the fingerprint"}>
            {copied ? "copied" : "copy"}
          </button>
        </span>
      )
      : "not known — nothing has answered there",
    tone: fp ? undefined : "quiet",
  });

  // Every deck at this address, the one this dialog is about first. Empty for
  // the ordinary machine, which runs one.
  const instances = twins.length ? [{ row, peer: peer ?? null }, ...twins] : [];

  // Portalled like every dialog opened from inside the accounts panel: the
  // panel's layout rules are not a modal's to inherit — see AddAccountDialog.
  return createPortal(
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div ref={dialogRef} className="modal lan-peer" data-tone={row.tone} onClick={e => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-labelledby="lan-peer-title" aria-describedby="lan-peer-sub">
        <header className="modal-head lan-peer-head">
          <i className={row.here ? "ap-pulse" : "ap-dot"} aria-hidden />
          <div className="lan-peer-id">
            {editing ? (
              <form className="lan-peer-edit" onSubmit={e => { e.preventDefault(); void saveName(draft ?? ""); }}>
                <span id="lan-peer-title" className="vis-hidden">{row.name}</span>
                <input ref={inputRef} className="ap-manage-input lan-peer-input"
                  value={draft ?? ""} maxLength={48} placeholder={own}
                  aria-label="Name for this deck, shown on this deck only"
                  onChange={e => setDraft(e.target.value)} />
                <button type="submit" className="ap-manage-btn" {...press(`alias:${row.fp}`)}>save</button>
                <button type="button" className="ap-manage-btn" onClick={() => setDraft(null)}>cancel</button>
              </form>
            ) : (
              <span className="lan-peer-title">
                <span id="lan-peer-title" className="lan-peer-name">{row.name}</span>
                {canRename && (
                  <button type="button" className="glyph-btn lan-peer-rename"
                    onClick={() => { setFailure(null); setDraft(row.name); }}
                    aria-label={`Rename ${row.name} on this deck`}
                    title="Give it a name of your own. Only this deck sees it.">
                    <Pencil />
                  </button>
                )}
              </span>
            )}
            {/* THE STEADY STATE IS SILENCE HERE TOO. `quiet` is the row's own
                word for online with nothing to repair, and the list has obeyed
                it since it was written — a line every healthy row carries
                identically is a line that cannot be scanned. The sentence is
                still HERE, and still read aloud; it simply stops competing
                with the one thing on the surface a reader can act on. */}
            <p id="lan-peer-sub" className="lan-peer-sub">
              {row.self && (
                <>
                  calls itself <span className="lan-peer-self">{row.self}</span>
                  {editing && (
                    <button type="button" className="ap-lan-word lan-peer-restore" {...press(`alias:${row.fp}`)}
                      onClick={() => void saveName("")}>
                      use this name
                    </button>
                  )}
                  {/* The pause belongs to the sentence, not to the glyph: read
                      aloud, an aria-hidden `·` ran the name straight into the
                      state as one breathless clause. */}
                  <span className="vis-hidden">{". "}</span>
                  {!row.quiet && <span aria-hidden>{" · "}</span>}
                </>
              )}
              <span className={row.quiet ? "vis-hidden" : "lan-peer-state"}>{row.state}</span>
            </p>
          </div>
          <div className="modal-actions">
            <button ref={closeRef} type="button" className="glyph-btn" onClick={onClose}
              aria-label="Close (Esc)" title="Close (Esc)">×</button>
          </div>
        </header>

        <section className="modal-body lan-peer-body">
          {failure && (
            <div className="ap-failure" role="alert">
              <span className="ap-failure-text">{failure}</span>
              <button type="button" className="ap-failure-x" onClick={() => setFailure(null)}
                aria-label="Dismiss this message" title="Dismiss">×</button>
            </div>
          )}

          <LanPeerMap view={view} row={row} status={status} asking={asking} drawn={drawn} onSettings={onSettings} />

          <dl className="lan-facts">
            {facts.map(f => (
              <div key={f.label} className="lan-fact" data-tone={f.tone}>
                <dt>{f.label}</dt>
                <dd>{f.value}</dd>
              </div>
            ))}
          </dl>

          {/* One machine, more than one deck — see LanPeerTwins. */}
          {instances.length > 1 && (
            <LanPeerTwins instances={instances} now={now} busy={busy} press={press}
              armedTwin={armedTwin} pressTwin={pressTwin} onUnpair={onUnpair} />
          )}
        </section>

        {/* A ROW CAN CHANGE KIND UNDER AN OPEN DIALOG. A nearby deck that
            sends its request on the next poll comes back as `asks`, which has
            no verb here — the request is answered in its own dialog, where the
            fingerprint is shown and has to be read before anybody says yes, and
            that is not a decision to duplicate onto a bar at the bottom of a
            details panel. Before this, the bar drew itself empty: 51px of
            border and nothing in it, in the one state where the reader most
            needs telling what changed. */}
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
              onClick={() => void run(onCheck).then(ok => { if (ok && alive.current) setDrawn(n => n + 1); })}
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
      </div>
    </div>,
    document.body,
  );
}
