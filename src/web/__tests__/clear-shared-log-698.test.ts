// Clear was a machine-wide destructive action wearing the clothes of a per-deck
// one (#698).
//
// `POST /api/clear` ran `truncate(persistPath, 0)`, and persistPath is not this
// deck's log — it is the one events.jsonl every deck on the machine shares by
// default, which is the entire reason the single-writer election exists. So
// pressing Clear on a small deck scoped to one tree deleted the persisted
// history of every other deck that was running, and told none of them: they go
// on serving what is still in their ring buffers, so the damage is invisible
// until one of them restarts and replays a file that is now empty.
//
// Measured here before the fix, on macOS 15 / Node 22.14, with a machine-wide
// deck holding the log and a scoped deck beside it:
//
//     log size before clear:     1407 bytes,  5 lines
//     clear on the scoped deck:  200 {"ok":true}
//     log size after clear:      134 bytes,   1 line
//     machine-wide deck still shows: 5 events
//
// The 134 bytes were the scoped deck's own `__clear` marker — appended by a deck
// that writes nothing else to that file, because the marker carries no session
// id and writesLogFor therefore answers "mine".
//
// The rule now: a deck may empty the log it WRITES. Ownership is electWriters,
// the same election over the same discovery records that decides which deck
// appends a line, so the process that truncates the file is the process that
// fills it. A deck that is not the elected writer clears its own canvas and
// leaves the file alone, and `GET /api/clear` tells the confirmation dialog
// which of those two things the press will do BEFORE it happens.
//
// Two real decks, in two real processes, over one real log — the assertions that
// matter are on the other deck's file and the other deck's canvas, not on the
// answer the cleared deck gives about itself.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { request } from "node:http";
import { createServer } from "node:net";
import type { AddressInfo, Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { clearCopy, readClearPlan } from "../clear-confirm";

// Sandbox first, module import second: the server resolves its config dir, its
// Codex home and its discovery directory at import time. HOME and USERPROFILE
// together cover POSIX and Windows; nothing in this file can reach the
// developer's own ~/.claude, ~/.codex or ~/.agents-deck.
const SANDBOX = mkdtempSync(join(tmpdir(), "ccdeck-clear-698-"));
const CONFIG = join(SANDBOX, "claude");
const CODEX = join(SANDBOX, "codex");
const TREE = join(SANDBOX, "proj");
const PREV: Record<string, string | undefined> = {};
for (const k of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME"]) PREV[k] = process.env[k];
process.env.HOME = SANDBOX;
process.env.USERPROFILE = SANDBOX;
process.env.CLAUDE_CONFIG_DIR = CONFIG;
process.env.CODEX_HOME = CODEX;
process.env.XDG_CONFIG_HOME = join(SANDBOX, "xdg");

mkdirSync(join(CONFIG, "agent-dag"), { recursive: true });
mkdirSync(CODEX, { recursive: true });
mkdirSync(TREE, { recursive: true });

// @ts-expect-error — .mjs server module, no types
const { startServer, hookToken, logSharing } = await import("../../server/index.mjs");
// @ts-expect-error — .mjs server module, no types
const { claudeConfigDir } = await import("../../server/claude-dir.mjs");
// @ts-expect-error — .mjs server module, no types
const { writeDiscovery, discoveryPath, AGENT_DAG_DIR } = await import("../../server/installer.mjs");

// Belt and braces. Every assertion below is about a file being truncated or not
// truncated; if an override had not taken, this file would be doing that to the
// developer's real event log.
for (const p of [claudeConfigDir(), AGENT_DAG_DIR, discoveryPath()] as string[]) {
  if (!resolve(String(p)).startsWith(resolve(CONFIG))) {
    throw new Error(`refusing to run: resolved ${p}, outside ${CONFIG}`);
  }
}

/** The log the two spawned decks share — the machine-wide default. */
const SHARED = join(CONFIG, "agent-dag", "events.jsonl");
/** A log nobody else names, for the ordinary single-deck case. */
const SOLO = join(CONFIG, "agent-dag", "solo.jsonl");
// The script node is handed on the command line, which is a path and stays one:
// argv[1] is resolved by the CLI as a file path on every platform. Nothing here
// hands the child a path where a module SPECIFIER is expected — see the harness,
// which resolves the server against its own `import.meta.url` rather than
// against anything passed in.
const HARNESS = join(dirname(fileURLToPath(import.meta.url)), "clear-shared-log-deck-698.mjs");

type Deck = { child: ChildProcess; pid: number; port: number; token: string };

/** Two free ports, lowest first. The election is decided by the lower one, so
 *  the machine-wide deck is given it deliberately rather than by luck. */
function freePorts(): Promise<[number, number]> {
  return new Promise(done => {
    const held: Server[] = [];
    const ports: number[] = [];
    const grab = () => {
      if (held.length === 2) {
        let left = held.length;
        for (const s of held) s.close(() => { if (--left === 0) done(ports.sort((a, b) => a - b) as [number, number]); });
        return;
      }
      const s = createServer();
      s.listen(0, "127.0.0.1", () => { ports.push((s.address() as AddressInfo).port); held.push(s); grab(); });
    };
    grab();
  });
}

function boot(port: number, workspace: string): Promise<Deck> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [HARNESS], {
      env: {
        ...process.env,
        DECK_PORT: String(port),
        DECK_PERSIST: SHARED,
        DECK_WORKSPACE: workspace,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let why = "";
    child.stdout!.setEncoding("utf8").on("data", (c: string) => {
      out += c;
      const line = out.split("\n").find(l => l.includes('"ready"'));
      if (line) done({ child, ...JSON.parse(line) });
    });
    child.stderr!.setEncoding("utf8").on("data", (c: string) => { why += c; });
    child.on("exit", code => fail(new Error(`deck on ${port} exited ${code}: ${why.slice(0, 400)}`)));
    // Generous on purpose: this is a cold `node` start plus the whole server
    // module on a shared runner, and Windows pays the most for both. A deck that
    // is merely slow must not read as a deck that is broken.
    setTimeout(() => fail(new Error(`deck on ${port} never reported ready: ${why.slice(0, 400)}`)), 30_000);
  });
}

function call(port: number, path: string, method: "GET" | "POST", token?: string, body?: unknown) {
  return new Promise<{ status: number; json: Record<string, unknown> | null; raw: string }>((done, fail) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = request({
      host: "127.0.0.1", port, path, method,
      headers: {
        ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}),
        ...(token ? { "x-ccdeck-token": token } : {}),
      },
    }, res => {
      let raw = "";
      res.setEncoding("utf8").on("data", c => { raw += c; });
      res.on("end", () => {
        let json: Record<string, unknown> | null = null;
        try { json = JSON.parse(raw); } catch { /* not every route answers JSON */ }
        done({ status: res.statusCode ?? 0, json, raw });
      });
    });
    req.on("error", fail);
    req.end(data ?? undefined);
  });
}

