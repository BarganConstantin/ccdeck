// What the boot reads out of a log that is far longer than the ring (#742).
//
// The replay runs before the port opens. It used to parse the whole file from
// the front to fill a ring of MAX_BUFFER events, so on a log with five times
// that in it, four fifths of the parse existed only to be evicted — and the
// cost grew with every session the user ever ran, until rotation cut the file
// at 50 MB. Measured on the machine this was written on: 12,079 lines, 31 MB,
// 690ms of JSON.parse before a browser could connect.
//
// This file pins the two halves of the replacement:
//
//   * The RING IS THE SAME. Reading backwards has to leave exactly what
//     reading forwards left, because what survived a forward replay was always
//     the newest admitted events that fit — anything older had been evicted by
//     the time the file ended.
//   * The READ IS SHORTER. The observable is damage: unparseable lines are
//     written into the OLD end of the log, where a reader that got that far
//     would have counted them and said so on the terminal.
//
// One server, started once, because the ring is module state and a second
// startServer in the same worker would replay into the first one's buffer.
import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Server } from "node:http";
import type { HookEnvelope, HookPayload } from "../types";

// Sandboxed before the server module is imported: it resolves its config
// directories at import time, and the real ~/.claude must stay untouched.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-replay-tail-"));
const prevEnv = { ...process.env };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.XDG_CONFIG_HOME = join(DIR, "config");
for (const p of [process.env.HOME, process.env.CLAUDE_CONFIG_DIR, process.env.CODEX_HOME]) {
  if (!resolve(p!).startsWith(resolve(DIR))) throw new Error(`sandbox escaped: ${p}`);
}

// @ts-expect-error — plain .mjs server module, no types
const mod = await import("../../server/index.mjs");
const startServer = mod.startServer as (o: unknown) => Promise<Server>;
const eventsSince = mod.eventsSince as (seq: number) => HookEnvelope[];
const replayScope = mod.replayScope as (w: string) => ((p: unknown) => boolean) & { orderDependent: boolean };
const MAX_BUFFER = mod.MAX_BUFFER as number;

const LOG = join(DIR, "events.jsonl");
/** How far past the ring the log runs. Small enough to keep the fixture quick,
 *  big enough that a reader which ignored the bound would reach the damage. */
const EXTRA = 500;
const TOTAL = MAX_BUFFER + EXTRA;

const line = (i: number) => JSON.stringify({
  seq: i + 1,
  epoch: "fixture",
  receivedAt: 1_700_000_000_000 + i,
  source: "hook",
  payload: {
    session_id: `s${i}`,
    hook_event_name: "SessionStart",
    cwd: join(DIR, "tree"),
    // Numbered in the payload as well as in the envelope, because the envelope's
    // seq is discarded on replay — pushEvent assigns its own.
    transcript_path: `/t/${i}`,
  },
});

// Two shredded lines at the very front, where the pre-#446 writer's damage
// actually lived. A forward read counts these; a read bounded by the ring never
// reaches them, and that difference is the whole assertion.
const DAMAGE = ['{"seq":0,"payload":{"cwd":"', "not json at all {{{"];

let server: Server | null = null;
let warned: string[] = [];

beforeAll(async () => {
  writeFileSync(LOG, [...DAMAGE, ...Array.from({ length: TOTAL }, (_, i) => line(i))].join("\n") + "\n");
  const warn = vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
    warned.push(a.map(String).join(" "));
  });
  try {
    // Port 0 so this cannot collide with a deck already up on this machine.
    // `claude: false, codex: false` so nothing is installed and no watcher runs
    // — the replay is the only thing under test.
    server = await startServer({
      port: 0, host: "127.0.0.1", persist: LOG, workspace: "", codex: false, claude: false,
    });
  } finally {
    warn.mockRestore();
  }
}, 40_000);

afterAll(async () => {
  if (server) await new Promise<void>(done => server!.close(() => done()));
  for (const k of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME"]) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  rmTempDir(DIR);
});

describe("a log five times longer than the ring", () => {
  it("fills the ring, and no more than the ring", () => {
    expect(eventsSince(0)).toHaveLength(MAX_BUFFER);
  });

  it("holds the NEWEST events, which is what a forward replay left too", () => {
    const held = eventsSince(0);
    const ids = held.map(e => (e.payload as HookPayload).session_id);
    // The last MAX_BUFFER of the TOTAL written, in file order.
    expect(ids[0]).toBe(`s${TOTAL - MAX_BUFFER}`);
    expect(ids[ids.length - 1]).toBe(`s${TOTAL - 1}`);
    expect(ids).toHaveLength(MAX_BUFFER);
  });

  it("numbers them forwards, whichever direction the file was read", () => {
    // `seq` is assigned by pushEvent in call order and is what a resuming
    // client asks to continue from. A ring numbered backwards would hand every
    // one of them a Last-Event-ID meaning the opposite of what it says.
    const held = eventsSince(0);
    const seqs = held.map(e => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    // And the oldest event held is the oldest seq, not the newest.
    expect((held[0].payload as HookPayload).session_id).toBe(`s${TOTAL - MAX_BUFFER}`);
  });

  it("keeps what the envelope carried, rather than restamping it as new", () => {
    const first = eventsSince(0)[0];
    expect(first.receivedAt).toBe(1_700_000_000_000 + (TOTAL - MAX_BUFFER));
    expect(first.source).toBe("hook");
  });

  it("never read as far back as the damage, and so never counted it", () => {
    // The measurement, expressed as behaviour. Those two lines are at the front
    // of a file whose last MAX_BUFFER entries are all this reader needs; a
    // forward read parses them and warns, and the warning is the proof it went
    // there.
    expect(warned.filter(w => w.includes("unreadable"))).toEqual([]);
  });
});

describe("which reader a deck gets is decided by its own scope predicate", () => {
  it("says an unscoped replay may be fed the log backwards", () => {
    expect(replayScope("").orderDependent).toBe(false);
  });

  it("says a scoped one may not", () => {
    // Its cwd-less enrichment events — ModelObserved, UsageObserved,
    // SessionNamed, ContextObserved — are decided by a cwd-bearing event
    // EARLIER in the log. Backwards, the answer arrives after the question and
    // the session lands on the canvas with no model and no tokens; that is what
    // replay-scope-696 saw when this was first written the naive way.
    expect(replayScope(join(DIR, "tree")).orderDependent).toBe(true);
  });
});
