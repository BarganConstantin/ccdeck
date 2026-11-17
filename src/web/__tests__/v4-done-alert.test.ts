// V4 top-10 #5: the deck tells you when a session FINISHES, not only when it is
// blocked (an idea taken from herdr, which alerts for exactly those two and
// never for the session you are looking at).
//
// The same discipline as the blocked notice (notify.ts): one OS notification per
// turn end, only while the page is hidden, never for history, `tag` = key, and
// the one switch silences both. The first half calls the pure rules in
// notify-finished.ts; the second runs the real hook, use-os-notifications.ts,
// against the real reducer on a React of four hooks, as
// notify-switch-adopts-standing-1761.test.ts does, so the wiring is proven
// too: the seeds, the order of the effects, the click.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { blockedSessions } from "../ambient-counts";
import { t } from "../i18n";
import { noticesFor } from "../notify";
import {
  finishedBody, finishedKey, finishedNoticesFor, finishedTurns, nextFinishedTold, seedFinishedTold, type FinishedTold,
} from "../notify-finished";
import { applyEvent, initialState, type GraphState } from "../reducer";
import { turnEndedAt } from "../session-seen";
import type { AgentNodeData, BackgroundJob, HookEnvelope, HookPayload, WaitingBlock } from "../types";

/** A session root as the reducer leaves it, with only what these rules read. */
function root(id: string, over: Partial<AgentNodeData> = {}): AgentNodeData {
  return {
    id, sessionId: id, label: "api", cwdBasename: "api", kind: "root",
    state: "done", startedAt: 1_000, endedAt: 5_000,
    prompts: [{ at: 2_000, text: "Fix the login page" }], toolCount: 3,
    tools: [], childCount: 0,
    ...over,
  } as AgentNodeData;
}

const job = (state: BackgroundJob["state"]): BackgroundJob => ({ id: "j1", state, detail: "", updatedAt: 0 });
const block = (kind: WaitingBlock["kind"], since: number): WaitingBlock => ({ kind, message: "Claude needs your permission", since });
const NONE: FinishedTold = new Map();

