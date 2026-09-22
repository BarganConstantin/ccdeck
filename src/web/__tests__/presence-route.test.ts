// POST /api/presence is how the deck learns that somebody is looking at it, and
// the away-update (auto-update.mjs) will not install or restart while anybody
// is. So the failure that matters here is the quiet one: a route that starts
// turning real tabs away, for any reason — a change to the body it reads, a
// TAB_ID tightened past what a page actually generates, the page's keepalive
// POST refused at the gate — leaves the deck believing nobody is ever looking,
// and it updates and restarts itself under the person watching it. Nothing on
// screen says why.
//
// auto-update-away.test.ts pins the pieces: createPresence on its own, the
// page's beat, and the route line in the router's source. Nothing had ever
// POSTed to the route, and nothing had handed createPresence an id the page's
// own newTabId made (#1168). These do both.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPresence } from "../../server/presence.mjs";
import { newTabId } from "../presence";

// Temp home, set before the dynamic import: the server resolves its config
// directories at import time and the real ~/.claude must stay untouched.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-presence-route-"));
const prevEnv = { ...process.env };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
for (const p of [process.env.HOME, process.env.USERPROFILE, process.env.CLAUDE_CONFIG_DIR, process.env.CODEX_HOME]) {
  if (!resolve(p!).startsWith(resolve(DIR))) throw new Error(`sandbox escaped: ${p}`);
}

// @ts-expect-error — plain .mjs module, no types
const { startServer } = await import("../../server/index.mjs");

let server: Server;
let port = 0;

beforeAll(async () => {
  server = await startServer({ port: 0, host: "127.0.0.1", persist: null, codex: false, claude: false });
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>(done => {
    server.closeAllConnections?.();
    server.close(() => done());
  });
  for (const k of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  rmTempDir(DIR);
});

/** What the page's own fetch sends: Origin on every POST, fetch metadata saying
 *  same-origin, and a loopback Host from the URL bar. */
const ui = () => ({
  Host: `127.0.0.1:${port}`,
  Origin: `http://127.0.0.1:${port}`,
  "Sec-Fetch-Site": "same-origin",
  "Content-Type": "application/json",
});

function post(body: string, headers: Record<string, string> = ui()): Promise<{ status: number; body: unknown }> {
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port, path: "/api/presence", method: "POST", headers }, res => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", c => { text += c; });
      res.on("end", () => done({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
    });
    req.on("error", fail);
    req.end(body);
  });
}

describe("POST /api/presence", () => {
  it("takes a tab's claim from the deck's own page", async () => {
    expect(await post(JSON.stringify({ tab: "tab-1", looking: true }))).toEqual({ status: 200, body: { ok: true } });
    // And the goodbye, which is the same body saying false.
    expect(await post(JSON.stringify({ tab: "tab-1", looking: false }))).toEqual({ status: 200, body: { ok: true } });
  });

  it("takes the id the page actually generates, in both of its shapes", async () => {
    // What a tab sends is newTabId(), not "tab-1": a UUID where the page is a
    // secure context, a time-and-random pair where it is not.
    expect((await post(JSON.stringify({ tab: newTabId(), looking: true }))).status).toBe(200);
    expect((await post(JSON.stringify({ tab: "lx3k9q2a-8f7d6e5c", looking: true }))).status).toBe(200);
  });

  it("refuses an id no page would make", async () => {
    for (const tab of ["../../etc", "x".repeat(65), "", "tab 1"]) {
      expect(await post(JSON.stringify({ tab, looking: true })), JSON.stringify(tab).slice(0, 20)).toEqual({ status: 400, body: { ok: false } });
    }
    // A claim with no tab at all is the same refusal, not a crash.
    expect(await post(JSON.stringify({ looking: true }))).toEqual({ status: 400, body: { ok: false } });
  });

  it("refuses a body that is not a JSON object, and says it was the body", async () => {
    for (const body of ["not json", "", "null", "42"]) {
      expect(await post(body), JSON.stringify(body)).toEqual({ status: 400, body: { ok: false, reason: "bad_request" } });
    }
  });

  it("is the deck's own page's to post, not any local process's", async () => {
    // Not in OPEN_MUTATIONS, deliberately: a process that could claim a tab was
    // looking could hold the away-update off for ever.
    const bare = await post(JSON.stringify({ tab: "tab-1", looking: true }), { "Content-Type": "application/json" });
    expect(bare.status).toBe(401);
  });
});

describe("the page's tab id against the server's rule", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  // presence.mjs's TAB_ID and presence.ts's newTabId are written in two files
  // for two runtimes, and a claim is only ever as good as the pair agreeing.
  // Tighten the pattern past a UUID, or change the fallback's shape, and every
  // report is refused while each half still passes its own tests.
  it("accepts every id a secure page generates", () => {
    const p = createPresence();
    for (let i = 0; i < 200; i++) {
      const id = newTabId();
      expect(p.report(id, true, 0), id).toBe(true);
    }
  });

  it("accepts every id the fallback generates, where randomUUID is not there to call", () => {
    // A deck reached over the LAN is not a secure context, and randomUUID
    // throws there. Stubbed to throw, so the fallback is what is measured.
    vi.stubGlobal("crypto", { randomUUID: () => { throw new Error("insecure context"); } });
    const p = createPresence();
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const id = newTabId();
      seen.add(id);
      expect(p.report(id, true, 0), id).toBe(true);
    }
    // The stub was the one in force: none of these is a UUID.
    for (const id of seen) expect(id).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});
