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
  /** The identity this row is really about: a heard deck's own fingerprint, or
   *  the one that answered at a typed address. Null while an address has never
   *  answered, which is the only state where there is nothing to name. */
  peerFp?: string | null;
  name: string;
  addr: string;
  port: number;
  manual?: boolean;
  /** A typed address that has answered at least once, so its name is the name
   *  the deck on the other end gave rather than the address we dialled. */
  met?: boolean;
  /** Somebody here pressed accept on this deck. */
  paired?: boolean;
  /** Paired, and this deck has no address to reach it at — it called us and we
   *  said yes, so it calls and we answer. */
  waiting?: boolean;
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
  invite: LanInvite | null;
  pending: LanStranger[];
  strangers: LanStranger[];
  /** Filled in by the section from prefs, so the modal can list what this deck
   *  dials without asking for prefs a second time. */
  manualRows?: string[];
  /** Whether other decks can reach this one, when the machine could be asked.
   *  Null on every platform this cannot measure and on the first poll after a
   *  start, and both mean the same thing: say nothing. See lan-reach.mjs. */
  reach?: LanReach | null;
}

/** What lan-reach.mjs concluded, and the command it would have somebody paste.
 *  `steps` is text and only text — nothing here runs, for the reason
 *  relay-guard.mjs wrote down. */