describe("a finished turn", () => {
  it("raises one notice per turn end, named as the blocked notice names the session", () => {
    const a = root("A");
    const turns = finishedTurns([a]);
    const notices = finishedNoticesFor(turns, NONE, false);
    expect(notices).toEqual([{ key: "A#done@5000", title: "api", body: "Done\nFix the login page", sessionId: "A" }]);
    // Keyed on session-seen.ts turnEndedAt, the moment the rail's Done · new is.
    expect(turns[0].endedAt).toBe(turnEndedAt(a));
    expect(notices[0].key).toBe(finishedKey("A", turnEndedAt(a)!));
    // The title is the blocked notice's: the same session blocked is titled so.
    const blocked = blockedSessions([root("A", { state: "active", endedAt: undefined, waiting: block("permission", 6_000) })]);
    expect(noticesFor(blocked, new Set(), false)[0].title).toBe(notices[0].title);

    // Once: the next pass, with nothing new, says nothing.
    const told = nextFinishedTold(turns, notices, NONE);
    expect(finishedNoticesFor(turns, told, false)).toEqual([]);
    // The session's next turn is news again.
    const next = finishedTurns([root("A", { prompts: [...a.prompts, { at: 7_000, text: "Now the logout" }], endedAt: 9_000 })]);
    expect(finishedNoticesFor(next, told, false).map(n => [n.key, n.body])).toEqual([["A#done@9000", "Done\nNow the logout"]]);
  });

  it("counts the idle 'your turn' prompt as the end, and its later idle block is the same end", () => {
    // Only the notification says it is waiting on its next prompt: its `since`.
    const idleOnly = root("A", { state: "active", endedAt: undefined, waiting: block("idle", 7_000) });
    expect(finishedNoticesFor(finishedTurns([idleOnly]), NONE, false).map(n => n.key)).toEqual(["A#done@7000"]);
    // A Stop at 5000 and CC's idle prompt a minute after: one turn, one notice.
    const stopped = finishedTurns([root("A")]);
    const told = nextFinishedTold(stopped, finishedNoticesFor(stopped, NONE, false), NONE);
    const idleLater = finishedTurns([root("A", { waiting: block("idle", 65_000) })]);
    expect(finishedNoticesFor(idleLater, told, false)).toEqual([]);
  });

  it("is never raised while the page is visible, and a visible pass adopts what it shows", () => {
    const turns = finishedTurns([root("A")]);
    expect(finishedNoticesFor(turns, NONE, true)).toEqual([]);
    // What the hook keeps after a visible pass: hidden later, it is not said late.
    expect(finishedNoticesFor(turns, seedFinishedTold(turns, NONE), false)).toEqual([]);
  });

  it("is never raised with the switch off", () => {
    expect(finishedNoticesFor(finishedTurns([root("A")]), NONE, false, false)).toEqual([]);
  });

  it("waits for a background job still at work, and is said once it settles", () => {
    for (const working of [job("working"), job("blocked")]) {
      const held = finishedTurns([root("A", { job: working })]);
      expect(held[0].held).toBe("job");
      expect(finishedNoticesFor(held, NONE, false)).toEqual([]);
      // Neither told nor adopted, so the settling is news.
      const told = seedFinishedTold(held, nextFinishedTold(held, [], NONE));
      expect(told.size).toBe(0);
      const settled = finishedTurns([root("A", { job: job("done") })]);
      expect(finishedNoticesFor(settled, told, false).map(n => n.key)).toEqual(["A#done@5000"]);
    }
  });

  it("is not raised for a session never given a prompt, nor one that is over", () => {
    // An idle prompt on a session nobody has asked anything.
    const untouched = root("A", { state: "active", endedAt: undefined, prompts: [], toolCount: 0, waiting: block("idle", 7_000) });
    // Quit (SessionEnd), or given up on by the stale sweep: both write closedAt.
    const quit = root("B", { closedAt: 8_000 });
    const reaped = root("C", { closedAt: 3_000, reaped: true });
    expect(finishedTurns([untouched, quit, reaped])).toEqual([]);
    // Still running: no turn end at all.
    expect(finishedTurns([root("D", { state: "active", endedAt: undefined })])).toEqual([]);
    // A subagent's end is not the session's.
    expect(finishedTurns([root("E", { kind: "subagent" })])).toEqual([]);
  });

  it("is not raised as well as a block on you: the blocked notice speaks for that turn", () => {
    // A background subagent asks after the root's turn ended.
    const both = root("A", { waiting: block("permission", 6_000) });
    const turns = finishedTurns([both]);
    expect(turns[0].held).toBe("block");
    expect(finishedNoticesFor(turns, NONE, false)).toEqual([]);
    expect(noticesFor(blockedSessions([both]), new Set(), false)).toHaveLength(1);
    // Answered, the turn's end is still not said: it was told by the block.
    const told = nextFinishedTold(turns, [], NONE);
    expect(finishedNoticesFor(finishedTurns([root("A")]), told, false)).toEqual([]);
  });

  it("never bursts for history: what a deck finds already finished is adopted, and only what ends after is said", () => {
    const found = finishedTurns([root("A"), root("B", { endedAt: 4_000 }), root("C", { state: "active", endedAt: undefined, waiting: block("idle", 4_500) })]);
    const seeded = seedFinishedTold(found);
    expect(finishedNoticesFor(found, seeded, false)).toEqual([]);
    const later = finishedTurns([root("A"), root("B", { endedAt: 4_000 }), root("D", { endedAt: 12_000 })]);
    expect(finishedNoticesFor(later, seeded, false).map(n => n.sessionId)).toEqual(["D"]);
  });

  it("does not say a turn again when its end is stamped later without a new prompt", () => {
    // A restarted deck reads an idle session back from disk and ends its turn
    // again at that moment (session-recovery.ts), as does a second Stop.
    const turns = finishedTurns([root("A")]);
    const told = nextFinishedTold(turns, finishedNoticesFor(turns, NONE, false), NONE);
    const restamped = finishedTurns([root("A", { endedAt: 50_000 })]);
    expect(finishedNoticesFor(restamped, told, false)).toEqual([]);
    // And the memo follows the new end, so it still names the latest turn.
    expect(nextFinishedTold(restamped, [], told).get("A")?.key).toBe("A#done@50000");
  });

  it("forgets a turn once it is no longer the session's latest, so the memo stays as long as the board", () => {
    const turns = finishedTurns([root("A"), root("B"), root("C")]);
    let told = nextFinishedTold(turns, finishedNoticesFor(turns, NONE, false), NONE);
    expect(told.size).toBe(3);
    // A is working again, B was quit, C is gone from the board.
    told = nextFinishedTold(finishedTurns([root("A", { state: "active", endedAt: undefined }), root("B", { closedAt: 9_000 })]), [], told);
    expect(told.size).toBe(0);
    // A turn that is not the latest any more is dropped for the one that is,
    // never kept beside it.
    told = nextFinishedTold(turns, finishedNoticesFor(turns, NONE, false), NONE);
    const next = finishedTurns([root("A", { prompts: [{ at: 7_000, text: "again" }], endedAt: 9_000 })]);
    told = nextFinishedTold(next, finishedNoticesFor(next, told, false), told);
    expect([...told.values()].map(v => v.key)).toEqual(["A#done@9000"]);
  });

  it("says Done, Done · n failed or Failed, the words its row and card wear", () => {
    expect(finishedBody(root("A"))).toBe(`${t("board.card.stateDone")}\nFix the login page`);
    expect(finishedBody(root("A", { toolErrorCount: 1 }))).toBe("Done · 1 failed\nFix the login page");
    expect(finishedBody(root("A", { toolErrorCount: 2 })))
      .toBe(`${t("board.card.stateDone")} · ${t("board.failedCount", { n: 2 })}\nFix the login page`);
    // Stopped on an error: Failed, whatever its count.
    const stopped = { kind: "login", error: "authentication_failed", message: "", at: 5_000 } as AgentNodeData["stopFailure"];
    expect(finishedBody(root("A", { stopFailure: stopped, toolErrorCount: 3 }))).toBe(`${t("board.card.stateFailed")}\nFix the login page`);
  });

  it("puts the rail row's second line under the word, less a folder the title says, and nothing when there is none", () => {
    // Nothing asked: the word alone.
    expect(finishedBody(root("A", { prompts: [], firstPrompt: undefined }))).toBe("Done");
    // Named elsewhere than its folder, the row's line is "folder · task"; the
    // title here is the folder, so the task alone.
    expect(finishedBody(root("A", { sessionName: "loroloop" }))).toBe("Done\nFix the login page");
  });
});

