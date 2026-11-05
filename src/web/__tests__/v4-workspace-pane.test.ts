// V4 Workspace: the pane. One pane that fills its cell; ✕ empties it (and on the
// empty pane leaves for the Board); ⤢ is Zoom; the empty pane says what the
// frames say; and the Board's stage is not touched by any of it.
import { describe, it, expect, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { all, one } from "./fake-react";
import { sourceOf } from "./client-source";
import { withoutComments } from "./tsx-scan";
import { stageGeometry, ASSUMED_CELL, INSET_RIGHT, STAGE_COLS_KEY, WS_INSET_LEFT, WS_TERM_TOP, type StageGeometryInput } from "../stage-geometry";
import StageHeader, {
  BACK_EMPTY_LABEL_MSG, CLOSE_LABEL_MSG, FULL_LABEL_MSG, FULL_LEAVE_LABEL_MSG, PANE_CLOSE_LABEL_MSG, ZOOM_LABEL_MSG, ZOOM_OFF_LABEL_MSG,
  expandLabelFor, zoomLabelFor, type StageHeaderProps,
} from "../components/terminal/StageHeader";
import { StateCard, WS_EMPTY_LINE_MSG, WS_EMPTY_TITLE_MSG, type StageBodyProps } from "../components/terminal/StageBody";
import { en } from "../i18n/en";

// CHANGED ON PURPOSE (the UI in every language): these words are read through
// their keys now, and the English catalog holds them.
const BACK_EMPTY_LABEL = en[BACK_EMPTY_LABEL_MSG], CLOSE_LABEL = en[CLOSE_LABEL_MSG], FULL_LABEL = en[FULL_LABEL_MSG];
const FULL_LEAVE_LABEL = en[FULL_LEAVE_LABEL_MSG], PANE_CLOSE_LABEL = en[PANE_CLOSE_LABEL_MSG];
const ZOOM_LABEL = en[ZOOM_LABEL_MSG], ZOOM_OFF_LABEL = en[ZOOM_OFF_LABEL_MSG];
const WS_EMPTY_LINE = en[WS_EMPTY_LINE_MSG], WS_EMPTY_TITLE = en[WS_EMPTY_TITLE_MSG];
import { EMPTY_PANE_NAME_MSG, stageName } from "../components/terminal/TerminalStage";
import { askSentence, waitingCardFor } from "../components/terminal/stage-board";
import type { BlockedSession } from "../ambient-counts";
import { onItsWay, waitedFor, type StagePhase, type StageStatus } from "../components/terminal/stage-model";
import KeysBar, { type KeysBarProps } from "../components/terminal/KeysBar";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const html = (el: ReactElement) => renderToStaticMarkup(el);
const none: StageStatus = { state: "none", phrase: "" };
const sheet = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const stageCss = sheet("styles/terminal-stage.css");
const wsCss = sheet("styles/workspace.css");
/** The body of the rule whose selector is exactly `sel` (at a line's start). */
function rule(css: string, sel: string): string {
  const at = css.indexOf(`\n${sel} {`);
  expect(at, `${sel} has a rule`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at));
}
/** A declaration's value in a rule body, whitespace collapsed. */
const decl = (body: string, prop: string) =>
  new RegExp(`(?:^|[;{\\s])${prop}:\\s*([^;]+);`).exec(body)?.[1].replace(/\s+/g, " ").trim();

const geo = (over: Partial<StageGeometryInput> = {}): StageGeometryInput => ({
  appW: 816, bodyH: 836, cellW: ASSUMED_CELL.w, cellH: ASSUMED_CELL.h, expanded: false, narrow: false, storedCols: null, ...over,
});

