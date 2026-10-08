// WCAG 2.1.4 Character Key Shortcuts, for the git view's keys: with Settings ›
// General's "Single-key shortcuts" off, `g` no longer opens the view from the
// canvas and `n` no longer reaches its newest diff from there, while Esc, a
// named key, still closes it. The view's own keys — f, 1 2 3, n, i, g, the
// arrows, Enter and Esc — are kept under 2.1.4's third option: they answer only
// while focus is inside the view (`data-key-scope="git"`), from the view's own
// handler, and never from the deck's window listener. What the switch does to
// the hints that name `g` is single-key-shortcuts-git-surfaces.test.ts's.
//
// The deck's handler runs through deck-keys-harness.ts, as
// single-key-shortcuts-keys.test.ts runs it.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), useEffect: (run: () => void) => { run(); } }));

const { BODY, mountDeckKeys } = await import("./deck-keys-harness");
const { setSingleKeyShortcuts } = await import("../single-key-shortcuts");
const { setGitViewNewest } = await import("../git-view-request");
const { viewKeyIntent } = await import("../git-view-keys");
const { historyKey } = await import("../git-graph-keys");
const { sourceOf } = await import("./client-source");

afterEach(() => {
  vi.unstubAllGlobals();
  setSingleKeyShortcuts(true);
  setGitViewNewest(null);
});

/** Every spy the deck's keys can reach, so "nothing happened" is one check. */
function reached(deck: ReturnType<typeof mountDeckKeys>): string[] {
  const props = deck.props as unknown as Record<string, unknown>;
  const spies = Object.entries(props).filter(([, v]) => typeof v === "function" && "mock" in (v as object));
  const refSpies = [["removeSelected", deck.props.removeSelectedRef.current], ["activateSound", deck.props.activateSoundRef.current]] as const;
  return [...spies, ...refSpies]
    .filter(([, spy]) => (spy as ReturnType<typeof vi.fn>).mock.calls.length > 0)
    .map(([name]) => name as string);
}

/** Focus inside the git view: an element under its `data-key-scope` root. */
const IN_VIEW = { tagName: "DIV", role: "option", inKeyScope: true };

const key = (k: string) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false });
const where = (pane: "graph" | "files" | "diff" | null, fork = false) => ({
  pane, typing: false, handled: false, control: false,
  ...(fork ? { fork: { sidebar: true, local: false, tab: "changes" as const } } : {}),
});

// ── the deck's keys ─────────────────────────────────────────────────────────

describe("with Single-key shortcuts off, the canvas's git keys do nothing", () => {
  it("leaves g and G on a selected card without opening the view", () => {
    const deck = mountDeckKeys({ singleKeys: false });
    deck.press("g");
    deck.press("G");
    expect(deck.props.toggleGitView).not.toHaveBeenCalled();
    expect(deck.gitView.value).toBe(false);
    expect(reached(deck)).toEqual([]);
  });

  it("leaves g from the canvas without closing a view that is open", () => {
    const deck = mountDeckKeys({ singleKeys: false });
    deck.gitView.value = true;
    deck.press("g", { target: BODY });
    expect(deck.gitView.value).toBe(true);
    expect(reached(deck)).toEqual([]);
  });

  it("leaves n from the canvas without reaching the open view's newest diff", () => {
    const newest = vi.fn();
    setGitViewNewest(newest);
    const deck = mountDeckKeys({ singleKeys: false });
    deck.gitView.value = true;
    deck.press("n");
    deck.press("N");
    expect(newest).not.toHaveBeenCalled();
  });

  it("still closes the open view on Esc, a named key", () => {
    const deck = mountDeckKeys({ singleKeys: false });
    deck.gitView.value = true;
    deck.press("Escape", { target: BODY });
    expect(deck.props.closeGitView).toHaveBeenCalledWith("key");
    expect(deck.gitView.value).toBe(false);
    expect(deck.props.clearSelection).not.toHaveBeenCalled();
  });
});

describe("with Single-key shortcuts on, the canvas's git keys work as before", () => {
  it("opens the view on g and closes it on the next g", () => {
    const deck = mountDeckKeys();
    deck.press("g");
    expect(deck.gitView.value).toBe(true);
    deck.press("G");
    expect(deck.gitView.value).toBe(false);
    expect(deck.props.toggleGitView).toHaveBeenCalledTimes(2);
  });

  it("reaches the open view's newest diff on n", () => {
    const newest = vi.fn();
    setGitViewNewest(newest);
    const deck = mountDeckKeys();
    deck.press("n");
    expect(newest).not.toHaveBeenCalled();
    deck.gitView.value = true;
    deck.press("n");
    expect(newest).toHaveBeenCalledTimes(1);
  });
});

