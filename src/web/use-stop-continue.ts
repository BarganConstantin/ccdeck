// What the page knows about continuing turns that stopped on an expired login
// or a usage limit (#2193): the server's answer to GET /api/stop-continue — the
// gate's evidence, the setting, each session's last continue — and the presses
// this page has made.
//
// A MODULE STORE rather than state in App, the shape SessionPeek.tsx uses for
// the same reason: the answer is read by every stopped card and by the detail
// panel, and App re-renders four times a second as it is. A card reads it in
// the leaf that draws it, so an answer arriving re-renders the stop rows and
// nothing else.
//
// POLLED ONLY WHILE IT HAS SOMETHING TO SAY: while a card on the board is
// stopped, and for a short while after the last one is not — the automatic
// continue takes the stop down within seconds of running, and the line it
// leaves on the card ("Continued automatically 2m ago") is in the next answer.
// Once when the page opens, without the gate's evidence, for a continue that
// ran while it was closed.
import { useEffect, useRef, useSyncExternalStore, type MutableRefObject } from "react";
import { selfPressAccepted } from "./panel-press";
import { continueGate, type Gate, type LoginEvidence } from "../server/stop-continue-gate.mjs";
import type { StopFacts, StopKind } from "../server/stop-failure.mjs";
import type { ContinueOutcome } from "./stop-continue-copy";
import { gateSentence } from "./stop-continue-copy";
import type { GraphState } from "./graph-state";
import type { AgentNodeData } from "./types";

/** One session as the server keeps it. */
export interface ServerRecord {
  stop: { kind: StopKind; at: number } | null;
  /** Continued automatically, then stopped again: held until somebody acts. */
  held: boolean;
  /** The automatic continue has had its one go at this stop. */
  tried: boolean;
  last: ContinueOutcome | null;
}

export interface ContinueAnswer {
  auto: boolean;
  login: LoginEvidence | null;
  /** Whether `login` was asked for: an answer without it says nothing about
   *  the gate. */
  withLogin: boolean;
  sessions: Record<string, ServerRecord>;
}

export interface ContinueSnapshot {
  answer: ContinueAnswer | null;
  pressing: ReadonlySet<string>;
  /** This page's own presses, newest per session, until an answer carries them. */
  pressed: Readonly<Record<string, ContinueOutcome>>;
}

let snap: ContinueSnapshot = { answer: null, pressing: new Set(), pressed: {} };
/** The sessions with a press out, read by the press itself rather than off
 *  the snapshot a render drew from (#620): the second Enter lands before the
 *  next render, and the card and the panel share one press per session. */
const pressingRef: { current: Set<string> } = { current: new Set() };
const listeners = new Set<() => void>();
function publish(next: Partial<ContinueSnapshot>): void {
  snap = { ...snap, ...next };
  for (const l of listeners) l();
}
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const read = () => snap;

/** The store, for a component. */
export function useStopContinueSnapshot(): ContinueSnapshot {
  return useSyncExternalStore(subscribe, read, read);
}

/** For the suite: put the store back, or into a given state. */
export function resetStopContinue(next: Partial<ContinueSnapshot> = {}): void {
  snap = { answer: null, pressing: new Set(), pressed: {}, ...next };
  pressingRef.current = new Set(snap.pressing);
  for (const l of listeners) l();
}

const KINDS = new Set<StopKind>(["login", "usage-limit", "api-error"]);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === "string" ? v : "");

function outcomeFrom(raw: unknown): ContinueOutcome | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const at = num(o.at);
  if (at == null) return null;
  return {
    at, auto: o.auto === true, ok: o.ok === true,
    outcome: o.outcome === "continued" || o.outcome === "copied" ? o.outcome : null,
    reason: typeof o.reason === "string" ? o.reason : null,
    detail: str(o.detail), stopped: o.stopped === true,
  };
}

function loginFrom(raw: unknown): LoginEvidence | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  return { ok: o.ok === true, at: num(o.at) ?? 0, room: typeof o.room === "boolean" ? o.room : null };
}

/** GET /api/stop-continue's answer, every field checked: it is drawn. */
export function answerFrom(raw: unknown, withLogin: boolean): ContinueAnswer | null {
  if (!raw || typeof raw !== "object" || (raw as { ok?: unknown }).ok !== true) return null;
  const o = raw as Record<string, unknown>;
  const sessions: Record<string, ServerRecord> = {};
  const src = o.sessions && typeof o.sessions === "object" ? o.sessions as Record<string, unknown> : {};
  for (const [sid, v] of Object.entries(src)) {
    if (!v || typeof v !== "object") continue;
    const r = v as Record<string, unknown>;
    const s = r.stop as Record<string, unknown> | null | undefined;
    const stop = s && KINDS.has(s.kind as StopKind) && num(s.at) != null ? { kind: s.kind as StopKind, at: s.at as number } : null;
    sessions[sid] = { stop, held: r.held === true, tried: r.tried === true, last: outcomeFrom(r.last) };
  }
  return { auto: o.auto === true, login: withLogin ? loginFrom(o.login) : null, withLogin, sessions };
}

/** Ask the server again. `withLogin` adds the gate's evidence, which costs
 *  the server a quota read (cached and floored there). */
