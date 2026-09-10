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
import { pressAccepted, pressState } from "../panel-press";
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
  const [busy, setBusy] = useState<string | null>(null);
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
  /** WHICH control is working, not WHETHER one is. This dialog spelled the
   *  panel's tagged request slot as a single boolean across thirteen controls,
   *  which was invisible only while nothing painted `aria-busy`. Painted, one
   *  boolean would mark `make an invite`, `join`, `check now`, every `unpair`
   *  and every account tick as working the instant any one of them was pressed.
   *  `pressState` exists to tell "yours" from "somebody else's"; it needs a tag
   *  to do it. */
  const busyRef = useRef<string | null>(null);
  /** Take the dialog's one request slot, or refuse the press. */
  const claim = useCallback((tag: string) => {
    if (!pressAccepted(busyRef.current)) return false;
    busyRef.current = tag;
    setBusy(tag);
    return true;
  }, []);
  const release = useCallback(() => {
    busyRef.current = null;
    if (alive.current) setBusy(null);
  }, []);
  /** Inert while somebody else is working; busy and still focusable while it is
   *  your own request. */
  const pressProps = (tag: string) => {
    const s = pressState(busy, tag);
    return { disabled: s.disabled, "aria-busy": s.busy };
  };
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

  const write = useCallback(async (lan: Record<string, unknown>, what: string, tag = "write") => {
    // Unguarded on purpose, as it always was: a tick composes with the tick
    // before it through `pending`, and refusing the second press would drop it.
    // What the tag adds is only which control says it is working.
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
      // Whether it landed, for the one caller that has something to do next.
      // Everybody else spells the call `void write(...)` and is unaffected.
      return !!out?.ok;
    } catch {
      if (alive.current) setFailure(writeFailure(what, null));
      return false;
    } finally {
      release();
    }
  }, [onChanged]);

  const peerAction = useCallback(async (action: string, fp: string, what: string) => {
    if (!claim(`:`)) return;
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
      release();
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
    if (!claim(`invite:`)) return;
    setCopied(null);
    try {
      const out = await call("/api/lan/invite", { action });
      if (!alive.current) return;
      if (out?.ok) { setFailure(null); onChanged(); }
      else setFailure(writeFailure(action === "make" ? "make an invite" : "put the invite away", out));
    } catch {
      if (alive.current) setFailure(writeFailure("make an invite", null));
    } finally {
      release();
    }
  }, [call, onChanged]);

  const join = useCallback(async () => {
    const token = joinDraft.trim();
    if (!token || !claim("join")) return;
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
      release();
      if (alive.current) setJoining(false);
    }
  }, [joinDraft, call, onChanged]);

  const checkNow = useCallback(async () => {
    if (!claim("check")) return;
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
      release();
      if (alive.current) setChecking(false);
    }
  }, [onChanged]);

  const copy = useCallback(async (text: string) => {
    try { await navigator.clipboard?.writeText(text); setCopied(text); window.setTimeout(() => setCopied(null), 1600); }
    catch { setFailure("Could not reach the clipboard — select the text and copy it."); }
  }, []);

  const addAddress = async () => {
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
    if (manual.includes(entry)) return;
    // KNOCK NOW RATHER THAN WITHIN THE MINUTE. Somebody types an address
    // because the deck was not found on its own, so the question they are
    // asking is "can this one be reached" — and a row that sits there saying
    // nothing for up to SYNC_MS is that question unanswered. The write puts it
    // in the dial list; this makes the first dial happen while they are still
    // looking at it.
    if (await write({ manual: [...manual, entry] }, "add that address", "add")) await checkNow();
  };

  // ONLY THE ONES SOMEBODY ACTUALLY PAIRED WITH. An address in the dial list
  // that has never answered is not a paired deck, and listing it under that
  // heading was the dialog telling the reader something untrue — those rows
  // already have a home two blocks up, under the addresses this deck dials.
  const paired = (status.peers ?? []).filter(p => p.paired);
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

          {/* TWO COLUMNS, AND THEY ARE TWO SUBJECTS. Left is this machine —
              what it is called, where it can be reached, which of its logins it
              offers. Right is everybody else — how to reach one, who is nearby,
              who it already talks to. Wrapped rather than left to the grid's own
              row-major flow, because two sections of very different heights in
              one grid leave a hole under the shorter of them. */}
          <div className="lan-col">
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
                        {...pressProps(`copy:${d}`)}
                        onClick={() => void copy(d)}
                        title="Copy this address, and give it to the other deck">
                        <code className="ap-lan-code">{d}</code>
                        {copied === d && <span className="lan-copied">copied</span>}
                      </button>
                    ))}
                  </span>
                </div>
                <p className="lan-note">
                  A deck on another network cannot find this one on its own. Give it whichever
                  of these it can reach — or send an invite, which carries them all.
                </p>
              </>
            ) : (
              <p className="lan-note">
                No network address yet. This machine is not connected to anything other decks could reach.
              </p>
            )}
            {status.fp && (
              <>
                <div className="ap-lan-row">
                  <span className="ap-lan-label">fingerprint</span>
                  <code className="ap-lan-code">{status.fp}</code>
                </div>
                <p className="lan-note">
                  This deck&apos;s own. When somebody asks to pair, compare the one they show
                  against the one on their screen.
                </p>
              </>
            )}
          </div>

          {/* ── what this deck offers ─────────────────────────────────────── */}
          <div className="modal-section">
            <h3 className="lan-h">Share these accounts</h3>
            <p className="lan-warn">
              A login you tick here is a working one, and another deck keeps its own copy.
              Unticking stops it being offered from now on — it does not take back a copy
              somebody already has.
            </p>
            <div className="ap-lan-picks">
              {accounts.length === 0 && (
                <span className="ap-lan-empty">
                  No Claude accounts on this deck yet — add one with + at the top of this panel.
                </span>
              )}
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
                  {/* Not "dead": a reader who has not read the docs cannot tell whether
                      that is about the account or about this machine. It is about this
                      machine's copy, and that is what makes it the one a peer heals. */}
                  {!a.alive && <span className="ap-lan-dead">not working here</span>}
                </label>
              ))}
            </div>
          </div>

          </div>
          <div className="lan-col">
          {/* ── pair with a deck ──────────────────────────────────────────── */}
          <div className="modal-section">
            <h3 className="lan-h">Pair with another deck</h3>

            {/* WHY THE LIST IS EMPTY, WHEN THE MACHINE CAN BE ASKED. "Nothing
                here yet" and "nothing can get in" look identical and are not:
                the first is answered by waiting and the second never is. The
                reported shape was "he sees me and I see nobody", which is one
                machine dropping unsolicited inbound while its own beacon
                leaves freely — so both people read the same feature as working
                and as broken.

                THE ORDER OF THE TWO ANSWERS IS THE POINT. What comes first is
                the way out that needs no firewall rule at all, because a round
                is one OUTBOUND connection: this deck dialling is enough for the
                whole of it. The command comes second, is optional, and is text
                — nothing here runs it, for the reason relay-guard.mjs gives. */}
            {status.reach?.blocked && (
              <div className="ap-lan-reach">
                <p className="lan-warn">{status.reach.text}</p>
                <p className="lan-note">
                  Nothing here is stuck: a deck that dials out first needs none of this.
                  {" "}<strong>Ask them to make the invite and paste it below</strong> — an invite is
                  dialled by whoever pastes it, so on this machine it has to be pasted rather
                  than made. Typing their address below works the same way.
                </p>
                {(status.reach.steps ?? []).length > 0 && (
                  <details className="ap-lan-reach-fix">
                    <summary>or let them find this deck on their own</summary>
                    <p className="lan-note">
                      Run this in PowerShell <strong>as Administrator</strong>, then restart the deck.
                      {status.reach.category === "Public" && (
                        <> The first line marks this network as a home or office one — leave it
                        out on a network you do not trust.</>
                      )}
                    </p>
                    <pre className="ap-lan-cmd"><code>{(status.reach.steps ?? []).join("\n")}</code></pre>
                    <button type="button" className="ap-manage-btn" {...pressProps("copy:fix")}
                      onClick={() => void copy((status.reach?.steps ?? []).join("\n"))}
                      title="Copy these lines, then paste them into an elevated PowerShell">
                      {copied === (status.reach.steps ?? []).join("\n") ? "copied" : "copy command"}
                    </button>
                  </details>
                )}
              </div>
            )}

            {status.invite && status.invite.expiresAt > now ? (
              <div className="ap-lan-invite">
                <div className="ap-lan-invite-head">
                  <span className="ap-lan-invite-title">Send this to them</span>
                  <span className="ap-lan-invite-left">{leftLabel(status.invite.expiresAt, now)} left</span>
                </div>
                <code className="ap-lan-token">{status.invite.token}</code>
                <div className="ap-lan-acts">
                  <button type="button" className="ap-manage-btn" {...pressProps("copy:invite")}
                    onClick={() => void copy(status.invite!.token)}
                    title="Copy it, and send it however you already talk to them">
                    {copied === status.invite.token ? "copied" : "copy invite"}
                  </button>
                  <button type="button" className="ap-manage-btn" {...pressProps("invite:withdraw")}
                    onClick={() => void invite("withdraw")}
                    title="Cancel it. Anybody already holding the text can no longer use it.">
                    cancel invite
                  </button>
                </div>
                {/* Said once, where the decision is: what holding this token
                    actually lets somebody do, and that it carries every address
                    so they never have to know which one they can reach. */}
                <p className="lan-note">
                  They paste it and it pairs itself — nothing to press here.
                  It carries every address this deck has, so they do not have to know which one works.
                </p>
                <p className="lan-warn">
                  Anyone who gets hold of this text can pair with this deck until it runs out.
                </p>
              </div>
            ) : (
              <button type="button" className="ap-manage-btn lan-primary" {...pressProps("invite:make")}
                onClick={() => void invite("make")}
                title="One piece of text you send them. They paste it and the two decks pair.">
                make an invite
              </button>
            )}

            <div className="lan-or">or paste one you were sent</div>
            <div className="ap-lan-join">
              <input
                className="ap-manage-input ap-lan-input"
                aria-label="An invite you were sent"
                value={joinDraft}
                placeholder="ccdeck1…"
                spellCheck={false}
                onChange={e => { setJoinDraft(e.target.value); setTried(null); setJoinedWith(null); }}
                onKeyDown={e => { if (e.key === "Enter") void join(); }}
              />
              {joinDraft.trim() !== "" && (
                <button type="button" className="ap-manage-btn" {...pressProps("join")}
                  onClick={() => void join()}
                  title="Reach that deck and pair with it. Nobody has to press anything there.">
                  {joining ? "joining…" : "join"}
                </button>
              )}
            </div>
            {joinedWith && (
              <p className="lan-note lan-good">
                ✓ Paired with {joinedWith}. It is in the list below now.
              </p>
            )}
            {tried && (
              <div className="ap-lan-tried">
                <span className="lan-note">
                  Nothing answered at any address in that invite. Check that deck is running
                  and that its Local network switch is on.
                </span>
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
                <h4 className="ap-lan-sub">on this network right now</h4>
                <p className="lan-note">
                  You are not paired with any of these yet. Asking sends a request the
                  person at that machine has to accept.
                </p>
                <div className="ap-lan-peers">
                  {(status.strangers ?? []).map(p => (
                    <div key={p.fp} className="ap-lan-peer">
                      <span className="ap-lan-peer-name">{p.name}</span>
                      <code className="ap-lan-code">{p.addr}</code>
                      <button type="button" className="ap-manage-btn ap-lan-drop" {...pressProps(`accept:${p.fp}`)}
                        onClick={() => void peerAction("accept", p.fp, "reach that deck")}
                        title={`Send ${p.name} a request. Somebody at that machine has to accept it before anything is shared. Its fingerprint is ${p.fp}.`}>
                        ask to pair
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}

            {(status.manualRows ?? []).length > 0 && (
              <>
                <h4 className="ap-lan-sub">addresses this deck keeps trying</h4>
                <div className="ap-lan-peers">
                  {(status.manualRows ?? []).map(row => (
                    <div key={row} className="ap-lan-peer">
                      <code className="ap-lan-code">{row}</code>
                      <button type="button" className="ap-manage-btn ap-lan-drop" {...pressProps(`manual:${row}`)}
                        onClick={() => void write({ manual: manual.filter(m => m !== row) }, "stop dialling that address", `manual:${row}`)}
                        aria-label={`Stop trying ${row}`}
                        title="Stop trying this address">remove</button>
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* THE FIELD IS NOT PART OF THE LIST ABOVE, and it used to be —
                inside the same `manualRows.length > 0` block it fills. So the
                only way to reach the box that adds the FIRST address was to
                already have one, which is the state it exists to leave. From a
                clean install this control could not be reached at all.
                Reported as "there is no way to just type an IP". */}
            <div className="ap-lan-row">
              <span className="ap-lan-label">by address</span>
              <input
                className="ap-manage-input ap-lan-input"
                aria-label="Another deck's address"
                value={addrDraft}
                placeholder="192.168.1.5:54340"
                onChange={e => setAddrDraft(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") void addAddress(); }}
              />
              {addrDraft.trim() !== "" && (
                <button type="button" className="ap-manage-btn" {...pressProps("add")}
                  onClick={() => void addAddress()}
                  title="Try this address every minute, starting now. Use it when a deck cannot be found on its own.">add</button>
              )}
            </div>
            {(status.manualRows ?? []).length === 0 && (
              <p className="lan-note">
                Decks on one network find each other without this. Type an address when that
                has not happened — another subnet, a VPN, or a firewall in the way.
              </p>
            )}
          </div>

          {/* ── who this deck talks to ────────────────────────────────────── */}
          <div className="modal-section">
            <h3 className="lan-h">
              Paired decks
              <button type="button" className="ap-manage-btn lan-h-btn" {...pressProps("check")}
                onClick={() => void checkNow()}
                title="Check every paired deck now, instead of waiting for the next minute">
                {checking ? "checking…" : "check now"}
              </button>
            </h3>
            {paired.length === 0 ? (
              <span className="ap-lan-empty">
                none yet — make an invite above and send it, or paste one you were sent
              </span>
            ) : (
              <div className="ap-lan-peers">
                {paired.map(p => {
                  const line = roundLabel(p.last, now);
                  const here = isOnline(p, now);
                  return (
                    <div key={p.fp} className="ap-lan-peer">
                      <i className={here ? "ap-pulse" : "ap-dot"} aria-hidden />
                      {p.manual && !p.met
                        ? <code className="ap-lan-code">{p.addr}:{p.port}</code>
                        : <span className="ap-lan-peer-name">{p.name}</span>}
                      <span className="ap-lan-peer-when" title={p.addr ? `${p.addr}:${p.port}` : undefined}>
                        {/* "it calls us" was true and internal-sounding. What it means to a
                            reader is that this deck has no address for that one, so the
                            connection only happens in one direction. */}
                        {here ? "here" : p.waiting ? "reaches us" : p.lastSeen != null ? seenLabel(p.lastSeen, now) : "away"}
                      </span>
                      <button type="button" className="ap-manage-btn danger ap-lan-drop" {...pressProps(`unpair:${p.peerFp ?? p.fp}`)}
                        onClick={() => void peerAction("unpair", p.peerFp ?? p.fp, "unpair that deck")}
                        aria-label={`Unpair ${p.name}`}
                        title="Stop talking to this deck from now on. Logins it already has stay with it.">unpair</button>
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
          </div>
        </section>
      </div>
    </div>
  );
}
