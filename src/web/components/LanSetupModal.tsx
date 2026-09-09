// Everything about LAN sync that is a DECISION, in one place, so the panel
// behind it can go back to being an instrument.
//
// WHY A MODAL. The section in the accounts panel had grown to nine controls in
// a 288px column — a name field, a passphrase field with three verbs, a column
// of account checkboxes, an address field, a check button and a peer list — and
// every one of them was on screen every time somebody opened the panel to look
// at a quota. Configuration is something you do twice: once when you set this
// up, once when you change your mind. What you do every day is look, and
// looking is what the panel is for.
//
// WHAT IS NOT HERE. The switch, and the requests waiting to be accepted. Both
// stay in the panel: the switch because it is the one control that answers "is
// this thing on", and a request because it arrives while nobody is looking at a
// dialog and is worthless if it waits for one to be opened.
import { useCallback, useEffect, useRef, useState } from "react";
import { useModalDismiss } from "./use-modal-dismiss";
import { selfPressAccepted, selfPressProps } from "../panel-press";
import { parseAddress, sameKeys, writeFailure } from "./LanSyncSection";
import type { LanAccount, LanStatus } from "./LanSyncSection";

/** How this deck is reached, as one line a person reads out to somebody else. */
export function dialLines(addrs: string[], port: number | null): string[] {
  if (port == null) return [];
  return (addrs ?? []).map(a => `${a}:${port}`);
}