describe("the geometry, filled", () => {
  it("makes the pane the whole cell: its columns are what fit, with no navigator and no takeover", () => {
    const g = stageGeometry(geo({ fill: true }));
    expect(g.fill).toBe(true);
    expect(g.stageW).toBe(816);
    expect(g.navW).toBe(0);
    expect(g.takeover).toBe(false);
    // (816 - the insets) / 8: the 96 columns of the 1440 frame, less the lane for the scrollbar.
    // CHANGED ON PURPOSE: the pane's text is 14 in (V4), not the Board's 24,
    // so the inset before the first column is Workspace's own.
    expect(g.cols).toBe(Math.floor((816 - WS_INSET_LEFT - INSET_RIGHT) / ASSUMED_CELL.w));
    expect(g.range).toEqual({ min: g.cols, max: g.cols, detents: [] });
  });

  it("ignores the Board's stored width and Zoom: the divider has nothing to move", () => {
    const plain = stageGeometry(geo({ fill: true }));
    expect(stageGeometry(geo({ fill: true, storedCols: 100 }))).toEqual(plain);
    expect(stageGeometry(geo({ fill: true, expanded: true }))).toEqual(plain);
    expect(stageGeometry(geo({ fill: true, narrow: true }))).toEqual(plain);
  });

  it("fits the rows between the header and the keys bar as the Board does", () => {
    const g = stageGeometry(geo({ fill: true, headH: 36, barH: 32 }));
    const board = stageGeometry(geo({ appW: 1440, bodyH: 836, headH: 36, barH: 32 }));
    expect(g.rows).toBe(board.rows);
    expect(g.headH).toBe(36);
  });

  it("hangs the first row 12 under the header, as V4 sets the pane's text, and keeps every row inside", () => {
    // The Board centres its grid; Workspace's pane starts it 12 down and 14 in
    // (V4's Workspace · Term), with what is left over below the last row.
    expect(WS_TERM_TOP).toBe(12);
    expect(WS_INSET_LEFT).toBe(14);
    for (const [bodyH, headH, barH, cellH] of [[836, 36, 32, 18], [836, 44, 32, 17], [700, 36, 51, 18], [540, 36, 36, 19]] as const) {
      const g = stageGeometry(geo({ fill: true, bodyH, headH, barH, cellH }));
      const board = stageGeometry(geo({ appW: 1440, bodyH, headH, barH, cellH }));
      expect(g.termTop, `${bodyH}/${headH}/${barH}/${cellH}`).toBe(12);
      expect(g.rows, "the Board's row count: no row is lost to the inset").toBe(board.rows);
      expect(g.termTop + g.rows * cellH, "the last row ends above the bar").toBeLessThanOrEqual(bodyH - headH - barH);
    }
    // The CSS sets the same 14 for the pane's host, and leaves the Board's 24.
    expect(stageCss).toMatch(/\n\.ts-stage\[data-fill\] \.ts-host \{ left: 14px; \}/);
    expect(stageCss).toMatch(/\n\.ts-host \{[^}]*left: 24px;/);
  });

  it("leaves the Board's geometry exactly as it was: no fill key at all", () => {
    for (const w of [1440, 1024, 760]) {
      const g = stageGeometry(geo({ appW: w, narrow: w < 1100 }));
      expect("fill" in g).toBe(false);
    }
    expect(stageGeometry(geo({ appW: 1440, fill: false }))).toEqual(stageGeometry(geo({ appW: 1440 })));
  });

  it("never reads or writes the stored width: the hook passes `fill`, and the Board's divider is not drawn", () => {
    const stage = withoutComments(sourceOf("use-stage.ts"));
    expect(stage).toContain("fill: workspace, barH, headH })");
    const ts = withoutComments(sourceOf("components/terminal/TerminalStage.tsx"));
    expect(ts).toContain("!p.geometry.takeover && !p.expanded && !workspace && (");
    expect(STAGE_COLS_KEY).toBe("agent-dag.terminal.cols");
  });
});

const headerProps = (over: Partial<StageHeaderProps> = {}): StageHeaderProps => ({
  identity: "session:a", name: "web-api", provider: "claude", status: none, keysOwner: "board", chordLabel: "Ctrl+Shift+X",
  canType: true, expanded: false, takeover: false, onKeys: vi.fn(), onExpand: vi.fn(), onClose: vi.fn(), ...over,
});

