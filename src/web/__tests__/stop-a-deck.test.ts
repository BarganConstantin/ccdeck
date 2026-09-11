// Ctrl+C stopped being the off switch the moment the deck started outliving the
// terminal, so `ccdeck --stop` is not a convenience — it is the only thing
// standing between "runs in the background" and the twenty forgotten processes
// that started this whole line of work.
//
// It has to work on a machine with no signals. `process.kill(pid, "SIGTERM")` on
// Windows is TerminateProcess: the deck stops mid-instruction, its discovery
// file is left for the next boot to sweep, and its LAN beacon never says
// goodbye, so every paired colleague watches it time out instead of seeing it
// leave. One loopback POST behaves the same on all three platforms and ends in
// the deck's own shutdown(). The signals stay, one rung down, for the deck too
// old to know the route — which would otherwise be unstoppable by its own
// command.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

// Temp home, set before the dynamic import: the server resolves its config
// directories at import time and the real ~/.claude must stay untouched.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-stop-"));
const prevEnv = { ...process.env };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.AGENTS_DECK_NO_INSTALL = "1";
for (const p of [process.env.HOME, process.env.CLAUDE_CONFIG_DIR, process.env.CODEX_HOME]) {
  if (!resolve(p!).startsWith(resolve(DIR))) throw new Error(`sandbox escaped: ${p}`);
}

// @ts-expect-error — plain .mjs module, no types
const { startServer, hookToken } = await import("../../server/index.mjs");
// @ts-expect-error — plain .mjs module, no types
const stop = await import("../../server/stop-deck.mjs");
const { askDeckToStop, killPidTree, stopDeck } = stop as {
  askDeckToStop: (rec: Rec, o?: { timeoutMs?: number; request?: unknown }) => Promise<Answer>;
  killPidTree: (pid: number, signal?: string, o?: KillOpts) => void;
  stopDeck: (rec: Rec, o?: Record<string, unknown>) => Promise<Verdict>;
};
// @ts-expect-error — plain .mjs module, no types
const { sinceLabel } = await import("../../server/term.mjs");

type Rec = { pid: number; port: number; token: string; parent?: number | null };
type Answer = { ok: boolean; status: number; old: boolean; reason?: string };
type Verdict = { ok: boolean; how: string; old?: boolean; reason?: string };
type KillOpts = { platform?: string; spawnFn?: unknown; kill?: (p: number, s: string) => void };

const DECK = readFileSync(fileURLToPath(new URL("../../../bin/deck.js", import.meta.url)), "utf8");

/** One request, with whatever headers the case is about. */
function post(port: number, path: string, headers: Record<string, string>) {
  return new Promise<{ status: number; body: string }>((res, rej) => {
    const req = request({ hostname: "127.0.0.1", port, path, method: "POST", headers: { "content-length": "0", ...headers } }, r => {
      let body = "";
      r.setEncoding("utf8");
      r.on("data", c => { body += c; });
      r.on("end", () => res({ status: r.statusCode ?? 0, body }));
    });
    req.on("error", rej);
    req.end();
  });
}

