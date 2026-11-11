// Quick open (⌘K on a Mac, Ctrl+K elsewhere): what the field finds and in what
// order, what it remembers, the chord through the deck's one keydown handler,
// and that every row runs the press its door, setting or action already had.
// How it looks and moves is checked in a browser; this holds the rules.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QuickItem } from "../quick-open";
import type { RailItem } from "../components/EdgeRails";
import type { RailItems } from "../rail-items";
import type { Row } from "../components/SessionList";
import type { AgentNodeData } from "../types";

vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), useEffect: (run: () => void) => { run(); } }));

const { mountDeckKeys } = await import("./deck-keys-harness");
const { modalStack } = await import("../modal-dismiss");
const {
  EMPTY_SESSIONS, RECENT_KEY, SECTION_CAP, flatGroupRows, fuzzyMatch, groupQuick, isQuickOpenChord, quickOpenChordLabel,
  rankQuick, readRecent, rememberRecent, stepRow, withRecent,
} = await import("../quick-open");
const { quickOpenItems, sessionLine, startFolder } = await import("../quick-open-items");
const { indexFor } = await import("../settings-search");
const { openedAt, SETTINGS_CLOSED } = await import("../settings");
const { keyHelpFor } = await import("../key-help");
const { sourceOf } = await import("./client-source");

afterEach(() => { vi.unstubAllGlobals(); });

const noop = () => {};

function item(id: string, section: QuickItem["section"], title: string, extra: Partial<QuickItem> = {}): QuickItem {
  return { id, section, title, tag: "Tag", verb: "Open", run: noop, ...extra };
}

// ── matching ────────────────────────────────────────────────────────────────

describe("what a few letters find", () => {
  it("puts a run at the start of the title ahead of the same run later in it", () => {
    expect(fuzzyMatch("set", "Settings")!.score).toBeGreaterThan(fuzzyMatch("set", "Data settings")!.score);
    expect(fuzzyMatch("set", "Data settings")!.score).toBeGreaterThan(fuzzyMatch("set", "Reset calendar")!.score);
    expect(fuzzyMatch("usage", "Usage")!.score).toBeGreaterThan(fuzzyMatch("usage", "Usage history")!.score);
    expect(fuzzyMatch("USA", "usage")?.hits).toEqual([0, 1, 2]);
  });

  it("reads initials, taking each letter at the start of a word where it can", () => {
    expect(fuzzyMatch("ta", "Tool activity")?.hits).toEqual([0, 5]);
    expect(fuzzyMatch("rb", "Rider Black")?.hits).toEqual([0, 6]);
    expect(fuzzyMatch("rid bl", "Rider Black")?.hits).toEqual([0, 1, 2, 6, 7]);
  });

  it("finds nothing when the letters are not there in order", () => {
    expect(fuzzyMatch("zq", "Usage")).toBeNull();
    expect(fuzzyMatch("egasu", "Usage")).toBeNull();
  });

  it("does not scatter letters that start no word: the first must start one", () => {
    expect(fuzzyMatch("us", "Claude accounts")).toBeNull();
    expect(fuzzyMatch("ca", "Claude accounts")?.hits).toEqual([0, 7]);
  });
});

// ── the list ────────────────────────────────────────────────────────────────

describe("the list an empty field shows", () => {
  const sessions = Array.from({ length: 7 }, (_, n) => item(`session:${n}`, "sessions", `session ${n}`));
  const items = [
    ...sessions,
    item("door:usage", "open", "Usage"),
    item("settings:section:sounds", "settings", "Sounds"),
    item("settings:text-size", "settings", "Text size", { queryOnly: true }),
    item("action:fit", "actions", "Fit every agent on screen"),
    item("theme:rider-black", "themes", "Rider Black", { queryOnly: true }),
  ];

  it("is the map of the deck: the first sessions, the doors, Settings' sections and the actions", () => {
    const list = rankQuick(items, "");
    expect(list.map(s => s.section)).toEqual(["sessions", "open", "settings", "actions"]);
    expect(list[0].items).toHaveLength(EMPTY_SESSIONS);
    expect(list.flatMap(s => s.items.map(r => r.item.id))).not.toContain("settings:text-size");
    expect(list.flatMap(s => s.items.map(r => r.item.id))).not.toContain("theme:rider-black");
  });

  it("opens with what was opened last, a theme or a setting among them, and lists none of it twice", () => {
    const list = rankQuick(items, "", ["door:usage", "gone:since", "theme:rider-black"]);
    expect(list[0].section).toBe("recent");
    expect(list[0].items.map(r => r.item.id)).toEqual(["door:usage", "theme:rider-black"]);
    expect(list.find(s => s.section === "open")).toBeUndefined();
  });
});

