// The deck's record of the sessions its Command Panel started (F6-R), from the
// server's panel-provenance.mjs: recorded only from the engine's own answers,
// bound to the session's id, kept in the deck's events log and replayed from
// it, and answering "panel", "external" or "unknown" — never anything about
// what may be attached.
//
// Each case is one deck: `emit` and `hook` append to a log exactly as the
// pipeline does (the payload as JSON, its source, the time received) and hand
// the event to `observe` as pushEvent does; a restart is a new deck replaying
// that log, or only its newest lines, with `replay: true`.
import { describe, expect, it } from "vitest";
import { applyEvent, initialState } from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";

// @ts-expect-error — plain .mjs server module, no types
const P = await import("../../server/panel-provenance.mjs");
const {
  createPanelProvenance, withProvenance, PANEL_LAUNCH, PENDING_MS, LAUNCH_MAX_AGE_MS, LAUNCHES_MAX, REFRESH_EVERY,
} = P;

const A = "0b9f3c1e-2d4a-4b6c-8e0f-1a2b3c4d5e6f";
const B = "1c8e2d0f-3e5b-4c7d-9f10-2b3c4d5e6f70";
const C = "2d7f1e2a-4f6c-4d8e-8a21-3c4d5e6f7081";
const X = "3e6a2f3b-5a7d-4e9f-9b32-4d5e6f708192";
const FOLDER = "/home/someone/Private Project";

type Line = { payload: any; source: string; receivedAt: number };
const flush = () => new Promise((r) => setTimeout(r, 0));

function deck({ t0 = 1_700_000_000_000, foreign = (_: string) => false, on = true }: { t0?: number; foreign?: (id: string) => boolean; on?: boolean } = {}) {
  const log: Line[] = [];
  let t = t0;
  const now = () => t;
  /** The Command Panel's switch, in Settings. */
  const panel = { on };
  // eslint-disable-next-line prefer-const
  let p: any;
  const push = (raw: any, source: string, opts: Record<string, unknown> = {}) => {
    const line = { payload: JSON.parse(JSON.stringify(raw)), source, receivedAt: now() };
    log.push(line);
    p.observe(raw, source, line.receivedAt, opts);
  };
  p = createPanelProvenance({ emit: (raw: any) => push(raw, "internal"), foreign, now, active: () => panel.on });
  return {
    p, log, now, panel,
    tick: (ms: number) => { t += ms; },
    at: (v: number) => { t = v; },
    hook: (raw: any, source = "hook") => push(raw, source),
    start: (id: string, extra: Record<string, unknown> = {}) => push({ hook_event_name: "SessionStart", session_id: id, cwd: FOLDER, source: "startup", ...extra }, extra.provider === "codex" ? "codex" : "hook"),
    end: (id: string) => push({ hook_event_name: "SessionEnd", session_id: id, cwd: FOLDER }, "hook"),
    other: (n = 1) => { for (let i = 0; i < n; i++) push({ hook_event_name: "PreToolUse", session_id: X, tool_name: "Read" }, "hook"); },
    /** The routes' half of a launch or an adopt: noted, the engine asked, its answer noted. */
    launch(agent: string, status: number, body: any, key = "k-1") {
      const question = { agent, cwd: FOLDER, key };
      const ref = p.started("launch", question);
      p.answered("launch", question, ref, status, body);
      return ref;
    },
    adopt(id: string, status: number, body: any, between?: () => void) {
      const question = { sessionId: id, provider: "claude", cwd: FOLDER };
      const ref = p.started("adopt", question);
      between?.();
      p.answered("adopt", question, ref, status, body);
    },
    claim(id: string, key: string, status: number, body: any) {
      p.answered("claim", { key, sessionId: id, provider: "codex", cwd: FOLDER }, null, status, body);
    },
  };
}

/** A new deck (a restart, or a deck under another sign-in) replaying `lines` at boot. */
function replayed(lines: Line[], opts: { t0?: number; foreign?: (id: string) => boolean } = {}) {
  const d = deck({ t0: opts.t0 ?? (lines.at(-1)?.receivedAt ?? 0) + 60_000, ...(opts.foreign ? { foreign: opts.foreign } : {}) });
  for (const l of lines) d.p.observe(JSON.parse(JSON.stringify(l.payload)), l.source, l.receivedAt, { replay: true });
  return d;
}

const launched = (id: string) => ({ ok: true, sessionId: id, name: "deck-claude-x", ticket: null });

