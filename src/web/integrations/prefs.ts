// What an integration panel remembers between reloads, per browser (#2178):
// for each kind, which connection the panel shows; for each connection, the
// panel's own view — the board on show, the filters that were on, which groups
// were open — under keys the panel chooses.
//
// View choices, like the usage panel's period and the accounts panel's order
// (accounts-prefs.ts), so they live in localStorage through storage.ts — which
// survives a browser that blocks site data — and are checked rather than cast
// when read back, because the stored string is whatever was in the store.
// One stored object per connection, `agent-dag.integrations.prefs.<kind>:<id>`,
// removed when the connection is.

import { readStored, removeStored, writeStored } from "../storage";
import type { IntegrationPrefs } from "./types";

const ACTIVE_KEY = "agent-dag.integrations.active";
const prefsKey = (kind: string, connId: string) => `agent-dag.integrations.prefs.${kind}:${connId}`;
/** A bound on one connection's stored view, so a panel cannot grow it without
 *  limit: a few hundred group and filter choices fit easily. */
const MAX_BYTES = 32_000;

function readAll(kind: string, connId: string): Record<string, unknown> {
  const raw = readStored(prefsKey(kind, connId));
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** The panel's `prefs` for one connection. */
export function connectionPrefs(kind: string, connId: string): IntegrationPrefs {
  return {
    read<T>(key: string, check: (value: unknown) => value is T): T | undefined {
      const value = readAll(kind, connId)[key];
      return check(value) ? value : undefined;
    },
    write(key: string, value: unknown) {
      const all = readAll(kind, connId);
      if (value === undefined) delete all[key]; else all[key] = value;
      const text = JSON.stringify(all);
      if (text.length <= MAX_BYTES) writeStored(prefsKey(kind, connId), text);
    },
  };
}

/** Forget a removed connection's view. */
export function clearConnectionPrefs(kind: string, connId: string): void {
  removeStored(prefsKey(kind, connId));
}

/** Which connection a kind's panel showed last. */
export function loadActiveConnection(kind: string): string | null {
  const raw = readStored(ACTIVE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const id = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>)[kind] : null;
    return typeof id === "string" && id.length <= 80 ? id : null;
  } catch {
    return null;
  }
}

export function saveActiveConnection(kind: string, connId: string): void {
  let parsed: Record<string, string> = {};
  try {
    const raw = readStored(ACTIVE_KEY);
    const value = raw ? JSON.parse(raw) : {};
    if (value && typeof value === "object" && !Array.isArray(value)) {
      parsed = Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === "string").slice(0, 20)) as Record<string, string>;
    }
  } catch { /* start over */ }
  parsed[kind] = connId;
  writeStored(ACTIVE_KEY, JSON.stringify(parsed));
}
