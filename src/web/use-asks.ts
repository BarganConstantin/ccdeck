// The asks run: the sessions waiting on you, answered one after another from
// the stage, with the next one where your eyes already are.
//
// The topbar's "● N waiting" chip used to fly the camera to the oldest blocked
// session and leave you there. With the terminal stage it starts a RUN instead
// (DESIGN-UI, the v3 design): the stage opens on the oldest waiting session
// with the keys in its pane, the keys bar under the TUI shows a track — one
// segment per ask, "1 of 2" — and once the session you answered starts moving
// again the bar says "✓ paycore resumed" and offers "Next ask ›" right below
// the line you just typed into. The last answered, it says "✓ No more asks"
// and the track goes away.
//
// THE RUN NEVER MOVES BY ITSELF. Answering paycore does not carry you to
// travel: the next ask is a button, n or w, never a timer. A permission prompt
// is answered with a bare `1`, and a stage that switched sessions on its own
// would put the next `1` you type into a prompt you have not read. Nothing in
// this file calls `switchTo` except `startAsks` and `nextAsk`, which are a
// click or a key.
//
// WHAT IT WATCHES is the waiting list the topbar chip counts (blockedSessions in
// ambient-counts.ts, oldest first), and nothing else: a session in the run is
// ANSWERED when it leaves that list, and a session that joins the list is an
// ASK THAT ARRIVED. An arrival during a run is one more segment on the track;
// with the stage open and no run, it is said once, in the bar, for eight
// seconds ("● travel asks · Answer n") and then left to the chip, which keeps
// counting it. A session already waiting when the stage opened is not news.
//
// WHAT IT SAYS goes through the deck's one announcement rule, nextAnnouncement
// in block-announce.ts: a sentence when something happened ("paycore
// resumed.", "No more asks.", "travel is waiting on you."), the same string —
// silence — when nothing did. App mounts `said` in an always-mounted
// .vis-hidden role="status" region beside the topbar's others.
//
// The decisions are a pure reducer over plain data, so asks-run.test.ts can
// call what ships with no DOM; the hook is the thin part that feeds it the
// waiting list, runs the two timers and hands back the two actions.
import { useCallback, useEffect, useState } from "react";

import { nextAnnouncement } from "./block-announce";
import { useMirroredRef } from "./use-mirrored-ref";

/** A waiting session, as the run needs it. BlockedSession is one. */
export interface WaitingLike {
  id: string;
  label: string;
}

/** A run through the asks. */
export interface AsksRun {
  /** The sessions the run visits, in order: the waiting list, oldest first, as
   *  it stood when the run began, then each ask that arrived during it. */
  ids: readonly string[];
  /** The ones answered — every session that left the waiting list. */
  done: readonly string[];
  /** The segment added last during the run, for the track to grow in. */
  fresh: string | null;
  /** Each session's name, kept because a session that was answered is no longer
   *  in the waiting list to read it from, and "✓ paycore resumed" needs it. */
  labels: Readonly<Record<string, string>>;
  /** When the run leaves the bar, once every ask is answered; null while some
   *  are left. */
  endsAt: number | null;
}

/** An ask that arrived while the stage was open and no run was going. */
export interface ArrivalNote {
  id: string;
  label: string;
  /** When the note leaves the bar. */
  until: number;
}

export interface AsksState {
  run: AsksRun | null;
  arrival: ArrivalNote | null;
  /** The waiting ids seen last, oldest first, which is what "arrived" and
   *  "answered" are measured against. Null until the first look, so a deck
   *  that loads with sessions already waiting does not take them for news. */
  waiting: readonly string[] | null;
  /** Whether the stage was open at the last look: the run ends when it closes. */
  stageOpen: boolean;
  /** The sentence for the live region. */
  said: string;
}

/** How long the bar says an ask arrived. The chip goes on counting it after. */
export const ARRIVAL_NOTE_MS = 8000;
/** How long "✓ No more asks" stays before the track leaves the bar. */
export const ASKS_CLEAR_MS = 3200;

