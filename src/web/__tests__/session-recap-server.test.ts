// Claude Code's recap through a real server, on both roads it can take.
//
// The recap is written into a silence: three minutes after a turn ended, with
// the terminal out of focus and no hook firing. A deck that only read the
// transcript on hook events would find it when the NEXT turn starts, which is
// the moment it stops being true. So it has two roads onto the wire — the
// transcript cursor that every hook event already drives, and the output watch
// that stats the file between events — and these drive both the way the deck
// is driven: hook events in, transcript lines appended, envelopes out.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-recap-"));
const prevEnv = { ...process.env };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");

// @ts-expect-error — .mjs server module, no types
const { hookToken, startServer } = await import("../../server/index.mjs");

// Under $CLAUDE_CONFIG_DIR/projects: since #674 the deck opens no posted
// `transcript_path` outside it.
const PROJECTS = join(DIR, "claude", "projects", "-tmp-recap");
const T0 = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const RECAP = (content: string, at: number) => JSON.stringify({
  type: "system", subtype: "away_summary", isSidechain: false, content, timestamp: iso(at),
}) + "\n";
const ASSISTANT = (at: number) => JSON.stringify({
  type: "assistant", isSidechain: false, timestamp: iso(at), message: { content: [{ type: "text", text: "on it" }] },
}) + "\n";

let server: Server;
let port = 0;
let token = "";

beforeAll(async () => {
  mkdirSync(PROJECTS, { recursive: true });
  const started = await startServer({ port: 0, workspace: "", codex: false });
  server = started.server ?? started;
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

type Payload = { hook_event_name?: string; session_id?: string; recap?: { text: string; at: number } | null };

function events(): Promise<{ payload: Payload }[]> {
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

const of = async (sid: string, kind: string) =>
  (await events()).filter(e => e.payload?.hook_event_name === kind && e.payload?.session_id === sid).map(e => e.payload);
const recaps = async (sid: string) => (await of(sid, "SessionRecapped")).map(p => p.recap);

/** The scans and the watch push on their own; wait for the envelope, not a clock. */
async function until(sid: string, kind: string, want: number, nudge?: () => void) {
  for (let i = 0; i < 400; i++) {
    if ((await of(sid, kind)).length >= want) return;
    nudge?.();
    await new Promise(r => setTimeout(r, 25));
  }
  expect((await of(sid, kind)).length, `${kind} for ${sid} never reached ${want}`).toBeGreaterThanOrEqual(want);
}

/** The idle prompt — a hook event carrying the transcript path, which is how
 *  the deck learns where the file is. */
const idle = (sid: string, transcript: string) => post("/api/event", {
  hook_event_name: "Notification", notification_type: "idle_prompt", message: "Claude is waiting for your input",
  session_id: sid, cwd: DIR, transcript_path: transcript,
});

/** Past MODEL_READ_THROTTLE_MS, so the next hook event reads the file again. */
const pastThrottle = () => new Promise(r => setTimeout(r, 2700));

describe("a recap reaches the wire", () => {
  it("off the transcript cursor, when a hook event has the file read", async () => {
    const t = join(PROJECTS, "cursor.jsonl");
    writeFileSync(t, ASSISTANT(T0 - 240_000) + RECAP("Planned. (disable recaps in /config)", T0));
    await idle("cursor", t);
    await until("cursor", "SessionRecapped", 1);
    expect(await recaps("cursor")).toEqual([{ text: "Planned.", at: T0 }]);
  });

  it("off the watch, when it lands in a silence with no hook at all", async () => {
    const t = join(PROJECTS, "watch.jsonl");
    writeFileSync(t, ASSISTANT(T0 - 240_000));
    await idle("watch", t);
    // The watch's first look at a file only records where it ends, and a recap
    // written before that look would be history to it. A real one lands
    // minutes later; here, wait until the watch has demonstrably read a tail.
    let n = 0;
    await until("watch", "OutputObserved", 1, () => { if (++n % 20 === 0) appendFileSync(t, ASSISTANT(Date.now())); });
    expect(await recaps("watch")).toEqual([]);
    appendFileSync(t, RECAP("Waiting on you.", T0 + 1000));
    await until("watch", "SessionRecapped", 1);
    expect(await recaps("watch")).toEqual([{ text: "Waiting on you.", at: T0 + 1000 }]);
  }, 25_000);

  it("once, and then null when the next turn retires it", async () => {
    const t = join(PROJECTS, "retire.jsonl");
    writeFileSync(t, RECAP("Done for now.", T0));
    await idle("retire", t);
    await until("retire", "SessionRecapped", 1);
    await pastThrottle();
    await idle("retire", t);
    await new Promise(r => setTimeout(r, 300));
    expect(await recaps("retire"), "the same recap, read again, was sent again").toHaveLength(1);
    appendFileSync(t, ASSISTANT(T0 + 60_000));
    await pastThrottle();
    await post("/api/event", { hook_event_name: "UserPromptSubmit", session_id: "retire", cwd: DIR, transcript_path: t, prompt: "go" });
    await until("retire", "SessionRecapped", 2);
    expect(await recaps("retire")).toEqual([{ text: "Done for now.", at: T0 }, null]);
  }, 25_000);

  it("never, for a session that never had one", async () => {
    const t = join(PROJECTS, "quiet.jsonl");
    writeFileSync(t, ASSISTANT(T0));
    await idle("quiet", t);
    await new Promise(r => setTimeout(r, 500));
    expect(await recaps("quiet")).toEqual([]);
  });
});
