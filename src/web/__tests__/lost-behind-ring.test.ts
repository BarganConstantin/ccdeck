// Two kinds of thing a page loses when it connects behind the ring's head, and
// the deck keeps both: a session's model, name and usage (folded as the ring
// evicts them) and its card's branch and collisions (kept by the git
// watchers). Each is handed back ahead of the replay under its own seq. Both
// are asked for against one cut-off, the oldest seq the ring still holds: a
// lookup that took its cut-off from the other's oldest value would drop every
// value of its own that sits between that value and the ring's head. So the
// two kinds are interleaved here, in time, and every one of them has to
// arrive. Through the real server, real repositories, and read back through
// the real reducer.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { request, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
import { repoWith, tempDir, write } from "./git-fixture";
import { applyEvent, initialState } from "../reducer";
import type { HookEnvelope } from "../types";

const DIR = tempDir("ccdeck-lost-behind-");
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
const streams: IncomingMessage[] = [];
let server: Server;
let port = 0;
type Env = HookEnvelope & { seq: number; receivedAt: number; payload: any; replay?: boolean };

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
const post = async (p: Record<string, unknown>): Promise<number> => (await call("POST", "/api/event", p)).body.seq;
const ring = async (): Promise<Env[]> => (await call("GET", "/api/events?since=0")).body;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until<T>(get: () => Promise<T | undefined>, what: string, ms = 8_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await get();
    if (v !== undefined) return v;
    await sleep(50);
  }
  throw new Error(`gave up waiting for ${what}`);
}

/** One SSE frame block's field. */
const fieldOf = (block: string, name: string) => block.split("\n").find(l => l.startsWith(`${name}: `))?.slice(name.length + 2) ?? null;

