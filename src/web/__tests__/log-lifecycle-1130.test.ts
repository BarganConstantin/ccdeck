// THREE PLACES THE LOG'S LIFECYCLE STILL DISAGREED WITH WHAT THE DECK SAID (#1130).
//
// Found reviewing #1062, which made events.jsonl say when it loses a line and
// stopped Clear and rotation moving it mid-append. Each was reproduced on main
// with a real server over a sandboxed HOME before anything was changed:
//
// 1. A CLEAR ON A ROTATED LOG CAME BACK AT THE NEXT BOOT. `/api/clear`
//    truncated events.jsonl and left events.jsonl.1 where it was, and since
//    #1062 `replayLog` reads the archive whenever the live log cannot fill the
//    ring — which a live log the Clear has just emptied never can. So the boot
//    replay restored exactly what the user cleared, behind a confirmation that
//    says it cannot be undone. Before #1062 nothing read the archive, so a
//    Clear stayed cleared.
//
// 2. EVENTS POSTED WHILE CLEAR WAITED ON THE QUEUE SURVIVED IN THE FILE.
//    `flushAppends` waits for the queue as it stood when it was called, and the
//    truncate ran beside the queue rather than in it, so a line queued during
//    the wait could land after the truncate. The ring had been emptied, so the
//    event was gone from the board; the file still had it, so the next restart
//    put it back.
//
// 3. RESTART STAYED REFUSED AFTER THE LOG RECOVERED. `_persistWritable` was
//    set by the boot probe and by nothing else, and `canRestartNow` required
//    it — so a log that could not be opened at boot and could be a moment later
//    (a mount that came up late, a permission that was fixed) kept Restart
//    refused for the life of the process, with the lines landing on disk and
//    the failure count at zero.
//
// The numbers each case measured on main are next to it.
import { describe, it, expect, afterAll, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Sandbox first, module import second: the server resolves its config dir, its
// Codex home and its discovery directory at import time. HOME and USERPROFILE
// together cover POSIX and Windows; nothing in this file can reach the
// developer's own ~/.claude, ~/.codex or ~/.ccdeck.
//
// Under /var/tmp rather than os.tmpdir() off Windows, so no deck this file
// boots has a HOME inside the shared system temp directory — the place #551 and
// #955 moved the deck's own stagers out of. Windows' tmpdir is per-user already.
const BASE = process.platform === "win32" ? tmpdir() : "/var/tmp";
const SANDBOX = mkdtempSync(join(BASE, "ccdeck-log-lifecycle-1130-"));
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

// @ts-expect-error — plain .mjs server module, no types
const { appendLogLine, emptyLog, flushAppends } = await import("../../server/log-writer.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { startServer, hookToken, replayLog, eventsSince } = await import("../../server/index.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { claudeConfigDir } = await import("../../server/claude-dir.mjs");

// Belt and braces. Every assertion below is about a log being emptied, removed
// or replayed; if an override had not taken, this file would be doing that to
// the developer's real event log.
if (!resolve(String(claudeConfigDir())).startsWith(resolve(CONFIG))) {
  throw new Error(`refusing to run: resolved ${claudeConfigDir()}, outside ${CONFIG}`);
}

const append = appendLogLine as (file: string, line: string) => Promise<void>;
const empty = emptyLog as (file: string, archives?: string[], ms?: number) => Promise<boolean>;
const flush = flushAppends as (file: string, ms?: number) => Promise<boolean>;
const replay = replayLog as (file: string, workspace?: string) => Promise<number>;
type Envelope = { seq: number; payload: Record<string, unknown> | null };
const since = eventsSince as (seq: number) => Envelope[];
const token = () => (hookToken as () => string)();
const headers = () => ({ "content-type": "application/json", "x-ccdeck-token": token() });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// One port per deck, fixed and never reused inside this file, so no case binds
// a port another case has only just released — the Windows SO_EXCLUSIVEADDRUSE
// race append-failure-991.test.ts describes.
const PORT_ROTATED = 4610;
const PORT_BURST = 4611;
const PORT_GATE = 4612;

async function boot(port: number, persist: string, extra: Record<string, unknown> = {}): Promise<Server> {
  return await (startServer as (o: Record<string, unknown>) => Promise<Server>)({
    port, host: "127.0.0.1", persist, codex: false, claude: false, portRange: [port, port], ...extra,
  });
}

async function stop(deck: Server | null): Promise<void> {
  if (!deck) return;
  deck.closeAllConnections?.();
  await new Promise<void>(done => deck.close(() => done()));
}

/** One envelope, in the shape replayLog parses back. */
function envelope(session: string, cwd: string): string {
  return JSON.stringify({
    source: "hook", receivedAt: Date.now(),
    payload: { hook_event_name: "PreToolUse", tool_name: "Bash", session_id: session, cwd },
  }) + "\n";
}

/** Where the ring is now, so a case can read back only what it pushed. */
function mark(): number {
  const all = since(0);
  return all.length ? all[all.length - 1].seq : 0;
}

/** The session ids in one log file, in file order. */
function sessionsIn(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean)
    .map(line => String((JSON.parse(line) as Envelope).payload?.session_id));
}

afterAll(() => {
  for (const k of Object.keys(PREV)) {
    if (PREV[k] === undefined) delete process.env[k];
    else process.env[k] = PREV[k];
  }
  rmTempDir(SANDBOX);
});

describe("a Clear on a log that has rotated", () => {
  let deck: Server | null = null;
  afterAll(() => stop(deck));

  it("stays cleared across the next boot, on both of the replay's paths", async () => {
    // MEASURED on main: the archive held three events and the live log one.
    // `/api/clear` answered `log: "cleared"` and left the live file at 0 bytes,
    // and replayLog on the same path then returned the three archived sessions
    // — on the backwards (machine-wide) path and the forwards (scoped) one
    // alike, because the one reads the archive when the live log runs out and
    // the other probes the live log, finds it cannot fill the ring, and reads
    // the archive first.
    const persist = join(SANDBOX, "rotated", "events.jsonl");
    mkdirSync(dirname(persist), { recursive: true });
    writeFileSync(persist + ".1", ["archived-a", "archived-b", "archived-c"].map(s => envelope(s, TREE)).join(""));
    writeFileSync(persist, envelope("live-before-clear", TREE));

    deck = await boot(PORT_ROTATED, persist);
    const cleared = await fetch(`http://127.0.0.1:${PORT_ROTATED}/api/clear`, {
      method: "POST", headers: headers(), body: "{}",
    }).then(r => r.json());
    expect(cleared.log, "this deck owns the log, so the Clear is its to make").toBe("cleared");
    await stop(deck);
    deck = null;

    // What the next boot does with the same file: `replayLog(persistPath,
    // workspace)`. Machine-wide first, then scoped to the tree the sessions ran
    // in, so both of the replay's readers are asked.
    const back: Record<string, unknown[]> = {};
    for (const [name, workspace] of [["machine-wide", ""], ["scoped", TREE]]) {
      const from = mark();
      await replay(persist, workspace);
      back[name] = since(from).map(e => e.payload?.session_id);
    }
    expect(back, "what the next boot puts back on the board").toEqual({ "machine-wide": [], scoped: [] });

    // And nothing of it is left on disk to be read some other way — the
    // confirmation promises the history is gone, not that the deck declines to
    // look at it.
    expect([...sessionsIn(persist), ...sessionsIn(persist + ".1")]).toEqual([]);
  });
});

describe("emptying a log in its turn on the append queue", () => {
  it("erases every line queued before it, and none queued after it", async () => {
    // The ordering the Clear relies on, asked of the primitive with no timing
    // in it at all. Both batches are queued in one synchronous run each, exactly
    // as pushEvent queues them, so the chain's first write cannot begin until
    // all fifty lines and the turn between them are on it.
    const path = join(SANDBOX, "turn", "events.jsonl");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path + ".1", envelope("older-generation", ""));
    for (let i = 0; i < 25; i++) append(path, envelope(`before-${i}`, ""));
    const emptied = empty(path, [path + ".1"]);
    for (let i = 0; i < 25; i++) append(path, envelope(`after-${i}`, ""));

    expect(await emptied, "the turn came and went inside its deadline").toBe(true);
    expect(await flush(path)).toBe(true);
    expect(sessionsIn(path), "only what was queued after the turn, all of it, in order")
      .toEqual(Array.from({ length: 25 }, (_, i) => `after-${i}`));
    expect(existsSync(path + ".1"), "and the older generation went in the same turn").toBe(false);
  });
});

