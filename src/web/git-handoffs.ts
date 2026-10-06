// The git view's hand-offs as the page holds them: which git client, editor
// and terminal the deck's machine has (GET /api/git/handoffs), whether this
// page is on that machine, and the two things the page asks for — opening one
// of them on a session's folder (POST /api/git/open) and picking which one a
// slot opens (the deck's prefs, `gitApps`).
//
// One answer for the whole page, kept outside React the way git-pref.ts keeps
// the switch, so every glance, the wide view's header and Appearance read the
// same thing from one request. Asked for the first time something wants it,
// and again when Appearance opens, because an app installed since then should
// turn up there.
import { useEffect, useSyncExternalStore } from "react";
import { useGitOn } from "./git-pref";

export type HandoffSlot = "git" | "editor" | "terminal";
export const HANDOFF_SLOTS: HandoffSlot[] = ["git", "editor", "terminal"];

export interface HandoffApp { id: string; name: string }
export interface HandoffSlotState { apps: HandoffApp[]; chosen: string | null }

export interface Handoffs {
  /** `ready` once the server has answered; `off` while Git is switched off. */
  state: "idle" | "loading" | "ready" | "off" | "error";
  /** Whether this page is on the deck's own machine. False until known, so a
   *  page viewed from elsewhere never draws a launch button even for a frame. */
  local: boolean;
  /** The deck's machine, for the sentence that says why the buttons are gone. */
  machine: string;
  slots: Record<HandoffSlot, HandoffSlotState>;
}

const EMPTY: Record<HandoffSlot, HandoffSlotState> = {
  git: { apps: [], chosen: null },
  editor: { apps: [], chosen: null },
  terminal: { apps: [], chosen: null },
};

let snap: Handoffs = { state: "idle", local: false, machine: "", slots: EMPTY };
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function set(next: Handoffs): void {
  snap = next;
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const read = () => snap;

/** Coerce the server's slots into the page's shape, dropping anything odd. */
function slotsOf(raw: unknown): Record<HandoffSlot, HandoffSlotState> {
  const src = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const out = { ...EMPTY };
  for (const slot of HANDOFF_SLOTS) {
    const s = src[slot] as { apps?: unknown; chosen?: unknown } | undefined;
    const apps = Array.isArray(s?.apps)
      ? (s.apps as unknown[]).filter((a): a is HandoffApp =>
        !!a && typeof (a as HandoffApp).id === "string" && typeof (a as HandoffApp).name === "string")
      : [];
    const chosen = typeof s?.chosen === "string" && apps.some(a => a.id === s.chosen) ? s.chosen : (apps[0]?.id ?? null);
    out[slot] = { apps, chosen };
  }
  return out;
}

/** Ask the server, unless an answer is on its way; `again` asks even when one
 *  is already here, and `fresh` has the server look at the machine again
 *  rather than answer from its last look. Never rejects. */
export function loadHandoffs(again = false, fresh = false): Promise<void> {
  if (inflight) return inflight;
  if (!again && (snap.state === "ready" || snap.state === "off")) return Promise.resolve();
  if (snap.state === "idle" || snap.state === "error") set({ ...snap, state: "loading" });
  inflight = fetch(fresh ? "/api/git/handoffs?fresh=1" : "/api/git/handoffs")
    .then(async r => {
      if (r.status === 409) { set({ state: "off", local: false, machine: "", slots: EMPTY }); return; }
      const d = r.ok ? await r.json() : null;
      if (!d?.ok) { set({ ...snap, state: "error", local: false }); return; }
      set({ state: "ready", local: d.local === true, machine: typeof d.machine === "string" ? d.machine : "", slots: slotsOf(d.slots) });
    })
    .catch(() => { set({ ...snap, state: "error", local: false }); })
    .finally(() => { inflight = null; });
  return inflight;
}

/** The hand-offs now, outside React. */
export const handoffsNow = read;

/** The hand-offs, asked for on first use, re-rendering the caller as they change. */
export function useHandoffs(): Handoffs {
  const value = useSyncExternalStore(subscribe, read, read);
  // Asked again when Git is switched back on: the last answer was "off".
  const gitOn = useGitOn();
  useEffect(() => { if (gitOn) void loadHandoffs(snap.state === "off"); }, [gitOn]);
  return value;
}

/** What the server said about a launch. */
export interface OpenResult { ok: boolean; app?: HandoffApp; error?: string }

/**
 * Open a slot's app on a session's folder — and, for the editor, one file in
 * its repository, as git names it. The server finds the folder and the app;
 * the page only names the session and the slot.
 */
export async function openHandoff(
  { sessionId, agentId = null, slot, file = null }: { sessionId: string; agentId?: string | null; slot: HandoffSlot; file?: string | null },
): Promise<OpenResult> {
  try {
    const r = await fetch("/api/git/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: sessionId, slot, ...(agentId ? { agent: agentId } : {}), ...(file ? { file } : {}) }),
    });
    const d = await r.json().catch(() => null);
    if (r.ok && d?.ok) return { ok: true, app: d.app };
    // A refusal for not being on this machine means the page's own idea of
    // that was wrong; asking again hides the buttons it should not have drawn.
    if (r.status === 403) void loadHandoffs(true);
    return { ok: false, error: typeof d?.error === "string" ? d.error : "The deck could not open it." };
  } catch {
    return { ok: false, error: "The deck did not answer." };
  }
}

/** Appearance's pick for a slot: shown at once, written to the deck's prefs,
 *  and settled by the server's next answer. */
export function pickHandoff(slot: HandoffSlot, id: string): void {
  const cur = snap.slots[slot];
  if (!cur.apps.some(a => a.id === id)) return;
  set({ ...snap, slots: { ...snap.slots, [slot]: { ...cur, chosen: id } } });
  fetch("/api/prefs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ gitApps: { [slot]: id } }),
  }).then(() => loadHandoffs(true)).catch(() => {});
}
