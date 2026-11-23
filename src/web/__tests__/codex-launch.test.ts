// A Codex launch becoming its session (components/terminal/codex-launch.ts):
// Codex picks its own id, so the stage puts each Codex that turns up on the
// board to the deck with the launch's key, and follows only a yes.
//
// Run as a hook under the suite's stand-in React (fake-react.ts), with the
// deck's claim route answered by a stubbed fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CODEX_LAUNCH_ASKS, CODEX_LAUNCH_GAP_MS, CODEX_UNSURE_FOR_MS, CODEX_UNSURE_GAPS_MS, codexCandidates, useCodexLaunch, type Asked as Seen } from "../components/terminal/codex-launch";
import type { StageTarget } from "../stage-shell";
import type { AgentNodeData } from "../types";
import { mount } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);

const KEY = "launch-k1";
const LAUNCH: StageTarget = { kind: "launch", agent: "codex", cwd: "/w/app", key: KEY };

function root(id: string, extra: Partial<AgentNodeData> = {}): AgentNodeData {
  return { id, sessionId: id, kind: "root", label: id, state: "active", tools: [], prompts: [], startedAt: 0, provider: "codex", cwd: "/w/app", ...extra } as AgentNodeData;
}

/** What the deck answers, per session id: claimed or not, a target kind, or a failure. */
type Answer = { claimed?: boolean; kind?: string; status?: number };
type Body = { key: string; sessionId: string; provider: string; cwd: string };
type Asked = { path: string; method: string; body: Body; at: number };
let answers: Map<string, Answer>;
/** Answers given one per ask, in order, before `answers` takes over. */
let sequences: Map<string, Answer[]>;
/** A deck that answers from the whole question, key included. */
let deck: ((body: Body) => Answer) | null;
let asked: Asked[];

beforeEach(() => {
  vi.useFakeTimers();
  answers = new Map();
  sequences = new Map();
  deck = null;
  asked = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    asked.push({ path: input, method: init?.method ?? "GET", body, at: Date.now() });
    const a = deck?.(body) ?? sequences.get(body.sessionId)?.shift() ?? answers.get(body.sessionId) ?? { claimed: false, kind: "C" };
    if (a.status) return new Response(JSON.stringify({ ok: false, error: "no" }), { status: a.status });
    const target = a.kind === "unsupported"
      ? { kind: "unsupported", label: "tmux is not answering right now.", reason: "not-answering" }
      : { kind: a.kind ?? "A", label: "…" };
    return new Response(JSON.stringify({ ok: true, claimed: a.claimed === true, target }), { status: 200 });
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

interface Props { target: StageTarget | null; agents: Map<string, AgentNodeData>; onFound: (id: string, key: string) => void }
function Harness({ target, agents, onFound }: Props) {
  useCodexLaunch(target, agents, onFound);
  return null;
}

/** Let the stubbed answers arrive. */
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function setup(agents: AgentNodeData[] = [root("old-codex")]) {
  const board = new Map(agents.map(a => [a.id, a]));
  const onFound = vi.fn();
  const props: Props = { target: LAUNCH, agents: board, onFound };
  const view = mount(Harness, props);
  const add = (a: AgentNodeData) => { board.set(a.id, a); view.rerender({ ...props }); };
  return { view, props, board, onFound, add };
}

describe("finding the session a Codex launch became", () => {
  it("asks the deck about a Codex that turns up after the launch, with the launch's key, and follows its yes once", async () => {
    const { view, props, onFound, add } = setup();
    answers.set("c-new", { claimed: true });
    add(root("c-new"));
    await settle();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ path: "/api/terminal/claim", method: "POST" });
    expect(asked[0].body).toEqual({ key: KEY, sessionId: "c-new", provider: "codex", cwd: "/w/app" });
    expect(onFound.mock.calls, "with the launch it was asked for").toEqual([["c-new", KEY]]);
    vi.advanceTimersByTime(CODEX_LAUNCH_GAP_MS * 4);
    view.rerender({ ...props });
    await settle();
    expect(asked, "a yes is not asked again").toHaveLength(1);
    expect(onFound).toHaveBeenCalledTimes(1);
  });

  it("never asks about what the board had before the launch, a Claude, or a subagent", async () => {
    const { add } = setup([root("old-codex"), root("old-claude", { provider: "claude" })]);
    add(root("new-claude", { provider: "claude" }));
    add(root("c-new::t1", { kind: "subagent", sessionId: "c-new" }));
    await settle();
    expect(asked).toEqual([]);
  });

  it("follows only the session the deck says yes to, when two begin at once", async () => {
    const { board, view, props, onFound } = setup();
    answers.set("c-mine", { claimed: true });
    answers.set("c-theirs", { claimed: false, kind: "A" });
    board.set("c-theirs", root("c-theirs"));
    board.set("c-mine", root("c-mine"));
    view.rerender({ ...props });
    await settle();
    expect(asked.map(a => a.body.sessionId).sort()).toEqual(["c-mine", "c-theirs"]);
    expect(onFound.mock.calls).toEqual([["c-mine", KEY]]);
  });

  it("takes a no that names another pane as final, and asks again only when the deck could not say", async () => {
    const { view, props, add } = setup();
    // CHANGED ON PURPOSE (Codex claim retry): a C is no longer final (see the
    // tests below), so the no here names another pane the deck started.
    answers.set("c-no", { claimed: false, kind: "A" });
    answers.set("c-stalled", { kind: "unsupported" });
    answers.set("c-failed", { status: 503 });
    add(root("c-no"));
    add(root("c-stalled"));
    add(root("c-failed"));
    await settle();
    const count = (id: string) => asked.filter(a => a.body.sessionId === id).length;
    expect([count("c-no"), count("c-stalled"), count("c-failed")]).toEqual([1, 1, 1]);
    view.rerender({ ...props });
    await settle();
    expect(count("c-stalled"), "not before the gap").toBe(1);
    for (let i = 0; i < CODEX_LAUNCH_ASKS + 2; i++) {
      vi.advanceTimersByTime(CODEX_LAUNCH_GAP_MS);
      view.rerender({ ...props });
      await settle();
    }
    expect(count("c-no")).toBe(1);
    expect(count("c-stalled")).toBe(CODEX_LAUNCH_ASKS);
    expect(count("c-failed")).toBe(CODEX_LAUNCH_ASKS);
  });

  it("asks nothing for a Claude launch or a session, and drops a yes that comes after the stage moved on", async () => {
    const claude = setup();
    claude.view.rerender({ ...claude.props, target: { kind: "launch", agent: "claude", cwd: "/w/app", key: KEY } });
    claude.add(root("c-new"));
    await settle();
    expect(asked).toEqual([]);

    const moved = setup();
    answers.set("c-late", { claimed: true });
    moved.board.set("c-late", root("c-late"));
    moved.view.rerender({ ...moved.props });
    moved.view.rerender({ ...moved.props, target: { kind: "session", id: "other" } });
    await settle();
    expect(asked).toHaveLength(1);
    expect(moved.onFound).not.toHaveBeenCalled();
  });

  it("drops a yes that comes after the stage has gone", async () => {
    const { view, props, board, onFound } = setup();
    answers.set("c-late", { claimed: true });
    board.set("c-late", root("c-late"));
    view.rerender({ ...props });
    view.unmount();
    await settle();
    expect(asked).toHaveLength(1);
    expect(onFound).not.toHaveBeenCalled();
  });

  it("starts over for the next launch, with the board as it is then", async () => {
    const { view, props, board, onFound } = setup();
    board.set("c-between", root("c-between"));
    view.rerender({ ...props, target: { ...LAUNCH, key: "launch-k2" } });
    await settle();
    expect(asked, "a session that was there when the launch was asked for").toEqual([]);
    answers.set("c-next", { claimed: true });
    board.set("c-next", root("c-next"));
    view.rerender({ ...props, target: { ...LAUNCH, key: "launch-k2" } });
    await settle();
    expect(asked[0].body.key).toBe("launch-k2");
    expect(onFound.mock.calls).toEqual([["c-next", "launch-k2"]]);
  });
});

