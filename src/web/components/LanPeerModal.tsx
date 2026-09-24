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
// THE PICTURE BEFORE THE PARTICULARS. What somebody opens this to find out is
// what goes from that machine to this one, what goes back, and which of it is
// broken — and it was answered as eleven lines of label and value and two lists
// to be read against each other. It is drawn now, in the shapes the Local
// network guide already taught: the two machines, the network between them,
// and one lane per login with the state of each copy at its own end and an
// arrow for each way a copy can travel. What is read across machines rather
// than at a glance — the fingerprint, the day it was paired — stays as label
// and value, under the picture.
//
// THE VERB IS THE ROW'S. Whatever the row's one button does, the foot of this
// does, through the same call and the same busy tag — so a press here lights the
// row behind it and the row's own press lights this. Nothing here decides
// anything the row could not.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { armedPress, pressState } from "../panel-press";
import { useModalDismiss } from "./use-modal-dismiss";
import { askedLabel, CONFIRM_GAP_MS, exchangeLanes, roundLabel, roundWhy, seenLabel, silenceNote, versionOrder } from "./LanSyncSection";
import type { DeckAbout, DeckRow, Lane, LanAccount, LanStatus, RowSource } from "./LanSyncSection";

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
  /** Close this and open the add dialog with an invite made — the one way a
   *  nearby or declined machine can still be paired while this deck pairs
   *  only by invite. Optional so a caller from before the mode still fits. */
  onInvite?: () => void;
  /** The other decks folded into this row — its name at its address, one
   *  machine running more than one — each with the peer it was built from. */
  twins?: Array<{ row: DeckRow; peer: RowSource["peer"] }>;
  /** Unpair one of those, by fingerprint, through the row's own call. */
  onUnpair?: (fp: string) => Promise<string | null>;
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

