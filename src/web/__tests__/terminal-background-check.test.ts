// POST /api/terminal/background with `check: true`: the question the pane asks
// before it offers "Move session here". It makes every lookup of the real move
// and sends nothing, so a pane on Linux, on Windows, or in a Mac terminal other
// than Ghostty never shows a button that can only fail.
import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-background-check-"));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.CCDECK_HOME = join(DIR, "deck");
process.env.XDG_CONFIG_HOME = join(DIR, "config");
process.env.XDG_DATA_HOME = join(DIR, "data");
process.env.XDG_STATE_HOME = join(DIR, "state");
if (!resolve(process.env.CLAUDE_CONFIG_DIR).startsWith(resolve(DIR))) throw new Error("sandbox escaped");

// @ts-expect-error — plain .mjs server module, no types
const routes = await import("../../server/terminal-routes.mjs");

const SID = "0b9f3c1e-2d4a-4b6c-8e0f-1a2b3c4d5e6f";
let options: Record<string, unknown> = {};
let server: Server;
let port = 0;

beforeAll(async () => {
  server = createServer((req, res) => { void routes.handleTerminalBackground(req, res, options); });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
});
afterAll(async () => {
  await new Promise(r => server.close(r));
  rmTempDir(DIR);
});

function post(body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve_, reject) => {
    const payload = JSON.stringify(body);
    const req = request({
      host: "127.0.0.1", port, path: "/api/terminal/background", method: "POST",
      headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) },
    }, res => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", c => { raw += c; });
      res.on("end", () => resolve_({ status: res.statusCode ?? 0, body: JSON.parse(raw) }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

const engineSaying = (kind: string) => ({
  enabled: true,
  route: vi.fn(async () => ({ status: 200, body: { ok: true, target: { kind } } })),
});

describe("POST /api/terminal/background with check", () => {
  it("says movable for a Claude in its own terminal when the lookups say yes, and asks for a check only", async () => {
    const background = vi.fn(async () => true);
    options = { enabled: () => true, engine: engineSaying("C"), background };
    const got = await post({ sessionId: SID, provider: "claude", cwd: "/work", check: true });
    expect(got).toEqual({ status: 200, body: { ok: true, movable: true } });
    expect(background).toHaveBeenCalledTimes(1);
    expect(background.mock.calls[0][1]).toMatchObject({ check: true });
  });

  it("says not movable when the lookups say no, and for any target that is not a terminal of its own", async () => {
    options = { enabled: () => true, engine: engineSaying("C"), background: vi.fn(async () => false) };
    expect((await post({ sessionId: SID, provider: "claude", cwd: "/work", check: true })).body).toEqual({ ok: true, movable: false });
    for (const kind of ["A", "B", "D", "E"]) {
      const background = vi.fn(async () => true);
      options = { enabled: () => true, engine: engineSaying(kind), background };
      expect((await post({ sessionId: SID, provider: "claude", cwd: "/work", check: true })).body, kind).toEqual({ ok: true, movable: false });
      expect(background).not.toHaveBeenCalled();
    }
  });

  it("says not movable without the engine", async () => {
    const background = vi.fn(async () => true);
    options = { enabled: () => true, engine: { enabled: false }, background };
    expect((await post({ sessionId: SID, provider: "claude", cwd: "/work", check: true })).body).toEqual({ ok: true, movable: false });
    expect(background).not.toHaveBeenCalled();
  });

  it("does not hold the cooldown: a check, then the move, then the move refused for 15 s", async () => {
    const background = vi.fn(async () => true);
    const sid = "1b9f3c1e-2d4a-4b6c-8e0f-1a2b3c4d5e6f";
    options = { enabled: () => true, engine: engineSaying("C"), background };
    expect((await post({ sessionId: sid, provider: "claude", cwd: "/work", check: true })).body.movable).toBe(true);
    expect(await post({ sessionId: sid, provider: "claude", cwd: "/work" })).toEqual({ status: 200, body: { ok: true } });
    expect(background.mock.calls[1][1]).not.toMatchObject({ check: true });
    expect((await post({ sessionId: sid, provider: "claude", cwd: "/work" })).status).toBe(409);
    // A check still answers during the cooldown, and sends nothing.
    expect((await post({ sessionId: sid, provider: "claude", cwd: "/work", check: true })).body.movable).toBe(true);
    expect(background).toHaveBeenCalledTimes(3);
  });

  it("refuses a body that does not name a Claude session, check or not", async () => {
    options = { enabled: () => true, engine: engineSaying("C"), background: vi.fn(async () => true) };
    for (const body of [
      { sessionId: SID, provider: "codex", cwd: "/work", check: true },
      { sessionId: "not-an-id", provider: "claude", cwd: "/work", check: true },
      { sessionId: SID, provider: "claude", cwd: "relative", check: true },
    ]) {
      expect((await post(body)).status).toBe(400);
    }
  });

  it("is absent with the panel off", async () => {
    options = { enabled: () => false, engine: engineSaying("C"), background: vi.fn(async () => true) };
    expect((await post({ sessionId: SID, provider: "claude", cwd: "/work", check: true })).status).toBe(404);
  });
});