// Design recommendations (2026-11-09): V4 keeps Settings behind a cog at the
// foot of the left stripe, so an empty field names it, with its chord, on its
// own after the sessions. It is never the row Enter runs on an empty field:
// that stays the first session (the one waiting) or what was opened last.
describe("Settings, listed on its own in an empty field", () => {
  const settings = item("door:settings", "open", "Settings", { pinned: true, keyCap: "Ctrl+,", tag: "Dialog" });
  const waiting = item("session:w", "sessions", "web-api", { tone: "waiting" });
  const working = item("session:k", "sessions", "docs-site", { tone: "working" });
  const doors = [item("door:usage", "open", "Usage"), settings];
  const actions = [item("action:fit", "actions", "Fit every agent on screen")];
  const empty = (items: QuickItem[], recent: string[] = []) => groupQuick(rankQuick(items, "", recent), false);
  const ids = (groups: ReturnType<typeof empty>) => groups.map(g => [g.group, g.items.map(r => r.item.id)]);

  it("follows the sessions, in a group of its own with no caption, and leaves the doors", () => {
    const groups = empty([waiting, working, ...doors, ...actions]);
    expect(ids(groups)).toEqual([
      ["needs", ["session:w"]],
      ["sessions", ["session:k"]],
      ["pinned", ["door:settings"]],
      ["do", ["action:fit"]],
      ["open", ["door:usage"]],
    ]);
    const pinned = groups.find(g => g.group === "pinned")!;
    expect(pinned.title).toBe("");
    expect(pinned.items[0].item.keyCap).toBe("Ctrl+,");
  });

  it("leaves the chosen row where it was: the first session, or what was opened last", () => {
    const before = (items: QuickItem[], recent: string[] = []) =>
      flatGroupRows(empty(items.map(i => ({ ...i, pinned: undefined })), recent))[0].item.id;
    const now = (items: QuickItem[], recent: string[] = []) => flatGroupRows(empty(items, recent))[0].item.id;
    for (const [items, recent] of [
      [[waiting, working, ...doors, ...actions], []],
      [[working, ...doors, ...actions], []],
      [[waiting, working, ...doors, ...actions], ["door:usage"]],
      [[...doors, ...actions], []],
      [[settings], []],
    ] as Array<[QuickItem[], string[]]>) {
      expect(now(items, recent)).toBe(before(items, recent));
    }
    expect(now([waiting, working, ...doors, ...actions])).toBe("session:w");
  });

  it("is never the first row, even with no session and nothing opened lately", () => {
    const groups = empty([...doors, ...actions]);
    expect(groups.map(g => g.group)).toEqual(["do", "pinned", "open"]);
    expect(flatGroupRows(groups)[0].item.id).toBe("action:fit");
  });

  it("is listed once: in Recent when it was opened lately, and ranked like any row once something is typed", () => {
    const recent = empty([waiting, ...doors, ...actions], ["door:settings"]);
    expect(ids(recent)[0]).toEqual(["recent", ["door:settings"]]);
    expect(recent.find(g => g.group === "pinned")).toBeUndefined();
    const typed = rankQuick([waiting, ...doors, ...actions], "sett");
    expect(typed.map(s => [s.section, s.items.map(r => r.item.id)])).toEqual([["open", ["door:settings"]]]);
  });
});

describe("the list a query shows", () => {
  it("puts the section with the best answer first, whatever kind it is", () => {
    const list = rankQuick([item("session:a", "sessions", "Bus fix"), item("door:usage", "open", "Usage")], "us");
    expect(list.map(s => s.section)).toEqual(["open", "sessions"]);
  });

  it("finds a door by a word it does not print, from the start of that word, with nothing marked", () => {
    const usage = item("door:usage", "open", "Usage", { keywords: ["cost", "spend"] });
    expect(rankQuick([usage], "cost")[0].items[0]).toEqual({ item: usage, hits: [] });
    expect(rankQuick([usage], "ost")).toEqual([]);
  });

  it("lists the themes and the single settings once something is typed", () => {
    const list = rankQuick([item("theme:rider-black", "themes", "Rider Black", { queryOnly: true })], "rider");
    expect(list[0].items[0].item.id).toBe("theme:rider-black");
  });

  it("keeps one long section from pushing every other answer out of the window", () => {
    const many = Array.from({ length: 20 }, (_, n) => item(`settings:${n}`, "settings", `Sound ${n}`));
    expect(rankQuick(many, "sound")[0].items).toHaveLength(SECTION_CAP);
  });
});

