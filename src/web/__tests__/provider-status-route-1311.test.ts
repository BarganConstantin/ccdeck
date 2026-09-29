// #1311, through the real server: GET /api/provider-status answers, and a
// status page that cannot be reached leaves it — and the rest of the deck —
// answering. Every fetch in this process is refused, so nothing here reaches
// the network, and the read that fails is the one the route really makes.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { get, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

// A temp home, set before the server is imported: it resolves its config
// directories at import time, and the real ~/.claude must stay untouched.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-provider-status-"));
const KEYS = ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "AGENTS_DECK_NO_STATUS", "AGENTS_DECK_NO_INSTALL"];
const prevEnv = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
// Not NO_INSTALL: that is one of the two switches that turn the checks off,
// and this file is about the checks running.
delete process.env.AGENTS_DECK_NO_INSTALL;
delete process.env.AGENTS_DECK_NO_STATUS;

const asked: string[] = [];
vi.stubGlobal("fetch", async (url: string) => {
  asked.push(String(url));
  throw new TypeError("fetch failed");
});

// @ts-expect-error — .mjs server module, no types
const { startServer } = await import("../../server/index.mjs");

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

let server: Server;
let port = 0;

beforeAll(async () => {
  server = await startServer({ port: 0, host: "127.0.0.1", persist: null, codex: false });
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>(done => {
    server.closeAllConnections?.();
    server.close(() => done());
  });
  vi.unstubAllGlobals();
  for (const k of KEYS) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  rmTempDir(DIR);
});

function call(path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    get({ host: "127.0.0.1", port, path }, res => {
      let out = "";
      res.setEncoding("utf8");
      res.on("data", c => { out += c; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(out) }); }
        catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

describe("GET /api/provider-status", () => {
  it("answers unknown for an unreachable page, and only for the CLIs the deck watches", async () => {
    const { status, body } = await call("/api/provider-status");
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.disabled).toBe(false);
    // `codex: false` at boot, so OpenAI's page is never asked.
    expect(body.providers.map((p: { provider: string }) => p.provider)).toEqual(["claude"]);
    expect(body.providers[0]).toMatchObject({ state: "unknown", checkedAt: null, statusPageUrl: "https://status.claude.com" });
    expect(asked).toEqual(["https://status.claude.com/api/v2/summary.json"]);
  });

  it("leaves the rest of the deck answering", async () => {
    expect((await call("/api/health")).status).toBe(200);
  });

  it("does not ask again inside the retry floor", async () => {
    await call("/api/provider-status");
    await call("/api/provider-status");
    expect(asked).toHaveLength(1);
  });

  it("asks nobody once the opt-out is set", async () => {
    process.env.AGENTS_DECK_NO_STATUS = "1";
    try {
      const { body } = await call("/api/provider-status");
      expect(body).toEqual({ ok: true, disabled: true, providers: [] });
      expect(asked).toHaveLength(1);
    } finally {
      delete process.env.AGENTS_DECK_NO_STATUS;
    }
  });
});
