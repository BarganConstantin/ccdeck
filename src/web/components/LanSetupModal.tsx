// What this deck IS on the network, and nothing about who it talks to.
//
// THE DIALOG USED TO BE THE WHOLE FEATURE. It held the invite, the join field,
// the address field, every deck ever paired with, the machines nearby, the
// firewall advice and a `check now` — thirteen controls in two columns, behind
// a button in a panel. Which meant the two things somebody does every day —
// see who is there, answer somebody who is asking — were the two things furthest
// away, and the reported symptom was exactly that: "it is too complicated, I
// should just see who wants to connect and press yes or no".
//
// So the split moved. WHO THIS DECK TALKS TO is a list, and a list belongs on
// the surface you already have open — it is in the panel now, one row per
// machine, with the verb that changes it on the end of the row. WHAT THIS DECK
// IS — the name it appears under and the logins it offers — is a decision made
// twice, and that is what is left here.
//
// Two fields, then, and both of them are about this machine. Everything that
// takes an address, a token or another deck's name is in LanSyncSection.tsx.
//
// AND TWO SWITCHES, which are the third thing this deck IS on the network: does
// it ask the machines it finds, and is a request that arrives answered here or
// answered for it. They are last on purpose. The dialog reads as one sentence
// in three parts — this is my name, these are the logins I offer, and this is
// who may take them — and the permission belongs after the list it is a
// permission over, where the warning under it can point at rows the reader has
// just looked at.
//
// BOTH ON BY DEFAULT, and the two are not the same risk. Asking gives nothing
// away: the machine on the other end still answers. Saying yes is the one that
// hands somebody a copy — which is said by the switch's own label rather than by
// a paragraph under it, because the default state is not where a reader needs
// prose. A switch somebody has turned OFF is: that deck is no longer doing what
// it says on the box, and the line under it says what that costs.
import { useCallback, useEffect, useRef, useState } from "react";
import { useModalDismiss } from "./use-modal-dismiss";
import { pressState } from "../panel-press";
import { sameKeys, writeFailure } from "./LanSyncSection";
import type { LanAccount, LanStatus } from "./LanSyncSection";

