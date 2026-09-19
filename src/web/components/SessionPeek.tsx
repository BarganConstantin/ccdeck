import React, { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { placeBeside } from "../popover-place";
import { isAlarming } from "../ambient-counts";
import { agentCost, agentUnpricedTokens } from "../usage-models";
import { fmtCost } from "../pricing";
import { fmtTokens } from "../token-format";
import { elapsed } from "../duration";
import { shortModel } from "../model-label";
import { sessionDisplay } from "../session-display";
import { useNow } from "../use-now";
import { branchLong, stateMarkKind, type BranchSummary } from "../node-face";
import type { AgentNodeData } from "../types";
import { stateLabel, waitingLabel } from "./AgentNode";
import { AlertMark, StateMark } from "./StateMark";

/**
 * WHICH CARD THE PEEK IS ABOUT, and the element it hangs off.
 *
 * A module store rather than state in App, on purpose: App is the whole deck
 * and re-renders four times a second as it is, and a pointer sweeping across a
 * column of tiles would add a render of all of it per tile. Here a hover
 * re-renders this one card and nothing else.
 */
interface PeekTarget {
  id: string;
  anchor: Element;
  /** How it was opened. A keyboard focus stays open until focus moves; a hover
   *  until the pointer leaves. */
  by: "pointer" | "focus";
}
let target: PeekTarget | null = null;
/** A hover waiting out OPEN_DELAY_MS, and the timer that will open it. The
 *  global timers rather than window's, so the store can be driven without a
 *  browser (adaptive-graph.test.ts). */
let pending: { at: PeekTarget; timer: ReturnType<typeof setTimeout> } | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const snapshot = () => target;

/** Long enough that a pointer crossing a column of tiles on its way somewhere
 *  else opens nothing, short enough to read as the tile answering. Once a peek
 *  is up, moving to the next tile swaps it at once — the reader is reading. */
const OPEN_DELAY_MS = 90;

function cancelPending(id?: string): void {
  if (!pending || (id != null && pending.at.id !== id)) return;
  clearTimeout(pending.timer);
  pending = null;
}

export function showPeek(id: string, anchor: Element, by: PeekTarget["by"] = "pointer"): void {
  cancelPending();
  const at = { id, anchor, by };
  if (target || by === "focus") {
    target = at;
    emit();
    return;
  }
  pending = {
    at,
    timer: setTimeout(() => {
      pending = null;
      target = at;
      emit();
    }, OPEN_DELAY_MS),
  };
}

/** Which card the peek is open on, if any. */
export function peekedId(): string | null {
  return target?.id ?? null;
}

/** Close it — or, given an id, close it only if it is still about that card,
 *  so a leave that lands after the next card's enter does not shut the new one. */
export function hidePeek(id?: string): void {
  cancelPending(id);
  if (!target || (id != null && target.id !== id)) return;
  target = null;
  emit();
}

interface SessionPeekProps {
  /** The card, read at the moment of rendering: the board is a mutable ref in
   *  App, and a copy passed down would be a render stale. */
  agentFor: (id: string) => (AgentNodeData & { branch?: BranchSummary }) | undefined;
  /** The label of a subagent's parent, for "subagent of …". */
  labelFor: (id: string) => string | undefined;
  /** The part of the window the peek may use: the canvas, less the rail of
   *  floating panels on its right. */
  bounds: () => { width: number; height: number };
}

/**
 * THE CARD, READABLE, WITHOUT ZOOMING THE CANVAS TO IT.
 *
 * At the compact and overview distances a card is a face with a name and one
 * line; this is the rest of it, at 1:1 and beside the tile, for as long as the
 * pointer rests there or the keyboard is on the card. It is the deck's hover
 * card — `.ap-peek`, the one Local network and the account fold already use —
 * so it is placed the same way (placeBeside: beside, never under, away from the
 * edge) and arrives the same way, on an opacity fade.
 *
 * Nothing in it is a control. Everything it says is also said on the card's
 * accessible name (agentAriaLabel) and in the detail panel a click opens, so it
 * is `role="tooltip"` over content that exists elsewhere, not the only door to
 * anything. At the detail distance it never opens: the card itself says all of
 * this at a readable size, and a copy of it over the top would be noise.
 */
export default function SessionPeek({ agentFor, labelFor, bounds }: SessionPeekProps) {
  const t = useSyncExternalStore(subscribe, snapshot, snapshot);
  const a = t ? agentFor(t.id) : undefined;
  // A card that left the board while its peek was up takes the peek with it,
  // and so does one whose element React Flow unmounted.
  const orphaned = t != null && (!a || !t.anchor.isConnected);
  useEffect(() => { if (orphaned && t) hidePeek(t.id); }, [orphaned, t]);
  if (!t || !a || orphaned) return null;
  return <PeekCard key={t.id} a={a} anchor={t.anchor} parentLabel={a.parentId ? labelFor(a.parentId) : undefined} bounds={bounds} />;
}

function PeekCard({ a, anchor, parentLabel, bounds }: {
  a: AgentNodeData & { branch?: BranchSummary };
  anchor: Element;
  parentLabel?: string;
  bounds: () => { width: number; height: number };
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Its own beat: the clock and the waiting duration count while it is open.
  const now = useNow(1000);
  const place = useCallback(() => {
    const el = ref.current;
    if (!el || !anchor.isConnected) return;
    const p = placeBeside(anchor.getBoundingClientRect(), { width: el.offsetWidth, height: el.offsetHeight }, bounds());
    el.style.top = `${p.top}px`;
    el.style.left = `${p.left}px`;
    el.style.maxHeight = p.maxHeight == null ? "" : `${p.maxHeight}px`;
    el.dataset.side = p.side;
  }, [anchor, bounds]);
  // Before paint, every render: a card whose waiting row appeared is taller
  // than the one that was placed.
  useLayoutEffect(() => { place(); });

  const naming = sessionDisplay(a.sessionName, a.sessionTitle);
  const failed = a.tools.filter(x => x.ok === false).length;
  const inflight = a.tools.filter(x => !x.endedAt).length;
  const cost = agentCost(a, now).total;
  const tokens = a.usage.inputTokens + a.usage.outputTokens;
  const alarm = a.kind === "root" && isAlarming(a.waiting);
  const kind = a.kind === "root" ? "session" : parentLabel ? `subagent of ${parentLabel}` : "subagent";
  const facts = [
    `${a.toolCount} ${a.toolCount === 1 ? "tool" : "tools"}`,
    inflight > 0 ? `${inflight} in-flight` : null,
    tokens > 0 ? `${fmtTokens(tokens)} tok` : null,
    cost > 0 ? `${fmtCost(cost)}${agentUnpricedTokens(a, now) > 0 ? "+" : ""}` : null,
  ].filter(Boolean).join(" · ");

  return createPortal(
    <div ref={ref} className="ap-peek node-peek" role="tooltip" id="node-peek">
      <div className="node-peek-head">
        <span className="node-peek-name">{a.label}</span>
        <span className="node-peek-time">{a.synthetic ? "≥ " : ""}{elapsed(a.startedAt, a.endedAt, now)}</span>
      </div>
      <div className="node-peek-kind">
        <span className="node-peek-state" data-kind={stateMarkKind(a.state)}>
          <StateMark kind={stateMarkKind(a.state)} />{stateLabel(a.state)}
        </span>
        <span>{kind}</span>
        {a.model ? <span>{shortModel(a.model)}</span> : null}
      </div>
      {a.kind === "root" && naming.face && <p className="node-peek-title">{naming.face}</p>}
      {a.kind === "root" && a.waiting && (
        <p className={`node-peek-wait${alarm ? " warn" : ""}`}>
          {alarm && <AlertMark />}
          <span>{waitingLabel(a.waiting)}</span>
          <b>{elapsed(a.waiting.since, undefined, now)}</b>
        </p>
      )}
      <p className="node-peek-facts">
        {facts}
        {failed > 0 && <span className="node-peek-failed"> · {failed} failed</span>}
      </p>
      {a.branch && a.branch.total > 0 && <p className="node-peek-branch">{branchLong(a.branch)}</p>}
      <p className="node-peek-hint">Double-click to zoom in · click for details</p>
    </div>,
    document.body,
  );
}
