// Settings › Claude Code's reading of the user's Claude Code settings, and the
// press that changes one (src/server/claude-settings.mjs). One store for the
// page, read while the section is open and every ten seconds after, the way
// Radar's switch is (use-radar-settings.ts).
//
// A SAVE IS CHECKED AGAIN A FEW SECONDS LATER. A running Claude Code session
// can write its own copy of settings.json shortly after the deck writes it,
// and that copy does not hold the deck's change. The second reading is what
// tells the reader, where the switch alone would have looked saved.
import { useEffect, useState } from "react";

export type ClaudeSettingValue = boolean | string | number | null;

export interface ClaudeSettingRow {
  id: string;
  value: ClaudeSettingValue;
  isSet: boolean;
  custom?: boolean;
  lockedBy?: "managed" | "organization";
  editable: boolean;
  reason?: string;
  /** A variable that outranks the row, where it is set, and what it makes of
   *  the row ("Off", "Updates are off"). */
  override?: { env: string; value: string; where: "managed" | "organization" | "user" | "environment"; effect: string };
}

/** The user's settings.json: read, not there yet (Claude Code is on its
 *  defaults), not JSON (Claude Code skips it), or not readable by the deck. */
export type ClaudeUserFile = "read" | "absent" | "invalid" | "unreadable";

export interface ClaudeSettingsReading {
  claudeVersion: string | null;
  file: string;
  /** `file` with the home directory written as ~. */
  fileShown: string;
  userFile: ClaudeUserFile;
  settings: ClaudeSettingRow[];
  /** Every top-level key of the user file, and what the page may see of its
   *  value: the value for a safe kind, otherwise "set". Null while the file
   *  cannot be read. */
  present: Record<string, string> | null;
}

export interface ClaudeSettingsState {
  reading: ClaudeSettingsReading | null;
  /** The row whose change is being saved. */
  saving: string | null;
  error: string;
  /** The row a running session wrote back over, and what to say about it. */
  undone: { id: string } | null;
}

/** How long after a save the deck reads the file again. Past the window in
 *  which a running session ignores outside changes to its own last write. */
export const RECHECK_MS = 6500;
const POLL_MS = 10_000;

let snapshot: ClaudeSettingsState = { reading: null, saving: null, error: "", undone: null };
const subscribers = new Set<(value: ClaudeSettingsState) => void>();
let poll: ReturnType<typeof setInterval> | null = null;
let recheck: ReturnType<typeof setTimeout> | null = null;
let request: AbortController | null = null;
let inFlight = false, revision = 0;
const publish = (patch: Partial<ClaudeSettingsState>) => { snapshot = { ...snapshot, ...patch }; subscribers.forEach(listener => listener(snapshot)); };

function valid(data: unknown): data is ClaudeSettingsReading & { ok: true } {
  const d = data as { ok?: unknown; settings?: unknown; present?: unknown } | null;
  return !!d && d.ok === true && Array.isArray(d.settings) && typeof d.present === "object";
}

async function read(signal: AbortSignal): Promise<ClaudeSettingsReading> {
  const res = await fetch("/api/claude-settings", { signal });
  const data = await res.json();
  if (!res.ok || !valid(data)) throw new Error();
  return data;
}

export async function refreshClaudeSettings() {
  if (inFlight || snapshot.saving) return;
  inFlight = true;
  const observed = revision, controller = new AbortController(); request = controller;
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 5000);
  try {
    const reading = await read(controller.signal);
    if (observed === revision && !controller.signal.aborted) publish({ reading, error: "" });
  } catch { if (observed === revision && (timedOut || !controller.signal.aborted)) publish({ error: "Could not read Claude Code settings. Try again." }); }
  finally { clearTimeout(timeout); inFlight = false; if (request === controller) request = null; }
}

/** The value a row reads as in a reading, or undefined without one. */
function rowValue(reading: ClaudeSettingsReading | null, id: string) {
  return reading?.settings.find(row => row.id === id)?.value;
}

export async function setClaudeSetting(id: string, value: ClaudeSettingValue) {
  if (snapshot.saving) return;
  revision++; request?.abort();
  if (recheck) { clearTimeout(recheck); recheck = null; }
  publish({ saving: id, error: "", undone: null });
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch("/api/claude-settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, value }), signal: controller.signal,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !valid(data)) throw new Error(typeof data?.error === "string" ? data.error : "Could not save the change. Try again.");
    publish({ reading: data });
    // What the save left the row reading, taken now: the ten-second reading
    // may land first and already hold the session's copy.
    const saved = rowValue(data, id);
    recheck = setTimeout(() => {
      recheck = null;
      const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 5000);
      read(controller.signal).then(reading => {
        publish({ reading, undone: rowValue(reading, id) === saved ? null : { id } });
      }).catch(() => {}).finally(() => clearTimeout(timeout));
    }, RECHECK_MS);
  } catch (error) {
    publish({ error: error instanceof Error && error.message ? error.message : "Could not save the change. Try again." });
  } finally { clearTimeout(timeout); publish({ saving: null }); }
}

export function useClaudeSettings() {
  const [value, setValue] = useState(snapshot);
  useEffect(() => {
    subscribers.add(setValue); setValue(snapshot);
    if (!poll) { void refreshClaudeSettings(); poll = setInterval(() => void refreshClaudeSettings(), POLL_MS); }
    return () => {
      subscribers.delete(setValue);
      if (!subscribers.size) { if (poll) clearInterval(poll); poll = null; request?.abort(); }
    };
  }, []);
  return value;
}