describe("the header", () => {
  it("is Zoom on a pane: a pressed state with its own labels, the glyph unchanged", () => {
    const off = StageHeader(headerProps({ workspace: "pane" }));
    const zoomBtn = one(off, el => el.type === "button" && el.props["data-zoom"] === true);
    expect(zoomBtn.props["aria-pressed"]).toBe(false);
    expect(zoomBtn.props["aria-label"]).toBe(ZOOM_LABEL);
    const on = StageHeader(headerProps({ workspace: "pane", expanded: true }));
    const zoomed = one(on, el => el.type === "button" && el.props["data-zoom"] === true);
    expect(zoomed.props["aria-pressed"]).toBe(true);
    expect(zoomed.props["aria-label"]).toBe(ZOOM_OFF_LABEL);
    expect(ZOOM_LABEL).toBe("Zoom — fold the list and the Inspector");
    expect(ZOOM_OFF_LABEL).toBe("Bring the list and the Inspector back");
  });

  it("keeps full screen where ⤢ goes full screen today", () => {
    expect(zoomLabelFor(false, true, false)).toBe(FULL_LABEL);
    expect(zoomLabelFor(true, true, true)).toBe(FULL_LEAVE_LABEL);
    expect(zoomLabelFor(true, true, false)).toBe(ZOOM_OFF_LABEL);
  });

  it("does not report a state on the Board's ⤢ (the keys' landing looks for the one pressed button)", () => {
    const board = StageHeader(headerProps());
    const btn = one(board, el => el.type === "button" && el.props["aria-label"] === expandLabelFor(false, false, false));
    expect(btn.props["aria-pressed"]).toBeUndefined();
    expect(btn.props["data-zoom"]).toBeUndefined();
  });

  it("closes a pane with the promise it keeps, and an empty pane with the way back to the Board", () => {
    const pane = StageHeader(headerProps({ workspace: "pane" }));
    expect(one(pane, el => el.props["data-stage-close"] === true).props["aria-label"]).toBe(CLOSE_LABEL);
    const dead = StageHeader(headerProps({ workspace: "pane", nothingRunning: true }));
    expect(one(dead, el => el.props["data-stage-close"] === true).props["aria-label"]).toBe(PANE_CLOSE_LABEL);
    const empty = StageHeader(headerProps({ workspace: "empty", nothingRunning: true, canType: false }));
    expect(one(empty, el => el.props["data-stage-close"] === true).props["aria-label"]).toBe(BACK_EMPTY_LABEL);
    expect(BACK_EMPTY_LABEL).toBe("Back to the board");
  });

  it("gives the empty pane one control, ✕ — no ⌨, no ⤢ — and no back arrow", () => {
    const empty = StageHeader(headerProps({ workspace: "empty", nothingRunning: true, canType: false }));
    const buttons = all(empty, el => el.type === "button");
    expect(buttons.map(b => b.props["data-stage-close"] === true)).toEqual([true]);
  });

  it("has no ‹ in Workspace: the pane is not a takeover", () => {
    const g = stageGeometry(geo({ fill: true }));
    expect(g.takeover).toBe(false);
  });

  it("titles the empty pane \"Empty pane\", and only in Workspace", () => {
    // CHANGED ON PURPOSE (the UI in every language): the name is a catalog key now.
    expect(en[EMPTY_PANE_NAME_MSG]).toBe("Empty pane");
    expect(stageName({ kind: "empty" }, true)).toBe("Empty pane");
    expect(stageName({ kind: "empty" })).toBe("No session open");
  });
});

const bodyProps = (over: Partial<StageBodyProps> = {}): StageBodyProps => ({
  phase: { kind: "empty" }, onAdopt: vi.fn(), onNotNow: vi.fn(), onRetry: vi.fn(), onNewSession: vi.fn(), ...over,
});