/** Let `ms` go by, every launch rendered each `step`, as the board's clock does. */
async function pass(ms: number, step: number, ...runs: Array<{ view: { rerender(p: Props): void }; props: Props }>) {
  for (let gone = 0; gone < ms; gone += step) {
    vi.advanceTimersByTime(step);
    for (const r of runs) r.view.rerender({ ...r.props });
    await settle();
  }
}

/** When each ask about `id` went out, in seconds after `from`. */
const times = (id: string, from: number) => asked.filter(a => a.body.sessionId === id).map(a => (a.at - from) / 1000);

// On Windows the deck answers C for a new Codex while it cannot yet tell
// which console the session runs in, as when another Codex process was
// running at that moment. A C is asked again, further apart each time.
describe("a C, which the deck may answer while it cannot tell yet", () => {
  it("binds a Codex the board hears of late, once the deck can tell, and asks nothing after the yes", async () => {
    const run = setup();
    const t0 = Date.now();
    await pass(11_000, 250, run);
    sequences.set("c-late", [{ claimed: false, kind: "C" }, { claimed: false, kind: "C" }]);
    answers.set("c-late", { claimed: true });
    run.add(root("c-late"));
    await settle();
    await pass(CODEX_UNSURE_FOR_MS + 60_000, 1_000, run);
    expect(times("c-late", t0), "a C at 11 s, a C 3 s on, the yes 6 s after that").toEqual([11, 14, 20]);
    expect(run.onFound.mock.calls).toEqual([["c-late", KEY]]);
  });

  it("asks a C again after 3, 6 and 12 seconds and then every 30, never sooner", async () => {
    const run = setup();
    run.add(root("c-unsure"));
    const t0 = Date.now();
    await settle();
    await pass(120_000, 250, run);
    expect(CODEX_UNSURE_GAPS_MS).toEqual([3_000, 6_000, 12_000, 30_000]);
    expect(times("c-unsure", t0)).toEqual([0, 3, 9, 21, 51, 81, 111]);
    expect(run.onFound).not.toHaveBeenCalled();
  });

  it("stops asking a C ten minutes after the first", async () => {
    const run = setup();
    run.add(root("c-elsewhere"));
    const t0 = Date.now();
    await settle();
    await pass(CODEX_UNSURE_FOR_MS + 5 * 60_000, 1_000, run);
    const at = times("c-elsewhere", t0);
    expect(CODEX_UNSURE_FOR_MS).toBe(600_000);
    expect(at.at(-1), "the last ask, within the ten minutes").toBe(591);
    expect(at).toHaveLength(23);
    expect(run.onFound).not.toHaveBeenCalled();
  });

  it("asks only once about a session the deck places in another pane, or nowhere", async () => {
    const run = setup();
    const kinds = ["A", "B", "D", "gone"];
    for (const kind of kinds) {
      answers.set(`c-${kind}`, { claimed: false, kind });
      run.add(root(`c-${kind}`));
    }
    await settle();
    await pass(CODEX_UNSURE_FOR_MS, 1_000, run);
    expect(kinds.map(kind => asked.filter(a => a.body.sessionId === `c-${kind}`).length)).toEqual([1, 1, 1, 1]);
    expect(run.onFound).not.toHaveBeenCalled();
  });

  it("never binds a session to the other of two launches in one folder", async () => {
    const board = new Map([["old-codex", root("old-codex")]]);
    const launch = (key: string) => {
      const onFound = vi.fn();
      const props: Props = { target: { ...LAUNCH, key }, agents: board, onFound };
      return { view: mount(Harness, props), props, onFound };
    };
    const one = launch("launch-k1");
    const two = launch("launch-k2");
    const start = Date.now();
    // The deck cannot tell for the first 20 seconds, and then claims a
    // session only for the launch that started it.
    const mine: Record<string, string> = { "c-one": "launch-k1", "c-two": "launch-k2" };
    deck = body => (Date.now() - start >= 20_000 && mine[body.sessionId] === body.key ? { claimed: true } : { claimed: false, kind: "C" });
    board.set("c-two", root("c-two"));
    board.set("c-one", root("c-one"));
    await pass(CODEX_UNSURE_FOR_MS + 60_000, 1_000, one, two);
    expect(one.onFound.mock.calls).toEqual([["c-one", "launch-k1"]]);
    expect(two.onFound.mock.calls).toEqual([["c-two", "launch-k2"]]);
    const keys = new Set(asked.map(a => `${a.body.key} ${a.body.sessionId}`));
    expect(keys, "each launch asked about both sessions").toEqual(new Set(["launch-k1 c-one", "launch-k1 c-two", "launch-k2 c-one", "launch-k2 c-two"]));
    expect(Math.max(...asked.map(a => a.at)) - start, "nothing asked once both are found").toBe(22_000);
  });
});

