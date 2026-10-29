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
  /** Whether this deck can connect and read the kind now. Only true offers
   *  it: a deck that cannot leaves the kind out of the list or says false,
   *  and an entry that does not say is not taken for an offer. */
  available?: boolean;
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
  return withReadDeadline(rest.signal, timeoutMs, async signal => {
    let res: Response;
    try {
      res = await fetch(path, {
        ...rest, signal,
        headers: rest.body ? { "Content-Type": "application/json", ...(rest.headers ?? {}) } : rest.headers,
      });
    } catch (err) {
      if (signal.aborted) throw err;
      throw new IntegrationFailure("network", "The deck could not be reached.");
    }
    if (!res.ok) throw await failureOf(res);
    return res.json() as Promise<T>;
  });
}

/** Fetch ends at headers; the deadline and parent cancellation must also
 * cover the body, including an error response's JSON. */
async function withReadDeadline<T>(outer: AbortSignal | null | undefined, timeoutMs: number, read: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  const stop = () => controller.abort(outer?.reason);
  outer?.addEventListener("abort", stop, { once: true });
  if (outer?.aborted) stop();
  try {
    controller.signal.throwIfAborted();
    return await read(controller.signal);
  } catch (err) {
    if (outer?.aborted) throw outer.reason ?? err;
    if (controller.signal.aborted) throw new IntegrationFailure("network", "The deck took too long to answer.");
    throw err;
  } finally {
    window.clearTimeout(timer);
    outer?.removeEventListener("abort", stop);
  }
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

/** A picture's own address, for the browser to ask when the deck could not
 *  read it: a self-managed GitLab whose public visibility is restricted gives
 *  an avatar to a signed-in browser and to no token. Only on the connection's
 *  own origin, the tracker the user connected, and nowhere else. */
export function trackerImageUrl(conn: Pick<Connection, "baseUrl">, url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.username || u.password || (u.protocol !== "https:" && u.protocol !== "http:")) return null;
    return u.origin === new URL(conn.baseUrl).origin ? u.href : null;
  } catch {
    return null;
  }
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
  return withReadDeadline(signal, timeoutMs, async inner => {
    let res: Response;
    try { res = await api(path, { signal: inner, headers: { Accept: "application/json" } }); }
    catch (err) {
      if (inner.aborted) throw err;
      throw new IntegrationFailure("network", "The deck could not be reached.");
    }
    if (!res.ok) throw await failureOf(res);
    try { return await res.json() as T; }
    catch (err) {
      if (inner.aborted) throw err;
      throw new IntegrationFailure("upstream", "The deck answered with something that is not JSON.");
    }
  });
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
/** A failed first read's next try, and how many it has had (three at most). */
let retry: number | null = null;
let retries = 0;
const RETRY_FIRST_MS = 5_000;
const RETRIES = 3;

function publish(patch: Partial<IntegrationsState>) {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach(listener => listener(snapshot));
}

/** Read the list again. Concurrent asks share one read. */
export function refreshIntegrations(): Promise<void> {
  if (reading) return reading;
  reading = (async () => {
    try {
      const body = await integrationCall<{ connections?: unknown; providers?: unknown } | null>("/api/integrations", { timeoutMs: 10_000 });
      const connections = body?.connections;
      const providers = body?.providers;
      // An answer that is not the list, a field of it missing or not a list,
      // says nothing of what the deck offers: a failed read, like a 500.
      if (!Array.isArray(connections) || !Array.isArray(providers)) {
        throw new IntegrationFailure("upstream", "The deck answered with something that is not the list of connections.");
      }
      publish({ connections: connections as Connection[], providers: providers as ProviderInfo[], error: "" });
    } catch (err) {
      publish({ error: err instanceof Error ? err.message : "Could not read the connections." });
      // A first read that failed (the deck restarting, say) is tried again
      // after 5, 10 and 20 s, before the minute's read takes over.
      if (snapshot.connections === null && listeners.size > 0 && retry === null && retries < RETRIES) {
        retry = window.setTimeout(() => { retry = null; void refreshIntegrations(); }, RETRY_FIRST_MS * 2 ** retries++);
      }
    } finally {
      reading = null;
    }
  })();
  return reading;
}