export const NO_MORE_ASKS = "No more asks.";

export type AsksAction =
  /** A look at the waiting list, the stage, and the session on it. */
  | { type: "observe"; waiting: readonly WaitingLike[]; stageOpen: boolean; current: string | null; now: number }
  /** The chip, or n with nothing going: a run over everything waiting now. */
  | { type: "start"; waiting: readonly WaitingLike[] }
  /** The arrival note's session was taken to. */
  | { type: "take-arrival" }
  /** A timer came due. */
  | { type: "expire"; now: number };

export function initialAsks(): AsksState {
  return { run: null, arrival: null, waiting: null, stageOpen: false, said: "" };
}

const sameIds = (a: readonly string[] | null, b: readonly string[]) =>
  a != null && a.length === b.length && a.every((id, i) => id === b[i]);

/** The run's labels with any name the waiting list now spells differently —
 *  the same object when none does, so a look that changed nothing is quiet. */
function freshLabels(labels: Readonly<Record<string, string>>, ids: readonly string[], waiting: readonly WaitingLike[]) {
  let out = labels;
  for (const w of waiting) {
    if (!ids.includes(w.id) || labels[w.id] === w.label) continue;
    if (out === labels) out = { ...labels };
    (out as Record<string, string>)[w.id] = w.label;
  }
  return out;
}

function observe(state: AsksState, { waiting, stageOpen, current, now }: Extract<AsksAction, { type: "observe" }>): AsksState {
  const ids = waiting.map(w => w.id);
  // The first look only learns what is already waiting.
  if (state.waiting === null) return { ...state, waiting: ids, stageOpen };
  const before = new Set(state.waiting);
  const waitingNow = new Set(ids);
  const label = (id: string, fallback = id) => waiting.find(w => w.id === id)?.label ?? fallback;
  // Oldest first, as the list is; the last of them is the newest.
  const arrived = waiting.filter(w => !before.has(w.id));
  const news: string[] = [];

  let run = state.run;
  let arrival = state.arrival;
  // Closing the stage ends the visit the run and the note belonged to. Only
  // the closing does: a run the chip starts before the stage has opened is
  // waiting for the stage, not ended by it.
  if (state.stageOpen && !stageOpen) {
    run = null;
    arrival = null;
  }

  if (run) {
    const r = run;
    // Answered: a session of the run that is no longer waiting on you.
    const answered = r.ids.filter(id => !r.done.includes(id) && !waitingNow.has(id));
    for (const id of answered) news.push(`${r.labels[id] ?? id} resumed.`);
    let done: readonly string[] = answered.length > 0 ? [...r.done, ...answered] : r.done;
    let runIds = r.ids;
    let fresh = r.fresh;
    // A session that asks again reopens its segment; one that asks for the
    // first time is a segment more. One the run already counts as open — the
    // chip read the list a moment before this look did — is neither.
    for (const w of arrived) {
      if (done.includes(w.id)) done = done.filter(id => id !== w.id);
      else if (!runIds.includes(w.id)) runIds = [...runIds, w.id];
      else continue;
      fresh = w.id;
      news.push(`${w.label} is waiting on you.`);
    }
    let labels = freshLabels(r.labels, runIds, waiting);
    for (const id of runIds) {
      if (labels[id] === undefined) labels = { ...labels, [id]: label(id) };
    }
    const allDone = runIds.every(id => done.includes(id));
    let endsAt = r.endsAt;
    if (allDone && endsAt === null) {
      endsAt = now + ASKS_CLEAR_MS;
      news.push(NO_MORE_ASKS);
    } else if (!allDone) {
      endsAt = null;
    }
    const changed = runIds !== r.ids || done !== r.done || fresh !== r.fresh || labels !== r.labels || endsAt !== r.endsAt;
    if (changed) run = { ids: runIds, done, fresh, labels, endsAt };
  } else if (stageOpen) {
    // No run: an ask that arrives while the keys are on some other session is
    // said once in the bar. Not for the session on the stage — that one is
    // in front of you already.
    const elsewhere = arrived.filter(w => w.id !== current);
    for (const w of elsewhere) news.push(`${w.label} is waiting on you.`);
    const newest = elsewhere[elsewhere.length - 1];
    if (newest) arrival = { id: newest.id, label: newest.label, until: now + ARRIVAL_NOTE_MS };
  }

  // The note is about an ask: it goes when that session stops waiting, or
  // when you go to it.
  if (arrival && (!waitingNow.has(arrival.id) || arrival.id === current)) arrival = null;

  const said = news.length > 0 ? nextAnnouncement(state.said, news.join(" "), state.said) : state.said;
  if (run === state.run && arrival === state.arrival && sameIds(state.waiting, ids)
      && stageOpen === state.stageOpen && said === state.said) return state;
  return { run, arrival, waiting: sameIds(state.waiting, ids) ? state.waiting : ids, stageOpen, said };
}

