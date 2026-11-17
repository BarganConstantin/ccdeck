// The ccdeck account as the page holds it: the deck's answer to GET
// /api/account, kept fresh by `event: account` on the deck's event stream, and
// the presses that change it.
//
// ONE COPY FOR THE PAGE. Settings › Account and the tab's settings sync
// (account-bridge.ts) both read it, so it is a small store outside React that
// both subscribe to, fetched once when the first of them mounts. Its code is
// in the account's own chunk: App loads it with React.lazy only when
// /api/prefs says the account is on, so on a deck with it off none of this is
// fetched, let alone run.
import { useEffect, useRef, useSyncExternalStore } from "react";
import { createAccountBridge, type AccountView, type Appliers } from "./account-bridge";
import { ACCOUNT_EVENT, STREAM_OPEN_EVENT } from "./account-events";
import { readStored, STORED_EVENT } from "./storage";
import { THEMES } from "./theme";


let view: AccountView | null = null;
let failed = false;
const listeners = new Set<() => void>();
let started = false;

function set(next: AccountView | null) {
  view = next;
  for (const l of listeners) l();
}

async function refresh(): Promise<void> {
  try {
    const r = await fetch("/api/account", { headers: { accept: "application/json" } });
    if (!r.ok) { failed = true; set(view); return; }
    failed = false;
    set(await r.json() as AccountView);
  } catch {
    failed = true;
    set(view);
  }
}

function start() {
  if (started || typeof window === "undefined") return;
  started = true;
  window.addEventListener(ACCOUNT_EVENT, e => {
    const data = (e as CustomEvent<string>).detail;
    try { set(JSON.parse(data) as AccountView); } catch { /* a frame that did not parse */ }
  });
  // The stream reopens after the deck restarts, and nothing is broadcast for
  // a state that did not change across it: ask.
  window.addEventListener(STREAM_OPEN_EVENT, () => { void refresh(); });
  void refresh();
}

function subscribe(listener: () => void) {
  start();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The account as the deck last said, or null before the first answer. */
export function useAccountView(): { view: AccountView | null; failed: boolean } {
  const v = useSyncExternalStore(subscribe, () => view, () => null);
  return { view: v, failed };
}

async function postJson(path: string, body: unknown = {}): Promise<any> {
  const r = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => null);
  if (!r.ok && !data) throw new Error(`${path} answered ${r.status}`);
  return data;
}

/** Whether a URL the deck handed back may be opened in a browser: https, or
 *  http on this machine's loopback for a development API. */
export function openableUrl(raw: string | null | undefined): boolean {
  try {
    const url = new URL(String(raw ?? ""));
    if (url.username || url.password) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

/** The presses Settings › Account makes. Each answers what the deck said. */
export const accountActions = {
  async connect(name: string): Promise<AccountView | null> {
    const next = await postJson("/api/account/connect", { name }) as AccountView;
    if (next) set(next);
    return next;
  },
  async cancel() { set(await postJson("/api/account/connect/cancel") as AccountView); },
  async disconnect() { set(await postJson("/api/account/disconnect") as AccountView); },
  async setMode(body: { mode: "shared"; join: "use-shared" | "publish"; previewRevision?: number } | { mode: "independent" }) {
    const out = await postJson("/api/account/sync/mode", body);
    await refresh();
    return out as { ok?: boolean; error?: string };
  },
  async resolve(action: "use-latest" | "reapply") { await postJson("/api/account/sync/resolve", { action }); await refresh(); },
  async upload() { await postJson("/api/account/sync/upload", { upload: true }); await refresh(); },
  async preview(): Promise<{ local: Record<string, unknown>; shared: { revision: number; values: Record<string, unknown>; updatedBy: { name: string } | null } | null; differences: { key: string; local: unknown; shared: unknown }[]; error?: string }> {
    const r = await fetch("/api/account/sync/preview");
    return r.json();
  },
  refresh,
};

/**
 * The tab's settings sync, for as long as the component that calls it is
 * mounted (AccountBridge.tsx, mounted by App while the account is on).
 * `appliers` is read through a ref, so App's setters can be new functions on
 * every render without the bridge being rebuilt.
 */
export function useAccountSync(appliers: Appliers): void {
  const appliersRef = useRef(appliers);
  appliersRef.current = appliers;
  const { view: current } = useAccountView();
  const bridgeRef = useRef<ReturnType<typeof createAccountBridge> | null>(null);
  if (!bridgeRef.current) {
    bridgeRef.current = createAccountBridge({
      post: (path, body) => postJson(path, body),
      read: readStored,
      appliers: () => appliersRef.current,
      themes: () => THEMES,
    });
  }
  useEffect(() => {
    const bridge = bridgeRef.current!;
    const onStored = (e: Event) => {
      const d = (e as CustomEvent<{ key: string; value: string }>).detail;
      if (d && typeof d.key === "string") bridge.onStored(d.key, d.value ?? null);
    };
    window.addEventListener(STORED_EVENT, onStored);
    return () => { window.removeEventListener(STORED_EVENT, onStored); bridge.dispose(); };
  }, []);
  useEffect(() => { bridgeRef.current!.onView(current); }, [current]);
}
