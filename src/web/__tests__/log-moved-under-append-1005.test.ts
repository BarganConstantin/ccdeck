// CLEAR AND ROTATION BOTH MOVED THE LOG OUT FROM UNDER AN IN-FLIGHT APPEND,
// AND NOTHING EVER READ events.jsonl.1.
//
// Appends are fire-and-forget behind a per-file promise chain that lives inside
// log-writer.mjs: `pushEvent` calls `appendLogLine` without awaiting it and the
// 200 goes out on the next statement. `appendTails` was never exported and
// there was no flush, so the two operations that move the file underneath that
// chain consulted neither.
//
// 1. CLEAR. Measured on a sandboxed deck — one 3 MB PostToolUse on the wire,
//    eight small envelopes queued behind it, then `POST /api/clear`:
//
//      POST /api/clear answered:       {"ok":true,"log":"cleared", ...}
//      file right after the truncate:  0 bytes
//      file 2.5s after the Clear:      564 bytes, 3 line(s)
//      sessions surviving the Clear:   before-clear
//
//    The ring was emptied, the file was truncated, `__clear` went out over SSE
//    and the canvas went blank — and then the queue drained its PRE-CLEAR lines
//    into the now-empty file. The next restart replays them, so sessions the
//    user explicitly and irreversibly cleared come back. This is #698's residue
//    by a different route, and it survives the ownership gate that fixed #698
//    because it happens on the deck that DOES own the file.
//
// 2. ROTATION. One 24 MB line and one small line queued, the rename performed
//    while the chain was still running:
//
//      events.jsonl    size: 65
//      events.jsonl.1  size: 25165897
//
//    A descriptor opened before the rename completes into the RENAMED inode, so
//    the line being appended at the moment of a rotation lands in the archive.
//
// 3. AND NOTHING READ THE ARCHIVE. A grep for `.1` across src/ and bin/ finds
//    four sites: the rename, the copy deck-home's migration makes, and two
//    comments. `replayLog` is called once, with `persistPath` alone. So the
//    boot immediately after a rotation replayed a file holding a handful of
//    lines while 50 MB of history sat beside it unread — measured, one rotation
//    and then `replayLog(events.jsonl)` returning 1 — and the next rotation's
//    `unlink` deleted it outright.
//
// WHY THE ROTATION CASE IS PINNED ON THE SOURCE AND THE OTHERS ARE NOT.
// `ROTATE_AT_BYTES` is a 50 MB constant with no parameter, and the interleave
// that matters needs a line still inside write(2) at the moment of the rename —
// which at that threshold means a single event of tens of megabytes, well over
// the 5,000,000-character cap ingest enforces. There is no honest way to reach
// it through the deck. So the primitive is tested for real below, and the
// rotation path is pinned on calling it, and on calling it before it moves the
// file.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { rename } from "node:fs/promises";
import { rmTempDir } from "./rm-temp-dir";
import { createServer } from "node:net";
import type { AddressInfo, Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Sandbox first, module import second: the server resolves its config dir, its
// Codex home and its discovery directory at import time. HOME and USERPROFILE
// together cover POSIX and Windows; nothing in this file can reach the
// developer's own ~/.claude, ~/.codex or ~/.agents-deck.
const SANDBOX = mkdtempSync(join(tmpdir(), "ccdeck-log-moved-1005-"));
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
const { appendLogLine, flushAppends } = await import("../../server/log-writer.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { startServer, hookToken, replayLog, eventsSince } = await import("../../server/index.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { claudeConfigDir } = await import("../../server/claude-dir.mjs");

// Belt and braces. Every assertion below is about a file being emptied, moved
// or replayed; if an override had not taken, this file would be doing that to
// the developer's real event log.
if (!resolve(String(claudeConfigDir())).startsWith(resolve(CONFIG))) {
  throw new Error(`refusing to run: resolved ${claudeConfigDir()}, outside ${CONFIG}`);
}

const append = appendLogLine as (file: string, line: string) => Promise<void>;
const flush = flushAppends as (file: string, ms?: number) => Promise<boolean>;
const replay = replayLog as (
  file: string, workspace?: string, o?: { maxEvents?: number; maxChars?: number },
) => Promise<number>;
const since = eventsSince as (seq: number) => { seq: number; payload: Record<string, unknown> }[];

/** Where the ring is now, so a case can read back only what it pushed. */
function mark(): number {
  const all = since(0);
  return all.length ? all[all.length - 1].seq : 0;
}

/** One envelope, in the shape replayLog parses back. */
function envelope(session: string, cwd = ""): string {
  return JSON.stringify({
    source: "hook", receivedAt: Date.now(),
    payload: { hook_event_name: "PreToolUse", tool_name: "Bash", session_id: session, cwd },
  }) + "\n";
}

function freePort(): Promise<number> {
  return new Promise(done => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => done(p));
    });
  });
}