describe("the arrows", () => {
  it("wrap at both ends and start at the end they point to", () => {
    expect(stepRow(-1, 3, 1)).toBe(0);
    expect(stepRow(-1, 3, -1)).toBe(2);
    expect(stepRow(2, 3, 1)).toBe(0);
    expect(stepRow(0, 3, -1)).toBe(2);
    expect(stepRow(0, 0, 1)).toBe(-1);
  });
});

describe("what it remembers", () => {
  it("keeps the last five, newest first, each once", () => {
    expect(withRecent(["a", "b", "c", "d", "e"], "c")).toEqual(["c", "a", "b", "d", "e"]);
    expect(withRecent(["a", "b", "c", "d", "e"], "f")).toEqual(["f", "a", "b", "c", "d"]);
  });

  it("survives a store that holds something else, and one that refuses", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } } });
    rememberRecent("door:usage");
    rememberRecent("theme:gruvbox-dark");
    expect(readRecent()).toEqual(["theme:gruvbox-dark", "door:usage"]);
    store.set(RECENT_KEY, "{not json");
    expect(readRecent()).toEqual([]);
    store.set(RECENT_KEY, JSON.stringify(["door:usage", 4, null]));
    expect(readRecent()).toEqual(["door:usage"]);
    vi.stubGlobal("window", { get localStorage(): Storage { throw new Error("SecurityError"); } });
    expect(readRecent()).toEqual([]);
    expect(() => rememberRecent("door:usage")).not.toThrow();
  });
});

// ── the chord ───────────────────────────────────────────────────────────────

const chord = (o: Partial<{ key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }>) =>
  ({ key: "k", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o });

describe("the chord", () => {
  it("is ⌘K on a Mac, where Ctrl+K belongs to the text field, and Ctrl+K elsewhere", () => {
    expect(isQuickOpenChord(chord({ metaKey: true }), true)).toBe(true);
    expect(isQuickOpenChord(chord({ ctrlKey: true }), true)).toBe(false);
    expect(isQuickOpenChord(chord({ ctrlKey: true }), false)).toBe(true);
    expect(isQuickOpenChord(chord({ metaKey: true }), false)).toBe(false);
    expect(isQuickOpenChord(chord({ ctrlKey: true, shiftKey: true }), false)).toBe(false);
    expect(isQuickOpenChord(chord({ ctrlKey: true, altKey: true }), false)).toBe(false);
    expect(isQuickOpenChord(chord({ key: "K", ctrlKey: true }), false)).toBe(true);
    // A layout with no Latin letters still has the key where K is.
    expect(isQuickOpenChord(chord({ key: "л", code: "KeyK", ctrlKey: true }), false)).toBe(true);
    expect(quickOpenChordLabel(true)).toBe("⌘K");
    expect(quickOpenChordLabel(false)).toBe("Ctrl+K");
  });

  it("opens the field from the canvas and from a field, once for a held chord", () => {
    vi.stubGlobal("navigator", { platform: "Linux x86_64" });
    const deck = mountDeckKeys();
    expect(deck.press("k", { ctrlKey: true }).preventDefault).toHaveBeenCalled();
    deck.press("k", { ctrlKey: true, repeat: true });
    deck.press("k", { ctrlKey: true, target: { tagName: "INPUT", type: "text" } });
    expect(deck.props.openQuickOpen).toHaveBeenCalledTimes(2);
  });

  it("answers with the single-key shortcuts off, and the bare letter stays the canvas's", () => {
    vi.stubGlobal("navigator", { platform: "Linux x86_64" });
    const deck = mountDeckKeys({ singleKeys: false });
    deck.press("k", { ctrlKey: true });
    expect(deck.props.openQuickOpen).toHaveBeenCalledTimes(1);
    const on = mountDeckKeys();
    on.press("k");
    expect(on.props.openQuickOpen).not.toHaveBeenCalled();
  });

  it("opens nothing behind a dialog, and leaves the browser the keystroke there", () => {
    vi.stubGlobal("navigator", { platform: "Linux x86_64" });
    const deck = mountDeckKeys();
    const closeDialog = modalStack.push(noop);
    try {
      expect(deck.press("k", { ctrlKey: true }).preventDefault).not.toHaveBeenCalled();
    } finally {
      closeDialog();
    }
    expect(deck.props.openQuickOpen).not.toHaveBeenCalled();
  });

  it("is ⌘K on a Mac, and Ctrl+K there is the field's", () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    const deck = mountDeckKeys();
    deck.press("k", { ctrlKey: true, target: { tagName: "INPUT", type: "text" } });
    expect(deck.props.openQuickOpen).not.toHaveBeenCalled();
    deck.press("k", { metaKey: true });
    expect(deck.props.openQuickOpen).toHaveBeenCalledTimes(1);
  });

  it("is on the shortcuts sheet, and stays there with the letters off as the one way to the panels", () => {
    const row = keyHelpFor(true).flatMap(g => g.rows).find(r => r.cap === "Ctrl + K");
    expect(row).toMatchObject({ macCap: "⌘ K", chord: true });
    // CHANGED ON PURPOSE (V4's Figma): Quick open is still alone in the panels group with the letters off, which V4 names Panels.
    expect(keyHelpFor(false).find(g => g.title === "Panels")?.rows.map(r => r.cap)).toEqual(["Ctrl + K"]);
  });
});