export default function LanSetupModal({ status, accounts, manual, onClose, onChanged }: {
  status: LanStatus;
  accounts: LanAccount[];
  /** The addresses typed into this deck, from prefs. The status route reports
   *  peers, which is a different list: one is what we dial, the other is what
   *  answered. */
  manual: string[];
  onClose: () => void;
  /** Something was written — reload the section behind this and the roster. */
  onChanged: () => void;
}) {
  const dialogRef = useModalDismiss(onClose);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [addrDraft, setAddrDraft] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  /** What we last sent, so a second tick inside one poll window composes with
   *  the first instead of being built from a render that predates it. The same
   *  race the panel had, and the same fix. */
  const pending = useRef<string[] | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  // The server has caught up with the last thing we sent, so it is the truth
  // again and the optimistic copy is retired. Without this the boxes would keep
  // showing what was SENT even after the deck refused it.
  useEffect(() => {
    if (pending.current && sameKeys(pending.current, status.shared ?? [])) pending.current = null;
  }, [status.shared]);

  const write = useCallback(async (lan: Record<string, unknown>, what: string) => {
    busyRef.current = true;
    setBusy(true);
    try {
      const res = await fetch("/api/prefs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lan }),
      });
      const out = await res.json().catch(() => null);
      if (!alive.current) return;
      if (out?.ok) setFailure(null); else setFailure(writeFailure(what, out));
      onChanged();
    } catch {
      if (alive.current) setFailure(writeFailure(what, null));
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  }, [onChanged]);

  const peerAction = useCallback(async (action: string, fp: string, what: string) => {
    if (!selfPressAccepted(busyRef.current)) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const res = await fetch("/api/lan/peer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, fp }),
      });
      const out = await res.json().catch(() => null);
      if (!alive.current) return;
      if (out?.ok) setFailure(null); else setFailure(writeFailure(what, out));
      onChanged();
    } catch {
      if (alive.current) setFailure(writeFailure(what, null));
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  }, [onChanged]);

  const copy = useCallback(async (text: string) => {
    try { await navigator.clipboard?.writeText(text); setCopied(text); window.setTimeout(() => setCopied(null), 1600); }
    catch { setFailure("Could not reach the clipboard — select the text and copy it."); }
  }, []);

  const addAddress = () => {
    const typed = addrDraft.trim();
    if (!typed) return;
    const parsed = parseAddress(typed);
    if (!parsed) {
      // The text stays where it is. It used to be thrown away on a bad parse,
      // which left a blank box, no deck, and nothing saying anything was wrong.
      setFailure(`"${typed}" is not an address and a port — try 192.168.1.5:54340.`);
      return;
    }
    const entry = `${parsed.addr}:${parsed.port}`;
    setAddrDraft("");
    setFailure(null);
    if (!manual.includes(entry)) void write({ manual: [...manual, entry] }, "add that address");
  };

  const sharedList = pending.current ?? status.shared ?? [];
  const shared = new Set(sharedList);
  const dials = dialLines(status.addrs ?? [], status.port);

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div ref={dialogRef} className="modal lan-modal" onClick={e => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-labelledby="lan-modal-title">
        <header className="modal-head">
          <div className="modal-title">
            <span id="lan-modal-title" className="modal-tool-name">Local network</span>
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

          {/* ── this deck ─────────────────────────────────────────────────── */}
          <div className="modal-section">
            <h3 className="lan-h">This deck</h3>
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
                  void write({ name: nameDraft }, "save the name");
                  setNameDraft(null);
                }}
              />
              {nameDraft != null && nameDraft !== (status.name ?? "") && (
                <button type="button" className="ap-manage-btn" {...selfPressProps(busy)}
                  onClick={() => { void write({ name: nameDraft }, "save the name"); setNameDraft(null); }}
                  title="Save the name other decks see">save</button>
              )}
            </div>
            <p className="lan-note">Everyone on this network can see this name.</p>

            {/* THE THING SOMEBODY READS OUT. Every address, because which one
                the other machine can reach depends on where it is — a VPN, a
                second card, another subnet — and this side cannot answer that.
                The person picks; they are the only one who knows. */}
            {dials.length > 0 ? (
              <>
                <div className="ap-lan-row">
                  <span className="ap-lan-label">reach me at</span>
                  <span className="lan-dials">
                    {dials.map(d => (
                      <button key={d} type="button" className="ap-manage-btn lan-dial"
                        {...selfPressProps(busy)}
                        onClick={() => void copy(d)}
                        title="Copy this, and give it to the other deck">
                        <code className="ap-lan-code">{d}</code>
                        {copied === d && <span className="lan-copied">copied</span>}
                      </button>
                    ))}
                  </span>
                </div>
                <p className="lan-note">
                  Broadcast does not cross a router, so give the other deck whichever of these it can reach.
                </p>
              </>
            ) : (
              <p className="lan-note">This machine has no network address to give out yet.</p>
            )}
            {status.fp && (
              <div className="ap-lan-row">
                <span className="ap-lan-label">fingerprint</span>
                <code className="ap-lan-code">{status.fp}</code>
              </div>
            )}
          </div>

          {/* ── add a deck ────────────────────────────────────────────────── */}
          <div className="modal-section">
            <h3 className="lan-h">Add a deck</h3>
            <div className="ap-lan-row">
              <span className="ap-lan-label">by address</span>
              <input
                className="ap-manage-input ap-lan-input"
                aria-label="Another deck's address"
                value={addrDraft}
                placeholder="192.168.1.5:54340"
                onChange={e => setAddrDraft(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") addAddress(); }}
              />
              {addrDraft.trim() !== "" && (
                <button type="button" className="ap-manage-btn" {...selfPressProps(busy)}
                  onClick={() => { if (selfPressAccepted(busyRef.current)) addAddress(); }}
                  title="Dial this deck directly, for a machine broadcast cannot reach">add</button>
              )}
            </div>
            <p className="lan-note">
              The other deck asks its own owner to accept you. Nothing moves until they do.
            </p>

            {(status.strangers ?? []).length > 0 && (
              <>
                <h4 className="ap-lan-sub">heard on this network</h4>
                <div className="ap-lan-peers">
                  {(status.strangers ?? []).map(p => (
                    <div key={p.fp} className="ap-lan-peer">
                      <span className="ap-lan-peer-name">{p.name}</span>
                      <code className="ap-lan-code">{p.addr}</code>
                      <button type="button" className="ap-manage-btn ap-lan-drop" {...selfPressProps(busy)}
                        onClick={() => void peerAction("accept", p.fp, "pair with that deck")}
                        title={`Pair with ${p.name}. Its fingerprint is ${p.fp}.`}>pair</button>
                    </div>
                  ))}
                </div>
              </>
            )}

            {(status.manualRows ?? []).length > 0 && (
              <>
                <h4 className="ap-lan-sub">addresses this deck dials</h4>
                <div className="ap-lan-peers">
                  {(status.manualRows ?? []).map(row => (
                    <div key={row} className="ap-lan-peer">
                      <code className="ap-lan-code">{row}</code>
                      <button type="button" className="ap-manage-btn ap-lan-drop" {...selfPressProps(busy)}
                        onClick={() => void write({ manual: manual.filter(m => m !== row) }, "stop dialling that address")}
                        aria-label={`Stop dialling ${row}`}
                        title="Stop dialling this address">remove</button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* ── what this deck offers ─────────────────────────────────────── */}
          <div className="modal-section">
            <h3 className="lan-h">Share these accounts</h3>
            <p className="lan-warn">
              A login you share is a live one, and it cannot be taken back.
              Turning this off stops what has not happened yet.
            </p>
            <div className="ap-lan-picks">
              {accounts.length === 0 && <span className="ap-lan-empty">no accounts to share yet</span>}
              {accounts.map(a => (
                <label key={a.key} className="ap-lan-pick" title={a.alive
                  ? "Offer this account to the decks you have paired with, so one whose copy has died can heal from yours"
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
                  {!a.alive && <span className="ap-lan-dead">dead here</span>}
                </label>
              ))}
            </div>
          </div>

          {/* ── who this deck talks to ────────────────────────────────────── */}
          <div className="modal-section">
            <h3 className="lan-h">Paired decks</h3>
            {(status.trusted ?? []).length === 0 ? (
              <span className="ap-lan-empty">
                none yet — give another deck one of the addresses above, or accept the request it sends you
              </span>
            ) : (
              <div className="ap-lan-peers">
                {(status.trusted ?? []).map(t => (
                  <div key={t.fp} className="ap-lan-peer">
                    <span className="ap-lan-peer-name">{t.name || t.fp}</span>
                    <code className="ap-lan-code">{t.fp}</code>
                    <button type="button" className="ap-manage-btn danger ap-lan-drop" {...selfPressProps(busy)}
                      onClick={() => void peerAction("unpair", t.fp, "unpair that deck")}
                      aria-label={`Unpair ${t.name || t.fp}`}
                      title="Stop talking to this deck. It takes back nothing already shared.">unpair</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