/** The asks reducer. Returns the same state object when nothing changed, which
 *  is what keeps a look at an unchanged list from rendering anything. */
export function asksReducer(state: AsksState, action: AsksAction): AsksState {
  switch (action.type) {
    case "observe":
      return observe(state, action);
    case "start": {
      // A run already going is the one the chip continues.
      if (state.run || action.waiting.length === 0) return state;
      const labels: Record<string, string> = {};
      for (const w of action.waiting) labels[w.id] = w.label;
      return {
        ...state,
        run: { ids: action.waiting.map(w => w.id), done: [], fresh: null, labels, endsAt: null },
        // The run covers the ask the note was about.
        arrival: null,
      };
    }
    case "take-arrival":
      return state.arrival ? { ...state, arrival: null } : state;
    case "expire": {
      const arrival = state.arrival && state.arrival.until <= action.now ? null : state.arrival;
      const run = state.run && state.run.endsAt !== null && state.run.endsAt <= action.now ? null : state.run;
      return arrival === state.arrival && run === state.run ? state : { ...state, arrival, run };
    }
  }
}

/** The first ask of a run not yet answered — where the chip takes you, even
 *  when it is the session already on the stage. */
export function firstOpenAsk(run: AsksRun | null): string | null {
  return run?.ids.find(id => !run.done.includes(id)) ?? null;
}

/** Where "Next ask" goes: the ask that arrived, if the bar is saying so, or
 *  else the run's first open ask other than the one on the stage. Null when
 *  there is none, and also when there is no run — the caller starts one. */
export function nextAskId(state: AsksState, current: string | null): string | null {
  if (state.arrival) return state.arrival.id;
  const run = state.run;
  return run?.ids.find(id => !run.done.includes(id) && id !== current) ?? null;
}

/** The earliest moment a timer is due, or null when nothing is waiting on one. */
export function nextDeadline(state: AsksState): number | null {
  const times = [state.arrival?.until, state.run?.endsAt].filter((t): t is number => typeof t === "number");
  return times.length > 0 ? Math.min(...times) : null;
}

/** One segment of the track: hollow to do, filled now, done in the ok hue. */
export interface AskSegment {
  id: string;
  state: "done" | "now" | "todo";
  /** Arrived during the run, last: the segment grows in. */
  fresh: boolean;
}

/** What the keys bar draws for the asks, from left to right. */
export interface AsksView {
  /** Empty when there is no run. */
  track: AskSegment[];
  /** "1 of 2": the session on the stage, while its ask is still open. */
  position: { index: number; total: number } | null;
  /** "✓ paycore resumed": the session on the stage, once its ask is answered. */
  resumed: { id: string; label: string } | null;
  /** "Next ask <name> ›". */
  next: { id: string; label: string } | null;
  /** "✓ No more asks": every ask answered. */
  clear: boolean;
  /** "● travel asks · Answer n": an ask that arrived, with no run going. */
  arrival: ArrivalNote | null;
}

