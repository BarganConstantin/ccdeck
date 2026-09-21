// The desktop app's tray connection to the deck (#1160).
//
// The app reads `/events` to draw its tray icon. Counted as a page, it would
// make the deck believe somebody was looking whenever the app ran — and the
// notifications a closed deck raises would never fire, which is the one thing
// the app exists to deliver. So `?role=tray` is subscribed like any client and
// counted as none, and while one is connected the closed-deck notification is
// handed to it (to raise under ccdeck's own name) instead of to osascript.
//
// Only with the deck's token: a page must not be able to opt itself out of
// being counted and switch the closed-deck notifications on over itself.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { get, request, type ClientRequest, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-tray-"));
const prevEnv = { ...process.env };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.CCDECK_HOME = join(DIR, "deck");

const { startServer, hookToken } = await import("../../server/index.mjs");

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
  for (const k of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CCDECK_HOME"]) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  rmTempDir(DIR);
});

function health(): Promise<{ clients: number; trays: number }> {
  return new Promise((resolve, reject) => {
    get({ host: "127.0.0.1", port, path: "/api/health" }, res => {
      let out = "";
      res.setEncoding("utf8");
      res.on("data", c => { out += c; });
      res.on("end", () => resolve(JSON.parse(out)));
    }).on("error", reject);
  });
}

async function until(fn: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await new Promise(r => setTimeout(r, 30));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Open a stream; resolves with a live transcript of everything it receives. */
function stream(path: string, token = true): Promise<{ req: ClientRequest; text: () => string; res: IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (token) headers["x-ccdeck-token"] = hookToken();
    let text = "";
    const req = get({ host: "127.0.0.1", port, path, headers }, res => {
      res.setEncoding("utf8");
      res.on("data", c => { text += c; });
      resolve({ req, res, text: () => text });
    });
    req.on("error", reject);
    open.push(req);
  });
}

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

describe("the tray connection", () => {
  it("is subscribed, and is not a page", async () => {
    const tray = await stream("/events?role=tray");
    await until(async () => (await health()).trays === 1, "the tray to subscribe");
    expect((await health()).clients).toBe(0);
    await until(async () => tray.text().includes("event: replay-end"), "the replay to end");
    tray.req.destroy();
    await until(async () => (await health()).trays === 0, "the tray to leave");
  });

  it("counts a stream that asks for the role without the token as a page", async () => {
    // Without the token /events refuses outright; with it but no role it is a
    // page. The role alone, from something that cannot prove it is the app, is
    // never honoured.
    const page = await stream("/events");
    await until(async () => (await health()).clients === 1, "the page to subscribe");
    expect((await health()).trays).toBe(0);
    page.req.destroy();
    await until(async () => (await health()).clients === 0, "the page to leave");
  });

  it("receives the closed-deck notification, to raise as ccdeck", async () => {
    expect(await post("/api/prefs", { notifications: true }, true)).toBe(200);
    const tray = await stream("/events?role=tray");
    await until(async () => tray.text().includes("event: replay-end"), "the replay to end");
    expect(await post("/api/event", {
      hook_event_name: "Stop", session_id: "tray-s1", cwd: join(DIR, "vcrm-core"),
      last_assistant_message: "All tests pass.",
    })).toBe(200);
    await until(async () => tray.text().includes("event: notify"), "the notification");
    const frame = tray.text().split("event: notify\ndata: ")[1].split("\n")[0];
    // `chime` names the tone the page would have played, so the app plays it.
    expect(JSON.parse(frame)).toEqual({ title: "vcrm-core — ccdeck", body: "All tests pass.", chime: "done" });
    tray.req.destroy();
  });

  it("is not sent a notification while a page is open — the page plays the sound", async () => {
    const tray = await stream("/events?role=tray");
    const page = await stream("/events");
    await until(async () => (await health()).clients === 1 && (await health()).trays === 1, "both to subscribe");
    await post("/api/event", { hook_event_name: "Stop", session_id: "tray-s2", cwd: DIR, last_assistant_message: "x" });
    await new Promise(r => setTimeout(r, 200));
    expect(tray.text()).not.toContain("event: notify");
    tray.req.destroy();
    page.req.destroy();
  });
});
