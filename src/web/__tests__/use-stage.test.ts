// The terminal stage as App holds it (use-stage.ts): the flag, every way in —
// a click on a card, a session list row, the Terminal button, the asks run,
// the keys — and the rules it keeps with the rest of the deck: the detail
// panel and the stage evict each other, the board under the stage is inert
// only once a double-click can no longer be aimed at it, and with the flag off
// it answers "not mine" to everything.
//
// Run as a hook under the suite's stand-in React (fake-react.ts), against a
// canvas made of the few element methods the hook calls.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BlockedSession } from "../ambient-counts";
import { DOUBLE_CLICK_MS } from "../focus-hold";
import type { GraphState } from "../reducer";
import type { AgentNodeData } from "../types";
import { useStage, useStageAsks, RESTORE_FRESH_MS, RESTORE_WAIT_MS, SHELL_UNAVAILABLE, STAGE_RESTORE_KEY, type StageDeps } from "../use-stage";
import { mount } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);

const rect = (x: number, y: number, w: number, h: number) =>
  ({ left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, x, y });

/** The canvas the hook reads: React Flow's element (which it makes inert),
 *  one card per id, a navigator tile per id, and its own size. */
function makeCanvas() {
  const flow = { inert: false, toggleAttribute: vi.fn((name: string, on: boolean) => { if (name === "inert") flow.inert = on; }) };
  const nameEl = { getBoundingClientRect: () => rect(412, 210, 60, 15) };
  const card = {
    classList: { contains: (c: string) => c === "react-flow__node" },
    getBoundingClientRect: () => rect(400, 200, 240, 90),
    querySelector: (s: string) => (s === ".lod-name" ? nameEl : null),
  };
  const tile = { id: "tile" };
  const canvas = {
    clientWidth: 1440,
    clientHeight: 848,
    getBoundingClientRect: () => rect(0, 52, 1440, 848),
    querySelector: vi.fn((sel: string) => {
      if (sel === ":scope > .react-flow") return flow;
      if (sel.startsWith(".react-flow__node")) return card;
      if (sel.startsWith(".board-nav [data-nav-session")) return tile;
      return null;
    }),
    querySelectorAll: () => [],
  };
  return { canvas, flow, card };
}

function root(id: string, extra: Partial<AgentNodeData> = {}): AgentNodeData {
  return { id, sessionId: id, kind: "root", label: id, state: "active", tools: [], prompts: [], startedAt: 0, ...extra } as AgentNodeData;
}

let page: ReturnType<typeof makeCanvas>;
let focused: string | null;
let session: Map<string, string>;
let pagehide: (() => void)[];

beforeEach(() => {
  vi.useFakeTimers();
  page = makeCanvas();
  focused = null;
  const g = globalThis as Record<string, unknown>;
  session = new Map();
  pagehide = [];
  g.window = {
    setTimeout, clearTimeout, innerWidth: 1440,
    addEventListener(type: string, fn: () => void) { if (type === "pagehide") pagehide.push(fn); },
    removeEventListener(type: string, fn: () => void) { if (type === "pagehide") pagehide = pagehide.filter(f => f !== fn); },
    sessionStorage: {
      getItem: (k: string) => session.get(k) ?? null,
      setItem: (k: string, v: string) => { session.set(k, v); },
      removeItem: (k: string) => { session.delete(k); },
    },
  };
  g.CSS = { escape: (s: string) => s };
  g.document = {
    body: {},
    activeElement: null,
    querySelector: (sel: string) => (sel.includes("react-flow__node") ? { focus: () => { focused = sel; } } : null),
  };
});

afterEach(() => {
  vi.useRealTimers();
  const g = globalThis as Record<string, unknown>;
  delete g.window;
  delete g.CSS;
  delete g.document;
});

interface Props {
  deps: StageDeps;
  waiting: BlockedSession[];
}

function Harness({ deps, waiting }: Props) {
  const stage = useStage(deps);
  const asks = useStageAsks(stage, waiting, deps.canvasRef);
  return { stage, asks };
}

