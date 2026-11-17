// V4 top-10 #5: stop showing machinery the reader does not need right now.
//
// Four surfaces. The top bar draws a count only while it counts something. The
// Sessions panel lost its "Nobody's waiting · 5 working" line and each row's
// model. The status bar names a key only until it has been used three times
// from the keyboard in this browser, and then keeps one quiet "? Keys", the
// door to the keyboard sheet; the pane's way out is named for as long as focus
// is in the pane. The canvas bar keeps the view's controls and one ⋯, whose
// menu is v4-quiet-chrome-menu.test.ts's; the handler's counting is
// v4-quiet-chrome-keys.test.ts's.
//
// Rendered wherever a part can be drawn on its own; the store is a stubbed
// window.localStorage, and a reload is the module loaded again over it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { sourceOf } from "./client-source";
import { BoardEmptyContext } from "../board-empty";
import { CountPill, ReadoutGroup, WaitingStat } from "../components/TopbarReadouts";
import { en } from "../i18n/en";
import { KEY_USES_KEY } from "../storage";

const noop = () => {};
afterEach(() => { vi.unstubAllGlobals(); });

/** `part` drawn on a board that has sessions (empty false) or none. */
const onBoard = (part: ReactElement, empty = false) =>
  renderToStaticMarkup(createElement(BoardEmptyContext.Provider, { value: empty }, part));

// ── 1. the top bar's counts ─────────────────────────────────────────────────

