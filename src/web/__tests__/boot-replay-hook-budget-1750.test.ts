// #1750. The ring keeps MAX_BUFFER HOOK events since #1032, with the
// enrichment the deck derives — UsageObserved, ContextObserved, ModelObserved,
// SessionNamed — riding along among them. That enrichment is logged like any
// other event, about 1.6 lines per hook event, and the boot replay stopped
// after MAX_BUFFER log LINES. So a restart rebuilt the board from roughly a
// third of the window the live ring had held.
//
// The same miscount sat in the probe that decides whether a scoped deck reads
// the archive: an enrichment-heavy live log "filled the ring" with far fewer
// than MAX_BUFFER hook events, and the archive was skipped.
//
// Driven through `replayLog` with the production caps — no `maxEvents` passed,
// which is what a boot does — and read through `eventBufferStats`.
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-boot-replay-"));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.XDG_CONFIG_HOME = join(DIR, "config");
if (!resolve(process.env.CLAUDE_CONFIG_DIR).startsWith(resolve(DIR))) throw new Error("sandbox escaped");

// @ts-expect-error — plain .mjs server module, no types
const mod = await import("../../server/index.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { clearEventBuffer } = await import("../../server/event-ring.mjs");
const replayLog = mod.replayLog as (p: string, w?: string) => Promise<number>;
const eventsSince = mod.eventsSince as (seq: number) => { payload: Record<string, unknown> }[];
const stats = mod.eventBufferStats as () => { events: number; hookEvents: number; chars: number };
const MAX_BUFFER = mod.MAX_BUFFER as number;
const MAX_RING_ENTRIES = mod.MAX_RING_ENTRIES as number;

afterAll(() => rmTempDir(DIR));
// Each case reads the ring whole, so each starts from an empty one.
beforeEach(() => clearEventBuffer());

const TREE = join(DIR, "tree");
mkdirSync(TREE, { recursive: true });

let n = 0;
function lines(payloads: Record<string, unknown>[]): string {
  return payloads.map(payload => JSON.stringify({
    seq: ++n, epoch: "fixture", receivedAt: 1_700_000_000_000 + n, source: "hook", payload,
  })).join("\n") + "\n";
}

/** One hook event and the enrichment a real deck derives from it. */
function round(i: number, tag: string): Record<string, unknown>[] {
  const sid = `${tag}${i % 50}`;
  const out: Record<string, unknown>[] = [
    { hook_event_name: "PostToolUse", session_id: sid, cwd: TREE, tool_name: "Bash", i },
    { hook_event_name: "UsageObserved", session_id: sid },
    { hook_event_name: "ContextObserved", session_id: sid },
  ];
  if (i % 10 === 0) out.push({ hook_event_name: "ModelObserved", session_id: sid });
  return out;
}

/** A live log of 2000 lines, a third of them hook events, and an archive of
 *  2000 older hook events beside it — the pair a rotation leaves. */
function rotatedPair(name: string): string {
  const dir = join(DIR, name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "events.jsonl");
  const archived = Array.from({ length: 2000 }, (_, i) =>
    ({ hook_event_name: "PreToolUse", session_id: `old${i % 50}`, cwd: TREE, tool_name: "Bash", archived: true }));
  writeFileSync(path + ".1", lines(archived));
  const live: Record<string, unknown>[] = [];
  for (let i = 0; live.length < 2000; i++) live.push(...round(i, "new").slice(0, 3));
  writeFileSync(path, lines(live.slice(0, 2000)));
  return path;
}

const held = () => eventsSince(0).map(e => e.payload);
const isHook = (p: Record<string, unknown>) =>
  !["UsageObserved", "ContextObserved", "ModelObserved", "SessionNamed"].includes(String(p.hook_event_name));

describe("a boot replay rebuilds the window the live ring held (#1750)", () => {
  it("replays MAX_BUFFER hook events from an enrichment-heavy log", async () => {
    const path = join(DIR, "mixed.jsonl");
    writeFileSync(path, lines(Array.from({ length: 3000 }, (_, i) => round(i, "s")).flat()));
    await replayLog(path, "");
    const st = stats();
    // 645 before: the replay stopped after 2000 lines, most of them enrichment.
    expect(st.hookEvents).toBe(MAX_BUFFER);
    expect(st.events).toBeLessThanOrEqual(MAX_RING_ENTRIES);
    // The NEWEST 2000, which is what the live ring held before the restart.
    const hooks = held().filter(isHook);
    expect(hooks.at(-1)!.i).toBe(2999);
    expect(hooks[0].i).toBe(1000);
  });

  it("reads on into the archive when the live log holds fewer than MAX_BUFFER hook events", async () => {
    const path = rotatedPair("unscoped");
    await replayLog(path, "");
    expect(stats().hookEvents).toBe(MAX_BUFFER);
    expect(held().some(p => p.archived === true), "nothing came out of the archive").toBe(true);
  });

  it("reads the archive on a scoped deck too", async () => {
    const path = rotatedPair("scoped");
    await replayLog(path, TREE);
    expect(stats().hookEvents).toBe(MAX_BUFFER);
    expect(held().some(p => p.archived === true), "the probe skipped the archive").toBe(true);
  });

  it("still stops at the ring's array bound when a log is nearly all enrichment", async () => {
    // MAX_RING_ENTRIES is what bounds the staging once MAX_BUFFER counts hook
    // events only: a log that is almost all enrichment must not be read whole.
    const path = join(DIR, "dense.jsonl");
    const dense: Record<string, unknown>[] = [];
    for (let i = 0; i < 1500; i++) {
      dense.push({ hook_event_name: "PostToolUse", session_id: "d", cwd: TREE });
      for (let k = 0; k < 8; k++) dense.push({ hook_event_name: "UsageObserved", session_id: `d${k}` });
    }
    writeFileSync(path, lines(dense));
    const count = await replayLog(path, "");
    expect(count).toBeLessThanOrEqual(MAX_RING_ENTRIES);
    expect(stats().events).toBeLessThanOrEqual(MAX_RING_ENTRIES);
  });
});
