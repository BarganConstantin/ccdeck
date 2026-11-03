// /api/session/transcript on a real deck: the router's read gate runs in front
// of it (401 with nothing, a foreign Host refused), and the deck's own page
// reads a session the deck knows. guarded-reads.test.ts walks the routes it
// names; this is the same boot for the one route that shows a conversation.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-transcript-server-"));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.XDG_CONFIG_HOME = join(DIR, "config");
process.env.XDG_DATA_HOME = join(DIR, "data");
process.env.CLAUDE_SWAP_BACKUP = join(DIR, "claude-swap");
if (!resolve(process.env.CLAUDE_CONFIG_DIR).startsWith(resolve(DIR))) throw new Error("sandbox escaped");

// @ts-expect-error — plain .mjs server module, no types
const mod = await import("../../server/index.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { outputWatch } = await import("../../server/session-tracking.mjs");

let server: Server;
let port = 0;
const SESSION = "11111111-2222-3333-4444-555555555555";
const FILE = join(DIR, "claude", "projects", "work", `${SESSION}.jsonl`);

beforeAll(async () => {
  mkdirSync(join(DIR, "claude", "projects", "work"), { recursive: true });
  writeFileSync(FILE, JSON.stringify({ type: "user", message: { role: "user", content: "hello deck" } }) + "\n");
  outputWatch.note(SESSION, FILE);
  server = await mod.startServer({ port: 0, persist: false, open: false, claude: false, codex: false });
  port = (server.address() as { port: number }).port;
}, 30_000);
afterAll(async () => {
  await new Promise(r => server.close(r));
  rmTempDir(DIR);
});

const get = (path: string, headers: Record<string, string> = {}) =>
  new Promise<{ status: number; raw: string }>((done, fail) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", headers }, res => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", c => { raw += c; });
      res.on("end", () => done({ status: res.statusCode ?? 0, raw }));
    });
    req.on("error", fail);
    req.setTimeout(15_000, () => { req.destroy(); done({ status: 0, raw: "" }); });
    req.end();
  });
const page = () => ({ host: `127.0.0.1:${port}`, "sec-fetch-site": "same-origin" });
const route = `/api/session/transcript?session=${SESSION}`;

describe("the transcript route on a running deck", () => {
  it("is refused with no browser headers and no token", async () => {
    expect((await get(route)).status).toBe(401);
    expect((await get(route, { host: `127.0.0.1:${port}` })).status).toBe(401);
  });

  it("is refused for a cross-site page and for a rebound host", async () => {
    expect((await get(route, { host: `127.0.0.1:${port}`, "sec-fetch-site": "cross-site" })).status).toBe(401);
    expect((await get(route, { host: "attacker.example", "sec-fetch-site": "same-origin" })).status).toBe(403);
  });

  it("answers the deck's own page the turns of a session the deck knows", async () => {
    const { status, raw } = await get(route, page());
    expect(status).toBe(200);
    expect(JSON.parse(raw)).toEqual({ ok: true, complete: true, turns: [{ kind: "user", text: "hello deck" }] });
  });

  it("answers the token for a client that is not a browser", async () => {
    expect((await get(route, { "x-ccdeck-token": mod.hookToken() })).status).toBe(200);
  });

  it("answers a session it does not know 404, and a path put in the id 400", async () => {
    expect((await get("/api/session/transcript?session=nobody", page())).status).toBe(404);
    expect((await get(`/api/session/transcript?session=${encodeURIComponent("../../etc/passwd")}`, page())).status).toBe(400);
  });
});
