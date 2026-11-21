// What Chat reads: one session's conversation, from the deck's read-only
// transcript route (src/server/session-transcript-routes.mjs).
//
// ASKS ONLY WHILE SHOWN. Nothing is fetched while the Chat view is not on
// screen. When it is, the hook asks at once; again HEARD_MS after the session
// is heard from (`heard`, which moves on every event the board gets for it:
// its hooks, and the output watch's line for each block the transcript gains),
// so a burst of events is one ask; once more when the session's prompt count
// or its end changes (`change`); and on a timer while the page is visible,
// every POLL_MS while the session works and every IDLE_POLL_MS otherwise, for
// what no event says. Every ask after the first sends the version it holds, and
// a file that has not moved is answered `unchanged` after one stat.
//
// OLDER PAGES ON REQUEST. The route answers the last window of the file; when
// that did not reach its start, `older` loads the window before, and the next,
// up to MAX_KEPT_TURNS in all. A live answer replaces only the window it is;
// pages already loaded stay, and when the live window has slid past where they
// end, the stretch between is read before the answer is drawn.
//
// IMPORTS NO SCREEN. It answers with `ChatSource`, a type, and the words that
// belong to the answer are chosen when drawn (`useT`), so a language change
// reaches a message already on screen.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatSource, ChatTurn } from "./components/chat/chat-model";
import type { Provider } from "./types";
import { useT } from "./i18n";

/** How often a working session's conversation is asked for again. */
export const POLL_MS = 5000;

/** How often a resting session's is: a local command's output fires no event. */
export const IDLE_POLL_MS = 15000;

/** How long after the session is heard from Chat asks: the events of one step are one ask. */
export const HEARD_MS = 250;

/** The most turns Chat keeps, older pages and the live window together: no
 *  more are offered once it is reached, and the oldest go as the window grows. */
export const MAX_KEPT_TURNS = 2000;

/** The most windows read to close one gap; past it Chat starts again from the live window. */
export const MAX_GAP_PAGES = 8;

export const TRANSCRIPT_ROUTE = "/api/session/transcript";

/** The shape the route accepts for a session id (the server's own test, spelled again). */
export const TRANSCRIPT_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** A supported session ID when Chat is enabled in this pane. */
export function chatSessionFor(chatFlag: boolean, ref: { sessionId: string; provider: string } | null): string | null {
  if (!chatFlag || !ref || (ref.provider !== "claude" && ref.provider !== "codex")) return null;
  return TRANSCRIPT_SESSION_ID.test(ref.sessionId) ? ref.sessionId : null;
}

/** What one ask came to: the turns, that the file has not moved since `since`,
 *  that the session has none the deck can read yet, or a failure. `version` and
 *  `older` are the route's tokens, opaque here. */
export type TranscriptRead =
  | { kind: "ready"; complete: boolean; turns: ChatTurn[]; version?: string; older?: string }
  | { kind: "unchanged" }
  | { kind: "unknown" }
  | { kind: "failed" };

/** Which window to ask for: the live one (with the version held), or the one before a cursor. */
export interface TranscriptPage {
  since?: string;
  before?: string;
  /** With `before`: stop at this cursor, a line already held. */
  after?: string;
}

export async function readTranscript(
  session: string,
  fetchFn: (input: string, init?: RequestInit) => Promise<Response> = (input, init) => fetch(input, init),
  signal?: AbortSignal,
  provider: Provider = "claude",
  page: TranscriptPage = {},
): Promise<TranscriptRead> {
  try {
    const query = new URLSearchParams({ session });
    if (provider === "codex") query.set("provider", provider);
    if (page.before) {
      query.set("before", page.before);
      if (page.after) query.set("after", page.after);
    } else if (page.since) query.set("since", page.since);
    const res = await fetchFn(`${TRANSCRIPT_ROUTE}?${query}`, { cache: "no-store", signal });
    if (res.status === 404) return { kind: "unknown" };
    if (!res.ok) return { kind: "failed" };
    const body = await res.json() as { ok?: unknown; unchanged?: unknown; complete?: unknown; turns?: unknown; version?: unknown; older?: unknown };
    if (body.ok === true && body.unchanged === true && page.since) return { kind: "unchanged" };
    if (body.ok !== true || !Array.isArray(body.turns)) return { kind: "failed" };
    const read: TranscriptRead = { kind: "ready", complete: body.complete !== false, turns: body.turns as ChatTurn[] };
    if (typeof body.version === "string") read.version = body.version;
    if (typeof body.older === "string") read.older = body.older;
    return read;
  } catch {
    return { kind: "failed" };
  }
}