// ── the view's own keys ─────────────────────────────────────────────────────

describe("the view's own keys, with Single-key shortcuts off", () => {
  it("still answer with focus inside the view: f, 1 2 3, n, g, the arrows, Enter and Esc", () => {
    setSingleKeyShortcuts(false);
    expect(viewKeyIntent(key("f"), where("graph"))).toEqual({ kind: "look" });
    expect(viewKeyIntent(key("F"), where("diff", true))).toEqual({ kind: "look" });
    expect(viewKeyIntent(key("1"), where("graph", true))).toEqual({ kind: "tab", index: 0 });
    expect(viewKeyIntent(key("2"), where("graph", true))).toEqual({ kind: "tab", index: 1 });
    expect(viewKeyIntent(key("3"), where("graph", true))).toEqual({ kind: "tab", index: 2 });
    expect(viewKeyIntent(key("n"), where("diff"))).toEqual({ kind: "newest" });
    expect(viewKeyIntent(key("g"), where("graph"))).toEqual({ kind: "close" });
    expect(viewKeyIntent(key("ArrowRight"), where("graph"))).toEqual({ kind: "focus", pane: "files" });
    expect(viewKeyIntent(key("Enter"), where("files"))).toEqual({ kind: "focus", pane: "diff" });
    expect(viewKeyIntent(key("Escape"), where("diff"))).toEqual({ kind: "focus", pane: "files" });
  });

  it("still take i on a history row to its agent's card", () => {
    setSingleKeyShortcuts(false);
    expect(historyKey({ key: "i", ctrlKey: false, metaKey: false, altKey: false }, 2, 10, 5)).toEqual({ kind: "card" });
  });

  it("are answered by the view's own handler alone, which never asks the switch", () => {
    const view = sourceOf("components/GitView.tsx");
    const handler = view.slice(view.indexOf("const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {"), view.indexOf("// Mounted on <body>"));
    expect(handler).toContain("viewKeyIntent(e, {");
    expect(handler).not.toMatch(/characterKeyMuted|singleKeyShortcutsOn|useSingleKeyShortcuts/);
    expect(sourceOf("git-view-keys.ts")).not.toMatch(/single-key-shortcuts/);
  });
});

describe("the view's own keys answer only while focus is inside it", () => {
  it("are on the view's root, which carries the key scope, and never on window or document", () => {
    const view = sourceOf("components/GitView.tsx");
    expect(view).toMatch(/data-key-scope="git"[\s\S]{0,300}?onKeyDown=\{onKeyDown\}/);
    expect(view).not.toMatch(/addEventListener\("key(?:down|up)"/);
    // The history's two document-level listeners: Esc taking a hover card
    // away, a named key, and a flag for "a key was pressed in here" that does
    // nothing itself.
    const graph = sourceOf("components/GitGraph.tsx");
    expect(graph.match(/addEventListener\("keydown"/g)).toHaveLength(2);
    expect(sourceOf("git-graph-keys.ts")).toMatch(/return e\.key === "Escape" && !isBrowserChord\(e\);/);
    expect(graph).toMatch(/if \(!dismissesCard\(e\) \|\| e\.defaultPrevented\) return;/);
    expect(graph).toMatch(/if \(!scope \|\| !\(e\.target instanceof Node\) \|\| !scope\.contains\(e\.target\)\) return;\s*keyed\.current = true;/);
  });

  it("reach nothing on the canvas from inside the view, whichever way the switch is set", () => {
    for (const singleKeys of [true, false]) {
      const deck = mountDeckKeys({ singleKeys });
      deck.gitView.value = true;
      for (const k of ["f", "F", "1", "2", "3", "n", "i", "g", "r", "R", "c", " "]) deck.press(k, { target: IN_VIEW });
      expect(reached(deck), `switch ${singleKeys ? "on" : "off"}`).toEqual([]);
      expect(deck.gitView.value).toBe(true);
    }
  });

  it("are not the view's from the canvas: f there is the deck's fit with the switch on, and nothing with it off", () => {
    const on = mountDeckKeys();
    on.gitView.value = true;
    on.press("f", { target: BODY });
    expect(reached(on)).toEqual(["handleFit"]);
    const off = mountDeckKeys({ singleKeys: false });
    off.gitView.value = true;
    for (const k of ["f", "1", "2", "3", "i"]) off.press(k, { target: BODY });
    expect(reached(off)).toEqual([]);
  });
});
