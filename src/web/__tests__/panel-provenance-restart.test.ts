// The deck's record of what its Command Panel started (F6-R) across a real
// deck restart: a deck writes its events log, stops, and a fresh copy of every
// server module — a new process, as far as module state goes — boots on the
// same log and replays it. A launch the first deck's engine answered is the
// panel's after the restart; a session nothing launched is not; and a line in
// the log that only claims to be the deck's record, from a hook, is not one.
import { afterAll, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-panel-restart-"));
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
mkdirSync(join(DIR, "deck"), { recursive: true });
const LOG = join(DIR, "deck", "events.jsonl");

const LAUNCHED = "8e5f6071-92a3-4ebf-8a31-4c5d6e7f8091";
const FORGED = "9f607182-a3b4-4fc0-9b42-5d6e7f8091a2";
const C_TARGET = { kind: "C", label: "This session was started outside the deck, so there is no pane to attach to.", adoptable: true };

const engine = {
  get enabled() { return true; },
  attach: () => ({ ok: false, status: 503 }),
  route: async (method: string) => method === "launch"
    ? { status: 200, body: { ok: true, sessionId: LAUNCHED, name: "deck-claude-x", ticket: null } }
    : method === "target" ? { status: 200, body: { ok: true, target: C_TARGET } }
    : { status: 409, body: { ok: false, error: "not here", code: "no-terminal" } },
};

/** A deck on a fresh copy of every server module, on LOG. */
async function boot(): Promise<{ server: Server; port: number; flush: () => Promise<boolean> }> {
  vi.resetModules();
  // @ts-expect-error — plain .mjs server module, no types
  const mod = await import("../../server/index.mjs");
  // @ts-expect-error — plain .mjs server module, no types
  const { createTicketStore } = await import("../../server/terminal-socket.mjs");
  // @ts-expect-error — plain .mjs server module, no types
  const { flushAppends } = await import("../../server/log-writer.mjs");
  const server: Server = await mod.startServer({
    port: 0, persist: LOG, claude: false, codex: false,
    terminal: { enabled: () => true, engine, tickets: createTicketStore() },
  });
  return { server, port: (server.address() as { port: number }).port, flush: () => flushAppends(LOG) };
}
async function stop(server: Server) {
  server.closeAllConnections?.();
  await new Promise<void>(done => server.close(() => done()));
}
function ask(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
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
const provenanceOf = async (port: number, id: string) =>
  (await ask(port, "GET", `/api/terminal/target?session=${id}&provider=claude&cwd=${encodeURIComponent(PROJECT)}`)).json?.target?.provenance;

afterAll(() => rmTempDir(DIR));

describe("a deck restart (F6-R)", () => {
  it("replays the panel's launch from the log; a forged line from a hook stays nothing", async () => {
    const first = await boot();
    const launch = await ask(first.port, "POST", "/api/terminal/launch", { agent: "claude", cwd: PROJECT, key: "k-restart" });
    expect(launch.status).toBe(200);
    expect(await provenanceOf(first.port, LAUNCHED)).toBe("panel");
    expect(await first.flush()).toBe(true);
    await stop(first.server);

    const lines = readFileSync(LOG, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
    const ours = lines.filter(l => l.payload?.hook_event_name === "__panel_launch");
    expect(ours.map(l => [l.source, l.payload.launch])).toEqual([["internal", "started"], ["internal", "bound"]]);
    expect(JSON.stringify(ours)).not.toContain(PROJECT);

    // A line written into the log by something other than the deck: a hook's source.
    appendFileSync(LOG, JSON.stringify({
      seq: 999, source: "hook", receivedAt: Date.now(),
      payload: { hook_event_name: "__panel_launch", launch: "bound", provider: "claude", session: FORGED },
    }) + "\n");

    const second = await boot();
    try {
      expect(await provenanceOf(second.port, LAUNCHED)).toBe("panel");
      expect(await provenanceOf(second.port, FORGED)).toBe("unknown");
    } finally {
      await stop(second.server);
    }
  }, 60_000);
});