function setup(opts: { detailOpen?: boolean; selected?: string | null; agents?: AgentNodeData[] } = {}) {
  const agents = new Map((opts.agents ?? [root("s1"), root("s2"), { ...root("s1::a"), sessionId: "s1", kind: "subagent" } as AgentNodeData])
    .map(a => [a.id, a]));
  const setDetailOpen = vi.fn();
  const selectAgent = vi.fn();
  const deps: StageDeps = {
    stateRef: { current: { agents } as unknown as GraphState },
    canvasRef: { current: page.canvas as unknown as HTMLElement },
    detailOpen: opts.detailOpen ?? false,
    detailShown: false,
    setDetailOpen,
    primarySelectedIdRef: { current: opts.selected ?? null },
    selectAgent,
  };
  const props: Props = { deps, waiting: [] };
  const view = mount(Harness, props);
  const now = () => view.tree as { stage: ReturnType<typeof useStage>; asks: ReturnType<typeof useStageAsks> };
  const turnOn = () => now().stage.loadTerminalPrefs({ terminalOn: true });
  return { view, now, deps, props, setDetailOpen, selectAgent, turnOn };
}

describe("with the terminal flag off", () => {
  it("leaves a click on a card to the deck: the stage answers false and nothing opens", () => {
    const { now, setDetailOpen } = setup({ detailOpen: true });
    expect(now().stage.enabled).toBe(false);
    expect(now().stage.onNodeClick("s1", page.card as unknown as Element)).toBe(false);
    expect(now().stage.shell.phase).toBe("closed");
    expect(setDetailOpen, "the click's own line closes the panel, not the stage").not.toHaveBeenCalled();
  });

  it("claims no key, follows no session list row, and never touches the board", () => {
    const { now } = setup();
    now().stage.switchTo("s1", { focusPane: true });
    now().stage.openFromButton(null);
    expect(now().stage.followSession("s1")).toBe(false);
    expect(now().stage.shell.phase).toBe("closed");
    expect(now().stage.keysRef.current).toBeNull();
    expect(page.flow.toggleAttribute).not.toHaveBeenCalled();
  });

  it("turns on only for a prefs answer that says so", () => {
    const { now } = setup();
    now().stage.loadTerminalPrefs({ terminalOn: "yes" });
    expect(now().stage.enabled).toBe(false);
    now().stage.loadTerminalPrefs({ terminalOn: true });
    expect(now().stage.enabled).toBe(true);
  });
});

describe("a click on a card, with the flag on", () => {
  it("puts the card's session on the stage, growing out of the card that was clicked", () => {
    const { now, turnOn } = setup();
    turnOn();
    expect(now().stage.onNodeClick("s1::a", page.card as unknown as Element)).toBe(true);
    const { shell } = now().stage;
    expect(shell.phase, "unseen while the pane attaches").toBe("waiting");
    expect(shell.target).toEqual({ kind: "session", id: "s1" });
    expect(shell.origin).toEqual({ x: 400, y: 200, w: 240, h: 90 });
    expect(shell.originName).toEqual({ x: 412, y: 210, w: 60, h: 15 });
    expect(shell.grace, "a double-click's second press is still on its way").toBe(true);
    expect(shell.focusRequest, "a pointer that picked a session is about to type to it").not.toBeNull();
  });

  it("evicts the detail panel as it opens", () => {
    const { now, turnOn, setDetailOpen } = setup({ detailOpen: true });
    turnOn();
    now().stage.onNodeClick("s1", page.card as unknown as Element);
    expect(setDetailOpen).toHaveBeenCalledWith(false);
  });

  it("is closed at once by the detail panel appearing, with no morph", () => {
    const { view, now, turnOn, props } = setup();
    turnOn();
    now().stage.onNodeClick("s1", page.card as unknown as Element);
    view.rerender({ ...props, deps: { ...props.deps, detailShown: true } });
    expect(now().stage.shell.phase).toBe("closed");
  });

  it("switches the stage when it is already open, without moving where it grew from", () => {
    const { now, turnOn } = setup();
    turnOn();
    now().stage.onNodeClick("s1", page.card as unknown as Element);
    now().stage.reveal();
    now().stage.revealed();
    now().stage.onNodeClick("s2", page.card as unknown as Element);
    expect(now().stage.shell.phase).toBe("open");
    expect(now().stage.shell.target).toEqual({ kind: "session", id: "s2" });
  });
});

