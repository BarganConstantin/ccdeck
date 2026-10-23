// A deck with the terminal panel switched off is a deck without one.
//
// The panel ships off: off unless the switch in Settings › Experimental, or
// the settings file it writes, says otherwise. Off has to mean ABSENT, not
// "present and refusing": every /api/terminal/* path answers exactly what an
// /api path with no route answers, a request offering an upgrade — the
// socket's, or curl's h2c — is answered as if it offered none, the page is
// told terminalOn: false, and nothing anywhere runs tmux.
//
// This boots the deck the product boots — startServer with no stand-ins —
// under a sandboxed HOME, with CCDECK_TMUX pointing at a script that writes
// down every time it is run. tmux.mjs takes CCDECK_TMUX as the only candidate
// when it is set, so every way the deck could reach tmux — findTmux's probe,
// a session listing, a control client — runs that script first, and the
// script's log staying empty is the proof that none of them did.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-terminal-off-"));
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
// A launch variable from before the switch, and the engine's own opt-in:
// neither turns the panel on, whatever the shell running the suite has set.
process.env.CCDECK_TERMINAL = "1";
process.env.CCDECK_ENGINE_TERMINAL = "1";

const TMUX_LOG = join(DIR, "tmux-was-run.log");
const TMUX_STUB = join(DIR, "tmux");
writeFileSync(TMUX_STUB, ["#!/bin/sh", `echo "$*" >> "${TMUX_LOG}"`, "echo 'tmux 3.6'"].join("\n") + "\n", { mode: 0o755 });
process.env.CCDECK_TMUX = TMUX_STUB;

// @ts-expect-error — plain .mjs server module, no types
const mod = await import("../../server/index.mjs");
// @ts-expect-error — plain .mjs server module, no types
const prefs = await import("../../server/deck-prefs.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { GUARDED_READS } = await import("../../server/request-gates.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { SETTING_VARS, SCOPE_VARS } = await import("../../server/login-service.mjs");

let server: Server;
let port = 0;
beforeAll(async () => {
  server = await mod.startServer({ port: 0, persist: false, claude: false, codex: false });
  port = (server.address() as { port: number }).port;
}, 30_000);
afterAll(async () => {
  await new Promise(r => server.close(r));
  rmTempDir(DIR);
});

/** The deck's own page: what passes every gate, so what is left is the route. */
const page = () => ({
  host: `127.0.0.1:${port}`,
  origin: `http://127.0.0.1:${port}`,
  "sec-fetch-site": "same-origin",
});

interface Answer { status: number; type: string; body: string }

function ask(method: string, path: string, body?: unknown, headers: Record<string, string> = page()): Promise<Answer> {
  return new Promise((resolve_, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request({
      host: "127.0.0.1", port, path, method,
      headers: { ...headers, ...(payload ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) } : {}) },
    }, res => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", c => { raw += c; });
      res.on("end", () => resolve_({ status: res.statusCode ?? 0, type: String(res.headers["content-type"] ?? ""), body: raw }));
    });
    req.on("error", reject);
    req.setTimeout(10_000, () => { req.destroy(); reject(new Error(`${method} ${path} timed out`)); });
    req.end(payload);
  });
}

const ROUTES: [string, string, unknown?][] = [
  ["GET", "/api/terminal/status"],
  ["GET", "/api/terminal/target?session=0b9f3c1e-2d4a-4b6c-8e0f-1a2b3c4d5e6f&provider=claude&cwd=%2Ftmp"],
  ["POST", "/api/terminal/open", { sessionId: "0b9f3c1e-2d4a-4b6c-8e0f-1a2b3c4d5e6f", provider: "claude", cwd: "/tmp" }],
  ["POST", "/api/terminal/adopt", { sessionId: "0b9f3c1e-2d4a-4b6c-8e0f-1a2b3c4d5e6f", provider: "claude", cwd: "/tmp" }],
  ["POST", "/api/terminal/launch", { agent: "claude", cwd: "/tmp" }],
  ["POST", "/api/terminal/claim", { key: "launch-k1", sessionId: "0b9f3c1e-2d4a-4b6c-8e0f-1a2b3c4d5e6f", provider: "codex", cwd: "/tmp" }],
];