describe("the empty pane", () => {
  it("says what the frame says when nothing waits, with New session as its one action", () => {
    const out = html(createElement(StateCard, bodyProps({ workspace: true })));
    expect(WS_EMPTY_TITLE).toBe("Nothing is waiting");
    expect(WS_EMPTY_LINE).toBe("Open a session from the list, or start a new one.");
    expect(out).toContain(">Nothing is waiting<");
    expect(out).toContain(">Open a session from the list, or start a new one.<");
    expect(out).toContain("New session");
    expect(out).toContain("data-stage-land");
    expect(out).not.toContain("Click a session on the board");
  });

  it("names the oldest waiting session when someone waits, with no New session", () => {
    const waiting = { id: "s1", name: "web-api", waited: "6m 42s", ask: "Allow this command?", command: "npm test -- rate-limit" };
    const out = html(createElement(StateCard, bodyProps({ workspace: true, waiting })));
    expect(out).toContain("web-api is waiting on you");
    expect(out).toContain("6m 42s");
    expect(out).toContain("Allow this command?");
    expect(out).toContain("<code>npm test -- rate-limit</code>");
    expect(out).toContain("Open web-api");
    // V4's Figma puts the key cap after the label.
    expect(out).toMatch(/<span>Open web-api<\/span><kbd class="kbd">n<\/kbd><\/button>/);
    expect(out).not.toContain("New session");
    // Not a decision card: nothing to allow or deny here.
    expect(out).not.toMatch(/Allow<|Deny/);
  });

  it("is the Board's card, word for word, on the Board", () => {
    const out = html(createElement(StateCard, bodyProps()));
    expect(out).toContain("Click a session on the board to watch it here, or start a new one.");
  });

  it("opens the session the card names, by id, with the keys in its pane (not the next-ask door)", () => {
    // Was wired to p.onNextAsk, which goes to the arrival the bar names first and
    // so could open another session than the one the button says (review 2).
    const ts = withoutComments(sourceOf("components/terminal/TerminalStage.tsx"));
    expect(ts).toContain("onOpenWaiting={openWaiting(p.waiting, p.onOpenWaiting)}");
    const shell = withoutComments(sourceOf("components/terminal/StageShell.tsx"));
    expect(shell).toContain("onOpenWaiting={id => stage.switchTo(id, { focusPane: true })}");
    expect(shell).toContain("onNextAsk={p.asks.nextAsk}");
  });
});

describe("what the empty pane is told about the wait", () => {
  const block = (over: Partial<BlockedSession["waiting"]> = {}, label = "web-api"): BlockedSession => ({
    id: "s1", label, waiting: { kind: "permission", message: "", since: 1000, tool: { name: "Bash", preview: "npm test -- rate-limit" }, ...over } as BlockedSession["waiting"],
  });

  it("counts to the second, as the frame prints it", () => {
    // CHANGED ON PURPOSE: the pane's own `waitedExact` is gone. The empty pane,
    // the header and the rail row print one wait with one clock, so it is the
    // header's `waitedFor` now, and the seconds are padded after a minute.
    expect(waitedFor(6 * 60_000 + 42_000)).toBe("6m 42s");
    expect(waitedFor(6 * 60_000 + 7_000)).toBe("6m 07s");
    expect(waitedFor(9_000)).toBe("9s");
    expect(waitedFor(75 * 60_000)).toBe("1h 15m");
  });

  it("asks what the block asks", () => {
    expect(askSentence(block().waiting)).toBe("Allow this command?");
    expect(askSentence(block({ tool: { name: "Edit", preview: "a.ts" } }).waiting)).toBe("Allow Edit?");
    expect(askSentence(block({ tool: undefined }).waiting)).toBe("Needs your permission.");
    expect(askSentence(block({ kind: "asked", tool: undefined }).waiting)).toBe("Asked you a question.");
    expect(askSentence(block({ kind: "idle", tool: undefined }).waiting)).toBe("Waiting for your next instruction.");
  });

  it("takes the first of the queue, which is the oldest, and none when none waits", () => {
    expect(waitingCardFor([], 0)).toBeNull();
    const card = waitingCardFor([block(), block({}, "second")], 1000 + 402_000);
    expect(card).toEqual({ id: "s1", name: "web-api", waited: "6m 42s", ask: "Allow this command?", command: "npm test -- rate-limit" });
  });
});