describe("the board under the stage", () => {
  it("stays reachable through the double-click window, then goes inert, and comes back when the stage goes", () => {
    const { now, turnOn } = setup();
    turnOn();
    now().stage.onNodeClick("s1", page.card as unknown as Element);
    now().stage.reveal();
    expect(page.flow.inert, "the second press of a double-click must reach the card").toBe(false);
    vi.advanceTimersByTime(DOUBLE_CLICK_MS);
    expect(now().stage.shell.grace).toBe(false);
    expect(page.flow.inert).toBe(true);
    now().stage.close();
    expect(now().stage.shell.phase).toBe("closing");
    expect(page.flow.inert, "the board is what the close lands on").toBe(false);
  });

  it("is inert at once for a stage opened by anything but a click", () => {
    const { now, turnOn } = setup();
    turnOn();
    now().stage.switchTo("s1", { focusPane: true });
    now().stage.reveal();
    expect(page.flow.inert).toBe(true);
    expect(now().stage.shell.focusRequest).not.toBeNull();
  });
});

describe("the other ways in", () => {
  it("lets a session list row move the stage only while it is up", () => {
    const { now, turnOn } = setup();
    turnOn();
    expect(now().stage.followSession("s2"), "closed: the row does what it always did").toBe(false);
    now().stage.switchTo("s1", { focusPane: false });
    expect(now().stage.followSession("s2")).toBe(true);
    expect(now().stage.shell.target).toEqual({ kind: "session", id: "s2" });
  });

  it("selects the session the stage moves to, without opening the detail panel that would evict it", () => {
    const { now, turnOn, selectAgent } = setup();
    turnOn();
    now().stage.switchTo("s1", { focusPane: false });
    now().stage.openTile("s2");
    expect(selectAgent.mock.calls).toEqual([["s1", false, false], ["s2", false, false]]);
    selectAgent.mockClear();
    now().stage.onNodeClick("s1::a", page.card as unknown as Element);
    expect(selectAgent, "a click on a card has selected the card already").not.toHaveBeenCalled();
    now().stage.switchTo("gone", { focusPane: false });
    expect(selectAgent, "a session the board no longer has cannot be selected").not.toHaveBeenCalled();
  });

  it("opens the Terminal button on the selected card's session", () => {
    const { now, turnOn } = setup({ selected: "s1::a" });
    turnOn();
    now().stage.openFromButton(null);
    expect(now().stage.shell.target).toEqual({ kind: "session", id: "s1" });
  });

  it("opens the Terminal button on the empty stage when nothing is selected or remembered", () => {
    const { now, turnOn } = setup();
    turnOn();
    now().stage.openFromButton(null);
    expect(now().stage.shell.target).toEqual({ kind: "empty" });
  });

  it("starts a run of asks from the chip, on the oldest ask, with the keys in its pane", () => {
    const { view, now, turnOn, props } = setup();
    turnOn();
    const waiting: BlockedSession[] = [
      { id: "s2", label: "s2", waiting: { kind: "permission", message: "", since: 1 } },
      { id: "s1", label: "s1", waiting: { kind: "permission", message: "", since: 2 } },
    ];
    view.rerender({ ...props, waiting });
    now().asks.startAsks();
    expect(now().stage.shell.target).toEqual({ kind: "session", id: "s2" });
    expect(now().stage.shell.focusRequest).not.toBeNull();
    expect(now().asks.view.track.map(s => s.id)).toEqual(["s2", "s1"]);
  });

  it("follows a launch to its session once the board has it", () => {
    const { view, now, turnOn, props, deps } = setup();
    turnOn();
    now().stage.openFromButton(null);
    now().stage.launch("claude", "/w/new");
    const key = (now().stage.shell.target as { key: string }).key;
    expect(key).toMatch(/^launch-/);
    now().stage.onLaunched({ sessionId: "s-new" });
    view.rerender(props);
    expect(now().stage.shell.target, "not on the board yet").toMatchObject({ kind: "launch" });
    deps.stateRef.current.agents.set("s-new", root("s-new"));
    view.rerender(props);
    expect(now().stage.shell.target).toEqual({ kind: "session", id: "s-new" });
  });
});