describe("recorded only after an authoritative, successful launch", () => {
  it("binds a Claude launch to the id the engine answered, and to nothing else", async () => {
    const d = deck();
    d.launch("claude", 200, launched(A));
    d.start(A);
    expect(d.p.classify("claude", A)).toBe("panel");
    // The provider is part of the identity: the same id as a Codex is not this launch.
    expect(d.p.classify("codex", A)).toBe("unknown");
    const names = d.log.filter((l) => l.payload.hook_event_name === PANEL_LAUNCH).map((l) => l.payload.launch);
    expect(names).toEqual(["started", "bound"]);
  });

  it("records nothing for a launch the engine refused, and closes it", async () => {
    const d = deck();
    d.tick(1);
    d.launch("claude", 409, { ok: false, error: "The deck is running as many sessions as it can.", code: "full" });
    d.launch("claude", 200, { ok: false, error: "no" });
    d.tick(1);
    d.start(B);
    expect(d.p.classify("claude", B)).toBe("external");
    expect(d.log.filter((l) => l.payload.launch === "refused")).toHaveLength(2);
  });

  it("leaves a launch the engine never answered open, so what started in it is unknown, never external", () => {
    const d = deck();
    d.tick(1);
    d.p.started("launch", { agent: "claude", cwd: FOLDER, key: "k-lost" }); // the deck stopped before the answer
    d.tick(1_000);
    d.start(A);
    expect(d.p.classify("claude", A)).toBe("unknown");
    // Past PENDING_MS the open launch is a gap: still unknown inside it, external after it.
    d.tick(PENDING_MS + 1);
    d.start(B);
    expect(d.p.classify("claude", A)).toBe("unknown");
    expect(d.p.classify("claude", B)).toBe("external");
    // A Codex outside a Claude launch's span is not touched by it.
    d.at(d.now());
  });

  it("binds a Codex only by a claim the engine confirmed; until then its session is unknown", () => {
    const d = deck();
    d.tick(1);
    d.launch("codex", 200, { ok: true, sessionId: "", name: "deck-codex-x", ticket: null }, "k-cx");
    d.tick(500);
    d.start(C, { provider: "codex" });
    expect(d.p.classify("codex", C)).toBe("unknown");
    d.claim(C, "k-cx", 200, { ok: true, claimed: false, target: { kind: "A", label: "x" } });
    d.claim(C, "k-cx", 409, { ok: true, claimed: true });
    d.claim(C, "k-cx", 200, { ok: false, claimed: true });
    expect(d.p.classify("codex", C)).toBe("unknown");
    d.claim(C, "k-cx", 200, { ok: true, claimed: true, target: { kind: "A", label: "x" } });
    expect(d.p.classify("codex", C)).toBe("panel");
  });

  it("keeps no folder, prompt, output or environment: ids, providers, keys and times only", () => {
    const d = deck();
    d.launch("claude", 200, launched(A));
    d.adopt(B, 200, { ok: true, ticket: null });
    d.launch("codex", 200, { ok: true, sessionId: "" }, "k-cx");
    d.claim(C, "k-cx", 200, { ok: true, claimed: true });
    const ours = d.log.filter((l) => l.payload.hook_event_name === PANEL_LAUNCH);
    expect(ours.length).toBeGreaterThan(0);
    for (const l of ours) {
      expect(l.source).toBe("internal");
      expect(Object.keys(l.payload).every((k) => ["hook_event_name", "launch", "ref", "provider", "key", "session"].includes(k))).toBe(true);
      expect(JSON.stringify(l.payload)).not.toContain(FOLDER);
      // Never where a hook's own `session_id` goes.
      expect(l.payload.session_id).toBeUndefined();
    }
  });
});

describe("reload and other tabs", () => {
  it("answers from the deck, the same to every caller, and only for case C", () => {
    const d = deck();
    d.launch("claude", 200, launched(A));
    const q = { sessionId: A, provider: "claude", cwd: FOLDER };
    const c = { ok: true, target: { kind: "C", label: "This session was started outside the deck.", adoptable: true } };
    const first = withProvenance(d.p, q, c);
    const again = withProvenance(d.p, q, c);
    expect(first).toEqual({ ok: true, target: { ...c.target, provenance: "panel" } });
    expect(again).toEqual(first);
    // Not case C: handed back as it came.
    for (const body of [{ ok: true, target: { kind: "A", label: "a" } }, { ok: true, target: { kind: "gone", label: "g", adoptable: true } }, { ok: false, error: "x", code: "y" }, null]) {
      expect(withProvenance(d.p, q, body)).toBe(body);
    }
    // An open the engine refused stays refused: no ticket appears, only the word.
    const refused = { ok: false, target: c.target };
    expect(withProvenance(d.p, q, refused)).toEqual({ ok: false, target: { ...c.target, provenance: "panel" } });
  });
});

