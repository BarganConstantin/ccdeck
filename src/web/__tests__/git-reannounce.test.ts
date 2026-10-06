// A card's branch and its collisions are sent once, when they change, and the
// ring drops its oldest events as new ones arrive. A page that connects after
// the event that carried them has left the ring — a reload or a second tab on
// a busy deck — is sent them again before its replay ends, through the real
// server. Real repositories; the agents are the test posting their events.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { request, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
import { repoWith, tempDir, write } from "./git-fixture";

const DIR = tempDir("ccdeck-git-reannounce-");
const LOG = join(DIR, "events.jsonl");
const KEYS = ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME"] as const;
const prevEnv = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.XDG_CONFIG_HOME = join(DIR, "config");
process.env.XDG_DATA_HOME = join(DIR, "data");

// @ts-expect-error — plain .mjs server module, no types
const { startServer, hookToken, replayLog, eventBufferStats, MAX_BUFFER } = await import("../../server/index.mjs");

const made: string[] = [];
const track = (d: string) => { made.push(d); return d; };
const streams: IncomingMessage[] = [];
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
const event = (p: Record<string, unknown>) => call("POST", "/api/event", p);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const ring = async (): Promise<Env[]> => (await call("GET", "/api/events?since=0")).body;
const gitIn = (events: Env[], name: string, sid: string) => events.filter(e => e.payload?.hook_event_name === name && e.payload.session_id === sid);
async function until<T>(get: () => Promise<T | undefined>, what: string, ms = 8_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await get();
    if (v !== undefined) return v;
    await sleep(50);
  }
  throw new Error(`gave up waiting for ${what}`);
}

/** A fresh page: an SSE stream with no Last-Event-ID, read to `replay-end`. */
function freshPage(): Promise<Env[]> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/events", method: "GET", headers: { accept: "text/event-stream", "x-ccdeck-token": hookToken() } }, res => {
      streams.push(res);
      const got: Env[] = [];
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", chunk => {
        buffer += chunk;
        for (;;) {
          const end = buffer.indexOf("\n\n");
          if (end === -1) break;
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const field = (name: string) => block.split("\n").find(l => l.startsWith(`${name}: `))?.slice(name.length + 2) ?? null;
          if (field("event") === "replay-end") { res.destroy(); resolve(got); return; }
          if (field("event") === "hook") got.push(JSON.parse(field("data") ?? "null"));
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

/** Push `count` hook events of a session nobody looks at through the real ring. */
async function noise(count: number): Promise<void> {
  const path = join(DIR, `noise-${Date.now()}.jsonl`);
  writeFileSync(path, Array.from({ length: count }, (_, i) => JSON.stringify({
    seq: i + 1, epoch: "fixture", receivedAt: Date.now(), source: "hook",
    payload: { hook_event_name: i % 2 ? "PostToolUse" : "PreToolUse", session_id: "noise", tool_name: "Read" },
  })).join("\n") + "\n", "utf8");
  await replayLog(path, "", { maxEvents: 1e6, maxEntries: 1e6, maxChars: 1e9 });
}

beforeAll(async () => {
  server = await startServer({ port: 0, host: "127.0.0.1", persist: LOG, codex: false });
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const s of streams.splice(0)) s.destroy();
  await new Promise<void>(done => {
    server.closeAllConnections?.();
    server.close(() => done());
  });
  for (const k of KEYS) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  for (const d of made) rmTempDir(d);
  rmTempDir(DIR);
});

describe("a page that connects behind the ring's head", () => {
  it("is told every card's branch and every collision that still holds", async () => {
    const repo = track(repoWith({ "src/app.ts": "app\n" }, "ccdeck-reannounce-"));
    await event({ hook_event_name: "SessionStart", session_id: "R-ui", cwd: repo });
    await event({ hook_event_name: "SessionStart", session_id: "R-fix", cwd: repo });
    for (const sid of ["R-ui", "R-fix"]) await until(async () => gitIn(await ring(), "GitObserved", sid)[0], `${sid}'s branch`);
    for (const [sid, n] of [["R-ui", 1], ["R-fix", 2]] as const) {
      write(repo, { "src/app.ts": `${sid}\n` });
      await event({ hook_event_name: "PostToolUse", session_id: sid, cwd: repo, tool_name: "Edit", tool_input: { file_path: join(repo, "src/app.ts") }, tool_response: { success: true }, tool_use_id: `toolu_r${n}` });
    }
    const sharp = (c: any) => c?.sharp?.length === 1;
    await until(async () => gitIn(await ring(), "GitCollisions", "R-ui").find(e => sharp(e.payload.collisions)), "the sharp collision");
    await until(async () => gitIn(await ring(), "GitObserved", "R-fix").find(e => e.payload.git.stale >= 1), "the edit's stale mark");
    await sleep(600);

    // A busy deck: the events that carried them leave the ring…
    await noise(MAX_BUFFER + 100);
    // …and both sessions do something that changes nothing, so their cards
    // are drawn again.
    for (const sid of ["R-ui", "R-fix"]) {
      await event({ hook_event_name: "PreToolUse", session_id: sid, cwd: repo, tool_name: "Read" });
    }
    const before = await ring();
    expect(gitIn(before, "GitObserved", "R-ui")).toEqual([]);
    expect(gitIn(before, "GitCollisions", "R-ui")).toEqual([]);
    expect(eventBufferStats().oldestSeq).toBeGreaterThan(1);

    const page = await freshPage();
    for (const sid of ["R-ui", "R-fix"]) {
      const git = gitIn(page, "GitObserved", sid);
      expect(git, sid).toHaveLength(1);
      expect(git[0].payload.git).toMatchObject({ state: "repo", topLevel: repo, branch: "main" });
      const c = gitIn(page, "GitCollisions", sid);
      expect(c, sid).toHaveLength(1);
      expect(c[0].payload.collisions.sharp).toEqual([expect.objectContaining({ files: ["src/app.ts"] })]);
    }
    // Nothing for the session the ring holds no event of, and nothing logged.
    expect(gitIn(page, "GitObserved", "noise")).toEqual([]);

    // A second page finds them in the ring now, so nothing more is pushed.
    const count = (events: Env[]) => events.filter(e => /^Git(Observed|Collisions)$/.test(e.payload?.hook_event_name ?? "")).length;
    const inRing = count(await ring());
    const second = await freshPage();
    expect(count(await ring())).toBe(inRing);
    expect(gitIn(second, "GitCollisions", "R-fix")).toHaveLength(1);
  });

  it("is sent nothing again when the ring has dropped nothing it had not seen", async () => {
    const all = await ring();
    const last = all[all.length - 1].seq;
    const count = () => ring().then(r => r.length);
    const n = await count();
    // A page that has seen everything up to now reconnects.
    await new Promise<void>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/events", method: "GET", headers: { accept: "text/event-stream", "x-ccdeck-token": hookToken(), "last-event-id": String(last) } }, res => {
        streams.push(res);
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { if (chunk.includes("replay-end")) { res.destroy(); resolve(); } });
      });
      req.on("error", reject);
      req.end();
    });
    expect(await count()).toBe(n);
  });
});