describe("the keys", () => {
  it("hands use-deck-shortcuts the stage while it is up, and walks the navigator's order", () => {
    const { now, turnOn } = setup();
    turnOn();
    expect(now().stage.keysRef.current?.open).toBe(false);
    now().stage.switchTo("s1", { focusPane: false });
    const keys = now().stage.keysRef.current!;
    expect(keys.open).toBe(true);
    expect(keys.current).toBe("s1");
    expect(keys.order).toEqual([]);
  });

  it("puts the keys in the pane on Enter, as a fresh request each time", () => {
    const { now, turnOn } = setup();
    turnOn();
    now().stage.switchTo("s1", { focusPane: false });
    now().stage.focusPane();
    const first = now().stage.shell.focusRequest;
    now().stage.focusPane();
    expect(first).not.toBeNull();
    expect(now().stage.shell.focusRequest).not.toBe(first);
  });

  it("puts the keys in the pane on Enter on the tile already on the stage, where the release left the focus", () => {
    const { now, turnOn } = setup();
    turnOn();
    now().stage.switchTo("s1", { focusPane: false });
    expect(now().stage.shell.focusRequest).toBeNull();
    now().stage.openTile("s1", { keyboard: true });
    expect(now().stage.shell.focusRequest, "the bar's \"↵ type here\"").not.toBeNull();
    expect(now().stage.shell.target).toEqual({ kind: "session", id: "s1" });
  });

  it("leaves the keys on the board for a pointer on that tile, and for Enter on any other tile", () => {
    const { now, turnOn } = setup();
    turnOn();
    now().stage.switchTo("s1", { focusPane: false });
    now().stage.openTile("s1", { keyboard: false });
    expect(now().stage.shell.focusRequest, "pointing at the socket is not asking to type").toBeNull();
    now().stage.openTile("s2", { keyboard: true });
    expect(now().stage.shell.target).toEqual({ kind: "session", id: "s2" });
    expect(now().stage.shell.focusRequest, "another tile is a switch, keys on the board").toBeNull();
  });

  it("gives the keys back onto the session's tile in the navigator", () => {
    const { now, turnOn } = setup();
    turnOn();
    now().stage.switchTo("s1", { focusPane: true });
    const focusTile = vi.fn();
    now().stage.navRef.current = { focusTile, tileRects: () => new Map(), fold: () => Promise.resolve(true) };
    now().stage.release();
    expect(focusTile).toHaveBeenCalledWith("s1");
  });

  it("always lands the release chord somewhere: ⌨, else ✕, else off the pane — never a keyboard trap", () => {
    const { now, turnOn } = setup();
    turnOn();
    now().stage.switchTo("s1", { focusPane: true });
    // No navigator beside the stage (the takeover, or a launch with no tile).
    const landed: string[] = [];
    const head = (buttons: Record<string, boolean>) => ({
      querySelector: (sel: string) => {
        const name = sel === "button[aria-pressed]" ? "keys" : sel === "button[data-stage-close]" ? "close" : null;
        return name && buttons[name] ? { focus: () => landed.push(name) } : null;
      },
    });
    const blur = vi.fn();
    const doc = globalThis.document as unknown as Record<string, unknown>;
    doc.activeElement = { blur };
    for (const buttons of [{ keys: true, close: true }, { keys: false, close: true }, { keys: false, close: false }]) {
      doc.querySelector = (sel: string) => (sel === ".stage-dock .ts-head" ? head(buttons) : null);
      now().stage.release();
    }
    expect(landed, "⌨ while the pane takes keys, ✕ once it does not").toEqual(["keys", "close"]);
    expect(blur, "with neither drawn, the pane's textarea still lets go").toHaveBeenCalledTimes(1);
  });
});