afterAll(() => {
  for (const k of Object.keys(PREV)) {
    if (PREV[k] === undefined) delete process.env[k];
    else process.env[k] = PREV[k];
  }
  rmTempDir(SANDBOX);
});

describe("waiting for the append queue", () => {
  it("does not return until what was queued is on disk", async () => {
    const path = join(SANDBOX, "flush", "events.jsonl");
    mkdirSync(dirname(path), { recursive: true });
    // Queued in ONE synchronous loop and not awaited, exactly as pushEvent does
    // it. The first write cannot begin until the loop ends — the chain's first
    // step is a microtask — so at the moment flush is called the queue is at
    // its fullest, with no timing left in the case at all.
    for (let i = 0; i < 25; i++) append(path, envelope(`s${i}`));
    expect(existsSync(path), "nothing has landed yet, which is the premise").toBe(false);

    expect(await flush(path), "the queue really drained").toBe(true);
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    expect(lines, "every queued line is on disk before flush returns").toHaveLength(25);
  });

  it("returns at once when nothing is queued", async () => {
    // The ordinary case. Clear and rotation both call this on a deck that is
    // idle far more often than not, and neither may pay for it.
    const t0 = Date.now();
    expect(await flush(join(SANDBOX, "never-written.jsonl"))).toBe(true);
    expect(Date.now() - t0).toBeLessThan(50);
  });

  it("gives up on its own deadline rather than holding a request open", async () => {
    // The whole point of the fire-and-forget shape is that no caller waits on
    // the disk indefinitely, and that has to stay true of a caller answering an
    // HTTP request. A deadline reached is the old behaviour, which is no worse
    // than before.
    const path = join(SANDBOX, "flush-slow", "events.jsonl");
    mkdirSync(dirname(path), { recursive: true });
    append(path, envelope("slow"));
    const t0 = Date.now();
    const drained = await flush(path, 0);
    expect(typeof drained).toBe("boolean");
    expect(Date.now() - t0, "bounded, whatever the filesystem is doing").toBeLessThan(500);
  });

  it("puts every queued line in the file that gets archived, not across the two", async () => {
    // The rotation hazard, on the primitive. Renaming while the chain runs
    // sends whatever is inside write(2) into the RENAMED inode: measured, a
    // 24 MB line in events.jsonl.1 against a 65-byte live file. After the flush
    // the split is clean — the archive holds the generation that was written,
    // the live file holds what comes after, and nothing straddles them.
    const path = join(SANDBOX, "rotate", "events.jsonl");
    mkdirSync(dirname(path), { recursive: true });
    for (let i = 0; i < 12; i++) append(path, envelope(`old${i}`));
    await flush(path);
    await rename(path, path + ".1");
    await append(path, envelope("new-generation"));

    const archived = readFileSync(path + ".1", "utf8");
    const live = readFileSync(path, "utf8");
    expect(archived.split("\n").filter(Boolean), "the whole generation went over").toHaveLength(12);
    expect(archived).toContain("old11");
    expect(archived, "and nothing from after the move is in it").not.toContain("new-generation");
    expect(live.split("\n").filter(Boolean)).toHaveLength(1);
    expect(live).toContain("new-generation");
  });

  it("is what the rotation path calls, before it moves the file", () => {
    // Pinned on the source because the real interleave cannot be produced at
    // this threshold — see the file header. Ordering is the whole of it: a
    // flush after the rename is a flush into the archive.
    const src = readFileSync(
      fileURLToPath(new URL("../../server/index.mjs", import.meta.url)), "utf8");
    const flushAt = src.indexOf("await flushAppends(persistPath);");
    const renameAt = src.indexOf("await rename(persistPath, oldPath);");
    const unlinkAt = src.indexOf("try { await unlink(oldPath); } catch {}");
    expect(flushAt, "the rotation path flushes at all").toBeGreaterThan(-1);
    expect(flushAt).toBeLessThan(renameAt);

    // And the ownership gate, which the truncate already had and this did not.
    // Two decks appending to one log is explicitly permitted as the fail-safe,
    // so both cross 50 MB and both rotate: if B's stat lands before A's rename,
    // B's unlink deletes the archive A has just made and B's rename moves the
    // new, near-empty live file into its place.
    const gateAt = src.indexOf("if (!sharing.mine) return;");
    expect(gateAt, "rotation asks whether this deck owns the log").toBeGreaterThan(-1);
    expect(gateAt, "and asks before it deletes the previous archive").toBeLessThan(unlinkAt);
  });
});

