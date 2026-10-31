// The deck's record of what its Command Panel started (F6-R), through the real
// routes of a real deck (startServer) with a stand-in engine: the record comes
// only from the engine's own answers to a launch, an adopt or a claim; a case C
// target then carries `provenance` on every read — a reload, another tab — and
// nothing else the engine said changes: no ticket appears, no refusal becomes
// an answer, the question the engine is asked is the page's own. And the one
// door without the deck's token, `POST /api/event`, cannot write the record.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-panel-provenance-"));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.CCDECK_HOME = join(DIR, "deck");
process.env.XDG_CONFIG_HOME = join(DIR, "config");
process.env.XDG_DATA_HOME = join(DIR, "data");
process.env.XDG_STATE_HOME = join(DIR, "state");
process.env.CLAUDE_SWAP_BACKUP = join(DIR, "claude-swap");
if (!resolve(process.env.CLAUDE_CONFIG_DIR).startsWith(resolve(DIR))) throw new Error("sandbox escaped");
const PROJECT = join(DIR, "project");
mkdirSync(PROJECT);

// @ts-expect-error — plain .mjs server module, no types
const mod = await import("../../server/index.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { createTicketStore } = await import("../../server/terminal-socket.mjs");

const LAUNCHED = "4a1b2c3d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const ELSEWHERE = "5b2c3d4e-6f70-4b8c-9d0e-1f2a3b4c5d6e";
const FORGED = "6c3d4e5f-7081-4c9d-8e1f-2a3b4c5d6e7f";
const REFUSED = "7d4e5f60-8192-4dae-9f20-3b4c5d6e7f80";
const C_TARGET = { kind: "C", label: "This session was started outside the deck, so there is no pane to attach to.", adoptable: true };

let asked: Array<{ method: string; body: unknown }> = [];
/** What the stand-in engine answers, per route; edited per case. */
let answers: Record<string, { status: number; body: unknown }> = {};
const engine = {
  get enabled() { return true; },
  attach: () => ({ ok: false, status: 503 }),
  route: async (method: string, body: unknown) => {
    asked.push({ method, body });
    return answers[method] ?? { status: 409, body: { ok: false, error: "not here", code: "no-terminal" } };
  },
};

let server: Server;
let port = 0;
beforeAll(async () => {
  server = await mod.startServer({ port: 0, persist: false, claude: false, codex: false, terminal: { enabled: () => true, engine, tickets: createTicketStore() } });
  port = (server.address() as { port: number }).port;
}, 30_000);
beforeEach(() => {
  asked = [];
  answers = { target: { status: 200, body: { ok: true, target: C_TARGET } } };
});
afterAll(async () => {
  await new Promise(r => server.close(r));
  rmTempDir(DIR);
});

function ask(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const raw = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((done, fail) => {
    const req = request({
      host: "127.0.0.1", port, path, method,
      headers: {
        host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin",
        ...(raw !== undefined ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(raw)) } : {}),
      },
    }, res => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", c => { text += c; });
      res.on("end", () => { let json: any = null; try { json = JSON.parse(text); } catch { json = text; } done({ status: res.statusCode ?? 0, json }); });
    });
    req.on("error", fail);
    req.end(raw);
  });
}
const target = (id: string, provider = "claude") => ask("GET", `/api/terminal/target?session=${id}&provider=${provider}&cwd=${encodeURIComponent(PROJECT)}`);

describe("the deck's record through its routes (F6-R)", () => {
  it("a launch the engine answered is the panel's on every later read: a reload, another tab", async () => {
    answers.launch = { status: 200, body: { ok: true, sessionId: LAUNCHED, name: "deck-claude-x", ticket: null } };
    const launch = await ask("POST", "/api/terminal/launch", { agent: "claude", cwd: PROJECT, key: "k-route-1" });
    expect(launch.status).toBe(200);
    // The engine was asked the page's question, and nothing of the record.
    expect(asked).toEqual([{ method: "launch", body: { agent: "claude", cwd: PROJECT, key: "k-route-1" } }]);
    for (let i = 0; i < 3; i++) {
      const read = await target(LAUNCHED);
      expect(read.status).toBe(200);
      expect(read.json).toEqual({ ok: true, target: { ...C_TARGET, provenance: "panel" } });
    }
  });

  it("a session the deck has no record of is unknown, and an answer that is not case C is untouched", async () => {
    expect((await target(ELSEWHERE)).json).toEqual({ ok: true, target: { ...C_TARGET, provenance: "unknown" } });
    answers.target = { status: 200, body: { ok: true, target: { kind: "A", label: "attached" } } };
    expect((await target(LAUNCHED)).json).toEqual({ ok: true, target: { kind: "A", label: "attached" } });
  });

  it("never turns a refusal into an attach: an open that is not attachable stays so, with no ticket", async () => {
    answers.open = { status: 200, body: { ok: false, target: C_TARGET } };
    const open = await ask("POST", "/api/terminal/open", { sessionId: LAUNCHED, provider: "claude", cwd: PROJECT });
    expect(open.status).toBe(200);
    expect(open.json).toEqual({ ok: false, target: { ...C_TARGET, provenance: "panel" } });
    expect(open.json.ticket).toBeUndefined();
  });

  it("an adopt the engine refused leaves no record", async () => {
    answers.adopt = { status: 409, body: { ok: false, error: "It is still running.", code: "still-running" } };
    const adopt = await ask("POST", "/api/terminal/adopt", { sessionId: REFUSED, provider: "claude", cwd: PROJECT });
    expect(adopt.status).toBe(409);
    expect((await target(REFUSED)).json.target.provenance).toBe("unknown");
  });

  it("refuses the record from POST /api/event, the door without the deck's token", async () => {
    for (const launch of ["bound", "held", "started"]) {
      const forged = await ask("POST", "/api/event", {
        hook_event_name: "__panel_launch", launch, provider: "claude", session: FORGED, ref: FORGED,
        launches: [{ provider: "claude", session: FORGED, at: Date.now(), state: "panel", started: true }],
      });
      expect(forged.status, launch).toBe(400);
      expect(forged.json, launch).toEqual({ error: "reserved event name" });
    }
    expect((await target(FORGED)).json.target.provenance).toBe("unknown");
  });
});
