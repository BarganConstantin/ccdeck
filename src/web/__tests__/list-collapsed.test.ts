// Shut a group of the Sessions list from its header, so a long Done can be put
// out of the way while a person works with a few Pinned sessions: every group
// but Pinned has its header as the button; shut, the group keeps its label and
// count and draws no rows; opened again it draws its budget and "N more" as
// before; the choice is kept across a reload; and a session that newly needs
// you is never left behind a shut header.
//
// Run, not read: SessionList is called under fake-react on sessions the real
// reducer built, against a stubbed store, as list-pinned-session-list.test.ts
// does. The rules on their own are called first. What a browser does with the
// button (Enter and Space press it, focus stays on it) is the browser check's.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async () => (await import("./fake-react")).react);

import { all, mount, one, textOf, type Drawn } from "./fake-react";
import SessionList from "../components/SessionList";
import { FoldBody, GroupHead, MoreLine, RailRow, railRowId, type RowPin } from "../components/RailParts";
import { applyEvent, initialState, type GraphState } from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";
import { markSeen, resetSessionsSeen } from "../session-seen";
import { RAIL_PINNED, type Slot } from "../rail-model";
import {
  LIST_COLLAPSED_KEY, canShut, groupExpanded, loadCollapsed, pressHeader, reopenedBy, saveCollapsed, withShut,
} from "../list-collapsed";

const T0 = 1_700_000_000_000;
const SEC = 1000;
const MIN = 60 * SEC;
const NOW = T0 + 2 * MIN;
let seq = 0;
const send = (s: GraphState, sid: string, payload: Record<string, unknown>, at: number) =>
  applyEvent(s, { seq: ++seq, receivedAt: T0 + at, source: "hook", payload: { session_id: sid, ...payload } as HookPayload } as HookEnvelope);
