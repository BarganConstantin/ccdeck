// Interactive alerts in the desktop app: a session's notification and a tray
// row for a blocked session open the window on that session in Chat. The deck
// names the session in its notify frame, main.mjs holds the id until the page
// has loaded, and preload.cjs keeps it until the page asks for it.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { holdSession, HOLD_MS, pokePage, POKE_SCRIPT, SESSION_HELD_EVENT, SESSION_TAKE_CHANNEL, sessionOf, takeHeld } from "../../../desktop/session-link.mjs";
import { DESK_SESSION_EVENT } from "../use-chat-alerts";
import { trayMenuItems } from "../../../desktop/tray-menu.mjs";
import { createBlockNotifier } from "../../server/block-notify.mjs";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

describe("the session id the app carries", () => {
  it("is a session id or nothing", () => {
    expect(sessionOf("abc-123_x.y:z")).toBe("abc-123_x.y:z");
    for (const bad of [null, undefined, 42, "", "../x", "a b", "<script>", "a".repeat(129)]) expect(sessionOf(bad)).toBeNull();
  });

  it("is announced to a page that has loaded, with an event that carries nothing", () => {
    const contents = { loading: true, isLoading() { return this.loading; }, isDestroyed: () => false, executeJavaScript: vi.fn(() => Promise.resolve()) };
    expect(pokePage(contents)).toBe(false);
    expect(contents.executeJavaScript).not.toHaveBeenCalled();
    contents.loading = false;
    expect(pokePage(contents)).toBe(true);
    expect(contents.executeJavaScript).toHaveBeenCalledWith(POKE_SCRIPT);
    expect(POKE_SCRIPT).toBe('window.dispatchEvent(new Event("ccdeck:session-held"))');
    expect(SESSION_HELD_EVENT).toBe(DESK_SESSION_EVENT);
    expect(pokePage(undefined)).toBe(false);
    expect(pokePage({ ...contents, isDestroyed: () => true })).toBe(false);
  });

  it("is held for a little while for a page that asks as it starts, and only a session id", () => {
    const held = holdSession("s1", 1_000);
    expect(held).toEqual({ id: "s1", at: 1_000 });
    expect(takeHeld(held, 1_000 + HOLD_MS)).toBe("s1");
    expect(takeHeld(held, 1_001 + HOLD_MS)).toBeNull();
    expect(takeHeld(null, 1_000)).toBeNull();
    expect(holdSession("../x", 1_000)).toBeNull();
    expect(holdSession(undefined, 1_000)).toBeNull();
  });

  it("is packaged with the app, and wired to a notification's click, a tray row and a starting page", () => {
    expect(read("../../../desktop/electron-builder.config.cjs")).toMatch(/"session-link\.mjs"/);
    const main = read("../../../desktop/main.mjs");
    expect(main).toMatch(/n\.on\("click", \(\) => openSession\(session\)\)/);
    expect(main).toMatch(/openSession: id => openSession\(id\)/);
    expect(main).toMatch(/ipcMain\.handle\(SESSION_TAKE_CHANNEL, event => \{\s*if \(!fromDeckPage\(event\)/);
    expect(main).toMatch(/installSessionLinkIpc\(\);/);
    expect(main).toMatch(/if \(heldSession\) pokePage\(win\?\.webContents\);/);
  });
});

describe("the tray's blocked rows", () => {
  const on = () => ({
    openWindow: vi.fn(), openSession: vi.fn(), startDeck: vi.fn(), openInBrowser: vi.fn(), toggleNotifications: vi.fn(),
    setOpenAtLogin: vi.fn(), restartToUpdate: vi.fn(), checkForUpdates: vi.fn(), restartDeck: vi.fn(), quit: vi.fn(),
  });
  const items = (actions: Record<string, unknown>, blocked: unknown[]) => trayMenuItems({
    now: 10_000, snapshot: { icon: "waiting", waiting: blocked.length, running: 0, title: "ccdeck", blocked },
    deck: { pid: 1, port: 4881, token: "t", version: "4.3.15" }, starting: null, restarting: null, notifyOn: true,
    openAtLogin: false, appVersion: "4.3.15", update: { status: "idle" },
  }, actions) as Array<{ label?: string; click?: () => void }>;

  it("open their session in Chat", () => {
    const a = on();
    const row = items(a, [{ id: "s1", label: "api", kind: "permission", since: 5_000 }]).find(i => i.label?.startsWith("api"))!;
    row.click!();
    expect(a.openSession).toHaveBeenCalledWith("s1");
    expect(a.openWindow).not.toHaveBeenCalled();
  });

  it("open the window as before where there is no id, or no way to open one", () => {
    const a = on();
    items(a, [{ label: "api", kind: "asked", since: 5_000 }]).find(i => i.label?.startsWith("api"))!.click!();
    const { openSession: _, ...older } = on();
    items(older, [{ id: "s1", label: "api", kind: "asked", since: 5_000 }]).find(i => i.label?.startsWith("api"))!.click!();
    expect(a.openWindow).toHaveBeenCalledTimes(1);
    expect(older.openWindow).toHaveBeenCalledTimes(1);
  });
});

describe("the deck naming the session", () => {
  it("in the notifier's raise", () => {
    const notify = vi.fn().mockResolvedValue(true);
    const n = createBlockNotifier({ notify, product: "ccdeck", now: () => 10_000_000 });
    n.consider({ hook_event_name: "Notification", notification_type: "permission_prompt", session_id: "abcdef1234", cwd: "/src/api", message: "Needs Bash" }, { clients: 0 });
    expect(notify.mock.calls[0][2]).toMatchObject({ session: "abcdef1234" });
  });

  it("in the frame the app reads, only when it is a session id", async () => {
    const { notifyTrays, trayClients } = await import("../../server/sse-clients.mjs");
    const frames: string[] = [];
    const app = { write: (f: string) => { frames.push(f); return true; }, writableLength: 0 };
    trayClients.add(app);
    try {
      notifyTrays("api — ccdeck", "Needs Bash", { chime: "needs-input", who: "api", session: "abcdef1234" });
      notifyTrays("api — ccdeck", "Needs Bash", { chime: "needs-input", who: "api", session: "../../x" });
    } finally {
      trayClients.delete(app);
    }
    const data = frames.map(f => JSON.parse(/^data: (.*)$/m.exec(f)![1]));
    expect(data).toEqual([
      { title: "api", body: "Needs Bash", chime: "needs-input", session: "abcdef1234" },
      { title: "api", body: "Needs Bash", chime: "needs-input" },
    ]);
  });
});

describe("the preload's hand-over", () => {
  function boot() {
    const exposed = new Map<string, Record<string, (...a: unknown[]) => unknown>>();
    const invoke = vi.fn(async () => "s9");
    const electron = {
      contextBridge: { exposeInMainWorld: (name: string, api: Record<string, (...a: unknown[]) => unknown>) => { exposed.set(name, api); } },
      ipcRenderer: { invoke },
      webFrame: { getZoomFactor: () => 1 },
      webUtils: { getPathForFile: () => "" },
    };
    const req = (name: string) => { if (name !== "electron") throw new Error(`a sandboxed preload cannot require ${name}`); return electron; };
    new Function("require", "process", read("../../../desktop/preload.cjs"))(req, { argv: [], platform: "linux" });
    return { session: exposed.get("ccdeckSession")!, invoke };
  }

  it("is one call that takes nothing from the page", async () => {
    const { session, invoke } = boot();
    expect(Object.keys(session)).toEqual(["take"]);
    expect(await session.take("../etc", { path: "/" })).toBe("s9");
    expect(invoke).toHaveBeenCalledWith(SESSION_TAKE_CHANNEL);
    expect(invoke.mock.calls[0]).toEqual([SESSION_TAKE_CHANNEL]);
  });

  it("listens to nothing, as the rest of the preload does not", () => {
    expect(read("../../../desktop/preload.cjs")).not.toMatch(/ipcRenderer\.(send|on)\b/);
  });
});
