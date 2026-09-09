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
// but only a deck holding the same passphrase is ever answered. So the field
// opens filled with six words this deck generated, and the panel says what
// having it means.
//
// WHAT IT REFUSES TO SAY. Not "sharing is revocable". Unpairing stops what has
// not happened yet; a refresh token that has left this machine is gone, and the
// only real revocation is a re-login at Anthropic, which kills the session on
// every machine at once. That sentence is in the panel once, before the first
// account can be ticked, rather than in documentation nobody opens.
//
// THE DOCTRINE THIS SECTION HAD TO BE TAUGHT. The panel above it commits on a
// press and never on a blur, reports every failure in a box a reader can see,
// and makes a destructive act cost a second deliberate press. This file shipped
// with none of the three: two fields saved on blur and threw a bad value away
// in silence, every write checked `ok` and had no `else`, and the one action in
// the whole deck that cannot be undone — offering a live login to the network —
// was a single unguarded click. All three are the same fix: do what the panel
// two hundred lines above already does.
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
  addrs: string[];
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

/** What the last round with one peer did: the sentence, and which of the three
 *  things it is. */
export interface RoundLine { text: string; tone: "bad" | "idle" | "ok" }

/**
 * What the last round with one peer did, as a line and a tone.
 *
 * An error is said plainly and is not translated into reassurance: a deck that
 * cannot be reached is a deck that cannot heal anything, and a row that said
 * "waiting" over a refused handshake would be the panel lying about a thing the
 * user can fix by checking the passphrase on the other machine.
 *
 * THE TONE IS THE HALF THAT WAS MISSING. The sentence was honest and the
 * stylesheet drew it in the dimmest ink the panel has — the same colour, size
 * and weight as `nothing to do · checked now` on the row above it. This list is
 * the whole readout of whether the feature works, and the one thing anybody
 * scans a list like this for is which row is wrong. So the rule that decides
 * that travels with the sentence, where it can be tested, rather than being
 * inferred from the string by a stylesheet that cannot.
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

async function post(body: Record<string, unknown>) {
  const res = await fetch("/api/prefs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json().catch(() => null);
}

/**
 * Copy, and say whether it worked.
 *
 * The same shape as the panel's own, and here for the same reason: the whole
 * point of showing the passphrase is getting it onto a second machine intact,
 * and a copy button that fails silently is worse than none — it is a promise
 * the reader acts on.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    const ok = await Promise.race([
      navigator.clipboard?.writeText(text).then(() => true) ?? Promise.resolve(false),
      new Promise<boolean>(r => window.setTimeout(() => r(false), 500)),
    ]);
    if (ok) return true;
  } catch { /* fall through to the selection trick */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch { return false; }
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
  const [copied, setCopied] = useState(false);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [addrDraft, setAddrDraft] = useState("");
  const [manual, setManual] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  /** The one thing this section could not say. See writeFailure. */
  const [failure, setFailure] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  /** Read by the press guard rather than the state, because `busy` is a render
   *  behind: two clicks in the same frame both see `false` and both fire. */
  const busyRef = useRef(false);
  /**
   * WHAT WE LAST SENT, and the fix for a lost tick.
   *
   * The picks were drawn from `status.shared`, which only changes after a write
   * has landed AND the poll after it has returned. So ticking a second account
   * inside that window built its Set from the state before the FIRST tick, and
   * the first account was quietly dropped from the group — with both boxes
   * still drawn ticked until a later poll silently unticked one. The panel and
   * the network disagreed about which logins were being offered, and nothing on
   * screen took the user's side.
   *
   * So the boxes are drawn from what we last sent, until the server agrees with
   * it. Then this goes back to null and the server is the truth again.
   */
  const pending = useRef<string[] | null>(null);
  /** One write at a time, in the order they were pressed. Two ticks are two
   *  different intentions and both have to land, so they queue rather than
   *  being refused the way a repeated press of one button is.
   *
   *  Seeded null and filled on the first write rather than seeded with a
   *  resolved promise: #612 pins that a ref is seeded with a VALUE, because an
   *  expression in the seed position is built on every render and thrown away
   *  on all but the first. */
  const chain = useRef<Promise<unknown> | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const [lan, prefs] = await Promise.all([
        fetch("/api/lan").then(r => r.json()),
        fetch("/api/prefs").then(r => r.json()),
      ]);
      if (!alive.current) return;
      if (lan?.ok) {
        setStatus(lan);
        // The server has caught up with the last thing we sent, so it is the
        // truth again and the optimistic copy is retired.
        if (pending.current && sameKeys(pending.current, lan.shared ?? [])) pending.current = null;
      }
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

  /**
   * One write, and the three things that were missing from it.
   *
   * It reported nothing when the deck refused, nothing when the deck was gone,
   * and it let two writes race. `what` is the verb the failure box says, so the
   * sentence names the thing the user was doing rather than the route it used.
   *
   * #620 is still honoured for the BUTTONS, which each refuse their own second
   * press. It is deliberately not applied here: two ticks in the picks list are
   * two different intentions, and refusing the second would drop a decision
   * rather than de-duplicate one.
   */
  const save = useCallback((lan: Record<string, unknown>, what: string) => {
    const run = async () => {
      busyRef.current = true;
      setBusy(true);
      try {
        const out = await post({ lan });
        if (out?.ok) {
          setHasPassphrase(out.prefs?.lan?.hasPassphrase === true);
          setFailure(null);
        } else if (alive.current) {
          setFailure(writeFailure(what, out));
        }
        await load();
        return out;
      } catch {
        // The write path, not the poll path. A poll that cannot reach the deck
        // is covered by the connection banner; a WRITE that cannot reach it
        // leaves the user believing the opposite of what is true.
        if (alive.current) setFailure(writeFailure(what, null));
        return null;
      } finally {
        busyRef.current = false;
        if (alive.current) setBusy(false);
      }
    };
    chain.current = (chain.current ?? Promise.resolve()).then(run, run);
    return chain.current;
  }, [load]);

  const syncNow = useCallback(async () => {
    if (!selfPressAccepted(busyRef.current)) return;
    busyRef.current = true;
    setBusy(true);
    setChecking(true);
    try {
      const res = await fetch("/api/lan/sync", { method: "POST" });
      const out = await res.json().catch(() => null);
      if (out?.ok) { setStatus(out); setFailure(null); }
      else if (alive.current) setFailure(writeFailure("check the group", out));
      // A round can add or heal an account, which is a different roster.
      if (out?.done?.length) onChanged();
    } catch {
      if (alive.current) setFailure(writeFailure("check the group", null));
    } finally {
      busyRef.current = false;
      if (alive.current) { setBusy(false); setChecking(false); }
    }
  }, [onChanged]);

  /**
   * Open the passphrase field with six words this deck generated.
   *
   * It opened empty, under a placeholder reading "the same words on every
   * deck" — which is an instruction to invent something two people can both
   * remember, and that is how a group ends up protected by `officeteam`.
   * suggestPassphrase had been written, documented and tested since the first
   * commit of this feature and was reachable from nothing.
   *
   * Showing it is not what publicPrefs refuses to do. That rule is about a
   * value already on disk, which a suggestion nobody has saved yet is not.
   */
  const openPassphrase = useCallback(async () => {
    if (!selfPressAccepted(busyRef.current)) return;
    setCopied(false);
    // FETCHED BEFORE THE FIELD EXISTS, and this ordering is the whole fix.
    //
    // It opened the field empty and filled it when the answer came back, under
    // a guard that only wrote if the field was still empty. That guard cannot
    // tell the two empties apart: "we just opened this" and "the user selected
    // all six words and pressed delete" are the same string. So somebody who
    // cleared the field to type their own passphrase had it refilled with the
    // suggestion under their cursor, and typing over it did not help — the next
    // clear brought it back.
    //
    // With nothing in flight once the field is on screen, there is no late
    // write to guard against. The wait is bounded because a deck that does not
    // answer must still leave a field somebody can type into, rather than a
    // button that looks dead.
    let suggestion = "";
    try {
      const out = await Promise.race([
        fetch("/api/lan/passphrase").then(r => r.json()),
        new Promise(r => window.setTimeout(() => r(null), 1_500)),
      ]) as { ok?: boolean; passphrase?: string } | null;
      if (out?.ok && typeof out.passphrase === "string") suggestion = out.passphrase;
    } catch { /* an empty field still works; the placeholder says what it wants */ }
    if (alive.current) setDraft(suggestion);
  }, []);

  /**
   * Commit the typed address, and say why when it is not one.
   *
   * It parsed on blur and, when the parse failed, emptied the field and
   * returned — so a typo produced a blank box, no peer, and no statement that
   * anything had gone wrong. The two things the empty-peers copy then told the
   * reader to check were both the wrong things. The text stays where it is now,
   * and the failure box names the half that failed.
   */
  const addAddress = useCallback(() => {
    const typed = addrDraft.trim();
    if (!typed) return;
    const parsed = parseAddress(typed);
    if (!parsed) {
      setFailure(`"${typed}" is not an address and a port — try 192.168.1.5:54340.`);
      return;
    }
    const entry = `${parsed.addr}:${parsed.port}`;
    setAddrDraft("");
    setFailure(null);
    if (!manual.includes(entry)) void save({ manual: [...manual, entry] }, "add that address");
  }, [addrDraft, manual, save]);

  const on = status?.enabled === true;
  // What we last sent, until the server agrees with it. See `pending`.
  const sharedList = pending.current ?? status?.shared ?? [];
  const shared = new Set(sharedList);
  // Nothing is hidden that exists: the block is only closed the first time,
  // when there is nothing in it to see, and one press opens it for good. That
  // press is the deliberate act this decision was missing — the panel makes you
  // press twice to delete an account you can sign back into, and asked for one
  // unguarded click to put a live login on the network.
  const showPicks = picking || sharedList.length > 0;

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
          onClick={() => {
            if (!selfPressAccepted(busyRef.current)) return;
            void save({ enabled: !on }, on ? "turn this off" : "turn this on");
          }}
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

      {/* Announced, and dismissible, exactly like the panel's own. Directly
          under the head rather than at the foot of the section: this section is
          450px tall with everything open, and a failure at the bottom of it is
          a failure nobody scrolls to. */}
      {failure && (
        <div className="ap-failure" role="alert">
          <span className="ap-failure-text">{failure}</span>
          <button type="button" className="ap-failure-x" onClick={() => setFailure(null)}
            aria-label="Dismiss this message" title="Dismiss">×</button>
        </div>
      )}

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
              /* NOT onBlur. picker-commit.ts spends three paragraphs on why no
                 control in this panel may act on an event the user did not aim
                 at, and this field was doing exactly that one file over. It
                 proposes; the button beside it commits. */
              onKeyDown={e => {
                if (e.key !== "Enter" || nameDraft == null) return;
                void save({ name: nameDraft }, "save the name");
                setNameDraft(null);
              }}
            />
            {nameDraft != null && nameDraft !== (status?.name ?? "") && (
              <button type="button" className="ap-manage-btn" {...selfPressProps(busy)}
                onClick={() => {
                  if (!selfPressAccepted(busyRef.current)) return;
                  void save({ name: nameDraft }, "save the name");
                  setNameDraft(null);
                }}
                title="Save the name other decks see">save</button>
            )}
          </div>
          {/* Said once, where the field is. The beacon carries this name in the
              clear to everyone on the network, passphrase or not — see
              beaconPayload — and a name nobody was told was public is a name
              somebody would have chosen differently. */}
          <span className="ap-lan-empty">everyone on this network can see this name</span>

          <div className="ap-lan-row">
            <span className="ap-lan-label">passphrase</span>
            {draft == null ? (
              <>
                {/* Never the STORED value, and never dots standing in for it.
                    The server does not send it — see publicPrefs — so there is
                    nothing here to put back in a field. A suggestion this deck
                    has just generated is a different thing, and it is shown. */}
                <span className="ap-lan-set">{hasPassphrase ? "set" : "not set yet"}</span>
                <button type="button" className="ap-manage-btn" {...selfPressProps(busy)}
                  onClick={() => void openPassphrase()}
                  title="Open the field with six words this deck generated, or type your own">
                  {hasPassphrase ? "change" : "set"}
                </button>
              </>
            ) : (
              <input
                className="ap-manage-input ap-lan-input"
                /* Readable, on purpose. This is the moment the passphrase is
                   BEING SET, and it has to reach a second machine — usually by
                   being read out loud across a desk. Dots here would hide the
                   one thing the step exists to transfer. */
                type="text"
                aria-label="Group passphrase"
                autoComplete="off"
                spellCheck={false}
                autoFocus
                value={draft}
                placeholder="the same words on every deck"
                onChange={e => { setDraft(e.target.value); setCopied(false); }}
                onKeyDown={e => {
                  if (e.key !== "Enter" || !draft) return;
                  void save({ passphrase: draft }, "save the passphrase");
                  setDraft(null);
                }}
              />
            )}
          </div>
          {draft != null && (
            <div className="ap-lan-acts">
              <button type="button" className="ap-manage-btn" {...selfPressProps(busy || !draft)}
                onClick={async () => {
                  if (!selfPressAccepted(busyRef.current)) return;
                  const ok = await copyText(draft);
                  if (!alive.current) return;
                  if (ok) { setCopied(true); window.setTimeout(() => setCopied(false), 1800); }
                  else setFailure("Could not reach the clipboard — select the words and copy them.");
                }}
                title="Copy it, so the other deck gets it character for character">
                {copied ? "copied" : "copy"}</button>
              <button type="button" className="ap-manage-btn" {...selfPressProps(busy || !draft)}
                onClick={() => {
                  if (!selfPressAccepted(busyRef.current)) return;
                  void save({ passphrase: draft }, "save the passphrase");
                  setDraft(null);
                }}
                title="Every deck in the group needs these exact words">save</button>
              <button type="button" className="ap-manage-btn" {...selfPressProps(busy)}
                onClick={() => { setDraft(null); setCopied(false); }}>cancel</button>
            </div>
          )}

          {hasPassphrase && (
            <>
              {/* h4, under the section's own h3. It was a div, so the two
                  headings that divide this section into "which accounts" and
                  "which decks" were invisible to anyone navigating by heading —
                  in the part of the panel that most needs landmarks. */}
              <h4 className="ap-lan-sub">share these accounts</h4>
              {!showPicks ? (
                // The one deliberate act. It costs a press the first time and
                // never again, and it is the press that puts the warning above
                // it in front of a decision instead of beside one.
                <button type="button" className="ap-manage-btn ap-lan-open" {...selfPressProps(busy)}
                  onClick={() => setPicking(true)}
                  title="Pick which logins this deck offers to the group. Each one you tick is a live login another machine keeps.">
                  choose accounts to share
                </button>
              ) : (
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
                          // Built from what we LAST SENT, never from the
                          // render's copy of the server's answer, which is two
                          // round trips behind a second tick. See `pending`.
                          const next = new Set(pending.current ?? status?.shared ?? []);
                          if (e.target.checked) next.add(a.key); else next.delete(a.key);
                          pending.current = [...next];
                          void save(
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
              )}

              <h4 className="ap-lan-sub">
                in this group
                <button type="button" className="ap-manage-btn ap-lan-now" {...selfPressProps(busy)}
                  onClick={() => void syncNow()}
                  title="Ask every deck in the group right now instead of waiting for the next minute">
                  {/* The word, because the attribute could not. selfPressProps
                      sets aria-busy and aria-busy has no rule anywhere in the
                      sheet, so this button looked identical pressed and
                      unpressed and got pressed three times. */}
                  {checking ? "checking…" : "check now"}
                </button>
              </h4>
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
                {(status?.peers ?? []).map(p => {
                  const line = roundLabel(p.last, now);
                  return (
                    <div key={p.fp} className="ap-lan-peer">
                      {/* A typed peer's "name" IS an address, and it was set in
                          the body font two hundred pixels above the same deck's
                          own addresses in monospace. One kind of thing, one
                          typeface. */}
                      {p.manual
                        ? <code className="ap-lan-code">{p.addr}:{p.port}</code>
                        : <span className="ap-lan-peer-name">{p.name}</span>}
                      {/* A typed deck never beacons, so it has no last-seen and
                          "not seen" would read as broken next to a round that
                          just succeeded. What it says instead is how it got
                          here. */}
                      <span className="ap-lan-peer-when">{p.manual ? "by address" : seenLabel(p.lastSeen, now)}</span>
                      {p.manual && (
                        <button type="button" className="ap-manage-btn ap-lan-drop"
                          {...selfPressProps(busy)}
                          onClick={() => {
                            if (!selfPressAccepted(busyRef.current)) return;
                            void save(
                              { manual: manual.filter(m => m !== `${p.addr}:${p.port}`) },
                              "stop dialling that address",
                            );
                          }}
                          aria-label={`Stop dialling ${p.addr}:${p.port}`}
                          title="Stop dialling this address">remove</button>
                      )}
                      {line && (
                        <span className={`ap-lan-peer-last${line.tone === "bad" ? " ap-lan-bad" : ""}`}>
                          {line.text}
                        </span>
                      )}
                    </div>
                  );
                })}
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
                  onKeyDown={e => { if (e.key === "Enter") addAddress(); }}
                />
                {addrDraft.trim() !== "" && (
                  <button type="button" className="ap-manage-btn" {...selfPressProps(busy)}
                    onClick={() => { if (selfPressAccepted(busyRef.current)) addAddress(); }}
                    title="Dial this deck directly, for a machine broadcast cannot reach">add</button>
                )}
              </div>

              {/* EVERY ADDRESS, not the first one. This printed the first and
                  it was wrong the first time somebody checked: the first here
                  is the LAN address and the deck that needed reaching was on a
                  VPN, so the panel offered an address that peer cannot route
                  to. Which one is right depends on where the peer is, which
                  this side cannot answer — so the person picks, because they
                  are the only one who knows how the other machine sees this
                  one. */}
              {status?.port != null && (status.addrs ?? []).length > 0 && (
                <p className="ap-auto-note ap-lan-addr">
                  Broadcast does not cross a router, so give the other deck
                  whichever of these it can reach:{" "}
                  {(status.addrs ?? []).map((a, i) => (
                    <span key={a}>
                      {i > 0 && " or "}
                      <code className="ap-lan-code">{a}:{status.port}</code>
                    </span>
                  ))}
                </p>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
