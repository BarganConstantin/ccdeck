// A session's model, name, usage, context, activity line and job are sent when
// they change, and an idle session sends none of them again. The ring keeps
// the newest MAX_BUFFER hook events, so on a busy deck the events that carried
// them leave its head while the session's later hook events stay — and a
// reload or a second tab drew the card with no model, no name and stale usage.
// The deck now hands a page that connects behind the head the newest value of
// each, under its own seq, ahead of the replay. Through the real server, and
// read back through the real reducer.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
import { applyEvent, initialState } from "../reducer";
import type { HookEnvelope } from "../types";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-enrichment-behind-"));
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
// @ts-expect-error — plain .mjs server module, no types
const { evictedStats } = await import("../../server/evicted-enrichment.mjs");

const streams: IncomingMessage[] = [];
let server: Server;
let port = 0;
type Env = HookEnvelope & { seq: number; payload: any; replay?: boolean };

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
/** Post one event the way a hook does, and answer the seq it was given. */
const post = async (p: Record<string, unknown>): Promise<number> => (await call("POST", "/api/event", p)).body.seq;
const ring = async (): Promise<Env[]> => (await call("GET", "/api/events?since=0")).body;

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

/** A page that stays connected, collecting every live frame after its replay. */
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
          const field = (name: string) => block.split("\n").find(l => l.startsWith(`${name}: `))?.slice(name.length + 2) ?? null;
          if (field("event") === "replay-end") { live = true; resolve(); continue; }
          if (live && field("event") === "hook") frames.push(JSON.parse(field("data") ?? "null"));
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
    payload: { hook_event_name: i % 2 ? "PostToolUse" : "PreToolUse", session_id: "noise", cwd: "/w/noise", tool_name: "Read", tool_use_id: `n${noiseFile}-${i >> 1}` },
  })).join("\n") + "\n", "utf8");
  await replayLog(path, "", { maxEvents: 1e6, maxEntries: 1e6, maxChars: 1e9 });
}

const usage = (input: number) => ({ input_tokens: input, output_tokens: 900, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });

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
  rmTempDir(DIR);
});

