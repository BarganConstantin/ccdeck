// #1032: the SSE replay window was budgeted in ring ENTRIES, and most of a busy
// ring is not events a user made.
//
// Four scanners fire per hook event and each can push a synthetic one. MEASURED
// against a real deck, sessions paced at one hook event every 3s — an ordinary
// tool-call cadence, well under every documented cap:
//
//   sessions=10   posted=60    seq_delta=160   amplification=2.67
//   sessions=200  posted=2000  seq_delta=5190  amplification=2.60
//
// Flat: about 2.6 ring slots per hook event. At 200 sessions the 2000-entry
// ring held {"PostToolUse":800,"UsageObserved":800,"ContextObserved":400} and
// spanned 9.5 SECONDS. Close the lid, switch networks, or let a tab sleep for
// fifteen seconds and the Last-Event-ID is older than the ring's head: handleSse
// replays what is left and the client steps lastSeq over the gap, so the tool
// calls made in those seconds are never drawn and nothing reports the hole.
//
// After, same load and same deck: the ring held all 2000 PostToolUse and
// spanned 28.2 seconds. Saturated, it holds exactly 2000 of them whatever else
// is interleaved.
//
// Driven through `replayLog`, which is how this file's neighbours reach the
// real pushEvent without a server, and read through `eventBufferStats` — the
// inspector that exists so a bound can be watched holding instead of watched
// killing a process.
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-ring-budget-"));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.XDG_CONFIG_HOME = join(DIR, "config");
if (!resolve(process.env.CLAUDE_CONFIG_DIR).startsWith(resolve(DIR))) throw new Error("sandbox escaped");

// @ts-expect-error — plain .mjs server module, no types
const mod = await import("../../server/index.mjs");
const replayLog = mod.replayLog as (p: string, w?: string, o?: { maxEvents?: number; maxChars?: number }) => Promise<number>;
const eventsSince = mod.eventsSince as (seq: number) => { seq: number; payload: { hook_event_name?: string } }[];
const stats = mod.eventBufferStats as () => { events: number; hookEvents: number; chars: number; oldestSeq: number; newestSeq: number };
const MAX_BUFFER = mod.MAX_BUFFER as number;
const MAX_RING_ENTRIES = mod.MAX_RING_ENTRIES as number;

afterAll(() => rmTempDir(DIR));

let file = 0;
/** Push these payloads through the real ring, in order. */
async function feed(payloads: Record<string, unknown>[]): Promise<void> {
  const path = join(DIR, `log-${file++}.jsonl`);
  writeFileSync(path, payloads.map((payload, i) => JSON.stringify({
    seq: i + 1, epoch: "fixture", receivedAt: 1_700_000_000_000 + i, source: "hook", payload,
  })).join("\n") + "\n", "utf8");
  // Past the staging caps on purpose: those bound what a BOOT replay reads, and
  // what is under test here is what the ring does with everything it is handed.
  await replayLog(path, "", { maxEvents: 1e6, maxChars: 1e9 });
}
/** One hook event and the enrichment a real deck derives from it, in the
 *  proportion measured above: usage and context every time, model now and then.
 *  2.6 entries per hook event, which is what a real deck produced. */
const round = (i: number, sessions: number): Record<string, unknown>[] => {
  const sid = `s${i % sessions}`;
  const out: Record<string, unknown>[] = [
    { hook_event_name: "PostToolUse", session_id: sid, cwd: "/w", tool_name: "Bash" },
    { hook_event_name: "UsageObserved", session_id: sid },
    { hook_event_name: "ContextObserved", session_id: sid },
  ];
  if (i % 10 === 0) out.push({ hook_event_name: "ModelObserved", session_id: sid });
  return out;
};
const rounds = (n: number, sessions: number) =>
  Array.from({ length: n }, (_, i) => round(i, sessions)).flat();

