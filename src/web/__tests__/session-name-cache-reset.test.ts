// A cache that gates an emit, and the two things that are supposed to reset it.
//
// maybeResolveSessionName only pushes SessionNamed when the signature CHANGES:
//
//     if (nameBySession.get(sid) === sig) return;
//
// which is right — the records are re-written about once per turn and 685 of
// them in one transcript carried 2 distinct values. It makes the cache
// load-bearing, though: anything that discards the name on the client without
// clearing the server's copy loses it for that session permanently.
//
// Two things did exactly that.
//
// forgetSession, the LRU eviction, deleted nine per-session maps and not these
// two — they were added later and the list was not updated. The leak is the
// smaller half (every sibling is capped at MAX_TRACKED_SESSIONS and these two
// were not); the functional half is that an evicted live session re-emits its
// model, because modelBySession WAS cleared, and never re-emits its name.
//
// POST /api/clear emptied the ring and pushed __clear, which makes the reducer
// return a fresh state — dropping sessionName and sessionTitle for every
// session — while nameBySession kept the signature. The next scan computed the
// same one, took the early return, and the card fell back to cwd/prompt for the
// rest of that session while the server sat on the name.
//
// Driven the way the deck drives it: a real server, hook events in, envelopes
// out. The cache is not exported and does not need to be — SessionNamed on the
// wire is the observable, and it is the thing that was missing.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-name-cache-"));
const prevEnv = { ...process.env };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");

// @ts-expect-error — .mjs server module, no types
const { hookToken, startServer } = await import("../../server/index.mjs");

// Under $CLAUDE_CONFIG_DIR/projects, where Claude Code writes transcripts:
// since #674 the deck refuses to open a posted `transcript_path` outside it, so
// a fixture in the bare temp dir would never be read and no name would land.
const PROJECTS = join(DIR, "claude", "projects", "-tmp-name-cache");
const TRANSCRIPT = join(PROJECTS, "named.jsonl");
const NAME = "account-management-oauth-flow";
const TITLE = "Inspect repository to understand current state";

let server: Server;
let port = 0;
let token = "";

beforeAll(async () => {
  mkdirSync(PROJECTS, { recursive: true });
  writeFileSync(TRANSCRIPT, [
    JSON.stringify({ type: "ai-title", aiTitle: TITLE }),
    JSON.stringify({ type: "agent-name", agentName: NAME }),
  ].join("\n") + "\n");
  const started = await startServer({ port: 0, workspace: "", codex: false });
  server = started.server ?? started;
  // /api/clear is a protected mutation. The hook route is not — hooks post with
  // no Origin at all — which is why only this one needs the header.
  token = hookToken();
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>(done => server.close(() => done()));
  for (const k of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  rmTempDir(DIR);
});

function post(path: string, body: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = request(
      { host: "127.0.0.1", port, path, method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(data),
          ...(token ? { "x-ccdeck-token": token } : {}),
        } },
      res => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); },
    );
    req.on("error", reject);
    req.end(data);
  });
}

function events(): Promise<{ payload: { hook_event_name?: string; session_id?: string } }[]> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/api/events", method: "GET", headers: { "x-ccdeck-token": token } }, res => {
      let raw = "";
      res.setEncoding("utf8").on("data", c => { raw += c; });
      res.on("end", () => { try { resolve(JSON.parse(raw).events ?? JSON.parse(raw)); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    req.end();
  });
}

const named = async (sid: string) =>
  (await events()).filter(e => e.payload?.hook_event_name === "SessionNamed" && e.payload?.session_id === sid).length;

/** One hook event for `sid`, which is what provokes the naming scan. */
const speak = (sid: string) =>
  post("/api/event", { hook_event_name: "UserPromptSubmit", session_id: sid, cwd: DIR, transcript_path: TRANSCRIPT, prompt: "go" });

/** The scan is async and pushes on its own; wait for the envelope rather than
 *  for a clock. */
async function untilNamed(sid: string, want: number) {
  for (let i = 0; i < 200; i++) {
    if (await named(sid) >= want) return;
    await new Promise(r => setTimeout(r, 25));
  }
  expect(await named(sid), `SessionNamed for ${sid} never reached ${want}`).toBeGreaterThanOrEqual(want);
}

describe("the name survives nothing, and comes back", () => {
  it("is emitted once for a session, not once per turn", async () => {
    await speak("s1");
    await untilNamed("s1", 1);
    await speak("s1");
    await new Promise(r => setTimeout(r, 100));
    // The change gate doing its job — this is what makes the cache load-bearing
    // and is the reason the two cases below matter.
    expect(await named("s1")).toBe(1);
  });

  it("is emitted again after a clear, because the client just forgot it", async () => {
    await speak("s2");
    await untilNamed("s2", 1);

    expect(await post("/api/clear", {})).toBe(200);
    // The ring is empty now, so the count restarts from zero — which is the
    // point: the client's state was reset and the server has to say the name
    // again.
    expect(await named("s2")).toBe(0);

    await speak("s2");
    await untilNamed("s2", 1);
  });
});