// ── what each row runs ──────────────────────────────────────────────────────

function door(id: string, extra: Partial<RailItem> = {}): RailItem {
  return { id, label: id, short: id, ariaLabel: id, glyph: null, kind: "panel", onPress: vi.fn(), ...extra };
}

function sources(extra: Partial<Parameters<typeof quickOpenItems>[0]> = {}) {
  const rails = {
    left: [door("session-list", { label: "Sessions", key: { cap: "L", aria: "L", single: true }, open: true })],
    leftStripe: [],
    capacity: [door("account-capacity", { label: "Capacity", kind: "dialog" })],
    right: [[door("usage", { label: "Usage", key: { cap: "U", aria: "U", single: true } })]],
    integrations: [],
    explore: [],
    utilities: [
      door("settings", { label: "Settings", kind: "dialog", key: { cap: "Ctrl+,", aria: "Control+,", single: false } }),
      door("feedback", { label: "Feedback", menu: "Send feedback", kind: "dialog" }),
    ],
    search: door("quick-open", { label: "Search", kind: "dialog" }),
  } as unknown as RailItems;
  const src = {
    rails,
    sessions: [] as Row[],
    openSession: vi.fn(),
    settings: indexFor(true),
    openSettings: vi.fn(),
    singleKeys: true,
    fit: vi.fn(), rearrange: vi.fn(), paused: false, togglePause: vi.fn(),
    keyHelp: vi.fn(), tour: vi.fn(), theme: "rider-black" as const, setTheme: vi.fn(),
    ...extra,
  };
  return { src, rails, items: quickOpenItems(src) };
}

const byId = (items: QuickItem[], id: string) => items.find(i => i.id === id);