// ── the hook, run ─────────────────────────────────────────────────────────────

const hooks = vi.hoisted(() => {
  type Deps = readonly unknown[] | undefined;
  interface Instance {
    slots: unknown[];
    effects: Array<{ deps: Deps; cleanup: void | (() => void) }>;
    queued: Array<{ index: number; run: () => void | (() => void); deps: Deps }>;
    cursor: number;
    effectCursor: number;
    dirty: boolean;
    flushing: boolean;
    flush(): void;
  }
  let current: Instance | null = null;
  const moved = (prev: Deps, next: Deps) => !prev || !next || next.some((d, k) => !Object.is(d, prev[k]));

  const react = {
    useState<T>(init: T | (() => T)) {
      const inst = current!;
      const i = inst.cursor++;
      if (!(i in inst.slots)) inst.slots[i] = typeof init === "function" ? (init as () => T)() : init;
      const set = (next: T | ((prev: T) => T)) => {
        const prev = inst.slots[i] as T;
        const value = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
        if (Object.is(prev, value)) return;
        inst.slots[i] = value;
        inst.dirty = true;
        if (!inst.flushing) inst.flush();
      };
      return [inst.slots[i] as T, set] as const;
    },
    useRef<T>(init: T) {
      const inst = current!;
      const i = inst.cursor++;
      if (!(i in inst.slots)) inst.slots[i] = { current: init };
      return inst.slots[i] as { current: T };
    },
    useCallback<F>(fn: F, deps: Deps) {
      const inst = current!;
      const i = inst.cursor++;
      const prev = inst.slots[i] as { fn: F; deps: Deps } | undefined;
      if (!prev || moved(prev.deps, deps)) inst.slots[i] = { fn, deps };
      return (inst.slots[i] as { fn: F }).fn;
    },
    useEffect(run: () => void | (() => void), deps?: readonly unknown[]) {
      const inst = current!;
      const index = inst.effectCursor++;
      const prev = inst.effects[index];
      if (!prev || moved(prev.deps, deps)) inst.queued.push({ index, run, deps });
    },
  };

  function mount<P, R>(hook: (props: P) => R, props: P) {
    let latest = props;
    let result!: R;
    const inst: Instance = {
      slots: [], effects: [], queued: [], cursor: 0, effectCursor: 0, dirty: false, flushing: false,
      flush() {
        inst.flushing = true;
        try {
          let passes = 0;
          do {
            if (++passes > 50) throw new Error("the hook never settled");
            inst.dirty = false;
            inst.cursor = 0;
            inst.effectCursor = 0;
            inst.queued = [];
            current = inst;
            try { result = hook(latest); } finally { current = null; }
            for (const q of inst.queued) {
              const cleanup = inst.effects[q.index]?.cleanup;
              if (typeof cleanup === "function") cleanup();
            }
            for (const q of inst.queued) inst.effects[q.index] = { deps: q.deps, cleanup: q.run() };
          } while (inst.dirty);
        } finally { inst.flushing = false; }
      },
    };
    inst.flush();
    return {
      get now() { return result; },
      rerender(next: Partial<P>) { latest = { ...latest, ...next }; inst.flush(); },
    };
  }

  return { react, mount };
});

