// The network map: every deck this one knows, drawn around it.
//
// WHAT IT IS FOR. The list in Local network answers "what is wrong with which
// machine", one row at a time. It cannot answer the question somebody has
// before that one — what does my network actually look like, how much of it is
// here right now, and which of those machines are reached over the tailnet
// rather than the room they are sitting in. A picture answers that in the time
// it takes to look at it, and it is the one surface in this section made to be
// looked at rather than worked in.
//
// SO IT CHANGES NOTHING. Every press on the map either shows a deck in the
// panel beside it or opens that deck's own dialog, where the verbs already
// live; the map owns no write and says nothing the list does not already know.
// Where things stand is lan-network-map.ts's; what each deck says is
// peerView's, the same words its own dialog uses.
//
// THE ONE AUTHORED MOMENT is the network drawing itself when the map opens:
// the rings, then a wire out to each deck clockwise, then the deck at its end.
// After that the only motion is a light going out along each live wire and
// coming back — a round, which is what actually happens between two paired
// decks that are on — and it stops while the map is covered or hidden.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import {
  continuousAngle, deckNextStep, machineKey, mapHeadline, mapLayout, mapSummary, networkNextStep, nodeCaption,
  nodeName, ownAddresses, presenceLine, troubleFirst, type MapLayout, type MapNode, type MapZone,
} from "../lan-network-map";
import { HERE_SAID, laneSaid, peerView, runsLine, sinceLabel, THERE_SAID } from "../lan-peer";
import { rowSource, type DeckRow } from "../lan-roster";
import type { LanAccount, LanStatus } from "../lan-types";
import { Machine } from "./LanPeerMap";
import { useModalDismiss } from "./use-modal-dismiss";

/** The disc a deck is drawn as, and this deck's own at the centre — the
 *  wires start and stop at their edges rather than under them. */
const NODE_R = 20;
/** A machine nothing is shared with is drawn a size down, out on the grey
 *  ring — part of the picture, not part of the network yet. */
const LOOSE_R = 17;
const CORE_R = 34;
/** How long a pointer may be between two decks before the map stops holding
 *  the one it left — long enough that sweeping across the ring never flashes
 *  the whole network back to full brightness in between. */
const LEAVE_GRACE_MS = 160;
/** How long the pointer has to rest on a deck before the panel turns to it:
 *  long enough that crossing the ring on the way to somewhere else does not
 *  flick the panel through every deck under the pointer, short enough that a
 *  deck pointed at is described before the eye has left it. The disc and the
 *  dim answer at once; only the panel waits. */
const SHOW_DWELL_MS = 80;
/** A resize settles for this long before the map's own movement comes back:
 *  geometry the window moved snaps, and only a change in the data travels. */
const STILL_MS = 200;
/** One round, out and back, and the long rest after it — see `nm-round`. The
 *  lights are spread over it by the golden ratio, so no two wires ever pulse
 *  together however many there are. */
const ROUND_TRIP_S = 8;
/** How far inside the tailnet slice's outer edge its name runs. */
const ZONE_LABEL_INSET = 6;

/** How the side panel arrives — see `entrance` in the map. */
type Entrance = "full" | "swap" | "none";
const GOLDEN = 0.618_033_988_75;

