// #1764: a paused canvas is not an idle deck.
//
// The page decided "nothing is running" from its own reducer, and a paused page
// stops applying events: the gate holds them for the resume, so the graph stays
// frozen at the moment of the pause while the board's clock keeps ticking. Send
// a prompt from the terminal with the canvas paused and the page saw nothing
// running, counted its thirty seconds and restarted the server under the agent,
// and the hook events fired while it was down were gone. The banner's own
// button said "Restart now — nothing is running" all the while.
//
// The fix asks the party that cannot be paused. The server hears every turn
// (activity.mjs, the same record the away-update waits on), so the automatic
// restart is asked of it as a restart WHEN IDLE, and it refuses one while a turn
// is open or has only just ended. The page's own view still has to agree — a
// restart needs both to say quiet. And the button stops claiming what a paused
// page cannot see.
//
// Three parts: the server's rule as a pure function, the route that applies it
// on a real deck, and the page's hook run on a React of four hooks with the
// pause gate on the same graph.
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

// ── the page's hooks, on a React small enough to read ───────────────────────
const hooks = vi.hoisted(() => {
  type Deps = readonly unknown[] | undefined;
  interface Effect { deps: Deps; cleanup: void | (() => void) }
  interface Instance {
    slots: unknown[];
    effects: Effect[];
    queued: Array<{ index: number; run: () => void | (() => void); deps: Deps }>;
    cursor: number;
    effectCursor: number;
    dirty: boolean;
    flushing: boolean;
    flush(): void;
  }
  let current: Instance | null = null;
  const moved = (a: Deps, b: Deps) => !a || !b || a.length !== b.length || a.some((d, k) => !Object.is(d, b[k]));

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
    useCallback<F>(fn: F, deps?: readonly unknown[]) {
      const inst = current!;
      const i = inst.cursor++;
      const prev = inst.slots[i] as { fn: F; deps: Deps } | undefined;
      if (prev && !moved(prev.deps, deps)) return prev.fn;
      inst.slots[i] = { fn, deps };
      return fn;
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
    let result: R;
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
      rerender(next: P) { latest = next; inst.flush(); },
    };
  }

  return { react, mount };
});

vi.mock("react", () => hooks.react);

import { IDLE_BEFORE_RESTART_MS, restartSafety } from "../restart";
import { initialState, applyEvent, type GraphState } from "../reducer";
import { usePauseGate } from "../use-pause-gate";
import { useAutoRestart } from "../use-auto-restart";
import type { HookEnvelope } from "../types";
import type { VersionInfo, VersionNotice } from "../use-version-check";
// @ts-expect-error — plain .mjs server module, no types
import { AWAY_QUIET_MS, turnsQuiet } from "../../server/auto-update.mjs";

// ── the rule ────────────────────────────────────────────────────────────────
describe("turnsQuiet — the server's idle, which a paused page cannot change", () => {
  it("is quiet only with no turn open and none heard for the whole window", () => {
    expect(turnsQuiet({ busy: false, quietMs: AWAY_QUIET_MS })).toBe(true);
    expect(turnsQuiet({ busy: false, quietMs: Infinity })).toBe(true);
    expect(turnsQuiet({ busy: true, quietMs: Infinity })).toBe(false);
    // The quiet straight after a turn is not yet quiet.
    expect(turnsQuiet({ busy: false, quietMs: AWAY_QUIET_MS - 1 })).toBe(false);
  });

  it("means by idle what the page means", () => {
    expect(AWAY_QUIET_MS).toBe(IDLE_BEFORE_RESTART_MS);
  });
});

describe("restartSafety — the button on a paused canvas", () => {
  it("does not say nothing is running when the canvas cannot see", () => {
    const paused = restartSafety(0, true);
    expect(paused.label).toBe("Restart anyway");
    expect(paused.clause).not.toMatch(/nothing is running/);
    expect(paused.clause).toMatch(/paused/);
  });

  it("still names what it can see, and is unchanged when not paused", () => {
    expect(restartSafety(2, true).clause).toBe("2 agents are running — their events during the restart are lost");
    expect(restartSafety(0, false)).toEqual({ label: "Restart now", clause: "nothing is running" });
    expect(restartSafety(0)).toEqual({ label: "Restart now", clause: "nothing is running" });
  });
});