describe("Clear, while a session is still posting", () => {
  let deck: Server | null = null;
  afterAll(() => stop(deck));

  it("keeps nothing it took off the board, and loses nothing it left on it", async () => {
    // MEASURED on main, this case run five times: 4, 5, 3, 3 and 2 events left
    // in the file that the Clear had taken off the board — every run.
    const persist = join(SANDBOX, "burst", "events.jsonl");
    deck = await boot(PORT_BURST, persist);
    const url = (p: string) => `http://127.0.0.1:${PORT_BURST}${p}`;
    const post = (body: Record<string, unknown>) => fetch(url("/api/event"), {
      method: "POST", headers: headers(), body: JSON.stringify(body),
    }).then(r => r.json() as Promise<{ ok: boolean; seq: number }>);

    // A queue worth waiting on. Tool responses just under the 5,000,000
    // character ingest cap, which is what keeps the chain busy long enough for
    // the session below to still be posting while the Clear waits on it.
    const big = "x".repeat(4_800_000);
    for (let i = 0; i < 12; i++) {
      await post({ hook_event_name: "PostToolUse", cwd: TREE, session_id: "before", tool_name: "Bash", n: i, tool_response: big });
    }

    // A session still talking while the user presses Clear. Every post's `seq`
    // is kept, because the board's own rule decides which side of the press an
    // event is on: the reducer forgets everything before the `__clear` marker,
    // so an event numbered below it is one the Clear took off the board, and
    // one numbered above it is one the board still shows.
    const seqOf = new Map<number, number>();
    let n = 0;
    let streaming = true;
    const stream = (async () => {
      const inflight: Promise<void>[] = [];
      while (streaming) {
        const k = n++;
        inflight.push(post({ hook_event_name: "PreToolUse", cwd: TREE, session_id: "during", tool_name: "Read", n: k })
          .then(a => { if (a.ok) seqOf.set(k, a.seq); }, () => {}));
        await sleep(1);
      }
      await Promise.all(inflight);
    })();
    // Some of the stream is answered before the press, so the "took off the
    // board" side of this case is never empty by luck.
    while (seqOf.size < 3) await sleep(1);
    const cleared = await fetch(url("/api/clear"), { method: "POST", headers: headers(), body: "{}" }).then(r => r.json());
    expect(cleared.log).toBe("cleared");
    await sleep(30);
    streaming = false;
    await stream;
    // And some of it is posted after the answer, one at a time, so the "left
    // on it" side is never empty by luck either: an event posted after the
    // Clear has answered cannot be numbered below a marker pushed before it did.
    for (let i = 0; i < 3; i++) {
      const k = n++;
      const a = await post({ hook_event_name: "PreToolUse", cwd: TREE, session_id: "during", tool_name: "Read", n: k });
      seqOf.set(k, a.seq);
    }
    expect(await flush(persist, 10_000), "the queue ran dry before anything is read").toBe(true);

    const markers = since(0).filter(e => e.payload?.hook_event_name === "__clear");
    expect(markers.length, "the Clear pushed its marker").toBeGreaterThan(0);
    const clearSeq = markers[markers.length - 1].seq;
    const taken = [...seqOf].filter(([, seq]) => seq < clearSeq).map(([k]) => k);
    const left = [...seqOf].filter(([, seq]) => seq > clearSeq).map(([k]) => k);
    expect(taken.length, "the premise: some of the session was on the board before the press").toBeGreaterThan(0);
    expect(left.length, "and some of it after").toBeGreaterThan(0);

    const lines = readFileSync(persist, "utf8").split("\n").filter(Boolean)
      .map(line => (JSON.parse(line) as Envelope).payload ?? {});
    const inFile = new Set(lines.filter(p => p.session_id === "during").map(p => p.n as number));
    expect(lines.filter(p => p.session_id === "before").length, "the burst the Clear waited on").toBe(0);
    expect(taken.filter(k => inFile.has(k)), "taken off the board, and still in the file a restart replays").toEqual([]);
    expect(left.filter(k => !inFile.has(k)), "left on the board, and missing from the file").toEqual([]);
  }, 60_000);
});