export default function LanNetworkMap({ status, rows, accounts, now, covered, onOpenDeck, onClose }: {
  status: LanStatus | null;
  /** The rows the list is drawn from — deckRows, one per machine. */
  rows: DeckRow[];
  /** This deck's own accounts, so a deck's logins say what they would do here. */
  accounts: LanAccount[];
  now: number;
  /** Another dialog is open over the map: the lights stop under it. */
  covered: boolean;
  /** Open that deck's own dialog, over this one. */
  onOpenDeck: (fp: string) => void;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalDismiss(onClose, { focusRef: closeRef });
  const stageRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [still, setStill] = useState(false);
  const stillTimer = useRef<number | null>(null);

  // THE STAGE IS MEASURED, NOT ASSUMED. The rings are laid out in the pixels
  // the dialog actually has, so a name is drawn at the size it is set in
  // rather than scaled down with the whole picture.
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    let last: { w: number; h: number } | null = null;
    const measure = () => {
      const w = Math.round(el.clientWidth);
      const h = Math.round(el.clientHeight);
      if (last && last.w === w && last.h === h) return;
      // A resize moves every deck at once, and none of them because anything
      // about the network changed — so for a moment the map does not travel.
      if (last) {
        setStill(true);
        if (stillTimer.current != null) window.clearTimeout(stillTimer.current);
        stillTimer.current = window.setTimeout(() => setStill(false), STILL_MS);
      }
      last = { w, h };
      setSize(last);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (stillTimer.current != null) window.clearTimeout(stillTimer.current);
    };
  }, []);

  const layout = useMemo<MapLayout | null>(
    // The captions as the decks will draw them — a live deck's is what it
    // runs — so every name box is laid out at the width it takes.
    () => (size
      ? mapLayout(rows, size.w, size.h, status?.name ?? "", row => nodeCaption(row, rowSource(status, row).peer?.about?.os))
      : null),
    [rows, size, status],
  );
  const summary = useMemo(() => mapSummary(rows), [rows]);
  const nodes = layout?.nodes ?? [];

  // EVERY WIRE TURNS THE SHORT WAY. A deck that changes ring usually changes
  // angle too, and the wire and the deck travel together along the same arc —
  // see `--nm-a` in the sheet — so the angle each one is handed is kept
  // continuous with the last one it was handed, by machine.
  const turned = useRef(new Map<string, number>());
  const angles = useMemo(() => {
    const next = new Map<string, number>();
    for (const n of nodes) {
      const key = machineKey(n.row);
      next.set(key, continuousAngle(turned.current.get(key), n.angle));
    }
    turned.current = next;
    return next;
  }, [nodes]);

  // Which machine the pointer or the keyboard is on — the rest of the network
  // dims around it — and which one the panel beside the map is showing. They
  // part on purpose: the panel keeps the last deck looked at, so the pointer
  // can travel from the ring to the panel's own button without the panel
  // changing under it on the way. Held by machine rather than by fingerprint,
  // because a machine running two decks leads with whichever answered last.
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [shownKey, setShownKey] = useState<string | null>(null);
  // HOW THE PANEL ARRIVES, which depends on what was there before it. The
  // first deck after the network's summary unfolds — its parts rise out of a
  // blur one after another, because that is the panel opening. Every deck
  // after it only crossfades through a slight blur, because a pointer
  // sweeping the ring sees this tens of times and a cascade each time would
  // be the map making it wait. And a deck reached by the keyboard arrives at
  // once: a key held down on the ring must never queue animations behind it.
  // Still on open: the network's summary arrives with the dialog itself, and
  // the map is the only thing drawing.
  const [entrance, setEntrance] = useState<Entrance>("none");
  const shownRef = useRef<string | null>(null);
  const showKey = useCallback((key: string | null, how: Entrance) => {
    if (shownRef.current === key) return;
    shownRef.current = key;
    setEntrance(how);
    setShownKey(key);
  }, []);
  const leaveTimer = useRef<number | null>(null);
  const showTimer = useRef<number | null>(null);
  const stopShowing = useCallback(() => {
    if (showTimer.current != null) window.clearTimeout(showTimer.current);
    showTimer.current = null;
  }, []);
  const hold = useCallback((key: string, via: "pointer" | "keyboard") => {
    if (leaveTimer.current != null) window.clearTimeout(leaveTimer.current);
    leaveTimer.current = null;
    stopShowing();
    setFocusKey(key);
    if (via === "keyboard") { showKey(key, "none"); return; }
    showTimer.current = window.setTimeout(() => showKey(key, shownRef.current ? "swap" : "full"), SHOW_DWELL_MS);
  }, [showKey, stopShowing]);
  const release = useCallback(() => {
    if (leaveTimer.current != null) window.clearTimeout(leaveTimer.current);
    stopShowing();
    leaveTimer.current = window.setTimeout(() => setFocusKey(null), LEAVE_GRACE_MS);
  }, [stopShowing]);
  useEffect(() => () => {
    if (leaveTimer.current != null) window.clearTimeout(leaveTimer.current);
    stopShowing();
  }, [stopShowing]);

  // A machine that left the ring while it was looked at fires no pointerleave
  // and no blur, so what is lit is asked of the ring as it is now — otherwise
  // the whole network would stay dimmed around a deck that is not there.
  const litKey = focusKey && nodes.some(n => machineKey(n.row) === focusKey) ? focusKey : null;
  const shownRow = shownKey ? rows.find(r => machineKey(r) === shownKey) ?? null : null;
  // And a machine that left while the panel described it hands the panel back
  // to the network rather than describing a machine that is gone.
  useEffect(() => {
    if (shownKey && !shownRow) showKey(null, "swap");
  }, [shownKey, shownRow, showKey]);

  // ONE TAB STOP FOR THE WHOLE RING, and the arrows inside it. Fifteen decks
  // as fifteen Tab presses between the title and the close would make the
  // map the slowest thing in this app to leave by keyboard. The stop is a
  // machine, not a place on the ring: a poll that moves a deck to the outer
  // ring must not hand the stop to whichever deck now stands where it stood.
  const [cursorKey, setCursorKey] = useState<string | null>(null);
  const nodeRefs = useRef(new Map<string, HTMLButtonElement>());
  const found = nodes.findIndex(n => machineKey(n.row) === cursorKey);
  const active = found < 0 ? 0 : found;
  const onRingKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (nodes.length === 0) return;
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1
      : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1
      : 0;
    const to = e.key === "Home" ? 0
      : e.key === "End" ? nodes.length - 1
      : step ? (active + step + nodes.length) % nodes.length
      : null;
    if (to == null) return;
    e.preventDefault();
    const key = machineKey(nodes[to].row);
    setCursorKey(key);
    nodeRefs.current.get(key)?.focus();
  };

  // STILL WHILE IT CANNOT BE SEEN: under any dialog opened over it, and while
  // the window is hidden. A loop nobody is watching is a loop the machine pays
  // for anyway.
  const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.hidden);
  useEffect(() => {
    const onVisibility = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const on = status?.enabled === true;
  const headline = !status ? "checking…" : !on ? "Local network is off" : mapHeadline(summary);
  // The dwell's timer goes too: Back hands focus to the deck's ring button
  // first (#1748), and that focus must not bring the deck back 80ms later.
  const toNetwork = () => { stopShowing(); showKey(null, "swap"); setFocusKey(null); };
  const litNode = litKey ? nodes.find(n => machineKey(n.row) === litKey) ?? null : null;
  // The deck panel's way back takes itself away with the panel, so focus goes
  // to the ring button of the deck it was showing — the ring's own tab stop —
  // rather than falling to the page (#1748). First, because focusing a deck on
  // the ring shows it in the panel, and the hand-back has to come after it.
  const backToNetwork = () => {
    if (shownKey) nodeRefs.current.get(shownKey)?.focus();
    toNetwork();
  };

  return createPortal(
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div ref={dialogRef} className="modal nm-modal" onClick={e => e.stopPropagation()}
        data-paused={covered || hidden || undefined}
        role="dialog" aria-modal="true" aria-labelledby="nm-title" aria-describedby="nm-sub">
        <header className="modal-head nm-head">
          <div className="nm-heading">
            <h2 id="nm-title" className="modal-title nm-title">Network map</h2>
            <p id="nm-sub" className="nm-sub">{headline}</p>
          </div>
          <div className="modal-actions">
            <button ref={closeRef} type="button" className="glyph-btn" onClick={onClose}
              aria-label="Close (Esc)" title="Close (Esc)">×</button>
          </div>
        </header>

        <div className="nm-body">
          <div className="nm-view">
          <div ref={stageRef} className="nm-stage"
            data-focus={litKey ? "" : undefined}
            data-focus-via={litNode?.row.via}
            data-dense={layout?.dense || undefined}
            data-still={still || undefined}
            // A press on the ground between the decks gives the panel back to
            // the network as a whole.
            onClick={e => { if (e.target === e.currentTarget) toNetwork(); }}>
            {size && layout && (
              <>
                <Orbits layout={layout} w={size.w} h={size.h} />
                {nodes.map(n => {
                  const key = machineKey(n.row);
                  return <Wire key={key} node={n} angle={angles.get(key) ?? n.angle} lit={litKey === key} />;
                })}
                <Core status={status} />
                <span id="nm-ring-hint" className="vis-hidden">Arrow keys move between decks. Enter opens the deck's own dialog.</span>
                <div className="nm-ring" role="group" aria-label={`Decks around this deck, ${nodes.length}`}
                  aria-describedby="nm-ring-hint" onKeyDown={onRingKey}>
                  {nodes.map((n, i) => {
                    const key = machineKey(n.row);
                    return (
                      <DeckNode key={key} node={n} angle={angles.get(key) ?? n.angle}
                        os={rowSource(status, n.row).peer?.about?.os}
                        lit={litKey === key}
                        shown={shownKey === key}
                        tabbable={i === active}
                        register={el => {
                          if (el) nodeRefs.current.set(key, el);
                          else nodeRefs.current.delete(key);
                        }}
                        onHold={via => { setCursorKey(key); hold(key, via); }}
                        onRelease={release}
                        onOpen={() => onOpenDeck(n.row.fp)} />
                    );
                  })}
                </div>
                {nodes.length === 0 && <EmptyNote status={status} />}
              </>
            )}
          </div>
          <Legend />
          </div>

          <aside className="nm-side" aria-label="Details">
            {shownRow && status
              ? <DeckDetails key={machineKey(shownRow)} row={shownRow} status={status} accounts={accounts} now={now}
                  entrance={entrance}
                  onOpen={() => onOpenDeck(shownRow.fp)} onBack={backToNetwork} />
              : <NetworkDetails status={status} summary={summary} entrance={entrance} />}
          </aside>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** The way in, drawn at the app's small-icon spec — 13px on a 14 viewBox,
 *  1.3 stroke, round caps: one deck in the middle, a wire out to three. */
export function MapGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor"
      strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="7" cy="7.4" r="1.8" />
      <circle cx="2.4" cy="2.9" r="1.2" />
      <circle cx="11.6" cy="2.9" r="1.2" />
      <circle cx="7" cy="12.4" r="1.1" />
      <path d="M5.7 6.1 3.3 3.8M8.3 6.1l2.4-2.3M7 9.2v2.1" />
    </svg>
  );
}

/** The rings, where each has a deck on it, and the tailnet's slice. Drawn
 *  once, in the stage's own pixels, and never animated past their entrance. */
function Orbits({ layout, w, h }: { layout: MapLayout; w: number; h: number }) {
  const { zone } = layout;
  return (
    <svg className="nm-orbits" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
      {zone && (
        <>
          <defs>
            <path id="nm-zone-arc" d={zoneArc(zone, w / 2, h / 2)} />
            {/* Clear at the centre, rising over the inner stretch and lying
                flat under the decks, so the slice reads as a region they
                stand in rather than a wedge cut out of the map. */}
            <radialGradient id="nm-zone-fill" gradientUnits="userSpaceOnUse"
              cx={w / 2} cy={h / 2} r={Math.max(zone.outer.rx, zone.outer.ry)}>
              <stop className="nm-zone-stop" offset="0.2" data-at="in" />
              <stop className="nm-zone-stop" offset="0.5" data-at="mid" />
              <stop className="nm-zone-stop" offset="1" data-at="out" />
            </radialGradient>
          </defs>
          <path className="nm-zone" d={zonePath(zone, w / 2, h / 2)} fill="url(#nm-zone-fill)" />
          <text className="nm-zone-label">
            <textPath href="#nm-zone-arc" startOffset="50%" textAnchor="middle">
              {/* What stands in it, not this deck's own address — the panel
                  has that. */}
              {`Tailscale · ${zone.count} deck${zone.count === 1 ? "" : "s"}`}
            </textPath>
          </text>
        </>
      )}
      {layout.rings.map((r, i) => (
        <ellipse key={r.ring} className="nm-orbit" data-ring={r.ring} data-folded={(layout.folded && r.ring === 1) || undefined}
          cx={w / 2} cy={h / 2} rx={r.rx} ry={r.ry}
          style={{ "--ring": i } as CSSProperties} />
      ))}
    </svg>
  );
}

/** A point on an ellipse centred at (cx, cy), at a parameter angle in degrees. */
function onEllipse(e: { rx: number; ry: number }, cx: number, cy: number, deg: number): string {
  const rad = (deg * Math.PI) / 180;
  return `${(cx + Math.cos(rad) * e.rx).toFixed(1)},${(cy + Math.sin(rad) * e.ry).toFixed(1)}`;
}

/** The slice itself: out along its near edge, round the outside, in along
 *  its far edge and back round the inside. */
function zonePath(z: MapZone, cx: number, cy: number): string {
  const large = z.to - z.from > 180 ? 1 : 0;
  return [
    `M${onEllipse(z.inner, cx, cy, z.from)}`,
    `L${onEllipse(z.outer, cx, cy, z.from)}`,
    `A${z.outer.rx.toFixed(1)},${z.outer.ry.toFixed(1)} 0 ${large} 1 ${onEllipse(z.outer, cx, cy, z.to)}`,
    `L${onEllipse(z.inner, cx, cy, z.to)}`,
    `A${z.inner.rx.toFixed(1)},${z.inner.ry.toFixed(1)} 0 ${large} 0 ${onEllipse(z.inner, cx, cy, z.from)}`,
    "Z",
  ].join(" ");
}

/** The line the slice's name runs along: just inside its outer edge, and
 *  drawn from the far end back to the near one, so that at the lower right
 *  the words read upward rather than upside down. */
function zoneArc(z: MapZone, cx: number, cy: number): string {
  const e = { rx: z.outer.rx - ZONE_LABEL_INSET, ry: z.outer.ry - ZONE_LABEL_INSET };
  const large = z.to - z.from > 180 ? 1 : 0;
  return `M${onEllipse(e, cx, cy, z.to)} A${e.rx.toFixed(1)},${e.ry.toFixed(1)} 0 ${large} 0 ${onEllipse(e, cx, cy, z.from)}`;
}

/** A wire from this deck's edge to that one's. A light runs out along it and
 *  back only while that deck is paired and on — the round the two decks are
 *  actually having. */
function Wire({ node, angle, lit }: { node: MapNode; angle: number; lit: boolean }) {
  const live = node.row.kind === "paired" && node.row.here;
  // Each wire's light starts a little later than the last, by the golden
  // ratio of the round, so no two ever leave together.
  const phase = ((node.order * GOLDEN) % 1) * ROUND_TRIP_S;
  return (
    <span className="nm-wire" aria-hidden
      data-tier={node.tier} data-via={node.row.via} data-on={lit || undefined}
      style={{
        "--nm-a": `${angle.toFixed(2)}deg`,
        "--nm-d": `${node.dist.toFixed(1)}px`,
        "--from": `${CORE_R}px`,
        "--gap": `${CORE_R + (node.tier === "loose" ? LOOSE_R : NODE_R)}px`,
        "--i": node.order,
        "--phase": `${phase.toFixed(2)}s`,
      } as CSSProperties}>
      {live && <i className="nm-glint" />}
    </span>
  );
}

/** This deck, at the centre of everything it can see. */
function Core({ status }: { status: LanStatus | null }) {
  const listening = status?.enabled === true && status.running;
  return (
    <div className="nm-core" data-listening={listening || undefined}>
      <span className="nm-core-orb" aria-hidden />
      <span className="nm-core-label">
        <span className="nm-core-name">{status?.name ?? "…"}</span>
        <span className="nm-core-what">this deck</span>
      </span>
    </div>
  );
}

function DeckNode({ node, angle, os, lit, shown, tabbable, register, onHold, onRelease, onOpen }: {
  node: MapNode;
  /** Its direction from the centre, kept continuous — see `angles`. */
  angle: number;
  os: string | null | undefined;
  lit: boolean;
  shown: boolean;
  tabbable: boolean;
  register: (el: HTMLButtonElement | null) => void;
  onHold: (via: "pointer" | "keyboard") => void;
  onRelease: () => void;
  onOpen: () => void;
}) {
  const { row } = node;
  // An id from the machine, hashed: a typed address can hold a space, and an
  // id with one is two references in an aria-describedby list.
  const describedBy = `nm-d-${idFor(machineKey(row))}`;
  const rad = (node.angle * Math.PI) / 180;
  const caption = nodeCaption(row, os);

  return (
    <button ref={register} type="button" className="nm-node"
      tabIndex={tabbable ? 0 : -1}
      data-tier={node.tier} data-kind={row.kind} data-side={node.side}
      data-via={row.via} data-on={lit || undefined} data-shown={shown || undefined}
      aria-label={`${row.name}: ${presenceLine(row)}`}
      // Only a live deck's caption says something its label does not — what
      // it runs; an away deck's is its presence line again, said twice.
      aria-describedby={node.tier === "online" ? describedBy : undefined}
      style={{
        "--nm-a": `${angle.toFixed(2)}deg`,
        "--nm-d": `${node.dist.toFixed(1)}px`,
        "--i": node.order,
        // Where it arrives from: a little way in along its own wire, so every
        // deck lands on its ring from the direction of the centre.
        "--in-x": `${(-Math.cos(rad) * 14).toFixed(1)}px`,
        "--in-y": `${(-Math.sin(rad) * 14).toFixed(1)}px`,
      } as CSSProperties}
      onPointerEnter={e => { if (e.pointerType === "mouse") onHold("pointer"); }}
      onPointerLeave={onRelease}
      // A keyboard's focus, not every focus: a press focuses the button too,
      // and that is the pointer arriving, not the keyboard.
      onFocus={e => onHold(e.currentTarget.matches(":focus-visible") ? "keyboard" : "pointer")}
      onBlur={onRelease}
      onClick={onOpen}>
      <i className="nm-halo" data-tier={node.tier} aria-hidden />
      {/* An address nothing has answered at is not a machine yet, so it is
          not drawn as one. */}
      {row.kind === "dialling" ? <i className="nm-addr-dot" aria-hidden /> : <Machine />}
      <i className="nm-mark" data-tier={node.tier} data-kind={row.kind} aria-hidden />
      <span className="nm-label" aria-hidden>
        <span className="nm-name">{nodeName(row)}</span>
        <span className="nm-cap">{caption}</span>
      </span>
      {/* The caption, for a screen reader: what the deck runs, or how long
          it has been away. The drawn one is aria-hidden with its name. */}
      {node.tier === "online" && <span id={describedBy} className="vis-hidden">{caption}</span>}
    </button>
  );
}

function EmptyNote({ status }: { status: LanStatus | null }) {
  const on = status?.enabled === true;
  return (
    <p className="nm-empty">
      {!status ? "Asking this deck about the network…"
        : !on ? "Local network is off, so this deck is not looking for any other."
        : "No other deck yet. Decks on one network usually find each other within a minute; one on another "
          + "network needs its address, through Add a deck in Local network."}
    </p>
  );
}

/** The key: the three rings inside out, each drawn as the wire and the mark
 *  its decks wear, and the tailnet's slice. Four entries, one word each —
 *  the same four words the decks and the panel use. */
function Legend() {
  return (
    <ul className="nm-legend">
      <li><span className="nm-key" aria-hidden><i className="nm-key-wire" data-tier="online" /><i className="nm-key-mark" data-tier="online" /></span>online</li>
      <li><span className="nm-key" aria-hidden><i className="nm-key-wire" data-tier="offline" /><i className="nm-key-mark" data-tier="offline" /></span>away</li>
      <li><span className="nm-key" aria-hidden><i className="nm-key-wire" data-tier="loose" /><i className="nm-key-mark" data-tier="loose" /></span>not paired</li>
      <li><i className="nm-key-zone" aria-hidden />over Tailscale</li>
    </ul>
  );
}

/** A label and its value, in the dialog's own grid. */
function Facts({ facts }: { facts: Array<{ label: string; value: ReactNode; quiet?: boolean }> }) {
  return (
    <dl className="lan-facts nm-facts">
      {facts.map(f => (
        <div key={f.label} className="lan-fact" data-tone={f.quiet ? "quiet" : undefined}>
          <dt>{f.label}</dt>
          <dd>{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The panel with nothing pointed at: this deck, the network in numbers —
 *  in ring order, each beside the mark its decks wear — and the one thing
 *  worth doing about it, if there is one. */
function NetworkDetails({ status, summary, entrance }: {
  status: LanStatus | null;
  summary: ReturnType<typeof mapSummary>;
  entrance: Entrance;
}) {
  const addresses = ownAddresses(status);
  const runs = runsLine(status?.about);
  const facts: Array<{ label: string; value: ReactNode; quiet?: boolean }> = [];
  if (runs) facts.push({ label: "Runs", value: runs });
  facts.push({
    label: addresses.length > 1 ? "Addresses" : "Address",
    value: addresses.length
      ? <span className="nm-addrs">{addresses.map(a => <code key={a} className="ap-lan-code">{a}</code>)}</span>
      : "none yet",
    quiet: addresses.length === 0,
  });
  if (status?.pairingMode) {
    facts.push({ label: "Pairing", value: status.pairingMode === "invite" ? "by invite only" : "asks and answers" });
  }
  // The same words the decks and the key use, inside out.
  const counts: Array<{ key: string; n: number; words: string; mark: ReactNode }> = [
    { key: "online", n: summary.online, words: "online", mark: <i className="nm-key-mark" data-tier="online" aria-hidden /> },
    { key: "away", n: summary.offline, words: "away", mark: <i className="nm-key-mark" data-tier="offline" aria-hidden /> },
    { key: "asks", n: summary.asks, words: "asking to pair", mark: <i className="nm-key-mark" data-tier="loose" data-kind="asks" aria-hidden /> },
    { key: "nearby", n: summary.nearby, words: "nearby, not paired", mark: <i className="nm-key-mark" data-tier="loose" aria-hidden /> },
    { key: "dialling", n: summary.dialling, words: "still dialling", mark: <i className="nm-key-mark" data-tier="loose" aria-hidden /> },
    { key: "declined", n: summary.declined, words: "declined, not drawn", mark: <i aria-hidden /> },
  ];
  const next = networkNextStep(summary);
  return (
    <div className="nm-panel" data-view="network" data-entrance={entrance}>
      <h3 className="nm-panel-name">{status?.name ?? "…"}</h3>
      <p className="nm-panel-self">this deck, at the centre of the map</p>
      <ul className="nm-counts">
        {counts.filter(c => c.n > 0).map(c => (
          <li key={c.key} data-count={c.key}>
            {c.mark}
            <span className="nm-count-n">{c.n}</span>
            <span className="nm-count-words">{c.words}</span>
          </li>
        ))}
      </ul>
      {summary.tailnet > 0 && (
        <p className="nm-counts-note">
          {summary.tailnet} reached over Tailscale — the shaded slice, lower right
        </p>
      )}
      {next && <p className="nm-next">{next}</p>}
      <Facts facts={facts} />
      <p className="nm-panel-hint">Point at a deck, or reach one with the arrow keys, to see it here. Press it to open its own dialog.</p>
    </div>
  );
}

/** The panel while a deck is pointed at, or was last: what its own dialog says
 *  about it, in the order somebody reads a machine — is it there and what to
 *  do about it, how it is reached and what it runs, and what the two decks
 *  share, trouble first. The button stays where it is from deck to deck, so
 *  the pointer that travels to it finds it. */
function DeckDetails({ row, status, accounts, now, entrance, onOpen, onBack }: {
  row: DeckRow;
  entrance: Entrance;
  status: LanStatus;
  accounts: LanAccount[];
  now: number;
  onOpen: () => void;
  onBack: () => void;
}) {
  const view = peerView({ row, source: rowSource(status, row), status, accounts, now });
  const facts: Array<{ label: string; value: ReactNode; quiet?: boolean }> = [];
  const reached = view.how ?? (view.peer?.waiting ? "it calls this deck; this deck has no address for it" : null);
  if (reached) facts.push({ label: "Reached", value: reached });
  if (view.where) facts.push({ label: "Address", value: <code className="ap-lan-code">{view.where}</code> });
  facts.push({
    label: "Runs",
    value: view.thereRuns
      ? `${view.thereRuns}${view.order ? ` · ${view.order < 0 ? "older than this deck" : "newer than this deck"}` : ""}`
      : view.unsaid,
    quiet: !view.thereRuns,
  });
  if (view.paired && view.peer?.pairedAt) facts.push({ label: "Paired", value: sinceLabel(view.peer.pairedAt, now) });
  if (view.hiddenThere) facts.push({ label: "Signed in to", value: "not said — its owner hides it", quiet: true });
  if (view.otherThere) facts.push({ label: "Signed in to", value: "an account it does not share", quiet: true });

  const emits = (row.kind === "paired" && row.here) || row.kind === "asks";
  const next = deckNextStep(row, status.pairingMode);
  const LANES_SHOWN = 6;
  const lanes = troubleFirst(view.lanes).slice(0, LANES_SHOWN);
  const more = view.lanes.length - lanes.length;
  const fine = view.lanes.filter(l => l.tone === "ok").length;
  const total = view.lanes.length;
  const title = total === 0 ? "No logins between the two"
    : `${total} login${total === 1 ? "" : "s"} between the two${fine === total ? (total === 1 ? ", fine" : ", all fine") : ` · ${fine} fine`}`;

  return (
    <div className="nm-panel" data-view="deck" data-entrance={entrance}
      data-tier={row.kind === "paired" ? (row.here ? "online" : "offline") : "loose"}>
      <button type="button" className="ap-lan-word nm-back" onClick={onBack}>
        <span aria-hidden>‹ </span>the whole network
      </button>
      <h3 className="nm-panel-name">
        {/* The map's own mark, said again: the green emission only for a
            paired deck that is on, the accent for one asking. A nearby deck
            is heard, and `here`, but it is not online in the legend's sense. */}
        <i className={emits ? "ap-pulse" : "ap-dot"} data-kind={row.kind} aria-hidden />
        {row.name}
      </h3>
      {row.self && <p className="nm-panel-self">calls itself {row.self}</p>}
      <p className="nm-panel-state" data-kind={row.kind}>{presenceLine(row)}</p>
      {next && <p className="nm-next">{next}</p>}
      <button type="button" className="btn nm-open" onClick={onOpen}>Open {row.name}</button>
      <Facts facts={facts} />
      {view.paired && (
        <section className="nm-logins" aria-label="Logins the two decks share">
          <p className="nm-logins-title">{title}</p>
          {lanes.length > 0 && (
            <ul className="nm-lanes">
              {lanes.map((l, k) => (
                <li key={l.key} className="nm-lane" data-tone={l.tone} style={{ "--k": k } as CSSProperties}>
                  <i className="nm-lane-dot" aria-hidden />
                  <span className="nm-lane-email" aria-hidden>{l.email}</span>
                  {/* A mark and a word, on the email's own line: the steady
                      state says nothing, and every other says which end is
                      wrong or what comes next, in the lane's own caption. */}
                  {laneWords(l) && <span className="nm-lane-said" aria-hidden>{laneWords(l)}</span>}
                  {l.usedThere && <span className="nm-lane-used" aria-hidden>in use there</span>}
                  <span className="vis-hidden">{l.email}: {laneSaid(l)}</span>
                </li>
              ))}
            </ul>
          )}
          {more > 0 && <p className="nm-lanes-more">and {more} more in its own dialog</p>}
          {view.unknown && <p className="nm-panel-hint">{view.unknown}</p>}
        </section>
      )}
    </div>
  );
}

/** What a login between the two says beside its mark: nothing while it works
 *  both ways, its caption when it has one, and otherwise the two ends. */
function laneWords(l: ReturnType<typeof peerView>["lanes"][number]): string | null {
  if (l.caption) return l.caption;
  if (l.tone === "ok") return null;
  return `${HERE_SAID[l.here]} · ${THERE_SAID[l.there]}`;
}

/** A short id that belongs to one machine: FNV-1a over its key, in base 36. */
function idFor(key: string): string {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