describe("the hook", () => {
  const stage = withoutComments(sourceOf("use-stage.ts"));

  it("empties the pane without ending anything, and clears the selection", () => {
    const at = stage.indexOf("const emptyPane = useCallback");
    const body = stage.slice(at, stage.indexOf("}, [enabledRef, openOn, clearRef]);", at));
    // Asks for the focus through the stage's request (review 10), so it lands on the
    // empty pane's action once that is drawn.
    expect(body).toContain('openOn({ kind: "empty" }, { focusPane: true })');
    expect(body).toContain("clearRef.current?.()");
    expect(body).not.toMatch(/stop|kill|end\(/i);
  });

  it("puts a row on the pane and lets the selection follow; Enter asks for the keys", () => {
    const at = stage.indexOf("const openInPane = useCallback");
    const body = stage.slice(at, stage.indexOf("}, [enabledRef, openOn, follow]);", at));
    expect(body).toContain('openOn({ kind: "session", id: sessionId }, { focusPane: opts.focusPane === true })');
    expect(body).toContain("follow(sessionId)");
  });

  it("opens the pane on the selection, else the last session, else nothing; once per entry", () => {
    expect(stage).toContain("terminalButtonTarget(selectedSession, shellRef.current.last,");
    expect(stage).toContain("enteredRef");
  });

  it("does not close the Inspector for the stage, or the stage for the Inspector", () => {
    expect(stage).toContain("if (detailOpenRef.current && !workspaceRef.current) setDetailOpen(false);");
    expect(stage).toContain("if (detailShown && !workspaceRef.current) giveRightBack();");
  });

  it("morphs nothing: a pane that is the cell is open as soon as it can be seen", () => {
    const shell = withoutComments(sourceOf("components/terminal/StageShell.tsx"));
    expect(shell).toContain("if (geo.fill) { settle(); done(); return; }");
  });

  it("leaves the Board in the same update that changes the view, Zoom given back", () => {
    expect(stage).toMatch(/const leaveWorkspace = useCallback\(\(\) => \{\s*setExpanded\(false\);\s*giveRightBack\(\);/);
  });
});

describe("the pane as V4's Workspace page draws it", () => {
  const barProps = (over: Partial<KeysBarProps> = {}): KeysBarProps => ({
    owner: "board", name: "web-api", chordLabel: "Ctrl+Shift+X", canType: true, asksWaiting: true,
    firstRun: false, onFirstRunDone: vi.fn(), onTypeHere: vi.fn(), ...over,
  });

  it("draws the live terminal on --sunken in Workspace, frame and all, and leaves the Board's body as it was", () => {
    // Was --sunken only while a state card spoke; the frame sat on --panel.
    expect(decl(rule(stageCss, ".ts-stage[data-fill] .ts-body"), "background")).toBe("var(--sunken)");
    expect(stageCss).not.toContain(".ts-stage[data-fill] .ts-body:not([data-frame])");
    expect(decl(rule(stageCss, ".ts-stage:not([data-fill]) .ts-body:not([data-frame])"), "background")).toBe("var(--bg)");
    // And xterm is told the same ground there (terminal-palette.test.ts sweeps it).
    const ts = withoutComments(sourceOf("components/terminal/TerminalStage.tsx"));
    expect(ts).toContain('terminalTheme(p.readToken, workspace ? "--sunken" : "--panel")');
  });

  it("sets the waiting glyph inline before the title, 8 apart, with the wait 12 after", () => {
    const waiting = { id: "s1", name: "web-api", waited: "6m 42s", ask: "Allow this command?", command: "npm test -- rate-limit" };
    const out = html(createElement(StateCard, bodyProps({ workspace: true, waiting })));
    expect(out).toMatch(/<div class="ts-ws-head"><span class="ts-glyph" data-glyph="waiting" aria-hidden="true">.*?<\/span><span class="ts-ws-title">web-api is waiting on you<\/span><span class="ts-ws-wait">6m 42s<\/span><\/div>/);
    // Not above the row any more.
    expect(out).not.toMatch(/data-waiting=""><span class="ts-glyph"/);
    const head = rule(wsCss, ".ts-ws-head");
    expect(decl(head, "display")).toBe("flex");
    expect(decl(head, "gap")).toBe("8px");
    expect(decl(rule(wsCss, ".ts-ws-head > .ts-glyph"), "align-self")).toBe("center");
    expect(decl(rule(wsCss, ".ts-ws-wait"), "margin-left")).toBe("4px");
  });

  it("sets the ask's command in the ask's own tone on a 20 line, and the Open button on the panel in --text", () => {
    expect(decl(rule(wsCss, ".ts-ws-ask code"), "font")).toBe("400 13px/20px var(--font-mono)");
    expect(decl(rule(wsCss, ".ts-ws-ask code"), "color")).toBe("var(--muted)");
    const open = rule(wsCss, ".btn.ts-ws-open");
    expect(decl(open, "background")).toBe("var(--panel)");
    expect(decl(open, "color")).toBe("var(--text)");
    // The kit's 28 stays: the rule sets no height of its own.
    expect(decl(open, "height")).toBeUndefined();
    expect(decl(open, "min-height")).toBeUndefined();
  });

  it("names the deck, as the status bar does, where the keys go in Workspace; the Board's strip keeps the board", () => {
    const deckKeys = html(createElement(KeysBar, barProps({ workspace: true })));
    expect(deckKeys).toMatch(/data-owner="board"><span class="ts-label">Keys on the deck<\/span>/);
    const deckPane = html(createElement(KeysBar, barProps({ workspace: true, owner: "pane" })));
    expect(deckPane).toContain('<kbd class="kbd" aria-hidden="true">Ctrl+Shift+X</kbd><span class="kbd-spoken">Control Shift X</span> keys back to the deck');
    // What a reader sees or hears, so the owner attribute ("board" as the
    // keys' holder, never shown) does not count.
    const words = (out: string) => [out.replace(/<[^>]*>/g, " "), ...[...out.matchAll(/(?:aria-label|title)="([^"]*)"/g)].map(m => m[1])].join(" ");
    for (const out of [deckKeys, deckPane]) expect(words(out)).not.toMatch(/\bboard\b/i);
    // The status bar's own words, so the two never drift apart in any language.
    expect(en["board.status.deckLabel"]).toBe("Keys on the deck");
    expect(en["board.status.keysBack"]).toBe("keys back to the deck");
    expect(html(createElement(KeysBar, barProps()))).toContain("Keys on the board");
    expect(html(createElement(KeysBar, barProps({ owner: "pane" })))).toContain("back to the board");
  });

  it("draws no keys strip while a pane is only being attached or started, and keeps it over a held frame and a reconnect", () => {
    const attaching: StagePhase = { kind: "attaching" };
    const reconnect: StagePhase = { kind: "attaching", reconnect: true };
    expect(onItsWay(attaching, "hidden"), "a first attach: the card alone").toBe(true);
    expect(onItsWay({ kind: "starting", agent: "claude", cwd: "/w" } as StagePhase, "hidden"), "a launch").toBe(true);
    expect(onItsWay(attaching, "held"), "a switch holds the last frame: the bar stays").toBe(false);
    expect(onItsWay(reconnect, "shown"), "a reconnect says so in the bar").toBe(false);
    expect(onItsWay({ kind: "live", sizeOwner: "dock", readOnly: false }, "shown")).toBe(false);
    const ts = withoutComments(sourceOf("components/terminal/TerminalStage.tsx"));
    expect(ts).toContain("paneless={p.show.kind === \"empty\" || PANELESS.has(phase.kind) || onItsWay(phase, frame)}");
    // The phone's key row is not the strip, and keeps its own rule.
    expect(ts).toContain("<PhoneKeys canType={typing} paneless={p.show.kind === \"empty\" || PANELESS.has(phase.kind)}");
    // Paneless, the strip is not drawn.
    expect(html(createElement(KeysBar, barProps({ workspace: true, paneless: true })))).toMatch(/<footer class="ts-bar"[^>]*hidden=""/);
  });
});
