// Internal #101, through a real deck: a page names a session, every page hears
// it on SessionNamed as `deckName`, the name is kept in the deck's data folder,
// and a deck that restarts tells the session its name again the first time it
// hears from it.
//
// Scratch HOME, CCDECK_HOME, CLAUDE_CONFIG_DIR and CODEX_HOME: nothing here
// reads or writes a real deck's names or a provider's files.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-rename-101-"));
const prevEnv = { ...process.env };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CCDECK_HOME = join(DIR, "deck");
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");

// @ts-expect-error — .mjs server module, no types
const { hookToken, startServer } = await import("../../server/index.mjs");
// @ts-expect-error — .mjs server module, no types
const names = await import("../../server/session-deck-names.mjs");

const FILE = join(DIR, "deck", "session-names.json");
const SID = "5d1c0f6e-2b3a-4c5d-9e8f-101101101101";

let server: Server;
let port = 0;
let token = "";

beforeAll(async () => {
  names.resetDeckNamesForTest();
  const started = await startServer({ port: 0, workspace: "", codex: false });
  server = started.server ?? started;
  token = hookToken();
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>(done => server.close(() => done()));
  names.resetDeckNamesForTest();
  for (const k of ["HOME", "USERPROFILE", "CCDECK_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  rmTempDir(DIR);
});

type Reply = { status: number; body: { ok?: boolean; name?: string | null; reason?: string } | null };
function post(path: string, body: unknown, headers: Record<string, string> = { "x-ccdeck-token": token }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = request(
      { host: "127.0.0.1", port, path, method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), ...headers } },
      res => {
        let raw = "";
        res.setEncoding("utf8").on("data", c => { raw += c; });
        res.on("end", () => {
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch { /* not JSON */ }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

type Envelope = { payload: { hook_event_name?: string; session_id?: string; deckName?: string | null } };
function events(): Promise<Envelope[]> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/api/events", method: "GET", headers: { "x-ccdeck-token": token } }, res => {
      let raw = "";
      res.setEncoding("utf8").on("data", c => { raw += c; });
      res.on("end", () => { try { const j = JSON.parse(raw); resolve(j.events ?? j); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    req.end();
  });
}

/** The deck names told for SID, in order. */
const told = async (sid = SID) => (await events())
  .filter(e => e.payload?.hook_event_name === "SessionNamed" && e.payload.session_id === sid && "deckName" in e.payload)
  .map(e => e.payload.deckName);

const speak = (sid = SID) =>
  post("/api/event", { hook_event_name: "UserPromptSubmit", session_id: sid, cwd: DIR, prompt: "go" }, {});

async function until(check: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`never: ${what}`);
}

describe("naming a session through the deck (internal #101)", () => {
  it("saves a requested provider rename in the Claude transcript and in the deck", async () => {
    const sid = "5d1c0f6e-2b3a-4c5d-9e8f-101101101102";
    const project = join(DIR, "claude", "projects", "fixture");
    mkdirSync(project, { recursive: true });
    const transcript = join(project, sid + ".jsonl");
    writeFileSync(transcript, "{}\n");
    const result = await post("/api/session-name", { provider: "claude", sessionId: sid, name: "Planning", syncProvider: true });
    expect(result).toEqual({ status: 200, body: { ok: true, name: "Planning" } });
    expect(JSON.parse(readFileSync(transcript, "utf8").trim().split("\n").at(-1)!)).toEqual({ type: "custom-title", customTitle: "Planning", sessionId: sid });
    expect(names.deckNameFor("claude", sid)).toBe("Planning");
    await post("/api/session-name", { provider: "claude", sessionId: sid, name: null });
  });

  it("does not announce or save a local success when the provider rename fails", async () => {
    const sid = "5d1c0f6e-2b3a-4c5d-9e8f-101101101103";
    const result = await post("/api/session-name", { provider: "claude", sessionId: sid, name: "Missing", syncProvider: true });
    expect(result).toEqual({ status: 409, body: { ok: false, reason: "provider_name_not_saved" } });
    expect(names.deckNameFor("claude", sid)).toBeUndefined();
    expect(await told(sid)).toEqual([]);
  });

  it("keeps the name, answers it as kept, and tells every page", async () => {
    const r = await post("/api/session-name", { provider: "claude", sessionId: SID, name: "  Billing   fix " });
    expect(r).toEqual({ status: 200, body: { ok: true, name: "Billing fix" } });
    expect(await told()).toEqual(["Billing fix"]);
    expect(JSON.parse(readFileSync(FILE, "utf8")).names[`claude:${SID}`].name).toBe("Billing fix");
  });

  it("refuses a page of another site, and keeps nothing it sent", async () => {
    const r = await post("/api/session-name", { sessionId: SID, name: "Hijacked" }, { origin: "http://attacker.example" });
    expect(r.status).toBe(403);
    expect(await told()).toEqual(["Billing fix"]);
    expect(names.deckNameFor("claude", SID)).toBe("Billing fix");
  });

  it("answers 400 for a session id that could be a path", async () => {
    const r = await post("/api/session-name", { sessionId: "../../etc", name: "x" });
    expect(r).toEqual({ status: 400, body: { ok: false, reason: "bad_request" } });
  });

  it("tells a restarted deck's pages the name the first time the session speaks, once", async () => {
    // A restart, as far as the names and the log go: the file is read again by
    // a process that holds nothing, and the ring that held the announce is gone.
    names.resetDeckNamesForTest();
    expect((await post("/api/clear", {})).status).toBe(200);
    expect(await told()).toEqual([]);
    await names.loadDeckNames();

    expect((await speak()).status).toBe(200);
    await until(async () => (await told()).length >= 1, "the kept name is told");
    expect((await speak()).status).toBe(200);
    await new Promise(r => setTimeout(r, 100));
    expect(await told()).toEqual(["Billing fix"]);
  });

  it("clears the name with an empty one, tells the pages null, and forgets it on disk", async () => {
    const r = await post("/api/session-name", { sessionId: SID, name: "" });
    expect(r).toEqual({ status: 200, body: { ok: true, name: null } });
    expect((await told()).at(-1)).toBeNull();
    expect(JSON.parse(readFileSync(FILE, "utf8")).names).toEqual({});
  });

  it("says nothing about a session the reader never named", async () => {
    const other = "aaaaaaaa-1111-2222-3333-444444444444";
    expect((await speak(other)).status).toBe(200);
    await new Promise(r => setTimeout(r, 100));
    expect(await told(other)).toEqual([]);
    expect(existsSync(FILE)).toBe(true);
  });
});
