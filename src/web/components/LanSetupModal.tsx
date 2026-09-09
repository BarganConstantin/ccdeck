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
// WHAT IS NOT HERE. The switch, who is online right now, and the requests
// waiting to be accepted. All three stay in the panel: the switch because it is
// the control that answers "is this on", the roster because it is the one thing
// worth a glance every day, and a request because it arrives while nobody is
// looking at a dialog and is worthless if it waits for one to be opened.
//
// EVERYTHING ELSE IS HERE, and that is the whole shape of it. Making an invite,
// joining on somebody else's, this deck's name and fingerprint, which accounts
// it offers, and every deck it has ever paired with — online or not. The panel
// is an instrument; this is the workshop.
import { useCallback, useEffect, useRef, useState } from "react";
import { useModalDismiss } from "./use-modal-dismiss";
import { selfPressAccepted, selfPressProps } from "../panel-press";
import { isOnline, leftLabel, parseAddress, roundLabel, sameKeys, seenLabel, writeFailure } from "./LanSyncSection";
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
  const [joinDraft, setJoinDraft] = useState("");
  const [joining, setJoining] = useState(false);
  const [checking, setChecking] = useState(false);
  /** Which addresses a failed join tried, and what each one said. An invite
   *  carries several because nobody knows which routes; when none did, that
   *  list is the only thing the reader can act on. */
  const [tried, setTried] = useState<Array<{ addr: string; why: string }> | null>(null);
  const [joinedWith, setJoinedWith] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // The invite has a countdown on it, so this dialog has a clock.
    const iv = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(iv);
  }, []);
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

  const call = useCallback(async (url: string, body: Record<string, unknown>) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json().catch(() => null);
  }, []);

  const invite = useCallback(async (action: "make" | "withdraw") => {
    if (!selfPressAccepted(busyRef.current)) return;
    busyRef.current = true;
    setBusy(true);
    setCopied(null);
    try {
      const out = await call("/api/lan/invite", { action });
      if (!alive.current) return;
      if (out?.ok) { setFailure(null); onChanged(); }
      else setFailure(writeFailure(action === "make" ? "make an invite" : "put the invite away", out));
    } catch {
      if (alive.current) setFailure(writeFailure("make an invite", null));
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  }, [call, onChanged]);

  const join = useCallback(async () => {
    const token = joinDraft.trim();
    if (!token || !selfPressAccepted(busyRef.current)) return;
    busyRef.current = true;
    setBusy(true);
    setJoining(true);
    setTried(null);
    setJoinedWith(null);
    try {
      const out = await call("/api/lan/invite", { action: "join", token });
      if (!alive.current) return;
      if (out?.ok) {
        setFailure(null);
        setJoinDraft("");
        setJoinedWith(out.peer?.name ?? "that deck");
        onChanged();
      } else if (out?.reason === "not_an_invite") {
        setFailure("That is not an invite. Paste the whole thing — it starts with ccdeck1.");
      } else if (out?.reason === "expired") {
        setFailure("That invite has run out. Ask for a new one.");
      } else if (out?.reason === "unreachable") {
        setTried(out.tried ?? []);
      } else {
        setFailure(writeFailure("join that deck", out));
      }
    } catch {
      if (alive.current) setFailure(writeFailure("join that deck", null));
    } finally {
      busyRef.current = false;
      if (alive.current) { setBusy(false); setJoining(false); }
    }
  }, [joinDraft, call, onChanged]);

  const checkNow = useCallback(async () => {
    if (!selfPressAccepted(busyRef.current)) return;
    busyRef.current = true;
    setBusy(true);
    setChecking(true);
    try {
      const res = await fetch("/api/lan/sync", { method: "POST" });
      const out = await res.json().catch(() => null);
      if (!alive.current) return;
      if (out?.ok) { setFailure(null); onChanged(); }
      else setFailure(writeFailure("check the paired decks", out));
    } catch {
      if (alive.current) setFailure(writeFailure("check the paired decks", null));
    } finally {
      busyRef.current = false;
      if (alive.current) { setBusy(false); setChecking(false); }
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

          {/* ── pair with a deck ──────────────────────────────────────────── */}
          <div className="modal-section">
            <h3 className="lan-h">Pair with another deck</h3>

            {status.invite && status.invite.expiresAt > now ? (
              <div className="ap-lan-invite">
                <div className="ap-lan-invite-head">
                  <span className="ap-lan-invite-title">Send this to them</span>
                  <span className="ap-lan-invite-left">{leftLabel(status.invite.expiresAt, now)} left</span>
                </div>
                <code className="ap-lan-token">{status.invite.token}</code>
                <div className="ap-lan-acts">
                  <button type="button" className="ap-manage-btn" {...selfPressProps(busy)}
                    onClick={() => void copy(status.invite!.token)}
                    title="Copy it, and send it however you already talk to them">
                    {copied === status.invite.token ? "copied" : "copy invite"}
                  </button>
                  <button type="button" className="ap-manage-btn" {...selfPressProps(busy)}
                    onClick={() => void invite("withdraw")}
                    title="Stop offering it. Anybody holding it can no longer pair.">
                    put it away
                  </button>
                </div>
                {/* Said once, where the decision is: what holding this token
                    actually lets somebody do, and that it carries every address
                    so they never have to know which one they can reach. */}
                <p className="lan-note">
                  It carries this deck&apos;s addresses and a code, so they do not have to know
                  which one they can reach. Anyone holding it can pair with this deck until it
                  runs out. They paste it and it pairs itself — nobody has to press anything here.
                </p>
              </div>
            ) : (
              <button type="button" className="ap-manage-btn lan-primary" {...selfPressProps(busy)}
                onClick={() => void invite("make")}
                title="One piece of text that carries this deck's addresses and a code">
                make an invite
              </button>
            )}

            <div className="lan-or">or paste one you were sent</div>
            <div className="ap-lan-join">
              <input
                className="ap-manage-input ap-lan-input"
                aria-label="An invite you were sent"
                value={joinDraft}
                placeholder="ccdeck1.…"
                spellCheck={false}
                onChange={e => { setJoinDraft(e.target.value); setTried(null); setJoinedWith(null); }}
                onKeyDown={e => { if (e.key === "Enter") void join(); }}
              />
              {joinDraft.trim() !== "" && (
                <button type="button" className="ap-manage-btn" {...selfPressProps(busy)}
                  onClick={() => void join()}
                  title="Reach that deck and pair with it. Nobody has to press anything on the other side.">
                  {joining ? "joining…" : "join"}
                </button>
              )}
            </div>
            {joinedWith && <p className="lan-note lan-good">Paired with {joinedWith}.</p>}
            {tried && (
              <div className="ap-lan-tried">
                <span className="lan-note">None of the addresses in that invite answered:</span>
                {tried.map(t => (
                  <span key={t.addr} className="ap-lan-tried-row">
                    <code className="ap-lan-code">{t.addr}</code>
                    <span className="ap-lan-bad">{t.why}</span>
                  </span>
                ))}
              </div>
            )}

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
                        title={`Reach ${p.name} and ask its owner to accept. Its fingerprint is ${p.fp}.`}>ask it</button>
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
            <h3 className="lan-h">
              Paired decks
              <button type="button" className="ap-manage-btn lan-h-btn" {...selfPressProps(busy)}
                onClick={() => void checkNow()}
                title="Ask every paired deck right now instead of waiting for the next minute">
                {checking ? "checking…" : "check now"}
              </button>
            </h3>
            {(status.peers ?? []).length === 0 ? (
              <span className="ap-lan-empty">
                none yet — make an invite above and send it, or paste one you were sent
              </span>
            ) : (
              <div className="ap-lan-peers">
                {(status.peers ?? []).map(p => {
                  const line = roundLabel(p.last, now);
                  const here = isOnline(p, now);
                  return (
                    <div key={p.fp} className="ap-lan-peer">
                      <i className={here ? "ap-pulse" : "ap-dot"} aria-hidden />
                      {p.manual && !p.met
                        ? <code className="ap-lan-code">{p.addr}:{p.port}</code>
                        : <span className="ap-lan-peer-name">{p.name}</span>}
                      <span className="ap-lan-peer-when" title={p.addr ? `${p.addr}:${p.port}` : undefined}>
                        {here ? "here" : p.waiting ? "it calls us" : p.lastSeen != null ? seenLabel(p.lastSeen, now) : "away"}
                      </span>
                      <button type="button" className="ap-manage-btn danger ap-lan-drop" {...selfPressProps(busy)}
                        onClick={() => void peerAction("unpair", p.peerFp ?? p.fp, "unpair that deck")}
                        aria-label={`Unpair ${p.name}`}
                        title="Stop talking to this deck. It takes back nothing already shared.">unpair</button>
                      {line && (
                        <span className={`ap-lan-peer-last${line.tone === "bad" ? " ap-lan-bad" : ""}`}>
                          {line.text}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