describe("deck restart", () => {
  it("replays its records from the log, and a session it saw start outside any launch is external", async () => {
    const d = deck();
    d.other();
    await flush(); // the first live event writes the "held" record
    d.tick(1);
    d.launch("claude", 200, launched(A));
    d.start(A);
    d.tick(1);
    d.start(B);
    const r = replayed(d.log);
    expect(r.p.classify("claude", A)).toBe("panel");
    expect(r.p.classify("claude", B)).toBe("external");
  });

  it("keeps a record past the replay window: every REFRESH_EVERY hook events carry it forward", async () => {
    const d = deck();
    d.launch("claude", 200, launched(A));
    d.start(A);
    for (let i = 0; i < 6; i++) { d.other(REFRESH_EVERY); await flush(); }
    // The newest ring's worth only, as the boot replay reads it: the launch itself is long gone.
    const window = d.log.slice(-2 * REFRESH_EVERY);
    expect(window.some((l) => l.payload.launch === "bound")).toBe(false);
    expect(replayed(window).p.classify("claude", A)).toBe("panel");
    // Enrichment is not counted: it cannot push a record out on its own.
    const e = deck();
    e.other();
    await flush();
    const before = e.log.filter((l) => l.payload.launch === "held").length;
    for (let i = 0; i < REFRESH_EVERY * 2; i++) e.hook({ hook_event_name: "UsageObserved", session_id: X, usage: {} }, "internal");
    await flush();
    expect(e.log.filter((l) => l.payload.launch === "held").length).toBe(before);
  });

  it("does not call a session started before the records begin external", () => {
    // Sessions seen in a window with no "held" (a deck without this record wrote it) start before this deck did.
    const old = deck();
    old.start(B);
    old.tick(1);
    const lines = old.log.filter((l) => l.payload.hook_event_name !== PANEL_LAUNCH);
    const r = replayed(lines);
    expect(r.p.classify("claude", B)).toBe("unknown");
  });

  it("a restart in the middle of a launch: unknown until it is bound, then the panel's", () => {
    const d = deck();
    d.p.started("launch", { agent: "codex", cwd: FOLDER, key: "k-cx" });
    d.tick(200);
    d.start(C, { provider: "codex" });
    const r = replayed(d.log, { t0: d.now() + 1_000 });
    expect(r.p.classify("codex", C)).toBe("unknown");
    // The tab outlived the restart and claims it now.
    r.claim(C, "k-cx", 200, { ok: true, claimed: true });
    expect(r.p.classify("codex", C)).toBe("panel");
  });

  it("forgets every record on a Clear, writes nothing into the emptied log, and starts over from it", async () => {
    const d = deck();
    d.other();
    await flush();
    d.launch("claude", 200, launched(A));
    d.start(A);
    d.tick(1);
    d.start(B);
    d.tick(1);
    const at = d.log.length;
    d.hook({ hook_event_name: "__clear", cwd: "" }, "internal");
    await flush();
    expect(d.log.length).toBe(at + 1);
    // What the Clear forgot is not the panel's or external any more: unknown, here and after a restart.
    expect(d.p.classify("claude", A)).toBe("unknown");
    expect(d.p.classify("claude", B)).toBe("unknown");
    // The next live event writes what is left, which names neither.
    d.tick(1);
    d.other();
    await flush();
    const after = d.log.slice(at);
    const held = after.filter((l) => l.payload.launch === "held");
    expect(held.length).toBe(1);
    expect(JSON.stringify(held)).not.toContain(A);
    expect(JSON.stringify(held)).not.toContain(B);
    // What starts after it is told apart as before.
    d.tick(1);
    d.launch("claude", 200, launched(C), "k-2");
    d.start(C);
    d.tick(1);
    d.start(X);
    const r = replayed(d.log.slice(at));
    for (const p of [d.p, r.p]) {
      expect(p.classify("claude", A)).toBe("unknown");
      expect(p.classify("claude", C)).toBe("panel");
      expect(p.classify("claude", X)).toBe("external");
    }
  });
});

describe("a deck with the Command Panel off", () => {
  it("writes nothing of its own into the log or the ring", async () => {
    const d = deck({ on: false });
    d.start(B);
    d.other(REFRESH_EVERY * 2);
    d.hook({ hook_event_name: "__clear", cwd: "" }, "internal");
    d.other(3);
    await flush();
    expect(d.log.some((l) => l.payload.hook_event_name === PANEL_LAUNCH)).toBe(false);
  });

  it("carries the records forward from the first live event after it is switched on", async () => {
    const d = deck();
    d.other();
    await flush();
    d.launch("claude", 200, launched(A));
    d.start(A);
    d.panel.on = false;
    d.other(REFRESH_EVERY * 3);
    await flush();
    const quiet = d.log.length;
    d.panel.on = true;
    d.other();
    await flush();
    const after = d.log.slice(quiet);
    expect(after.filter((l) => l.payload.launch === "held").length).toBe(1);
    expect(replayed(after).p.classify("claude", A)).toBe("panel");
  });
});

