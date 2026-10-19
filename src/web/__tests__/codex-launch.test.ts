// A Codex launch becoming its session (components/terminal/codex-launch.ts):
// Codex picks its own id, so the stage puts each Codex that turns up on the
// board to the deck with the launch's key, and follows only a yes.
//
// Run as a hook under the suite's stand-in React (fake-react.ts), with the
// deck's claim route answered by a stubbed fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CODEX_LAUNCH_ASKS, CODEX_LAUNCH_GAP_MS, codexCandidates, useCodexLaunch } from "../components/terminal/codex-launch";
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
type Asked = { path: string; method: string; body: { key: string; sessionId: string; provider: string; cwd: string } };
let answers: Map<string, Answer>;
let asked: Asked[];

beforeEach(() => {
  vi.useFakeTimers();
  answers = new Map();
  asked = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    asked.push({ path: input, method: init?.method ?? "GET", body });
    const a = answers.get(body.sessionId) ?? { claimed: false, kind: "C" };
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

  it("takes a no as final, and asks again only when the deck could not say", async () => {
    const { view, props, add } = setup();
    answers.set("c-no", { claimed: false, kind: "C" });
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
});