// FIRST, while the ring is still short of its budget: the two cases that read a
// delta rather than a saturated total.
describe("what the budget counts, and what it does not (#1032)", () => {
  it("counts OutputObserved as history, because two of them are two events", () => {
    // The distinction the exclusion list rests on. Model, usage, context and
    // name are last-value-wins STATE — replaying an older one on top of a newer
    // one changes nothing a reader can see. OutputObserved says something
    // landed at a given moment, which is not a value anything supersedes.
    expect(stats().hookEvents, "the ring is already saturated; this case reads a delta")
      .toBeLessThan(MAX_BUFFER);
    return feed([
      { hook_event_name: "OutputObserved", session_id: "s", at: 1 },
      { hook_event_name: "UsageObserved", session_id: "s" },
      { hook_event_name: "SessionNamed", session_id: "s", name: "x" },
    ]).then(() => {
      const st = stats();
      expect(st.events).toBe(3);
      expect(st.hookEvents).toBe(1);
    });
  });
});

describe("the ring's window is measured in events a user made (#1032)", () => {
  it("holds MAX_BUFFER hook events however much enrichment rides along", async () => {
    // The whole defect in one number. Budgeted in entries, this load leaves
    // about 2000/2.6 = 770 hook events in the ring; budgeted in hook events it
    // leaves 2000, which is what MAX_BUFFER has always claimed to be.
    await feed(rounds(MAX_BUFFER * 2, 200));
    // Counted out of the ring itself first, because that is the number a
    // resuming client's window is made of and it needs no new field to read.
    const held = eventsSince(0);
    expect(held.filter(e => e.payload.hook_event_name === "PostToolUse").length)
      .toBe(MAX_BUFFER);
    // Then the total the budget is kept against, which must agree with it.
    const st = stats();
    expect(st.hookEvents).toBe(MAX_BUFFER);
    expect(st.events).toBeGreaterThan(MAX_BUFFER);
    expect(held.length).toBe(st.events);
  });

  it("does not let the window shrink as sessions multiply, which was the bug", async () => {
    // The amplification is a function of how many sessions are posting, and the
    // old budget passed that straight through to the window: 225s of resume at
    // 10 sessions, 11s at 200. Both now hold the same number of real events.
    await feed(rounds(MAX_BUFFER * 2, 10));
    const ten = stats().hookEvents;
    await feed(rounds(MAX_BUFFER * 2, 200));
    const twoHundred = stats().hookEvents;
    expect(ten).toBe(MAX_BUFFER);
    expect(twoHundred).toBe(MAX_BUFFER);
  });

  it("keeps the array bounded, since the budget no longer does it alone", async () => {
    // MAX_RING_ENTRIES is the backstop for a ratio nobody has measured yet — a
    // future scanner, or a cadence that makes enrichment denser still. It must
    // never be the binding limit at the measured 2.6, and it is not: the cases
    // above land well under it.
    const dense: Record<string, unknown>[] = [];
    for (let i = 0; i < MAX_BUFFER; i++) {
      dense.push({ hook_event_name: "PostToolUse", session_id: "s" });
      for (let k = 0; k < 8; k++) dense.push({ hook_event_name: "UsageObserved", session_id: `s${k}` });
    }
    await feed(dense);
    const st = stats();
    expect(st.events).toBeLessThanOrEqual(MAX_RING_ENTRIES);
    expect(st.hookEvents).toBeLessThanOrEqual(MAX_BUFFER);
  });

  it("still evicts a prefix, so no resuming client is handed a hole", async () => {
    // The property eviction has to keep and the one this change could most
    // easily have broken: what leaves is always the OLDEST entries, never a
    // superseded one from the middle. A hole would have no id for a resuming
    // client to ask for again — which is exactly what GET /api/events and the
    // replay loop would then hand out without noticing.
    await feed(rounds(MAX_BUFFER * 2, 200));
    const st = stats();
    expect(st.newestSeq - st.oldestSeq + 1).toBe(st.events);
    const seqs = eventsSince(0).map(e => e.seq);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i] - seqs[i - 1]).toBe(1);
  });
});