export interface LanReach {
  blocked: boolean;
  why: string;
  category: string;
  alias: string;
  text?: string;
  steps?: string[];
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

/** What this deck is offering, and until when. */
export interface LanInvite { token: string; expiresAt: number }

/** A countdown a person reads while somebody else is reading the token out. */
export function leftLabel(expiresAt: number, now: number): string {
  const s = Math.max(0, Math.round((expiresAt - now) / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Is this deck reachable right now?
 *
 * TWO DIFFERENT KINDS OF EVIDENCE, and neither is available for both kinds of
 * peer. A deck found by broadcast says so every thirty seconds, so a recent
 * `lastSeen` is the answer. A deck reached by address never beacons at all, so
 * the only evidence is whether the last round got through — which is exactly
 * what a person means by "is it up".
 *
 * A round that failed is offline whatever the beacon says: a deck this one can
 * hear and cannot talk to is not somewhere you can send an account.
 */
export function isOnline(p: Peer, now: number): boolean {
  if (p.last?.error) return false;
  if (p.last?.at && now - p.last.at < ONLINE_MS) return true;
  if (p.lastSeen != null && now - p.lastSeen < ONLINE_MS) return true;
  return false;
}

/** Three beacon intervals plus slack, the same window the peer table uses to
 *  decide a deck is still present. Two lost packets do not put somebody
 *  offline. */
export const ONLINE_MS = 95_000;

/** Who is here now, and how many are not. The panel shows the first and counts
 *  the second — a list of machines that are switched off is a list nobody
 *  reads, and it is what made this section feel like a settings page. */
export function rosterSplit(peers: Peer[], now: number): { online: Peer[]; offline: Peer[] } {
  const online: Peer[] = [];
  const offline: Peer[] = [];
  for (const p of peers ?? []) (isOnline(p, now) ? online : offline).push(p);
  return { online, offline };
}

/**
 * THE ONE LINE THAT SAYS WHAT IS HAPPENING, which is the thing this section did
 * not have.
 *
 * Every other state was legible only by reading the whole section and working
 * it out — is it on, is anybody there, did the last round do anything, is that
 * invite still good. The panel's own doctrine has had the answer since the
 * freshness column: put the state in a sentence, at the top, in the vocabulary
 * a person would use.
 *
 * The tone travels with it for the same reason roundLabel's does: a stylesheet
 * cannot tell "nobody yet" from "it broke", and those are the two states a
 * reader most needs told apart.
 */
export function sectionState(
  s: { enabled?: boolean; running?: boolean; peers?: Peer[]; pending?: LanStranger[] } | null,
  now: number,
): { text: string; tone: "bad" | "idle" | "ok" | "wait" } {
  if (!s?.enabled) return { text: "off — this deck is not on the network", tone: "idle" };
  if (!s.running) return { text: "starting…", tone: "wait" };
  const asking = (s.pending ?? []).length;
  if (asking) {
    return {
      text: asking === 1 ? "one deck is asking to pair" : `${asking} decks are asking to pair`,
      tone: "wait",
    };
  }
  const peers = s.peers ?? [];
  if (!peers.length) return { text: "no decks paired yet", tone: "idle" };
  const { online, offline } = rosterSplit(peers, now);
  if (!online.length) {
    return {
      text: offline.length === 1 ? "the paired deck is not reachable" : "no paired deck is reachable",
      tone: "bad",
    };
  }
  const here = online.length === 1 ? "1 deck here" : `${online.length} decks here`;
  return { text: offline.length ? `${here} · ${offline.length} away` : here, tone: "ok" };
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

  const on = status?.enabled === true;
  const asking = status?.pending ?? [];
  const { online, offline } = rosterSplit(status?.peers ?? [], now);
  const state = sectionState(status, now);

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
            ? "Stop talking to other decks. Nothing is shared while this is off."
            : "Let the decks you pair with repair this one's expired logins"}
        >
          <i className={on ? "ap-pulse" : "ap-dot"} aria-hidden />
          {on ? "on" : "off"}
        </button>
      </div>

      {/* What the thing IS, for somebody meeting it. One line, and it stays one
          line: this section is read by a person who came to look at a quota,
          and a paragraph here is a paragraph they scroll past. What sharing a
          login costs is said in the dialog, where the decision is. */}
      {/* One verb for one thing, everywhere. The account rows in this panel
          already say `login expired`, so this says expired too — "heal" and
          "dead" were two more words for the same state and a reader scanning
          three of them has to work out that they are one. */}
      <p className="ap-auto-note">Decks you pair with repair each other&apos;s expired logins.</p>

      {/* WHO IS HERE, IN ONE LINE. Every state this section had was legible only
          by reading the whole thing and working it out. This is the panel's own
          answer, the one the freshness column has made on every account row for
          a year: say the state, at the top, in the words a person would use. */}
      <p className={`ap-lan-status ${state.tone}`}>{state.text}</p>

      {failure && (
        <div className="ap-failure" role="alert">
          <span className="ap-failure-text">{failure}</span>
          <button type="button" className="ap-failure-x" onClick={() => setFailure(null)}
            aria-label="Dismiss this message" title="Dismiss">×</button>
        </div>
      )}

      {on && (
        <>
          {/* THE REQUEST, AND IT COMES FIRST. Somebody dialled this deck without
              an invite and is waiting; until this is answered nothing moves
              between them. Announced, because it arrives while the reader is
              three sections up looking at a quota. */}
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
                      title={`Talk to this deck from now on. Its fingerprint is ${p.fp} — check it matches the one on their screen before you accept.`}>
                      accept
                    </button>
                    <button type="button" className="ap-manage-btn" {...selfPressProps(busy)}
                      onClick={() => void answer("dismiss", p.fp)}
                      title="Take this request off the list. Nothing is shared. If that deck asks again, it comes back.">
                      dismiss
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* WHO IS HERE NOW, AND ONLY THEM. A list of machines that are
              switched off is a list nobody reads, and it is what made this
              section read as a settings page rather than as an instrument. The
              ones that are away are counted, not enumerated — and the count is
              the way into the dialog that has them all. */}
          {online.length > 0 && (
            <ul className="ap-lan-here">
              {online.map(p => {
                const line = roundLabel(p.last, now);
                return (
                  <li key={p.fp} className="ap-lan-who">
                    <i className="ap-pulse" aria-hidden />
                    <span className="ap-lan-who-name">
                      {p.manual && !p.met ? `${p.addr}:${p.port}` : p.name}
                    </span>
                    <span className="ap-lan-who-when">
                      {line ? line.text : p.lastSeen != null ? seenLabel(p.lastSeen, now) : "here"}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}

          {online.length === 0 && (
            <p className="ap-lan-fine">
              {(status?.peers ?? []).length === 0
                ? "No deck paired yet. Open setup, make an invite and send it — they paste it and you are done."
                : "None of the decks you paired with is answering right now."}
            </p>
          )}

          {/* EVERYTHING ELSE IS BEHIND ONE DOOR. The invite, the join field,
              this deck's name, which accounts it offers, every deck it has ever
              paired with — all of it is configuration, and configuration is
              something you do twice. What you do every day is look. */}
          <button type="button" className="ap-manage-btn ap-lan-setup" {...selfPressProps(busy)}
            onClick={() => setSetupOpen(true)}
            title="Invite a deck, join one, and choose which logins this deck offers">
            {offline.length
              ? `setup · ${offline.length} away`
              : (status?.peers ?? []).length ? "setup…" : "invite a deck…"}
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
