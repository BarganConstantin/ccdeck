// What the ring keeps back of the enrichment it evicts, for a page that
// connects behind its head (evicted-enrichment.mjs): the newest value of each
// kind per session, chosen by seq, and bounded however much is evicted —
// `POST /api/event` takes enrichment names from anyone, so this must not
// become a second ring with no budget.
import { beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs server module, no types
import * as kept from "../../server/evicted-enrichment.mjs";

type Envelope = { seq: number; epoch: string; receivedAt: number; source: string; payload: Record<string, unknown> };
let seq = 0;
const evict = (payload: Record<string, unknown>, charged = 0): Envelope => {
  const e = { seq: ++seq, epoch: "e1", receivedAt: 1_000 + seq, source: "internal", payload };
  kept.noteEvicted(e, charged);
  return e;
};
const all = (sessions: string[]) => kept.evictedEnrichment({ after: 0, before: Infinity, sessions: new Set(sessions) }) as Envelope[];

beforeEach(() => kept.clearEvicted());

describe("the enrichment the ring keeps back", () => {
  it("keeps only enrichment that names a session", () => {
    evict({ hook_event_name: "PreToolUse", session_id: "s1" });
    evict({ hook_event_name: "OutputObserved", session_id: "s1", kind: "text", at: 1 });
    evict({ hook_event_name: "SessionRecapped", session_id: "s1", recap: null });
    evict({ hook_event_name: "ModelObserved", model: "m" });
    evict({ hook_event_name: "ModelObserved", session_id: "", model: "m" });
    kept.noteEvicted({ seq: ++seq, payload: null });
    expect(kept.evictedStats()).toEqual({ sessions: 0, values: 0, chars: 0 });
  });

  it("answers one envelope per kind per session, with the seq, time and source of the newest, oldest first", () => {
    const a = evict({ hook_event_name: "UsageObserved", session_id: "s1", usage: { input_tokens: 1 } });
    const b = evict({ hook_event_name: "ModelObserved", session_id: "s1", model: "m1" });
    const c = evict({ hook_event_name: "UsageObserved", session_id: "s1", usage: { input_tokens: 2 } });
    expect(a.seq).toBeLessThan(c.seq);
    expect(all(["s1"])).toEqual([
      { seq: b.seq, epoch: "e1", receivedAt: b.receivedAt, source: "internal", payload: b.payload },
      { seq: c.seq, epoch: "e1", receivedAt: c.receivedAt, source: "internal", payload: { hook_event_name: "UsageObserved", session_id: "s1", usage: { input_tokens: 2 } } },
    ]);
  });

  it("answers only for the sessions asked about, and only what is newer than `after` and older than `before`", () => {
    const m = evict({ hook_event_name: "ModelObserved", session_id: "s1", model: "m" });
    const n = evict({ hook_event_name: "SessionNamed", session_id: "s1", sessionName: "api-fix", sessionTitle: null });
    evict({ hook_event_name: "ModelObserved", session_id: "s2", model: "m" });
    const pick = (after: number, before: number, sessions = ["s1"]) =>
      (kept.evictedEnrichment({ after, before, sessions: new Set(sessions) }) as Envelope[]).map(e => e.seq);
    expect(pick(0, Infinity)).toEqual([m.seq, n.seq]);
    expect(pick(m.seq, Infinity)).toEqual([n.seq]);
    expect(pick(n.seq, Infinity)).toEqual([]);
    expect(pick(0, n.seq)).toEqual([m.seq]);
    expect(pick(0, Infinity, [])).toEqual([]);
  });

  it("does not modify the payloads it was handed", () => {
    const first = { hook_event_name: "ContextObserved", session_id: "s1", context: { msgsUser: 1 } };
    const second = { hook_event_name: "ContextObserved", session_id: "s1", context: { toolUses: 4 } };
    evict(first);
    evict(second);
    expect(first.context).toEqual({ msgsUser: 1 });
    expect(second.context).toEqual({ toolUses: 4 });
    expect(all(["s1"])[0].payload.context).toEqual({ msgsUser: 1, toolUses: 4 });
  });

  it("holds at most MAX_EVICTED_SESSIONS sessions, dropping the one folded into longest ago", () => {
    for (let i = 0; i <= kept.MAX_EVICTED_SESSIONS; i++) evict({ hook_event_name: "ModelObserved", session_id: `s${i}`, model: "m" });
    expect(kept.evictedStats().sessions).toBe(kept.MAX_EVICTED_SESSIONS);
    expect(all(["s0"])).toEqual([]);
    expect(all([`s${kept.MAX_EVICTED_SESSIONS}`])).toHaveLength(1);
  });

  it("moves a session heard from again to the back of the line", () => {
    evict({ hook_event_name: "ModelObserved", session_id: "busy", model: "m" });
    for (let i = 1; i < kept.MAX_EVICTED_SESSIONS; i++) evict({ hook_event_name: "ModelObserved", session_id: `s${i}`, model: "m" });
    evict({ hook_event_name: "UsageObserved", session_id: "busy", usage: { input_tokens: 1 } });
    evict({ hook_event_name: "ModelObserved", session_id: "one-more", model: "m" });
    expect(all(["busy"])).toHaveLength(2);
    expect(all(["s1"])).toEqual([]);
  });

  it("lets go of a value no scanner could have written, and of the older value of its kind with it", () => {
    evict({ hook_event_name: "UsageObserved", session_id: "s1", usage: { input_tokens: 1 } });
    evict({ hook_event_name: "UsageObserved", session_id: "s1", usage: { input_tokens: 2 } }, kept.MAX_EVICTED_VALUE_CHARS + 1);
    expect(all(["s1"])).toEqual([]);
    // Charged small, but folded past the cap: the same.
    evict({ hook_event_name: "ContextObserved", session_id: "s2", context: { memoryFiles: [{ path: "x".repeat(kept.MAX_EVICTED_VALUE_CHARS), bytes: 1 }] } });
    expect(all(["s2"])).toEqual([]);
    expect(kept.evictedStats()).toEqual({ sessions: 0, values: 0, chars: 0 });
  });

  it("keeps everything under MAX_EVICTED_CHARS, dropping whole sessions oldest first", () => {
    const big = "x".repeat(Math.floor(kept.MAX_EVICTED_VALUE_CHARS / 2));
    const n = Math.ceil(kept.MAX_EVICTED_CHARS / big.length) + 4;
    for (let i = 0; i < n; i++) evict({ hook_event_name: "SessionNamed", session_id: `s${i}`, sessionName: big, sessionTitle: null });
    const { chars, sessions } = kept.evictedStats();
    expect(chars).toBeLessThanOrEqual(kept.MAX_EVICTED_CHARS);
    expect(sessions).toBeLessThan(n);
    expect(all(["s0"])).toEqual([]);
    expect(all([`s${n - 1}`])).toHaveLength(1);
  });

  it("forgets everything on a clear", () => {
    evict({ hook_event_name: "ModelObserved", session_id: "s1", model: "m" });
    kept.clearEvicted();
    expect(kept.evictedStats()).toEqual({ sessions: 0, values: 0, chars: 0 });
    expect(all(["s1"])).toEqual([]);
  });
});
