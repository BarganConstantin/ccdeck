// Interactive alerts, the system notification: raised through the deck's
// service worker so it can carry buttons, with the plain notification where
// there is no worker; the worker hands a press back to the page. The server's
// half is chat-alerts-served.test.ts.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALERT_WORKER_URL, chatLink, chatLinkTarget, notifyActions, parseWorkerMessage, registerAlertWorker, showRich,
  workerSupported, type RichNotice, type WorkerHost,
} from "../alert-worker";
import { waitingExtras } from "../use-os-notifications";
import type { BlockedSession } from "../ambient-counts";
import type { GraphState } from "../graph-state";
import { t } from "../i18n";

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(here, "../public");
const WORDS = { allow: "Allow once", open: "Open", openInChat: "Open in Chat" };

const notice: RichNotice = {
  key: "s1@1", title: "api", body: "Needs your permission", icon: "/icon-192.png",
  data: { sessionId: "s1", kind: "permission", since: 1 },
  actions: notifyActions("permission", true, WORDS), requireInteraction: true,
};

function host(over: Partial<WorkerHost> = {}, reg?: { active?: unknown; showNotification: ReturnType<typeof vi.fn> } | null) {
  const register = vi.fn(() => Promise.resolve({}));
  const getRegistration = vi.fn(() => Promise.resolve(reg ?? undefined));
  return { h: { serviceWorker: { register, getRegistration }, secure: true, desktop: false, ...over } as WorkerHost, register, getRegistration };
}

describe("the buttons a notification carries", () => {
  it("Allow once and Open for a permission prompt Chat can answer", () => {
    expect(notifyActions("permission", true, WORDS)).toEqual([{ action: "allow", title: "Allow once" }, { action: "open", title: "Open" }]);
  });
  it("Open in Chat for a question, a plan, or a prompt Chat cannot answer", () => {
    for (const kind of ["question", "plan", "other"]) expect(notifyActions(kind, false, WORDS)).toEqual([{ action: "open", title: "Open in Chat" }]);
    expect(notifyActions("permission", false, WORDS)).toEqual([{ action: "open", title: "Open in Chat" }]);
  });
  it("none for a finished turn", () => {
    expect(notifyActions("finished", false, WORDS)).toEqual([]);
  });

  it("are worked out from the waiting session, as its alert card is", () => {
    const b = { id: "s1", label: "api", waiting: { kind: "permission", message: "", since: 7, tool: { name: "Bash", preview: "npm test" } } } as BlockedSession;
    const graph = (provider: string) => ({ agents: new Map([["s1", { sessionId: "s1", provider }]]), toolIndex: new Map() }) as unknown as GraphState;
    const claude = waitingExtras(b, graph("claude"));
    expect(claude.data).toEqual({ sessionId: "s1", kind: "permission", since: 7 });
    expect(claude.actions.map(a => a.action)).toEqual(["allow", "open"]);
    expect(claude.actions[0].title).toBe(t("board.chat.alert.allowOnce"));
    expect(waitingExtras(b, graph("codex")).actions.map(a => a.action)).toEqual(["open"]);
    const plan = { ...b, waiting: { ...b.waiting, tool: { name: "ExitPlanMode", preview: "" } } } as BlockedSession;
    expect(waitingExtras(plan, graph("claude"))).toMatchObject({ data: { kind: "plan" }, actions: [{ action: "open", title: t("board.chat.alert.openInChat") }] });
  });
});

describe("raising one", () => {
  it("goes through the worker, with its buttons, when the worker runs", async () => {
    const reg = { active: {}, showNotification: vi.fn(() => Promise.resolve()) };
    const { h } = host({}, reg);
    const plain = vi.fn();
    expect(await showRich(notice, plain, h)).toBe("worker");
    expect(plain).not.toHaveBeenCalled();
    expect(reg.showNotification).toHaveBeenCalledWith("api", expect.objectContaining({
      body: "Needs your permission", tag: "s1@1", data: notice.data, actions: notice.actions, requireInteraction: true,
    }));
  });

  it("falls back to the plain one: no worker yet, a refusal, no secure context, the desktop app", async () => {
    const plain = vi.fn();
    expect(await showRich(notice, plain, host({}, { showNotification: vi.fn() }).h)).toBe("plain");
    const refusing = { active: {}, showNotification: vi.fn(() => Promise.reject(new TypeError("no actions"))) };
    expect(await showRich(notice, plain, host({}, refusing).h)).toBe("plain");
    const insecure = host({ secure: false }, { active: {}, showNotification: vi.fn() });
    expect(await showRich(notice, plain, insecure.h)).toBe("plain");
    expect(insecure.getRegistration).not.toHaveBeenCalled();
    expect(await showRich(notice, plain, host({ desktop: true }).h)).toBe("plain");
    expect(await showRich(notice, plain, { secure: true, desktop: false })).toBe("plain");
    expect(plain).toHaveBeenCalledTimes(5);
  });

  it("registers the worker at the root, only where it can run", async () => {
    const ok = host();
    expect(await registerAlertWorker(ok.h)).toBe(true);
    expect(ok.register).toHaveBeenCalledWith(ALERT_WORKER_URL, { scope: "/" });
    const lan = host({ secure: false });
    expect(await registerAlertWorker(lan.h)).toBe(false);
    expect(lan.register).not.toHaveBeenCalled();
    expect(workerSupported(host({ desktop: true }).h)).toBe(false);
    const refused = host();
    refused.register.mockImplementation(() => Promise.reject(new Error("SecurityError")));
    expect(await registerAlertWorker(refused.h)).toBe(false);
  });
});