describe("the terminal routes on a deck with the panel switched off", () => {
  it("answer exactly what an /api path with no route answers", async () => {
    for (const [method, path, body] of ROUTES) {
      const got = await ask(method, path, body);
      const none = await ask(method, "/api/terminal/no-such-route", body);
      expect(none.status, "the comparison itself").toBe(404);
      expect(got, `${method} ${path}`).toEqual(none);
    }
  });

  it("are still behind the gates that come first, as every path is", async () => {
    // Off does not open anything: the reads are guarded and the writes are
    // mutations, so a caller with no page and no token is refused before the
    // route — which is the same answer it gets with the panel on.
    expect(GUARDED_READS.has("/api/terminal/status")).toBe(true);
    expect(GUARDED_READS.has("/api/terminal/target")).toBe(true);
    expect((await ask("GET", "/api/terminal/status", undefined, { host: `127.0.0.1:${port}` })).status).toBe(401);
    expect((await ask("POST", "/api/terminal/launch", { agent: "claude", cwd: "/tmp" }, { host: `127.0.0.1:${port}` })).status).toBe(401);
    expect((await ask("POST", "/api/terminal/claim", { key: "launch-k1" }, { host: `127.0.0.1:${port}` })).status).toBe(401);
  });

  it("answer a request that offers an upgrade exactly as the same request offering none", async () => {
    // With no 'upgrade' listener Node routes such a request like any other;
    // with one, it would be the listener's to answer, on every path. So off
    // must mean no listener: the socket's own handshake and curl --http2's h2c
    // probe both get the deck's ordinary answer — never a 101, never a 404
    // and a hang-up the deck did not give before the panel existed.
    const websocket = {
      connection: "Upgrade", upgrade: "websocket",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13",
    };
    const h2c = { connection: "Upgrade, HTTP2-Settings", upgrade: "h2c", "http2-settings": "AAMAAABkAAQCAAAAAAIAAAAA" };
    for (const path of ["/api/terminal/attach?ticket=" + "a".repeat(43), "/api/terminal/no-such-route", "/api/prefs", "/"]) {
      const plain = await ask("GET", path);
      for (const offer of [websocket, h2c]) {
        const got = await ask("GET", path, undefined, { ...page(), ...offer });
        expect(got, `${path} offering ${offer.upgrade}`).toEqual(plain);
      }
    }
    expect(server.listenerCount("upgrade"), "no listener at all").toBe(0);
  });

  it("never ran tmux, for any of it", () => {
    expect(existsSync(TMUX_LOG), existsSync(TMUX_LOG) ? readFileSync(TMUX_LOG, "utf8") : "").toBe(false);
  });

  it("tell the page the panel is off, in the read it already makes", async () => {
    const got = await ask("GET", "/api/prefs");
    expect(got.status).toBe(200);
    const body = JSON.parse(got.body);
    expect(body.terminalOn).toBe(false);
    expect(body.prefs.terminal).toBe(false);
  });

  it("is switched on by the switch in Settings, and off again", async () => {
    // The deck's own page passes the mutation gate, as every switch in
    // Settings does. Off again before anything asks tmux, so the rest of this
    // file still holds a deck with the panel off.
    const on = JSON.parse((await ask("POST", "/api/prefs", { terminal: true })).body);
    expect(on.terminalOn).toBe(true);
    expect(on.terminalSupported).toBe(process.platform === "linux");
    const off = JSON.parse((await ask("POST", "/api/prefs", { terminal: false })).body);
    expect(off.terminalOn).toBe(false);
    expect((await ask("GET", "/api/terminal/status")).status).toBe(404);
  });
});

describe("terminalOn", () => {
  const { terminalOn, DEFAULTS, PAGE_FIELDS, normalise } = prefs;

  it("is off by default", () => {
    expect(DEFAULTS.terminal).toBe(false);
    expect(normalise({}).terminal).toBe(false);
    expect(terminalOn({})).toBe(false);
    expect(terminalOn(undefined)).toBe(false);
  });

  it("is the switch alone: no launch variable turns it on", () => {
    expect(process.env.CCDECK_TERMINAL, "set above, as a shell might have").toBe("1");
    expect(terminalOn({ terminal: false })).toBe(false);
    expect(prefs).not.toHaveProperty("TERMINAL_ENV");
    expect(prefs).not.toHaveProperty("terminalForced");
  });

  it("is on with the stored switch, and only a real true counts", () => {
    expect(terminalOn({ terminal: true })).toBe(true);
    expect(terminalOn({ terminal: "true" })).toBe(false);
    expect(normalise({ terminal: true }).terminal, "kept across a write").toBe(true);
    expect(normalise({ terminal: 1 }).terminal).toBe(false);
  });

  it("is a field a page may write: Settings › Experimental's Command Panel switch", () => {
    expect(PAGE_FIELDS.top).toContain("terminal");
    expect(prefs.pagePatch({ terminal: true })).toEqual({ terminal: true });
  });

  it("has no launch variable: CCDECK_TERMINAL is read nowhere the deck runs, documented nowhere, carried by no login item", () => {
    const readme = readFileSync(fileURLToPath(new URL("../../../README.md", import.meta.url)), "utf8");
    expect(readme).not.toContain("CCDECK_TERMINAL");
    expect([...SETTING_VARS, ...SCOPE_VARS]).not.toContain("CCDECK_TERMINAL");
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const sources = ["src/server", "bin"].flatMap(dir => readdirSync(join(root, dir), { recursive: true }).map(f => join(root, dir, String(f))))
      .filter(f => /\.(?:mjs|js)$/.test(f));
    expect(sources.length).toBeGreaterThan(50);
    expect(sources.filter(f => /\bCCDECK_TERMINAL\b/.test(readFileSync(f, "utf8")))).toEqual([]);
  });
});
