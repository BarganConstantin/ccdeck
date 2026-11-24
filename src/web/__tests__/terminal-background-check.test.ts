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
// @ts-expect-error — plain .mjs server module, no types
const { handoffContinued, handoffSent, HANDOFF_SENT_FOR } = await import("../../server/ghostty-handoff.mjs");

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
    expect((await post({ sessionId: SID, provider: "claude", cwd: "/work", check: true })).body).toEqual({ ok: true, movable: false, reason: "failed" });
    for (const kind of ["A", "B", "D", "E"]) {
      const background = vi.fn(async () => true);
      options = { enabled: () => true, engine: engineSaying(kind), background };
      expect((await post({ sessionId: SID, provider: "claude", cwd: "/work", check: true })).body, kind).toEqual({ ok: true, movable: false, reason: "not-ghostty" });
      expect(background).not.toHaveBeenCalled();
    }
  });

  it("says not movable without the engine", async () => {
    const background = vi.fn(async () => true);
    options = { enabled: () => true, engine: { enabled: false }, background };
    expect((await post({ sessionId: SID, provider: "claude", cwd: "/work", check: true })).body).toEqual({ ok: true, movable: false, reason: "failed" });
    expect(background).not.toHaveBeenCalled();
  });

  it("does not hold the cooldown: a check, then the move, then the move refused as already sent", async () => {
    const background = vi.fn(async () => true);
    const sid = "1b9f3c1e-2d4a-4b6c-8e0f-1a2b3c4d5e6f";
    options = { enabled: () => true, engine: engineSaying("C"), background };
    expect((await post({ sessionId: sid, provider: "claude", cwd: "/work", check: true })).body.movable).toBe(true);
    expect(await post({ sessionId: sid, provider: "claude", cwd: "/work" })).toEqual({ status: 200, body: { ok: true } });
    expect(background.mock.calls[1][1]).not.toMatchObject({ check: true });
    expect(await post({ sessionId: sid, provider: "claude", cwd: "/work" })).toEqual({ status: 409, body: { ok: false, reason: "already-sent" } });
    // A check still answers while the move is remembered, and sends nothing.
    expect((await post({ sessionId: sid, provider: "claude", cwd: "/work", check: true })).body.movable).toBe(true);
    expect(background).toHaveBeenCalledTimes(3);
    handoffContinued(sid);
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

  it("says why a check is no, from the lookups' reason", async () => {
    for (const reason of ["ghostty-unsupported", "claude-not-ready", "not-ghostty", "not-mac"]) {
      options = { enabled: () => true, engine: engineSaying("C"), background: vi.fn(async () => ({ ok: false, reason })) };
      expect((await post({ sessionId: SID, provider: "claude", cwd: "/work", check: true })).body, reason)
        .toEqual({ ok: true, movable: false, reason });
    }
    options = { enabled: () => true, engine: engineSaying("C"), background: vi.fn(async () => ({ ok: true })) };
    expect((await post({ sessionId: SID, provider: "claude", cwd: "/work", check: true })).body).toEqual({ ok: true, movable: true });
  });
  it("is absent with the panel off", async () => {
    options = { enabled: () => false, engine: engineSaying("C"), background: vi.fn(async () => true) };
    expect((await post({ sessionId: SID, provider: "claude", cwd: "/work", check: true })).status).toBe(404);
  });
});

describe("POST /api/terminal/background, the move", () => {
  const move = (sessionId: string) => post({ sessionId, provider: "claude", cwd: "/work" });

  it("answers 409 with the reason the move did not happen, and sends again only after a failure", async () => {
    const sid = "2b9f3c1e-2d4a-4b6c-8e0f-1a2b3c4d5e6f";
    for (const reason of ["ghostty-unsupported", "automation-denied", "claude-not-ready", "surface-changed", "failed"]) {
      options = { enabled: () => true, engine: engineSaying("C"), background: vi.fn(async () => ({ ok: false, reason })) };
      expect(await move(sid), reason).toEqual({ status: 409, body: { ok: false, reason } });
    }
    expect(handoffSent(sid), "nothing was sent, so nothing is remembered").toBe(false);
    // A stand-in that answers a plain boolean still works.
    options = { enabled: () => true, engine: engineSaying("C"), background: vi.fn(async () => false) };
    expect(await move(sid)).toEqual({ status: 409, body: { ok: false, reason: "failed" } });
    options = { enabled: () => true, engine: engineSaying("C"), background: vi.fn(async () => true) };
    expect(await move(sid)).toEqual({ status: 200, body: { ok: true } });
    handoffContinued(sid);
  });

  it("never asks Ghostty for a session that is not in a terminal of its own", async () => {
    const sid = "3b9f3c1e-2d4a-4b6c-8e0f-1a2b3c4d5e6f";
    const background = vi.fn(async () => true);
    options = { enabled: () => true, engine: engineSaying("D"), background };
    expect(await move(sid)).toEqual({ status: 409, body: { ok: false, reason: "not-ghostty" } });
    options = { enabled: () => true, engine: { enabled: false }, background };
    expect(await move(sid)).toEqual({ status: 409, body: { ok: false, reason: "failed" } });
    expect(background).not.toHaveBeenCalled();
  });

  it("sends once: a second press, or one at the same time, is told it already went", async () => {
    const sid = "4b9f3c1e-2d4a-4b6c-8e0f-1a2b3c4d5e6f";
    let release!: () => void;
    const background = vi.fn(() => new Promise<{ ok: true }>(r => { release = () => r({ ok: true }); }));
    options = { enabled: () => true, engine: engineSaying("C"), background };
    const first = move(sid);
    await vi.waitFor(() => expect(background).toHaveBeenCalledTimes(1));
    expect(await move(sid), "while the first is being asked").toEqual({ status: 409, body: { ok: false, reason: "already-sent" } });
    release();
    expect(await first).toEqual({ status: 200, body: { ok: true } });
    expect(await move(sid), "after it went").toEqual({ status: 409, body: { ok: false, reason: "already-sent" } });
    expect(background).toHaveBeenCalledTimes(1);
    expect(handoffSent(sid)).toBe(true);
    // Its continued session found (session-transcript-routes): it may go again.
    handoffContinued(sid);
    background.mockImplementation(async () => ({ ok: true }));
    expect(await move(sid)).toEqual({ status: 200, body: { ok: true } });
    expect(background).toHaveBeenCalledTimes(2);
    handoffContinued(sid);
  });

  it("remembers a sent move for two minutes at least, longer than the pane waits", () => {
    expect(HANDOFF_SENT_FOR).toBeGreaterThanOrEqual(120_000);
  });
});
