// Pin a session, in the Sessions list (Board and Workspace draw the same one):
// every row has a pin beside its eye; a pinned row moves to Pinned, a group of
// its own above Needs you, in the order the pins were put on, keeps saying
// what its session wants, and is listed there only; it offers no hide; the
// pins survive a reload and go with a session that leaves the board; Alt+P on
// a focused row pins it or takes the pin off.
//
// Run, not read: SessionList and RailRow are called under fake-react, on
// sessions built by the real reducer, against a stubbed store. fake-react
// draws no child component, so the list is read as the elements it drew: its
// group headers and its rows, with their props. The rules on their own are
// list-pinned.test.ts; the shared setup is list-hidden-session-list.test.ts's.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async () => (await import("./fake-react")).react);

import { all, mount, one, textOf, type Drawn } from "./fake-react";
import SessionList from "../components/SessionList";
import { FoldBody, GroupHead, MoreLine, RailRow, type RowAct, type RowPin } from "../components/RailParts";
import { PinGlyph } from "../components/rail-glyphs";
import { applyEvent, initialState, type GraphState } from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";
import { markSeen, resetSessionsSeen } from "../session-seen";
import { LIST_PINNED_KEY, pinChordLabel } from "../list-pinned";
import { LIST_HIDDEN_KEY } from "../list-hidden";
import { RAIL_PINNED } from "../rail-model";
import { platformName } from "../platform";
import { LANGUAGES } from "../i18n";

const T0 = 1_700_000_000_000;
const SEC = 1000;
const MIN = 60 * SEC;
let seq = 0;
const send = (s: GraphState, sid: string, payload: Record<string, unknown>, at: number) =>
  applyEvent(s, { seq: ++seq, receivedAt: T0 + at, source: "hook", payload: { session_id: sid, ...payload } as HookPayload } as HookEnvelope);
const begin = (s: GraphState, sid: string, cwd: string, prompt: string | null, at: number) => {
  s = send(s, sid, { hook_event_name: "SessionStart", cwd }, at);
  return prompt == null ? s : send(s, sid, { hook_event_name: "UserPromptSubmit", prompt }, at + 1);
};
const stop = (s: GraphState, sid: string, at: number) => send(s, sid, { hook_event_name: "Stop" }, at);

/** One of each kind of row: "blocked" waits on a permission, "busy" works,
 *  "d1"–"d3" finished and were looked at, "ready" was never given a prompt.
 *  `without` leaves sessions out, as a board that has evicted them would. */
function board(without: readonly string[] = []): GraphState {
  const on = (id: string) => !without.includes(id);
  let s = initialState();
  if (on("busy")) s = begin(s, "busy", "/code/busy", "Refactor the parser", 0);
  if (on("blocked")) {
    s = begin(s, "blocked", "/code/blocked", "Clean the build", 0);
    s = send(s, "blocked", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "b1", tool_input: { command: "rm -rf build" } }, 10 * SEC);
    s = send(s, "blocked", { hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" }, 20 * SEC);
  }
  for (const [id, cwd, prompt, at] of [["d1", "/code/one", "Write the changelog", 30], ["d2", "/code/two", "Fix the flaky test", 40], ["d3", "/code/three", "Bump the version", 50]] as const) {
    if (!on(id)) continue;
    s = begin(s, id, cwd, prompt, 0);
    s = stop(s, id, at * SEC);
    markSeen(id, s.agents.get(id)!.endedAt);
  }
  if (on("ready")) s = begin(s, "ready", "/code/ready", null, 0);
  return s;
}

const NOW = T0 + 2 * MIN;

function fakeStore(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    setItem: (k: string, v: string) => { data.set(k, String(v)); },
    removeItem: (k: string) => { data.delete(k); },
  };
}

const isRow = (el: Drawn) => el.type === RailRow;
const idOf = (el: Drawn) => (el.props.row as { sessionId: string }).sessionId;
const pinOf = (el: Drawn) => el.props.pin as RowPin | undefined;
const actOf = (el: Drawn) => el.props.act as RowAct | undefined;

