// The deck's service worker (public/sw.js) and what passes through it: a
// notification raised with buttons, and the press on one coming back to the
// page as a message.
//
// WHY A WORKER. A page's `new Notification` takes no buttons; only one raised
// by a service worker's registration does, and only a worker hears which
// button was pressed. The worker does nothing else: it has no fetch handler,
// so it caches nothing and never stands between the deck and its server.
//
// WHERE THERE IS NONE, nothing changes: the desktop app (Electron raises its
// notifications natively, without buttons), a browser without workers, and a
// LAN deck on plain http, which a browser does not give workers to. The
// notification is the plain one it always was, and its click opens the session.
import { inDesktopApp } from "./in-app";

/** The worker's path, served at the root so its scope is the whole deck. */
export const ALERT_WORKER_URL = "/sw.js";
/** The message type the worker posts to the page. */
export const WORKER_MESSAGE = "ccdeck:notification";

/** What a notification's buttons can ask: open the session in Chat, or answer
 *  the permission prompt "Yes" once. */
export type NotifyAction = "open" | "allow";

/** What a notification carries for the worker to hand back. */
export interface NotifyData {
  sessionId: string;
  /** "permission", "question", "plan", "other", or "finished" for a turn that ended. */
  kind: string;
  /** The block's start: a press for another block answers nothing. */
  since?: number;
}

/** A notification with what the worker needs: its buttons and its data. */
export interface RichNotice {
  key: string;
  title: string;
  body: string;
  icon: string;
  data: NotifyData;
  actions: { action: NotifyAction; title: string }[];
  /** A wait stays until it is dealt with; a finished turn goes on its own. */
  requireInteraction: boolean;
}

/** A press the worker sent, checked: what the page acts on. */
export interface OpenRequest {
  sessionId: string;
  action: NotifyAction;
  kind?: string;
  since?: number;
}

/** A session id as the deck has them: short, and nothing a path or a selector could hide in. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** Whether `id` can be a session id. */
export function sessionIdOk(id: unknown): id is string {
  return typeof id === "string" && SESSION_ID.test(id);
}

/** The worker's message, or null for anything else on that channel. */
export function parseWorkerMessage(data: unknown): OpenRequest | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.type !== WORKER_MESSAGE || !sessionIdOk(d.sessionId)) return null;
  const action: NotifyAction = d.action === "allow" ? "allow" : "open";
  return {
    sessionId: d.sessionId,
    action,
    ...(typeof d.kind === "string" ? { kind: d.kind } : null),
    ...(typeof d.since === "number" && Number.isFinite(d.since) ? { since: d.since } : null),
  };
}

/** The link that opens a deck on a session in Chat, for a press with no deck open. */
export function chatLink(sessionId: string): string {
  return `/#chat=${encodeURIComponent(sessionId)}`;
}

/** The session a deck was opened on (`#chat=<id>`), or null. */
export function chatLinkTarget(hash: string): string | null {
  const m = /^#chat=([^&]+)$/.exec(hash);
  if (!m) return null;
  let id: string;
  try { id = decodeURIComponent(m[1]); } catch { return null; }
  return sessionIdOk(id) ? id : null;
}

/** The buttons a notification about a waiting session offers. "Allow once" only
 *  for a permission prompt the deck can answer from Chat. */
export function notifyActions(kind: string, answerable: boolean, words: { allow: string; open: string; openInChat: string }): RichNotice["actions"] {
  if (kind === "permission" && answerable) return [{ action: "allow", title: words.allow }, { action: "open", title: words.open }];
  if (kind === "finished") return [];
  return [{ action: "open", title: words.openInChat }];
}

/** What the page needs of the browser to raise one; absent pieces are absent. */
export interface WorkerHost {
  serviceWorker?: {
    register(url: string, opts?: { scope?: string }): Promise<unknown>;
    getRegistration(url?: string): Promise<{ active?: unknown; showNotification(title: string, opts: object): Promise<void> } | undefined>;
  };
  secure: boolean;
  desktop: boolean;
}

/** The browser as this page has it. */
export function realHost(): WorkerHost {
  const nav = typeof navigator === "undefined" ? undefined : (navigator as Navigator & { serviceWorker?: WorkerHost["serviceWorker"] });
  return {
    serviceWorker: nav?.serviceWorker,
    secure: typeof window !== "undefined" && window.isSecureContext === true,
    desktop: inDesktopApp(),
  };
}

/** Whether notifications here can carry buttons. */
export function workerSupported(host: WorkerHost = realHost()): boolean {
  return !!host.serviceWorker && host.secure && !host.desktop;
}

/** Registers the worker once per page; a refusal costs the buttons, nothing else. */
export function registerAlertWorker(host: WorkerHost = realHost()): Promise<boolean> {
  if (!workerSupported(host)) return Promise.resolve(false);
  return host.serviceWorker!.register(ALERT_WORKER_URL, { scope: "/" }).then(() => true, () => false);
}

/**
 * Raises `n` through the worker, with its buttons; `plain()` raises the plain
 * notification where there is no worker, or it is not running yet, or it
 * refuses. Resolves to which one went up.
 */
export async function showRich(n: RichNotice, plain: () => void, host: WorkerHost = realHost()): Promise<"worker" | "plain"> {
  if (workerSupported(host)) {
    try {
      const reg = await host.serviceWorker!.getRegistration(ALERT_WORKER_URL);
      if (reg?.active) {
        await reg.showNotification(n.title, {
          body: n.body, tag: n.key, icon: n.icon, data: n.data,
          actions: n.actions, requireInteraction: n.requireInteraction,
        });
        return "worker";
      }
    } catch { /* the plain one below says it all the same */ }
  }
  plain();
  return "plain";
}
