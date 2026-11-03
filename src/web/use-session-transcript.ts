// What Chat reads: one Claude session's conversation, from the deck's read-only
// transcript route (src/server/session-transcript-routes.mjs).
//
// ASKS ONLY WHILE SHOWN. Nothing is fetched while the Chat view is not on
// screen. When it is, the hook asks at once, then every POLL_MS while the page
// is visible and the session is working, and it rests otherwise; one more ask
// follows when the session's prompt count or its end changes (`change`), since
// that is when a quiet session's conversation has moved.
//
// IMPORTS NO SCREEN. It answers with `ChatSource`, a type, and the words that
// belong to the answer are chosen when drawn (`useT`), so a language change
// reaches a message already on screen.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatSource, ChatTurn } from "./components/chat/chat-model";
import { useT } from "./i18n";

/** How often a working session's conversation is asked for again. */
export const POLL_MS = 5000;

export const TRANSCRIPT_ROUTE = "/api/session/transcript";

/** The shape the route accepts for a session id (the server's own test, spelled again). */
export const TRANSCRIPT_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** The Claude session id Chat can show, or null: the flag is effective, the
 *  session is Claude's (a Codex session has no transcript the deck reads) and
 *  its id has the shape the route takes. */
export function chatSessionFor(chatFlag: boolean, ref: { sessionId: string; provider: string } | null): string | null {
  if (!chatFlag || !ref || ref.provider !== "claude") return null;
  return TRANSCRIPT_SESSION_ID.test(ref.sessionId) ? ref.sessionId : null;
}

/** What one ask came to: the turns, that the session has none the deck can read yet, or a failure. */
export type TranscriptRead =
  | { kind: "ready"; complete: boolean; turns: ChatTurn[] }
  | { kind: "unknown" }
  | { kind: "failed" };

export async function readTranscript(
  session: string,
  fetchFn: (input: string, init?: RequestInit) => Promise<Response> = (input, init) => fetch(input, init),
  signal?: AbortSignal,
): Promise<TranscriptRead> {
  try {
    const res = await fetchFn(`${TRANSCRIPT_ROUTE}?session=${encodeURIComponent(session)}`, { cache: "no-store", signal });
    if (res.status === 404) return { kind: "unknown" };
    if (!res.ok) return { kind: "failed" };
    const body = await res.json() as { ok?: unknown; complete?: unknown; turns?: unknown };
    if (body.ok !== true || !Array.isArray(body.turns)) return { kind: "failed" };
    return { kind: "ready", complete: body.complete !== false, turns: body.turns as ChatTurn[] };
  } catch {
    return { kind: "failed" };
  }
}

export interface SessionTranscriptInput {
  /** The Claude session id, or null when this pane has no conversation to show. */
  session: string | null;
  /** The Chat view is on screen. */
  shown: boolean;
  /** The session is working: only then is it asked again on a timer. */
  working: boolean;
  /** The session has ended: a deck that no longer knows it cannot say more. */
  ended?: boolean;
  /** Changes when the session's prompt count or its status does (working,
   *  waiting, done, ended): one more ask, which is what catches the last reply
   *  and the question a session stops on. */
  change?: string | number;
}

export interface SessionTranscriptDeps {
  fetchFn?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Whether the page is visible; the suite's seam. */
  visible?: () => boolean;
  pollMs?: number;
}

type Held = { session: string; read: TranscriptRead } | null;

export function useSessionTranscript(input: SessionTranscriptInput, deps: SessionTranscriptDeps = {}): ChatSource {
  const t = useT();
  const { session, shown, working, change, ended } = input;
  const [held, setHeld] = useState<Held>(null);
  const [again, setAgain] = useState(0);
  const dep = useRef(deps);
  dep.current = deps;
  // Only the newest ask may answer: a slower, older one landing last is dropped.
  const latest = useRef(0);

  // One ask: the answer is kept only if it is still the one wanted.
  const ask = useCallback((id: string, signal: AbortSignal) => {
    const mine = ++latest.current;
    readTranscript(id, dep.current.fetchFn, signal).then(read => {
      if (!signal.aborted && mine === latest.current) setHeld({ session: id, read });
    });
  }, []);

  // On show, on a new session, on a change of prompts or end, and on Retry.
  useEffect(() => {
    if (!shown || !session) return;
    const abort = new AbortController();
    ask(session, abort.signal);
    return () => abort.abort();
  }, [shown, session, change, again, ask]);

  // Again on a timer, while the session is working and the page is looked at.
  useEffect(() => {
    if (!shown || !session || !working) return;
    const abort = new AbortController();
    const visible = () => (dep.current.visible ?? (() => typeof document === "undefined" || document.visibilityState === "visible"))();
    const timer = setInterval(() => { if (visible()) ask(session, abort.signal); }, dep.current.pollMs ?? POLL_MS);
    return () => { clearInterval(timer); abort.abort(); };
  }, [shown, session, working, ask]);

  const onRetry = useCallback(() => { setHeld(null); setAgain(n => n + 1); }, []);

  return useMemo<ChatSource>(() => {
    if (!held || held.session !== session) return { state: "loading" };
    const read = held.read;
    if (read.kind === "unknown") return { state: "error", message: t(ended ? "board.chat.unavailable" : "board.chat.notYet") };
    if (read.kind === "failed") return { state: "error", message: t("board.chat.failed"), onRetry };
    const turns: ChatTurn[] = read.complete ? read.turns : [{ kind: "record", text: t("board.chat.earlier") }, ...read.turns];
    return { state: "ready", turns };
  }, [held, session, ended, t, onRetry]);
}