vi.mock("react", () => hooks.react);

const { useOsNotifications } = await import("../use-os-notifications");

interface Raised { title: string; body: string; tag: string; note: FakeNotification }
let raised: Raised[] = [];
let page: { hidden: boolean };
let focused: string[] = [];

class FakeNotification {
  static permission = "granted";
  static requestPermission = () => Promise.resolve("granted");
  onclick: (() => void) | null = null;
  closed = false;
  constructor(title: string, opts: { body: string; tag: string }) { raised.push({ title, body: opts.body, tag: opts.tag, note: this }); }
  close() { this.closed = true; }
}

beforeEach(() => {
  raised = [];
  focused = [];
  page = { hidden: true };
  vi.stubGlobal("Notification", FakeNotification);
  vi.stubGlobal("document", page);
  vi.stubGlobal("window", { focus: () => {} });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, prefs: { notifications: true } }) })));
});

afterEach(() => { vi.unstubAllGlobals(); });

let seq = 0;
function send(state: GraphState, sessionId: string, payload: Partial<HookPayload>, at: number): void {
  applyEvent(state, {
    seq: ++seq, receivedAt: at, source: "hook",
    payload: { session_id: sessionId, provider: "claude", cwd: `/home/u/${sessionId}`, ...payload } as HookPayload,
  } as HookEnvelope);
}
/** A whole turn: the prompt, then its end. */
function turn(state: GraphState, sessionId: string, at: number, prompt = "Fix the login page"): void {
  send(state, sessionId, { hook_event_name: "UserPromptSubmit", prompt }, at);
  send(state, sessionId, { hook_event_name: "Stop" }, at + 30_000);
}

/** The hook as App.tsx mounts it: on an empty graph, before the stream has
 *  delivered anything, with the switch read on. */
function deck(state: GraphState) {
  const view = hooks.mount(useOsNotifications, {
    waitingSessions: [] as ReturnType<typeof blockedSessions>, liveSince: null as number | null,
    focusSession: (id: string) => { focused.push(id); }, stateRef: { current: state },
  });
  view.now.loadNotifyPrefs({ prefs: { notifications: true } });
  return view;
}
/** App.tsx's render after the graph moved: the waiting set recomputed from it. */
const render = (view: ReturnType<typeof deck>, state: GraphState, extra: { liveSince?: number | null } = {}) =>
  view.rerender({ waitingSessions: blockedSessions(state.agents.values()), ...extra });

