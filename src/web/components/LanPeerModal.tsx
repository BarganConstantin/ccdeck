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
// THE VERB IS THE ROW'S. Whatever the row's one button does, the foot of this
// does, through the same call and the same busy tag — so a press here lights the
// row behind it and the row's own press lights this. Nothing here decides
// anything the row could not.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { pressState } from "../panel-press";
import { useModalDismiss } from "./use-modal-dismiss";
import { askedLabel, CONFIRM_GAP_MS, offerLine, roundLabel, seenLabel, versionOrder } from "./LanSyncSection";
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
}

/** Two stamps this far apart came off the same round.
 *
 *  A round reads the other deck's manifest and then writes its own result, so
 *  `offersBy` and `lastRound` land microseconds apart when it worked and drift
 *  apart when it did not — see roundWith. A whole second is orders of
 *  magnitude more than the gap it is there to swallow and orders of magnitude
 *  less than the interval between rounds, so nothing that matters lands in it. */
const SAME_ROUND_MS = 1_000;

/** A date somebody reads, and how long ago in the panel's own words. */
function sinceLabel(at: number, now: number): string {
  const day = new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const ago = seenLabel(at, now);
  return `${day} · ${ago === "now" ? "just now" : ago}`;
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
  row, source, status, accounts, now, busy, onClose, onRename, onCheck, onVerb, onSettings,
}: Props) {
  // The keyboard lands on ×, as it does in the tool inspector: this dialog is
  // opened to be read, and the first control in it — the pencil — would put a
  // stray Enter into renaming the machine somebody only came to look at.
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalDismiss(onClose, { focusRef: closeRef });
  /** The name being typed, or null while nobody is renaming. */
  const [draft, setDraft] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  /** Unpair costs two presses here as it does on the row. */
  const [armed, setArmed] = useState(false);
  /** When it was armed, so a double-click cannot be its own confirmation. */
  const armedAt = useRef(0);
  const [copied, setCopied] = useState(false);
  /** Whether the outbound list is open. Shut by default and per dialog: it is
   *  the same list in every one of them, and the rows worth seeing are drawn
   *  whether it is open or not. */
  const [shown, setShown] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const editing = draft != null;
  // Selected rather than merely focused: renaming is almost always replacing,
  // and the name that is there is the one being replaced.
  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);
  // An armed unpair stands down on its own, the way the row's does.
  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), 4_000);
    return () => window.clearTimeout(t);
  }, [armed]);

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

  const { peer, stranger } = source;
  const paired = row.kind === "paired";
  const own = row.self ?? row.name;
  // A typed address nothing has answered at is not a machine yet, so there is
  // nothing to hang a name on — see deckRows.
  const canRename = row.kind !== "dialling";
  const fp = row.kind === "dialling" ? null : row.fp;
  const where = peer
    ? (peer.addr ? `${peer.addr}:${peer.port}` : "")
    : stranger
      ? (stranger.port ? `${stranger.addr}:${stranger.port}` : stranger.addr)
      : row.addr;
  const about = peer?.about ?? null;
  const mine = status.about?.version ?? null;

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

  // WHAT IT HAS NOT SAID, and whose move that is. A card is only ever sent
  // between paired decks, so an unpaired one has not said by design; a paired
  // one that answered a round and still sent nothing is running a version from
  // before this; and one that only calls in says it the next time it calls.
  const unsaid = !paired ? "shown once paired"
    : peer?.waiting
      ? (peer.lastSeen != null ? "not said — it runs an older version" : "not said yet — it says when it next calls")
      : peer?.offers ? "not said — it runs an older version"
      : "not reached yet";

  const versionText = (() => {
    if (!about?.version) return null;
    const o = mine ? versionOrder(about.version, mine) : null;
    if (o == null) return about.version;
    if (o === 0) return `${about.version} · same as this deck`;
    return `${about.version} · ${o < 0 ? "older" : "newer"} than this deck's ${mine}`;
  })();

  const line = peer ? roundLabel(peer.last, now) : null;
  // The sentence the row translated, kept whole: `not listening` is what the
  // row can fit, `connect ECONNREFUSED 192.168.1.229:65059` is what somebody
  // fixing it needs.
  const raw = peer?.last?.error && line && line.text !== peer.last.error ? peer.last.error : null;
  const done = peer?.last?.done ?? [];

  // `quiet` is what is not known. `meta` is known and minor — the stamps, the
  // version and the operating system, which are what somebody comes looking
  // for when something is wrong and are never what they came to read.
  const facts: Array<{ label: string; value: ReactNode; tone?: "bad" | "quiet" | "meta" }> = [];
  facts.push({
    label: "Address",
    value: where ? <code className="ap-lan-code">{where}</code> : "none here — it calls this deck",
    tone: where ? undefined : "quiet",
  });
  facts.push({
    label: "Reached",
    value: peer
      ? peer.waiting ? "it calls this deck · one-way"
        : peer.manual ? "by an address added here"
        : "found on this network"
      : row.kind === "nearby" ? "heard on this network"
      : "asked this deck to pair",
  });
  if (row.kind !== "dialling") {
    facts.push({
      label: "Paired",
      value: paired
        ? (peer?.pairedAt ? sinceLabel(peer.pairedAt, now) : "before this deck kept the date")
        : row.kind === "declined" && stranger ? `no · you said no ${askedLabel(stranger.at, now)}`
        : "not yet",
      tone: paired && !peer?.pairedAt ? "quiet" : "meta",
    });
    if (about) {
      facts.push({ label: "Deck", value: versionText ?? "not said", tone: versionText ? "meta" : "quiet" });
      facts.push({
        label: "System",
        value: about.os ? [about.os, about.arch].filter(Boolean).join(" · ") : "not said",
        tone: about.os ? "meta" : "quiet",
      });
    } else {
      // One line for the two, when neither is known: the same reason twice in
      // a row is a sentence the reader has to read twice to see it is one.
      facts.push({ label: "Version, OS", value: unsaid, tone: "quiet" });
    }
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
  if (paired || row.kind === "dialling") {
    facts.push({
      label: "Last round",
      value: line
        ? (
          <>
            {/* `now` is a column's word; after a clause it reads as an order. */}
            {line.text.replace(/ · now$/, " · just now")}
            {raw && <span className="lan-fact-raw">{raw}</span>}
            {done.length > 0 && (
              <ul className="lan-done">
                {done.map(d => (
                  <li key={`${d.email}:${d.action}`} data-ok={d.ok}>
                    {d.email} <span className="lan-done-what">{d.ok ? "arrived" : "did not arrive"}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )
        : "not asked yet",
      tone: line?.tone === "bad" ? "bad" : line ? undefined : "quiet",
    });
  }

  const byKey = new Map(accounts.map(a => [a.key, a]));
  const sharedHere = new Set(status.shared ?? []);
  const offering = (status.shared ?? []).map(k => byKey.get(k)).filter((a): a is LanAccount => !!a);
  // A login this deck advertises and cannot honour is the one thing in the
  // outbound list somebody here can fix, so it is the one thing that never
  // collapses into the count. See the block that draws it.
  const spent = offering.filter(a => !a.alive);
  const working = offering.length - spent.length;
  const offers = peer?.offers ?? null;
  // WHEN IT LAST TOLD US, and only when that is not already answered above.
  // A round sets `offersBy` and `lastRound` microseconds apart, so on every
  // healthy deck this was a second printing of the clock in `Last round` —
  // redundant often enough to train the eye to skip it, which is exactly the
  // habit that hides it on the one round that failed and left the list a
  // fossil. `offers.at` only falls behind when a round did not get through.
  const stale = offers && peer?.last && peer.last.at - offers.at > SAME_ROUND_MS
    ? seenLabel(offers.at, now)
    : null;

  return (
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
                identically is a line that cannot be scanned. This dialog drew
                it anyway, so a healthy deck said `online · all logins fine`
                under its name and `all logins fine · just now` again seven
                rows down. The sentence is still HERE, and still read aloud;
                it simply stops competing with the one thing on the surface a
                reader can act on. */}
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

          <div className="modal-section">
            <h3 className="lan-h">Connection</h3>
            <dl className="lan-facts">
              {facts.map(f => (
                <div key={f.label} className="lan-fact" data-tone={f.tone}>
                  <dt>{f.label}</dt>
                  <dd>{f.value}</dd>
                </div>
              ))}
            </dl>
            {/* The one-way case in full — the sentence the row's tooltip used
                to carry, which is the only place it is ever explained. */}
            {peer?.waiting && <p className="lan-note">{row.hint}</p>}
          </div>

          {paired && (
            <div className="modal-section">
              {/* WHOSE LOGINS THESE ARE, not which way the verb points. The
                  two captions were `Offers you` and `You offer` — the same two
                  words reordered, not even parallel constructions, carrying
                  the one fact on a credential surface that must never be
                  misread. The machine's own name says it without being
                  parsed. */}
              <h3 className="lan-h">
                From {row.name}
              </h3>
              {/* Marked on the LIST, not beside the caption, because the list
                  is the thing that is out of date. */}
              {stale && (
                <p className="lan-stale">
                  Last told us {stale === "now" ? "just now" : stale} — the last round did not get through,
                  so this may have changed.
                </p>
              )}
              {peer?.waiting ? (
                <p className="lan-empty">
                  Not known. This deck never asks it — it calls in — so what it offers only shows once
                  this deck can reach it.
                </p>
              ) : !offers ? (
                <p className="lan-empty">
                  {peer?.last?.error ? "Not known — the last attempt to ask it did not get through." : "Not asked yet. The next round asks it."}
                </p>
              ) : offers.accounts.length === 0 ? (
                // NOT "ticked", which names a checkbox on a machine this
                // reader has never seen. The same word is fair one section
                // down, where the control is a button away.
                <p className="lan-empty">Nothing. Nobody at that deck has chosen a login to share.</p>
              ) : (
                <ul className="lan-offers" role="list">
                  {offers.accounts.map(a => {
                    const said = offerLine(a, byKey.get(a.key) ?? null, sharedHere.has(a.key));
                    return (
                      // `role` survives `display: contents`, which is what
                      // puts these cells on the list's own grid.
                      <li key={a.key} role="listitem" className="lan-offer" data-tone={said.tone}>
                        <span className="lan-offer-email">{a.email}</span>
                        {/* THERE IS NEVER THE ACTIONABLE HALF — a round only
                            ever pulls, so nothing on this screen can change
                            what a login does on the other machine. It stays
                            unlit on every row, and `here` gets the one left
                            edge worth running an eye down. */}
                        <span className="lan-offer-there">{said.there}</span>
                        <span className="lan-offer-here">{said.here}</span>
                        {said.note && <span className="lan-offer-note">{said.note}</span>}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}

          {paired && (
            <div className="modal-section">
              {/* NOT ABOUT THIS MACHINE, and the caption has always said so
                  in small print. This list is the same in every paired deck's
                  dialog, so drawn in full it spent a third of a per-machine
                  inspector saying something no machine here changes. It is a
                  count now, and the count opens.

                  WHAT NEVER COLLAPSES is a login this deck advertises and
                  cannot honour: every paired deck is being promised something
                  that gives them nothing, the fix is one sign-in away, and it
                  is the only thing in this section somebody here can act on.
                  A summary that can hide the one actionable row is a summary
                  that has to be opened every time, which is not a summary. */}
              <h3 className="lan-h">From this deck</h3>
              {offering.length === 0 ? (
                <p className="lan-empty">Nothing. No login on this deck is chosen to share.</p>
              ) : (
                <>
                  {spent.length > 0 && (
                    <ul className="lan-offers" role="list">
                      {spent.map(a => (
                        <li key={a.key} role="listitem" className="lan-offer" data-tone="bad">
                          <span className="lan-offer-email">{a.email}</span>
                          <span className="lan-offer-there" />
                          <span className="lan-offer-here">expired here</span>
                          <span className="lan-offer-note">offered to every paired deck and gives them nothing — sign in again</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {working > 0 && (
                    <button type="button" className="ap-lan-word lan-more" aria-expanded={shown}
                      onClick={() => setShown(v => !v)}>
                      {working === 1 ? "1 login works here" : `${working} logins work here`}
                      <span className="lan-more-mark" aria-hidden>{shown ? "−" : "+"}</span>
                    </button>
                  )}
                  {shown && working > 0 && (
                    <ul className="lan-offers" role="list">
                      {offering.filter(a => a.alive).map(a => (
                        <li key={a.key} role="listitem" className="lan-offer" data-tone="ok">
                          <span className="lan-offer-email">{a.email}</span>
                          <span className="lan-offer-there" />
                          <span className="lan-offer-here">works here</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
              {/* THE SCOPE, where the scope can be acted on. `every paired
                  deck gets this list` sat beside the caption as metadata; it
                  is the consequence of the button under it, so it is said
                  where somebody is about to press. */}
              <p className="lan-scope">
                Every paired deck gets this list, the ones here now and any paired later.
              </p>
              <button type="button" className="ap-lan-word lan-peer-settings" onClick={onSettings}>
                Change what this deck offers
              </button>
            </div>
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
              onClick={() => void run(onCheck)}
              title="Ask this deck now instead of waiting for the next round">
              {busy === `check:${row.fp}` ? "Checking…" : "Check now"}
            </button>
          )}
          {row.kind === "paired" && (
            <button type="button" className={`btn danger lan-peer-verb${armed ? " armed" : ""}`}
              {...press(`unpair:${row.fp}`)}
              // A HELD KEY IS ONE DECISION TOO. The clock below is the rule
              // for a mouse, where the second press cannot arrive before the
              // hand can mean it; a keyboard repeats at around half a second,
              // which clears that bar while the finger has never come up. The
              // repeat never reaches the click at all.
              onKeyDown={e => { if (e.repeat) e.preventDefault(); }}
              onClick={() => {
                if (!armed) { setArmed(true); armedAt.current = Date.now(); return; }
                // A double-click is one decision, not two — the row's rule.
                if (Date.now() - armedAt.current < CONFIRM_GAP_MS) return;
                setArmed(false);
                void run(onVerb);
              }}
              // The row's own unpair names the machine; this one said only
              // "Unpair", and it is the same irreversible verb.
              aria-label={armed ? `Confirm unpairing ${row.name}` : `Unpair ${row.name}`}
              title={armed
                ? "Press again to stop talking to this deck. Logins it already has stay with it."
                : "Stop talking to this deck from now on"}>
              {busy === `unpair:${row.fp}` ? "Unpairing…" : armed ? "Unpair — sure?" : "Unpair"}
            </button>
          )}
          {row.kind === "nearby" && (
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
          {row.kind === "declined" && (
            <button type="button" className="btn lan-peer-verb" {...press(`allow:${row.fp}`)}
              onClick={() => void run(onVerb)}
              title="Take the no back. That deck is still trying, so its request comes round again on its own.">
              {busy === `allow:${row.fp}` ? "Allowing…" : "Let it ask again"}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
