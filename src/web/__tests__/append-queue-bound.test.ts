// The ring beside it kept its 128 MiB budget exactly. The append queue held
// 1.4 GB, and nothing anywhere counted it.
//
// `appendLogLine` serialized appends behind a per-file promise chain and
// bounded them by nothing: every queued line's full string is retained by the
// closure that will eventually write it, and the only brake on how many of
// those exist at once is how fast write(2) returns. pushEvent hands each line
// over fire-and-forget and answers `{ok:true, seq}` on the next statement, so
// `POST /api/event` admits them as fast as a socket can deliver them.
//
// Measured on Linux 7.0 / Node 24.21 / ext4 on NVMe — eight sockets posting
// 1 MB `tool_response` bodies to a sandboxed deck for four seconds:
//
//   t=2.5s  log_MB=51    rss_MB=1741
//   t=4.1s  log_MB=85    rss_MB=2260   <- ingest stops; 1540 MB acknowledged
//   t=6.0s  log_MB=1540  rss_MB=546    <- queue finally drained
//
// 85 MB on disk against 1540 MB the deck had said it had. 1455 MB of serialized
// lines held in the heap, and an RSS peak of 2260 MB — 17x MAX_BUFFER_CHARS,
// the budget the ring one file over keeps exactly. The same burst under
// `--max-old-space-size=1024` aborted 3.2 s in with `FATAL ERROR: Reached heap
// limit`, SIGABRT, 50 MB written — and that abort is not catchable, so the SSE
// stream, the hook ingest and the log stop together. `/api/event` is a
// deliberate open mutation, so those posts need no credential at all.
//
// With the bound, the same burst under the same 1024 MB heap runs to completion
// with RSS oscillating in a 400-750 MB band and the deck still up.
//
// Three things to pin, each breakable without touching the other two:
//
//   1. The BOUND. Pending characters never pass MAX_PENDING_APPEND_CHARS, and
//      the queue takes everything it can fit before it refuses anything — a
//      bound that sheds early would trade the OOM for a deck that drops events
//      it had room for.
//   2. The EXCEPTION. An empty queue always accepts, whatever the line weighs,
//      because ingest admits 5,000,000 characters and a Codex rollout line read
//      off disk has no length bound at all. The ring makes the same exception
//      for the same reason, and without it a deck silently never records its
//      largest events.
//   3. The COUNTER AND THE LINE. Discarding events with no number and no
//      message is the other half of what was filed here: a bound whose only
//      observable effect is a hole in the log is not much better than one whose
//      only observable failure is the process dying.
//
// HOW THE BURST IS MADE DETERMINISTIC, since a test that raced a real disk
// would be a test that passes on the machine that wrote it. Every append in a
// case below is issued in ONE synchronous loop: the first write cannot begin
// until the loop has finished, because the chain's first step is a microtask
// and microtasks do not run until the stack is empty. So the queue is at its
// fullest at exactly the moment the loop ends, with no timing left in it at
// all — no sleeps, no polling, and no injected clock.
//
// The lines are also pointed at a path whose parent does not exist, so each
// `open(…, "a")` fails and nothing is written. The case under test is
// ADMISSION — what the queue agrees to hold — and the writing half already has
// a suite of its own in log-line-atomic.test.ts. Running these against a real
// file would mean 128 MiB of writes per case to prove that memory is NOT being
// held, which is the one thing a 128 MiB temp file is bad at demonstrating.
// One case below does use a real file, to show that an accepted line is still
// written and the accounting still lands back on zero.
import { describe, it, expect, afterAll, afterEach, beforeEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Nothing here reads the developer's home — log-writer.mjs resolves no config
// at all — but the temp directory is claimed before the import either way, so
// the pattern every other suite here follows is not broken by this one.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-append-bound-"));

// @ts-expect-error — plain .mjs server module, no types
const mod = await import("../../server/log-writer.mjs");
const appendLogLine = mod.appendLogLine as (file: string, line: string) => Promise<void>;
const appendQueueStats = mod.appendQueueStats as () => {
  pendingLines: number; pendingChars: number;
  droppedLines: number; droppedChars: number; dropEpisodes: number;
};
const MAX_PENDING_APPEND_CHARS: number = mod.MAX_PENDING_APPEND_CHARS;

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = join(HERE, "..", "..", "server", "index.mjs");

// A path that cannot be opened: the parent directory is not there, on POSIX and
// on Windows alike. See the note above for why the writes are meant to fail.
const UNWRITABLE = join(DIR, "no-such-directory", "events.jsonl");

/** One line of exactly `chars` characters, newline included. */
const line = (chars: number) => "A".repeat(chars - 1) + "\n";

/** Hand `count` copies of one line over in a single tick, and wait for the
 *  queue to empty afterwards. The same string object every time, so a case that
 *  charges 320 MB allocates eight. */
async function burst(path: string, count: number, text: string): Promise<void> {
  const issued: Promise<void>[] = [];
  for (let i = 0; i < count; i++) issued.push(appendLogLine(path, text));
  await Promise.all(issued);
}

let said: string[] = [];
const realError = console.error;
beforeEach(() => {
  said = [];
  console.error = (...args: unknown[]) => { said.push(args.map(String).join(" ")); };
});
// Put back after every case, not only at the end of the file: a case that fails
// mid-way must not leave the rest of the run unable to print why.
afterEach(() => { console.error = realError; });
afterAll(() => { rmTempDir(DIR); });

describe("the bound on what the append queue may hold", () => {
  it("stops accepting at the budget instead of holding every line handed to it", async () => {
    // Sixteen 8 MiB lines are the budget exactly, so this is not an
    // approximation: the seventeenth is the first that cannot fit, and the
    // twenty-four after it are refused for the same reason.
    const EIGHT_MIB = 8 * 1024 * 1024;
    const text = line(EIGHT_MIB);
    const before = appendQueueStats();

    const issued: Promise<void>[] = [];
    for (let i = 0; i < 40; i++) issued.push(appendLogLine(UNWRITABLE, text));

    // Read in the same tick the loop ran in — nothing has been written, and
    // nothing can have been, so this is the high-water mark by construction.
    const peak = appendQueueStats();
    expect(peak.pendingChars, "held at the budget and not one line past it")
      .toBe(MAX_PENDING_APPEND_CHARS);
    expect(peak.pendingLines).toBe(16);
    expect(peak.droppedLines - before.droppedLines).toBe(24);
    expect(peak.droppedChars - before.droppedChars).toBe(24 * EIGHT_MIB);
    // Without the bound this is what the queue would have been holding: 320 MB
    // of one burst, and nothing to stop the next burst adding to it.
    expect(40 * EIGHT_MIB).toBeGreaterThan(2 * MAX_PENDING_APPEND_CHARS);

    await Promise.all(issued);
    const after = appendQueueStats();
    expect(after.pendingLines, "the charge is given back as lines leave").toBe(0);
    expect(after.pendingChars).toBe(0);
  });

  it("takes everything it has room for before it refuses anything", async () => {
    // A bound that sheds early is its own bug. Ordinary traffic is about 5 KB
    // per serialized event, so a full 2000-event ring's worth of it is 10 MB —
    // a thirteenth of this budget, which is one of the three readings that
    // picked the number. Nothing in that burst may be dropped.
    const before = appendQueueStats();
    await burst(UNWRITABLE, 2000, line(5 * 1024));
    const after = appendQueueStats();
    expect(after.droppedLines - before.droppedLines,
      "ordinary traffic never meets this bound at all").toBe(0);
    expect(after.pendingLines).toBe(0);
  });

  it("always accepts a line when the queue is empty, however large it is", async () => {
    // Ingest admits 5,000,000 characters and a Codex rollout line read off disk
    // has no length bound at all. Refusing an oversized line outright would
    // mean a deck that never records its largest events — so the true ceiling
    // is the budget plus one line, exactly as the ring's is MAX_BUFFER_CHARS
    // plus one event.
    const before = appendQueueStats();
    expect(before.pendingLines, "the queue is empty before this starts").toBe(0);
    await appendLogLine(UNWRITABLE, line(6_000_000));
    const after = appendQueueStats();
    expect(after.droppedLines - before.droppedLines).toBe(0);
    expect(after.pendingLines).toBe(0);
  });

  it("writes every line it accepted, and lands the accounting back on zero", async () => {
    // The real-file half. If the charge were released on the wrong promise, or
    // twice, the counter would drift and a later burst would shed against a
    // budget already spent — the debt clearEventBuffer's comment describes for
    // the ring's running total, which is the same mistake one file over.
    const file = join(DIR, "events.jsonl");
    const issued: Promise<void>[] = [];
    for (let i = 0; i < 20; i++) issued.push(appendLogLine(file, JSON.stringify({ seq: i }) + "\n"));
    await Promise.all(issued);
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(20);
    expect(JSON.parse(lines[19]).seq).toBe(19);
    expect(appendQueueStats().pendingChars).toBe(0);
    expect(appendQueueStats().pendingLines).toBe(0);
  });
});

describe("what the deck says when it drops an event", () => {
  it("names the queue once at the start and reports the total when it drains", async () => {
    // Discarding events with no counter and no line is the other half of what
    // was filed here. One line at the start and one at the end, and not one per
    // refusal: a burst refuses thousands, and thousands of lines onto the
    // terminal the deck paints over would be its own version of the problem.
    const EIGHT_MIB = 8 * 1024 * 1024;
    const before = appendQueueStats();
    await burst(UNWRITABLE, 24, line(EIGHT_MIB));

    const full = said.filter(s => /append queue is full/.test(s));
    expect(full, "once, at the start of the episode").toHaveLength(1);
    expect(full[0]).toMatch(/^ccdeck: /);
    expect(full[0]).toContain(UNWRITABLE);
    expect(full[0]).toMatch(/\d+MB waiting/);
    // One line, always: this prints onto the terminal the deck paints over.
    expect(full[0]).not.toContain("\n");

    const drained = said.filter(s => /append queue drained/.test(s));
    expect(drained, "once, when the last queued line is gone").toHaveLength(1);
    // Eight of the twenty-four did not fit. The count is what separates one
    // dropped tool response from a session that is not in the log at all.
    expect(drained[0]).toContain("8 event(s)");
    expect(drained[0]).toContain("64MB");
    expect(drained[0]).not.toContain("\n");

    const after = appendQueueStats();
    expect(after.dropEpisodes - before.dropEpisodes).toBe(1);
    expect(after.droppedLines - before.droppedLines).toBe(8);
  });

  it("says nothing at all when nothing was dropped", async () => {
    // The ordinary case, and the one this must not cost anything on: a deck
    // that printed about its append queue on a quiet day would be a deck whose
    // one real warning nobody reads.
    await burst(UNWRITABLE, 50, line(1024));
    expect(said.filter(s => /append queue/.test(s))).toEqual([]);
  });
});

describe("the budget itself", () => {
  it("is the ring's, at the same size and for the same three readings", () => {
    // Sibling bounds, deliberately: the ring holds parsed payloads and this
    // holds their serialization, so they are two budgets of the same size
    // rather than one counter adding up two different units. Asserted against
    // the ring's own literal, so moving one without the other fails here.
    expect(MAX_PENDING_APPEND_CHARS).toBe(128 * 1024 * 1024);
    expect(readFileSync(INDEX, "utf8"))
      .toContain("export const MAX_BUFFER_CHARS = 128 * 1024 * 1024;");
  });

  it("clears the largest line ingest can produce by a wide margin", () => {
    // `handleEventIngest` admits 5,000,000 characters of request body. A budget
    // that were merely a few of those would collapse to nothing the first time
    // eight subagents each returned a big Read — which is ordinary use, not an
    // attack.
    const INGEST_LIMIT_CHARS = 5_000_000;
    expect(MAX_PENDING_APPEND_CHARS / INGEST_LIMIT_CHARS).toBeGreaterThan(20);
  });
});
