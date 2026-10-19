// A Codex launch becoming its session (components/terminal/codex-launch.ts):
// Codex picks its own id, so the stage puts each Codex that turns up on the
// board to the deck with the launch's key, and follows only a yes.
//
// Run as a hook under the suite's stand-in React (fake-react.ts), with the
// deck's target route answered by a stubbed fetch.
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

/** What the deck answers, per session id: launched or not, a target kind, or a failure. */
type Answer = { launched?: boolean; kind?: string; status?: number };
let answers: Map<string, Answer>;
let asked: URL[];

beforeEach(() => {
  vi.useFakeTimers();
  answers = new Map();
  asked = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = new URL(input, "http://127.0.0.1/");
    asked.push(url);
    const a = answers.get(url.searchParams.get("session") ?? "") ?? { launched: false, kind: "C" };
    if (a.status) return new Response(JSON.stringify({ ok: false, error: "no" }), { status: a.status });
    const target = a.kind === "unsupported"
      ? { kind: "unsupported", label: "tmux is not answering right now.", reason: "not-answering" }
      : { kind: a.kind ?? "A", label: "…" };
    return new Response(JSON.stringify({ ok: true, target, ...(url.searchParams.has("launch") ? { launched: a.launched === true } : {}) }), { status: 200 });
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

interface Props { target: StageTarget | null; agents: Map<string, AgentNodeData>; onFound: (id: string) => void }
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
    answers.set("c-new", { launched: true });
    add(root("c-new"));
    await settle();
    expect(asked).toHaveLength(1);
    expect(asked[0].pathname).toBe("/api/terminal/target");
    expect(Object.fromEntries(asked[0].searchParams)).toEqual({ session: "c-new", provider: "codex", cwd: "/w/app", launch: KEY });
    expect(onFound.mock.calls).toEqual([["c-new"]]);
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
    answers.set("c-mine", { launched: true });
    answers.set("c-theirs", { launched: false, kind: "A" });
    board.set("c-theirs", root("c-theirs"));
    board.set("c-mine", root("c-mine"));
    view.rerender({ ...props });
    await settle();
    expect(asked.map(u => u.searchParams.get("session")).sort()).toEqual(["c-mine", "c-theirs"]);
    expect(onFound.mock.calls).toEqual([["c-mine"]]);
  });

  it("takes a no as final, and asks again only when the deck could not say", async () => {
    const { view, props, add } = setup();
    answers.set("c-no", { launched: false, kind: "C" });
    answers.set("c-stalled", { kind: "unsupported" });
    answers.set("c-failed", { status: 503 });
    add(root("c-no"));
    add(root("c-stalled"));
    add(root("c-failed"));
    await settle();
    const count = (id: string) => asked.filter(u => u.searchParams.get("session") === id).length;
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
    answers.set("c-late", { launched: true });
    moved.board.set("c-late", root("c-late"));
    moved.view.rerender({ ...moved.props });
    moved.view.rerender({ ...moved.props, target: { kind: "session", id: "other" } });
    await settle();
    expect(asked).toHaveLength(1);
    expect(moved.onFound).not.toHaveBeenCalled();
  });

  it("starts over for the next launch, with the board as it is then", async () => {
    const { view, props, board, onFound } = setup();
    board.set("c-between", root("c-between"));
    view.rerender({ ...props, target: { ...LAUNCH, key: "launch-k2" } });
    await settle();
    expect(asked, "a session that was there when the launch was asked for").toEqual([]);
    answers.set("c-next", { launched: true });
    board.set("c-next", root("c-next"));
    view.rerender({ ...props, target: { ...LAUNCH, key: "launch-k2" } });
    await settle();
    expect(asked[0].searchParams.get("launch")).toBe("launch-k2");
    expect(onFound.mock.calls).toEqual([["c-next"]]);
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
