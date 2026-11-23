// Hide from list, in the Sessions list (Board and Workspace draw the same
// one): a finished or never-prompted row has a quiet trailing act that takes
// the row away, and only the row; an Undo offers it back for a few seconds; the
// list's last line, Hidden · n, lists what is hidden with Show in list; a
// hidden row comes back by itself when its session works again; and focus goes
// to the next row, else the one before, else the list's heading.
//
// Run, not read: SessionList, RailRow and the Undo strip are called under
// fake-react, on sessions built by the real reducer, against a stubbed store
// and fake timers. fake-react draws no child component and attaches no ref, so
// `commit` stands up the few nodes the list asks the document for (its rows,
// their buttons, the heading) from the tree it drew, the way the browser would.
// The rules on their own are list-hidden.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

vi.mock("react", async () => (await import("./fake-react")).react);

import { all, mount, one, textOf, type Drawn } from "./fake-react";
import SessionList from "../components/SessionList";
import { FoldBody, HiddenLine, RailRow, hideOnDelete, type RowAct } from "../components/RailParts";
import HideUndo from "../components/HideUndo";
import { applyEvent, initialState, type GraphState } from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";
import { markSeen, resetSessionsSeen } from "../session-seen";
import { LIST_HIDDEN_KEY } from "../list-hidden";
import { REARRANGE_UNDO_MS } from "../rearrange-undo";
import { LANGUAGES } from "../i18n";
import type { ListHiddenOffer } from "../use-list-hidden";

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
 *  "d1"–"d3" finished and were looked at, "ready" was never given a prompt. */