// ── the page ────────────────────────────────────────────────────────────────
describe("useAutoRestart — a paused canvas and a turn sent from the terminal", () => {
  const T0 = 1_800_000_000_000;
  const version = { canRestart: true, running: "3.32.1", installed: "3.32.2" } as unknown as VersionInfo;
  const notice: VersionNotice = { kind: "restart", from: "3.32.1", to: "3.32.2" };

  let asked: Array<Record<string, unknown> | null>;
  let answer: { status: number; body: unknown };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    asked = [];
    answer = { status: 409, body: { ok: false, reason: "busy" } };
    const store = () => {
      const m = new Map<string, string>();
      return {
        getItem: (k: string) => m.get(k) ?? null,
        setItem: (k: string, v: string) => { m.set(k, v); },
        removeItem: (k: string) => { m.delete(k); },
      };
    };
    vi.stubGlobal("window", {
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
      localStorage: store(),
      sessionStorage: store(),
      location: { reload: () => {} },
    });
    vi.stubGlobal("document", { visibilityState: "visible" });
    vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
      if (url === "/api/restart") asked.push(init?.body ? JSON.parse(init.body) : null);
      const { status, body } = answer;
      return { ok: status >= 200 && status < 300, status, json: async () => body };
    });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  /** Microtasks, so an ask's `await fetch` and its `.json()` have landed. */
  const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

  const env = (seq: number, payload: Record<string, unknown>): HookEnvelope =>
    ({ seq, receivedAt: T0 + seq, source: "claude", payload: { session_id: "s1764", cwd: "/w", ...payload } } as unknown as HookEnvelope);

  function deck() {
    const stateRef = { current: initialState() as GraphState };
    const view = hooks.mount(({ now }: { now: number }) => {
      const pause = usePauseGate(stateRef);
      const restart = useAutoRestart({
        now, stateRef, version, notice, noticeOpen: true, upgradeFailure: null, paused: pause.paused,
      });
      return { pause, restart };
    }, { now: T0 });
    /** The event stream's own two lines: held while paused, applied otherwise. */
    const deliver = (e: HookEnvelope) => {
      if (view.now.pause.pauseGate.accept(e)) stateRef.current = applyEvent(stateRef.current, e);
    };
    /** The board's 250ms clock, from `from` to `to`. */
    const tick = async (from: number, to: number) => {
      for (let t = from; t <= to; t += 250) { view.rerender({ now: t }); await settle(); }
    };
    return { view, deliver, tick };
  }

  it("asks the server for a restart only when idle, and takes its no", async () => {
    const { view, deliver, tick } = deck();
    view.now.pause.togglePause();
    expect(view.now.pause.paused).toBe(true);
    deliver(env(1, { hook_event_name: "SessionStart" }));
    deliver(env(2, { hook_event_name: "UserPromptSubmit", prompt: "go" }));
    deliver(env(3, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "sleep 60" } }));
    expect(view.now.pause.pauseGate.size, "the pause holds the turn").toBe(3);

    // The button does not claim a quiet the page cannot see.
    expect(view.now.restart.restartCopy.label).not.toBe("Restart now");
    expect(view.now.restart.restartCopy.clause).not.toMatch(/nothing is running/);

    // The page's own clock runs out at T0 + 30s. What it asks then is a
    // restart that only an idle server grants — the server hears the turn the
    // pause is hiding.
    await tick(T0, T0 + IDLE_BEFORE_RESTART_MS);
    expect(asked).toEqual([{ upgrade: false, whenIdle: true }]);
    // Refused, it is not left saying "restarting…", and it does not ask again
    // on the next tick: the refusal starts the quiet stretch over.
    expect(view.now.restart.restarting).toBe(false);
    await tick(T0 + IDLE_BEFORE_RESTART_MS + 250, T0 + 2 * IDLE_BEFORE_RESTART_MS);
    expect(asked, "asked again inside the new window").toHaveLength(1);
    // A full window later it asks again, the same way.
    await tick(T0 + 2 * IDLE_BEFORE_RESTART_MS + 250, T0 + 2 * IDLE_BEFORE_RESTART_MS + 500);
    expect(asked).toEqual([{ upgrade: false, whenIdle: true }, { upgrade: false, whenIdle: true }]);
    expect(view.now.restart.restarting).toBe(false);
  });

  it("still restarts on its own when the server agrees nothing is running", async () => {
    // The pause does not switch auto-update off: a canvas left paused overnight
    // still updates, because the server knows it is quiet.
    answer = { status: 200, body: { ok: true, mode: null } };
    const { view, tick } = deck();
    view.now.pause.togglePause();
    await tick(T0, T0 + IDLE_BEFORE_RESTART_MS + 1_000);
    expect(asked).toEqual([{ upgrade: false, whenIdle: true }]);
    expect(view.now.restart.restarting).toBe(true);
  });

  it("leaves the banner's own press as it was: the person's call, not the server's", async () => {
    answer = { status: 200, body: { ok: true, mode: null } };
    const { view } = deck();
    await view.now.restart.askRestart();
    expect(asked).toEqual([{ upgrade: false }]);
  });
});

