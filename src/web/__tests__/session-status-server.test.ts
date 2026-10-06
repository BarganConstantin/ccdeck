// The status line through a real server, from both of its sources.
//
// The activity line comes off the output watch, which reads a transcript
// BETWEEN hook events — the model writes "Now I'll run the tests" with no hook
// firing at all. A background job's line comes off Claude Code's own job
// folder, which no hook ever names. So these drive the deck the way it is
// driven — a hook event to say where the session is, then files written under
// $CLAUDE_CONFIG_DIR — and read the envelopes it sends. session-status.test.ts
// pins the rules one function at a time.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-status-"));
const prevEnv = { ...process.env };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");

// @ts-expect-error — .mjs server module, no types
const { hookToken, startServer } = await import("../../server/index.mjs");

const PROJECTS = join(DIR, "claude", "projects", "-tmp-status");
const JOBS = join(DIR, "claude", "jobs");
const iso = (ms: number) => new Date(ms).toISOString();
const ASSISTANT = (id: string, at: number, ...content: unknown[]) => JSON.stringify({
  type: "assistant", isSidechain: false, timestamp: iso(at), message: { id, content },
}) + "\n";

let server: Server;
let port = 0;
let token = "";

beforeAll(async () => {
  mkdirSync(PROJECTS, { recursive: true });
  mkdirSync(JOBS, { recursive: true });
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

type Payload = { hook_event_name?: string; session_id?: string; activity?: { text: string } | null; job?: Record<string, unknown> | null };

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

/** The watches push on their own; wait for the envelope, not a clock. */
async function until(sid: string, kind: string, want: number, nudge?: () => void) {
  for (let i = 0; i < 600; i++) {
    if ((await of(sid, kind)).length >= want) return;
    nudge?.();
    await new Promise(r => setTimeout(r, 25));
  }
  expect((await of(sid, kind)).length, `${kind} for ${sid} never reached ${want}`).toBeGreaterThanOrEqual(want);
}

/** A prompt, carrying the transcript path — how the deck learns the session
 *  exists and where its file is. */
const prompt = (sid: string, transcript: string) => post("/api/event", {
  hook_event_name: "UserPromptSubmit", prompt: "go", session_id: sid, cwd: DIR, transcript_path: transcript,
});

const writeJob = (id: string, body: Record<string, unknown>) => {
  mkdirSync(join(JOBS, id), { recursive: true });
  writeFileSync(join(JOBS, id, "state.json"), JSON.stringify(body));
};

describe("the activity line reaches the wire", () => {
  it("off the output watch, while no hook fires, and the sentence outranks its call", async () => {
    const sid = "act";
    const t = join(PROJECTS, "act.jsonl");
    writeFileSync(t, "");
    await prompt(sid, t);
    // The watch's first look only records where the file ends. Wait until it
    // has demonstrably read a tail before writing the reply under test.
    let n = 0;
    await until(sid, "OutputObserved", 1, () => {
      if (++n % 20 === 0) appendFileSync(t, ASSISTANT(`warm-${n}`, Date.now(), { type: "thinking", thinking: "…" }));
    });
    const now = Date.now();
    appendFileSync(t,
      ASSISTANT("m1", now, { type: "text", text: "Now I'll run the API tests." })
      + ASSISTANT("m1", now + 10, { type: "tool_use", name: "Bash", input: { command: "npm test", description: "Run the API tests" } }));
    await until(sid, "ActivityObserved", 1);
    expect((await of(sid, "ActivityObserved")).map(p => p.activity?.text)).toEqual(["Now I'll run the API tests."]);

    appendFileSync(t, ASSISTANT("m2", now + 5000, { type: "tool_use", name: "Read", input: { file_path: "/r/src/reducer.ts" } }));
    await until(sid, "ActivityObserved", 2);
    expect((await of(sid, "ActivityObserved")).map(p => p.activity?.text)).toEqual([
      "Now I'll run the API tests.", "Reading reducer.ts",
    ]);
  }, 30_000);
});

describe("a background job's line reaches the wire", () => {
  it("once per change of words, and null when the job is gone", async () => {
    const sid = "bg-1";
    const t = join(PROJECTS, "bg-1.jsonl");
    writeFileSync(t, "");
    writeJob("f2d33397", {
      state: "blocked", detail: "Merge PR #29?", needs: "Merge PR #29 so ChatGPT can connect?",
      suggestedReply: "merge it", sessionId: sid, updatedAt: iso(Date.now()),
    });
    await prompt(sid, t);
    await until(sid, "JobObserved", 1);
    expect((await of(sid, "JobObserved"))[0].job).toMatchObject({
      id: "f2d33397", state: "blocked", needs: "Merge PR #29 so ChatGPT can connect?", suggestedReply: "merge it",
    });

    // The classifier rewrites the clock every fifteen seconds of a working turn,
    // mostly to say the same thing. Same words, no event.
    writeJob("f2d33397", {
      state: "blocked", detail: "Merge PR #29?", needs: "Merge PR #29 so ChatGPT can connect?",
      suggestedReply: "merge it", sessionId: sid, updatedAt: iso(Date.now() + 15_000),
    });
    await new Promise(r => setTimeout(r, 3500));
    expect(await of(sid, "JobObserved")).toHaveLength(1);

    writeJob("f2d33397", {
      state: "done", detail: "merged", sessionId: sid, updatedAt: iso(Date.now() + 30_000),
      output: { result: "PR #29 merged; ChatGPT connects." },
    });
    await until(sid, "JobObserved", 2);
    expect((await of(sid, "JobObserved"))[1].job).toMatchObject({ state: "done", result: "PR #29 merged; ChatGPT connects." });

    rmSync(join(JOBS, "f2d33397"), { recursive: true });
    await until(sid, "JobObserved", 3);
    expect((await of(sid, "JobObserved"))[2].job).toBeNull();
  }, 40_000);

  it("never, for a session that is not a background job", async () => {
    const sid = "plain";
    const t = join(PROJECTS, "plain.jsonl");
    writeFileSync(t, "");
    await prompt(sid, t);
    await new Promise(r => setTimeout(r, 3500));
    expect(await of(sid, "JobObserved")).toEqual([]);
  }, 10_000);
});
