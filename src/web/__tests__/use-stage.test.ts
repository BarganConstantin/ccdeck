// The terminal stage as App holds it (use-stage.ts): the flag, every way in —
// a click on a card, a session list row, the Terminal button, the asks run,
// the keys — and the rules it keeps with the rest of the deck: the detail
// panel and the stage evict each other, a rail panel asked for takes the right
// of the deck back, the stage is sized to the room the canvas has and no more,
// the board under the stage is inert only once a double-click can no longer
// be aimed at it, and with the flag off it answers "not mine" to everything.
//
// Run as a hook under the suite's stand-in React (fake-react.ts), against a
// canvas made of the few element methods the hook calls.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BlockedSession } from "../ambient-counts";
import { DOUBLE_CLICK_MS } from "../focus-hold";
import type { GraphState } from "../reducer";
import type { AgentNodeData } from "../types";
import {
  useRailPanel, useStage, useStageAsks, RESTORE_FRESH_MS, RESTORE_WAIT_MS, SHELL_UNAVAILABLE, STAGE_RESTORE_KEY, TERMINAL_SWITCHED_KEY as STAGE_SWITCHED,
  type StageDeps,
} from "../use-stage";
import { TYPE_AHEAD_MS } from "../type-ahead";
import { mount } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);

const rect = (x: number, y: number, w: number, h: number) =>
  ({ left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, x, y });

/** The canvas the hook reads: React Flow's element (which it makes inert),
 *  one card per id, a navigator tile per id, and its own size. */