export async function refreshStopContinue(withLogin = true): Promise<void> {
  try {
    const res = await fetch(`/api/stop-continue${withLogin ? "?login=1" : ""}`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return;
    const answer = answerFrom(await res.json(), withLogin);
    if (!answer) return;
    // An answer without the evidence keeps the evidence it already had.
    const login = withLogin ? answer.login : snap.answer?.login ?? null;
    publish({ answer: { ...answer, login, withLogin: withLogin || (snap.answer?.withLogin ?? false) } });
  } catch { /* the next poll asks again */ }
}

/** A press of Continue on a background session's stop. What the server said
 *  goes into the store at once, as this session's newest outcome. */
export async function pressContinue(sessionId: string, stop: Pick<StopFacts, "kind" | "at">): Promise<ContinueOutcome | null> {
  if (!selfPressAccepted(pressingRef.current.has(sessionId))) return null;
  pressingRef.current.add(sessionId);
  publish({ pressing: new Set([...snap.pressing, sessionId]) });
  let out: ContinueOutcome;
  try {
    const res = await fetch("/api/stop-continue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, stop: { kind: stop.kind, at: stop.at } }),
    });
    const body = await res.json().catch(() => null) as Record<string, unknown> | null;
    const reason = typeof body?.reason === "string" ? body.reason : res.ok ? null : res.status === 401 || res.status === 403 ? "refused" : "failed";
    out = {
      at: Date.now(), auto: false, ok: body?.ok === true,
      outcome: body?.outcome === "copied" ? "copied" : body?.ok === true ? "continued" : null,
      reason,
      detail: reason === "not_ready" ? gateSentence((body?.gate as Gate["reason"]) ?? null) : str(body?.detail),
      stopped: body?.stopped === true,
    };
  } catch {
    out = { at: Date.now(), auto: false, ok: false, outcome: null, reason: "unreachable", detail: "", stopped: false };
  }
  pressingRef.current.delete(sessionId);
  const pressing = new Set(snap.pressing);
  pressing.delete(sessionId);
  publish({ pressing, pressed: { ...snap.pressed, [sessionId]: out } });
  void refreshStopContinue(true);
  return out;
}

/** One session's continue, as a surface draws it. */
export interface ContinueView {
  /** The stop on the card now, or null once the session moved on. */
  stop: StopFacts | null;
  /** Claude Code keeps a job folder for it: `claude --bg`, agent view. */
  background: boolean;
  jobId: string | null;
  /** The server has answered with the gate's evidence. */
  loaded: boolean;
  gate: Gate;
  pressing: boolean;
  auto: boolean;
  held: boolean;
  tried: boolean;
  /** The newest continue of this session, a press here or the server's. */
  last: ContinueOutcome | null;
}

/** How long a continue's line stays on a card that is no longer stopped. */
export const CONTINUED_SHOWN_MS = 30 * 60_000;

/**
 * What the card and the panel say about one session, or null when there is
 * nothing: not a Claude session root, or neither stopped nor continued.
 */
export function continueView(
  a: Pick<AgentNodeData, "kind" | "sessionId" | "stopFailure" | "job" | "provider">,
  s: ContinueSnapshot,
): ContinueView | null {
  if (a.kind !== "root" || a.provider === "codex") return null;
  const rec = s.answer?.sessions[a.sessionId] ?? null;
  const mine = s.pressed[a.sessionId] ?? null;
  const last = [rec?.last ?? null, mine].filter((o): o is ContinueOutcome => o != null).sort((x, y) => y.at - x.at)[0] ?? null;
  const stop = a.stopFailure ?? null;
  if (!stop && !last) return null;
  // The server's flags are about the stop it saw; a stop it never saw (a deck
  // restarted since) has none.
  const same = rec?.stop != null && stop != null && rec.stop.at === stop.at;
  return {
    stop,
    background: a.job != null,
    jobId: a.job?.id || null,
    loaded: s.answer?.withLogin === true,
    gate: continueGate(stop, s.answer?.login ?? null),
    pressing: s.pressing.has(a.sessionId),
    auto: s.answer?.auto === true,
    held: same && rec!.held,
    tried: same && rec!.tried,
    last,
  };
}

/** How often the page asks while a card is stopped. */
export const POLL_MS = 15_000;
/** How long it keeps asking after the last stopped card moved on. */
export const AFTER_MS = 2 * 60_000;

function anyStopped(state: GraphState): boolean {
  for (const a of state.agents.values()) if (a.kind === "root" && a.stopFailure) return true;
  return false;
}

/**
 * The poll, mounted once by App. `now` is the board's clock, which re-renders
 * App on its beat; `enabled` is whether this deck watches Claude Code at all.
 */
export function useStopContinueFeed({ stateRef, now, enabled }: {
  stateRef: MutableRefObject<GraphState>;
  now: number;
  enabled: boolean;
}): void {
  const seenAt = useRef(0);
  if (enabled && anyStopped(stateRef.current)) seenAt.current = now;
  const want = enabled && seenAt.current > 0 && now - seenAt.current < AFTER_MS;

  useEffect(() => {
    if (enabled) void refreshStopContinue(false);
  }, [enabled]);

  useEffect(() => {
    if (!want) return;
    void refreshStopContinue(true);
    const t = window.setInterval(() => { void refreshStopContinue(true); }, POLL_MS);
    return () => window.clearInterval(t);
  }, [want]);
}
