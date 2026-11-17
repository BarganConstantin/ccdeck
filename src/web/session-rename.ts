// Naming a session in the deck (internal #101).
//
// Saving asks the provider to rename its actual conversation, then persists
// the deck's display override. Clearing removes only the deck override.
// A provider refusal leaves the name unchanged and reports a failed save.
//
// Kept out of React, so the rules the field follows (what a press saves, which
// key does what) are tested in a plain node environment, and so the field's
// keys are named here rather than in a component.
import type { AgentNodeData } from "./types";
import { sessionListName } from "./session-display";

/** The longest name kept, in characters: the server cuts there too
 *  (session-deck-names.mjs DECK_NAME_MAX). */
export const SESSION_NAME_MAX = 120;

/** What the field needs about the session it renames, read once when it opens:
 *  a field whose session changes under it saves to the one it was opened on. */
export interface RenameFacts {
  provider: "claude" | "codex";
  sessionId: string;
  /** The name drawn now: what the field opens holding. */
  current: string;
  /** The name drawn without the deck's: what a reset gives back. */
  fallback: string;
  /** The deck holds a name for it, so there is one to reset. */
  deckNamed: boolean;
}

type Renameable = Pick<AgentNodeData,
  "kind" | "sessionId" | "provider" | "deckName" | "providerSessionName" | "sessionName" | "sessionTitle" | "label" | "cwdBasename">;

/** The facts for a session the deck can name: a root with an id. A subagent is
 *  named by its task, and is left alone. */
export function renameFacts(a: Renameable | null | undefined): RenameFacts | null {
  if (!a || a.kind !== "root" || typeof a.sessionId !== "string" || !a.sessionId) return null;
  const fallback = sessionListName({
    sessionName: a.providerSessionName ?? (a.deckName ? undefined : a.sessionName),
    sessionTitle: a.sessionTitle,
    label: a.label,
    cwdBasename: a.cwdBasename,
  }) ?? "";
  return {
    provider: a.provider === "codex" ? "codex" : "claude",
    sessionId: a.sessionId,
    current: sessionListName(a) ?? "",
    fallback,
    deckNamed: typeof a.deckName === "string" && a.deckName.trim() !== "",
  };
}

/** One line, its runs of space made one, cut to SESSION_NAME_MAX characters:
 *  the server's own cleaning, so what the field shows is what is kept. */
export function cleanTyped(typed: string): string {
  const one = typed.replace(/\s+/g, " ").trim();
  return Array.from(one).slice(0, SESSION_NAME_MAX).join("");
}

/** What a save of `typed` asks the deck for: nothing, when it would change
 *  nothing; a name; or null, to clear the deck's name. An empty field clears
 *  it, and so does the default name typed back, which then keeps following
 *  the provider. */
export type SaveAsk = { kind: "none" } | { kind: "save"; name: string | null };

export function saveAsk(typed: string, facts: RenameFacts): SaveAsk {
  const name = cleanTyped(typed);
  if (!name || name === facts.fallback) return facts.deckNamed ? { kind: "save", name: null } : { kind: "none" };
  if (name === facts.current) return { kind: "none" };
  return { kind: "save", name };
}

/** What a key pressed in the field does: Enter saves, Escape puts the name back
 *  as it was. Anything else is typing. A key pressed mid-composition (an IME
 *  choosing a word) is the composition's. */
export function nameFieldKey(e: { key: string; isComposing?: boolean }): "save" | "cancel" | null {
  if (e.isComposing) return null;
  if (e.key === "Enter") return "save";
  if (e.key === "Escape") return "cancel";
  return null;
}

/** Whether F2 on a focused row starts renaming it, as it does on a file in a
 *  file manager. No modifier: F2 with one is somebody else's. */
export function isRenameKey(e: { key: string; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }): boolean {
  return e.key === "F2" && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
}

export type SaveResult = { ok: true; name: string | null } | { ok: false };

/** Asks the deck to keep `name` for the session (null clears it). The deck
 *  announces it to every page itself, this one included; the answer only says
 *  whether it was kept. Never throws: a failure is `{ ok: false }`, and the
 *  field keeps what was typed. */
export async function saveSessionName(
  facts: Pick<RenameFacts, "provider" | "sessionId">,
  name: string | null,
  send: typeof fetch = fetch,
): Promise<SaveResult> {
  try {
    const res = await send("/api/session-name", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: facts.provider, sessionId: facts.sessionId, name, syncProvider: true }),
    });
    const body = await res.json().catch(() => null) as { ok?: unknown; name?: unknown } | null;
    if (!res.ok || !body || body.ok !== true) return { ok: false };
    return { ok: true, name: typeof body.name === "string" ? body.name : null };
  } catch {
    return { ok: false };
  }
}