export default function LanSetupModal({ status, accounts, onClose, onChanged }: {
  status: LanStatus;
  accounts: LanAccount[];
  /** The addresses typed into this deck, from prefs. Unused here since the
   *  dialling moved into the panel — kept on the props so the section has one
   *  shape to pass and the two files cannot disagree about it. */
  manual?: string[];
  onClose: () => void;
  /** Something was written — reload the section behind this and the roster. */
  onChanged: () => void;
}) {
  const dialogRef = useModalDismiss(onClose);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  /** WHICH control is working, not WHETHER one is. `pressState` is what tells
   *  "yours" from "somebody else's", and it needs a tag to do it: one boolean
   *  across the name field and every account tick would mark all of them as
   *  working the instant any one of them was pressed. */
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef<string | null>(null);
  const pressProps = (tag: string) => {
    const s = pressState(busy, tag);
    return { disabled: s.disabled, "aria-busy": s.busy };
  };
  /** What we last sent, so a second tick inside one poll window composes with
   *  the first instead of being built from a render that predates it. */
  const pending = useRef<string[] | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  // The server has caught up with the last thing we sent, so it is the truth
  // again and the optimistic copy is retired. Without this the boxes would keep
  // showing what was SENT even after the deck refused it.
  useEffect(() => {
    if (pending.current && sameKeys(pending.current, status.shared ?? [])) pending.current = null;
  }, [status.shared]);

  const write = useCallback(async (lan: Record<string, unknown>, what: string, tag = "write") => {
    // Unguarded on purpose: a tick composes with the tick before it through
    // `pending`, and refusing the second press would drop it. What the tag adds
    // is only which control says it is working.
    busyRef.current = tag;
    setBusy(tag);
    try {
      const res = await fetch("/api/prefs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lan }),
      });
      const out = await res.json().catch(() => null);
      if (!alive.current) return false;
      if (out?.ok) setFailure(null); else setFailure(writeFailure(what, out));
      onChanged();
      return out?.ok === true;
    } catch {
      if (alive.current) setFailure(writeFailure(what, null));
      return false;
    } finally {
      busyRef.current = null;
      if (alive.current) setBusy(null);
    }
  }, [onChanged]);

  const shared = new Set(pending.current ?? status.shared ?? []);
  // Absent means on: a deck that has not written prefs since this shipped is a
  // deck with the defaults, and reading a missing key as `off` would draw the
  // switches against what the engine is actually doing.
  const asks = status.autoAsk !== false;
  const says = status.autoAccept !== false;

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div ref={dialogRef} className="modal lan-modal" onClick={e => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-labelledby="lan-modal-title">
        <header className="modal-head">
          <div className="modal-title">
            <span id="lan-modal-title" className="modal-tool-name">This deck on the network</span>
          </div>
          <div className="modal-actions">
            <button className="glyph-btn" onClick={onClose} aria-label="Close (Esc)" title="Close (Esc)">×</button>
          </div>
        </header>

        <section className="modal-body">
          {failure && (
            <div className="ap-failure" role="alert">
              <span className="ap-failure-text">{failure}</span>
              <button type="button" className="ap-failure-x" onClick={() => setFailure(null)}
                aria-label="Dismiss this message" title="Dismiss">×</button>
            </div>
          )}

          <div className="modal-section">
            <h3 className="lan-h">Name</h3>
            <div className="ap-lan-row">
              <span className="ap-lan-label">appear as</span>
              <input
                className="ap-manage-input ap-lan-input"
                aria-label="This deck's name on the network"
                value={nameDraft ?? status.name ?? ""}
                placeholder="this machine"
                onChange={e => setNameDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key !== "Enter" || nameDraft == null) return;
                  void write({ name: nameDraft }, "save the name", "name");
                  setNameDraft(null);
                }}
              />
              {nameDraft != null && nameDraft !== (status.name ?? "") && (
                <button type="button" className="ap-manage-btn" {...pressProps("name")}
                  onClick={() => { void write({ name: nameDraft }, "save the name", "name"); setNameDraft(null); }}
                  title="Save it. This is the name other decks show for this one.">save</button>
              )}
            </div>
            <p className="lan-note">Everyone on this network can see this name.</p>
            {status.fp && (
              <>
                <div className="ap-lan-row">
                  <span className="ap-lan-label">fingerprint</span>
                  <code className="ap-lan-code">{status.fp}</code>
                </div>
                {/* The one value that cannot be chosen, so it is the one worth
                    reading out. The other deck's owner sees it in the dialog
                    that asks them to accept this one. */}
                <p className="lan-note">
                  Read this out when somebody is deciding whether to accept this deck.
                </p>
              </>
            )}
          </div>

          <div className="modal-section">
            <h3 className="lan-h">Share these accounts</h3>
            <div className="ap-lan-picks">
              {accounts.length === 0 && (
                <span className="ap-lan-empty">
                  No Claude accounts on this deck yet — add one with + at the top of this panel.
                </span>
              )}
              {accounts.map(a => (
                <label key={a.key} className="ap-lan-pick" title={a.alive
                  ? "Offer this account to the decks you have paired with, so one whose copy has died can heal from yours. Unticking stops it being offered from now on; it does not take back a copy somebody already has."
                  : "This deck cannot use this login, so it has nothing to offer — a deck that can will heal it"}>
                  <input
                    type="checkbox"
                    checked={shared.has(a.key)}
                    onChange={e => {
                      const next = new Set(pending.current ?? status.shared ?? []);
                      if (e.target.checked) next.add(a.key); else next.delete(a.key);
                      pending.current = [...next];
                      void write(
                        { shared: [...next] },
                        e.target.checked ? "share that account" : "stop sharing that account",
                      );
                    }}
                  />
                  <span className="ap-lan-pick-name">{a.email}</span>
                  {/* Not "dead": a reader who has not read the docs cannot tell whether
                      that is about the account or about this machine. It is about this
                      machine's copy, and that is what makes it the one a peer heals. */}
                  {!a.alive && <span className="ap-lan-dead">not working here</span>}
                </label>
              ))}
            </div>
          </div>

          <div className="modal-section">
            <h3 className="lan-h">Pairing</h3>
            {/* Two rows and one shape, because they are the two halves of one
                question: who reaches whom without anybody pressing anything.
                The switch is the panel's own — same control, same words, so
                nobody has to learn a second on. */}
            <div className="lan-switches">
              <div className="lan-switch">
                <span className="lan-switch-what">Ask every deck this one finds</span>
                <button
                  type="button"
                  className={`ap-auto-state${asks ? " live" : ""}`}
                  role="switch"
                  aria-checked={asks}
                  aria-label="Ask every deck this one finds"
                  {...pressProps("ask")}
                  onClick={() => void write(
                    { autoAsk: !asks },
                    asks ? "stop asking automatically" : "ask every deck this one finds",
                    "ask",
                  )}
                  title={asks
                    ? "Stop sending requests on their own. You press ask on the row instead."
                    : "Send a pairing request to every deck heard on this network. Somebody over there still has to say yes."}
                >
                  <i className={asks ? "ap-pulse" : "ap-dot"} aria-hidden />
                  {asks ? "on" : "off"}
                </button>
              </div>
              <div className="lan-switch">
                <span className="lan-switch-what">Say yes to every deck that asks</span>
                <button
                  type="button"
                  className={`ap-auto-state${says ? " live" : ""}`}
                  role="switch"
                  aria-checked={says}
                  aria-label="Say yes to every deck that asks"
                  {...pressProps("accept")}
                  onClick={() => void write(
                    { autoAccept: !says },
                    says ? "stop accepting automatically" : "accept every deck that asks",
                    "accept",
                  )}
                  title={says
                    ? "Stop saying yes for you. A deck that asks waits in the panel again."
                    : "Say yes for you. Every deck on this network that asks is paired without anybody being asked here."}
                >
                  <i className={says ? "ap-pulse" : "ap-dot"} aria-hidden />
                  {says ? "on" : "off"}
                </button>
              </div>
            </div>
            {/* NOTHING TO SAY WHEN BOTH ARE ON, which is the state this ships in
                and the state the two labels above already describe in full. A
                paragraph under a switch that is doing what its own label says is
                a paragraph nobody reads twice — and the roster in the panel is
                built on the same rule: say something when there is something to
                say. What IS worth a line is a switch somebody has turned off,
                because then the deck behaves differently from its default and
                the difference is what a reader came here to check. */}
            {says ? null : asks ? (
              <p className="lan-note">
                This deck asks; somebody on the other machine still has to say yes. A
                request coming the other way waits in the panel for you.
              </p>
            ) : (
              <p className="lan-note">
                Nothing pairs on its own. You press <strong>ask</strong> on a deck you find,
                and <strong>accept</strong> on one that asks. A deck you said no to is never
                asked about again either way.
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