/** A deck's card as one line: its version, then the system under it. */
function runsLine(about: DeckAbout | null | undefined): string | null {
  if (!about) return null;
  return [about.version, about.os, about.arch].filter(Boolean).join(" · ") || null;
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

/** A machine, at the same stroke: a screen and the desk under it. */
function Machine() {
  return (
    <svg className="lan-machine" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2.5" y="3" width="11" height="7.5" rx="1.2" />
      <path d="M1 13h14" />
    </svg>
  );
}

/** Which way a copy travels, drawn at the end it arrives at. The bar in front
 *  of one is a copy that reaches this deck and stops there — `blocked`. It
 *  stands a clear gap ahead of the chevron: touching, the two strokes read as
 *  a letter K rather than as an arrow meeting a closed door. */
function Chevron({ dir, gate = false }: { dir: "in" | "out"; gate?: boolean }) {
  const w = gate ? 12 : 8;
  return (
    <svg className="lan-chev" data-dir={dir} data-gate={gate || undefined} width={w} height="8" viewBox={`0 0 ${w} 8`}
      fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={dir === "out" ? "M2.8 1L6 4 2.8 7" : gate ? "M1 1v6M9.6 1L6.4 4l3.2 3" : "M5.2 1L2 4l3.2 3"} />
    </svg>
  );
}

/** What the two marks at the ends of a lane stand for, for a reader who cannot
 *  see them. The caption beside them only says what is not working. */
const HERE_SAID = { works: "works here", expired: "expired here", missing: "not on this deck" } as const;
const THERE_SAID = { works: "works there", broken: "broken there", unknown: "not offered by that deck" } as const;
function laneSaid(l: Lane): string {
  const ways = l.in && l.out ? "offered both ways" : l.in ? "offered by that deck" : "offered by this deck";
  // The accent and the ring say this to the eye; these words say it aloud.
  return `${HERE_SAID[l.here]}, ${THERE_SAID[l.there]}, ${ways}${l.usedThere ? ", in use there" : ""}.`;
}

export default function LanPeerModal({
  row, source, status, accounts, now, busy, onClose, onRename, onCheck, onVerb, onSettings, onInvite,
  twins = [], onUnpair,
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
  /** Which folded deck's unpair is armed, by fingerprint: the same two presses,
   *  one deck at a time. Shares armedAt, since only one can be armed. */
  const [armedTwin, setArmedTwin] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  /** Bumped when a check comes back, so the lanes draw themselves again: the
   *  picture that answered the press is visibly a new one. */
  const [drawn, setDrawn] = useState(0);
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
  useEffect(() => {
    if (!armedTwin) return;
    const t = window.setTimeout(() => setArmedTwin(null), 4_000);
    return () => window.clearTimeout(t);
  }, [armedTwin]);

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

  // WHAT EACH END RUNS, under its name, so the two versions are read side by
  // side — which is why the comparison is one word now. `older than this
  // deck's 3.22.9` spelled out the number already printed across the dialog.
  const hereRuns = runsLine(status.about);
  const thereRuns = runsLine(about);
  const order = about?.version && mine ? versionOrder(about.version, mine) : null;

  const line = peer ? roundLabel(peer.last, now) : null;
  // WHAT THE DECK ALREADY KNEW about an address that answers nothing: whether a
  // beacon from that machine is arriving here, and on which port. See
  // silenceNote, where the two conclusions and the evidence for them live.
  //
  // Every deck heard on this network is offered, whatever list it is filed
  // under — a machine that beacons is a machine that is up, and which of this
  // panel's three lists it landed in says nothing about that. The row's own
  // beacon is among them on purpose: a PAIRED deck that is heard and cannot be
  // dialled is the same firewall, said about a machine that already has a name.
  const silence = peer && peer.last?.error
    ? silenceNote(
      { error: peer.last.error, host: peer.addr, port: peer.port },
      [
        ...(status.strangers ?? []),
        ...(status.pending ?? []),
        ...(status.peers ?? []).filter(p => !p.manual && p.addr).map(p => ({ fp: p.fp, name: p.name, addr: p.addr, port: p.port, at: p.lastSeen ?? 0 })),
      ],
      now,
    )
    : null;
  // The sentence the row translated, kept whole: `not listening` is what the
  // row can fit, `connect ECONNREFUSED 192.168.1.229:65059` is what somebody
  // fixing it needs.
  const raw = peer?.last?.error && line && line.text !== peer.last.error ? peer.last.error : null;
  const done = peer?.last?.done ?? [];
  // THE HEADER ALREADY SAID IT. A deck that did not answer reads `no answer ·
  // last online 1h ago` under its name, and the line under the network said
  // `no answer` again with the reason after it. When the header carries the
  // verdict, the picture carries what the header cannot: the reason, in the
  // machine's own words.
  const echoed = !!line && !!raw && !row.quiet && row.state.startsWith(line.text);
  const showRound = paired || row.kind === "dialling";
  // Over the tailnet the same three sentences name it, because "on this
  // network" about a laptop at home is the one thing the row must not say.
  const overTailnet = (peer?.via ?? row.via) === "tailscale";
  const how = peer
    ? peer.waiting ? null : peer.manual ? (overTailnet ? "added by its Tailscale address" : "added by address")
      : overTailnet ? "over Tailscale" : "on this network"
    : row.kind === "nearby" ? (overTailnet ? "heard over Tailscale" : "heard on this network")
    : overTailnet ? "asked this deck to pair, over Tailscale" : "asked this deck to pair";

  // THE NETWORK, drawn the way the row's mark is coloured: whole and lit while
  // it answers, broken in the warning ink when the last round failed, and a
  // dotted line for every other state — not paired yet, or not heard lately.
  const link = row.tone === "bad" ? "bad" : !paired ? "loose" : row.here ? "up" : "down";
  const asking = busy === `check:${row.fp}`;

  const offers = peer?.offers ?? null;
  // WHICH ACCOUNT IT IS ON, and only while it answers: "on this one right now"
  // cannot be vouched for by a deck that has gone quiet, so the mark stops with
  // the lights. `hidden` is its owner's switch, and `other` an account it does
  // not share — both said under its name, since neither is a lane to mark.
  const current = link === "up" ? offers?.current ?? null : null;
  const theirKey = current && "key" in current ? current.key : null;
  const hiddenThere = !!current && "hidden" in current;
  const otherThere = !!current && "other" in current;
  // A deck that calls in sends its list with every call now, so its lanes are
  // drawn from what it said like anybody else's; an older one sends none.
  const lanes = paired
    ? exchangeLanes(offers?.accounts ?? null, accounts, status.shared ?? [], theirKey)
    : [];
  // A login this deck advertises and cannot honour, with nothing coming the
  // other way to repair it: every paired deck is promised something that
  // gives them nothing. A lane that already says `sign in again` is not one.
  const spent = lanes.filter(l => l.in == null && l.out === "cut");
  const taking = lanes.some(l => l.in != null);
  const giving = lanes.some(l => l.out != null);
  // What the last round moved, on the lane it moved along. Anything it moved
  // that is not a lane any more is listed under the network instead.
  const told = new Map(done.map(d => [d.email, d]));
  const unplaced = done.filter(d => !lanes.some(l => l.email === d.email));
  // WHY THAT DECK'S HALF IS MISSING, when it is. This deck's half is drawn
  // either way — it is this deck's own list, and it is known.
  const unknown = !paired ? null
    : !offers
      ? (peer?.waiting
        // It says with every call now. One that has called and still said
        // nothing runs a version from before it started saying.
        ? "What that deck offers is not known yet. A deck that calls in says so each time it calls — one on an older version never does."
        : peer?.last?.error
          ? "What that deck offers is not known — the last attempt to ask it did not get through."
          : "Nobody has asked that deck what it offers yet. The next round asks it.")
      : offers.accounts.length === 0 ? "That deck offers nothing. Nobody there has chosen a login to share."
      : null;
  // WHEN IT LAST TOLD US, and only when that is not already answered under
  // the network. A round sets `offersBy` and `lastRound` microseconds apart,
  // so on every healthy deck this was a second printing of the same clock —
  // redundant often enough to train the eye to skip it, which is exactly the
  // habit that hides it on the one round that failed and left the lanes a
  // fossil. `offers.at` only falls behind when a round did not get through.
  const stale = offers && peer?.last && peer.last.at - offers.at > SAME_ROUND_MS
    ? seenLabel(offers.at, now)
    : null;

  // What is read across machines rather than at a glance: when the pairing
  // was made, and the fingerprint to compare with the other screen.
  const facts: Array<{ label: string; value: ReactNode; tone?: "quiet" | "meta" }> = [];
  if (paired && peer?.pairedAt) {
    facts.push({ label: "Paired", value: sinceLabel(peer.pairedAt, now), tone: "meta" });
  } else if (row.kind === "declined" && stranger) {
    facts.push({ label: "Paired", value: `no · you said no ${askedLabel(stranger.at, now)}`, tone: "meta" });
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

  // Every deck at this address, the one this dialog is about first. Empty for
  // the ordinary machine, which runs one.
  const instances = twins.length ? [{ row, peer: peer ?? null }, ...twins] : [];

  // Portalled like every dialog opened from inside the accounts panel: the
  // panel's layout rules are not a modal's to inherit — see AddAccountDialog.
  return createPortal(
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
                identically is a line that cannot be scanned. The sentence is
                still HERE, and still read aloud; it simply stops competing
                with the one thing on the surface a reader can act on. */}
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

          {/* THE PICTURE: this deck on the left, that one on the right, the
              network across the top and one lane per login under it. The two
              rails down from the machines are where every lane's ends dock,
              so a mark's side says whose copy it is without a word. */}
          <div className="lan-map" data-link={link} data-asking={asking || undefined}
            data-bus={lanes.length > 0 || undefined}>
            <div className="lan-ends">
              <p className="lan-end">
                <span className="lan-end-name">This deck</span>
                {hereRuns && <span className="lan-end-runs">{hereRuns}</span>}
                {/* This deck's own switch, said where its owner looks: the
                    decks it is paired with are reading this line about it. */}
                {paired && status.shareActive === false && (
                  <span className="lan-end-note">current account hidden</span>
                )}
              </p>
              <p className="lan-end" data-side="there">
                <span className="lan-end-name">{row.name}</span>
                {row.kind !== "dialling" && (
                  <span className="lan-end-runs">
                    {thereRuns ?? (about ? "not said" : unsaid)}
                    {order ? ` · ${order < 0 ? "older" : "newer"}` : null}
                  </span>
                )}
                {/* Working, and its owner chose not to say on which account —
                    said, rather than drawn as nothing, so that is what it reads as. */}
                {hiddenThere && <span className="lan-end-note">current account hidden</span>}
                {/* Working on an account it does not share: said, never named. */}
                {otherThere && <span className="lan-end-note">on another account</span>}
              </p>
            </div>

            <div className="lan-link">
              <Machine />
              <span className="lan-span">
                <span className="lan-wire" aria-hidden>
                  <i className="lan-glint" data-dir="out" />
                  <i className="lan-glint" data-dir="in" />
                </span>
                <span className="lan-link-label">
                  {where ? <code className="ap-lan-code">{where}</code> : "none here — it calls this deck"}
                </span>
              </span>
              <Machine />
              {((where && how) || showRound) && (
                <p className="lan-link-sub">
                  {where && how}
                  {where && how && showRound && " · "}
                  {showRound && (
                    !line ? "not asked yet"
                      : echoed ? <code className="ap-lan-code">{raw}</code>
                      // `now` is a column's word; after a clause it reads as an order.
                      : <span className="lan-round" data-tone={line.tone}>{line.text.replace(/ · now$/, " · just now")}</span>
                  )}
                  {showRound && raw && !echoed && <code className="lan-fact-raw">{raw}</code>}
                </p>
              )}
              {unplaced.length > 0 && (
                <ul className="lan-done">
                  {unplaced.map(d => {
                    const why = roundWhy(d);
                    return (
                      <li key={`${d.email}:${d.action}`} data-ok={d.ok && !why}>
                        {d.email} <span className="lan-done-what">{d.ok ? "arrived" : "did not arrive"}{why && ` — ${why.long}`}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
              {/* Why the silence, when this deck holds evidence the socket did
                  not — a beacon from the same machine. See silenceNote. */}
              {silence && <p className="lan-note lan-link-note">{silence}</p>}
              {/* The one-way case in full — the sentence the row's tooltip used
                  to carry, which is the only place it is ever explained. */}
              {peer?.waiting && <p className="lan-note lan-link-note">{row.hint}</p>}
            </div>

            {lanes.length > 0 && (
              <ul key={drawn} className="lan-lanes" role="list" aria-label={`Logins between this deck and ${row.name}`}>
                {lanes.map((l, i) => {
                  const d = told.get(l.email);
                  // An arrival with a problem is not drawn as a clean one.
                  const why = d ? roundWhy(d) : null;
                  const flows = l.out === "live" || (l.in != null && l.in !== "cut");
                  return (
                    <li key={l.key} role="listitem" className="lan-lane" data-tone={l.tone}
                      data-draw={l.in && l.out ? "both" : l.in ? "in" : "out"}
                      data-used-there={l.usedThere || undefined}
                      style={{ "--i": i } as CSSProperties}>
                      <i className="lan-pip" data-end="here" data-state={l.here} aria-hidden />
                      <span className="lan-track">
                        <span className="lan-wire" data-flow={flows ? "live" : "cut"} aria-hidden>
                          {(l.in === "live" || l.in === "wait") && <i className="lan-glint" data-dir="in" data-tone={l.in} />}
                          {l.out === "live" && <i className="lan-glint" data-dir="out" />}
                        </span>
                        {l.in && l.in !== "cut" && <Chevron dir="in" gate={l.in === "blocked"} />}
                        {l.out === "live" && <Chevron dir="out" />}
                        <span className="lan-lane-email">{l.email}</span>
                      </span>
                      <i className="lan-pip" data-end="there" data-state={l.there} aria-hidden />
                      <span className="vis-hidden">{laneSaid(l)}</span>
                      {(l.caption || d) && (
                        <span className="lan-lane-note">
                          {l.caption}
                          {l.caption && d && " · "}
                          {d && (
                            <span className="lan-lane-done" data-ok={d.ok && !why}>
                              {d.ok ? "arrived last round" : "did not arrive last round"}{why && ` — ${why.long}`}
                            </span>
                          )}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            {paired && (
              <>
                {/* ONCE, for all of them. The fix is the same sign-in every
                    time, so it is said where the lanes end. */}
                {spent.length > 0 && (
                  <p className="lan-spent">
                    Paired decks get nothing from {spent.length === 1 ? spent[0].email : "the expired ones"} until
                    you sign in again here.
                  </p>
                )}
                {unknown && <p className="lan-empty">{unknown}</p>}
                {/* The lanes are a fossil and say so under themselves — in the
                    muted ink, because the warning is already under the name. */}
                {stale && <p className="lan-stale">As of {stale === "now" ? "just now" : stale}, when it last answered.</p>}
                {/* THE KEY TO THE ARROWS, and the scope of this deck's half:
                    a dialog about one deck is the one place somebody could
                    take this deck's list to be that deck's alone. */}
                <div className="lan-legend">
                  {taking && (
                    <span className="lan-key">
                      <span className="lan-key-wire" data-dir="in" aria-hidden><Chevron dir="in" /></span>
                      from {row.name}
                    </span>
                  )}
                  {giving ? (
                    <span className="lan-key">
                      <span className="lan-key-wire" data-dir="out" aria-hidden><Chevron dir="out" /></span>
                      from this deck, to every paired deck
                    </span>
                  ) : (
                    <span className="lan-key">This deck offers nothing yet.</span>
                  )}
                  {/* The door to this deck's half, on the key that names it. */}
                  <button type="button" className="ap-lan-word lan-legend-act" onClick={onSettings}
                    aria-label="Change what this deck offers">
                    change
                  </button>
                </div>
              </>
            )}
          </div>

          <dl className="lan-facts">
            {facts.map(f => (
              <div key={f.label} className="lan-fact" data-tone={f.tone}>
                <dt>{f.label}</dt>
                <dd>{f.value}</dd>
              </div>
            ))}
          </dl>

          {/* ONE MACHINE, MORE THAN ONE DECK. The list draws a machine once —
              two rows with one name, and no address to tell them apart, are
              one machine to anybody reading them — and this is where every
              deck folded into that row is still accounted for: its port, its
              fingerprint, what it runs, and a way to let go of the one that
              should not be there. A key the machine held before and dropped
              is one of these too: paired, no address, never calling again.
              Everything above is about the first. */}
          {instances.length > 1 && (
            <div className="modal-section">
              <h3 className="lan-h">{instances.length} decks on this machine</h3>
              <ul className="lan-twins" role="list">
                {instances.map((t, i) => {
                  const at = t.peer?.addr ? `${t.peer.addr}:${t.peer.port}` : t.row.addr;
                  const named = at || t.row.fp;
                  const since = t.peer?.pairedAt ? seenLabel(t.peer.pairedAt, now) : null;
                  const meta = [
                    t.peer?.about?.version ? `runs ${t.peer.about.version}` : null,
                    since ? `paired ${since === "now" ? "just now" : since}` : null,
                    t.row.state,
                  ].filter(Boolean).join(" · ");
                  const fpT = t.row.fp;
                  return (
                    <li key={fpT} role="listitem" className="lan-twin" data-tone={t.row.tone}>
                      <i className={t.row.here ? "ap-pulse" : "ap-dot"} aria-hidden />
                      {at
                        ? <code className="ap-lan-code lan-twin-at">{at}</code>
                        : <span className="lan-twin-at lan-twin-none">no address here</span>}
                      <code className="ap-lan-code lan-twin-fp">{fpT}</code>
                      {/* Before the second line in the markup, so the grid
                          places it beside the identity and lets it span both
                          lines; after it, auto-placement dropped it onto the
                          second line, a row below the address it acts on. */}
                      {i > 0 && onUnpair && (
                        <button type="button"
                          className={`ap-manage-btn danger lan-twin-do${armedTwin === fpT ? " armed" : ""}`}
                          {...press(`unpair:${fpT}`)}
                          onKeyDown={e => { if (e.repeat) e.preventDefault(); }}
                          onClick={() => {
                            const now = Date.now();
                            const press = armedPress({
                              armedFor: armedTwin, target: fpT, armedAt: armedAt.current, now, gapMs: CONFIRM_GAP_MS,
                            });
                            if (press === "arm") { setArmedTwin(fpT); armedAt.current = now; return; }
                            if (press === "ignore") return;
                            setArmedTwin(null);
                            void run(() => onUnpair(fpT));
                          }}
                          aria-label={armedTwin === fpT ? `Confirm unpairing ${named}` : `Unpair ${named}`}
                          title={armedTwin === fpT
                            ? "Press again to stop talking to this deck. Logins it already has stay with it."
                            : "Stop talking to this one of the machine's decks"}>
                          {busy === `unpair:${fpT}` ? "unpairing…" : armedTwin === fpT ? "confirm" : "unpair"}
                        </button>
                      )}
                      <span className="lan-twin-meta">{i === 0 ? `${meta} · shown above` : meta}</span>
                    </li>
                  );
                })}
              </ul>
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
              onClick={() => void run(onCheck).then(ok => { if (ok && alive.current) setDrawn(n => n + 1); })}
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
                const now = Date.now();
                const press = armedPress({
                  armedFor: armed ? row.fp : null, target: row.fp, armedAt: armedAt.current, now, gapMs: CONFIRM_GAP_MS,
                });
                if (press === "arm") { setArmed(true); armedAt.current = now; return; }
                // A double-click is one decision, not two — the row's rule.
                if (press === "ignore") return;
                setArmed(false);
                void run(onVerb);
              }}
              // The row's own unpair names the machine; this one said only
              // "Unpair", and it is the same irreversible verb.
              aria-label={armed ? `Confirm unpairing ${row.name}` : `Unpair ${row.name}`}
              title={armed
                ? "Press again to stop talking to this deck. Logins it already has stay with it."
                : "Stop talking to this deck from now on"}>
              {busy === `unpair:${row.fp}` ? "Unpairing…" : armed ? "Confirm unpair" : "Unpair"}
            </button>
          )}
          {row.kind === "nearby" && status.pairingMode !== "invite" && (
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
          {row.kind === "declined" && status.pairingMode !== "invite" && (
            <button type="button" className="btn lan-peer-verb" {...press(`allow:${row.fp}`)}
              onClick={() => void run(onVerb)}
              title="Take the no back. That deck is still trying, so its request comes round again on its own.">
              {busy === `allow:${row.fp}` ? "Allowing…" : "Let it ask again"}
            </button>
          )}
          {/* INVITE-ONLY LEAVES THIS FOOTER ONE VERB, not none. Without it a
              nearby or declined machine opened here showed a border with
              nothing in it — the state the comment on this footer says was
              fixed — at the moment the reader came here to pair it. */}
          {(row.kind === "nearby" || row.kind === "declined") && status.pairingMode === "invite" && onInvite && (
            <button type="button" className="btn primary lan-peer-verb"
              onClick={onInvite}
              title="This deck pairs only by invite. Make one and send it to whoever is at that machine.">
              Invite to pair
            </button>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
