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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
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
const HARNESS = join(dirname(fileURLToPath(import.meta.url)), "clear-shared-log-deck-698.mjs");
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

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
        DECK_ROOT: REPO,
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
    setTimeout(() => fail(new Error(`deck on ${port} never reported ready: ${why.slice(0, 400)}`)), 15_000);
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
const canvas = async (port: number) => {
  const { raw } = await call(port, "/api/events", "GET");
  const parsed = JSON.parse(raw);
  return (Array.isArray(parsed) ? parsed : parsed.events) as { payload: { hook_event_name?: string } }[];
};
const hookEvents = async (port: number) =>
  (await canvas(port)).filter(e => e.payload?.hook_event_name !== "__clear").length;

async function until(ok: () => boolean | Promise<boolean>, what: string, tries = 300) {
  for (let i = 0; i < tries; i++) {
    if (await ok()) return;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

let wide: Deck;      // machine-wide, lowest port — the elected writer
let scoped: Deck;    // scoped to one tree, the deck the reporter pressed Clear on
let solo: Server;    // this process, a deck with a log nobody shares

beforeAll(async () => {
  const [low, high] = await freePorts();
  wide = await boot(low, "");
  scoped = await boot(high, TREE);
  // Five hook events, delivered to the elected writer the way the hook delivers
  // them — the scoped deck would be posted `?persist=0` for the same session.
  for (let i = 0; i < 5; i++) {
    await call(wide.port, "/api/event", "POST", undefined, {
      hook_event_name: i === 0 ? "SessionStart" : "PreToolUse",
      session_id: "sess-698", cwd: TREE, tool_name: "Bash", tool_input: { command: `echo ${i}` },
    });
  }
  await until(() => logLines(SHARED) === 5, "the shared log to hold five lines");
}, 60_000);

afterAll(async () => {
  for (const d of [wide, scoped]) d?.child.kill();
  if (solo) await new Promise<void>(r => solo.close(() => r()));
  await new Promise(r => setTimeout(r, 200));
  for (const [k, v] of Object.entries(PREV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(SANDBOX, { recursive: true, force: true });
});

describe("Clear on a deck that does not own the shared log", () => {
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
    expect(await hookEvents(wide.port), "the machine-wide deck's canvas").toBe(5);
    // The half the reporter could not see: what a restart of that deck would
    // rebuild. Every one of the five events is still on disk to be replayed.
    const replayable = readFileSync(SHARED, "utf8").split("\n").filter(Boolean)
      .map(l => JSON.parse(l).payload?.hook_event_name);
    expect(replayable).toEqual(["SessionStart", "PreToolUse", "PreToolUse", "PreToolUse", "PreToolUse"]);
  });

  it("still clears the canvas the user was looking at", async () => {
    // The press is not refused — what the user asked for is their own board, and
    // they get it. Only the file that is not this deck's stays.
    expect(await hookEvents(scoped.port), "the scoped deck's own canvas").toBe(0);
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
    expect(await hookEvents(wide.port), "the owner's canvas").toBe(0);
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