describe("a page that connects behind the ring's head", () => {
  let sent: Record<string, number> = {};
  let before = 0;

  beforeAll(async () => {
    // An idle session: everything about it was said at the start, then it
    // went quiet but for one event the ring still holds. A second session
    // whose every event leaves the ring, and a Codex-style session whose
    // model and window arrive on separate events.
    await post({ hook_event_name: "SessionStart", session_id: "idle", cwd: "/w/shop-api" });
    await post({ hook_event_name: "SessionStart", session_id: "gone", cwd: "/w/gone" });
    await post({ hook_event_name: "ModelObserved", session_id: "gone", model: "claude-haiku-4-5" });
    sent = {
      model: await post({ hook_event_name: "ModelObserved", session_id: "idle", model: "claude-opus-5-5", subagentModels: {} }),
      window: await post({ hook_event_name: "ModelObserved", session_id: "codex", provider: "codex", model: "gpt-5.6", model_context_window: 272_000 }),
      codexModel: await post({ hook_event_name: "ModelObserved", session_id: "codex", provider: "codex", model: "gpt-5.6-mini" }),
      usage1: await post({ hook_event_name: "UsageObserved", session_id: "idle", usage: usage(1_000), usageByModel: null }),
      name: await post({ hook_event_name: "SessionNamed", session_id: "idle", sessionName: "api-fix", sessionTitle: "Fix the login flow" }),
      context: await post({ hook_event_name: "ContextObserved", session_id: "idle", context: { msgsUser: 3, currentContextTokens: 41_000, memoryFiles: [{ path: "/w/CLAUDE.md", bytes: 9 }] } }),
      activity: await post({ hook_event_name: "ActivityObserved", session_id: "idle", activity: { text: "Reading the auth module", source: "said", at: Date.now() - 60_000 } }),
      job: await post({ hook_event_name: "JobObserved", session_id: "idle", job: { id: "j1", state: "done", detail: "tests pass", updatedAt: 5 } }),
      usage2: await post({ hook_event_name: "UsageObserved", session_id: "idle", usage: usage(18_000), usageByModel: { "claude-opus-5-5": usage(18_000) } }),
    };
    before = Date.now();
    await new Promise(r => setTimeout(r, 20));
    await noise(MAX_BUFFER - 50);
    await post({ hook_event_name: "Stop", session_id: "idle", cwd: "/w/shop-api" });
    await post({ hook_event_name: "PreToolUse", session_id: "codex", provider: "codex", cwd: "/w/shop-api-fix", tool_name: "Bash", tool_use_id: "c1" });
    await noise(100);
  });

  it("is the case: the session's card survives in the ring and its enrichment does not", async () => {
    const held = await ring();
    expect(held[0].seq).toBeGreaterThan(sent.usage2);
    expect(held.some(e => e.payload?.session_id === "idle" && e.payload.hook_event_name === "Stop")).toBe(true);
    expect(held.some(e => e.payload?.session_id === "idle" && e.payload.hook_event_name === "ModelObserved")).toBe(false);
  });

  it("hands a fresh page the newest value of each kind, under its own seq, ahead of the replay", async () => {
    const got = await page();
    const oldest = eventBufferStats().oldestSeq;
    const lost = got.filter(e => e.seq < oldest);
    // In front of everything the ring holds, oldest first, each marked as replay.
    expect(got.slice(0, lost.length)).toEqual(lost);
    expect(lost.map(e => e.seq)).toEqual([...lost.map(e => e.seq)].sort((a, b) => a - b));
    expect(lost.every(e => e.replay === true)).toBe(true);
    const idle = lost.filter(e => e.payload.session_id === "idle");
    expect(idle.map(e => [e.payload.hook_event_name, e.seq])).toEqual([
      ["ModelObserved", sent.model],
      ["SessionNamed", sent.name],
      ["ContextObserved", sent.context],
      ["ActivityObserved", sent.activity],
      ["JobObserved", sent.job],
      ["UsageObserved", sent.usage2],
    ]);
    // When it was received, not when it was handed over: the page must not
    // read an idle session as heard from just now.
    expect(idle.every(e => e.receivedAt <= before)).toBe(true);
    // Only the cards the page will draw.
    expect(lost.some(e => e.payload.session_id === "gone")).toBe(false);
    // Two Codex model events, folded into the one that leaves the card where both did.
    const codex = lost.filter(e => e.payload.session_id === "codex");
    expect(codex).toHaveLength(1);
    expect(codex[0].seq).toBe(sent.codexModel);
    expect(codex[0].payload).toMatchObject({ model: "gpt-5.6-mini", model_context_window: 272_000 });
  });

  it("leaves the page's cards with the model, the name and the usage a page that watched them has", async () => {
    const got = await page();
    let state = initialState();
    for (const e of got) state = applyEvent(state, e);
    const idle = state.agents.get("idle")!;
    expect(idle.model).toBe("claude-opus-5-5");
    expect(idle.sessionName).toBe("api-fix");
    expect(idle.sessionTitle).toBe("Fix the login flow");
    expect(idle.usage.inputTokens).toBe(18_000);
    expect(Object.keys(idle.usageByModel ?? {})).toEqual(["claude-opus-5-5"]);
    expect(idle.context?.currentContextTokens).toBe(41_000);
    expect(idle.activity?.text).toBe("Reading the auth module");
    expect(idle.job?.state).toBe("done");
    const codex = state.agents.get("codex")!;
    expect(codex.model).toBe("gpt-5.6-mini");
    expect(codex.contextWindow).toBe(272_000);
    expect(state.parkedEnrichment.size).toBe(0);
  });

  it("sends a page only what it was never sent", async () => {
    const after = await page(sent.name);
    const oldest = eventBufferStats().oldestSeq;
    expect(after.filter(e => e.seq < oldest).map(e => e.payload.hook_event_name).sort())
      .toEqual(["ActivityObserved", "ContextObserved", "JobObserved", "UsageObserved"]);
    const saw = await page(sent.usage2);
    expect(saw.filter(e => e.seq < oldest)).toEqual([]);
    const current = await page(eventBufferStats().newestSeq);
    expect(current).toEqual([]);
  });

  it("puts nothing in the ring, the log or the pages already connected", async () => {
    const watcher = livePage();
    await watcher.ready;
    const { newestSeq, events } = eventBufferStats();
    const logged = readFileSync(LOG, "utf8");
    await page();
    await new Promise(r => setTimeout(r, 200));
    expect(eventBufferStats().newestSeq).toBe(newestSeq);
    expect(eventBufferStats().events).toBe(events);
    expect(readFileSync(LOG, "utf8")).toBe(logged);
    expect(watcher.frames).toEqual([]);
  });

  it("forgets them with the ring on a Clear", async () => {
    expect(evictedStats().values).toBeGreaterThan(0);
    expect((await call("POST", "/api/clear")).status).toBe(200);
    expect(evictedStats()).toEqual({ sessions: 0, values: 0, chars: 0 });
    await post({ hook_event_name: "Stop", session_id: "idle", cwd: "/w/shop-api" });
    expect((await page()).some(e => e.payload?.hook_event_name === "ModelObserved")).toBe(false);
  });
});
