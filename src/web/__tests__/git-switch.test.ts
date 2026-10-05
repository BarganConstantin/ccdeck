// The Settings switch for the git view, through the real server: off, the deck
// reads no repository at all — no GitObserved, the routes refused — and on
// again, every session on the board is looked at without waiting for its next
// event. And a deck booting on a log reads each card's branch afresh, telling
// the page only what changed since the log.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
import { repoWith, sh, tempDir } from "./git-fixture";

const DIR = tempDir("ccdeck-git-switch-");
const LOG = join(DIR, "events.jsonl");
const KEYS = ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME"] as const;
const prevEnv = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.XDG_CONFIG_HOME = join(DIR, "config");
process.env.XDG_DATA_HOME = join(DIR, "data");

// Two sessions already in the log: one whose logged branch is still the
// repository's, and one whose repository has moved on since.
const same = repoWith({ "a.txt": "one\n" }, "ccdeck-git-switch-same-");
const moved = repoWith({ "a.txt": "one\n" }, "ccdeck-git-switch-moved-");
const line = (seq: number, payload: Record<string, unknown>) =>
  JSON.stringify({ seq, epoch: "old", receivedAt: Date.now() - 60_000, source: payload.hook_event_name === "GitObserved" ? "internal" : "hook", payload });
const logged = (top: string, branch: string) => ({
  state: "repo", topLevel: top, name: top.split(/[\\/]/).pop(), mainName: top.split(/[\\/]/).pop(),
  folderName: top.split(/[\\/]/).pop(), nameDiffers: false, linkedWorktree: false,
  branch, detached: false, sha: "0000000", unborn: false, empty: false, stale: 3,
});
writeFileSync(LOG, [
  line(1, { hook_event_name: "SessionStart", session_id: "B-same", cwd: same }),
  line(2, { hook_event_name: "GitObserved", session_id: "B-same", git: logged(same, "main") }),
  line(3, { hook_event_name: "SessionStart", session_id: "B-moved", cwd: moved }),
  line(4, { hook_event_name: "GitObserved", session_id: "B-moved", git: logged(moved, "main") }),
].join("\n") + "\n");
sh(moved, ["checkout", "-q", "-b", "moved-on"]);

// @ts-expect-error — plain .mjs server module, no types
const { startServer, hookToken } = await import("../../server/index.mjs");

let server: Server;
let port = 0;
type Env = { seq: number; payload: any };

function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { "Content-Type": "application/json", "x-ccdeck-token": hookToken() } }, res => {
      let out = "";
      res.setEncoding("utf8");
      res.on("data", c => { out += c; });
      res.on("end", () => {
        let parsed: any = null;
        try { parsed = JSON.parse(out); } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const all = async (): Promise<Env[]> => (await call("GET", "/api/events?since=0")).body;
const observed = async (sid: string, since = 0) =>
  (await all()).filter(e => e.seq > since && e.payload?.hook_event_name === "GitObserved" && e.payload.session_id === sid);
const lastSeq = async () => { const a = await all(); return a.length ? a[a.length - 1].seq : 0; };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function next(sid: string, since: number, test: (g: any) => boolean = () => true): Promise<Env> {
  for (let i = 0; i < 120; i++) {
    const hit = (await observed(sid, since)).find(e => test(e.payload.git));
    if (hit) return hit;
    await sleep(50);
  }
  throw new Error(`no GitObserved for ${sid} after ${since}`);
}

beforeAll(async () => {
  server = await startServer({ port: 0, host: "127.0.0.1", persist: LOG, codex: false });
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>(done => {
    server.closeAllConnections?.();
    server.close(() => done());
  });
  for (const k of KEYS) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  for (const d of [same, moved]) rmTempDir(d);
  rmTempDir(DIR);
});

describe("a deck booting on its log", () => {
  it("reads every card's branch again, and sends only the ones that changed", async () => {
    const e = await next("B-moved", 0, g => g.branch === "moved-on");
    expect(e.payload.git.topLevel).toBe(moved);
    await sleep(400);
    // The replayed line is the only one for the session whose branch held.
    expect((await observed("B-same")).map(x => x.payload.git.branch)).toEqual(["main"]);
  });
});

describe("the switch", () => {
  it("is on by default and can be written by the page", async () => {
    const r = await call("GET", "/api/prefs");
    expect(r.body.prefs.git).toBe(true);
  });

  it("off, stops every read: no GitObserved and the routes refused", async () => {
    const dir = repoWith({ "a.txt": "one\n" }, "ccdeck-git-switch-off-");
    try {
      const w = await call("POST", "/api/prefs", { git: false });
      expect(w.status).toBe(200);
      expect(w.body.prefs.git).toBe(false);
      const since = await lastSeq();
      await call("POST", "/api/event", { hook_event_name: "SessionStart", session_id: "S-off", cwd: dir });
      await call("POST", "/api/event", { hook_event_name: "PostToolUse", session_id: "S-off", cwd: dir, tool_name: "Bash" });
      await sleep(900);
      expect(await observed("S-off", since)).toEqual([]);
      for (const route of ["repo", "log", "status", "diff", "commit"]) {
        const r = await call("GET", `/api/git/${route}?session=S-off&path=a.txt&sha=abcd`);
        expect(r.status, route).toBe(409);
      }

      // On again: the session is told its branch without another event.
      const since2 = await lastSeq();
      expect((await call("POST", "/api/prefs", { git: true })).body.prefs.git).toBe(true);
      expect((await next("S-off", since2)).payload.git.branch).toBe("main");
      expect((await call("GET", "/api/git/repo?session=S-off")).status).toBe(200);
    } finally {
      rmTempDir(dir);
    }
  });
});
