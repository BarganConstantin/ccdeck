// Chat or Term, per session: which of the two a pane shows a session in, kept
// so the pane opens it again the way it was left; the way an alert, a
// notification or a key asks a pane to show a session in Chat; and which
// sessions a pane shows in Chat right now, which the alert stack does not
// raise a card for (the Decision card is already in front of the reader).
//
// THE MEMORY IS A SHORT LIST of the sessions last shown, each with the view
// it was left in, newest last and capped. A session not on it opens in
// whatever the pane shows already. Kept through storage.ts, so a blocked store
// costs the memory and nothing else.
import { readStored, writeStored } from "./storage";

export type PaneView = "chat" | "term";
/** One session's entry: its id and the view it was left in. */
export type ChatViewEntry = readonly [string, PaneView];

/** The sessions last shown, as a JSON array of [id, "chat" | "term"]. */
export const CHAT_VIEWS_KEY = "agent-dag.paneViews";
/** How many sessions the memory keeps. */
export const MAX_CHAT_VIEWS = 40;

/** The list after `sessionId` was left in `view`: it moves to the end, and
 *  the oldest go past the cap. */
export function nextChatViews(list: readonly ChatViewEntry[], sessionId: string, view: PaneView, max = MAX_CHAT_VIEWS): ChatViewEntry[] {
  return [...list.filter(([id]) => id !== sessionId), [sessionId, view] as const].slice(-max);
}

/** The stored list, or none: entries that are not [id, view] are dropped. */
export function parseChatViews(raw: string | null): ChatViewEntry[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((e): e is [string, PaneView] => Array.isArray(e) && e.length === 2
      && typeof e[0] === "string" && e[0].length > 0 && (e[1] === "chat" || e[1] === "term")).slice(-MAX_CHAT_VIEWS);
  } catch { return []; }
}

/** The view `sessionId` was left in, or null for a session not remembered. */
export function rememberedView(sessionId: string | null): PaneView | null {
  if (!sessionId) return null;
  return parseChatViews(readStored(CHAT_VIEWS_KEY)).find(([id]) => id === sessionId)?.[1] ?? null;
}

/** Keeps the view `sessionId` was left in. */
export function rememberView(sessionId: string | null, view: PaneView): void {
  if (!sessionId) return;
  const list = parseChatViews(readStored(CHAT_VIEWS_KEY));
  if (list.find(([id]) => id === sessionId)?.[1] === view) return;
  writeStored(CHAT_VIEWS_KEY, JSON.stringify(nextChatViews(list, sessionId, view)));
}

// ── asking a pane to show a session in Chat ─────────────────────────────────

type ChatAsk = (sessionId: string) => void;
const askers = new Set<ChatAsk>();

/** Every pane hears this; the one showing `sessionId` switches to Chat. The
 *  view is kept first, so a pane that opens the session after this call opens
 *  it in Chat as well. */
export function requestChatView(sessionId: string): void {
  rememberView(sessionId, "chat");
  for (const ask of [...askers]) ask(sessionId);
}

export function onChatViewRequest(ask: ChatAsk): () => void {
  askers.add(ask);
  return () => { askers.delete(ask); };
}

// ── the focused pane's toggle (the Chat | Term chord) ───────────────────────

const togglers = new Map<object, () => void>();

/** Pane `pane` says how its Chat | Term switch is turned, or that it has none
 *  (null). The pane that said so last, the focused one, is the one the chord
 *  reaches. */
export function setViewToggle(pane: object, toggle: (() => void) | null): void {
  togglers.delete(pane);
  if (toggle) togglers.set(pane, toggle);
}

/** Whether a pane would answer the chord. */
export function hasViewToggle(): boolean {
  return togglers.size > 0;
}

/** Turns the focused pane's switch; false when no pane has one. */
export function toggleFocusedView(): boolean {
  const last = [...togglers.values()].pop();
  if (!last) return false;
  last();
  return true;
}

// ── which sessions are in front of the reader in Chat ───────────────────────

const shown = new Map<object, string>();
const shownListeners = new Set<() => void>();
let shownKey = "";

/** Pane `pane` shows `sessionId` in Chat, or nothing (null). */
export function setShownInChat(pane: object, sessionId: string | null): void {
  if (sessionId) shown.set(pane, sessionId);
  else shown.delete(pane);
  const key = [...new Set(shown.values())].sort().join("|");
  if (key === shownKey) return;
  shownKey = key;
  for (const l of [...shownListeners]) l();
}

/** The sessions some pane shows in Chat, joined with "|" (a stable snapshot). */
export function shownInChatKey(): string {
  return shownKey;
}

export function onShownInChat(listener: () => void): () => void {
  shownListeners.add(listener);
  return () => { shownListeners.delete(listener); };
}

/** Tests: no pane, no request, no toggle. */
export function resetChatViews(): void {
  askers.clear();
  togglers.clear();
  shown.clear();
  shownKey = "";
  shownListeners.clear();
}
