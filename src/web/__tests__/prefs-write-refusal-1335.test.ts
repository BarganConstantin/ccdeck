// #1335: ticking an account under "Share these accounts" on a Mac answered
// "Could not share that account." and nothing else. The deck could not read its
// own prefs.json, and writePrefs said so precisely — PREFS_UNREADABLE — but the
// route let the error fall through to `guard`, whose 500 carries no reason by
// design. The panel was left with a failure it had no words for, on a deck where
// every other setting was failing the same way.
//
// The file is made unreadable by being a directory rather than by a mode bit:
// EISDIR is an unreadable file on all three legs, where chmod blocks nothing on
// Windows or for root.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-prefs-refusal-"));
const prevEnv = { ...process.env };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.AGENTS_DECK_NO_INSTALL = "1";
process.env.AGENTS_DECK_NO_LAN = "1";
for (const p of [process.env.HOME, process.env.USERPROFILE, process.env.CLAUDE_CONFIG_DIR, process.env.CODEX_HOME]) {
  if (!resolve(p!).startsWith(resolve(DIR))) throw new Error(`sandbox escaped: ${p}`);
}

// @ts-expect-error — plain .mjs module, no types
const { startServer } = await import("../../server/index.mjs");
// @ts-expect-error — plain .mjs module, no types
const { prefsPath, prefsWriteRefusal } = await import("../../server/deck-prefs.mjs");

const ENV_KEYS = ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "AGENTS_DECK_NO_INSTALL", "AGENTS_DECK_NO_LAN"];

describe("a settings write the deck cannot make", () => {
  let server: Server;
  let port = 0;

  beforeAll(async () => {
    mkdirSync(prefsPath(), { recursive: true });
    server = await startServer({ port: 0, host: "127.0.0.1", persist: null, codex: false });
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>(done => {
      server.closeAllConnections?.();
      server.close(() => done());
    });
    for (const k of ENV_KEYS) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
    rmTempDir(DIR);
  });

  /** The panel's own POST: same origin, fetch metadata and all. */
  function postPrefs(body: unknown): Promise<{ status: number; json: unknown }> {
    return new Promise((done, fail) => {
      const req = request({
        host: "127.0.0.1", port, path: "/api/prefs", method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: `http://127.0.0.1:${port}`,
          "Sec-Fetch-Site": "same-origin",
        },
      }, res => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", chunk => { raw += chunk; });
        res.on("end", () => done({ status: res.statusCode ?? 0, json: JSON.parse(raw) }));
      });
      req.on("error", fail);
      req.end(JSON.stringify(body));
    });
  }

  it("answers a share tick with a reason the panel can name", async () => {
    const { json } = await postPrefs({ lan: { shared: ["someone@example.com"] } });
    // And what blocked it: a directory where the file should be is not about
    // who owns it, which is exactly what 3.29.3's panel could not tell apart.
    expect(json).toEqual({
      ok: false,
      reason: "prefs_unreadable",
      detail: { code: "EISDIR", owner: "unknown", on: "file" },
    });
  });

  it("never puts the path it could not read in front of the page", async () => {
    const { json } = await postPrefs({ notifications: true });
    expect(JSON.stringify(json)).not.toContain(DIR);
  });
});

describe("prefsWriteRefusal", () => {
  const fsError = (code: string) => Object.assign(new Error(`${code}: fake, #1335 test`), { code });

  it("names a settings file the deck refused to write over", () => {
    expect(prefsWriteRefusal(fsError("PREFS_UNREADABLE"))).toBe("prefs_unreadable");
  });

  it("names a settings folder the deck is not allowed to write to", () => {
    for (const code of ["EACCES", "EPERM", "EROFS"]) {
      expect(prefsWriteRefusal(fsError(code)), code).toBe("prefs_not_writable");
    }
  });

  it("leaves a failure it cannot explain to the generic handler", () => {
    expect(prefsWriteRefusal(new Error("something else entirely"))).toBeNull();
    expect(prefsWriteRefusal(undefined)).toBeNull();
  });
});