describe("POST /api/shutdown", () => {
  let server: Server;
  let port = 0;
  const leave = vi.fn();

  beforeAll(async () => {
    server = await startServer({ port: 0, persist: null, codex: false, onStop: leave });
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => { await new Promise(r => server.close(() => r(null))); });

  it("refuses the deck's own page, not only a stranger", async () => {
    // Every OTHER mutating route accepts the token OR the deck's UI. This one
    // must not: there is no button for it, so a page asking to end the deck is
    // a page doing something no part of this product asks it to do. The request
    // below passes the router's own gate as the UI and is refused by the
    // handler, which is exactly the line being pinned.
    const asPage = await post(port, "/api/shutdown", {
      origin: `http://127.0.0.1:${port}`,
      host: `127.0.0.1:${port}`,
      "sec-fetch-site": "same-origin",
    });
    expect(asPage.status).toBe(401);
    expect(leave).not.toHaveBeenCalled();
  });

  it("refuses a wrong token without saying which part was wrong", async () => {
    const bad = await post(port, "/api/shutdown", { "x-ccdeck-token": "0".repeat(64) });
    expect(bad.status).toBe(401);
    expect(bad.body).not.toContain("token");
    expect(leave).not.toHaveBeenCalled();
  });

  it("answers before it tears anything down, and only then leaves", async () => {
    // shutdown() calls server.closeAllConnections(), which would cut this very
    // socket. So the teardown hangs off the response having left rather than
    // running beside it, and the caller gets a 200 instead of a dropped
    // connection it would have to interpret.
    const ok = await post(port, "/api/shutdown", { "x-ccdeck-token": hookToken() });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({ ok: true, pid: process.pid });
    await vi.waitFor(() => expect(leave).toHaveBeenCalledTimes(1));
  });

  it("does not start a second teardown for a second asker", async () => {
    // Two terminals, one deck. The response's own 'finish' and 'close' can both
    // fire for one request too, which is the same hazard reached from inside.
    const again = await post(port, "/api/shutdown", { "x-ccdeck-token": hookToken() });
    expect(again.status).toBe(200);
    expect(JSON.parse(again.body)).toMatchObject({ already: true });
    expect(leave).toHaveBeenCalledTimes(1);
  });
});

describe("a deck with no launcher to end it", () => {
  it("says so rather than pretending", async () => {
    // Running the module directly, or an embedder: the server does not own the
    // process lifecycle and has not been told how to leave.
    const server: Server = await startServer({ port: 0, persist: null, codex: false });
    const port = (server.address() as AddressInfo).port;
    const out = await post(port, "/api/shutdown", { "x-ccdeck-token": hookToken() });
    expect(out.status).toBe(501);
    expect(JSON.parse(out.body)).toMatchObject({ reason: "no_launcher" });
    await new Promise(r => server.close(() => r(null)));
  });
});

describe("the polite rung", () => {
  const rec = (o: Partial<Rec> = {}): Rec => ({ pid: 11, port: 4317, token: "t".repeat(64), ...o });

  /** A stand-in for node:http's `request` that answers with one status. */
  const answering = (status: number) => (_opts: unknown, cb: (r: unknown) => void) => {
    const res = { statusCode: status, resume() {}, on(ev: string, fn: () => void) { if (ev === "end") setTimeout(fn, 0); } };
    setTimeout(() => cb(res), 0);
    return { on() {}, end() {} };
  };

  it("carries the token in the one header the server reads", async () => {
    let seen: Record<string, string> = {};
    await askDeckToStop(rec(), {
      request: ((opts: { headers: Record<string, string> }, cb: (r: unknown) => void) => {
        seen = opts.headers;
        return answering(200)(opts, cb);
      }) as never,
    });
    expect(seen["x-ccdeck-token"]).toBe("t".repeat(64));
    // Without it the POST hangs: node:http will not end a request whose length
    // it cannot state, and the server is waiting for a body that never comes.
    expect(seen["content-length"]).toBe("0");
  });

  it("calls a 404 what it is — a deck older than the route", async () => {
    // Not a mysterious refusal. That deck can still be ended, one rung down,
    // and the message says which of the two happened.
    expect(await askDeckToStop(rec(), { request: answering(404) as never }))
      .toMatchObject({ ok: false, old: true });
    expect(await askDeckToStop(rec(), { request: answering(200) as never }))
      .toMatchObject({ ok: true, old: false });
    expect(await askDeckToStop(rec(), { request: answering(401) as never }))
      .toMatchObject({ ok: false, old: false });
  });

  it("never rejects, because every failure is a rung", async () => {
    const throwing = () => { throw Object.assign(new Error("nope"), { code: "EACCES" }); };
    await expect(askDeckToStop(rec(), { request: throwing as never }))
      .resolves.toMatchObject({ ok: false, reason: "EACCES" });
  });
});

describe("the ladder, when asking did not work", () => {
  const rec = { pid: 11, port: 4317, token: "t", parent: 9 };

  /** Deps that record the kills and let the caller decide when the pid dies. */
  function rig({ diesAfter }: { diesAfter: number }) {
    const kills: [number, string][] = [];
    let rung = 0;
    return {
      kills,
      deps: {
        ask: async () => ({ ok: false, status: 0, old: false, reason: "timeout" }),
        alive: () => rung < diesAfter,
        kill: (pid: number, sig: string) => { kills.push([pid, sig]); rung++; },
        now: () => 0,
        sleep: async () => {},
        goneMs: 0,
      },
    };
  }

  it("ends the parent before the child, or the supervisor undoes the kill", async () => {
    // A worker killed under a live supervisor is a worker the supervisor puts
    // back — that is what it is for, and after this change it really does. So
    // the supervisor goes first and the worker second, which is the whole
    // reason the discovery record carries `parent` at all.
    const { kills, deps } = rig({ diesAfter: 2 });
    const out = await stopDeck(rec, { ...deps, platform: "linux" });
    expect(out).toMatchObject({ ok: true, how: "signalled" });
    expect(kills).toEqual([[9, "SIGTERM"], [11, "SIGTERM"]]);
  });

  it("skips the SIGTERM rung on Windows, where it is not the polite one", async () => {
    // `taskkill` without /F posts WM_CLOSE to a window and the deck has none,
    // so a "polite" signal rung there would be the forceful one under another
    // name — run twice, reported as two different things.
    const { kills, deps } = rig({ diesAfter: 2 });
    const out = await stopDeck(rec, { ...deps, platform: "win32" });
    expect(out).toMatchObject({ ok: true, how: "killed" });
    expect(kills).toEqual([[9, "SIGKILL"], [11, "SIGKILL"]]);
  });

  it("says HOW it went out, because the two are not the same event", async () => {
    // "asked" means the deck closed its listener, unlinked its registration and
    // left the LAN cleanly. Anything else means none of that happened and the
    // next boot has litter to sweep. A command reporting both as "stopped"
    // would hide the only case worth knowing about.
    const asked = await stopDeck(rec, {
      ask: async () => ({ ok: true, status: 200, old: false }),
      alive: () => false, kill: () => {}, now: () => 0, sleep: async () => {}, goneMs: 0,
    });
    expect(asked).toEqual({ ok: true, how: "asked" });
  });

  it("admits defeat rather than reporting a stop that did not happen", async () => {
    const kills: [number, string][] = [];
    const out = await stopDeck(rec, {
      ask: async () => ({ ok: false, status: 0, old: false, reason: "timeout" }),
      alive: () => true,
      kill: (p: number, s: string) => { kills.push([p, s]); },
      now: () => 0, sleep: async () => {}, goneMs: 0, platform: "linux",
    });
    expect(out).toMatchObject({ ok: false, how: "stuck", reason: "timeout" });
    // Every rung was tried before giving up, and the parent led each time.
    expect(kills).toEqual([[9, "SIGTERM"], [11, "SIGTERM"], [9, "SIGKILL"], [11, "SIGKILL"]]);
  });

  it("kills the whole tree on Windows, where there is no process group", async () => {
    const spawned: string[][] = [];
    const spawnFn = (exe: string, args: string[]) => {
      spawned.push([exe, ...args]);
      return { on() {}, unref() {} };
    };
    killPidTree(4231, "SIGKILL", { platform: "win32", spawnFn: spawnFn as never });
    expect(spawned[0]).toContain("/T");
    expect(spawned[0]).toContain("/F");
    expect(spawned[0]).toContain("4231");
    // And on POSIX it is one signal and no subprocess at all.
    const signalled: [number, string][] = [];
    killPidTree(4231, "SIGTERM", { platform: "linux", kill: (p, s) => signalled.push([p, s]) });
    expect(signalled).toEqual([[4231, "SIGTERM"]]);
  });

  it("does nothing at all for a pid that is not one", async () => {
    // `parent` is null for an unsupervised deck, and a record from a deck too
    // old to publish it has no field. Neither may become `kill(NaN)`.
    const signalled: number[] = [];
    for (const bad of [null, undefined, 0, -1, 1.5, "9"]) {
      killPidTree(bad as never, "SIGTERM", { platform: "linux", kill: (p) => signalled.push(p) });
    }
    expect(signalled).toEqual([]);
  });
});

describe("which deck --stop ends", () => {
  it("targets the one a bare `ccdeck` would open, and nothing else by default", () => {
    // One model to hold: `ccdeck` opens X, `ccdeck --stop` ends X. Same
    // sameShape the attach uses.
    expect(DECK).toMatch(/decks\.filter\(d => sameShape\(d, mine\)\)\.slice\(0, 1\)/);
    expect(DECK).toMatch(/flags\.all\s*\n?\s*\?\s*decks/);
    expect(DECK).toContain("decks.filter(d => d.port === named)");
  });

  it("reads the default shape, not the flags on this command line", () => {
    // `--stop --no-codex` is not a request to end a Codex-less deck; it is a
    // flag that means nothing here. Reading it as a selector would make --stop
    // miss the deck it was pointed at and report that nothing is running.
    // The object itself, not everything between it and the next statement --
    // `--logs` now sits in that gap and mentions flags of its own.
    const at = DECK.indexOf("const mine = {");
    const mine = DECK.slice(at, DECK.indexOf("\n  };", at));
    expect(mine).toContain('workspace: "",');
    expect(mine).toContain("codex: hasCodexInstalled(),");
    expect(mine).toContain("claude: hasClaudeInstalled(),");
    expect(mine).not.toContain("flags.");
  });

  it("names what it did NOT stop", () => {
    // A command that ends one of three decks and says only "stopped" leaves the
    // reader believing the machine is clear.
    expect(DECK).toContain("other deck");
    expect(DECK).toContain("still running:");
    // The backtick is escaped in the source: the line lives inside a template
    // literal, and the flag is quoted for the shell in the message itself.
    expect(DECK).toContain("--stop --all\\` ends every deck");
  });

  it("runs above the migration, and never starts a server", () => {
    // A command that ends a deck has no business moving that deck's files on
    // the way past, and asking a server to stop must not require starting one.
    const gate = DECK.indexOf("if (flags.stop || flags.status || flags.logs || flags.installService");
    const migrate = DECK.indexOf("migrateDeckFiles({");
    const indexImport = DECK.indexOf('"src/server/index.mjs"');
    expect(gate).toBeGreaterThan(0);
    expect(migrate).toBeGreaterThan(gate);
    expect(indexImport).toBeGreaterThan(gate);
  });

  it("carries the supervisor's pid in the record, or the ladder has no parent", () => {
    expect(DECK).toContain("parent: SUPERVISED ? process.ppid : null,");
    const installer = readFileSync(
      fileURLToPath(new URL("../../server/installer.mjs", import.meta.url)), "utf8",
    );
    expect(installer).toContain("parent: Number.isInteger(parent) ? parent : null,");
  });

  it("can end a deck that is not supervised, unlike restarting one", () => {
    // A restart needs a supervisor to bring the replacement up on the same
    // port. Ending is something any deck can do alone, and --stop must work on
    // both — so this one is NOT behind the SUPERVISED check beside it.
    expect(DECK).toContain("onRestart: SUPERVISED ? requestRestart : null,");
    expect(DECK).toContain("onStop: () => shutdown(0),");
  });
});

describe("how long it has been up", () => {
  it("answers in the unit the reader is asking in", () => {
    // "up just now" is not an answer to "how long", and "11543s" is not one
    // either. Two units at most: nobody reading "2d" wants the minutes.
    expect(sinceLabel(24_000)).toBe("24s");
    expect(sinceLabel(59_000)).toBe("59s");
    expect(sinceLabel(60_000)).toBe("1m");
    expect(sinceLabel(3_600_000)).toBe("1h");
    expect(sinceLabel(11_520_000)).toBe("3h 12m");
    expect(sinceLabel(90_000_000)).toBe("1d 1h");
    expect(sinceLabel(259_200_000)).toBe("3d");
  });

  it("never prints a negative age", () => {
    // A `startedAt` from before the machine's clock was corrected, and a
    // missing one, both reach this.
    expect(sinceLabel(-5)).toBe("0s");
    expect(sinceLabel(Number.NaN)).toBe("0s");
    expect(sinceLabel(undefined as never)).toBe("0s");
  });
});

afterAll(() => {
  process.env = prevEnv;
  rmTempDir(DIR);
});