describe("codexCandidates", () => {
  it("skips a session in flight, answered, out of tries, or asked within the gap", () => {
    const a = root("c");
    const at = 10_000;
    const ask = (seen: { tries: number; at: number; busy: boolean; done: boolean }) =>
      codexCandidates([a], new Set(), new Map([["c", seen]]), at).length;
    expect(codexCandidates([a], new Set(), new Map(), at)).toEqual([a]);
    expect(ask({ tries: 1, at: 0, busy: true, done: false })).toBe(0);
    expect(ask({ tries: 1, at: 0, busy: false, done: true })).toBe(0);
    expect(ask({ tries: CODEX_LAUNCH_ASKS, at: 0, busy: false, done: false })).toBe(0);
    expect(ask({ tries: 1, at: at - CODEX_LAUNCH_GAP_MS + 1, busy: false, done: false })).toBe(0);
    expect(ask({ tries: 1, at: at - CODEX_LAUNCH_GAP_MS, busy: false, done: false })).toBe(1);
  });

  it("waits out a C's growing gap, whatever the tries, and stops ten minutes after the first C", () => {
    const a = root("c");
    const ask = (seen: Seen, now: number) => codexCandidates([a], new Set(), new Map([["c", seen]]), now).length;
    const unsure = (n: number, at: number): Seen => ({ tries: n + CODEX_LAUNCH_ASKS, at, busy: false, done: false, unsure: n, since: 0 });
    for (const [n, gap] of [[1, 3_000], [2, 6_000], [3, 12_000], [4, 30_000], [9, 30_000]]) {
      expect(ask(unsure(n, 100_000), 100_000 + gap - 1), `C number ${n}, before its gap`).toBe(0);
      expect(ask(unsure(n, 100_000), 100_000 + gap), `C number ${n}, at its gap`).toBe(1);
    }
    expect(ask(unsure(9, 0), CODEX_UNSURE_FOR_MS - 1)).toBe(1);
    expect(ask(unsure(9, 0), CODEX_UNSURE_FOR_MS)).toBe(0);
    expect(ask({ ...unsure(2, 0), busy: true }, 60_000)).toBe(0);
    expect(ask({ ...unsure(2, 0), done: true }, 60_000)).toBe(0);
  });
});