export interface SessionTranscriptInput {
  /** The session id, or null when this pane has no conversation to show. */
  session: string | null;
  provider?: Provider;
  /** The Chat view is on screen. */
  shown: boolean;
  /** The session is working: the timer asks every POLL_MS then, IDLE_POLL_MS otherwise. */
  working: boolean;
  /** The session has ended: a deck that no longer knows it cannot say more. */
  ended?: boolean;
  /** Changes when the session's prompt count or its status does (working,
   *  waiting, done, ended): one more ask, which is what catches the last reply
   *  and the question a session stops on. */
  change?: string | number;
  /** Moves whenever the board hears from the session (its `lastEventAt`): an
   *  ask HEARD_MS later, while the page is visible. */
  heard?: number;
}

export interface SessionTranscriptDeps {
  fetchFn?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Whether the page is visible; the suite's seam. */
  visible?: () => boolean;
  /** Calls back when the page's visibility changes; the suite's seam. */
  watchVisible?: (onChange: () => void) => () => void;
  pollMs?: number;
  idlePollMs?: number;
}

/** One window as read: its turns, whether it reached the file's start, and the cursor before it. */
interface Part { turns: ChatTurn[]; complete: boolean; older?: string }

type Ready = Extract<TranscriptRead, { kind: "ready" }>;

interface Held {
  session: string;
  provider: Provider;
  /** The live window, or why there is none. */
  read: Exclude<TranscriptRead, { kind: "unchanged" }>;
  /** Older windows loaded on request, oldest first. */
  pages: Part[];
  /** The cursor where `pages` end; the live window starts there when nothing is missing. */
  joint?: string;
  /** Moves by the turns added or taken away in front of what was there: Chat's
   *  scroll anchor and the offset that keeps its keys steady. */
  front: number;
}

const pageOf = (read: Ready): Part => ({ turns: read.turns, complete: read.complete, older: read.older });
const turnsIn = (parts: readonly Part[]) => parts.reduce((n, part) => n + part.turns.length, 0);

function documentVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

