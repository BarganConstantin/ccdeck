// LAN sync, at the bottom of the Accounts panel, where the accounts it is
// about already are.
//
// WHAT IT IS FOR, in one sentence a reader needs before any of the controls
// make sense: a login dies on the machine that has not used it while the same
// account stays alive on the machine that has, and today the fix is a blob
// copied out of one deck and pasted into another.
//
// THE PASSPHRASE IS THE WHOLE TRUST BOUNDARY, and the panel has to make that
// legible rather than merely true. Decks find each other by shouting on the
// network — anybody can hear that, and it carries no account and no secret —
// but only a deck holding the same passphrase is ever answered. So the field is
// the first control, it comes filled with something strong, and the panel says
// what having it means.
//
// WHAT IT REFUSES TO SAY. Not "sharing is revocable". Unpairing stops what has
// not happened yet; a refresh token that has left this machine is gone, and the
// only real revocation is a re-login at Anthropic, which kills the session on
// every machine at once. That sentence is in the panel once, before the first
// account can be ticked, rather than in documentation nobody opens.
import { useCallback, useEffect, useRef, useState } from "react";
import { selfPressAccepted, selfPressProps } from "../panel-press";

/** One deck in the group, as the status route reports it. */
interface Peer {
  fp: string;
  name: string;
  addr: string;
  port: number;
  manual?: boolean;
  lastSeen?: number;
  last?: { at: number; error?: string; done?: Array<{ email: string; action: string; ok: boolean }> } | null;
}

