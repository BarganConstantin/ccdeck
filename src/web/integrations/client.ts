// The page's half of the deck's connections to trackers (#2178): what a
// connection is, the calls that list, add, edit, test and remove one, and the
// one shared copy of the list every surface reads — the rail, Settings and the
// panels — so a connection added in Settings puts its rail button up at once.
//
// The page never holds a token. A connection says only whether one is saved
// (`tokenSaved`); the form sends a new one and forgets it, and every read of a
// tracker goes through the deck (/api/integrations/<kind>/<id>/…), which signs.

import { useEffect, useState } from "react";
import type { IntegrationConnection, IntegrationErrorKind, IntegrationKind } from "./types";

type Connection = IntegrationConnection;

export interface ProviderInfo {
  kind: IntegrationKind;
  label: string;
}

/** A failure, as the envelope every integration route answers with says it:
 *  `{ ok: false, error: { kind, message, status?, retryAfter? } }`. */
export class IntegrationFailure extends Error {
  kind: IntegrationErrorKind;
  /** The tracker's own HTTP status, when it answered one. */
  status?: number;
  retryAfter?: number;
  field?: string;
  detail?: string;
  constructor(kind: IntegrationErrorKind, message: string, extra: { status?: number; retryAfter?: number; field?: string; detail?: string } = {}) {
    super(message);
    this.name = "IntegrationFailure";
    this.kind = kind;
    Object.assign(this, extra);
  }
}

/** The error an answer carries, or one for an answer that carried none. */
export async function failureOf(res: Response): Promise<IntegrationFailure> {
  try {
    const body = await res.json();
    const e = body?.error;
    if (e && typeof e.kind === "string" && typeof e.message === "string") {
      return new IntegrationFailure(e.kind, e.message, { status: e.status, retryAfter: e.retryAfter, field: e.field, detail: e.detail });
    }
  } catch { /* not JSON */ }
  return new IntegrationFailure(res.status === 401 ? "auth" : "upstream", `The deck answered ${res.status}.`);
}

/** One call to the deck's integration routes, as JSON. */
export async function integrationCall<T>(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const { timeoutMs = 30_000, ...rest } = init;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  const outer = rest.signal;
  const stop = () => controller.abort();
  outer?.addEventListener("abort", stop, { once: true });
  let res: Response;
  try {
    res = await fetch(path, {
      ...rest,
      signal: controller.signal,
      headers: rest.body ? { "Content-Type": "application/json", ...(rest.headers ?? {}) } : rest.headers,
    });
  } catch (err) {
    if (outer?.aborted) throw err;
    throw new IntegrationFailure("network", controller.signal.aborted ? "The deck took too long to answer." : "The deck could not be reached.");
  } finally {
    window.clearTimeout(timer);
    outer?.removeEventListener("abort", stop);
  }
  if (!res.ok) throw await failureOf(res);
  return res.json() as Promise<T>;
}

/** Where one connection's reads live: /api/integrations/<kind>/<id>/. */
export const connectionPrefix = (conn: Pick<Connection, "kind" | "id">) =>
  `/api/integrations/${encodeURIComponent(conn.kind)}/${encodeURIComponent(conn.id)}/`;

/** The panel's `api`: a request under the connection's prefix, as a Response. */
export function connectionApi(conn: Pick<Connection, "kind" | "id">) {
  const prefix = connectionPrefix(conn);
  return (path: string, init?: RequestInit) => fetch(`${prefix}${path.replace(/^\/+/, "")}`, init);
}

/** The panel's `assetUrl`: an image through the deck's asset route. */
export function connectionAssetUrl(conn: Pick<Connection, "kind" | "id">) {
  const prefix = connectionPrefix(conn);
  return (url: string) => `${prefix}asset?url=${encodeURIComponent(url)}`;
}

/** A query string from a panel's parameters: unset, empty and false left out,
 *  true as "1". */
export function queryOf(params: Record<string, string | number | boolean | undefined>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "" || value === false) continue;
    q.set(key, value === true ? "1" : String(value));
  }
  const query = q.toString();
  return query ? `?${query}` : "";
}

/** One JSON read through a panel's `api`, with a deadline, as data or an
 *  IntegrationFailure. An abort by the caller is rethrown as it came. */
export async function readThrough<T>(api: (path: string, init?: RequestInit) => Promise<Response>, path: string, { signal, timeoutMs = 45_000 }: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  const stop = () => controller.abort();
  signal?.addEventListener("abort", stop, { once: true });
  let res: Response;
  try {
    res = await api(path, { signal: controller.signal, headers: { Accept: "application/json" } });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new IntegrationFailure("network", controller.signal.aborted ? "The deck took too long to answer." : "The deck could not be reached.");
  } finally {
    window.clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  }
  if (!res.ok) throw await failureOf(res);
  try { return await res.json() as T; }
  catch { throw new IntegrationFailure("upstream", "The deck answered with something that is not JSON."); }
}