describe("different Windows sign-ins", () => {
  it("a deck under another sign-in that shares the log says the panel started it, and is asked nothing about reaching it", async () => {
    const first = deck();
    first.other();
    await flush();
    first.launch("claude", 200, launched(A));
    first.start(A);
    const second = replayed(first.log);
    expect(second.p.classify("claude", A)).toBe("panel");
    // The only question there is: no logon, no caller, no "may I".
    expect(Object.keys(second.p).sort()).toEqual(["answered", "classify", "observe", "snapshot", "started"]);
    expect(second.p.classify.length).toBe(2);
  });

  it("a session another deck logs is that deck's to say: unknown here", () => {
    const d = deck({ foreign: (id) => id === B });
    d.tick(1);
    d.start(B);
    expect(d.p.classify("claude", B)).toBe("unknown");
  });
});

describe("stale records", () => {
  it("keeps a record while its session runs out of reach, however long, and lets it go at its definitive end", () => {
    const d = deck();
    d.launch("claude", 200, launched(A));
    d.start(A);
    d.tick(LAUNCH_MAX_AGE_MS - 60_000);
    d.other(50);
    expect(d.p.classify("claude", A)).toBe("panel");
    d.end(A);
    expect(d.p.classify("claude", A)).toBe("unknown");
  });

  it("past its age a record goes, and what it covered becomes unknown, never external", () => {
    const d = deck();
    d.tick(1);
    d.start(B);
    d.tick(1);
    d.launch("codex", 200, { ok: true, sessionId: "" }, "k-cx");
    d.tick(1);
    d.start(C, { provider: "codex" });
    d.claim(C, "k-cx", 200, { ok: true, claimed: true });
    expect(d.p.classify("claude", B)).toBe("external");
    d.tick(LAUNCH_MAX_AGE_MS + 1);
    expect(d.p.classify("codex", C)).toBe("unknown");
    expect(d.p.classify("claude", B)).toBe("unknown");
  });

  it("past LAUNCHES_MAX the oldest goes the same way", () => {
    const d = deck();
    const id = (i: number) => `${i.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
    for (let i = 0; i <= LAUNCHES_MAX; i++) {
      d.tick(1);
      d.launch("claude", 200, launched(id(i)), `k-${i}`);
      d.start(id(i));
    }
    expect(d.p.classify("claude", id(0))).toBe("unknown");
    expect(d.p.classify("claude", id(LAUNCHES_MAX))).toBe("panel");
    expect(d.p.snapshot().launches).toHaveLength(LAUNCHES_MAX);
  });
});

describe("id reuse", () => {
  it("a panel session started again by something else is unknown", () => {
    const d = deck();
    d.launch("claude", 200, launched(A));
    d.start(A);
    d.tick(60_000);
    d.start(A, { source: "resume" });
    expect(d.p.classify("claude", A)).toBe("unknown");
  });

  it("the panel's own reopen keeps it the panel's, whichever comes first", () => {
    for (const startFirst of [true, false]) {
      const d = deck();
      d.launch("claude", 200, launched(A));
      d.start(A);
      d.tick(60_000);
      d.adopt(A, 200, { ok: true, ticket: null }, startFirst ? () => d.start(A, { source: "resume" }) : undefined);
      if (!startFirst) d.start(A, { source: "resume" });
      expect(d.p.classify("claude", A), String(startFirst)).toBe("panel");
    }
  });

  it("ended, then resumed outside the deck: external; reopened by the panel: the panel's", () => {
    const d = deck();
    d.launch("claude", 200, launched(A));
    d.start(A);
    d.end(A);
    d.tick(1);
    d.start(A, { source: "resume" });
    expect(d.p.classify("claude", A)).toBe("external");
    d.end(A);
    d.tick(1);
    d.adopt(A, 200, { ok: true, ticket: null }, () => d.start(A, { source: "resume" }));
    expect(d.p.classify("claude", A)).toBe("panel");
  });

  it("a cleared conversation's new id is unknown; a compaction changes nothing", () => {
    const d = deck();
    d.launch("claude", 200, launched(A));
    d.start(A);
    d.start(A, { source: "compact" });
    expect(d.p.classify("claude", A)).toBe("panel");
    d.end(A);
    d.start(B, { source: "clear" });
    expect(d.p.classify("claude", B)).toBe("unknown");
  });

  it("an adopt the engine refused or never answered leaves no panel record", () => {
    const d = deck();
    d.tick(1);
    d.start(B);
    d.adopt(B, 409, { ok: false, error: "still running", code: "still-running" });
    expect(d.p.classify("claude", B)).toBe("external");
    d.p.started("adopt", { sessionId: C, provider: "claude", cwd: FOLDER });
    d.start(C, { source: "resume" });
    d.tick(PENDING_MS + 1);
    expect(d.p.classify("claude", C)).toBe("unknown");
  });
});

describe("forged provenance", () => {
  const bound = (session: string) => ({ hook_event_name: PANEL_LAUNCH, launch: "bound", provider: "claude", session });

  it("takes a record only from the deck's own source, live or replayed", () => {
    const d = deck();
    d.tick(1);
    d.start(A);
    for (const source of ["hook", "codex", "replay", "lan", ""]) d.hook(bound(A), source);
    expect(d.p.classify("claude", A)).toBe("external");
    const r = replayed(d.log.map((l) => ({ ...l })), {});
    r.p.observe(bound(A), "hook", r.now(), { replay: true });
    expect(r.p.classify("claude", A)).not.toBe("panel");
    d.hook(bound(A), "internal");
    expect(d.p.classify("claude", A)).toBe("panel");
  });

  it("ignores records that are not one: bad ids, providers, stages, snapshots", () => {
    const d = deck();
    d.tick(1);
    d.start(B);
    for (const raw of [
      { ...bound("not-an-id") }, { ...bound(B), provider: "gemini" }, { ...bound(B), launch: "BOUND" },
      { ...bound(B), launch: "started", ref: "x" }, { hook_event_name: PANEL_LAUNCH },
    ]) d.hook(raw, "internal");
    expect(d.p.classify("claude", B)).toBe("external");
    d.hook({ hook_event_name: PANEL_LAUNCH, launch: "held", since: "yesterday", launches: [{ provider: "x", session: B, at: 1 }, null, 7, { provider: "claude", session: "nope", at: 1 }], pending: "x", gaps: [{}] }, "internal");
    expect(d.p.snapshot().launches).toEqual([]);
  });

  it("never records from an answer that is not the engine's success", () => {
    const d = deck();
    d.tick(1);
    d.start(A);
    d.p.answered("launch", { agent: "claude", cwd: FOLDER }, null, 200, launched(A)); // no "started" before it: not a launch this deck made
    d.p.answered("open", { sessionId: A, provider: "claude", cwd: FOLDER }, null, 200, { ok: true, ticket: "t" });
    d.p.answered("target", { sessionId: A, provider: "claude", cwd: FOLDER }, null, 200, { ok: true, target: { kind: "C", label: "x" } });
    expect(d.p.classify("claude", A)).toBe("external");
  });
});

describe("unknown identity fails closed", () => {
  it("anything that is not a session the deck can name is unknown", () => {
    const d = deck();
    d.launch("claude", 200, launched(A));
    for (const [provider, id] of [["claude", "nope"], ["gemini", A], ["claude", ""], [undefined, A], ["claude", undefined]] as const) {
      expect(d.p.classify(provider, id), `${provider} ${id}`).toBe("unknown");
    }
    expect(d.p.classify("claude", B)).toBe("unknown"); // never seen start
    expect(d.p.started("launch", { agent: "gemini", cwd: FOLDER })).toBeNull();
    expect(d.p.started("adopt", { sessionId: "nope", provider: "claude", cwd: FOLDER })).toBeNull();
  });
});

describe("the board", () => {
  it("is not changed by the deck's records: no card, no session heard, nothing counted", () => {
    const d = deck();
    d.launch("claude", 200, launched(A));
    d.start(A);
    d.adopt(B, 200, { ok: true, ticket: null });
    let seq = 0;
    const board = (lines: Line[]) => lines.reduce(
      (s, l) => applyEvent(s, { seq: ++seq, receivedAt: l.receivedAt, source: l.source, payload: l.payload as HookPayload } as HookEnvelope),
      initialState(),
    );
    const withRecords = board(d.log);
    seq = 0;
    const without = board(d.log.filter((l) => l.payload.hook_event_name !== PANEL_LAUNCH));
    expect([...withRecords.agents.keys()]).toEqual([...without.agents.keys()]);
    expect(withRecords.agents.has("unknown")).toBe(false);
    expect(withRecords.totalEvents).toBe(without.totalEvents);
    expect(withRecords.lastSeq).toBe(d.log.length);
  });
});