export function asksView(state: AsksState, current: string | null): AsksView {
  const run = state.run;
  if (!run) return { track: [], position: null, resumed: null, next: null, clear: false, arrival: state.arrival };
  const isDone = (id: string) => run.done.includes(id);
  const track = run.ids.map(id => ({
    id,
    state: isDone(id) ? "done" as const : id === current ? "now" as const : "todo" as const,
    fresh: id === run.fresh,
  }));
  const at = current == null ? -1 : run.ids.indexOf(current);
  const open = at >= 0 && !isDone(current!);
  const nextId = nextAskId({ ...state, arrival: null }, current);
  return {
    track,
    position: open ? { index: at + 1, total: run.ids.length } : null,
    resumed: at >= 0 && !open ? { id: current!, label: run.labels[current!] ?? current! } : null,
    next: open || nextId == null ? null : { id: nextId, label: run.labels[nextId] ?? nextId },
    clear: run.ids.every(isDone),
    arrival: null,
  };
}

export interface AsksDeps {
  /** The sessions waiting on you, oldest first — App's `waitingSessions`. */
  waitingSessions: readonly WaitingLike[];
  /** Whether the terminal stage is open. */
  stageOpen: boolean;
  /** The session on the stage, if any. */
  currentId: string | null;
  /** Put a session on the stage. The run only ever calls it from a click or a
   *  key, and always with the keys in the pane: that is what answering is. */
  switchTo: (sessionId: string, opts: { focusPane: boolean }) => void;
}

export interface Asks {
  view: AsksView;
  /** For an always-mounted .vis-hidden role="status" aria-atomic region. */
  said: string;
  /** The chip: a run over everything waiting, starting at its first open ask. */
  startAsks: () => void;
  /** "Next ask", n and w: the arrived ask if the bar names one, else the run's
   *  next open ask, else a new run. */
  nextAsk: () => void;
}

export function useAsks({ waitingSessions, stageOpen, currentId, switchTo }: AsksDeps): Asks {
  const [asks, setAsks] = useState<AsksState>(initialAsks);
  const asksRef = useMirroredRef(asks);
  const waitingRef = useMirroredRef(waitingSessions);
  const currentRef = useMirroredRef(currentId);
  const switchRef = useMirroredRef(switchTo);

  // Keyed on the WORDS of the list, not the list: App rebuilds it on every
  // event and every sweep, and a list-shaped dependency would look again
  // through every tool storm to learn nothing had changed (the same reasoning
  // as use-live-announcements.ts).
  const waitingKey = waitingSessions.map(w => `${w.id}\t${w.label}`).join("\n");
  useEffect(() => {
    setAsks(s => asksReducer(s, { type: "observe", waiting: waitingRef.current, stageOpen, current: currentId, now: Date.now() }));
  }, [waitingKey, stageOpen, currentId, waitingRef]);

  // The note's eight seconds and the clear line's three: one timer, for
  // whichever is due first.
  const deadline = nextDeadline(asks);
  useEffect(() => {
    if (deadline === null) return;
    const t = setTimeout(() => setAsks(s => asksReducer(s, { type: "expire", now: Date.now() })), Math.max(0, deadline - Date.now()));
    return () => clearTimeout(t);
  }, [deadline]);

  const startAsks = useCallback(() => {
    const waiting = waitingRef.current;
    const started = asksReducer(asksRef.current, { type: "start", waiting });
    const target = firstOpenAsk(started.run) ?? waiting[0]?.id ?? null;
    if (target === null) return;
    setAsks(s => asksReducer(s, { type: "start", waiting }));
    switchRef.current(target, { focusPane: true });
  }, [asksRef, waitingRef, switchRef]);

  const nextAsk = useCallback(() => {
    const state = asksRef.current;
    if (!state.run && !state.arrival) {
      startAsks();
      return;
    }
    const target = nextAskId(state, currentRef.current);
    if (target === null) return;
    if (state.arrival) setAsks(s => asksReducer(s, { type: "take-arrival" }));
    switchRef.current(target, { focusPane: true });
  }, [asksRef, currentRef, switchRef, startAsks]);

  return { view: asksView(asks, currentId), said: asks.said, startAsks, nextAsk };
}