/** A page: an SSE stream, with or without a Last-Event-ID, read to `replay-end`. */
function page(lastEventId?: number): Promise<Env[]> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { accept: "text/event-stream", "x-ccdeck-token": hookToken() };
    if (lastEventId !== undefined) headers["last-event-id"] = String(lastEventId);
    const req = request({ host: "127.0.0.1", port, path: "/events", method: "GET", headers }, res => {
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
          if (fieldOf(block, "event") === "replay-end") { res.destroy(); resolve(got); return; }
          if (fieldOf(block, "event") === "hook") got.push(JSON.parse(fieldOf(block, "data") ?? "null"));
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

/** A page already connected and caught up: every live frame it is sent. */
function livePage(): { frames: Env[]; ready: Promise<void> } {
  const frames: Env[] = [];
  let live = false;
  const ready = new Promise<void>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/events", method: "GET", headers: { accept: "text/event-stream", "x-ccdeck-token": hookToken(), "last-event-id": String(eventBufferStats().newestSeq) } }, res => {
      streams.push(res);
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", chunk => {
        buffer += chunk;
        for (;;) {
          const end = buffer.indexOf("\n\n");
          if (end === -1) break;
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (fieldOf(block, "event") === "replay-end") { live = true; resolve(); continue; }
          if (live && fieldOf(block, "event") === "hook") frames.push(JSON.parse(fieldOf(block, "data") ?? "null"));
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
  return { frames, ready };
}

/** Push `count` hook events of a session nobody looks at through the real ring. */
let noiseFile = 0;
async function noise(count: number): Promise<void> {
  const path = join(DIR, `noise-${noiseFile++}.jsonl`);
  writeFileSync(path, Array.from({ length: count }, (_, i) => JSON.stringify({
    seq: i + 1, epoch: "fixture", receivedAt: Date.now(), source: "hook",
    payload: { hook_event_name: i % 2 ? "PostToolUse" : "PreToolUse", session_id: "noise", tool_name: "Read", tool_use_id: `n${noiseFile}-${i >> 1}` },
  })).join("\n") + "\n", "utf8");
  await replayLog(path, "", { maxEvents: 1e6, maxEntries: 1e6, maxChars: 1e9 });
}

const usage = (input: number) => ({ input_tokens: input, output_tokens: 900, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
const GIT = /^Git(Observed|Collisions)$/;
const ENRICH = /^(ModelObserved|SessionNamed|UsageObserved)$/;
const kept = (e: Env) => GIT.test(e.payload?.hook_event_name ?? "") || ENRICH.test(e.payload?.hook_event_name ?? "");

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

describe("a page that connects behind the ring's head, when git state and enrichment both fell off it", () => {
  const SIDS = ["L-ui", "L-fix"] as const;
  let repo = "";
  /** The newest of each kept kind per session, as the ring held it before the noise. */
  let newest = new Map<string, Env>();

  beforeAll(async () => {
    repo = repoWith({ "src/app.ts": "app\n" }, "ccdeck-lost-behind-");
    made.push(repo);
    // Git first: each card's branch…
    for (const sid of SIDS) await post({ hook_event_name: "SessionStart", session_id: sid, cwd: repo });
    for (const sid of SIDS) {
      await until(async () => (await ring()).find(e => e.payload?.hook_event_name === "GitObserved" && e.payload.session_id === sid), `${sid}'s branch`);
    }
    // …then the model and the name, which sit after the branch…
    for (const sid of SIDS) {
      await post({ hook_event_name: "ModelObserved", session_id: sid, model: sid === "L-ui" ? "claude-sonnet-5-5" : "claude-opus-5-5", subagentModels: {} });
      await post({ hook_event_name: "SessionNamed", session_id: sid, sessionName: `${sid}-name`, sessionTitle: `Work on ${sid}` });
      await post({ hook_event_name: "UsageObserved", session_id: sid, usage: usage(1_000), usageByModel: null });
    }
    // …then git again: both edit one file, so each is marked as colliding and
    // its branch says the edit made it stale…
    for (const [i, sid] of SIDS.entries()) {
      write(repo, { "src/app.ts": `${sid}\n` });
      await post({ hook_event_name: "PostToolUse", session_id: sid, cwd: repo, tool_name: "Edit", tool_input: { file_path: join(repo, "src/app.ts") }, tool_response: { success: true }, tool_use_id: `toolu_l${i}` });
    }
    await until(async () => (await ring()).find(e => e.payload?.hook_event_name === "GitCollisions" && e.payload.session_id === "L-fix" && e.payload.collisions?.sharp?.length === 1), "the sharp collision");
    for (const sid of SIDS) {
      await until(async () => (await ring()).find(e => e.payload?.hook_event_name === "GitObserved" && e.payload.session_id === sid && e.payload.git?.stale >= 1), `${sid}'s stale mark`);
    }
    await sleep(700);
    // …and the usage last, after every git value.
    for (const sid of SIDS) await post({ hook_event_name: "UsageObserved", session_id: sid, usage: usage(sid === "L-ui" ? 12_000 : 18_000), usageByModel: null });

    newest = new Map();
    for (const e of await ring()) {
      if (!kept(e) || !SIDS.includes(e.payload.session_id)) continue;
      newest.set(`${e.payload.session_id}|${e.payload.hook_event_name}`, e);
    }
    // A busy deck: every one of those leaves the ring, while each session
    // does one thing more that the ring keeps, so its card is drawn.
    await noise(MAX_BUFFER + 100);
    for (const sid of SIDS) await post({ hook_event_name: "PreToolUse", session_id: sid, cwd: repo, tool_name: "Read", tool_use_id: `toolu_r-${sid}` });
  });

  it("is the case: the two kinds interleave in time and none of them is in the ring", async () => {
    expect([...newest.keys()].sort()).toEqual(SIDS.flatMap(sid => [
      `${sid}|GitCollisions`, `${sid}|GitObserved`, `${sid}|ModelObserved`, `${sid}|SessionNamed`, `${sid}|UsageObserved`,
    ]).sort());
    const seq = (sid: string, name: string) => newest.get(`${sid}|${name}`)!.seq;
    for (const sid of SIDS) {
      // A model older than the newest git value, a usage newer than it.
      expect(seq(sid, "ModelObserved")).toBeLessThan(seq(sid, "GitObserved"));
      expect(seq(sid, "UsageObserved")).toBeGreaterThan(seq(sid, "GitObserved"));
      expect(seq(sid, "UsageObserved")).toBeGreaterThan(seq(sid, "GitCollisions"));
    }
    const held = await ring();
    expect(held.filter(e => SIDS.includes(e.payload?.session_id) && kept(e))).toEqual([]);
    expect(held.filter(e => SIDS.includes(e.payload?.session_id)).map(e => e.payload.hook_event_name)).toEqual(["PreToolUse", "PreToolUse"]);
  });

  it("hands it every git value and every enrichment value, each once, under its own seq and time", async () => {
    const watcher = livePage();
    await watcher.ready;
    const connectedAt = Date.now();
    const got = await page();
    const oldest = eventBufferStats().oldestSeq;
    const lost = got.filter(e => e.seq < oldest);
    // In front of the replay, oldest first, every one a replay frame.
    expect(got.slice(0, lost.length)).toEqual(lost);
    expect(lost.map(e => e.seq)).toEqual([...lost.map(e => e.seq)].sort((a, b) => a - b));
    expect(new Set(lost.map(e => e.seq)).size).toBe(lost.length);
    expect(lost.every(e => e.replay === true)).toBe(true);
    // Exactly the newest of each kind, for each session: its seq and its time.
    const mine = lost.filter(e => SIDS.includes(e.payload?.session_id));
    expect(mine.map(e => `${e.payload.session_id}|${e.payload.hook_event_name}`).sort()).toEqual([...newest.keys()].sort());
    for (const e of mine) {
      const was = newest.get(`${e.payload.session_id}|${e.payload.hook_event_name}`)!;
      expect(e.seq, `${e.payload.session_id} ${e.payload.hook_event_name}`).toBe(was.seq);
      expect(e.receivedAt, `${e.payload.session_id} ${e.payload.hook_event_name}`).toBe(was.receivedAt);
      expect(e.receivedAt).toBeLessThan(connectedAt);
    }
    // The page already open is sent none of it.
    await sleep(200);
    expect(watcher.frames.filter(kept)).toEqual([]);
  });

  it("leaves every card with its branch, its collision, its model, its name and its usage", async () => {
    let state = initialState();
    for (const e of await page()) state = applyEvent(state, e);
    for (const sid of SIDS) {
      const a = state.agents.get(sid)!;
      expect(a.git, sid).toMatchObject({ state: "repo", branch: "main" });
      expect(a.gitCollisions?.sharp, sid).toEqual([expect.objectContaining({ files: ["src/app.ts"] })]);
      expect(a.model, sid).toBe(sid === "L-ui" ? "claude-sonnet-5-5" : "claude-opus-5-5");
      expect(a.sessionName, sid).toBe(`${sid}-name`);
      expect(a.usage.inputTokens, sid).toBe(sid === "L-ui" ? 12_000 : 18_000);
    }
    expect(state.parkedEnrichment.size).toBe(0);
    expect(state.parkedGit.size).toBe(0);
  });

  it("sends a page that saw part of it only the rest, and a caught-up page nothing", async () => {
    const cut = newest.get("L-ui|GitObserved")!.seq;
    const oldest = eventBufferStats().oldestSeq;
    const rest = (await page(cut)).filter(e => e.seq < oldest && SIDS.includes(e.payload?.session_id));
    expect(rest.length).toBeGreaterThan(0);
    expect(rest.every(e => e.seq > cut)).toBe(true);
    expect(rest.map(e => `${e.payload.session_id}|${e.payload.hook_event_name}`).sort())
      .toEqual([...newest.entries()].filter(([, e]) => e.seq > cut).map(([k]) => k).sort());
    expect(await page(eventBufferStats().newestSeq)).toEqual([]);
  });
});