interface Status {
  enabled: boolean;
  running: boolean;
  name: string;
  fp: string | null;
  port: number | null;
  addr: string | null;
  shared: string[];
  peers: Peer[];
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

/**
 * What the last round with one peer did, as a line.
 *
 * An error is said plainly and is not translated into reassurance: a deck that
 * cannot be reached is a deck that cannot heal anything, and a row that said
 * "waiting" over a refused handshake would be the panel lying about a thing the
 * user can fix by checking the passphrase on the other machine.
 */
export function roundLabel(last: Peer["last"], now: number): string | null {
  if (!last) return null;
  if (last.error) return `could not reach it — ${last.error}`;
  const done = last.done ?? [];
  if (!done.length) return `nothing to do · checked ${seenLabel(last.at, now)}`;
  const ok = done.filter(d => d.ok);
  const verb = ok.length === 1 ? "account" : "accounts";
  return ok.length === done.length
    ? `took ${ok.length} ${verb} · ${seenLabel(last.at, now)}`
    : `took ${ok.length} of ${done.length} · ${seenLabel(last.at, now)}`;
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

async function post(body: Record<string, unknown>) {
  const res = await fetch("/api/prefs", {
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
  const [status, setStatus] = useState<Status | null>(null);
  const [hasPassphrase, setHasPassphrase] = useState(false);
  /** The field, while it is being edited. Null means "not editing", which is a
   *  different state from an empty string: the empty string is a passphrase the
   *  user is clearing. */
  const [draft, setDraft] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [addrDraft, setAddrDraft] = useState("");
  const [manual, setManual] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
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
      if (prefs?.ok) {
        setHasPassphrase(prefs.prefs?.lan?.hasPassphrase === true);
        setManual(Array.isArray(prefs.prefs?.lan?.manual) ? prefs.prefs.lan.manual : []);
      }
    } catch { /* the deck is down; the connection banner already says so */ }
  }, []);

  useEffect(() => {
    alive.current = true;
    void load();
    // Same cadence the rest of this panel polls at. The list is the point of
    // the section, so a deck appearing has to show up without a press.
    const iv = window.setInterval(() => { setNow(Date.now()); void load(); }, 5_000);
    return () => { alive.current = false; window.clearInterval(iv); };
  }, [load]);

  const save = useCallback(async (lan: Record<string, unknown>) => {
    // #620: the control is NOT disabled on press — that would take the element
    // the press came from out from under the keyboard, and this panel has no
    // focus trap to hand it back. The word says which state it is in and this
    // refuses the second press.
    if (!selfPressAccepted(busyRef.current)) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const out = await post({ lan });
      if (out?.ok) setHasPassphrase(out.prefs?.lan?.hasPassphrase === true);
      await load();
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  }, [load]);

  const syncNow = useCallback(async () => {
    if (!selfPressAccepted(busyRef.current)) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const res = await fetch("/api/lan/sync", { method: "POST" });
      const out = await res.json().catch(() => null);
      if (out?.ok) setStatus(out);
      // A round can add or heal an account, which is a different roster.
      if (out?.done?.length) onChanged();
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  }, [onChanged]);

  const on = status?.enabled === true;
  const shared = new Set(status?.shared ?? []);

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
          onClick={() => void save({ enabled: !on })}
          title={on
            ? "Stop finding other decks and stop answering them"
            : "Find other decks on this network that hold the same passphrase"}
        >
          <i className={on ? "ap-pulse" : "ap-dot"} aria-hidden />
          {on ? "on" : "off"}
        </button>
      </div>

      {/* The sentence, before the first thing that can be ticked. A refresh
          token that has left this machine cannot be called back — the only
          revocation is a re-login at Anthropic, which ends the session
          everywhere at once. Said here rather than in documentation, because
          the decision it belongs to is made on this screen. */}
      <p className="ap-auto-note">
        Decks holding the same passphrase heal each other&apos;s dead logins.
        A login you share is a live one, and it cannot be taken back.
      </p>

      {on && (
        <>
          <div className="ap-lan-row">
            <span className="ap-lan-label">appear as</span>
            <input
              className="ap-manage-input ap-lan-input"
              aria-label="This deck's name on the network"
              value={nameDraft ?? status?.name ?? ""}
              placeholder="this machine"
              onChange={e => setNameDraft(e.target.value)}
              onBlur={() => {
                if (nameDraft != null && nameDraft !== status?.name) void save({ name: nameDraft });
                setNameDraft(null);
              }}
              onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            />
          </div>

          <div className="ap-lan-row">
            <span className="ap-lan-label">passphrase</span>
            {draft == null ? (
              <>
                {/* Never the value, and never dots standing in for it. The
                    server does not send it — see publicPrefs — so there is
                    nothing here to put back in a field, which is the point. */}
                <span className="ap-lan-set">{hasPassphrase ? "set" : "not set yet"}</span>
                <button type="button" className="ap-manage-btn" {...selfPressProps(busy)}
                  onClick={() => setDraft("")}>
                  {hasPassphrase ? "change" : "set"}
                </button>
              </>
            ) : (
              <>
                <input
                  className="ap-manage-input ap-lan-input"
                  type="password"
                  aria-label="Group passphrase"
                  autoComplete="off"
                  value={draft}
                  placeholder="the same words on every deck"
                  onChange={e => setDraft(e.target.value)}
                />
                <button type="button" className="ap-manage-btn" {...selfPressProps(busy || !draft)}
                  onClick={() => { void save({ passphrase: draft }); setDraft(null); }}>save</button>
                <button type="button" className="ap-manage-btn" {...selfPressProps(busy)}
                  onClick={() => setDraft(null)}>cancel</button>
              </>
            )}
          </div>

          {hasPassphrase && (
            <>
              <div className="ap-lan-sub">share these accounts</div>
              <div className="ap-lan-picks">
                {accounts.length === 0 && <span className="ap-lan-empty">no accounts to share yet</span>}
                {accounts.map(a => (
                  <label key={a.key} className="ap-lan-pick" title={a.alive
                    ? "Offer this account to the group, so a deck whose copy has died can heal from yours"
                    : "This deck cannot use this login, so it has nothing to offer — a deck that can will heal it"}>
                    <input
                      type="checkbox"
                      checked={shared.has(a.key)}
                      onChange={e => {
                        const next = new Set(shared);
                        if (e.target.checked) next.add(a.key); else next.delete(a.key);
                        void save({ shared: [...next] });
                      }}
                    />
                    <span className="ap-lan-pick-name">{a.email}</span>
                    {!a.alive && <span className="ap-lan-dead">dead here</span>}
                  </label>
                ))}
              </div>

              <div className="ap-lan-sub">
                in this group
                <button type="button" className="ap-manage-btn ap-lan-now" {...selfPressProps(busy)}
                  onClick={() => void syncNow()}
                  title="Ask every deck in the group right now instead of waiting for the next minute">
                  check now
                </button>
              </div>
              <div className="ap-lan-peers">
                {(status?.peers ?? []).length === 0 && (
                  // The two things that actually cause this, in the order they
                  // are worth checking. Not "no decks found", which is what a
                  // reader can already see.
                  <span className="ap-lan-empty">
                    no other deck yet — check the passphrase matches, and that
                    this machine&apos;s firewall lets {status?.name || "the deck"} use the network
                  </span>
                )}
                {/* ONE LIST. A typed address is a deck in the group like any
                    other and was briefly drawn twice — once here and once in a
                    block of its own — which read as two decks at one address.
                    It is a row with a mark and a way to take it off. */}
                {(status?.peers ?? []).map(p => (
                  <div key={p.fp} className="ap-lan-peer">
                    <span className="ap-lan-peer-name">{p.manual ? `${p.addr}:${p.port}` : p.name}</span>
                    {/* A typed deck never beacons, so it has no last-seen and
                        "not seen" would read as broken next to a round that
                        just succeeded. What it says instead is how it got
                        here. */}
                    <span className="ap-lan-peer-when">{p.manual ? "by address" : seenLabel(p.lastSeen, now)}</span>
                    {p.manual && (
                      <button type="button" className="ap-manage-btn ap-lan-drop"
                        {...selfPressProps(busy)}
                        onClick={() => void save({ manual: manual.filter(m => m !== `${p.addr}:${p.port}`) })}
                        aria-label={`Stop dialling ${p.addr}:${p.port}`}
                        title="Stop dialling this address">remove</button>
                    )}
                    {roundLabel(p.last, now) && (
                      <span className="ap-lan-peer-last">{roundLabel(p.last, now)}</span>
                    )}
                  </div>
                ))}
              </div>

              {/* This deck's own address, for the other machine's field. Shown
                  rather than hidden behind a copy button, because the case it
                  is for is somebody reading it out to a colleague across a
                  desk. */}
              <div className="ap-lan-row">
                <span className="ap-lan-label">by address</span>
                <input
                  className="ap-manage-input ap-lan-input"
                  aria-label="Another deck's address"
                  value={addrDraft}
                  placeholder="192.168.1.5:54340"
                  onChange={e => setAddrDraft(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLElement).blur(); }}
                  onBlur={() => {
                    const parsed = parseAddress(addrDraft);
                    if (!parsed) { setAddrDraft(""); return; }
                    const entry = `${parsed.addr}:${parsed.port}`;
                    setAddrDraft("");
                    if (!manual.includes(entry)) void save({ manual: [...manual, entry] });
                  }}
                />
              </div>

              {status?.port != null && status.addr != null && (
                <p className="ap-auto-note ap-lan-addr">
                  Across a VPN or another subnet, give the other deck this
                  address: <code className="ap-lan-code">{status.addr}:{status.port}</code>
                </p>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