describe("the top bar's counts: a zero is not drawn", () => {
  const readouts = (over: Record<string, unknown>) => onBoard(createElement(ReadoutGroup, {
    versionCheck: { version: "1.0.0", notice: null, noticeOpen: false, showNotice: noop, versionChecking: false, loadVersion: noop },
    welcome: { chipVersion: null, openReleaseNotes: noop },
    desktopUpdate: { readyAppUpdate: null },
    pause: { paused: false, pauseGate: { size: 0, dropped: 0 } },
    announcements: { blockedSaid: "", watchSaid: "", incidentSaid: "" },
    notify: { notifySaid: null },
    waitingSessions: [],
    waitingCursorRef: { current: null },
    focusSession: noop,
    live: true,
    now: 1_790_550_000_000,
    incidents: [],
    counts: { working: 0, done: 0 },
    children: createElement("div", { className: "actions" }, "search-field"),
    ...over,
  } as unknown as Parameters<typeof ReadoutGroup>[0]));
  const asking = [{ id: "s1", label: "api", waiting: { kind: "permission", since: 1_790_549_990_000, message: "ok?" } }];

  it("draws a working or done count at zero as nothing, and any other count as before", () => {
    expect(renderToStaticMarkup(createElement(CountPill, { kind: "done", count: 0, glyph: null, word: "done" }))).toBe("");
    expect(renderToStaticMarkup(createElement(CountPill, { kind: "working", count: 2, glyph: null, word: "working" })))
      .toBe('<span class="count-pill count-working"><b>2</b><span class="count-word">working</span></span>');
  });

  it("draws no waiting pill while nothing waits", () => {
    expect(renderToStaticMarkup(createElement(WaitingStat, {
      waitingSessions: [], waitingCursorRef: { current: null }, focusSession: noop, now: 0,
    }))).toBe("");
  });

  it("draws nothing there at all while all three are zero, and no gap is kept for them", () => {
    const html = readouts({});
    expect(html).not.toContain('class="counts"');
    expect(html).not.toContain("count-pill");
    expect(html).toContain("<h1>ccdeck</h1>");
    expect(html).toContain("search-field");
  });

  it("brings back only the counts that count something", () => {
    const working = readouts({ counts: { working: 2, done: 0 } });
    expect(working.match(/class="count-pill /g)).toHaveLength(1);
    expect(working).toContain("count-working");
    expect(working).not.toContain("count-done");
    expect(working).not.toContain("waiting-stat");
  });

  it("keeps the waiting pill's press and its name when somebody waits", () => {
    const html = readouts({ waitingSessions: asking });
    expect(html).toMatch(/<button type="button" id="[^"]+" class="count-pill waiting-stat"/);
    expect(html).toContain('aria-label="1 session waiting for you"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-keyshortcuts="W"');
  });
});

// ── 2. the Sessions panel ───────────────────────────────────────────────────

describe("the Sessions panel: no summary line, a title free of model metadata", () => {
  // Drawn in v4-rail.test.ts ("Nobody’s waiting"): the line is gone over a calm
  // board and Working still counts its rows; a row with a model names none.
  it("draws neither, and keeps the group headings' counts and the Order held overlay", () => {
    const list = sourceOf("components/SessionList.tsx");
    const parts = sourceOf("components/RailParts.tsx");
    expect(list).not.toMatch(/sl-nobody|nobodyWaiting/);
    // CHANGED ON PURPOSE (#2591): the model is back on the row, below the
    // title; only the title's own line stays free of it.
    expect(parts.split('className="sl-line1"')[1].split('{lined &&')[0]).not.toMatch(/sl-model|modelChip/);
    expect(parts).toContain("sl-group-count");
    expect(list).toContain('<div className="sl-held"><PauseGlyph /><span>{heldLine(moves)}</span></div>');
    expect(Object.keys(en).filter(k => k.startsWith("board.rail.nobodyWaiting"))).toEqual([]);
  });
});

// ── 3. the status bar's keys, until learned ─────────────────────────────────

let stored: Record<string, string> = {};
/** A browser whose store holds `seed`, or refuses every read and write. */
function browser(seed: Record<string, string> = {}, refuses = false) {
  stored = { ...seed };
  const store = refuses
    ? { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: noop }
    : {
        getItem: (k: string) => stored[k] ?? null,
        setItem: (k: string, v: string) => { stored[k] = v; },
        removeItem: (k: string) => { delete stored[k]; },
      };
  vi.stubGlobal("window", { localStorage: store, addEventListener: noop, removeEventListener: noop, dispatchEvent: () => true });
}
/** The deck loaded fresh over that store: what a reload reads. */
async function load(seed: Record<string, string> = {}, refuses = false) {
  browser(seed, refuses);
  vi.resetModules();
  const learning = await import("../key-learning");
  const hints = await import("../status-hints");
  const { default: StatusBar } = await import("../components/StatusBar");
  const { BoardEmptyContext: Empty } = await import("../board-empty");
  const draw = (props: Record<string, unknown>, empty = false) => renderToStaticMarkup(createElement(Empty.Provider, { value: empty },
    createElement(StatusBar, { stageOpen: false, zoomedOut: true, ...props } as never)));
  return { ...learning, ...hints, draw };
}
const ALL = JSON.stringify({ cards: 3, select: 3, peek: 3, nextWaiting: 3, pause: 3, sessions: 3, openAndType: 3, view: 3 });
const board = (h: Awaited<ReturnType<typeof load>>, over: Record<string, unknown> = {}) =>
  h.statusViewFor({ stageOpen: false, pane: null, onCard: false, zoomedOut: true, singleKeys: true, platform: "linux", ...over });

describe("a key is learned after three uses from the keyboard, per browser", () => {
  it("is named until its third use, and the count is one JSON key of counts by hint", async () => {
    const h = await load();
    h.noteKeyUse("cards");
    h.noteKeyUse("cards");
    expect(h.isLearned("cards")).toBe(false);
    expect(h.unlearnedView(board(h), h.keyUses()).hints.map(x => x.learn)).toContain("cards");
    h.noteKeyUse("cards");
    expect(h.LEARNED_AFTER).toBe(3);
    expect(h.isLearned("cards")).toBe(true);
    expect(JSON.parse(stored[KEY_USES_KEY])).toEqual({ cards: 3 });
    expect(h.unlearnedView(board(h), h.keyUses()).hints.map(x => x.learn)).not.toContain("cards");
    // The other keys are still named.
    expect(h.isLearned("pause")).toBe(false);
  });

  it("writes nothing more once learned", async () => {
    const h = await load({ [KEY_USES_KEY]: JSON.stringify({ pause: 3 }) });
    const before = stored[KEY_USES_KEY];
    h.noteKeyUse("pause");
    expect(stored[KEY_USES_KEY]).toBe(before);
  });

  it("stays learned after a reload: the hint does not come back", async () => {
    let h = await load();
    for (let i = 0; i < 3; i++) h.noteKeyUse("peek");
    const kept = { ...stored };
    h = await load(kept);
    expect(h.isLearned("peek")).toBe(true);
    const words = h.unlearnedView(board(h), h.keyUses()).hints.map(x => x.word);
    expect(words).not.toContain(en["board.status.peek"]);
    expect(words).toContain(en["board.status.cards"]);
    expect(h.draw({})).not.toContain(en["board.status.peek"]);
    expect(h.draw({})).toContain(en["board.status.cards"]);
  });

  it("reads a value it cannot make sense of as no uses, and caps a count at three", async () => {
    expect((await load({ [KEY_USES_KEY]: "{not json" })).keyUses()).toEqual({});
    expect((await load({ [KEY_USES_KEY]: "[1,2]" })).keyUses()).toEqual({});
    expect((await load({ [KEY_USES_KEY]: JSON.stringify({ cards: 99, pause: "x", peek: -1 }) })).keyUses()).toEqual({ cards: 3 });
  });

  it("keeps counting in the tab where the store refuses, and forgets with the tab", async () => {
    const h = await load({}, true);
    for (let i = 0; i < 3; i++) h.noteKeyUse("select");
    expect(h.isLearned("select")).toBe(true);
    expect((await load({}, true)).isLearned("select")).toBe(false);
  });
});

describe("the status bar names only the keys not yet learned", () => {
  it("drops a learned hint and keeps the layer's label while one is drawn", async () => {
    const h = await load({ [KEY_USES_KEY]: JSON.stringify({ cards: 3 }) });
    const html = h.draw({});
    expect(html).not.toContain(`>${en["board.status.cards"]}<`);
    expect(html).toContain("statusbar-hint");
    expect(html).toContain('class="statusbar-who"');
    expect(html).not.toContain("statusbar-keys");
  });

  it("keeps one quiet ? Keys once every hint is learned: the keyboard button's own door", async () => {
    const h = await load({ [KEY_USES_KEY]: ALL });
    const html = h.draw({ setKeyHelpOpen: noop });
    expect(html).not.toContain("statusbar-hint");
    expect(html).not.toContain("statusbar-who");
    expect(html).toContain(
      `<button type="button" class="statusbar-keys" aria-label="${en["board.controls.keysLabel"]}" aria-haspopup="dialog" aria-keyshortcuts="?" title="${en["board.controls.keys"]} (?)"><kbd class="kbd">?</kbd>${en["board.keys.statusBar"]}</button>`);
    // It toggles the sheet the way the keyboard row of the canvas bar's ⋯ does.
    expect(sourceOf("components/StatusBar.tsx")).toContain('onClick={() => setKeyHelpOpen(o => !o)}');
    expect(sourceOf("App.tsx")).toMatch(/<StatusBar [^\n]*setKeyHelpOpen=\{setKeyHelpOpen\}/);
  });

  it("keeps ? Keys on a board with nothing to name, and draws it only where it can open the sheet", async () => {
    const h = await load();
    const empty = h.draw({ setKeyHelpOpen: noop }, true);
    expect(empty).toContain("statusbar-keys");
    expect(empty).not.toContain("statusbar-who");
    expect(h.draw({}, true)).not.toContain("statusbar-keys");
  });

  it("never stops naming the way out of the pane while focus is in it", async () => {
    const h = await load({ [KEY_USES_KEY]: ALL });
    const pane = h.statusViewFor({ stageOpen: true, pane: "api", onCard: false, zoomedOut: false, singleKeys: true, platform: "linux", viewChord: "board" });
    const left = h.unlearnedView(pane, h.keyUses());
    expect(left.layer).toBe("terminal");
    // The view chord was learned; the release chord has nothing to learn it by.
    expect(left.hints.map(x => x.word)).toEqual([en["board.status.keysBack"]]);
    expect(left.hints[0].learn).toBeUndefined();
    expect(left.label).toBe(pane.label);
    expect(left.label).not.toBe("");
  });

  it("leaves the Decision card's layer whole, however much is learned", async () => {
    const h = await load({ [KEY_USES_KEY]: ALL });
    const extra = { layer: "board", label: "Decision", hints: [{ caps: [{ text: "A" }], word: "Allow", binds: ["a"] }] };
    const html = h.draw({ extra, setKeyHelpOpen: noop });
    expect(html).toContain(">Allow</span>");
    expect(html).toContain(">Decision</span>");
    expect(html).not.toContain("statusbar-keys");
  });
});