/** Whether a later read of the list could change what the page draws: the
 *  deck has not answered it yet, or it reports a provider (available or
 *  not) or holds a connection (a stranded one too, so its row stays right).
 *  What the deck answers decides, never which product it is. */
function worthReadingAgain(state: IntegrationsState): boolean {
  return state.connections === null || state.providers.length > 0 || state.connections.length > 0;
}

/** A read on the minute, or on the tab's return: only where it is worth it. */
function refreshIfWorthIt() {
  if (worthReadingAgain(snapshot)) void refreshIntegrations();
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

/** The list, kept fresh: read on mount, then every minute while anything
 *  shows it and when the window comes back into view, where the deck reports
 *  something a read could change (worthReadingAgain). A deck that reports no
 *  provider and holds no connection, as the free deck does, is read once. */
export function useIntegrations(): IntegrationsState {
  const [state, setState] = useState(snapshot);
  useEffect(() => {
    listeners.add(setState);
    setState(snapshot);
    const onVisible = () => { if (document.visibilityState === "visible") refreshIfWorthIt(); };
    if (listeners.size === 1) {
      void refreshIntegrations();
      poll = window.setInterval(refreshIfWorthIt, 60_000);
      document.addEventListener("visibilitychange", onVisible);
    }
    return () => {
      listeners.delete(setState);
      if (listeners.size === 0) {
        if (poll !== null) window.clearInterval(poll);
        poll = null;
        if (retry !== null) window.clearTimeout(retry);
        retry = null;
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

// ── what this deck offers ───────────────────────────────────────────────────
//
// A deck offers only the kinds it can read. One that offers none draws no
// integrations: no Settings section, no rail control, no I, no row in
// Keyboard help or in Settings search, as a deck without them always drew. A
// connection of a kind it does not offer is stranded: Settings still lists
// it, with the one thing that works without a provider, Disconnect, which
// deletes it and its saved token. A kind is offered only once the deck has
// said so: until a read of the list answers — the first still on its way, or
// failed (the deck's 500, or no answer while it restarts) — nothing is
// offered and nothing is drawn, so a deck that offers no kind never shows
// one, not even until the next read.

/** The kinds this deck can connect and read: none until it has answered the
 *  list. */
export function offeredKinds(state: IntegrationsState): ReadonlySet<IntegrationKind> {
  if (state.connections === null) return new Set();
  return new Set(state.providers.filter(p => p?.available === true).map(p => p.kind));
}

/** Whether the deck offers a kind: false until it has answered the list. */
export function kindOffered(state: IntegrationsState, kind: IntegrationKind): boolean {
  return offeredKinds(state).has(kind);
}

/** Whether a kind's rail control, its key and its panel are up: the deck
 *  offers it and holds a connection of it. */
export function kindOpenable(state: IntegrationsState, kind: IntegrationKind): boolean {
  return kindOffered(state, kind) && connectionsOf(state, kind).length > 0;
}

/** How much of Settings › Integrations a deck draws: all of it while a kind is
 *  offered, only the stranded connections while it offers none, and nothing
 *  once those are gone, or while the list is not read. */
export type IntegrationsReach = "all" | "connections" | "none";

export function integrationsReach(state: IntegrationsState): IntegrationsReach {
  if (offeredKinds(state).size > 0) return "all";
  return (state.connections ?? []).length > 0 ? "connections" : "none";
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
let addRequest: IntegrationKind | null = null;

export function requestIntegrationFocus(connId: string) {
  addRequest = null;
  focusRequest = connId;
}

/** One-shot provider-targeted Settings navigation, never connection state. */
export function requestIntegrationAdd(kind: IntegrationKind) {
  focusRequest = null;
  addRequest = kind;
}

export function takeIntegrationAdd(): IntegrationKind | null {
  const kind = addRequest;
  addRequest = null;
  return kind;
}

export function takeIntegrationFocus(): string | null {
  const id = focusRequest;
  focusRequest = null;
  return id;
}