describe("a reload of the same tab", () => {
  const saved = (id: string, at = Date.now()) => session.set(STAGE_RESTORE_KEY, JSON.stringify({ id, at }));

  it("keeps the session on the stage, stamped again as the page goes, and forgets it once the stage closes", () => {
    const { now, turnOn } = setup();
    turnOn();
    now().stage.switchTo("s1", { focusPane: false });
    expect(JSON.parse(session.get(STAGE_RESTORE_KEY)!)).toMatchObject({ id: "s1" });
    vi.advanceTimersByTime(RESTORE_FRESH_MS * 2);
    for (const f of pagehide) f();
    expect(JSON.parse(session.get(STAGE_RESTORE_KEY)!).at, "fresh at the reload").toBe(Date.now());
    now().stage.close();
    now().stage.closed("");
    expect(session.has(STAGE_RESTORE_KEY)).toBe(false);
  });

  it("comes back on the same session once the board knows it, keys left on the board (S3)", () => {
    saved("s2");
    const { now, turnOn, deps, view, props } = setup({ agents: [root("s1")] });
    turnOn();
    expect(now().stage.shell.phase, "the board has not heard of s2 yet").toBe("closed");
    (deps.stateRef.current.agents as Map<string, AgentNodeData>).set("s2", root("s2"));
    view.rerender(props);
    expect(now().stage.shell.target).toEqual({ kind: "session", id: "s2" });
    expect(now().stage.shell.focusRequest, "a reload never types for anyone").toBeNull();
  });

  it("does not open on a stale tab, a session the board never hears of, or with the flag off", () => {
    saved("s1", Date.now() - RESTORE_FRESH_MS);
    const stale = setup();
    stale.turnOn();
    expect(stale.now().stage.shell.phase).toBe("closed");

    saved("gone");
    const gone = setup();
    gone.turnOn();
    vi.advanceTimersByTime(RESTORE_WAIT_MS + 1);
    (gone.deps.stateRef.current.agents as Map<string, AgentNodeData>).set("gone", root("gone"));
    gone.view.rerender(gone.props);
    expect(gone.now().stage.shell.phase, "too late: the reader has moved on").toBe("closed");

    saved("s1");
    const off = setup();
    off.view.rerender(off.props);
    expect(off.now().stage.shell.phase).toBe("closed");
    expect(session.has(STAGE_RESTORE_KEY), "the flag off touches nothing").toBe(true);
  });
});

describe("closing", () => {
  it("says the session keeps running and gives the card back its focus once the board is back", () => {
    const { now, turnOn } = setup();
    turnOn();
    now().stage.switchTo("s1", { focusPane: false });
    now().stage.reveal();
    now().stage.revealed();
    now().stage.close();
    now().stage.closed("Stage closed. s1 keeps running.");
    expect(now().stage.shell.phase).toBe("closed");
    expect(now().stage.said).toBe("Stage closed. s1 keeps running.");
    expect(focused).toBe('.react-flow__node[data-id="s1"]');
  });

  it("closes at once, and says why, when the stage's chunk will not load", () => {
    const { now, turnOn } = setup();
    turnOn();
    now().stage.switchTo("s1", { focusPane: false });
    now().stage.failed();
    expect(now().stage.shell.phase).toBe("closed");
    expect(now().stage.said).toBe(SHELL_UNAVAILABLE);
  });
});