const bytes = (p: string) => (existsSync(p) ? statSync(p).size : 0);
const logLines = (p: string) => (existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).length : 0);
const canvas = async (deck: { port: number; token: string }) => {
  // THAT deck's token, not this process's. The guarded-read gate wants the
  // deck's own credential from a client that is not a browser, and the two
  // decks here are separate PROCESSES with separate tokens — `hookToken()` in
  // the test would be a third one, belonging to neither.
  const { raw } = await call(deck.port, "/api/events", "GET", deck.token);
  const parsed = JSON.parse(raw);
  return (Array.isArray(parsed) ? parsed : parsed.events) as { payload: { hook_event_name?: string } }[];
};
const hookEvents = async (deck: { port: number; token: string }) =>
  (await canvas(deck)).filter(e => e.payload?.hook_event_name !== "__clear").length;

async function until(ok: () => boolean | Promise<boolean>, what: string, tries = 600) {
  for (let i = 0; i < tries; i++) {
    if (await ok()) return;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

let wide: Deck;      // machine-wide, lowest port — the elected writer
let scoped: Deck;    // scoped to one tree, the deck the reporter pressed Clear on
let scopedBefore = 0; // what the scoped deck was drawing before Clear was pressed
let linesBefore = 0;  // and what the shared log held, so the fixture can be checked
let solo: Server;    // this process, a deck with a log nobody shares

beforeAll(async () => {
  const [low, high] = await freePorts();
  wide = await boot(low, "");
  scoped = await boot(high, TREE);
  // Five hook events, delivered the way hook.js delivers them when two decks
  // both capture the session: the elected writer is posted plainly, and every
  // other deck is posted the SAME event with `?persist=0` so it draws the card
  // without a second copy reaching the file.
  //
  // Posting only to the writer would have left the scoped deck's canvas empty,
  // and "still clears the canvas the user was looking at" would then be
  // asserting 0 against a board that was 0 before the press — green whatever
  // Clear did. The whole complaint in #698 is that the scoped deck's own board
  // is what the user meant to clear, so it has to have something on it.
  for (let i = 0; i < 5; i++) {
    const body = {
      hook_event_name: i === 0 ? "SessionStart" : "PreToolUse",
      session_id: "sess-698", cwd: TREE, tool_name: "Bash", tool_input: { command: `echo ${i}` },
    };
    await call(wide.port, "/api/event", "POST", undefined, body);
    await call(scoped.port, "/api/event?persist=0", "POST", undefined, body);
  }
  await until(() => logLines(SHARED) >= 5, "the shared log to hold the five events");
  // Both boards are read here and ASSERTED in the first case rather than in
  // this hook. A throw in beforeAll files every case in the file as `skipped`,
  // which reads as a gate nobody registered rather than as a broken fixture —
  // and the skip-register audit then fails on top, hiding the cause twice over.
  // A bounded wait that gives up quietly, plus a named assertion below, says
  // what went wrong.
  await until(async () => (await hookEvents(scoped)) >= 5, "the scoped deck to draw the five", 200)
    .catch(() => {});
  scopedBefore = await hookEvents(scoped);
  linesBefore = logLines(SHARED);
}, 90_000);

afterAll(async () => {
  // Waited for, not slept past. Windows releases a process's handles when the
  // process is actually gone, and the directory removal below cannot delete a
  // file something still holds open — a fixed 200ms is a guess about a loaded
  // runner, and `exit` is the fact.
  await Promise.all([wide, scoped].map(d => (d ? new Promise<void>(r => {
    if (d.child.exitCode !== null || d.child.signalCode !== null) return r();
    d.child.once("exit", () => r());
    d.child.kill();
    setTimeout(r, 10_000);
  }) : Promise.resolve())));
  if (solo) await new Promise<void>(r => solo.close(() => r()));
  for (const [k, v] of Object.entries(PREV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  // THE SHARED HELPER, not a bare rmSync with retries. Windows failed this
  // teardown with ENOTEMPTY under a full-suite run: the two decks are gone by
  // the line above, but a hook process one of the cases spawned can still be
  // finishing — it sweeps the discovery directory and, since the challenge
  // gained a retry, lives a little longer than it did. rm-temp-dir.ts already
  // carries the patience for exactly this, learned three times over, including
  // the ENOTEMPTY spelling.
  rmTempDir(SANDBOX);
});

describe("Clear on a deck that does not own the shared log", () => {
  // First, because everything after it presses Clear and the board it presses
  // on has to have been worth clearing. Both halves of the delivery hook.js
  // makes are checked here: the writer took the five lines, and the second deck
  // drew the same five without adding a sixth.
  it("gives both decks the five events, and the file only one copy", () => {
    expect(linesBefore, "the elected writer took the five events").toBe(5);
    expect(scopedBefore, "the scoped deck drew them too, via ?persist=0").toBe(5);
  });

  it("leaves the other deck's log exactly as it found it", async () => {
    const before = bytes(SHARED);
    expect(before, "the fixture writes a log worth destroying").toBeGreaterThan(0);

    const res = await call(scoped.port, "/api/clear", "POST", scoped.token, {});
    expect(res.status).toBe(200);
    // Fire-and-forget on the server; give a truncate every chance to land.
    await new Promise(r => setTimeout(r, 250));

    expect(bytes(SHARED), "the shared log lost bytes to a deck that does not write it").toBe(before);
    expect(logLines(SHARED), "the shared log lost lines to a deck that does not write it").toBe(5);
  });

  it("leaves the other deck's canvas and its ability to replay intact", async () => {
    expect(await hookEvents(wide), "the machine-wide deck's canvas").toBe(5);
    // The half the reporter could not see: what a restart of that deck would
    // rebuild. Every one of the five events is still on disk to be replayed.
    const replayable = readFileSync(SHARED, "utf8").split("\n").filter(Boolean)
      .map(l => JSON.parse(l).payload?.hook_event_name);
    expect(replayable).toEqual(["SessionStart", "PreToolUse", "PreToolUse", "PreToolUse", "PreToolUse"]);
  });

  it("still clears the canvas the user was looking at", async () => {
    // The press is not refused — what the user asked for is their own board, and
    // they get it. Only the file that is not this deck's stays.
    //
    // The first assertion is not ceremony: it is what stops the second one from
    // passing on a board that had nothing on it to begin with. The clear that
    // empties this canvas happened in the first case of this block.
    expect(await hookEvents(scoped), "the scoped deck's own canvas").toBe(0);
  });

  it("says whose log it declined to empty, in the answer and in the plan", async () => {
    const res = await call(scoped.port, "/api/clear", "POST", scoped.token, {});
    expect(res.json?.log).toBe("kept");
    expect(res.json?.mine).toBe(false);
    expect(res.json?.decks).toBe(2);
    expect((res.json?.owner as { port: number }).port).toBe(wide.port);

    // And the same facts before the press, which is where they matter: this is
    // what the dialog asks as it opens.
    const plan = await call(scoped.port, "/api/clear", "GET");
    expect(plan.status).toBe(200);
    expect(plan.json?.mine).toBe(false);
    expect(plan.json?.decks).toBe(2);
    expect(plan.json?.path).toBe(SHARED);
    expect((plan.json?.owner as { port: number }).port).toBe(wide.port);
  });

  it("turns that plan into a confirmation that does not promise a deletion", async () => {
    const plan = readClearPlan((await call(scoped.port, "/api/clear", "GET")).json);
    expect(plan, "the dialog must be able to read the server's own answer").not.toBeNull();
    const { note, confirm } = clearCopy(3, plan);
    expect(note).toContain(`the deck on port ${wide.port} owns that file`);
    expect(note).toMatch(/leaves the event log alone/);
    expect(note).not.toMatch(/deletes the event log/);
    // The button stops saying "everything" when it is not going to destroy
    // everything.
    expect(confirm).toBe("Clear this canvas");
  });
});

describe("Clear on the deck that does own it", () => {
  it("empties the log, and leaves nothing behind in it", async () => {
    const res = await call(wide.port, "/api/clear", "POST", wide.token, {});
    expect(res.status).toBe(200);
    expect(res.json?.log).toBe("cleared");
    expect(res.json?.mine).toBe(true);
    await until(() => bytes(SHARED) === 0, "the owner's truncate to land");
    // Zero, not 134: the `__clear` marker is broadcast and no longer appended.
    // A marker in a log that was just emptied says nothing a replay of the empty
    // file does not already say, and appending it was how a deck that writes
    // nothing else still left bytes in a file it did not own.
    expect(bytes(SHARED)).toBe(0);
    expect(await hookEvents(wide), "the owner's canvas").toBe(0);
  });

  it("counts the decks that lose their history with it", async () => {
    const plan = readClearPlan((await call(wide.port, "/api/clear", "GET")).json);
    expect(plan?.mine).toBe(true);
    expect(plan?.decks).toBe(2);
    const { note, confirm } = clearCopy(3, plan);
    // The sentence the reporter never saw: what goes is not only this deck's.
    expect(note).toContain("1 other running deck shares");
    expect(note).toContain("all 3 agents on the canvas");
    expect(confirm).toBe("Clear everything");
  });
});

describe("A deck whose log nobody else holds", () => {
  it("clears it exactly as it always did", async () => {
    // The ordinary case, and the one a gate like this could quietly break: one
    // deck, one log, Clear empties it.
    solo = await startServer({ port: 0, persist: SOLO, workspace: "", codex: false });
    const port = (solo.address() as AddressInfo).port;
    await writeDiscovery({ port, workspace: "", token: hookToken(), persist: SOLO, codex: false });

    await call(port, "/api/event", "POST", undefined, {
      hook_event_name: "SessionStart", session_id: "sess-solo", cwd: SANDBOX,
    });
    await until(() => bytes(SOLO) > 0, "the solo deck's log to be written");

    const sharing = await logSharing();
    expect(sharing.decks, "a log nobody else names is shared with nobody").toBe(1);
    expect(sharing.mine).toBe(true);

    const res = await call(port, "/api/clear", "POST", hookToken(), {});
    expect(res.json?.log).toBe("cleared");
    await until(() => bytes(SOLO) === 0, "the solo deck's log to be emptied");

    // And it is the deck the old copy was written for, so it keeps the old
    // promise.
    const { note, confirm } = clearCopy(1, readClearPlan(res.json));
    expect(note).toContain("deletes this deck's event log");
    expect(note).toContain("the one agent");
    expect(confirm).toBe("Clear everything");
  }, 60_000);
});

describe("The second deck's own process", () => {
  it("loads the server through a URL, so a Windows runner can start it at all", () => {
    // This file's cases are the only ones in the suite that assert what one
    // deck's Clear does to ANOTHER deck's file, and they need a second process
    // to have a second deck. The first version handed that process the repo root
    // as an environment variable and built its import specifier out of it, which
    // is fine on POSIX by accident — `/a/b` is a usable specifier because it
    // reads as a URL path — and fatal on Windows, where `D:\a\b` parses as a URL
    // with the scheme `d:` and Node answers ERR_UNSUPPORTED_ESM_URL_SCHEME. The
    // deck exited 1 before printing anything, `beforeAll` threw, and vitest
    // reported all eleven cases as SKIPPED: a leg that never ran the assertions
    // for a data-loss bug whose Windows behaviour is the part most worth
    // testing, and a green-looking file either side of it.
    //
    // Checkable from any machine, which is the point — the platform that breaks
    // is the one nobody here can run.
    const src = readFileSync(HARNESS, "utf8");
    expect(src, "the server must be resolved against this file, not a path passed in")
      .toContain('new URL("../../server/index.mjs", import.meta.url).href');
    // No specifier assembled from a string that could be a Windows path. A
    // template literal or a `+` in front of `import(` is exactly how the first
    // version was written.
    expect(src).not.toMatch(/import\(\s*[`'"]?\$\{/);
    expect(src).not.toMatch(/import\([^)]*\+/);
    // And nothing hands it one to be tempted by. TEMP is on C: and the checkout
    // on D: on GitHub's Windows runners, so there is not even a shared root to
    // fall back on. The name is assembled rather than written, so that this
    // assertion is not satisfied by its own source — the same reason
    // skip-gate-inventory.test.ts builds its fixtures through `gate()`.
    const test = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "clear-shared-log-698.test.ts"), "utf8");
    expect(test, "a repo path in the child's environment is a specifier waiting to happen")
      .not.toMatch(new RegExp("DECK_" + "ROOT"));
  });
});

describe("The sentence when the server has not answered yet", () => {
  it("names the shared file rather than guessing quietly", () => {
    // A dialog that opened a frame ago, a deck too old to answer `GET
    // /api/clear`, a request that failed: all of them are "I do not know", and
    // the cost of over-warning is a cancelled click while the cost of
    // under-warning is somebody's history.
    const { note } = clearCopy(2, null);
    expect(note).toContain("every deck on this machine shares");
    expect(note).toContain("all 2 agents");
  });

  it("is the sentence the dialog actually shows", () => {
    // None of the cases above render React, so this is what stops the component
    // from going back to a sentence of its own: it must ASK the server what the
    // press will destroy, and it must show the answer clearCopy builds. The
    // string it used to hardcode — "the server's event log" — was true of
    // exactly one server in a product that runs several over one file.
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "components", "ClearConfirm.tsx"), "utf8");
    expect(src).toMatch(/from "\.\.\/clear-confirm"/);
    expect(src).toMatch(/clearCopy\(agentCount, plan\)/);
    expect(src).toMatch(/fetch\("\/api\/clear"\)/);
    expect(src).toMatch(/readClearPlan\(/);
    expect(src, "the copy is clearCopy's to write, not the component's").not.toContain("the server's event log");
  });

  it("reads an unusable answer as unknown rather than as safe", () => {
    // index.html, a 404 body, an old deck's `{ok:true}` — none of them are a
    // plan, and none may be read as "this deck is alone".
    for (const body of [null, "<!doctype html>", {}, { ok: true }, { decks: 2 }]) {
      expect(readClearPlan(body)).toBeNull();
    }
  });
});