describe("the page reading a press back", () => {
  it("takes the worker's message, checked", () => {
    expect(parseWorkerMessage({ type: "ccdeck:notification", sessionId: "s1", action: "allow", kind: "permission", since: 3 }))
      .toEqual({ sessionId: "s1", action: "allow", kind: "permission", since: 3 });
    expect(parseWorkerMessage({ type: "ccdeck:notification", sessionId: "s1", action: "delete" })).toEqual({ sessionId: "s1", action: "open" });
    for (const bad of [null, "x", { type: "other", sessionId: "s1" }, { type: "ccdeck:notification", sessionId: "<img>" }, { type: "ccdeck:notification", sessionId: "a".repeat(200) }]) {
      expect(parseWorkerMessage(bad)).toBeNull();
    }
  });

  it("opens a deck on a session by its link, and nothing else", () => {
    expect(chatLink("s 1")).toBe("/#chat=s%201");
    expect(chatLinkTarget("#chat=abc-123")).toBe("abc-123");
    expect(chatLinkTarget("#chat=%3Cx%3E")).toBeNull();
    expect(chatLinkTarget("#chat=%E0%A4%A")).toBeNull();
    expect(chatLinkTarget("#other=abc")).toBeNull();
  });
});

describe("the worker (public/sw.js)", () => {
  type Handler = (event: unknown) => void;
  function boot(windows: Array<{ focused?: boolean; visibilityState?: string }> = []) {
    const handlers = new Map<string, Handler>();
    const clients = windows.map(w => ({ ...w, focus: vi.fn(() => Promise.resolve()), postMessage: vi.fn() }));
    const self = {
      addEventListener: (type: string, fn: Handler) => { handlers.set(type, fn); },
      skipWaiting: vi.fn(),
      clients: { claim: vi.fn(() => Promise.resolve()), matchAll: vi.fn(() => Promise.resolve(clients)), openWindow: vi.fn(() => Promise.resolve(null)) },
    };
    new Function("self", readFileSync(join(PUBLIC, "sw.js"), "utf8"))(self);
    const click = async (data: unknown, action = "") => {
      let done: Promise<unknown> = Promise.resolve();
      const close = vi.fn();
      handlers.get("notificationclick")!({ action, notification: { data, close }, waitUntil: (p: Promise<unknown>) => { done = p; } });
      await done;
      return close;
    };
    return { handlers, clients, self, click };
  }

  it("has no fetch handler: it caches and serves nothing", () => {
    const { handlers } = boot();
    expect([...handlers.keys()].sort()).toEqual(["activate", "install", "notificationclick"]);
  });

  it("tells the deck in front which button was pressed", async () => {
    const { clients, click } = boot([{ visibilityState: "hidden" }, { focused: true }]);
    const close = await click({ sessionId: "s1", kind: "permission", since: 5 }, "allow");
    expect(close).toHaveBeenCalled();
    expect(clients[1].focus).toHaveBeenCalled();
    expect(clients[1].postMessage).toHaveBeenCalledWith({ type: "ccdeck:notification", sessionId: "s1", kind: "permission", since: 5, action: "allow" });
    expect(clients[0].postMessage).not.toHaveBeenCalled();
  });

  it("a body click or any other button only opens", async () => {
    const { clients, click } = boot([{ visibilityState: "visible" }]);
    await click({ sessionId: "s1", kind: "question" }, "");
    await click({ sessionId: "s1", kind: "question" }, "something");
    expect(clients[0].postMessage.mock.calls.map(c => (c[0] as { action: string }).action)).toEqual(["open", "open"]);
  });

  it("with no deck open, opens one on the session and answers nothing", async () => {
    const { self, click } = boot([]);
    await click({ sessionId: "s1", kind: "permission" }, "allow");
    expect(self.clients.openWindow).toHaveBeenCalledWith("/#chat=s1");
  });

  it("ignores a notification that names no session it can trust", async () => {
    const { self, clients, click } = boot([{ focused: true }]);
    await click({ sessionId: "../../etc" }, "allow");
    await click(null, "allow");
    expect(clients[0].postMessage).not.toHaveBeenCalled();
    expect(self.clients.openWindow).not.toHaveBeenCalled();
  });
});
