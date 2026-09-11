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

  const facts: Array<{ label: string; value: ReactNode; tone?: "bad" | "quiet" }> = [];
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
      tone: paired && !peer?.pairedAt ? "quiet" : undefined,
    });
    if (about) {
      facts.push({ label: "Deck", value: versionText ?? "not said", tone: versionText ? undefined : "quiet" });
      facts.push({
        label: "System",
        value: about.os ? [about.os, about.arch].filter(Boolean).join(" · ") : "not said",
        tone: about.os ? undefined : "quiet",
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
  const offers = peer?.offers ?? null;
  const offersAt = offers ? seenLabel(offers.at, now) : null;

  const checkPress = press(`check:${row.fp}`);

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
                  <span aria-hidden>{" · "}</span>
                </>
              )}
              <span className="lan-peer-state">{row.state}</span>
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
              <h3 className="lan-h">
                Offers you
                {offersAt && <span className="lan-h-note">asked {offersAt === "now" ? "just now" : offersAt}</span>}
              </h3>
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
                <p className="lan-empty">Nothing. Nobody at that deck has ticked a login to share.</p>
              ) : (
                <ul className="lan-offers">
                  {offers.accounts.map(a => {
                    const said = offerLine(a, byKey.get(a.key) ?? null, sharedHere.has(a.key));
                    return (
                      <li key={a.key} className="lan-offer" data-tone={said.tone}>
                        <span className="lan-offer-email">{a.email}</span>
                        <span className="lan-offer-state">{said.text}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}

          {paired && (
            <div className="modal-section">
              <h3 className="lan-h">
                You offer
                <span className="lan-h-note">every paired deck gets this list</span>
              </h3>
              {offering.length ? (
                <ul className="lan-offers">
                  {offering.map(a => (
                    <li key={a.key} className="lan-offer" data-tone={a.alive ? "ok" : "idle"}>
                      <span className="lan-offer-email">{a.email}</span>
                      <span className="lan-offer-state">{a.alive ? "works here" : "not working here · nothing to give"}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="lan-empty">Nothing. No login on this deck is ticked to share.</p>
              )}
              <button type="button" className="ap-lan-word lan-peer-settings" onClick={onSettings}>
                Change what this deck offers
              </button>
            </div>
          )}
        </section>

        <footer className="lan-peer-foot">
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
              onClick={() => {
                if (!armed) { setArmed(true); armedAt.current = Date.now(); return; }
                // A double-click is one decision, not two — the row's rule.
                if (Date.now() - armedAt.current < CONFIRM_GAP_MS) return;
                setArmed(false);
                void run(onVerb);
              }}
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