describe("the Restart gate, on a log that comes and goes", () => {
  let deck: Server | null = null;
  afterAll(() => stop(deck));

  it("opens once a line reaches the log, and closes again when one does not", async () => {
    // MEASURED on main: a line on disk and the failure count at 0, and
    // `canRestart` still false.
    //
    // The failure is forced the way append-failure-991.test.ts forces it: the
    // parent of the log path is an ordinary FILE, so neither the boot's mkdir
    // nor `open(path, "a")` can get through it on any platform. Replacing the
    // file with a directory is the volume coming back; replacing the directory
    // with a file again is it going away.
    const volume = join(SANDBOX, "volume");
    const persist = join(volume, "events.jsonl");
    const unplug = () => { rmSync(volume, { recursive: true, force: true }); writeFileSync(volume, "not a directory\n"); };
    const plugIn = () => { rmSync(volume, { recursive: true, force: true }); mkdirSync(volume); };
    const url = (p: string) => `http://127.0.0.1:${PORT_GATE}${p}`;
    const get = (p: string) => fetch(url(p), { headers: headers() }).then(r => r.json());
    const gate = async () => ({ canRestart: (await get("/api/version")).canRestart, log: (await get("/api/health")).log });
    /** One event, waited for until its append has landed or failed. */
    const speak = async (session: string) => {
      const ack = await fetch(url("/api/event"), {
        method: "POST", headers: headers(),
        body: JSON.stringify({ hook_event_name: "PreToolUse", cwd: TREE, session_id: session, tool_name: "Read" }),
      }).then(r => r.json());
      expect(ack.ok).toBe(true);
      expect(await flush(persist)).toBe(true);
    };

    unplug();
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      deck = await boot(PORT_GATE, persist, { onRestart: () => {} });
      let now = await gate();
      expect(now.canRestart, "the premise: refused at boot, where the probe could not open the log").toBe(false);
      expect(now.log.writable).toBe(false);

      plugIn();
      await speak("after-mount");
      expect(sessionsIn(persist), "the line reached the disk").toEqual(["after-mount"]);
      now = await gate();
      expect(now.log.failing, "and the appender has nothing to say against it").toBe(0);
      expect(now.canRestart, "so the button offers itself again").toBe(true);
      expect(now.log.writable, "and the health probe agrees with it").toBe(true);

      // Closing is not new — a failing append has always shut the gate — but it
      // has to still be true of a gate that can now reopen.
      unplug();
      await speak("while-unplugged");
      now = await gate();
      expect(now.log.failing).toBe(1);
      expect(now.canRestart, "a line that did not land closes it").toBe(false);
      expect(now.log.writable).toBe(false);

      plugIn();
      await speak("plugged-back-in");
      now = await gate();
      expect(now.canRestart, "and the next one that lands opens it again").toBe(true);
      expect(now.log.writable).toBe(true);
    } finally {
      quiet.mockRestore();
    }
  });
});