describe("the hook", () => {
  it("restored into a hidden tab, says nothing about turns that ended before it was watching", () => {
    const state = initialState();
    const view = deck(state);
    // The replay: three sessions that finished before this deck existed,
    // flushed in the one commit that ends the replay.
    turn(state, "A", 10_000);
    turn(state, "B", 20_000);
    turn(state, "C", 30_000);
    render(view, state, { liveSince: 100_000 });
    expect(raised).toEqual([]);
    // Then one finishes while the deck is watching, and is said.
    turn(state, "D", 200_000);
    render(view, state);
    expect(raised.map(r => [r.title, r.tag, r.body])).toEqual([["D", "D#done@230000", "Done\nFix the login page"]]);
    // Once.
    render(view, state);
    expect(raised).toHaveLength(1);
  });

  it("says nothing again when a deck restart ends idle turns a second time", () => {
    const state = initialState();
    const view = deck(state);
    turn(state, "A", 10_000);
    render(view, state, { liveSince: 100_000 });
    turn(state, "B", 200_000);
    render(view, state);
    expect(raised.map(r => r.tag)).toEqual(["B#done@230000"]);
    // The stream drops, the deck comes back, and its recovery snapshot finds A
    // and B idle: each turn is ended again, at that moment.
    render(view, state, { liveSince: null });
    for (const id of ["A", "B"]) {
      applyEvent(state, { seq: ++seq, receivedAt: 400_000, source: "internal", payload: {
        hook_event_name: "ClaudeSessionRecovered", provider: "claude", session_id: id, recovery_active: false, snapshot_observed_at: 400_000,
      } as HookPayload } as HookEnvelope);
    }
    expect(turnEndedAt(state.agents.get("A")!)).toBe(400_000);
    render(view, state, { liveSince: 400_500 });
    expect(raised.map(r => r.tag)).toEqual(["B#done@230000"]);
  });

  it("says a turn that ended while the stream was down when it comes back", () => {
    const state = initialState();
    const view = deck(state);
    render(view, state, { liveSince: 100_000 });
    render(view, state, { liveSince: null });
    turn(state, "A", 200_000);
    render(view, state, { liveSince: 300_000 });
    expect(raised.map(r => r.tag)).toEqual(["A#done@230000"]);
  });

  it("is quiet while the page is visible, and does not say that turn late once hidden", () => {
    const state = initialState();
    const view = deck(state);
    render(view, state, { liveSince: 100_000 });
    page.hidden = false;
    turn(state, "A", 200_000);
    render(view, state);
    page.hidden = true;
    turn(state, "B", 300_000);
    render(view, state);
    expect(raised.map(r => r.tag)).toEqual(["B#done@330000"]);
  });

  it("raises the blocked notice alone for a session blocked on you, and both through one click", () => {
    const state = initialState();
    const view = deck(state);
    render(view, state, { liveSince: 100_000 });
    send(state, "A", { hook_event_name: "UserPromptSubmit", prompt: "Deploy" }, 200_000);
    send(state, "A", { hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" }, 210_000);
    render(view, state);
    expect(raised.map(r => r.tag)).toEqual(["A@210000"]);
    send(state, "A", { hook_event_name: "Stop" }, 240_000);
    render(view, state);
    expect(raised.map(r => r.tag)).toEqual(["A@210000", "A#done@240000"]);
    // Clicking either lands on the session, with the blocked notice's handler.
    for (const r of raised) r.note.onclick?.();
    expect(focused).toEqual(["A", "A"]);
    expect(raised.every(r => r.note.closed)).toBe(true);
  });

  it("is silenced by the one switch, and turning it on adopts what is standing", async () => {
    const state = initialState();
    const view = deck(state);
    view.now.loadNotifyPrefs({ prefs: { notifications: false } });
    render(view, state, { liveSince: 100_000 });
    turn(state, "A", 200_000);
    render(view, state);
    expect(raised).toEqual([]);
    page.hidden = false;
    view.now.toggleNotify();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(view.now.notifyOn).toBe(true);
    page.hidden = true;
    turn(state, "B", 300_000);
    render(view, state);
    expect(raised.map(r => r.tag)).toEqual(["B#done@330000"]);
  });
});