describe("the rows the deck offers", () => {
  it("are the stripes' own doors, each running the press its button runs, and not the field itself", () => {
    const { rails, items } = sources();
    expect(byId(items, "door:session-list")).toMatchObject({ title: "Sessions", tag: "Shown", verb: "Hide panel", keyCap: "L" });
    expect(byId(items, "door:usage")).toMatchObject({ tag: "Panel", verb: "Show panel", keyCap: "U" });
    expect(byId(items, "door:feedback")).toMatchObject({ title: "Send feedback", tag: "Dialog", verb: "Open" });
    expect(byId(items, "door:usage")?.run).toBe(rails.right[0][0].onPress);
    expect(byId(items, "door:quick-open")).toBeUndefined();
  });

  it("print only the keys that work: no letters with the single-key shortcuts off, the chords still", () => {
    const { items } = sources({ singleKeys: false });
    expect(byId(items, "door:usage")?.keyCap).toBeUndefined();
    expect(byId(items, "action:fit")?.keyCap).toBeUndefined();
    expect(byId(items, "door:settings")?.keyCap).toBe("Ctrl+,");
  });

  it("pin Settings, and only Settings, for an empty field", () => {
    const { items } = sources();
    expect(items.filter(i => i.pinned).map(i => i.id)).toEqual(["door:settings"]);
  });

  it("open Settings at a section, or land on the one setting that was asked for", () => {
    const { src, items } = sources();
    byId(items, "settings:section:sounds")!.run();
    expect(src.openSettings).toHaveBeenLastCalledWith("sounds");
    expect(byId(items, "settings:section:sounds")?.queryOnly).toBeUndefined();
    const textSize = byId(items, "settings:text-size")!;
    expect(textSize).toMatchObject({ title: "Text size", subtitle: "Text & density", tag: "Setting", queryOnly: true });
    textSize.run();
    expect(src.openSettings).toHaveBeenLastCalledWith("reading", "text-size");
  });

  it("offer the thing rather than the button in Settings that opens it", () => {
    const ids = sources().items.map(i => i.id);
    for (const id of ["settings:accounts", "settings:browser-watch", "settings:radar-open", "settings:tour", "settings:feedback"]) {
      expect(ids).not.toContain(id);
    }
    expect(ids.filter(id => id.startsWith("settings:theme"))).toEqual(["settings:theme"]);
  });

  it("follow the Settings a deck draws: no Claude Code or Integrations where there is none", () => {
    const ids = sources({ settings: indexFor(false, "none") }).items.map(i => i.id);
    expect(ids).not.toContain("settings:section:claude");
    expect(ids).not.toContain("settings:section:integrations");
    expect(ids).toContain("settings:section:sounds");
  });

  it("list every theme for a query, the one in use said as such", () => {
    const { src, items } = sources();
    const themes = items.filter(i => i.section === "themes");
    expect(themes.length).toBeGreaterThan(5);
    expect(themes.every(t => t.queryOnly)).toBe(true);
    expect(byId(items, "theme:rider-black")?.tag).toBe("Current");
    byId(items, "theme:gruvbox-dark")!.run();
    expect(src.setTheme).toHaveBeenCalledWith("gruvbox-dark");
  });

  it("offer Clear only while there is something to clear, and say that it asks first", () => {
    expect(byId(sources().items, "action:clear")).toBeUndefined();
    const clear = vi.fn();
    expect(byId(sources({ clear }).items, "action:clear")).toMatchObject({ subtitle: "Asks first", verb: "Ask first", run: clear });
  });

  it("offer Next waiting as Do's first row while someone waits, on N's cap, running N's move", () => {
    expect(byId(sources().items, "action:next-waiting")).toBeUndefined();
    const nextWaiting = vi.fn();
    const { items } = sources({ nextWaiting });
    expect(byId(items, "action:next-waiting")).toMatchObject({ title: "Next waiting", subtitle: "the longest wait first", keyCap: "n", run: nextWaiting });
    expect(items.filter(i => i.section === "actions")[0].id).toBe("action:next-waiting");
    expect(byId(sources({ nextWaiting, singleKeys: false }).items, "action:next-waiting")?.keyCap).toBeUndefined();
    expect(sourceOf("App.tsx")).toContain("stepWaiting(stateRef.current, waitingCursorRef, focusSessionOnView)");
    expect(sourceOf("use-deck-shortcuts.ts")).toContain("stepWaiting(stateRef.current, waitingCursorRef, focusSession, e.shiftKey)");
  });

  it("offer a new Claude and a new Codex in the focused folder only where the deck can start one", () => {
    expect(sources().items.filter(i => i.section === "start")).toEqual([]);
    const launch = vi.fn();
    const { items } = sources({ start: { folder: { cwd: "/home/me/work/web-api", name: "web-api" }, launch } });
    const start = items.filter(i => i.section === "start");
    expect(start.map(i => [i.title, i.subtitle])).toEqual([
      ["New Claude session", "in web-api, ~/work/web-api"],
      ["New Codex session", "in web-api, ~/work/web-api"],
    ]);
    start[1].run();
    expect(launch).toHaveBeenCalledWith("codex", "/home/me/work/web-api");
    const app = sourceOf("App.tsx");
    expect(app).toMatch(/const quickStart = \(\) => \{\s*if \(!stage\.enabled\) return undefined;/);
    expect(app).toContain("folder ? { folder, launch: stage.launch } : undefined");
  });

  it("pick the Start folder as the New session popover does: the focused session's, else the latest", () => {
    const root = (sessionId: string, cwd: string, at: number) => ({ id: sessionId, sessionId, kind: "root", cwd, startedAt: at }) as unknown as AgentNodeData;
    const agents = [root("a", "/home/me/work/web-api", 10), root("b", "/home/me/work/infra", 20), root("c", "relative/path", 30)];
    expect(startFolder(agents, null)).toEqual({ cwd: "/home/me/work/infra", name: "infra" });
    expect(startFolder(agents, "a")).toEqual({ cwd: "/home/me/work/web-api", name: "web-api" });
    expect(startFolder([], null)).toBeNull();
    expect(startFolder([root("r", "relative/path", 1)], "r")).toBeNull();
    expect(startFolder([root("w", "C:\\Users\\me\\proj", 1)], null)).toEqual({ cwd: "C:\\Users\\me\\proj", name: "proj" });
  });

  it("say Pause or Resume as the stream stands", () => {
    expect(byId(sources().items, "action:pause")?.title).toBe("Pause the stream");
    expect(byId(sources({ paused: true }).items, "action:pause")?.title).toBe("Resume the stream");
  });
});

// CHANGED ON PURPOSE (owner's critique, 2026-11-11): the line said the ask, the
// turn's time or the summary, then the folder. A session is named one way on
// every surface now: its title, then folder · task (rail-row-copy.ts namesLine),
// and when it started with its id's tail in the hover.
describe("a session's line", () => {
  const row = (o: Partial<Row>) => ({ state: "active" as const, label: "fix login", sessionId: "s1", waiting: null, startedAt: 0, ...o }) as Row;

  it("says folder · task under a title of its own, the task alone under a title that is the folder", () => {
    expect(sessionLine(row({ folder: "api", task: "rotate the deploy keys" }))).toEqual({ line: "api · rotate the deploy keys", tone: "working" });
    expect(sessionLine(row({ label: "api", task: "rotate the deploy keys" })).line).toBe("rotate the deploy keys");
    expect(sessionLine(row({ folder: "api" })).line).toBe("api");
  });

  it("has no line when there is neither, and keeps the rail's glyph as its tone", () => {
    expect(sessionLine(row({ label: "api" })).line).toBe("");
    expect(sessionLine(row({ neverPrompted: true })).tone).toBe("idle");
    expect(sessionLine(row({ state: "err" })).tone).toBe("error");
    expect(sessionLine(row({ waiting: { kind: "permission", since: 1 } as Row["waiting"] })).tone).toBe("waiting");
  });

  it("puts the line under the title, and when it started in the hover, never on the row", () => {
    const hover = "Started 14:32 · 4efa";
    const items = sources({ sessions: [row({ folder: "api", task: "rotate the deploy keys", hover })] }).items;
    const item = items.find(i => i.title === "fix login")!;
    expect(item.subtitle).toBe("api · rotate the deploy keys");
    expect(item.hint).toBe(hover);
    expect(JSON.stringify({ title: item.title, subtitle: item.subtitle })).not.toContain("4efa");
    const bare = sources({ sessions: [row({ label: "api" })] }).items.find(i => i.title === "api")!;
    expect(bare).not.toHaveProperty("subtitle");
  });
});

// ── where it is wired ───────────────────────────────────────────────────────

describe("where the deck draws it", () => {
  it("is a door on the bar ahead of Settings, and the first row under the phone's More", () => {
    const app = sourceOf("App.tsx");
    // CHANGED ON PURPOSE (V4): Search ends the bar's end group; Feedback has
    // the corner cell after it.
    expect(app).toContain("<UtilityRun items={[rails.search]} />");
    expect(app).toMatch(/more=\{\[rails\.search, /);
    expect(app).toMatch(/\{quickOpenOpen && \(\s*<QuickOpen /);
  });

  it("asks for its chord ahead of Settings', so the two never compete", () => {
    const keys = sourceOf("use-deck-shortcuts.ts");
    expect(keys.indexOf("isQuickOpenChord(e")).toBeGreaterThan(0);
    expect(keys.indexOf("isQuickOpenChord(e")).toBeLessThan(keys.indexOf('e.key === "," && isSettingsChord(e)'));
  });

  it("keeps focus in the field and names the chosen row to a screen reader", () => {
    const view = sourceOf("components/QuickOpen.tsx");
    expect(view).toContain("useModalDismiss(leave, { focusRef: inputRef })");
    expect(view).toMatch(/role="combobox"[\s\S]*aria-activedescendant=/);
    expect(view).toMatch(/role="listbox"/);
  });

  it("lands Settings on the setting a door named, once", () => {
    expect(openedAt(SETTINGS_CLOSED, "reading", "text-size")).toStrictEqual({ open: true, section: "reading", landOn: "text-size" });
    expect(openedAt({ open: false, section: "reading", landOn: "text-size" })).toStrictEqual({ open: true, section: "reading" });
    expect(sourceOf("components/SettingsModal.tsx")).toContain("useEffect(() => { if (landOn) jumpTo(landOn); }, [landOn, jumpTo]);");
  });
});
