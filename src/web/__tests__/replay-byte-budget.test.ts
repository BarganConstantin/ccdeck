// The boot replay stages what the ring can hold — in BYTES as well as in count.
//
// The ring has two ceilings: MAX_BUFFER events and MAX_BUFFER_CHARS bytes
// (#625). Only eviction applies the second one, and eviction happens inside
// pushEvent — which does not run until the staging array is already full. So
// the reader filled to 2000 events first and let the ring throw most of them
// away afterwards.
//
// Measured on a 187 MB log of 40 events of 4.9M characters each, every one of
// them under the ingest cap: RSS 215 MB → peak 505 MB, and the ring that
// survived held 27 events and 126 MiB. About 290 MB staged for a ring capped at
// 128.
//
// Rotation at 50 MB normally keeps a log well under that, but rotation is
// best-effort and its failure is only logged, and this deck's own header
// records logs reaching gigabytes.
//
// The budget is passed in here rather than reached for: 128 MiB of fixture
// would be a slow test that measures the same rule.
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-replay-bytes-"));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.XDG_CONFIG_HOME = join(DIR, "config");
if (!resolve(process.env.CLAUDE_CONFIG_DIR).startsWith(resolve(DIR))) throw new Error("sandbox escaped");

// @ts-expect-error — plain .mjs server module, no types
const mod = await import("../../server/index.mjs");
const replayLog = mod.replayLog as (p: string, w?: string, o?: { maxEvents?: number; maxChars?: number }) => Promise<number>;
const eventsSince = mod.eventsSince as (seq: number) => Array<{ payload: { session_id: string } }>;
const MAX_BUFFER = mod.MAX_BUFFER as number;
const MAX_BUFFER_CHARS = mod.MAX_BUFFER_CHARS as number;

afterAll(() => rmTempDir(DIR));

/** One admissible event whose payload is `bytes` characters of prompt. */
const fat = (i: number, bytes: number) => JSON.stringify({
  seq: i + 1,
  epoch: "fixture",
  receivedAt: 1_700_000_000_000 + i,
  source: "hook",
  payload: {
    hook_event_name: "UserPromptSubmit",
    session_id: `s${i}`,
    cwd: "/tmp/anywhere",
    prompt: "x".repeat(bytes),
  },
});

describe("what a boot replay is allowed to stage", () => {
  it("stops at the byte budget long before the event count", async () => {
    // Twenty events of 64 KB against a budget of 256 KB: the count bound is
    // 2000 and would read every one of them.
    const log = join(DIR, "fat.jsonl");
    writeFileSync(log, Array.from({ length: 20 }, (_, i) => fat(i, 64 << 10)).join("\n") + "\n");

    const count = await replayLog(log, "", { maxChars: 256 << 10 });
    expect(count).toBeLessThan(20);
    expect(count).toBeGreaterThan(0);
    // Five events of 64 KB is 320 KB, so the reader stops on the fifth: the
    // ceiling is the budget plus one event, exactly as the ring's own eviction
    // rule is stated.
    expect(count).toBeLessThanOrEqual(5);
  });

  it("keeps the NEWEST events, which is what the ring would have kept anyway", async () => {
    const held = eventsSince(0);
    expect(held.length).toBeGreaterThan(0);
    // The fixture's last event is s19; a backwards read that stopped early must
    // have stopped at the OLD end.
    expect(held.at(-1)!.payload.session_id).toBe("s19");
    // And pushed oldest-first, so seq still runs the way a resuming client
    // reads it.
    const ids = held.map(e => Number(e.payload.session_id.slice(1)));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it("still stops at the event count when the events are small", async () => {
    // The bound that was already there, unchanged: a log of tiny events is
    // limited by how many the ring holds, not by their weight.
    const log = join(DIR, "thin.jsonl");
    writeFileSync(log, Array.from({ length: 40 }, (_, i) => fat(i, 8)).join("\n") + "\n");
    const count = await replayLog(log, "", { maxEvents: 7 });
    expect(count).toBe(7);
  });

  it("carries the production ceilings when nothing is passed", () => {
    // The parameters exist for this suite; a boot must get the ring's own
    // numbers, and the call site must pass neither.
    const src = mod.replayLog.toString();
    expect(src).toContain("maxEvents = MAX_BUFFER");
    expect(src).toContain("maxChars = MAX_BUFFER_CHARS");
    expect(MAX_BUFFER).toBe(2000);
    expect(MAX_BUFFER_CHARS).toBe(128 * 1024 * 1024);
  });
});