// ── the route ───────────────────────────────────────────────────────────────
// PORTS 4570-4579, and a `portRange` of exactly the one chosen, beside
// restart-refusals-994's 4560-4569 and away from the 4317 a real deck uses.
const SANDBOX = mkdtempSync(join(tmpdir(), "ccdeck-restart-paused-"));
const CONFIG = join(SANDBOX, "claude");
const CODEX = join(SANDBOX, "codex");
const PREV: Record<string, string | undefined> = {};
for (const k of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME"]) PREV[k] = process.env[k];
process.env.HOME = SANDBOX;
process.env.USERPROFILE = SANDBOX;
process.env.CLAUDE_CONFIG_DIR = CONFIG;
process.env.CODEX_HOME = CODEX;
process.env.XDG_CONFIG_HOME = join(SANDBOX, "xdg");
mkdirSync(join(CONFIG, "agent-dag"), { recursive: true });
mkdirSync(CODEX, { recursive: true });

// @ts-expect-error — plain .mjs server module, no types
const { startServer, hookToken, markDeckReady, releaseRestart } = await import("../../server/index.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { claudeConfigDir } = await import("../../server/claude-dir.mjs");
if (!resolve(String(claudeConfigDir())).startsWith(resolve(CONFIG))) {
  throw new Error(`refusing to run: resolved ${claudeConfigDir()}, outside ${CONFIG}`);
}

async function portInBand(): Promise<number> {
  for (let p = 4570; p <= 4579; p++) {
    const free = await new Promise<boolean>(done => {
      const s = createServer();
      s.once("error", () => done(false));
      s.listen(p, "127.0.0.1", () => s.close(() => done(true)));
    });
    if (free) return p;
  }
  throw new Error("no free port in 4570-4579 for a test deck");
}

afterAll(() => {
  for (const k of Object.keys(PREV)) {
    if (PREV[k] === undefined) delete process.env[k];
    else process.env[k] = PREV[k];
  }
  rmTempDir(SANDBOX);
});

describe("POST /api/restart { whenIdle: true } — refused while the server hears a turn", () => {
  let port = 0;
  let server: Server | null = null;
  const handed: unknown[] = [];
  const url = (p: string) => `http://127.0.0.1:${port}${p}`;
  const headers = () => ({ "content-type": "application/json", "x-ccdeck-token": (hookToken as () => string)() });
  const restart = (body: unknown) => fetch(url("/api/restart"), { method: "POST", headers: headers(), body: JSON.stringify(body) });
  const hook = (payload: Record<string, unknown>) =>
    fetch(url("/api/event"), { method: "POST", headers: headers(), body: JSON.stringify({ session_id: "s1764", cwd: "/w", ...payload }) })
      .then(r => r.json());
  /** Long enough for handOffRestart's 120 ms hand-off to have run, had it been scheduled. */
  const settle = () => new Promise(r => setTimeout(r, 400));

  afterAll(async () => {
    const s = server;
    server = null;
    if (s) await new Promise<void>(done => s.close(() => done()));
  });

  it("grants it on a deck that has heard no turn", async () => {
    port = await portInBand();
    server = await (startServer as (o: Record<string, unknown>) => Promise<Server>)({
      port, persist: join(SANDBOX, "log", "events.jsonl"), codex: false, claude: false, portRange: [port, port],
      onRestart: (mode: unknown) => { handed.push(mode); },
    });
    (markDeckReady as () => void)();

    const res = await restart({ whenIdle: true });
    expect(res.status).toBe(200);
    await settle();
    expect(handed).toEqual([null]);
    // The launcher here only records, so the latch is handed back by hand.
    (releaseRestart as () => void)();
    handed.length = 0;
  });

  it("refuses it mid-turn and straight after one, and hands the launcher nothing", async () => {
    // The turn the paused page could not see.
    expect((await hook({ hook_event_name: "SessionStart" })).ok).toBe(true);
    expect((await hook({ hook_event_name: "UserPromptSubmit", prompt: "go" })).ok).toBe(true);
    expect((await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1" })).ok).toBe(true);

    const mid = await restart({ whenIdle: true });
    expect(mid.status).toBe(409);
    expect(await mid.json()).toMatchObject({ ok: false, reason: "busy" });
    await settle();
    expect(handed, "the launcher was handed a restart mid-turn").toEqual([]);

    // Ended, but seconds ago: the page's own idle waits thirty, and so does this.
    expect((await hook({ hook_event_name: "Stop" })).ok).toBe(true);
    const after = await restart({ whenIdle: true });
    expect(after.status).toBe(409);
    expect((await after.json()).reason).toBe("busy");
    await settle();
    expect(handed).toEqual([]);
  });

  it("still lets a person restart anyway", async () => {
    // "Restart anyway" is a press the banner names for what it costs; the
    // server does not overrule it.
    const res = await restart({});
    expect(res.status).toBe(200);
    await settle();
    expect(handed).toEqual([null]);
    (releaseRestart as () => void)();
  });
});