/** The list on `state`, drawn as the deck draws it. */
function deck(state: GraphState, opts: { seed?: Record<string, string>; historyReady?: boolean; workspace?: boolean } = {}) {
  const store = fakeStore(opts.seed);
  vi.stubGlobal("document", {
    activeElement: null,
    hidden: false,
    documentElement: {},
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  vi.stubGlobal("window", { localStorage: store, setTimeout, clearTimeout });
  vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
  vi.stubGlobal("CSS", { escape: (s: string) => s });

  const props = {
    state, now: NOW, historyReady: opts.historyReady ?? true, selectedIds: new Set<string>(), onSelect: () => {}, onClose: () => {},
    removedIds: new Set<string>(),
    ...(opts.workspace ? { onOpenKeys: () => {}, onOpenBeside: () => {} } : {}),
  };
  const m = mount(SessionList as (p: typeof props) => unknown, props);
  const tree = () => m.tree;
  const rows = () => one(tree(), e => e.props.className === "sl-rows")!;

  /** The list as drawn: each group's header and the rows under it, folded
   *  ones included, by the group's number (Pinned is -1). */
  const groups = (): Array<[number, string[]]> => {
    const out: Array<[number, string[]]> = [];
    for (const node of ([] as unknown[]).concat(rows().props.children as unknown[]).flat() as Drawn[]) {
      if (!node || typeof node !== "object") continue;
      if (node.type === GroupHead) out.push([node.props.group as number, []]);
      else if (isRow(node) && !node.props.leaving) out.at(-1)![1].push(idOf(node));
      else if (node.type === FoldBody) out.at(-1)![1].push(...all(node.props.children, isRow).filter(r => !r.props.leaving).map(idOf));
    }
    return out;
  };
  /** The list's own rows (not the Hidden line's), in drawn order. */
  const listed = () => all(tree(), e => isRow(e) && !e.props.leaving && actOf(e)?.kind !== "show");
  const listedIds = () => listed().map(idOf);
  const row = (id: string) => listed().find(e => idOf(e) === id)!;
  const head = (group: number) => one(tree(), e => e.type === GroupHead && e.props.group === group);
  /** A press on a row's pin, the way its button's click calls it. */
  const pin = (id: string) => pinOf(row(id))!.run(id, { id: "the pin" } as unknown as HTMLElement);
  const stored = () => JSON.parse(store.data.get(LIST_PINNED_KEY) ?? "[]") as string[];
  const aside = () => one(tree(), e => e.type === "aside")!;
  const pointerIn = () => (aside().props.onPointerEnter as () => void)();
  const pointerOut = () => (aside().props.onPointerLeave as () => void)();
  const rerender = (next: GraphState, extra: Partial<typeof props> = {}) => m.rerender({ ...props, state: next, ...extra });
  return { store, tree, groups, listed, listedIds, row, head, pin, stored, pointerIn, pointerOut, rerender, unmount: m.unmount };
}

beforeEach(() => {
  seq = 0;
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  resetSessionsSeen();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetSessionsSeen();
});

describe("which rows offer a pin", () => {
  it("every row, beside the eye on the rows that have one", () => {
    const d = deck(board());
    const offers = Object.fromEntries(d.listed().map(e => [idOf(e), [pinOf(e)?.pinned ?? null, actOf(e)?.kind ?? null]]));
    expect(offers).toEqual({
      blocked: [false, null], busy: [false, null],
      d1: [false, "hide"], d2: [false, "hide"], d3: [false, "hide"], ready: [false, "hide"],
    });
    expect(d.head(RAIL_PINNED)).toBeNull();
  });

  it("in Workspace too, which draws the same list", () => {
    const d = deck(board(), { workspace: true });
    expect(d.listed().every(e => pinOf(e) !== undefined)).toBe(true);
  });
});

describe("pinning a row", () => {
  it("puts it first, under its own Pinned header, in the order the pins were put on", () => {
    const d = deck(board());
    expect(d.groups()).toEqual([[0, ["blocked"]], [2, ["busy"]], [3, ["d3", "d2", "d1"]], [4, ["ready"]]]);
    d.pin("d2");
    d.pin("blocked");
    // Needs you had only the blocked row, so it is not drawn while it is pinned.
    expect(d.groups()).toEqual([[RAIL_PINNED, ["d2", "blocked"]], [2, ["busy"]], [3, ["d3", "d1"]], [4, ["ready"]]]);
    expect(d.head(RAIL_PINNED)!.props).toMatchObject({ count: 2, spaced: false });
    expect(d.head(RAIL_PINNED)!.props.fold).toBeUndefined();
    expect(d.stored()).toEqual(["d2", "blocked"]);
  });

  it("keeps the row's own state: its glyph, clock and line are its usual group's", () => {
    const d = deck(board());
    d.pin("blocked");
    d.pin("busy");
    d.pin("d1");
    // RailRow draws its glyph, clock and second line from `group`: rank()'s,
    // never Pinned's.
    expect(d.row("blocked").props.group).toBe(0);
    expect(d.row("busy").props.group).toBe(2);
    expect(d.row("d1").props.group).toBe(3);
  });

  it("lists a pinned row once, and the header still counts the rows drawn", () => {
    const d = deck(board());
    d.pin("d3");
    d.pin("busy");
    const ids = d.listedIds();
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
    expect(textOf(one(d.tree(), e => e.props.className === "sl-count"))).toBe("6");
  });

  it("offers Unpin and no hide on a pinned row, and gives the eye back once unpinned", () => {
    const d = deck(board());
    d.pin("d1");
    expect(pinOf(d.row("d1"))!.pinned).toBe(true);
    expect(actOf(d.row("d1"))).toBeUndefined();
    d.pin("d1");
    expect(pinOf(d.row("d1"))!.pinned).toBe(false);
    expect(actOf(d.row("d1"))?.kind).toBe("hide");
    expect(d.groups()).toEqual([[0, ["blocked"]], [2, ["busy"]], [3, ["d3", "d2", "d1"]], [4, ["ready"]]]);
    expect(d.stored()).toEqual([]);
  });

  it("outranks a hidden mark another tab left, and unpinned the row stays in the list", () => {
    const d = deck(board(), { seed: { [LIST_PINNED_KEY]: JSON.stringify(["d2"]), [LIST_HIDDEN_KEY]: JSON.stringify([["d2", NOW]]) } });
    expect(d.groups()[0]).toEqual([RAIL_PINNED, ["d2"]]);
    d.pin("d2");
    expect(d.listedIds()).toContain("d2");
    expect(JSON.parse(d.store.data.get(LIST_HIDDEN_KEY)!)).toEqual([]);
  });
});

describe("kept across a reload", () => {
  it("in the order they were pinned", () => {
    const first = deck(board());
    first.pin("ready");
    first.pin("busy");
    const saved = Object.fromEntries(first.store.data);
    first.unmount();
    vi.unstubAllGlobals();
    const again = deck(board(), { seed: saved });
    expect(again.groups()[0]).toEqual([RAIL_PINNED, ["ready", "busy"]]);
  });

  it("reads a store that holds anything else as nothing pinned", () => {
    const d = deck(board(), { seed: { [LIST_PINNED_KEY]: "{not json" } });
    expect(d.head(RAIL_PINNED)).toBeNull();
    expect(d.listedIds()).toHaveLength(6);
  });
});

describe("a pinned session that leaves the board", () => {
  it("leaves Pinned, its pin is dropped, and back under the same id it is not pinned", () => {
    const d = deck(board());
    d.pin("d2");
    d.pin("d1");
    d.rerender(board(["d2"]));
    expect(d.groups()[0]).toEqual([RAIL_PINNED, ["d1"]]);
    expect(d.stored()).toEqual(["d1"]);
    d.rerender(board());
    expect(d.groups()).toEqual([[RAIL_PINNED, ["d1"]], [0, ["blocked"]], [2, ["busy"]], [3, ["d3", "d2"]], [4, ["ready"]]]);
  });

  it("keeps its pin while the deck has not heard its whole history", () => {
    const seed = { [LIST_PINNED_KEY]: JSON.stringify(["long-gone", "d2"]) };
    const d = deck(board(), { seed, historyReady: false });
    expect(d.stored()).toEqual(["long-gone", "d2"]);
    d.rerender(board(), { historyReady: true });
    expect(d.stored()).toEqual(["d2"]);
  });
});

describe("the order held under the pointer", () => {
  it("keeps a row just pinned in its place, says a move waits, and moves it when the pointer leaves", () => {
    const d = deck(board());
    d.pointerIn();
    const before = d.listedIds();
    d.pin("d1");
    expect(d.listedIds()).toEqual(before);
    expect(one(d.tree(), e => e.props.className === "sl-held")).not.toBeNull();
    // Already Unpin, and no eye: the press is done, only the move waits.
    expect(pinOf(d.row("d1"))!.pinned).toBe(true);
    expect(actOf(d.row("d1"))).toBeUndefined();
    d.pointerOut();
    expect(d.groups()[0]).toEqual([RAIL_PINNED, ["d1"]]);
    expect(one(d.tree(), e => e.props.className === "sl-held")).toBeNull();
  });
});

describe("the fold", () => {
  it("draws Pinned whole, never behind N more, and the rows it draws come out of the groups' room", () => {
    let s = initialState();
    const ids = Array.from({ length: 12 }, (_, i) => `s${String(i).padStart(2, "0")}`);
    for (const [i, id] of ids.entries()) {
      s = begin(s, id, `/code/${id}`, `Task ${id}`, 0);
      s = stop(s, id, (i + 1) * SEC);
      markSeen(id, s.agents.get(id)!.endedAt);
    }
    const d = deck(s);
    const pinned = ids.slice(0, 9);
    for (const id of pinned) d.pin(id);
    const [first, done] = d.groups();
    expect(first).toEqual([RAIL_PINNED, pinned]);
    // Every pinned row is drawn in the list itself, none inside a fold.
    const loose = (([] as unknown[]).concat(one(d.tree(), e => e.props.className === "sl-rows")!.props.children as unknown[]).flat() as Drawn[])
      .filter(n => n && typeof n === "object" && isRow(n)).map(idOf);
    expect(pinned.every(id => loose.includes(id))).toBe(true);
    expect(d.head(RAIL_PINNED)!.props.fold).toBeUndefined();
    expect(all(d.tree(), e => e.type === MoreLine)).toEqual([]);
    // Nine pinned rows use the whole budget of eight: Done folds away whole.
    expect(done[0]).toBe(3);
    expect(done[1]).toHaveLength(3);
    expect(d.head(3)!.props.fold).toMatchObject({ open: false });
  });
});

describe("the row's pin and its key (RailRow)", () => {
  const row = {
    sessionId: "d1", label: "Write the changelog", state: "done", startedAt: T0, lastActivity: T0 + 30 * SEC,
    folder: "one", cwdBasename: "one", provider: "claude", task: "Write the changelog",
  };
  function drawRow(pin: RowPin | undefined, act?: RowAct) {
    const button = { id: "row" };
    vi.stubGlobal("document", { activeElement: null });
    const m = mount(RailRow as (p: Record<string, unknown>) => unknown, {
      row, group: 3, now: NOW, selected: false, removed: false, leaving: false, landNonce: null,
      onSelect: () => {}, compact: true, act, pin,
    }, {
      commit: tree => {
        const b = one(tree, e => e.type === "button" && e.props.className === "sl-row");
        if (b) (b.ref as { current: unknown }).current = button;
      },
    });
    const inner = one(m.tree, e => e.props.className === "sl-row-in")!;
    const key = (k: string, extra: Record<string, unknown> = {}) => {
      const e = { key: k, code: "", repeat: false, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, target: button,
        preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra };
      (inner.props.onKeyDown as ((ev: typeof e) => void) | undefined)?.(e);
      return e;
    };
    return { tree: m.tree, button, key };
  }

  it("is a quiet icon button after the eye, at the edge, named Pin, its key in its title", () => {
    const run = vi.fn();
    const { tree } = drawRow({ pinned: false, run }, { kind: "hide", run: () => {} });
    const buttons = all(tree, e => e.type === "button");
    // The pin last, so it is at the edge on every row and stays put when the
    // eye comes and goes: a second press on it is the pin again, never the eye.
    expect(buttons.map(b => b.props.className)).toEqual(["sl-row", "sl-row-act sl-row-hide", "sl-row-act sl-row-pin"]);
    const pin = buttons[2];
    expect(pin.props["aria-label"]).toBe("Pin");
    expect(pin.props.title).toBe(`Pin (${pinChordLabel(platformName())})`);
    expect(one(pin, e => e.type === PinGlyph)!.props.pinned).toBe(false);
    const target = { id: "the pin" };
    (pin.props.onClick as (e: { currentTarget: unknown }) => void)({ currentTarget: target });
    expect(run).toHaveBeenCalledWith("d1", target);
  });

  it("says Unpin on a pinned row, draws the pin struck through, and says pinned after the name", () => {
    const { tree } = drawRow({ pinned: true, run: () => {} });
    const pin = one(tree, e => e.props.className === "sl-row-act sl-row-pin")!;
    expect(pin.props["aria-label"]).toBe("Unpin");
    expect(pin.props.title).toBe(`Unpin (${pinChordLabel(platformName())})`);
    expect(one(pin, e => e.type === PinGlyph)!.props.pinned).toBe(true);
    const name = one(tree, e => e.props.className === "sl-name")!;
    expect(textOf(name)).toContain(", pinned");
    // Nothing of the eye: a pinned row is drawn with no act.
    expect(one(tree, e => e.props.className === "sl-row-act sl-row-hide")).toBeNull();
  });

  it("pins the focused row on Alt+P, and stops it there", () => {
    const run = vi.fn();
    const r = drawRow({ pinned: false, run });
    const e = r.key("p", { altKey: true, code: "KeyP" });
    expect(run).toHaveBeenCalledWith("d1", r.button);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(e.stopPropagation).toHaveBeenCalled();
    // ⌥P on a Mac types π.
    r.key("π", { altKey: true, code: "KeyP" });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("leaves P to the deck's peek, and any other chord or a held key to whoever had it", () => {
    const run = vi.fn();
    const r = drawRow({ pinned: false, run });
    for (const [k, extra] of [
      ["p", {}], ["P", { shiftKey: true }], ["P", { altKey: true, shiftKey: true }],
      ["p", { altKey: true, ctrlKey: true }], ["p", { altKey: true, metaKey: true }], ["p", { altKey: true, repeat: true }],
    ] as const) {
      expect(r.key(k, { code: "KeyP", ...extra }).stopPropagation, `${k} ${JSON.stringify(extra)}`).not.toHaveBeenCalled();
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("has no Delete of its own on a pinned row: no hide, and the pin stays", () => {
    const run = vi.fn();
    const r = drawRow({ pinned: true, run });
    expect(r.key("Delete").stopPropagation).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("draws no pin on a row it is not given to (one leaving, one in the Hidden line)", () => {
    const { tree } = drawRow(undefined, { kind: "show", run: () => {} });
    expect(one(tree, e => e.props.className === "sl-row-act sl-row-pin")).toBeNull();
  });
});

describe("its words", () => {
  const KEYS = ["board.railGroup.pinned", "board.list.pinRow", "board.list.unpinRow", "board.list.pinnedSuffix"];

  it("are in every language, with the placeholders English has", () => {
    for (const { code, catalog } of LANGUAGES) {
      const c = catalog as Record<string, string>;
      for (const k of KEYS) {
        expect(c[k], `${code} ${k}`).toBeTruthy();
        expect(c[k].match(/\{\w+\}/g) ?? [], `${code} ${k}`).toEqual((LANGUAGES[0].catalog as Record<string, string>)[k].match(/\{\w+\}/g) ?? []);
      }
    }
  });

  it("are plain and short in English", () => {
    const en = LANGUAGES[0].catalog as Record<string, string>;
    expect(en["board.railGroup.pinned"]).toBe("Pinned");
    expect(en["board.list.pinRow"]).toBe("Pin");
    expect(en["board.list.unpinRow"]).toBe("Unpin");
    expect(en["board.list.pinnedSuffix"]).toBe(", pinned");
  });
});
