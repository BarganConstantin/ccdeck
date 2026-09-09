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
// WHAT THIS SECTION IS NOW. An instrument: is it on, who is paired, what
// happened, and who is asking. Every DECISION moved into LanSetupModal, because
// configuration is something you do twice and looking is something you do every
// day.
//
// WHAT IT REFUSES TO SAY. Not "sharing is revocable". Unpairing stops what has
// not happened yet; a refresh token that has left this machine is gone, and the
// only real revocation is a re-login at Anthropic, which kills the session on
// every machine at once.
import { useCallback, useEffect, useRef, useState } from "react";
import { selfPressAccepted, selfPressProps } from "../panel-press";
import LanSetupModal from "./LanSetupModal";

/** One deck this one dials, as the status route reports it. */
interface Peer {
  fp: string;
  name: string;
  addr: string;
  port: number;
  manual?: boolean;
  /** A typed address that has answered at least once, so its name is the name
   *  the deck on the other end gave rather than the address we dialled. */
  met?: boolean;
  lastSeen?: number;
  last?: { at: number; error?: string; done?: Array<{ email: string; action: string; ok: boolean }> } | null;
}

/** A deck that finished a handshake, or was merely heard, and that nobody here
 *  has accepted yet. */
export interface LanStranger { fp: string; name: string; addr: string; port?: number; at: number }

export interface LanStatus {
  enabled: boolean;
  running: boolean;
  name: string;
  fp: string | null;
  port: number | null;
  addrs: string[];
  shared: string[];
  peers: Peer[];
  trusted: Array<{ fp: string; name: string }>;
  pending: LanStranger[];
  strangers: LanStranger[];
  /** Filled in by the section from prefs, so the modal can list what this deck
   *  dials without asking for prefs a second time. */
  manualRows?: string[];
}

/** The accounts this deck holds, in the shape the panel already has them. */
export interface LanAccount { key: string; email: string; alive: boolean }

/** How long ago, in the panel's own vocabulary. Seconds are not printed: a
 *  beacon lands every thirty of them, so "12s ago" would be a number that
 *  changes while you read it and means nothing different from "now". */
export function seenLabel(lastSeen: number | undefined, now: number): string {
  if (lastSeen == null) return "not seen";
  const s = Math.max(0, Math.round((now - lastSeen) / 1000));
  if (s < 90) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

/** What the last round with one peer did: the sentence, and which of the three
 *  things it is. */
export interface RoundLine { text: string; tone: "bad" | "idle" | "ok" }

/**
 * What the last round with one peer did, as a line and a tone.
 *
 * An error is said plainly and is not translated into reassurance: a deck that
 * cannot be reached is a deck that cannot heal anything, and a row that said
 * "waiting" over a refused handshake would be the panel lying about a thing the
 * user can fix on the other machine.
 *
 * THE TONE TRAVELS WITH THE SENTENCE, where it can be tested, rather than being
 * inferred from the string by a stylesheet that cannot. This list is the whole
 * readout of whether the feature works, and the one thing anybody scans a list
 * like this for is which row is wrong.
 */
export function roundLabel(last: Peer["last"], now: number): RoundLine | null {
  if (!last) return null;
  if (last.error) return { text: `could not reach it — ${last.error}`, tone: "bad" };
  const done = last.done ?? [];
  if (!done.length) return { text: `nothing to do · checked ${seenLabel(last.at, now)}`, tone: "idle" };
  const ok = done.filter(d => d.ok);
  const verb = ok.length === 1 ? "account" : "accounts";
  return ok.length === done.length
    ? { text: `took ${ok.length} ${verb} · ${seenLabel(last.at, now)}`, tone: "ok" }
    // Some moved and some did not, which is neither a clean round nor a failure
    // to reach the deck. It reads as the partial thing it is.
    : { text: `took ${ok.length} of ${done.length} · ${seenLabel(last.at, now)}`, tone: "bad" };
}

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
  return { addr, port };
}

/**
 * Why a write did not happen, in words rather than in silence.
 *
 * Every one of these was silence. The distinction matters because the two cases
 * fail for completely different causes and lead to completely different next
 * moves: a deck that answered `bad_request` has a panel bug behind it, and a
 * deck that answered nothing at all has stopped.
 */