describe("the log a restart reads back", () => {
  it("falls through to the archive when the live log cannot fill the ring", async () => {
    // The boot immediately after a rotation. Before this, it replayed the
    // handful of lines written since the rename and drew a blank canvas, while
    // the generation that held the session history sat beside it untouched
    // until the next rotation deleted it.
    const path = join(SANDBOX, "replay-after-rotate", "events.jsonl");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path + ".1", [envelope("archived-a"), envelope("archived-b"), envelope("archived-c")].join(""));
    writeFileSync(path, envelope("live-a"));

    const at = mark();
    const count = await replay(path, "", { maxEvents: 50 });
    expect(count).toBe(4);
    const ids = since(at).map(e => e.payload.session_id);
    // Oldest first, and the archive's generation is older than the live one.
    expect(ids).toEqual(["archived-a", "archived-b", "archived-c", "live-a"]);
  });

  it("never opens the archive when the live log fills the ring on its own", async () => {
    // The cost of the fall-through on an ordinary deck is zero, and this is why:
    // the reader stops the moment either of the ring's bounds is reached, and
    // the archive is the thing it never gets to.
    const path = join(SANDBOX, "replay-full-ring", "events.jsonl");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path + ".1", [envelope("archived-x"), envelope("archived-y")].join(""));
    writeFileSync(path, [envelope("live-1"), envelope("live-2"), envelope("live-3")].join(""));

    const at = mark();
    const count = await replay(path, "", { maxEvents: 2 });
    expect(count, "bounded by the ring, not by the number of files").toBe(2);
    const ids = since(at).map(e => e.payload.session_id);
    expect(ids, "the newest two, and nothing out of the archive").toEqual(["live-2", "live-3"]);
  });

  it("reaches the archive on a scoped deck too, oldest generation first", async () => {
    // A scoped deck reads FORWARDS, because its predicate answers from what it
    // has already seen — the synthetic enrichment events carry a session id and
    // no cwd, and the event that places them is earlier in the log. So the
    // archive has to come first here, not second.
    const path = join(SANDBOX, "replay-scoped", "events.jsonl");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path + ".1", [envelope("scoped-old", TREE), envelope("elsewhere", join(SANDBOX, "other"))].join(""));
    writeFileSync(path, envelope("scoped-new", TREE));

    const at = mark();
    const count = await replay(path, TREE, { maxEvents: 50 });
    expect(count, "the out-of-scope line is refused, the other two are not").toBe(2);
    expect(since(at).map(e => e.payload.session_id)).toEqual(["scoped-old", "scoped-new"]);
  });

  it("replays nothing when neither generation is there", async () => {
    // The `--no-persist` and first-boot cases, which used to be the single
    // `existsSync` this now has to decide for two files.
    expect(await replay(join(SANDBOX, "nothing", "events.jsonl"))).toBe(0);
  });
});

describe("Clear, with a burst still on the wire", () => {
  let port = 0;
  let server: { close: (cb?: () => void) => void } | null = null;
  const persist = join(SANDBOX, "clear-deck", "events.jsonl");
  const url = (p: string) => `http://127.0.0.1:${port}${p}`;
  const headers = () => ({ "content-type": "application/json", "x-ccdeck-token": (hookToken as () => string)() });

  beforeAll(async () => {
    port = await freePort();
    server = await (startServer as (o: Record<string, unknown>) => Promise<Server>)({
      port, persist, codex: false, claude: false, portRange: [port, port],
    }) as unknown as { close: (cb?: () => void) => void };
  });
  afterAll(() => { server?.close(); });

  it("leaves nothing of the cleared sessions in the file", async () => {
    // A 3 MB tool response is the ordinary large event — the ingest cap is
    // 5,000,000 characters — and it is what keeps the chain busy long enough
    // for the small envelopes behind it to still be queued when Clear lands.
    const big = "x".repeat(3 * 1024 * 1024);
    await fetch(url("/api/event"), {
      method: "POST", headers: headers(),
      body: JSON.stringify({ hook_event_name: "PostToolUse", cwd: TREE, session_id: "before-clear", tool_name: "Bash", tool_response: big }),
    });
    for (let i = 0; i < 8; i++) {
      await fetch(url("/api/event"), {
        method: "POST", headers: headers(),
        body: JSON.stringify({ hook_event_name: "PreToolUse", cwd: TREE, session_id: "before-clear", tool_name: "Read", n: i }),
      });
    }

    const cleared = await fetch(url("/api/clear"), { method: "POST", headers: headers(), body: "{}" }).then(r => r.json());
    expect(cleared.ok).toBe(true);
    expect(cleared.log, "this deck owns the file, so it really is emptied").toBe("cleared");
    expect(statSync(persist).size, "empty when the answer goes out").toBe(0);

    // And still empty once the chain has had every chance to drain into it.
    // This was 564 bytes and three events of a session the user had just
    // destroyed, which the next restart would have replayed onto the canvas.
    await new Promise(r => setTimeout(r, 500));
    expect(readFileSync(persist, "utf8"), "and empty after the queue has run").toBe("");
  });
});
