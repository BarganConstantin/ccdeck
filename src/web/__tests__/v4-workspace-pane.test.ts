// V4 Workspace: the pane. One pane that fills its cell; ✕ empties it (and on the
// empty pane leaves for the Board); ⤢ is Zoom; the empty pane says what the
// frames say; and the Board's stage is not touched by any of it.
import { describe, it, expect, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { all, one } from "./fake-react";
import { sourceOf } from "./client-source";
import { withoutComments } from "./tsx-scan";
import { stageGeometry, ASSUMED_CELL, INSET_X, STAGE_COLS_KEY, type StageGeometryInput } from "../stage-geometry";
import StageHeader, {
  BACK_EMPTY_LABEL, CLOSE_LABEL, FULL_LABEL, FULL_LEAVE_LABEL, PANE_CLOSE_LABEL, ZOOM_LABEL, ZOOM_OFF_LABEL,
  expandLabelFor, zoomLabelFor, type StageHeaderProps,
} from "../components/terminal/StageHeader";
import { StateCard, WS_EMPTY_LINE, WS_EMPTY_TITLE, type StageBodyProps } from "../components/terminal/StageBody";
import { EMPTY_PANE_NAME, stageName } from "../components/terminal/TerminalStage";
import { askSentence, waitedExact, waitingCardFor } from "../components/terminal/stage-board";
import type { BlockedSession } from "../ambient-counts";
import type { StageStatus } from "../components/terminal/stage-model";

const html = (el: ReactElement) => renderToStaticMarkup(el);
const none: StageStatus = { state: "none", phrase: "" };

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
    expect(g.cols).toBe(Math.floor((816 - INSET_X) / ASSUMED_CELL.w));
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
    expect(EMPTY_PANE_NAME).toBe("Empty pane");
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
    expect(waitedExact(6 * 60_000 + 42_000)).toBe("6m 42s");
    expect(waitedExact(9_000)).toBe("9s");
    expect(waitedExact(75 * 60_000)).toBe("1h 15m");
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