const begin = (s: GraphState, sid: string, prompt: string | null, at: number) => {
  s = send(s, sid, { hook_event_name: "SessionStart", cwd: `/code/${sid}` }, at);
  return prompt == null ? s : send(s, sid, { hook_event_name: "UserPromptSubmit", prompt }, at + 1);
};
const waitOn = (s: GraphState, sid: string, at: number) => {
  s = send(s, sid, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: `${sid}-t`, tool_input: { command: "rm -rf build" } }, at);
  return send(s, sid, { hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" }, at + SEC);
};

/** `done` finished sessions, all seen, d00 the oldest; `waiting` ids blocked
 *  on a permission; one working session. */
function board({ done = 3, waiting = [] as readonly string[] } = {}): GraphState {
  let s = initialState();
  s = begin(s, "busy", "Refactor the parser", 0);
  for (const id of waiting) s = waitOn(begin(s, id, `Clean ${id}`, 0), id, 10 * SEC);
  for (let i = 0; i < done; i++) {
    const id = `d${String(i).padStart(2, "0")}`;
    s = begin(s, id, `Task ${id}`, 0);
    s = send(s, id, { hook_event_name: "Stop" }, (20 + i) * SEC);
    markSeen(id, s.agents.get(id)!.endedAt);
  }
  return s;
}

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
type Fold = { open: boolean; motion: string; controls?: string; onToggle: (e: { detail: number }) => void };

function deck(state: GraphState, opts: { seed?: Record<string, string>; historyReady?: boolean } = {}) {
  const store = fakeStore(opts.seed);
  vi.stubGlobal("document", { activeElement: null, hidden: false, documentElement: {}, addEventListener: () => {}, removeEventListener: () => {} });
  vi.stubGlobal("window", { localStorage: store, setTimeout, clearTimeout });
  vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
  vi.stubGlobal("CSS", { escape: (s: string) => s });
  const props = {
    state, now: NOW, historyReady: opts.historyReady ?? true, selectedIds: new Set<string>(), onSelect: () => {}, onClose: () => {},
    removedIds: new Set<string>(), landed: null as { id: string; nonce: number } | null,
  };
  const m = mount(SessionList as (p: typeof props) => unknown, props);
  const nodes = () => ([] as unknown[]).concat(one(m.tree, e => e.props.className === "sl-rows")!.props.children as unknown[]).flat()
    .filter((n): n is Drawn => !!n && typeof n === "object");

  /** Each group's header and the rows it DRAWS: its own, and an open fold's;
   *  not a closed fold's, nor the rows a shut group is drawing closing. */
  const groups = (): Array<[number, string[]]> => {
    const out: Array<[number, string[]]> = [];
    for (const node of nodes()) {
      if (node.type === GroupHead) out.push([node.props.group as number, []]);
      else if (isRow(node) && !node.props.leaving) out.at(-1)![1].push(idOf(node));
      else if (node.type === FoldBody && node.props.open) out.at(-1)![1].push(...all(node.props.children, isRow).filter(r => !r.props.leaving).map(idOf));
    }
    return out;
  };
  const rowsOf = (g: number) => groups().find(([n]) => n === g)?.[1] ?? null;
  const head = (g: number) => nodes().find(n => n.type === GroupHead && n.props.group === g) ?? null;
  const fold = (g: number) => head(g)?.props.fold as Fold | undefined;
  const press = (g: number, detail = 1) => fold(g)!.onToggle({ detail });
  const more = () => nodes().filter(n => n.type === MoreLine);
  const closing = (g: number) => nodes().find(n => n.type === FoldBody && n.props.shutting && n.key === `shut-${g}`) ?? null;
  const stored = () => (store.data.has(LIST_COLLAPSED_KEY) ? JSON.parse(store.data.get(LIST_COLLAPSED_KEY)!) as string[] : null);
  const rerender = (next: GraphState, extra: Partial<typeof props> = {}) => m.rerender({ ...props, state: next, ...extra });
  const pin = (id: string) => {
    const row = all(m.tree, e => isRow(e) && idOf(e) === id)[0];
    (row.props.pin as RowPin).run(id, { id: "pin" } as unknown as HTMLElement);
  };
  return { store, tree: () => m.tree, groups, rowsOf, head, fold, press, more, closing, stored, rerender, pin, unmount: m.unmount };
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

// ── the rules ───────────────────────────────────────────────────────────────

describe("the rules (list-collapsed.ts)", () => {
  it("lets every group but Pinned be shut", () => {
    expect(canShut(RAIL_PINNED)).toBe(false);
    expect([0, 1, 2, 3, 4].every(g => canShut(g as 0))).toBe(true);
  });

  it("calls a group expanded while it draws any row", () => {
    expect(groupExpanded({ shut: false, shown: 3, rest: 0, open: false })).toBe(true);
    expect(groupExpanded({ shut: true, shown: 3, rest: 0, open: false })).toBe(false);
    // Folded away whole by the budget: shut until its fold is open.
    expect(groupExpanded({ shut: false, shown: 0, rest: 4, open: false })).toBe(false);
    expect(groupExpanded({ shut: false, shown: 0, rest: 4, open: true })).toBe(true);
  });

  it("shuts an open group and lets its fold go; opens a shut one at its budget, or whole when the budget draws nothing", () => {
    expect(pressHeader({ shut: false, shown: 8, rest: 4, open: true })).toEqual({ shut: true, open: false });
    expect(pressHeader({ shut: false, shown: 3, rest: 0, open: false })).toEqual({ shut: true, open: false });
    expect(pressHeader({ shut: true, shown: 8, rest: 4, open: false })).toEqual({ shut: false, open: false });
    expect(pressHeader({ shut: true, shown: 0, rest: 4, open: false })).toEqual({ shut: false, open: true });
    expect(pressHeader({ shut: false, shown: 0, rest: 4, open: false })).toEqual({ shut: false, open: true });
  });

  it("opens a shut group again only for a session that newly needs you in it, and not on the first look", () => {
    const shut = new Set([0, 3] as const);
    const waiting: Slot[] = [{ id: "a", group: 0 }, { id: "b", group: 3 }, { id: "c", group: 2 }];
    expect(reopenedBy(shut, waiting, null)).toEqual([]);
    expect(reopenedBy(shut, waiting, new Set(["a", "b", "c"]))).toEqual([]);
    expect(reopenedBy(shut, waiting, new Set(["a"]))).toEqual([3]);
    expect(reopenedBy(shut, waiting, new Set())).toEqual([0, 3]);
    // Pinned never shuts, so a waiting pinned row opens nothing.
    expect(reopenedBy(shut, [{ id: "p", group: RAIL_PINNED }], new Set())).toEqual([]);
  });

  it("keeps the shut groups by name, and reads anything else as every group open", () => {
    const store = fakeStore();
    vi.stubGlobal("window", { localStorage: store });
    saveCollapsed(new Set([3, 0] as const));
    expect(store.data.get(LIST_COLLAPSED_KEY)).toBe('["needs","done"]');
    expect([...loadCollapsed()].sort()).toEqual([0, 3]);
    for (const junk of ["{not json", '"done"', '["done", 3, "pinned", "nope"]']) {
      store.data.set(LIST_COLLAPSED_KEY, junk);
      expect([...loadCollapsed()]).toEqual(junk.startsWith("[") ? [3] : []);
    }
    store.data.delete(LIST_COLLAPSED_KEY);
    expect(loadCollapsed().size).toBe(0);
    const set = new Set([3] as const);
    expect(withShut(set, 3, true)).toBe(set);
    expect([...withShut(set, 3, false)]).toEqual([]);
  });
});

// ── the list ────────────────────────────────────────────────────────────────

describe("a few completed sessions, nothing behind a fold", () => {
  it("shuts Done from its header, keeping the label and the count, and opens it again", () => {
    const d = deck(board({ done: 3 }));
    expect(d.rowsOf(3)).toEqual(["d02", "d01", "d00"]);
    expect(d.fold(3)).toMatchObject({ open: true, controls: ["d02", "d01", "d00"].map(railRowId).join(" ") });
    d.press(3);
    expect(d.head(3)!.props).toMatchObject({ group: 3, count: 3 });
    expect(d.fold(3)).toMatchObject({ open: false });
    expect(d.rowsOf(3)).toEqual([]);
    // The other groups are as they were.
    expect(d.rowsOf(2)).toEqual(["busy"]);
    expect(d.stored()).toEqual(["done"]);
    // The heading still counts every session listed.
    expect(textOf(one(d.tree(), e => e.props.className === "sl-count"))).toBe("4");
    d.press(3);
    expect(d.rowsOf(3)).toEqual(["d02", "d01", "d00"]);
    expect(d.fold(3)).toMatchObject({ open: true });
    expect(d.more()).toEqual([]);
    expect(d.stored()).toEqual([]);
  });

  it("is the same header before and after, so focus on it stays on it", () => {
    const d = deck(board({ done: 3 }));
    const before = d.head(3)!;
    d.press(3, 0);
    const after = d.head(3)!;
    expect(after.key).toBe(before.key);
    expect(after.type).toBe(GroupHead);
    expect(after.props.fold).toBeDefined();
  });

  it("by key goes at once; by the pointer the rows it drew fold away, inert, under the header", () => {
    const byKey = deck(board({ done: 3 }));
    byKey.press(3, 0);
    expect(byKey.fold(3)!.motion).toBe("instant");
    expect(byKey.closing(3)).toBeNull();
    byKey.unmount();
    vi.unstubAllGlobals();

    const byPointer = deck(board({ done: 3 }));
    byPointer.press(3, 1);
    expect(byPointer.fold(3)!.motion).toBe("animate");
    const closing = byPointer.closing(3)!;
    expect(closing.props.open).toBe(false);
    expect(all(closing.props.children, isRow).map(idOf)).toEqual(["d02", "d01", "d00"]);
    // Still nothing the list DRAWS: the closing body is on its way out.
    expect(byPointer.rowsOf(3)).toEqual([]);
    // Once it is done, a row that comes to the shut group later plays nothing.
    vi.advanceTimersByTime(1000);
    byPointer.rerender(board({ done: 4 }));
    expect(byPointer.closing(3)).toBeNull();
    expect(byPointer.rowsOf(3)).toEqual([]);
    expect(byPointer.head(3)!.props.count).toBe(4);
  });

  it("works on the other groups too: Working shuts and opens the same way", () => {
    const d = deck(board({ done: 2 }));
    expect(d.fold(2)).toMatchObject({ open: true });
    d.press(2);
    expect(d.rowsOf(2)).toEqual([]);
    expect(d.head(2)!.props.count).toBe(1);
    expect(d.stored()).toEqual(["working"]);
  });
});

describe("an overflowing Done", () => {
  it("shut draws no rows and no N more; opened again it is the budget and N more, as before", () => {
    const d = deck(board({ done: 12 }));
    // Working takes one of the eight: Done draws seven and folds five.
    expect(d.rowsOf(3)).toHaveLength(7);
    expect(d.more().map(n => n.props.count)).toEqual([5]);
    d.press(3);
    expect(d.rowsOf(3)).toEqual([]);
    expect(d.more()).toEqual([]);
    expect(d.head(3)!.props.count).toBe(12);
    d.press(3);
    expect(d.rowsOf(3)).toHaveLength(7);
    expect(d.more().map(n => n.props.count)).toEqual([5]);
  });

  it("lets N more go when it shuts, so it opens at its budget again", () => {
    const d = deck(board({ done: 12 }));
    (d.more()[0].props.onToggle as (e: { detail: number }) => void)({ detail: 1 });
    expect(d.rowsOf(3)).toHaveLength(12);
    expect(d.fold(3)!.controls!.split(" ")).toHaveLength(12);
    d.press(3);
    expect(d.rowsOf(3)).toEqual([]);
    d.press(3);
    expect(d.rowsOf(3)).toHaveLength(7);
    expect(d.more().map(n => n.props.count)).toEqual([5]);
  });

  it("still opens a group the budget folded away whole, and that press opens all of it", () => {
    const d = deck(board({ done: 12 }));
    for (const id of ["d00", "d01", "d02", "d03", "d04", "d05", "d06", "d07"]) d.pin(id);
    expect(d.rowsOf(3)).toEqual([]);
    expect(d.fold(3)).toMatchObject({ open: false });
    d.press(3);
    expect(d.rowsOf(3)).toHaveLength(4);
    d.press(3);
    expect(d.rowsOf(3)).toEqual([]);
    expect(d.stored()).toEqual(["done"]);
  });
});

describe("Pinned and Done together", () => {
  it("shutting Done leaves every pinned row drawn, and Pinned has no fold to shut", () => {
    const d = deck(board({ done: 5 }));
    d.pin("d01");
    d.pin("d03");
    d.press(3);
    expect(d.groups()).toEqual([[RAIL_PINNED, ["d01", "d03"]], [2, ["busy"]], [3, []]]);
    expect(d.head(RAIL_PINNED)!.props.fold).toBeUndefined();
    expect(d.head(3)!.props.count).toBe(3);
    // Nothing is closed or removed: unpinned, the row goes back into Done.
    d.pin("d03");
    expect(d.head(3)!.props.count).toBe(4);
  });
});

describe("kept across a reload", () => {
  it("draws a group left shut shut again, with nothing closing", () => {
    const first = deck(board({ done: 3 }));
    first.press(3);
    const saved = Object.fromEntries(first.store.data);
    first.unmount();
    vi.unstubAllGlobals();
    const again = deck(board({ done: 3 }), { seed: saved });
    expect(again.rowsOf(3)).toEqual([]);
    expect(again.fold(3)).toMatchObject({ open: false });
    expect(again.closing(3)).toBeNull();
  });

  it("opens every group when nothing, or nothing readable, is stored", () => {
    const d = deck(board({ done: 3 }), { seed: { [LIST_COLLAPSED_KEY]: "{not json" } });
    expect(d.rowsOf(3)).toHaveLength(3);
  });
});

describe("a session that needs you is never left behind a shut header", () => {
  it("opens Needs you again when a session newly waits, and not for the ones that waited already", () => {
    const d = deck(board({ done: 2, waiting: ["w1"] }));
    d.press(0);
    expect(d.rowsOf(0)).toEqual([]);
    d.rerender(board({ done: 2, waiting: ["w1"] }));
    expect(d.rowsOf(0)).toEqual([]);
    d.rerender(board({ done: 2, waiting: ["w1", "w2"] }));
    expect(d.rowsOf(0)!.sort()).toEqual(["w1", "w2"]);
    expect(d.fold(0)).toMatchObject({ open: true });
    expect(d.stored()).toEqual([]);
  });

  it("does not open on load for sessions that were waiting when the group was shut", () => {
    const d = deck(board({ done: 2, waiting: ["w1"] }), { seed: { [LIST_COLLAPSED_KEY]: '["needs"]' } });
    expect(d.rowsOf(0)).toEqual([]);
    d.rerender(board({ done: 2, waiting: ["w1"] }));
    expect(d.rowsOf(0)).toEqual([]);
  });

  it("does not open Done for a session that only finished", () => {
    const d = deck(board({ done: 2 }));
    d.press(3);
    d.rerender(board({ done: 3 }));
    expect(d.rowsOf(3)).toEqual([]);
    expect(d.head(3)!.props.count).toBe(3);
  });

  it("opens a shut group a jump lands in, so the row it went to is drawn", () => {
    const d = deck(board({ done: 3 }));
    d.press(3);
    d.rerender(board({ done: 3 }), { landed: { id: "d01", nonce: 7 } });
    expect(d.rowsOf(3)).toContain("d01");
  });
});

// ── the header itself ───────────────────────────────────────────────────────

describe("the header (GroupHead)", () => {
  const draw = (fold?: Fold) => {
    vi.stubGlobal("document", { activeElement: null, documentElement: {}, addEventListener: () => {}, removeEventListener: () => {} });
    const m = mount(GroupHead as (p: Record<string, unknown>) => unknown, { group: 3, count: 4, spaced: true, fold });
    return m.tree;
  };

  it("is one button, the chevron first, its name the label and the count, aria-expanded and aria-controls while open", () => {
    const tree = draw({ open: true, motion: "animate", controls: "sl-row-a sl-row-b", onToggle: () => {} });
    const button = one(tree, e => e.type === "button")!;
    expect(button.props).toMatchObject({ className: "sl-fold-btn", "aria-expanded": true, "aria-controls": "sl-row-a sl-row-b", title: "Collapse Done" });
    expect(button.props["aria-label"]).toBeUndefined();
    expect(textOf(button)).toBe("Done4");
    expect(one(tree, e => e.type === "li")!.props["data-group"]).toBe(3);
  });

  it("shut, says so, names no rows and offers to expand", () => {
    const tree = draw({ open: false, motion: "instant", controls: "", onToggle: () => {} });
    const button = one(tree, e => e.type === "button")!;
    expect(button.props).toMatchObject({ "aria-expanded": false, title: "Expand Done", "data-motion": "instant" });
    expect(button.props["aria-controls"]).toBeUndefined();
  });

  it("without a fold (Pinned) is the label and the count, no button", () => {
    expect(one(draw(), e => e.type === "button")).toBeNull();
  });
});