// ── the shared list ─────────────────────────────────────────────────────────

export interface IntegrationsState {
  /** null until the first read answers. */
  connections: Connection[] | null;
  providers: ProviderInfo[];
  error: string;
}

let snapshot: IntegrationsState = { connections: null, providers: [], error: "" };
const listeners = new Set<(state: IntegrationsState) => void>();
let poll: number | null = null;
let reading: Promise<void> | null = null;

function publish(patch: Partial<IntegrationsState>) {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach(listener => listener(snapshot));
}

/** Read the list again. Concurrent asks share one read. */
export function refreshIntegrations(): Promise<void> {
  if (reading) return reading;
  reading = (async () => {
    try {
      const body = await integrationCall<{ connections: Connection[]; providers: ProviderInfo[] }>("/api/integrations", { timeoutMs: 10_000 });
      publish({ connections: Array.isArray(body.connections) ? body.connections : [], providers: Array.isArray(body.providers) ? body.providers : [], error: "" });
    } catch (err) {
      publish({ error: err instanceof Error ? err.message : "Could not read the connections." });
    } finally {
      reading = null;
    }
  })();
  return reading;
}

/** Put one connection in the shared list as the deck just answered it. */
export function adoptConnection(conn: Connection) {
  const list = snapshot.connections ?? [];
  const at = list.findIndex(c => c.id === conn.id);
  publish({ connections: at < 0 ? [...list, conn] : list.map(c => (c.id === conn.id ? conn : c)) });
}

export function dropConnection(id: string) {
  publish({ connections: (snapshot.connections ?? []).filter(c => c.id !== id) });
}

/** The list, kept fresh: read on mount, every minute while anything shows it,
 *  and when the window comes back into view. */
export function useIntegrations(): IntegrationsState {
  const [state, setState] = useState(snapshot);
  useEffect(() => {
    listeners.add(setState);
    setState(snapshot);
    const onVisible = () => { if (document.visibilityState === "visible") void refreshIntegrations(); };
    if (listeners.size === 1) {
      void refreshIntegrations();
      poll = window.setInterval(() => void refreshIntegrations(), 60_000);
      document.addEventListener("visibilitychange", onVisible);
    }
    return () => {
      listeners.delete(setState);
      if (listeners.size === 0) {
        if (poll !== null) window.clearInterval(poll);
        poll = null;
        document.removeEventListener("visibilitychange", onVisible);
      }
    };
  }, []);
  return state;
}

/** The connections of one kind, in the order they were made. */
export function connectionsOf(state: IntegrationsState, kind: IntegrationKind): Connection[] {
  return (state.connections ?? []).filter(c => c.kind === kind);
}

// ── changes ─────────────────────────────────────────────────────────────────

export async function createConnection(kind: IntegrationKind, input: Record<string, string>, name?: string): Promise<Connection> {
  const body = await integrationCall<{ connection: Connection }>("/api/integrations/connections", {
    method: "POST", body: JSON.stringify({ kind, name, input }), timeoutMs: 60_000,
  });
  adoptConnection(body.connection);
  return body.connection;
}

export async function updateConnection(id: string, patch: { name?: string; input?: Record<string, string> }): Promise<{ connection: Connection; validated: boolean }> {
  const body = await integrationCall<{ connection: Connection; validated: boolean }>(`/api/integrations/connections/${encodeURIComponent(id)}`, {
    method: "PATCH", body: JSON.stringify(patch), timeoutMs: 60_000,
  });
  adoptConnection(body.connection);
  return body;
}

export async function testConnection(id: string): Promise<Connection> {
  const body = await integrationCall<{ connection: Connection }>(`/api/integrations/connections/${encodeURIComponent(id)}/test`, {
    method: "POST", body: "{}", timeoutMs: 60_000,
  });
  adoptConnection(body.connection);
  return body.connection;
}

export async function deleteConnection(id: string): Promise<void> {
  await integrationCall(`/api/integrations/connections/${encodeURIComponent(id)}`, { method: "DELETE" });
  dropConnection(id);
}

/** A host to show for a connection: "jira.example.com". */
export function connectionHost(conn: Pick<Connection, "baseUrl">): string {
  try { return new URL(conn.baseUrl).host; } catch { return conn.baseUrl; }
}

/** Initials for an avatar that did not load: "Jane Doe" → "JD". */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  return (words.length === 1 ? words[0].slice(0, 2) : `${words[0][0]}${words[words.length - 1][0]}`).toUpperCase();
}

// ── the way back from a refused token ───────────────────────────────────────

/** The connection Settings → Integrations should open at, set by a panel's
 *  Reconnect just before it opens Settings, and taken once. */
let focusRequest: string | null = null;

export function requestIntegrationFocus(connId: string) {
  focusRequest = connId;
}

export function takeIntegrationFocus(): string | null {
  const id = focusRequest;
  focusRequest = null;
  return id;
}
