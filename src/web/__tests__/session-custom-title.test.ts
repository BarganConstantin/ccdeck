// The name the user gave a session, with /rename or `--name`, is the one
// Claude Code prints in its prompt separator, and the rail showed the folder
// instead (owner, 2026-11-10). Claude Code keeps it in the transcript as a
// whole-line record, and a rename appends another:
//
//   {"type":"custom-title","customTitle":"loroloop","sessionId":"…"}
//
// The deck reads it on the transcript cursor beside `agent-name` and `ai-title`
// (transcript-scan.mjs), and sends it as the session's name ahead of the name
// Claude Code made up. The fixtures are built here; no real transcript is read.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-custom-title-"));
const prevEnv = { ...process.env };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");

// @ts-expect-error — .mjs server module, no types
const { foldSessionNamingLine, hookToken, startServer } = await import("../../server/index.mjs");

const CUSTOM = (n: string) => JSON.stringify({ type: "custom-title", customTitle: n, sessionId: "s1" });
const NAME = (n: string) => JSON.stringify({ type: "agent-name", agentName: n, sessionId: "s1" });
const TITLE = (t: string) => JSON.stringify({ type: "ai-title", aiTitle: t, sessionId: "s1" });

/** A chunk of transcript folded line at a time, as the scan folds it. */
function naming(text: string): Record<string, string | null> {
  const out: Record<string, string | null> = { aiTitle: null, agentName: null };
  for (const line of text.split("\n")) foldSessionNamingLine(out, line);
  return out;
}

describe("the custom-title record", () => {
  it("is read beside the other two", () => {
    expect(naming([TITLE("Fix the login page"), NAME("login-page-fix"), CUSTOM("loroloop")].join("\n")))
      .toEqual({ aiTitle: "Fix the login page", agentName: "login-page-fix", customTitle: "loroloop" });
  });

  it("takes the newest of several, as a rename appends one", () => {
    expect(naming([CUSTOM("loroloop"), TITLE("t"), CUSTOM("ccdeck v4")].join("\n")).customTitle).toBe("ccdeck v4");
  });

  it("is kept across chunks until a later one replaces it", () => {
    const out: Record<string, string | null> = { aiTitle: null, agentName: null };
    foldSessionNamingLine(out, CUSTOM("loroloop"));
    foldSessionNamingLine(out, TITLE("Later sentence"));
    expect(out.customTitle).toBe("loroloop");
    foldSessionNamingLine(out, CUSTOM("ccdeck v4"));
    expect(out.customTitle).toBe("ccdeck v4");
  });

  it("skips an empty, blank or non-string value, a truncated record and prose that mentions it", () => {
    const whole = CUSTOM("loroloop");
    const text = [
      JSON.stringify({ type: "custom-title", customTitle: "", sessionId: "s1" }),
      JSON.stringify({ type: "custom-title", customTitle: "   ", sessionId: "s1" }),
      JSON.stringify({ type: "custom-title", customTitle: 7, sessionId: "s1" }),
      whole.slice(0, whole.length - 8),
      JSON.stringify({ type: "user", message: { content: 'the "custom-title" record' } }),
    ].join("\n");
    expect(naming(text)).toEqual({ aiTitle: null, agentName: null });
  });
});

// ── on the wire ─────────────────────────────────────────────────────────────

const PROJECTS = join(DIR, "claude", "projects", "-tmp-custom-title");
const TRANSCRIPT = join(PROJECTS, "renamed.jsonl");
let server: Server;
let port = 0;
let token = "";

beforeAll(async () => {
  mkdirSync(PROJECTS, { recursive: true });
  writeFileSync(TRANSCRIPT, [TITLE("Fix the login page"), NAME("login-page-fix"), CUSTOM("loroloop")].join("\n") + "\n");
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
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } },
      res => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); },
    );
    req.on("error", reject);
    req.end(data);
  });
}

type Named = { hook_event_name?: string; session_id?: string; sessionName?: string | null; sessionTitle?: string | null };

function namedEvents(sid: string): Promise<Named[]> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/api/events", method: "GET", headers: { "x-ccdeck-token": token } }, res => {
      let raw = "";
      res.setEncoding("utf8").on("data", c => { raw += c; });
      res.on("end", () => {
        try {
          const all = (JSON.parse(raw).events ?? JSON.parse(raw)) as { payload: Named }[];
          resolve(all.map(e => e.payload).filter(p => p?.hook_event_name === "SessionNamed" && p.session_id === sid));
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

const speak = (sid: string) =>
  post("/api/event", { hook_event_name: "UserPromptSubmit", session_id: sid, cwd: DIR, transcript_path: TRANSCRIPT, prompt: "go" });

async function untilNamed(sid: string, want: number): Promise<Named[]> {
  for (let i = 0; i < 200; i++) {
    const got = await namedEvents(sid);
    if (got.length >= want) return got;
    await new Promise(r => setTimeout(r, 25));
  }
  const got = await namedEvents(sid);
  expect(got.length, `SessionNamed for ${sid} never reached ${want}`).toBeGreaterThanOrEqual(want);
  return got;
}

describe("the session's name on the wire", () => {
  it("is the user's name, ahead of the one Claude Code made up, and follows a rename", async () => {
    await speak("renamed");
    const first = await untilNamed("renamed", 1);
    expect(first[0]).toMatchObject({ sessionName: "loroloop", sessionTitle: "Fix the login page" });

    // The user renames the running session: Claude Code appends a record. The
    // naming read is throttled per session, so the next turn's hook is what
    // carries it, once the throttle has let go.
    appendFileSync(TRANSCRIPT, CUSTOM("ccdeck v4") + "\n" + NAME("login-page-fix") + "\n");
    await new Promise(r => setTimeout(r, 2_700));
    await speak("renamed");
    const after = await untilNamed("renamed", 2);
    expect(after.at(-1)).toMatchObject({ sessionName: "ccdeck v4", sessionTitle: "Fix the login page" });
  }, 15_000);
});
