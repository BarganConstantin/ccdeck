// The Local network panel's three write routes — /api/lan/invite, /api/lan/peer
// and /api/lan/sync — had never been called by a test (#1168). What stood in for
// them was a regex over the handler's `case` labels (lan-section-doctrine) and a
// copy of two of its closures tested against deck-prefs.mjs (prefs-update-1041),
// and both stay green while the route itself changes underneath them: the
// alias patch moved back outside updatePrefs, an invite answer whose spread
// order drops the address list, a join failure that turns into a 500.
//
// Every case here runs against a real deck whose LAN engine is OFF, because
// no-lan.ts sets AGENTS_DECK_NO_LAN=1 for the whole suite and a deck must not
// broadcast onto whatever network the tests run on. That is not a limitation to
// work around: an engine that is off is a state the panel really meets, and
// every refusal below is the one it gets there. The pairing paths that need a
// second deck on the wire are prefs-update-1041's, against two real engines.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Temp home, set before the dynamic import: the server resolves its config
// directories at import time, and prefs.json — which the alias route writes —
// has to land in here rather than in the user's own deck data.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-lan-routes-"));
const prevEnv = { ...process.env };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.XDG_CONFIG_HOME = join(DIR, "config");
for (const p of [process.env.HOME, process.env.USERPROFILE, process.env.CLAUDE_CONFIG_DIR, process.env.CODEX_HOME, process.env.XDG_CONFIG_HOME]) {
  if (!resolve(p!).startsWith(resolve(DIR))) throw new Error(`sandbox escaped: ${p}`);
}

// @ts-expect-error — plain .mjs module, no types
const { startServer } = await import("../../server/index.mjs");
// @ts-expect-error — plain .mjs module, no types
const { readPrefs, deckDataDir } = await import("../../server/deck-prefs.mjs").then(async m => ({
  ...m,
  // @ts-expect-error — plain .mjs module, no types
  deckDataDir: (await import("../../server/deck-home.mjs")).deckDataDir,
}));

let server: Server;
let port = 0;

beforeAll(async () => {
  // The deck's own prefs file, resolved the way the server resolves it, must be
  // inside the sandbox before anything writes to it.
  if (!resolve(deckDataDir()).startsWith(resolve(DIR))) throw new Error(`prefs outside the sandbox: ${deckDataDir()}`);
  server = await startServer({ port: 0, host: "127.0.0.1", persist: null, codex: false, claude: false });
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>(done => {
    server.closeAllConnections?.();
    server.close(() => done());
  });
  for (const k of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME"]) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  rmTempDir(DIR);
});

/** What the panel's own fetch sends: every one of these routes is the deck's
 *  page's to call, and without the page's headers the 401 lands before the
 *  handler ever runs. */
const ui = () => ({
  Host: `127.0.0.1:${port}`,
  Origin: `http://127.0.0.1:${port}`,
  "Sec-Fetch-Site": "same-origin",
});

type Answer = { status: number; body: Record<string, any>; raw: string };

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = ui()): Promise<Answer> {
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, res => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", c => { raw += c; });
      res.on("end", () => done({ status: res.statusCode ?? 0, body: JSON.parse(raw), raw }));
    });
    req.on("error", fail);
    req.end(body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));
  });
}
const post = (path: string, body?: unknown) => call("POST", path, body);

describe("POST /api/lan/invite", () => {
  it("says the engine is not running rather than handing out an invite nobody can use", async () => {
    // An invite names this deck's listener; with the engine off there is none.
    const r = await post("/api/lan/invite", { action: "make" });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ ok: false, reason: "not_running" });
  });

  it("puts an invite away whether or not there was one, and answers with the panel's state", async () => {
    const r = await post("/api/lan/invite", { action: "withdraw" });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    // The status rides along so the panel redraws from the answer.
    expect(r.body).toHaveProperty("enabled", false);
    expect(r.body).toHaveProperty("invite", null);
  });

  it("answers a join on something that is not an invite as a refusal the dialog can print, not an error", async () => {
    // 200 with ok:false and a reason, because the dialog draws the reason; a
    // 500 here would read as the deck having failed rather than the token.
    const r = await post("/api/lan/invite", { action: "join", token: "garbage" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: false, reason: "not_an_invite" });
  });

  it("refuses a verb it does not know, and a body it cannot read, the same way", async () => {
    for (const body of [{ action: "nope" }, {}, "not json"]) {
      const r = await post("/api/lan/invite", body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body).toEqual({ ok: false, reason: "unknown_action" });
    }
  });
});