function makeCanvas() {
  const flow = {
    inert: false,
    toggleAttribute: vi.fn((name: string, on: boolean) => { if (name === "inert") flow.inert = on; }),
    hasAttribute: (name: string) => name === "inert" && flow.inert,
    removeAttribute: vi.fn((name: string) => { if (name === "inert") flow.inert = false; }),
  };
  const nameEl = { getBoundingClientRect: () => rect(412, 210, 60, 15) };
  const card = {
    classList: { contains: (c: string) => c === "react-flow__node" },
    getBoundingClientRect: () => rect(400, 200, 240, 90),
    querySelector: (s: string) => (s === ".lod-name" ? nameEl : null),
  };
  const tile = { id: "tile" };
  /** The canvas's box as layout drew it, which may be a fraction of a pixel
   *  off the whole numbers clientWidth and clientHeight round to. */
  const box = { w: 1440, h: 848 };
  const canvas = {
    clientWidth: 1440,
    clientHeight: 848,
    box,
    getBoundingClientRect: () => rect(0, 52, box.w, box.h),
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
let storage: ((e: unknown) => void)[];
let local: Map<string, string>;
let localArea: Record<string, unknown>;
/** The window's capture listeners for keys and presses, the type-ahead's. */
let captured: Record<string, ((e: unknown) => void)[]>;

beforeEach(() => {
  vi.useFakeTimers();
  page = makeCanvas();
  focused = null;
  const g = globalThis as Record<string, unknown>;
  session = new Map();
  pagehide = [];
  storage = [];
  local = new Map();
  captured = { keydown: [], pointerdown: [], focusin: [] };
  localArea = {
    getItem: (k: string) => local.get(k) ?? null,
    setItem: (k: string, v: string) => { local.set(k, v); },
    removeItem: (k: string) => { local.delete(k); },
  };
  g.window = {
    setTimeout, clearTimeout, innerWidth: 1440,
    localStorage: localArea,
    addEventListener(type: string, fn: () => void) {
      if (type === "pagehide") pagehide.push(fn);
      if (type === "storage") storage.push(fn);
      if (type in captured) captured[type]!.push(fn);
    },
    removeEventListener(type: string, fn: () => void) {
      if (type === "pagehide") pagehide = pagehide.filter(f => f !== fn);
      if (type === "storage") storage = storage.filter(f => f !== fn);
      if (type in captured) captured[type] = captured[type]!.filter(f => f !== fn);
    },
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

  it("gives the card the focus the stage held when the detail panel evicts it — D pressed on a navigator tile", () => {
    const { view, now, turnOn, props } = setup();
    turnOn();
    now().stage.switchTo("s1", { focusPane: false });
    now().stage.reveal();
    const doc = (globalThis as Record<string, any>).document;
    doc.activeElement = { closest: (sel: string) => (sel.includes(".stage-nav") ? {} : null) };
    view.rerender({ ...props, deps: { ...props.deps, detailShown: true } });
    expect(now().stage.shell.phase).toBe("closed");
    expect(focused, "the tile went with the stage; <body> is not a place to leave it").toBe('.react-flow__node[data-id="s1"]');
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

describe("the switch in Settings", () => {
  /** The deck's answer to the POST, or a refusal, or no answer at all. */
  const answer = (out: { ok: boolean; body?: unknown } | Error) => {
    const fetch = vi.fn(async () => {
      if (out instanceof Error) throw out;
      return { ok: out.ok, json: async () => out.body };
    });
    vi.stubGlobal("fetch", fetch);
    return fetch;
  };
  const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
  afterEach(() => vi.unstubAllGlobals());

  it("turns the terminal on at the press, and keeps what the deck answers", async () => {
    const fetch = answer({ ok: true, body: { ok: true, terminalOn: true, terminalForced: false } });
    const { now } = setup();
    now().stage.toggleTerminal();
    expect(now().stage.enabled, "at the press, not a round trip later").toBe(true);
    expect(fetch).toHaveBeenCalledWith("/api/prefs", expect.objectContaining({ method: "POST", body: JSON.stringify({ terminal: true }) }));
    await flush();
    expect(now().stage.enabled).toBe(true);
    expect(now().stage.forced).toBe(false);
  });

  it("turns it off with the stage taken down at once and the board given back", async () => {
    const fetch = answer({ ok: true, body: { ok: true, terminalOn: false, terminalForced: false } });
    const { now, turnOn } = setup();
    turnOn();
    now().stage.onNodeClick("s1", page.card as unknown as Element);
    now().stage.reveal();
    vi.advanceTimersByTime(DOUBLE_CLICK_MS);
    expect(page.flow.inert).toBe(true);
    now().stage.toggleTerminal();
    expect(now().stage.enabled).toBe(false);
    expect(now().stage.shell.phase, "no morph: Settings is in front of it").toBe("closed");
    expect(page.flow.inert, "a board left inert would be a deck nobody can use").toBe(false);
    expect(fetch).toHaveBeenCalledWith("/api/prefs", expect.objectContaining({ body: JSON.stringify({ terminal: false }) }));
    await flush();
    expect(now().stage.enabled).toBe(false);
  });

  it("puts the switch back where the file has it when the deck refuses the write", async () => {
    answer({ ok: false, body: { ok: false, reason: "unwritable" } });
    const { now } = setup();
    now().stage.toggleTerminal();
    expect(now().stage.enabled).toBe(true);
    await flush();
    expect(now().stage.enabled).toBe(false);
  });

  it("puts it back when the deck does not answer at all", async () => {
    answer(new TypeError("Failed to fetch"));
    const { now, turnOn } = setup();
    turnOn();
    now().stage.toggleTerminal();
    expect(now().stage.enabled).toBe(false);
    await flush();
    expect(now().stage.enabled).toBe(true);
  });

  it("keeps only the latest press's answer when two cross on the way back", async () => {
    const answers: ((v: unknown) => void)[] = [];
    vi.stubGlobal("fetch", vi.fn(() => new Promise(resolve => answers.push(resolve))));
    const { now } = setup();
    now().stage.toggleTerminal();
    now().stage.toggleTerminal();
    expect(now().stage.enabled, "on, then off again").toBe(false);
    const reply = (on: boolean) => ({ ok: true, json: async () => ({ ok: true, terminalOn: on, terminalForced: false }) });
    answers[1](reply(false));
    await flush();
    answers[0](reply(true));
    await flush();
    expect(now().stage.enabled, "the first press's late answer is about a state already gone").toBe(false);
  });

  it("asks the deck what it holds when a write is refused, rather than guessing", async () => {
    const fetch = vi.fn(async (_url: string, init?: { method?: string }) => init?.method === "POST"
      ? { ok: false, json: async () => ({ ok: false, reason: "unwritable" }) }
      : { ok: true, json: async () => ({ ok: true, terminalOn: true, terminalForced: false }) });
    vi.stubGlobal("fetch", fetch);
    const { now } = setup();
    now().stage.toggleTerminal();
    await flush();
    expect(fetch).toHaveBeenLastCalledWith("/api/prefs");
    expect(now().stage.enabled, "the write landed after all: the deck says on").toBe(true);
  });

  it("tells the other tabs, which ask the deck and take the stage down when it is off", async () => {
    answer({ ok: true, body: { ok: true, terminalOn: true, terminalForced: false } });
    const { now } = setup();
    now().stage.toggleTerminal();
    await flush();
    expect(local.has(STAGE_SWITCHED), "this tab's press, told through storage").toBe(true);

    // Another tab, with its stage up, hears of it.
    const other = setup();
    other.turnOn();
    other.now().stage.onNodeClick("s1", page.card as unknown as Element);
    other.now().stage.reveal();
    expect(other.now().stage.shell.phase).not.toBe("closed");
    answer({ ok: true, body: { ok: true, terminalOn: false, terminalForced: false } });
    for (const fn of storage) fn({ storageArea: localArea, key: STAGE_SWITCHED, newValue: "1" });
    await flush();
    expect(other.now().stage.enabled).toBe(false);
    expect(other.now().stage.shell.phase).toBe("closed");
  });

  it("gives the card back the focus the stage held when another tab turns it off", async () => {
    const { now, turnOn } = setup();
    turnOn();
    now().stage.onNodeClick("s1", page.card as unknown as Element);
    now().stage.reveal();
    // The stage has left the page before the hook hears of it, so the focus it
    // held is on the body by then — what a real browser shows.
    const doc = (globalThis as Record<string, any>).document;
    doc.activeElement = doc.body;
    answer({ ok: true, body: { ok: true, terminalOn: false, terminalForced: false } });
    for (const fn of storage) fn({ storageArea: localArea, key: STAGE_SWITCHED, newValue: "1" });
    await flush();
    expect(now().stage.shell.phase).toBe("closed");
    expect(focused).toBe('.react-flow__node[data-id="s1"]');
  });

  it("leaves the focus on the switch in the tab that pressed it", async () => {
    const { now, turnOn } = setup();
    turnOn();
    now().stage.onNodeClick("s1", page.card as unknown as Element);
    now().stage.reveal();
    const doc = (globalThis as Record<string, any>).document;
    doc.activeElement = { closest: () => null };
    answer({ ok: true, body: { ok: true, terminalOn: false, terminalForced: false } });
    now().stage.toggleTerminal();
    await flush();
    expect(focused).toBeNull();
  });

  it("forgets the session a reload would have put back once it goes off", async () => {
    answer({ ok: true, body: { ok: true, terminalOn: false, terminalForced: false } });
    const { now, turnOn } = setup();
    turnOn();
    now().stage.onNodeClick("s1", page.card as unknown as Element);
    now().stage.reveal();
    expect(session.has(STAGE_RESTORE_KEY)).toBe(true);
    now().stage.toggleTerminal();
    expect(session.has(STAGE_RESTORE_KEY)).toBe(false);
  });

  it("forgets nothing on the first read, before the prefs said anything", () => {
    session.set(STAGE_RESTORE_KEY, JSON.stringify({ id: "s1", at: Date.now() }));
    const { now } = setup();
    now().stage.loadTerminalPrefs({ terminalOn: false });
    expect(session.has(STAGE_RESTORE_KEY), "a reload's restore is still to come").toBe(true);
  });

  it("says when the launch forced it on, from the read every page makes", () => {
    const { now } = setup();
    now().stage.loadTerminalPrefs({ terminalOn: true, terminalForced: true });
    expect(now().stage.enabled).toBe(true);
    expect(now().stage.forced).toBe(true);
    now().stage.loadTerminalPrefs({ terminalOn: true, terminalForced: "yes" });
    expect(now().stage.forced).toBe(false);
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
    expect(now().stage.shell.focusRequest, "the keys with it, as a card's click gives them").not.toBeNull();
  });

  it("gives the Terminal button the focus back when the empty stage it opened closes", () => {
    const { now, turnOn } = setup();
    turnOn();
    const button = { focus: vi.fn(), isConnected: true, getBoundingClientRect: () => rect(20, 400, 32, 32), classList: { contains: () => false } };
    now().stage.openFromButton(button as unknown as Element);
    now().stage.reveal();
    const doc = (globalThis as Record<string, any>).document;
    doc.activeElement = doc.body;
    now().stage.close();
    now().stage.closed("");
    expect(button.focus, "the empty stage has no card to go back to").toHaveBeenCalledTimes(1);
    expect(focused).toBeNull();
  });

  it("opens the Terminal button on the empty stage when nothing is selected or remembered", () => {
    const { now, turnOn } = setup();
    turnOn();
    now().stage.openFromButton(null);
    expect(now().stage.shell.target).toEqual({ kind: "empty" });
    expect(now().stage.shell.focusRequest, "met by the empty stage's New session").not.toBeNull();
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

  it("goes back to a launch the board has not heard of yet, from the Terminal button", () => {
    // A new Claude in an untrusted folder asks first, and no hook fires until
    // it is answered: closing the stage then must not lose the session.
    const { now, turnOn } = setup();
    turnOn();
    now().stage.openFromButton(null);
    now().stage.launch("claude", "/w/untrusted");
    now().stage.onLaunched({ sessionId: "s-asks-trust" });
    now().stage.close();
    now().stage.closed("");
    expect(now().stage.shell.phase).toBe("closed");
    now().stage.openFromButton(null);
    expect(now().stage.shell.target).toEqual({ kind: "session", id: "s-asks-trust" });
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

describe("the room the stage is given", () => {
  // The stage is sized from the canvas it shares, and stage-shell.css is what
  // keeps the canvas the cell's own size rather than the stage's: a dock that
  // could widen its grid track was read back as room it did not have, and a
  // window taken from 1440 to 900 in one step kept a stage 24px too wide for
  // good. That half lives in the sheet (stage-shell-view.test.ts holds it);
  // these hold the hook's: it follows whatever the canvas measures, down and
  // back, never past it, and the reader's column count survives the trip.
  let observers: (() => void)[];
  beforeEach(() => {
    observers = [];
    (globalThis as Record<string, unknown>).ResizeObserver = class {
      private fn: () => void;
      constructor(fn: () => void) { this.fn = fn; observers.push(fn); }
      observe() {}
      disconnect() { observers = observers.filter(f => f !== this.fn); }
    };
  });
  afterEach(() => { delete (globalThis as Record<string, unknown>).ResizeObserver; });

  /** The window resized to `win`, the canvas cell with it to `w` (which
   *  clientWidth reports rounded, as a browser does), the observer told. */
  const resize = (w: number, win: number) => {
    page.canvas.box.w = w;
    page.canvas.clientWidth = Math.round(w);
    (globalThis as Record<string, any>).window.innerWidth = win;
    for (const fn of [...observers]) fn();
  };

  it("follows a window taken straight down and back, and gives the reader's own width back with the room", () => {
    local.set("agent-dag.terminal.cols", "112");
    resize(1360, 1440);
    const { now, turnOn } = setup();
    turnOn();
    now().stage.switchTo("s1", { focusPane: false });
    expect(now().stage.geometry).toMatchObject({ cols: 112, stageW: 940, takeover: false });
    expect(observers.length, "the stage watches the canvas while it is up").toBe(1);

    resize(820, 900);
    const small = now().stage.geometry!;
    expect(small.takeover, "not even 80 columns fit beside a rail: the stage is the cell").toBe(true);
    expect(small.stageW, "the cell, never the width the stage had").toBe(820);
    expect(small.cols * 8 + 44).toBeLessThanOrEqual(820);

    resize(1360, 1440);
    expect(now().stage.geometry, "the 112 the reader chose, not what the small window could fit")
      .toMatchObject({ cols: 112, stageW: 940, takeover: false });
    expect(local.get("agent-dag.terminal.cols"), "a resize stores nothing").toBe("112");
  });

  it("measures the cell rounded down, so a fractional cell at a browser zoom is never asked for half a pixel more", () => {
    resize(820.6, 900);
    expect(page.canvas.clientWidth, "what clientWidth says").toBe(821);
    const { now, turnOn } = setup();
    turnOn();
    now().stage.switchTo("s1", { focusPane: false });
    expect(now().stage.geometry?.takeover).toBe(true);
    expect(now().stage.geometry?.stageW).toBe(820);
  });

  it("stops watching once the stage has gone", () => {
    const { now, turnOn } = setup();
    turnOn();
    now().stage.switchTo("s1", { focusPane: false });
    expect(observers.length).toBe(1);
    now().stage.failed();
    expect(observers.length).toBe(0);
  });
});

describe("a rail panel asked for while the stage is up", () => {
  // Usage and Machine float over the right of the cell, where the stage is.
  // Open before the stage came, they stand aside under it (stage-shell.css);
  // asked for while it is up — the stripe's button, U, S — one takes the right
  // of the deck back, as the detail panel does, and the stage goes at once.

  interface RailProps { deps: StageDeps; open: boolean; setOpen: ReturnType<typeof vi.fn> }
  function RailHarness({ deps, open, setOpen }: RailProps) {
    const stage = useStage(deps);
    const rail = useRailPanel(stage, open, setOpen);
    return { stage, rail };
  }

  /** The deck with one rail panel, `open` or not, and the stage open on s1
   *  unless `phase` says how far it got. What the document would do when the
   *  stage's DOM goes is said in `commit`: focus inside it falls to <body>. */
  function railSetup(opts: { open?: boolean; phase?: "waiting" | "open"; target?: "s1" | "empty"; focus?: "stage" | "button" | null } = {}) {
    const base = setup();
    const doc = (globalThis as Record<string, any>).document;
    const inStage = { closest: (sel: string) => (sel.includes(".stage-nav") ? {} : null) };
    const setOpen = vi.fn();
    let props: RailProps = { deps: base.deps, open: opts.open ?? false, setOpen };
    const view = mount(RailHarness, props, {
      commit: tree => {
        const t = tree as { stage: ReturnType<typeof useStage> };
        if (t.stage.shell.phase === "closed" && doc.activeElement === inStage) doc.activeElement = doc.body;
      },
    });
    const now = () => view.tree as { stage: ReturnType<typeof useStage>; rail: ReturnType<typeof useRailPanel> };
    now().stage.loadTerminalPrefs({ terminalOn: true });
    if (opts.target === "empty") now().stage.openFromButton(null);
    else now().stage.switchTo("s1", { focusPane: false });
    if ((opts.phase ?? "open") === "open") {
      now().stage.reveal();
      now().stage.revealed();
    }
    if (opts.focus === "stage") doc.activeElement = inStage;
    if (opts.focus === "button") doc.activeElement = { closest: () => null };
    const rerender = (over: Partial<RailProps>) => { props = { ...props, ...over }; view.rerender(props); };
    return { now, setOpen, rerender, doc };
  }

  it("reads as closed while the stage hides it, though its flag is kept for when the stage goes", () => {
    const { now, rerender } = railSetup({ open: true });
    expect(now().rail.shown, "stood aside under the stage: aria-expanded must not promise it").toBe(false);
    now().stage.close();
    rerender({});
    expect(now().rail.shown, "closing, the stage still covers the right").toBe(false);
    now().stage.closed("");
    rerender({});
    expect(now().rail.shown, "back with the board").toBe(true);
  });

  it("takes the right back on its button's toggle: the stage goes at once, and the panel is opened", () => {
    const { now, setOpen } = railSetup({ open: false });
    now().rail.set(o => !o);
    expect(now().stage.shell.phase, "no morph: the panel is already drawing where the stage was").toBe("closed");
    expect(setOpen).toHaveBeenCalledWith(true);
  });

  it("shows a panel the stage was hiding on the same press, rather than closing what nobody could see", () => {
    const { now, setOpen } = railSetup({ open: true });
    now().rail.set(o => !o);
    expect(setOpen, "a toggle answered from what is on screen").toHaveBeenCalledWith(true);
    expect(setOpen).not.toHaveBeenCalledWith(false);
    expect(now().stage.shell.phase).toBe("closed");
  });

  it("takes a stage still waiting unseen for its pane down too, which would hide the panel a moment later", () => {
    const { now, setOpen } = railSetup({ open: false, phase: "waiting" });
    expect(now().stage.shell.phase).toBe("waiting");
    now().rail.set(true);
    expect(now().stage.shell.phase).toBe("closed");
    expect(setOpen).toHaveBeenCalledWith(true);
  });

  it("leaves the stage up for a panel being closed", () => {
    const { now, setOpen } = railSetup({ open: false });
    now().rail.set(false);
    expect(now().stage.shell.phase).toBe("open");
    expect(setOpen).toHaveBeenCalledWith(false);
  });

  it("gives the focus the stage held back to the card — U pressed on a navigator tile", () => {
    const { now } = railSetup({ focus: "stage" });
    now().rail.set(o => !o);
    expect(focused).toBe('.react-flow__node[data-id="s1"]');
  });

  it("leaves the focus where the reader put it: on the stripe's button that was pressed", () => {
    const { now } = railSetup({ focus: "button" });
    now().rail.set(o => !o);
    expect(now().stage.shell.phase).toBe("closed");
    expect(focused).toBeNull();
  });

  it("puts the focus on the canvas when the stage showed no session, never on <body>", () => {
    const canvasFocus = vi.fn();
    (page.canvas as Record<string, unknown>).focus = canvasFocus;
    const { now } = railSetup({ focus: "stage", target: "empty" });
    expect(now().stage.shell.target).toEqual({ kind: "empty" });
    now().rail.set(true);
    expect(now().stage.shell.phase).toBe("closed");
    expect(canvasFocus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("is one setter for the life of the deck: the keys' listener keeps the first one it is given", () => {
    const { now, rerender } = railSetup({ open: false });
    const first = now().rail.set;
    rerender({ open: true });
    now().stage.close();
    expect(now().rail.set).toBe(first);
  });

  it("is the panel's own setter, called as it always was, with the terminal off", () => {
    const base = setup();
    const setOpen = vi.fn();
    const view = mount(RailHarness, { deps: base.deps, open: true, setOpen });
    const rail = (view.tree as { rail: ReturnType<typeof useRailPanel> }).rail;
    expect(rail.shown).toBe(true);
    const toggle = (o: boolean) => !o;
    rail.set(toggle);
    expect(setOpen, "the updater itself, for React to run on the latest state").toHaveBeenCalledWith(toggle);
  });
});

describe("keys typed before the pane can take them", () => {
  /** A keydown as the window's capture phase sees it: on the body, the board
   *  having gone inert under the stage, unless a target is given. */
  function press(key: string, extra: Record<string, unknown> = {}) {
    const e = {
      key, ctrlKey: false, metaKey: false, altKey: false, target: (globalThis as Record<string, any>).document.body,
      preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(), ...extra,
    };
    for (const fn of captured.keydown!) fn(e);
    return e;
  }
  const held = (e: ReturnType<typeof press>) => e.preventDefault.mock.calls.length > 0 && e.stopImmediatePropagation.mock.calls.length > 0;
  const pointer = (onStage: boolean) => {
    for (const fn of captured.pointerdown!) fn({ target: { closest: (sel: string) => (onStage && sel === ".stage-dock" ? {} : null) } });
  };
  const type = (keys: string[]) => keys.map(k => held(press(k)));

  it("holds what is typed after a click on a card, out of the deck's shortcuts, and hands it to that click's request once", () => {
    const { now, turnOn } = setup();
    turnOn();
    now().stage.onNodeClick("s1", page.card as unknown as Element);
    expect(type(["j", "k", " ", "é", "Enter", "Backspace"]), "j and k would have walked the stage to another session").toEqual([true, true, true, true, true, true]);
    const request = now().stage.shell.focusRequest;
    expect(now().stage.takeTypeAhead(request), "Enter and Backspace as xterm sends them").toBe("jk é\r\x7f");
    expect(now().stage.takeTypeAhead(request), "handed over once").toBe("");
    expect(held(press("x")), "and the keys go where they always went after").toBe(false);
  });

  it("holds after the Terminal button and the asks run too: both ask for the pane", () => {
    const { now, turnOn } = setup({ selected: "s1" });
    turnOn();
    now().stage.openFromButton(null);
    expect(held(press("a"))).toBe(true);
    now().stage.switchTo("s2", { focusPane: true });
    expect(held(press("b"))).toBe(true);
    expect(now().stage.takeTypeAhead(now().stage.shell.focusRequest), "what was typed for s1 went with s1").toBe("b");
  });

  it("holds after the stage itself asks for the keys again: Try again, Check again, Attach again, i", () => {
    // Try again brings the pane back a moment later; meanwhile its card had
    // gone, the focus was on the body, and the deck's shortcuts had the keys.
    const { now, turnOn } = setup();
    turnOn();
    now().stage.switchTo("s1", { focusPane: false });
    expect(held(press("x")), "nothing asked yet").toBe(false);
    now().stage.focusPane();
    expect(type(["o", "k"])).toEqual([true, true]);
    const request = now().stage.shell.focusRequest;
    expect(now().stage.holdsTypeAhead(request), "still holding, for a card that answers it to catch").toBe(true);
    expect(now().stage.holdsTypeAhead(-1)).toBe(false);
    expect(now().stage.takeTypeAhead(request)).toBe("ok");
    expect(now().stage.holdsTypeAhead(request), "handed over: nothing held").toBe(false);

    // Enter on the tile already on stage asks for the keys the same way.
    now().stage.openTile("s1", { keyboard: true });
    expect(held(press("z"))).toBe(true);
  });

  it("lets a key it cannot send go where it always went, and delivers nothing after one", () => {
    const { now, turnOn } = setup();
    turnOn();
    now().stage.onNodeClick("s1", page.card as unknown as Element);
    expect(held(press("h"))).toBe(true);
    expect([
      press("c", { ctrlKey: true }), press("k", { metaKey: true }), press("ArrowUp"), press("F5"), press("Process", { keyCode: 229 }),
    ].map(held)).toEqual([false, false, false, false, false]);
    expect(held(press("j")), "still kept from the deck's shortcuts").toBe(true);
    expect(now().stage.takeTypeAhead(now().stage.shell.focusRequest), "h, then a key it could not send: not what was typed").toBe("");
  });

  it("keeps a held Enter on the Terminal button from typing a stream of answers", () => {
    const { now, turnOn } = setup({ selected: "s1" });
    turnOn();
    const button = { tagName: "BUTTON", focus: vi.fn() };
    (globalThis as Record<string, any>).document.activeElement = button;
    now().stage.openFromButton(button as unknown as Element);
    expect([press("Enter", { target: button, repeat: true }), press("Enter", { target: button, repeat: true })].map(held)).toEqual([true, true]);
    expect(now().stage.takeTypeAhead(now().stage.shell.focusRequest)).toBe("");
  });

  it("holds where the press left the focus, on the body, and in the pane's own textarea", () => {
    const { now, turnOn } = setup();
    turnOn();
    const doc = (globalThis as Record<string, any>).document;
    const card = { tagName: "DIV" };
    doc.activeElement = card;
    now().stage.onNodeClick("s1", page.card as unknown as Element);
    expect(held(press("a", { target: card })), "the card that was clicked").toBe(true);
    expect(held(press("b")), "the body, the board having gone inert").toBe(true);
    doc.documentElement = { tagName: "HTML" };
    expect(held(press("c", { target: doc.documentElement }))).toBe(true);
    const pane = { tagName: "TEXTAREA", classList: { contains: (c: string) => c === "xterm-helper-textarea" } };
    expect(held(press("d", { target: pane })), "the pane's own textarea, between two sessions, is the hold's").toBe(true);
    expect(now().stage.takeTypeAhead(now().stage.shell.focusRequest)).toBe("abcd");
  });

  it("ends once the reader has moved the focus: an Enter on a tile or on ✕ is the control's, not the session's", () => {
    // Tab, then the arrows, to the next session's tile, and Enter: held, that
    // Enter would have answered the session the reader was leaving.
    for (const control of [{ tagName: "BUTTON", className: "nav-tile" }, { tagName: "BUTTON", className: "ts-close" }, { tagName: "INPUT" }]) {
      const { now, turnOn } = setup();
      turnOn();
      now().stage.onNodeClick("s1", page.card as unknown as Element);
      press("a");
      expect(held(press("Enter", { target: control })), control.className ?? control.tagName).toBe(false);
      expect(held(press("c")), "ended, not paused").toBe(false);
      expect(now().stage.takeTypeAhead(now().stage.shell.focusRequest)).toBe("");
    }
  });

  it("ends on Esc, which goes on to the deck, and on a press anywhere but the stage", () => {
    const { now, turnOn } = setup();
    turnOn();
    now().stage.onNodeClick("s1", page.card as unknown as Element);
    expect(held(press("Escape"))).toBe(false);
    expect(held(press("a")), "Esc took the keys back").toBe(false);
    now().stage.onNodeClick("s1", page.card as unknown as Element);
    pointer(true);
    expect(held(press("a")), "a press on the stage is still this session").toBe(true);
    pointer(false);
    expect(held(press("b"))).toBe(false);
    expect(now().stage.takeTypeAhead(now().stage.shell.focusRequest), "what it held goes with it").toBe("");
  });

  it("takes the request back with the keys: the pane, once it can, no longer reaches for them", () => {
    // Esc then ?, and the pane took the focus from under the key help sheet
    // half a second later (the hands-on run).
    const control = { tagName: "BUTTON", closest: () => null };
    const onStage = { tagName: "BUTTON", closest: (sel: string) => (sel === ".stage-dock" ? {} : null) };
    const ways: [string, () => void][] = [
      ["Esc", () => press("Escape")],
      ["the release chord", () => press("X", { ctrlKey: true, shiftKey: true, code: "KeyX" })],
      ["a press off the stage", () => pointer(false)],
      ["a key on a control the reader moved to", () => press("Enter", { target: control })],
      ["focus moved by the reader", () => { for (const fn of captured.focusin!) fn({ target: control }); }],
    ];
    for (const [how, take] of ways) {
      const { now, turnOn } = setup();
      turnOn();
      now().stage.onNodeClick("s1", page.card as unknown as Element);
      take();
      expect(now().stage.shell.focusRequest, how).toBeNull();
    }
    const { now, turnOn } = setup();
    turnOn();
    now().stage.onNodeClick("s1", page.card as unknown as Element);
    const request = now().stage.shell.focusRequest;
    for (const fn of captured.focusin!) fn({ target: onStage });
    pointer(true);
    press("ArrowUp");
    expect(now().stage.shell.focusRequest, "the stage's own focus, a press on it, a key that only spoils the hold").toBe(request);
    vi.advanceTimersByTime(TYPE_AHEAD_MS + 1);
    press("a");
    expect(now().stage.shell.focusRequest, "nor a hold that ran out: nobody said not to type").toBe(request);
  });

  it("is ended by any answer to its request, and only that request's answer is handed the text", () => {
    const { now, turnOn } = setup();
    turnOn();
    now().stage.onNodeClick("s1", page.card as unknown as Element);
    const request = now().stage.shell.focusRequest;
    press("a");
    expect(now().stage.takeTypeAhead("an older request")).toBe("");
    expect(held(press("b")), "still waiting on its own").toBe(true);
    expect(now().stage.takeTypeAhead(request)).toBe("ab");
  });

  it("goes with the stage moving to another session or closing, and with the flag going off", () => {
    const { now, turnOn, view, props } = setup();
    turnOn();
    now().stage.onNodeClick("s1", page.card as unknown as Element);
    now().stage.switchTo("s2", { focusPane: false });
    expect(held(press("a")), "a tile or j/k moved the stage: the letters were not for s2").toBe(false);
    now().stage.switchTo("s2", { focusPane: true });
    now().stage.close();
    expect(held(press("a"))).toBe(false);
    now().stage.switchTo("s1", { focusPane: true });
    now().stage.loadTerminalPrefs({ terminalOn: false });
    view.rerender({ ...props });
    expect(captured.keydown, "off, nothing listens").toEqual([]);
  });

  it("lets keys through again when the pane never came", () => {
    const { now, turnOn } = setup();
    turnOn();
    now().stage.onNodeClick("s1", page.card as unknown as Element);
    press("a");
    vi.advanceTimersByTime(TYPE_AHEAD_MS + 1);
    expect(held(press("b"))).toBe(false);
    expect(now().stage.takeTypeAhead(now().stage.shell.focusRequest)).toBe("");
  });

  it("is not started by a way in that leaves the keys on the board, nor by a launch", () => {
    const { now, turnOn } = setup();
    turnOn();
    now().stage.switchTo("s1", { focusPane: false });
    now().stage.openTile("s2");
    expect(held(press("j"))).toBe(false);
    now().stage.launch("claude", "/work");
    expect(held(press("h")), "a launch asks for the pane, but its welcome screen is seconds away").toBe(false);
  });
});
