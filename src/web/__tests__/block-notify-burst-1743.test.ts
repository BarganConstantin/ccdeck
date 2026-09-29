// The closed-deck notifier had one throttle, and it was per session.
//
// `POST /api/event` asks nothing of its caller (OPEN_MUTATIONS), and every
// event it ingests reaches createBlockNotifier. The memo there keys a
// Notification on its own session id, so a caller that sends a fresh id with
// every post never meets the cooldown: with notifications on and no tab open,
// 1,000 posts were 1,000 desktop notifications titled `<basename(cwd)> —
// ccdeck`, and with no desktop app connected each one was its own osascript,
// powershell.exe or notify-send. What bounds it now is a window across every
// session, with whatever it held back said once, as a count, when the window
// reopens.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { get, request, type ClientRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-notify-burst-"));
const prevEnv = { ...process.env };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.CCDECK_HOME = join(DIR, "deck");
process.env.XDG_CONFIG_HOME = join(DIR, "config");
process.env.XDG_STATE_HOME = join(DIR, "state");
delete process.env.AGENTS_DECK_NO_NOTIFY;

// @ts-expect-error — plain .mjs module, no types
const { blockNotice, createBlockNotifier } = await import("../../server/block-notify.mjs");
// @ts-expect-error — plain .mjs module, no types
const { startServer, hookToken } = await import("../../server/index.mjs");

/** A few per minute, across every session: the cap the notifier keeps. */
const CAP = 3;
const WINDOW_MS = 60_000;

const fake = (i: number) => ({
  hook_event_name: "Notification",
  session_id: `fake-${i}`,
  cwd: "/Anything",
  message: "Needs your permission",
});

function harness() {
  const notify = vi.fn().mockResolvedValue(true);
  let clock = 10_000_000;
  const timers: Array<() => void> = [];
  const n = createBlockNotifier({
    notify, product: "ccdeck", now: () => clock,
    // The window reopening is a timer, driven by hand here.
    later: (fn: () => void) => { timers.push(fn); },
  });
  const fire = () => { for (const fn of timers.splice(0)) fn(); };
  return { n, notify, fire, tick: (ms: number) => { clock += ms; } };
}

describe("a burst of sessions, each new to the notifier", () => {
  it("raises at most the cap inside one window, whatever the session ids", () => {
    const { n, notify, tick } = harness();
    for (let i = 0; i < 1000; i++) {
      n.consider(fake(i), { clients: 0 });
      tick(1);
    }
    expect(notify).toHaveBeenCalledTimes(CAP);
  });

  it("says what it held back once, as a count, when the window reopens", () => {
    const { n, notify, fire, tick } = harness();
    for (let i = 0; i < 1000; i++) n.consider(fake(i), { clients: 0 });
    tick(WINDOW_MS);
    fire();
    expect(notify).toHaveBeenCalledTimes(CAP + 1);
    const [title, body] = notify.mock.calls[CAP];
    expect(title).toBe("More sessions — ccdeck");
    expect(body).toBe(`${1000 - CAP} more sessions need you`);
    // And nothing further is owed: a second firing has nothing to say.
    fire();
    expect(notify).toHaveBeenCalledTimes(CAP + 1);
  });

  it("lets the next one through once the window has passed", () => {
    const { n, notify, fire, tick } = harness();
    for (let i = 0; i < CAP + 5; i++) n.consider(fake(i), { clients: 0 });
    tick(WINDOW_MS);
    fire();
    tick(WINDOW_MS);
    expect(n.consider(fake(9999), { clients: 0 })).toBe("notified");
    expect(notify).toHaveBeenLastCalledWith("Anything — ccdeck", "Needs your permission", expect.anything());
  });

  it("says nothing held back if a page has opened by then — the page is showing them", () => {
    const notify = vi.fn().mockResolvedValue(true);
    let clock = 10_000_000;
    let pages = 0;
    const timers: Array<() => void> = [];
    const n = createBlockNotifier({
      notify, product: "ccdeck", now: () => clock, pages: () => pages,
      later: (fn: () => void) => { timers.push(fn); },
    });
    for (let i = 0; i < CAP + 2; i++) n.consider(fake(i), { clients: 0 });
    pages = 1;
    clock += WINDOW_MS;
    for (const fn of timers.splice(0)) fn();
    expect(notify).toHaveBeenCalledTimes(CAP);
  });
});

describe("what reaches the OS helper", () => {
  it("cuts the title and the body to a fixed length", () => {
    const { title, body } = blockNotice({
      hook_event_name: "Notification",
      session_id: "s",
      cwd: `/${"d".repeat(10_000)}`,
      message: "m".repeat(10_000),
    }, "ccdeck");
    expect([...title].length).toBeLessThanOrEqual(80);
    expect(title.endsWith(" — ccdeck")).toBe(true);
    expect([...body].length).toBeLessThanOrEqual(160);
  });
});

// The same burst through the route. With the desktop app's tray connected the
// notification is handed to it rather than to an OS helper, so the frames it
// receives are the count — nothing is spawned.
describe("POST /api/event, fifty sessions at once", () => {
  let server: Server;
  let port = 0;
  const open: ClientRequest[] = [];

  beforeAll(async () => {
    server = await startServer({ port: 0, persist: null, codex: false, claude: false });
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    for (const r of open) r.destroy();
    await new Promise<void>(done => { server.closeAllConnections?.(); server.close(() => done()); });
    for (const k of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CCDECK_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "AGENTS_DECK_NO_NOTIFY"]) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
    rmTempDir(DIR);
  });

  function post(path: string, body: unknown, token = false): Promise<number> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers["x-ccdeck-token"] = hookToken();
      const req = request({ host: "127.0.0.1", port, path, method: "POST", headers }, res => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      });
      req.on("error", reject);
      req.end(JSON.stringify(body));
    });
  }

  function tray(): Promise<() => string> {
    return new Promise((resolve, reject) => {
      let text = "";
      const req = get({
        host: "127.0.0.1", port, path: "/events?role=tray", headers: { "x-ccdeck-token": hookToken() },
      }, res => {
        res.setEncoding("utf8");
        res.on("data", c => { text += c; });
        resolve(() => text);
      });
      req.on("error", reject);
      open.push(req);
    });
  }

  async function until(fn: () => boolean, what: string) {
    for (let i = 0; i < 200; i++) {
      if (fn()) return;
      await new Promise(r => setTimeout(r, 25));
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  it("raises at most the cap", async () => {
    expect(await post("/api/prefs", { notifications: true }, true)).toBe(200);
    const text = await tray();
    await until(() => text().includes("event: replay-end"), "the replay to end");
    for (let i = 0; i < 50; i++) expect(await post("/api/event", fake(i))).toBe(200);
    await until(() => text().split("event: notify\n").length - 1 >= CAP, "the first notifications");
    // Long enough for the rest to have arrived, had they been going to.
    await new Promise(r => setTimeout(r, 300));
    expect(text().split("event: notify\n").length - 1).toBe(CAP);
  });
});