describe("POST /api/lan/peer", () => {
  it("refuses a request that names no deck", async () => {
    for (const body of [{}, { fp: 42, action: "accept" }, "not json"]) {
      const r = await post("/api/lan/peer", body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body).toEqual({ ok: false, reason: "bad_request" });
    }
  });

  it("refuses a verb it does not know", async () => {
    const r = await post("/api/lan/peer", { fp: "abc-def", action: "nope" });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ ok: false, reason: "unknown_action" });
  });

  it("will not accept a deck nobody has met", async () => {
    // The key a pairing pins comes from what this deck saw on the wire, never
    // from the page — so a fingerprint that was never heard is refused rather
    // than trusted on a name somebody typed.
    const r = await post("/api/lan/peer", { fp: "abc-def", action: "accept" });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ ok: false, reason: "not_seen" });
  });

  it("answers a verb about a deck it does not have with ok:false, not a failure", async () => {
    for (const action of ["unpair", "dismiss", "allow"]) {
      const r = await post("/api/lan/peer", { fp: "unknown", action });
      expect(r.status, action).toBe(200);
      expect(r.body.ok, action).toBe(false);
    }
  });
});

describe("naming another deck", () => {
  it("refuses a key that could never be a fingerprint", async () => {
    // A typed address's placeholder has a colon in it and names no deck, and
    // nothing exotic becomes a key in an object written back to disk.
    for (const fp of ["../x", "10.0.0.2:45318", "a".repeat(65)]) {
      const r = await post("/api/lan/peer", { fp, action: "alias", name: "L" });
      expect(r.status, fp).toBe(400);
      expect(r.body).toEqual({ ok: false, reason: "bad_request" });
    }
  });

  it("keeps the name, cleaned, where the file and the panel both read it", async () => {
    const r = await post("/api/lan/peer", { fp: "abc-def-012", action: "alias", name: "  Laptop\u0007 " });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    // The answer, the file and the next read of the panel all say the same.
    expect(r.body.aliases["abc-def-012"]).toBe("Laptop");
    expect((await readPrefs()).lan.aliases["abc-def-012"]).toBe("Laptop");
    expect((await call("GET", "/api/lan")).body.aliases["abc-def-012"]).toBe("Laptop");
  });

  it("takes the name away when it is emptied", async () => {
    await post("/api/lan/peer", { fp: "abc-def-013", action: "alias", name: "Studio" });
    const r = await post("/api/lan/peer", { fp: "abc-def-013", action: "alias", name: "" });
    expect(r.status).toBe(200);
    expect((await readPrefs()).lan.aliases).not.toHaveProperty("abc-def-013");
    expect(r.body.aliases).not.toHaveProperty("abc-def-013");
  });

  it("keeps both of two renames made in the same turn", async () => {
    // #1041, through the route this time. Two tabs renaming two decks: the map
    // is rebuilt inside the write's own job, so the second rename is computed
    // from a file that already has the first.
    const [a, b] = await Promise.all([
      post("/api/lan/peer", { fp: "bbb-ccc-111", action: "alias", name: "Desktop" }),
      post("/api/lan/peer", { fp: "ccc-ddd-222", action: "alias", name: "Mini" }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const aliases = (await readPrefs()).lan.aliases;
    expect(aliases["bbb-ccc-111"]).toBe("Desktop");
    expect(aliases["ccc-ddd-222"]).toBe("Mini");
  });
});

describe("POST /api/lan/sync", () => {
  it("says a deck it holds no address for has none, rather than reporting a round that asked nobody", async () => {
    const r = await post("/api/lan/sync", { fp: "nobody" });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ ok: false, reason: "no_address" });
  });

  it("runs the whole round for the button that sends no body", async () => {
    const r = await post("/api/lan/sync");
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.done).toEqual([]);
  });
});

describe("GET /api/lan, as the panel reads it", () => {
  it("answers the page with the panel's state and never with the key", async () => {
    const r = await call("GET", "/api/lan", undefined, { Host: `127.0.0.1:${port}`, "Sec-Fetch-Site": "same-origin" });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    // The reachability verdict the panel draws its firewall line from.
    expect(r.body).toHaveProperty("reach");
    // The long-term key is in prefs.json and nowhere on the wire.
    expect(r.raw).not.toMatch(/secret/i);
  });
});

describe("who may call them", () => {
  it("refuses every one of them to a caller that presents nothing", async () => {
    for (const path of ["/api/lan/invite", "/api/lan/peer", "/api/lan/sync"]) {
      const r = await call("POST", path, { action: "withdraw", fp: "abc-def" }, {});
      expect(r.status, path).toBe(401);
    }
  });
});