function watchDocument(onChange: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

/** The oldest pages go first once the whole is over MAX_KEPT_TURNS; the live window always stays. */
function capped(held: Held): Held {
  if (held.read.kind !== "ready") return held;
  let pages = held.pages;
  let front = held.front;
  while (pages.length && turnsIn(pages) + held.read.turns.length > MAX_KEPT_TURNS) {
    front -= pages[0].turns.length;
    pages = pages.slice(1);
  }
  return pages === held.pages ? held : { ...held, pages, front, joint: pages.length ? held.joint : undefined };
}

/** The live window `read`, put after what `held` keeps. `gap` is the stretch read
 *  between the pages and the window, from `joint`; null when it could not be read. */
function withRead(held: Held | null, session: string, provider: Provider, read: Held["read"], gap?: { joint?: string; parts: Part[] | null }): Held {
  const base = held && held.session === session && held.provider === provider ? held : null;
  const front = base?.front ?? 0;
  if (!base || !base.pages.length || read.kind !== "ready") return { session, provider, read, pages: [], front };
  if (read.older !== undefined && read.older === base.joint) return { ...base, read };
  if (read.older !== undefined && gap?.parts && gap.joint === base.joint) {
    return capped({ ...base, read, pages: [...base.pages, ...gap.parts], joint: read.older });
  }
  // The pages no longer meet the live window (the file was replaced, or the gap
  // could not be read): start again from the window.
  return { session, provider, read, pages: [], front: front - turnsIn(base.pages) };
}

export function useSessionTranscript(input: SessionTranscriptInput, deps: SessionTranscriptDeps = {}): ChatSource {
  const t = useT();
  const { session, provider = "claude", shown, working, change, ended, heard } = input;
  const [held, setHeld] = useState<Held | null>(null);
  const [again, setAgain] = useState(0);
  const [paging, setPaging] = useState<"idle" | "loading" | "failed">("idle");
  const dep = useRef(deps);
  dep.current = deps;
  // What is drawn, kept beside the state so an answer is merged with the newest.
  const kept = useRef<Held | null>(null);
  const commit = useCallback((next: Held | null) => { kept.current = next; setHeld(next); }, []);
  // Only the newest ask may answer: a slower, older one landing last is dropped.
  const latest = useRef(0);
  const visible = useCallback(() => (dep.current.visible ?? documentVisible)(), []);
  // One life per session shown: hiding Chat or moving on drops what is in flight.
  const life = useMemo(() => new AbortController(), [shown, session, provider]);
  useEffect(() => () => life.abort(), [life]);

  /** The stretch between `joint` and the live window's start, oldest first; null when it cannot be read. */
  const readGap = useCallback(async (id: string, signal: AbortSignal, upTo: string, joint: string): Promise<Part[] | null> => {
    const parts: Part[] = [];
    let cursor: string | undefined = upTo;
    for (let n = 0; cursor; n++) {
      if (n >= MAX_GAP_PAGES) return null;
      const read = await readTranscript(id, dep.current.fetchFn, signal, provider, { before: cursor, after: joint });
      if (read.kind !== "ready") return null;
      parts.unshift(pageOf(read));
      if (turnsIn(parts) > MAX_KEPT_TURNS) return null;
      cursor = read.older;
    }
    return parts;
  }, [provider]);

  // One ask: the answer is kept only if it is still the one wanted.
  const ask = useCallback((id: string, signal: AbortSignal) => {
    const mine = ++latest.current;
    const was = kept.current;
    const since = was && was.session === id && was.provider === provider && was.read.kind === "ready" ? was.read.version : undefined;
    void (async () => {
      const read = await readTranscript(id, dep.current.fetchFn, signal, provider, since ? { since } : {});
      if (signal.aborted || mine !== latest.current || read.kind === "unchanged") return;
      const now = kept.current;
      const joint = now && now.session === id && now.provider === provider && now.pages.length ? now.joint : undefined;
      let gap: { joint?: string; parts: Part[] | null } | undefined;
      // The live window slid past where the older pages end: read the stretch between first.
      if (read.kind === "ready" && joint && read.older && read.older !== joint) {
        gap = { joint, parts: await readGap(id, signal, read.older, joint) };
        if (signal.aborted || mine !== latest.current) return;
      }
      commit(withRead(kept.current, id, provider, read, gap));
    })();
  }, [provider, readGap, commit]);

  // On show, on a new session, on a change of prompts or end, and on Retry.
  useEffect(() => {
    if (!shown || !session) return;
    ask(session, life.signal);
  }, [shown, session, change, again, ask, life]);

  // Soon after the session is heard from. One ask per burst: a timer already
  // waiting is not pushed back, so a steady stream of events still asks.
  const seen = useRef({ heard, life });
  const soon = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const was = seen.current;
    seen.current = { heard, life };
    if (was.life !== life) {
      // Shown again, or another session: the ask on show covers it.
      if (soon.current) clearTimeout(soon.current);
      soon.current = null;
      return;
    }
    if (heard === was.heard || !shown || !session || soon.current) return;
    soon.current = setTimeout(() => {
      soon.current = null;
      if (!life.signal.aborted && visible()) ask(session, life.signal);
    }, HEARD_MS);
  }, [heard, shown, session, ask, life, visible]);

  // Once more when the page is looked at again: what it was not told while hidden.
  useEffect(() => {
    if (!shown || !session) return;
    return (dep.current.watchVisible ?? watchDocument)(() => { if (visible()) ask(session, life.signal); });
  }, [shown, session, ask, life, visible]);

  // Again on a timer while the page is looked at, sooner while the session works.
  useEffect(() => {
    if (!shown || !session) return;
    const every = working ? dep.current.pollMs ?? POLL_MS : dep.current.idlePollMs ?? IDLE_POLL_MS;
    const timer = setInterval(() => { if (visible()) ask(session, life.signal); }, every);
    return () => clearInterval(timer);
  }, [shown, session, working, ask, life, visible]);

  // A page read cut short by hiding Chat or moving on is not still loading.
  useEffect(() => { setPaging("idle"); }, [life]);

  const onRetry = useCallback(() => { commit(null); setAgain(n => n + 1); }, [commit]);

  // The stretch between the pages and a live window that moved on while the
  // first page was read. A newer answer that lands first reads its own.
  const fill = useCallback(async (id: string, signal: AbortSignal) => {
    const from = kept.current;
    const read = from?.read;
    if (!from || from.session !== id || read?.kind !== "ready" || !from.pages.length || read.older === from.joint) return;
    const joint = from.joint;
    // A live window that starts at the file's start is another file: withRead starts again.
    const parts = read.older && joint ? await readGap(id, signal, read.older, joint) : null;
    const now = kept.current;
    if (signal.aborted || !now || now.read !== read || now.joint !== joint) return;
    commit(withRead(now, id, now.provider, read, { joint, parts }));
  }, [readGap, commit]);

  // The window before the oldest one held, put in front of it.
  // The life of the page read in flight: one at a time, and one cut short does not block the next.
  const paged = useRef<AbortSignal | null>(null);
  const loadOlder = useCallback(() => {
    const from = kept.current;
    if ((paged.current && !paged.current.aborted) || !from || from.read.kind !== "ready") return;
    const cursor = from.pages.length ? from.pages[0].older : from.read.older;
    if (!cursor) return;
    const signal = life.signal;
    paged.current = signal;
    setPaging("loading");
    const { session: id, provider: who } = from;
    void readTranscript(id, dep.current.fetchFn, signal, who, { before: cursor }).then(read => {
      if (paged.current === signal) paged.current = null;
      if (signal.aborted) return;
      const now = kept.current;
      // It goes in front of the oldest page it was asked before; a first page
      // goes in front of the live window even when that moved on meanwhile, and
      // the stretch between is read next.
      const fits = now?.read.kind === "ready" && (now.pages.length ? now.pages[0].older === cursor : true);
      if (read.kind !== "ready" || !now || now.session !== id || now.provider !== who || !fits) {
        setPaging(read.kind === "ready" ? "idle" : "failed");
        return;
      }
      const first = !now.pages.length;
      // Not capped here: the oldest page is the one just asked for. Nothing more
      // is offered once the whole reaches MAX_KEPT_TURNS, so it passes by one page at most.
      commit({ ...now, pages: [pageOf(read), ...now.pages], joint: first ? cursor : now.joint, front: now.front + read.turns.length });
      setPaging("idle");
      if (first) void fill(id, signal);
    });
  }, [fill, commit, life]);

  return useMemo<ChatSource>(() => {
    if (!held || held.session !== session || held.provider !== provider) return { state: "loading" };
    const read = held.read;
    if (read.kind === "unknown") return { state: "error", message: t(ended ? "board.chat.unavailable" : "board.chat.notYet") };
    if (read.kind === "failed") return { state: "error", message: t("board.chat.failed"), onRetry };
    const turns: ChatTurn[] = held.pages.length ? [...held.pages.flatMap(part => part.turns), ...read.turns] : read.turns;
    const oldest = held.pages[0] ?? read;
    const head = held.front ? { head: held.front } : {};
    if (oldest.older && turns.length < MAX_KEPT_TURNS) {
      return { state: "ready", turns, older: { load: loadOlder, loading: paging === "loading", failed: paging === "failed" }, ...head };
    }
    return { state: "ready", turns: oldest.complete ? turns : [{ kind: "record", text: t("board.chat.earlier") }, ...turns], ...head };
  }, [held, session, provider, ended, t, onRetry, loadOlder, paging]);
}