export function writeFailure(what: string, out: { ok?: boolean; reason?: string } | null): string {
  if (out == null) return `Could not ${what} — the deck did not answer.`;
  return out.reason
    ? `Could not ${what} — the deck refused it (${out.reason}).`
    : `Could not ${what}.`;
}

/** Two lists of account keys, same members or not. Order is not meaning here:
 *  the server stores what it is sent, and the panel sends a Set. */
export function sameKeys(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const seen = new Set(a);
  return b.every(k => seen.has(k));
}

/** How long a request has been waiting. Coarser than the peer clock on purpose:
 *  the answer is a press, and "4m ago" changes nothing about whether to make
 *  it. */
export function askedLabel(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 90) return "just now";
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

async function post(url: string, body: Record<string, unknown>) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json().catch(() => null);
}

export default function LanSyncSection({ accounts, onChanged }: {
  accounts: LanAccount[];
  /** The roster changed under us — a healed account is a different row. */
  onChanged: () => void;
}) {
  const [status, setStatus] = useState<LanStatus | null>(null);
  const [manual, setManual] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  /** The one thing this section could not say. See writeFailure. */
  const [failure, setFailure] = useState<string | null>(null);
  /** Read by the press guard rather than the state, because `busy` is a render
   *  behind: two clicks in the same frame both see `false` and both fire. */
  const busyRef = useRef(false);
  const [now, setNow] = useState(() => Date.now());
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const [lan, prefs] = await Promise.all([
        fetch("/api/lan").then(r => r.json()),
        fetch("/api/prefs").then(r => r.json()),
      ]);
      if (!alive.current) return;
      if (lan?.ok) setStatus(lan);
      if (prefs?.ok) setManual(Array.isArray(prefs.prefs?.lan?.manual) ? prefs.prefs.lan.manual : []);
    } catch { /* the deck is down; the connection banner already says so */ }
  }, []);

  useEffect(() => {
    alive.current = true;
    void load();
    // Same cadence the rest of this panel polls at. A request arriving is the
    // point of the section, so it has to show up without a press.
    const iv = window.setInterval(() => { setNow(Date.now()); void load(); }, 5_000);
    return () => { alive.current = false; window.clearInterval(iv); };
  }, [load]);

  const toggle = useCallback(async () => {
    if (!selfPressAccepted(busyRef.current)) return;
    const on = status?.enabled === true;
    busyRef.current = true;
    setBusy(true);
    try {
      const out = await post("/api/prefs", { lan: { enabled: !on } });
      if (!alive.current) return;
      if (out?.ok) setFailure(null);
      else setFailure(writeFailure(on ? "turn this off" : "turn this on", out));
      await load();
    } catch {
      if (alive.current) setFailure(writeFailure(on ? "turn this off" : "turn this on", null));
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  }, [status?.enabled, load]);

  const answer = useCallback(async (action: "accept" | "dismiss", fp: string) => {
    if (!selfPressAccepted(busyRef.current)) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const out = await post("/api/lan/peer", { action, fp });
      if (!alive.current) return;
      if (out?.ok) { setStatus(out); setFailure(null); }
      else setFailure(writeFailure(action === "accept" ? "accept that deck" : "dismiss that request", out));
      await load();
    } catch {
      if (alive.current) setFailure(writeFailure("answer that request", null));
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  }, [load]);

  const syncNow = useCallback(async () => {
    if (!selfPressAccepted(busyRef.current)) return;
    busyRef.current = true;
    setBusy(true);
    setChecking(true);
    try {
      const res = await fetch("/api/lan/sync", { method: "POST" });
      const out = await res.json().catch(() => null);
      if (!alive.current) return;
      if (out?.ok) { setStatus(out); setFailure(null); }
      else setFailure(writeFailure("check the paired decks", out));
      if (out?.done?.length) onChanged();
    } catch {
      if (alive.current) setFailure(writeFailure("check the paired decks", null));
    } finally {
      busyRef.current = false;
      if (alive.current) { setBusy(false); setChecking(false); }
    }
  }, [onChanged]);

  const on = status?.enabled === true;
  const asking = status?.pending ?? [];
  const peers = status?.peers ?? [];

  return (
    <div className="ap-auto ap-lan">
      <div className="ap-auto-head">
        <h3 className="ap-auto-title">Local network</h3>
        <button
          type="button"
          className={`ap-auto-state${on ? " live" : ""}`}
          role="switch"
          aria-checked={on}
          aria-label="Local network sync"
          {...selfPressProps(busy)}
          onClick={() => void toggle()}
          title={on
            ? "Stop answering other decks and stop dialling them"
            : "Let decks you have paired with heal this one's dead logins"}
        >
          <i className={on ? "ap-pulse" : "ap-dot"} aria-hidden />
          {on ? "on" : "off"}
        </button>
      </div>

      {/* The sentence, before anything can be shared. A refresh token that has
          left this machine cannot be called back — the only revocation is a
          re-login at Anthropic, which ends the session everywhere at once. */}
      <p className="ap-auto-note">
        Decks you pair with heal each other&apos;s dead logins.
        A login you share is a live one, and it cannot be taken back.
      </p>

      {failure && (
        <div className="ap-failure" role="alert">
          <span className="ap-failure-text">{failure}</span>
          <button type="button" className="ap-failure-x" onClick={() => setFailure(null)}
            aria-label="Dismiss this message" title="Dismiss">×</button>
        </div>
      )}

      {on && (
        <>
          {/* THE REQUEST, AND IT COMES FIRST. Somebody on the other machine
              typed this deck's address and is waiting; until this is answered
              nothing at all moves between them. Announced, because it arrives
              while the reader is looking at a quota rather than at this
              section. */}
          {asking.length > 0 && (
            <div className="ap-lan-asks" role="alert">
              {asking.map(p => (
                <div key={p.fp} className="ap-lan-ask">
                  <span className="ap-lan-ask-what">
                    <strong className="ap-lan-peer-name">{p.name}</strong>
                    {" at "}<code className="ap-lan-code">{p.addr}</code>
                    {" wants to pair · "}{askedLabel(p.at, now)}
                  </span>
                  <span className="ap-lan-ask-acts">
                    <button type="button" className="ap-manage-btn" {...selfPressProps(busy)}
                      onClick={() => void answer("accept", p.fp)}
                      title={`Talk to this deck from now on. Its fingerprint is ${p.fp} — check that it matches what is on their screen.`}>
                      accept
                    </button>
                    <button type="button" className="ap-manage-btn" {...selfPressProps(busy)}
                      onClick={() => void answer("dismiss", p.fp)}
                      title="Take this request off the list. If that deck asks again it comes back.">
                      dismiss
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}

          <h4 className="ap-lan-sub">
            paired decks
            <button type="button" className="ap-manage-btn ap-lan-now" {...selfPressProps(busy)}
              onClick={() => void syncNow()}
              title="Ask every paired deck right now instead of waiting for the next minute">
              {/* The word, because the attribute could not. selfPressProps sets
                  aria-busy and aria-busy has no rule anywhere in the sheet, so
                  this button looked identical pressed and unpressed. */}
              {checking ? "checking…" : "check now"}
            </button>
          </h4>
          <div className="ap-lan-peers">
            {peers.length === 0 && (
              <span className="ap-lan-empty">
                none yet — open setup, give the other deck one of this one&apos;s addresses,
                and accept the request it sends back
              </span>
            )}
            {peers.map(p => {
              const line = roundLabel(p.last, now);
              return (
                <div key={p.fp} className="ap-lan-peer">
                  {/* THE NAME AS SOON AS THERE IS ONE. A typed address is all
                      there is to show until something answers it, and the
                      moment something does it has said what it calls itself —
                      which is what the person typing the address was trying to
                      reach. Until then the address is the honest label, and it
                      is set like an address rather than like a name. */}
                  {p.manual && !p.met
                    ? <code className="ap-lan-code">{p.addr}:{p.port}</code>
                    : <span className="ap-lan-peer-name">{p.name}</span>}
                  {/* A typed deck never beacons, so it has no last-seen and
                      "not seen" would read as broken next to a round that just
                      succeeded. What it says instead is how it got here. */}
                  <span className="ap-lan-peer-when" title={p.manual ? `${p.addr}:${p.port}` : undefined}>
                    {p.manual ? "by address" : seenLabel(p.lastSeen, now)}
                  </span>
                  {line && (
                    <span className={`ap-lan-peer-last${line.tone === "bad" ? " ap-lan-bad" : ""}`}>
                      {line.text}
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          <button type="button" className="ap-manage-btn ap-lan-open" {...selfPressProps(busy)}
            onClick={() => setSetupOpen(true)}
            title="This deck's name and address, which decks it talks to, and which accounts it offers them">
            setup…
          </button>
        </>
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
    </div>
  );
}
