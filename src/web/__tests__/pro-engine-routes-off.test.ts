// With no engine — the default, and always so in the free product — the
// terminal panel's six routes are the JS routes they always were: a deck given
// no `terminal.engine`, a null one, or one that is switched off answers every
// route with the same status and the same bytes, asks the engine nothing, and
// loads nothing of the engine's.
//
// The three engine modules are replaced by stand-ins that record being loaded,
// so "loads nothing" is a fact about this run of a real deck rather than about
// the source; the scan below says the same of the source, for an import added
// later that this run would not reach.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

const loads = vi.hoisted(() => ({ terminal: 0, client: 0, install: 0 }));
vi.mock("../../server/pro-engine-terminal.mjs", () => { loads.terminal += 1; return {}; });
vi.mock("../../server/pro-engine-client.mjs", () => { loads.client += 1; return {}; });
vi.mock("../../server/pro-engine-install.mjs", () => { loads.install += 1; return {}; });

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-engine-routes-off-"));
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

const SID = "0b9f3c1e-2d4a-4b6c-8e0f-1a2b3c4d5e6f";
const SOCKET = { name: "ccdeck-test-engine-routes-off" };
const tickets = createTicketStore();
let asked: string[];
let downloads: number;

/** An engine's terminal as engineTerminals shapes it for a client that is
 *  switched off, recording anything asked of it. */
const off = {
  get enabled() { return false; },
  attach: (...args: unknown[]) => { asked.push(`attach ${args.length}`); return { ok: false, status: 503 }; },
  route: (method: string) => { asked.push(method); return null; },
  forgetTmux: () => { asked.push("forgetTmux"); },
};

// The deck's `terminal` option, edited per case: terminalDeps reads it again
// on every request.
const options: Record<string, unknown> = {
  enabled: () => true,
  deckSocket: SOCKET,
  tickets,
  findTmux: async () => ({ ok: true, path: "/secret/bin/tmux", version: [3, 6], raw: "tmux 3.6a" }),
  resolveTarget: async () => ({ kind: "A", socket: SOCKET, pane: "%12", name: "ccdeck-claude-0a1b2c3d", launchKey: "k-1" }),
  launchSession: async () => ({ name: "ccdeck-claude-feedf00d", sessionId: SID, pane: "%40" }),
  listDeckSessions: async () => [],
  labelDeckSession: async () => true,
  killDeckSession: async () => true,
  pruneDeadDeckSessions: async () => [],
  downloadBlocked: () => null,
  downloadTmux: () => { downloads += 1; return new Promise(() => {}); },
  downloadProgress: () => null,
  recentDownloadFailure: () => null,
  forgetTmux: () => {},
};

let server: Server;
let port = 0;
beforeAll(async () => {
  server = await mod.startServer({ port: 0, persist: false, claude: false, codex: false, terminal: options });
  port = (server.address() as { port: number }).port;
}, 30_000);
beforeEach(() => {
  asked = [];
  downloads = 0;
});
afterAll(async () => {
  await new Promise(r => server.close(r));
  rmTempDir(DIR);
});

function ask(method: string, path: string, body?: string): Promise<{ status: number; raw: string; headers: string }> {
  return new Promise((resolve_, reject) => {
    const req = request({
      host: "127.0.0.1", port, path, method,
      headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin", ...(body !== undefined ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } : {}) },
    }, res => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", c => { raw += c; });
      res.on("end", () => resolve_({ status: res.statusCode ?? 0, raw, headers: JSON.stringify([res.headers["content-type"], res.headers["cache-control"]]) }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

const session = JSON.stringify({ sessionId: SID, provider: "claude", cwd: PROJECT });
const ROUTES: Array<[string, string, string?]> = [
  ["GET", "/api/terminal/status"],
  ["GET", `/api/terminal/target?session=${SID}&provider=claude`],
  ["GET", "/api/terminal/target?session=nope"],
  ["POST", "/api/terminal/claim", JSON.stringify({ key: "k-1", sessionId: SID, provider: "claude", cwd: PROJECT })],
  ["POST", "/api/terminal/open", session],
  ["POST", "/api/terminal/open", "{not json"],
  ["POST", "/api/terminal/adopt", session],
  ["POST", "/api/terminal/launch", JSON.stringify({ agent: "claude", cwd: PROJECT, key: "k-1" })],
  ["POST", "/api/terminal/launch", JSON.stringify({ agent: "gemini", cwd: PROJECT })],
  ["POST", "/api/terminal/launch", JSON.stringify({ agent: "claude", cwd: PROJECT, pad: "x".repeat(9 * 1024) })],
];

/** Every route's answer, a minted ticket written as <ticket>. */
async function answers() {
  const out: string[] = [];
  for (const [method, path, body] of ROUTES) {
    const got = await ask(method, path, body);
    out.push(`${method} ${path.slice(0, 40)} → ${got.status} ${got.headers} ${got.raw.replace(/"ticket":"[A-Za-z0-9_-]{43}"/, '"ticket":"<ticket>"')}`);
  }
  return out;
}

describe("the terminal routes with no engine", () => {
  it("answer byte for byte the same with no engine, a null one, or one switched off, and ask it nothing", async () => {
    delete options.engine;
    const none = await answers();
    options.engine = null;
    const empty = await answers();
    options.engine = off;
    const disabled = await answers();
    delete options.engine;
    expect(empty).toEqual(none);
    expect(disabled).toEqual(none);
    expect(asked, "nothing was asked of the engine").toEqual([]);
    // What those answers are, so the comparison is not of three empty lists.
    expect(none).toHaveLength(ROUTES.length);
    expect(none[0]).toContain('→ 200 ["application/json; charset=utf-8","no-store"] {"ok":true,"platform":');
    expect(none[0]).toContain('"tmux":{"ok":true,"version":"3.6"}}');
    expect(none.filter(a => a.includes('"ticket":"<ticket>"')), "an open and a launch").toHaveLength(2);
    expect(none.at(-1)).toContain("→ 413");
    expect(downloads, "a tmux that works is not fetched").toBe(0);
  });

  it("loads nothing of the engine's, on a deck that answered every route", async () => {
    await answers();
    expect(loads).toEqual({ terminal: 0, client: 0, install: 0 });
  });

  it("import nothing of the engine's, statically or on demand", () => {
    for (const file of ["terminal-routes.mjs", "terminal-socket.mjs", "index.mjs"]) {
      const source = readFileSync(new URL(`../../server/${file}`, import.meta.url), "utf8");
      const imports = source.split("\n").filter(line => /^import\b/.test(line));
      expect(imports.length, `the scan sees ${file}'s imports`).toBeGreaterThan(0);
      expect(imports.filter(line => line.includes("pro-engine")), file).toEqual([]);
      expect(source.match(/import\([^)]*pro-engine/g), file).toBeNull();
    }
  });
});