function board(): GraphState {
  let s = initialState();
  s = begin(s, "busy", "/code/busy", "Refactor the parser", 0);
  s = begin(s, "blocked", "/code/blocked", "Clean the build", 0);
  s = send(s, "blocked", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "b1", tool_input: { command: "rm -rf build" } }, 10 * SEC);
  s = send(s, "blocked", { hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" }, 20 * SEC);
  s = begin(s, "d1", "/code/one", "Write the changelog", 0);
  s = stop(s, "d1", 30 * SEC);
  s = begin(s, "d2", "/code/two", "Fix the flaky test", 0);
  s = stop(s, "d2", 40 * SEC);
  s = begin(s, "d3", "/code/three", "Bump the version", 0);
  s = stop(s, "d3", 50 * SEC);
  for (const id of ["d1", "d2", "d3"]) markSeen(id, s.agents.get(id)!.endedAt);
  s = begin(s, "ready", "/code/ready", null, 0);
  return s;
}

const NOW = T0 + 2 * MIN;

// ── the few nodes of a document the list asks for ───────────────────────────

interface Page { active: unknown; keyboard: boolean }

/** An element: its tag, classes, data, children, and what focus does to it. */
class El {
  children: El[] = [];
  parentElement: El | null = null;
  dataset: Record<string, string> = {};
  /** The list's own rows, for its querySelectorAll. */
  rows: El[] = [];
  constructor(readonly page: Page, readonly tag: string, readonly classes: string[], readonly name: string) {}
  get classList() { return { contains: (c: string) => this.classes.includes(c) }; }
  private is(sel: string) {
    const [tag, ...cls] = sel.split(".");
    return (!tag || tag === this.tag) && cls.every(c => this.classes.includes(c));
  }
  contains(x: unknown): boolean { return x === this || this.children.some(c => c.contains(x)); }
  closest(sel: string): El | null {
    for (let e: El | null = this; e; e = e.parentElement) if (e.is(sel)) return e;
    return null;
  }
  querySelector(sel: string): El | null {
    for (const c of this.children) {
      if (c.is(sel)) return c;
      const d = c.querySelector(sel);
      if (d) return d;
    }
    return null;
  }
  /** Only the one question the list asks of itself: its rows in drawn order. */
  querySelectorAll(sel: string): El[] { return sel.includes(".sl-row-item") ? this.rows : []; }
  matches(sel: string) { return sel === ":focus-visible" ? this.page.active === this && this.page.keyboard : this.is(sel); }
  focus() { this.page.active = this; }
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
const actOf = (el: Drawn) => el.props.act as RowAct | undefined;

/** The list on `state`, with the document it is drawn in. */
function deck(state: GraphState, opts: { seed?: Record<string, string>; removeFromBoard?: () => void } = {}) {
  const page: Page = { active: null, keyboard: true };
  const store = fakeStore(opts.seed);
  vi.stubGlobal("document", {
    get activeElement() { return page.active; },
    hidden: false,
    documentElement: {},
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  vi.stubGlobal("window", { localStorage: store, setTimeout, clearTimeout });
  vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
  vi.stubGlobal("CSS", { escape: (s: string) => s });

  const els = new Map<string, El>();
  const el = (key: string, tag: string, classes: string[]) => {
    let e = els.get(key);
    if (!e) { e = new El(page, tag, classes, key); els.set(key, e); }
    e.children = [];
    e.parentElement = null;
    return e;
  };
  const adopt = (parent: El, kids: El[]) => { parent.children = kids; for (const k of kids) k.parentElement = parent; };
  const heading = new El(page, "h2", [], "heading");
  /** A row as RailRow draws it: the item, the row's button, its act. */
  const rowEl = (prefix: string, drawn: Drawn) => {
    const id = (drawn.props.row as { sessionId: string }).sessionId;
    const act = actOf(drawn);
    const item = el(`${prefix}item:${id}`, "li", ["sl-row-item"]);
    item.dataset = act?.kind === "show" ? { hiddenId: id } : { railId: id };
    const inner = el(`${prefix}in:${id}`, "div", ["sl-row-in"]);
    const button = el(`${prefix}row:${id}`, "button", ["sl-row"]);
    adopt(inner, act ? [button, el(`${prefix}act:${id}`, "button", act.kind === "hide" ? ["sl-row-act", "sl-row-hide"] : ["sl-row-act"])] : [button]);
    adopt(item, [inner]);
    return item;
  };

  const commit = (tree: unknown) => {
    const ul = one(tree, e => e.props.className === "sl-rows");
    const h2 = one(tree, e => e.type === "h2");
    if (!ul || !h2) return;
    (h2.ref as { current: unknown }).current = heading;
    const list = el("list", "ul", ["sl-rows"]);
    const rows: El[] = [];
    const kids: El[] = [];
    for (const node of ([] as unknown[]).concat(ul.props.children as unknown[]).flat() as Drawn[]) {
      if (!node || typeof node !== "object") continue;
      if (isRow(node) && !node.props.leaving) { const r = rowEl("", node); rows.push(r); kids.push(r); }
      else if (node.type === FoldBody && node.props.open) {
        for (const r of all(node.props.children, isRow).filter(n => !n.props.leaving)) { const x = rowEl("", r); rows.push(x); kids.push(x); }
      } else if (node.props.className === "sl-hidden") {
        const box = el("hidden-item", "li", ["sl-hidden"]);
        const hiddenList = el("hidden-list", "ul", ["sl-hidden-list"]);
        adopt(hiddenList, all(node, isRow).map(r => rowEl("h", r)));
        adopt(box, [hiddenList]);
        kids.push(box);
      }
    }
    adopt(list, kids);
    list.rows = rows;
    (ul.ref as { current: unknown }).current = list;
  };

  const onSelect = vi.fn();
  const props = { state, now: NOW, selectedIds: new Set<string>(), onSelect, onClose: () => {}, removedIds: new Set<string>() };
  const m = mount(SessionList as (p: typeof props) => unknown, props, { commit });
  const tree = () => m.tree;

  /** The list's own rows, in drawn order (not one on its way out, not the Hidden line's). */
  const listed = () => all(tree(), e => isRow(e) && !e.props.leaving && actOf(e)?.kind !== "show");
  const listedIds = () => listed().map(e => (e.props.row as { sessionId: string }).sessionId);
  const drawnRow = (id: string) => listed().find(e => (e.props.row as { sessionId: string }).sessionId === id);
  const hiddenRows = () => all(tree(), e => isRow(e) && actOf(e)?.kind === "show");
  const hiddenLine = () => one(tree(), e => e.type === HiddenLine);
  const offer = () => one(tree(), e => e.type === HideUndo)!.props.offer as ListHiddenOffer;
  const focusedName = () => (page.active as El | null)?.name ?? null;

  /** Hide from list on a row, the way a press on its act does: with focus on
   *  the act (a click there, or Enter after Tab), or with focus elsewhere. */
  const hide = (id: string, { focused = true } = {}) => {
    const act = els.get(`act:${id}`)!;
    if (focused) act.focus();
    const drawn = drawnRow(id);
    expect(actOf(drawn!)?.kind, `${id} has a hide`).toBe("hide");
    actOf(drawn!)!.run(id, act);
  };
  const show = (id: string) => {
    const act = els.get(`hact:${id}`)!;
    act.focus();
    const drawn = hiddenRows().find(e => (e.props.row as { sessionId: string }).sessionId === id)!;
    actOf(drawn)!.run(id, act);
  };
  const rerender = (next: GraphState, now = NOW) => m.rerender({ ...props, state: next, now });
  const pointerIn = () => (one(tree(), e => e.type === "aside")!.props.onPointerEnter as () => void)();
  return { page, store, els, tree, listed, listedIds, hiddenRows, hiddenLine, offer, focusedName, hide, show, rerender, pointerIn, onSelect, unmount: m.unmount };
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

describe("which rows offer Hide from list", () => {
  it("a finished row and a never-prompted one, and never a working row or one that needs you", () => {
    const d = deck(board());
    const kinds = Object.fromEntries(d.listed().map(e => [(e.props.row as { sessionId: string }).sessionId, actOf(e)?.kind ?? null]));
    expect(kinds).toEqual({ blocked: null, busy: null, d1: "hide", d2: "hide", d3: "hide", ready: "hide" });
  });

  it("draws nothing for the hidden rows while none is hidden", () => {
    const d = deck(board());
    expect(d.hiddenLine()).toBeNull();
    expect(d.hiddenRows()).toEqual([]);
    expect(d.offer().open).toBe(false);
  });
});

describe("hiding a row", () => {
  it("takes the row out of the list, keeps it in storage, and offers it back by name", () => {
    const d = deck(board());
    d.hide("d2");
    expect(d.listedIds()).not.toContain("d2");
    expect(d.listedIds()).toHaveLength(5);
    expect(JSON.parse(d.store.data.get(LIST_HIDDEN_KEY)!).map(([id]: [string]) => id)).toEqual(["d2"]);
    expect(d.offer().open).toBe(true);
    expect(d.offer().name).toBeTruthy();
    expect(d.hiddenLine()!.props).toMatchObject({ count: 1, open: false });
    // The header's count is the rows the list draws.
    expect(textOf(one(d.tree(), e => e.props.className === "sl-count"))).toBe("5");
  });

  it("selects nothing, and leaves the session itself alone", () => {
    const s = board();
    const before = s.agents.get("d2")!.state;
    const d = deck(s);
    d.hide("d2");
    expect(d.onSelect).not.toHaveBeenCalled();
    expect(s.agents.get("d2")!.state).toBe(before);
    expect(s.agents.has("d2")).toBe(true);
  });

  it("is still hidden after a reload", () => {
    const first = deck(board());
    first.hide("d2");
    const saved = Object.fromEntries(first.store.data);
    first.unmount();
    vi.unstubAllGlobals();
    const again = deck(board(), { seed: saved });
    expect(again.listedIds()).not.toContain("d2");
    expect(again.hiddenLine()!.props).toMatchObject({ count: 1 });
    // A reload offers no Undo: that was the moment after the press.
    expect(again.offer().open).toBe(false);
  });

  it("reads a store that holds anything else as nothing hidden", () => {
    const d = deck(board(), { seed: { [LIST_HIDDEN_KEY]: "{not json" } });
    expect(d.listedIds()).toHaveLength(6);
    expect(d.hiddenLine()).toBeNull();
  });
});

describe("where focus goes", () => {
  it("to the next row when the hidden one had it", () => {
    const d = deck(board());
    const order = d.listedIds();
    const at = order.indexOf("d1");
    d.hide("d1");
    expect(d.focusedName()).toBe(`row:${order[at + 1]}`);
  });

  it("to the row before when the hidden one was the last", () => {
    const d = deck(board());
    const order = d.listedIds();
    expect(order.at(-1)).toBe("ready");
    d.hide("ready");
    expect(d.focusedName()).toBe(`row:${order.at(-2)}`);
  });

  it("to the list's heading when it was the only row", () => {
    let s = initialState();
    s = begin(s, "only", "/code/only", null, 0);
    const d = deck(s);
    d.hide("only");
    expect(d.focusedName()).toBe("heading");
    expect(d.listedIds()).toEqual([]);
  });

  it("nowhere new when it was not in the row (a press that does not focus)", () => {
    const d = deck(board());
    d.page.active = null;
    d.hide("d1", { focused: false });
    expect(d.page.active).toBeNull();
  });
});

describe("Undo", () => {
  it("brings the row back where it was, with focus on it, and the offer ends", () => {
    const d = deck(board());
    const order = d.listedIds();
    d.hide("d2");
    d.offer().undo();
    expect(d.listedIds()).toEqual(order);
    expect(d.focusedName()).toBe("row:d2");
    expect(d.offer().open).toBe(false);
    expect(d.hiddenLine()).toBeNull();
    expect(JSON.parse(d.store.data.get(LIST_HIDDEN_KEY)!)).toEqual([]);
  });

  it("puts it back in its place in an order held under the pointer, not at its group's end", () => {
    const d = deck(board());
    d.pointerIn();
    const order = d.listedIds();
    const done = order.filter(id => id.startsWith("d"));
    expect(done).toHaveLength(3);
    d.hide(done[0]);
    d.offer().undo();
    expect(d.listedIds()).toEqual(order);
  });

  it("is offered for Re-arrange's few seconds, then the row stays hidden", () => {
    const d = deck(board());
    d.hide("d2");
    vi.advanceTimersByTime(REARRANGE_UNDO_MS - 1);
    expect(d.offer().open).toBe(true);
    vi.advanceTimersByTime(1);
    expect(d.offer().open).toBe(false);
    expect(d.listedIds()).not.toContain("d2");
    expect(d.hiddenLine()!.props).toMatchObject({ count: 1 });
  });

  it("offers the last row hidden, and the one before stays hidden", () => {
    const d = deck(board());
    d.hide("d1");
    d.hide("d3");
    d.offer().undo();
    expect(d.listedIds()).toContain("d3");
    expect(d.listedIds()).not.toContain("d1");
  });
});

describe("Hidden · n", () => {
  it("is shut until pressed, then lists the hidden rows, newest first, each with Show in list", () => {
    const d = deck(board());
    d.hide("d1");
    d.hide("ready");
    const line = d.hiddenLine()!;
    expect(line.props).toMatchObject({ count: 2, open: false, controls: "sl-hidden-list" });
    expect(d.hiddenRows()).toEqual([]);
    (line.props.onToggle as () => void)();
    expect(d.hiddenLine()!.props.open).toBe(true);
    const list = one(d.tree(), e => e.props.id === "sl-hidden-list")!;
    expect(list.props.className).toBe("sl-hidden-list");
    expect(d.hiddenRows().map(e => (e.props.row as { sessionId: string }).sessionId)).toEqual(["ready", "d1"]);
    for (const row of d.hiddenRows()) {
      expect(actOf(row)?.kind).toBe("show");
      // Still opens its session; not dragged into a pane, not renamed from here.
      expect(row.props.onSelect).toBeTypeOf("function");
      expect(row.props.onOpenBeside).toBeUndefined();
      expect(row.props.rename).toBeUndefined();
    }
  });

  it("opening a hidden row's session does not bring it back", () => {
    const d = deck(board());
    d.hide("d1");
    (d.hiddenLine()!.props.onToggle as () => void)();
    (d.hiddenRows()[0].props.onSelect as (id: string) => void)("d1");
    expect(d.onSelect).toHaveBeenCalledWith("d1");
    expect(d.listedIds()).not.toContain("d1");
  });

  it("Show in list puts a row back, focus on the next hidden one, then on the row itself", () => {
    const d = deck(board());
    d.hide("d1");
    d.hide("d3");
    vi.advanceTimersByTime(REARRANGE_UNDO_MS);
    (d.hiddenLine()!.props.onToggle as () => void)();
    // Listed newest first: d3, then d1.
    d.show("d3");
    expect(d.listedIds()).toContain("d3");
    expect(d.focusedName()).toBe("hact:d1");
    d.show("d1");
    expect(d.listedIds()).toContain("d1");
    expect(d.focusedName()).toBe("row:d1");
    // Nothing hidden: the line is gone, and it opens shut next time.
    expect(d.hiddenLine()).toBeNull();
    d.hide("d2");
    expect(d.hiddenLine()!.props.open).toBe(false);
  });
});

describe("coming back by itself", () => {
  it("when its session works again, and the mark goes with it", () => {
    const s = board();
    const d = deck(s);
    d.hide("d2");
    expect(d.listedIds()).not.toContain("d2");
    vi.setSystemTime(NOW + MIN);
    const next = send(s, "d2", { hook_event_name: "UserPromptSubmit", prompt: "One more thing" }, 3 * MIN);
    d.rerender(next, NOW + MIN);
    expect(d.listedIds()).toContain("d2");
    expect(d.hiddenLine()).toBeNull();
    expect(JSON.parse(d.store.data.get(LIST_HIDDEN_KEY)!)).toEqual([]);
    // Its Undo has nothing left to do.
    expect(d.offer().open).toBe(false);
    // Finished again, it stays in the list: the next turn is not hidden.
    const done = stop(next, "d2", 4 * MIN);
    d.rerender(done, NOW + 3 * MIN);
    expect(d.listedIds()).toContain("d2");
  });

  it("and a session the deck has never seen is never hidden", () => {
    const s = board();
    const d = deck(s);
    d.hide("d2");
    const next = begin(s, "fresh", "/code/fresh", null, 90 * SEC);
    d.rerender(next);
    expect(d.listedIds()).toContain("fresh");
  });

  it("not on a reload that replays the history it was hidden over", () => {
    const first = deck(board());
    first.hide("d2");
    const saved = Object.fromEntries(first.store.data);
    first.unmount();
    vi.unstubAllGlobals();
    vi.setSystemTime(NOW + 10 * MIN);
    const again = deck(board(), { seed: saved });
    expect(again.listedIds()).not.toContain("d2");
  });

  it("forgets a session the deck no longer knows, once its history is in", () => {
    const d = deck(board(), { seed: { [LIST_HIDDEN_KEY]: JSON.stringify([["long-gone", 1], ["d2", NOW]]) } });
    expect(JSON.parse(d.store.data.get(LIST_HIDDEN_KEY)!)).toEqual([["d2", NOW]]);
    expect(d.hiddenLine()!.props).toMatchObject({ count: 1 });
  });
});

describe("the row's act and its key (RailRow)", () => {
  const row = {
    sessionId: "d1", label: "Write the changelog", state: "done", startedAt: T0, lastActivity: T0 + 30 * SEC,
    folder: "one", cwdBasename: "one", provider: "claude", task: "Write the changelog",
  };
  function drawRow(act: RowAct | undefined) {
    const page: Page = { active: null, keyboard: true };
    vi.stubGlobal("document", { get activeElement() { return page.active; } });
    const button = new El(page, "button", ["sl-row"], "row:d1");
    const m = mount(RailRow as (p: Record<string, unknown>) => unknown, {
      row, group: act ? 3 : 2, now: NOW, selected: false, removed: false, leaving: false, landNonce: null,
      onSelect: () => {}, compact: true, act,
    }, {
      commit: tree => {
        const b = one(tree, e => e.type === "button" && e.props.className === "sl-row");
        if (b) (b.ref as { current: unknown }).current = button;
      },
    });
    const inner = one(m.tree, e => e.props.className === "sl-row-in")!;
    // Focus arriving on the row reaches its wrapper's onFocus, as a focusin
    // bubbling up does in the page: that is where the row reads how it came.
    const focusEl = button.focus.bind(button);
    button.focus = () => { focusEl(); (inner.props.onFocus as ((ev: { target: unknown }) => void) | undefined)?.({ target: button }); };
    const key = (k: string, extra: Record<string, unknown> = {}) => {
      const e = { key: k, repeat: false, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, target: button,
        preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra };
      (inner.props.onKeyDown as ((ev: typeof e) => void) | undefined)?.(e);
      return e;
    };
    return { tree: m.tree, page, button, key };
  }

  it("is a quiet icon button after the row's own, named Hide from list, its key in its title", () => {
    const run = vi.fn();
    const { tree } = drawRow({ kind: "hide", run });
    const buttons = all(tree, e => e.type === "button");
    expect(buttons.map(b => b.props.className)).toEqual(["sl-row", "sl-row-act sl-row-hide"]);
    const act = buttons[1];
    expect(act.props["aria-label"]).toBe("Hide from list");
    expect(act.props.title).toBe("Hide from list (Delete)");
    // Not inside the row's button: the row's click and Enter stay what they were.
    expect(all(buttons[0], e => e.type === "button")).toHaveLength(1);
    const target = { id: "the act" };
    (act.props.onClick as (e: { currentTarget: unknown }) => void)({ currentTarget: target });
    expect(run).toHaveBeenCalledWith("d1", target);
  });

  it("says Show in list on a hidden row, which keeps its id out of the list's motion", () => {
    const { tree } = drawRow({ kind: "show", run: () => {} });
    const act = one(tree, e => e.props.className === "sl-row-act")!;
    expect(act.props["aria-label"]).toBe("Show in list");
    const item = one(tree, e => e.type === "li")!;
    expect(item.props["data-rail-id"]).toBeUndefined();
    expect(item.props["data-hidden-id"]).toBe("d1");
  });

  it("draws no act on a working row", () => {
    const { tree } = drawRow(undefined);
    expect(one(tree, e => typeof e.props.className === "string" && e.props.className.includes("sl-row-act"))).toBeNull();
  });

  it("hides a keyboard-focused row on Delete, and stops it there so the deck's Remove from board never hears it", () => {
    const run = vi.fn();
    const r = drawRow({ kind: "hide", run });
    r.button.focus();
    const e = r.key("Delete");
    expect(run).toHaveBeenCalledWith("d1", r.button);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(e.stopPropagation).toHaveBeenCalled();
  });

  it("leaves Delete to the deck on a row the mouse pressed (Remove from board, #1668), and on any held or repeated Delete", () => {
    const run = vi.fn();
    const r = drawRow({ kind: "hide", run });
    // CHANGED ON PURPOSE: the press comes first and the focus after it, as in
    // the page; the row reads how focus came when it arrives.
    r.page.keyboard = false;
    r.button.focus();
    expect(r.key("Delete").stopPropagation).not.toHaveBeenCalled();
    r.page.keyboard = true;
    r.button.focus();
    for (const extra of [{ shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { repeat: true }]) {
      expect(r.key("Delete", extra).stopPropagation).not.toHaveBeenCalled();
    }
    // Backspace is not Delete, here as on the deck.
    expect(r.key("Backspace").stopPropagation).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("still leaves Delete to the deck on a pressed row the browser calls :focus-visible once a key is down (Chromium)", () => {
    // Chromium turns a focused button :focus-visible as soon as a key is
    // pressed on it. Read at the keydown, that took the mouse's row for the
    // keyboard's, and Delete hid it instead of removing its card (#1668).
    const run = vi.fn();
    const r = drawRow({ kind: "hide", run });
    r.page.keyboard = false;
    r.button.focus();
    r.page.keyboard = true;
    expect(r.key("Delete").stopPropagation).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    // Gone and back by the keyboard, it is the keyboard's row again.
    (one(r.tree, e => e.props.className === "sl-row-in")!.props.onBlur as (ev: { target: unknown }) => void)({ target: r.button });
    r.button.focus();
    r.key("Delete");
    expect(run).toHaveBeenCalledWith("d1", r.button);
  });

  it("has no Delete of its own on a working row", () => {
    const r = drawRow(undefined);
    r.button.focus();
    expect(r.key("Delete").stopPropagation).not.toHaveBeenCalled();
    expect(hideOnDelete("busy", undefined)).toBeUndefined();
  });

  it("is stopped before the deck's listener, which hears keys on window as they bubble", () => {
    const shortcuts = readFileSync(fileURLToPath(new URL("../use-deck-shortcuts.ts", import.meta.url)), "utf8");
    expect(shortcuts).toContain('window.addEventListener("keydown", onKey);');
    expect(shortcuts).toContain('if (e.key === "Delete") removeSelectedRef.current();');
  });
});

describe("the Undo strip (HideUndo)", () => {
  function strip(open: boolean, name = "Fix the flaky test") {
    vi.stubGlobal("document", { activeElement: null });
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    const offer: ListHiddenOffer = { open, name, undo: vi.fn(), dismiss: vi.fn(), hold: vi.fn(), release: vi.fn() };
    const m = mount(HideUndo as (p: { offer: ListHiddenOffer }) => unknown, { offer });
    return { m, offer };
  }

  it("says what was hidden, in a polite region mounted before it speaks, with Undo beside it", () => {
    const { m, offer } = strip(true);
    const status = one(m.tree, e => e.props.role === "status")!;
    expect(textOf(status)).toBe("Fix the flaky test hidden from the list. Undo available.");
    expect(textOf(one(m.tree, e => e.props.className === "rearrange-undo-state"))).toBe("Fix the flaky test hidden from the list");
    const undo = one(m.tree, e => e.props.className === "rearrange-undo-act")!;
    expect(textOf(undo)).toBe("Undo");
    expect(undo.props["aria-describedby"]).toBe("sl-undo-state");
    (undo.props.onClick as () => void)();
    expect(offer.undo).toHaveBeenCalled();
  });

  it("keeps its region and says nothing while nothing is offered", () => {
    const { m } = strip(false, "");
    expect(textOf(one(m.tree, e => e.props.role === "status"))).toBe("");
    expect(one(m.tree, e => e.props.className === "rearrange-undo-act")).toBeNull();
  });

  it("waits while the pointer or focus is on it", () => {
    const { m, offer } = strip(true);
    const box = one(m.tree, e => typeof e.props.className === "string" && e.props.className.startsWith("rearrange-undo sl-undo"))!;
    (box.props.onPointerEnter as () => void)();
    (box.props.onFocus as () => void)();
    expect(offer.hold).toHaveBeenCalledWith("hover");
    expect(offer.hold).toHaveBeenCalledWith("focus");
  });
});

describe("its words", () => {
  const KEYS = ["board.list.hideRow", "board.list.showRow", "board.list.hiddenRow", "board.list.hiddenSaid", "board.list.hiddenCount"];

  it("are in every language, with the placeholders English has", () => {
    for (const { code, catalog } of LANGUAGES) {
      const c = catalog as Record<string, string>;
      for (const k of KEYS) {
        expect(c[k], `${code} ${k}`).toBeTruthy();
        expect(c[k].match(/\{\w+\}/g) ?? [], `${code} ${k}`).toEqual((LANGUAGES[0].catalog as Record<string, string>)[k].match(/\{\w+\}/g) ?? []);
      }
    }
  });

  it("read as the owner asked in English", () => {
    const en = LANGUAGES[0].catalog as Record<string, string>;
    expect(en["board.list.hideRow"]).toBe("Hide from list");
    expect(en["board.list.showRow"]).toBe("Show in list");
    expect(en["board.list.hiddenRow"]).toBe("{name} hidden from the list");
    expect(en["board.list.hiddenCount"]).toBe("Hidden · {n}");
  });
});
