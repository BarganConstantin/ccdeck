// The terminal stage as drawn: its header, its state cards, its keys bar.
//
// Rendered to markup the way the deck's other views are pinned here
// (renderToStaticMarkup, no DOM), and pressed by calling a component and
// walking the element tree it returns (fake-react's tree helpers — react
// itself is the real one in this file). What is pinned is what v3 drew and
// DESIGN.md promised: ✕ named "Close — the session keeps running", the face's
// own sentence in the header, a card for every state that has no pane, a keys
// bar that always says who has the keyboard, and the pane's attribute on the
// terminal's host alone, so the board's keys still work from the header.
import { describe, it, expect, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { all, one, textOf, type Drawn } from "./fake-react";
import { withoutComments } from "./tsx-scan";
import { sheetText } from "./sheet-source";
import TerminalStage, { stageName, subjectOf, type StageShow, type TerminalStageProps } from "../components/terminal/TerminalStage";
import StageHeader, { BACK_LABEL, CLOSE_LABEL, chipLabel, chipText, type StageHeaderProps } from "../components/terminal/StageHeader";
import StageBody, { EMPTY_NEW_SESSION_ID, STILL_RUNNING_NOTE, StateCard, tmuxFact, type StageBodyProps } from "../components/terminal/StageBody";
import KeysBar, { ArrivalNote, AsksTrack, type KeysBarProps } from "../components/terminal/KeysBar";
import { ASSUMED_CELL, stageGeometry } from "../stage-geometry";
import type { StagePhase, StageStatus } from "../components/terminal/stage-model";

const html = (el: ReactElement) => renderToStaticMarkup(el);
const press = (el: Drawn | null, event: Record<string, unknown> = {}) => {
  expect(el, "the control is drawn").not.toBeNull();
  (el!.props.onClick as (e: unknown) => void)({ preventDefault() {}, ...event });
};
const button = (tree: unknown, name: string) =>
  one(tree, el => el.type === "button" && (el.props["aria-label"] === name || textOf(el).trim() === name));

const working: StageStatus = { state: "working", phrase: "working", tool: "Task", arg: "3 subagents running", seconds: "7m 38s" };

function headerProps(over: Partial<StageHeaderProps> = {}): StageHeaderProps {
  return {
    identity: "session:a", name: "paycore", provider: "claude", model: "claude-sonnet-5", status: working,
    keysOwner: "board", chordLabel: "Ctrl+Shift+X", canType: true, expanded: false, takeover: false,
    onKeys: vi.fn(), onExpand: vi.fn(), onClose: vi.fn(), ...over,
  };
}

function bodyProps(phase: StagePhase, over: Partial<StageBodyProps> = {}): StageBodyProps {
  return {
    hostRef: { current: null }, phase, ghostLine: "● Task(7 subagents running)",
    context: { prompt: "Refactor mailbox controller", fact: "3 subagents working · running in another terminal since 08:12" },
    onAdopt: vi.fn(), onNotNow: vi.fn(), onRetry: vi.fn(), onNewSession: vi.fn(), ...over,
  };
}

function barProps(over: Partial<KeysBarProps> = {}): KeysBarProps {
  return {
    owner: "board", name: "paycore", chordLabel: "Ctrl+Shift+X", canType: true, asksWaiting: true,
    firstRun: false, onFirstRunDone: vi.fn(), onTypeHere: vi.fn(), ...over,
  };
}

// ---------------------------------------------------------------------------

describe("the header", () => {
  it("names ✕ by the promise it keeps, never stop, end or quit", () => {
    const tree = StageHeader(headerProps());
    const close = button(tree, CLOSE_LABEL);
    expect(CLOSE_LABEL).toBe("Close — the session keeps running");
    expect(close!.props.title).toBe(CLOSE_LABEL);
    expect(html(createElement(StageHeader, headerProps()))).not.toMatch(/\b(stop|quit)\b|aria-label="End/i);
    const onClose = vi.fn();
    press(button(StageHeader(headerProps({ onClose })), CLOSE_LABEL));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("prints the face's sentence: the state, the tool, its argument and its live seconds", () => {
    const out = html(createElement(StageHeader, headerProps()));
    expect(out).toContain('<h2 class="ts-name">paycore</h2>');
    expect(out).toContain('data-state="working"');
    expect(out).toMatch(/class="ts-tool">Task<.*class="ts-arg">3 subagents running<.*class="ts-sec">7m 38s</);
  });

  it("says waiting with how long in bold, pinging the deck's own still-asking mark", () => {
    const out = html(createElement(StageHeader, headerProps({ status: { state: "waiting", phrase: "waiting", emphasis: "6m", tool: "Bash", arg: "git push" } })));
    expect(out).toContain("waiting <b>6m</b>");
    expect(out).toContain('class="ap-pulse"');
    expect(out).not.toMatch(/blocked/i);
  });

  it("wears the model chip with the provider in words for a screen reader", () => {
    expect(chipText("claude", "claude-opus-5-5")).toBe("Opus 5.5");
    expect(chipText("codex", null)).toBe("Codex");
    expect(chipText("claude", null), "no model yet: no chip guessing one").toBeNull();
    expect(chipLabel("claude", "Opus 5.5")).toBe("Claude Code · Opus 5.5");
    expect(chipLabel("codex", "Codex")).toBe("Codex");
    const out = html(createElement(StageHeader, headerProps({ model: "claude-opus-5-5" })));
    expect(out).toMatch(/class="model-chip ts-chip" data-family="opus" role="img" aria-label="Claude Code · Opus 5.5"/);
  });

  it("offers ⌨ only for a pane that takes keys, pressed while the pane has them", () => {
    const free = StageHeader(headerProps({ canType: false }));
    expect(button(free, "Type into the session")).toBeNull();
    const board = button(StageHeader(headerProps()), "Type into the session")!;
    expect(board.props["aria-pressed"]).toBe(false);
    const pane = button(StageHeader(headerProps({ keysOwner: "pane" })), "Type into the session")!;
    expect(pane.props["aria-pressed"]).toBe(true);
    expect(pane.props.title).toBe("Give the keys back to the board (Ctrl+Shift+X)");
  });

  it("leads with ‹ Board in the takeover, with the same promise as ✕, and drops ⤢", () => {
    const tree = StageHeader(headerProps({ takeover: true }));
    expect(button(tree, BACK_LABEL)).not.toBeNull();
    expect(BACK_LABEL).toMatch(/keeps running/);
    expect(button(tree, "Give the stage the width")).toBeNull();
    expect(button(StageHeader(headerProps()), "Give the stage the width")).not.toBeNull();
    expect(button(StageHeader(headerProps({ expanded: true })), "Give the board its room back")).not.toBeNull();
  });
});

describe("the body's state cards, each at the terminal's origin", () => {
  it("keeps the terminal's host drawn in every state, and marks it — and only it — as the pane", () => {
    for (const phase of [{ kind: "empty" }, { kind: "live", sizeOwner: "dock", readOnly: false }, { kind: "error", message: "x" }] as StagePhase[]) {
      const out = html(createElement(StageBody, bodyProps(phase)));
      expect(out, phase.kind).toMatch(/<div class="ts-host" data-terminal-panel=""/);
    }
    expect(html(createElement(StageBody, bodyProps({ kind: "live", sizeOwner: "dock", readOnly: false })))).toContain("data-shown");
    expect(html(createElement(StageBody, bodyProps({ kind: "attaching", reconnect: false })))).not.toContain("data-shown");
  });

  it("shows the last known line while attaching, and nothing over a reconnect's frozen frame", () => {
    expect(html(createElement(StateCard, bodyProps({ kind: "attaching", reconnect: false })))).toContain("● Task(7 subagents running)");
    expect(html(createElement(StateCard, bodyProps({ kind: "attaching", reconnect: true })))).toBe("");
  });

  it("says where a new session is starting", () => {
    expect(html(createElement(StateCard, bodyProps({ kind: "starting", agent: "claude", cwd: "/home/u/personal/ccdeck" }))))
      .toContain("Starting Claude Code in /home/u/personal/ccdeck");
  });

  it("offers Reopen here for case C with the deck's own sentence, and answers its 409 in place", () => {
    const target = { kind: "C" as const, label: "This session was started outside the deck, so there is no pane to attach to.", adoptable: true };
    const props = bodyProps({ kind: "not-attachable", target, stillRunning: false, busy: false });
    const out = html(createElement(StateCard, props));
    expect(out).toContain(target.label);
    expect(out).toContain("Refactor mailbox controller");
    expect(out).toContain("running in another terminal");
    const tree = StateCard(props);
    press(button(tree, "Reopen here"));
    expect(props.onAdopt).toHaveBeenCalled();
    press(button(tree, "Not now"));
    expect(props.onNotNow).toHaveBeenCalled();

    const refused = html(createElement(StateCard, bodyProps({ kind: "not-attachable", target, stillRunning: true, busy: false })));
    expect(refused).toContain(STILL_RUNNING_NOTE);
    expect(refused).toContain("Check again");
    expect(refused).not.toContain("Reopen here");
    expect(html(createElement(StateCard, bodyProps({ kind: "not-attachable", target: { ...target, adoptable: false }, stillRunning: false, busy: false }))))
      .not.toContain("Reopen here");
  });

  it("states tmux missing as a fact with the line that installs it, and checks again on request", () => {
    const props = bodyProps({ kind: "tmux-missing", reason: "missing", install: "sudo apt install tmux", busy: false });
    const out = html(createElement(StateCard, props));
    expect(out).toContain("tmux · not found on this machine");
    expect(out).toMatch(/<code><span class="ts-prompt">\$ <\/span>sudo apt install tmux<\/code>/);
    expect(out).toContain('aria-label="Copy the command"');
    press(button(StateCard(props), "Check again"));
    expect(props.onRetry).toHaveBeenCalled();
    // Busy, not disabled: a press never disables its own control (#620), so
    // focus stays on it; it says so, and the hook refuses the second press.
    const busy = button(StateCard(bodyProps({ kind: "tmux-missing", reason: "missing", busy: true })), "Checking…")!;
    expect(busy.props["aria-busy"]).toBe(true);
    expect(busy.props.disabled).toBeUndefined();
    expect(tmuxFact("too-old")).toMatch(/older than 3\.2/);
  });

  it("gives the empty stage New session as its only action", () => {
    const props = bodyProps({ kind: "empty" });
    const tree = StateCard(props);
    const buttons = all(tree, el => el.type === "button");
    expect(buttons.map(b => textOf(b))).toEqual(["New session"]);
    press(buttons[0]);
    expect(props.onNewSession).toHaveBeenCalledWith(EMPTY_NEW_SESSION_ID);
    expect(html(createElement(StateCard, props))).toContain("Click a session on the board to watch it here, or start a new one.");
  });

  it("never draws an empty black box: every state without a frame says something", () => {
    const phases: StagePhase[] = [
      { kind: "empty" }, { kind: "attaching", reconnect: false }, { kind: "starting", agent: "codex", cwd: "/w" },
      { kind: "not-attachable", target: { kind: "gone", label: "This session has ended.", adoptable: true }, stillRunning: false, busy: false },
      { kind: "tmux-missing", reason: "too-old", busy: false }, { kind: "error", message: "The deck did not answer." },
    ];
    for (const phase of phases) expect(textOf(StateCard(bodyProps(phase))).trim(), phase.kind).not.toBe("");
  });
});

describe("the keys bar", () => {
  it("says the board has the keys, with its keys, and offers to type here", () => {
    const out = html(createElement(KeysBar, barProps()));
    expect(out).toContain('data-owner="board"');
    expect(out).toContain("Keys on the board");
    expect(out).toMatch(/<kbd class="ts-kbd">j<\/kbd><kbd class="ts-kbd">k<\/kbd> sessions/);
    expect(out).toContain("next ask");
    const props = barProps();
    press(button(KeysBar(props), "type here"));
    expect(props.onTypeHere).toHaveBeenCalled();
    expect(html(createElement(KeysBar, barProps({ canType: false, asksWaiting: false })))).not.toMatch(/type here|next ask/);
  });

  it("says who is being typed into, that Escape goes to the session, and how to give the keys back", () => {
    const out = html(createElement(KeysBar, barProps({ owner: "pane" })));
    expect(out).toContain('data-owner="pane"');
    expect(out).toContain('Typing into <span class="ts-who">paycore</span>');
    expect(out).toContain("goes to the session");
    expect(out).toMatch(/<kbd class="ts-kbd" aria-label="Control Shift X">Ctrl\+Shift\+X<\/kbd> back to the board/);
  });

  it("carries the first-run line, so it never costs the terminal a row", () => {
    const props = barProps({ firstRun: true });
    const out = html(createElement(KeysBar, props));
    expect(out).toContain("Typing goes to the session");
    expect(out).toContain("closes the stage; the session keeps running");
    press(button(KeysBar(props), "Got it"));
    expect(props.onFirstRunDone).toHaveBeenCalled();
  });

  it("turns into the end bar for a finished session, with Reopen here", () => {
    const onAction = vi.fn();
    const props = barProps({ end: { sentence: "The session ended 14m ago — this is its last frame.", action: "Reopen here", onAction } });
    const out = html(createElement(KeysBar, props));
    expect(out).toContain("The session ended 14m ago — this is its last frame.");
    expect(out).not.toContain("Keys on the board");
    press(button(KeysBar(props), "Reopen here"));
    expect(onAction).toHaveBeenCalled();
  });

  it("runs the asks: the track and where the stage is in it, then Next ask, then no more", () => {
    const now = html(createElement(KeysBar, barProps({ asks: { segments: ["now", "todo"], position: { index: 0, total: 2 } } })));
    expect(now).toMatch(/Asks<\/span><span class="ts-track" aria-hidden="true"><i data-s="now"><\/i><i data-s="todo"><\/i><\/span><span class="ts-count">1 of 2<\/span>/);

    const onNextAsk = vi.fn();
    const props = barProps({ asks: { segments: ["done", "todo"], resumed: "paycore", next: { name: "travel-portal", waited: "2m", tool: "Edit" } }, onNextAsk });
    const out = html(createElement(KeysBar, props));
    expect(out).toContain("✓ paycore resumed");
    expect(out).toContain('aria-label="Next ask: travel-portal, waiting 2m on Edit"');
    press(button(AsksTrack({ asks: props.asks!, onNextAsk }), "Next ask: travel-portal, waiting 2m on Edit"));
    expect(onNextAsk).toHaveBeenCalled();

    expect(html(createElement(KeysBar, barProps({ asks: { segments: ["done", "done"], clear: true } })))).toContain("✓ No more asks");
    expect(html(createElement(KeysBar, barProps({ asks: { segments: ["now", "todo", "todo"], freshIndex: 2, position: { index: 0, total: 3 } } }))))
      .toContain('<i data-s="todo" data-fresh="true"></i>');
  });

  it("says once, quietly, that another session asks — and answering is a press, never automatic", () => {
    const onAnswerArrival = vi.fn();
    const props = barProps({ owner: "pane", arrival: { name: "boom-next-gen", tool: "Bash" }, onAnswerArrival });
    const out = html(createElement(KeysBar, props));
    expect(out).toMatch(/<b>boom-next-gen<\/b> asks · Bash/);
    expect(onAnswerArrival).not.toHaveBeenCalled();
    press(button(ArrivalNote({ arrival: props.arrival!, onAnswer: onAnswerArrival }), "Answer boom-next-gen"));
    expect(onAnswerArrival).toHaveBeenCalled();
  });
});

describe("the stage as a whole", () => {
  const geometry = stageGeometry({ appW: 1440, bodyH: 848, cellW: 8, cellH: 18, expanded: false, narrow: false, storedCols: null });
  const stageProps = (show: StageShow, over: Partial<TerminalStageProps> = {}): TerminalStageProps => ({
    show, geometry, cell: ASSUMED_CELL, readToken: () => "", expanded: false, firstRun: false, asksWaiting: false,
    onClose: vi.fn(), onToggleExpand: vi.fn(), onFirstRunDone: vi.fn(), onNewSession: vi.fn(),
    onCols: vi.fn(), onColsReset: vi.fn(), ...over,
  });
  const session: StageShow = {
    kind: "session",
    session: { ref: { sessionId: "s1", provider: "claude", cwd: "/w/paycore" }, name: "paycore", hue: 270, status: working },
  };

  it("is a region named for its session, its hue on the spine, sized from the geometry", () => {
    const out = html(createElement(TerminalStage, stageProps(session)));
    expect(out).toMatch(/^<section class="ts-stage" role="region" aria-label="Terminal — paycore" data-kind="empty"/);
    expect(out).toContain("--session-hue:270");
    expect(out).toContain("--ts-term-top:14px");
    expect(out).toContain("--ts-head-h:64px");
    expect(out, "the divider is a separator with a value").toMatch(/role="separator" aria-orientation="vertical" aria-label="Stage width" aria-valuemin="80" aria-valuemax="134" aria-valuenow="120" aria-valuetext="120 columns"/);
  });

  it("calls the empty stage what it is, with nothing on the spine", () => {
    const out = html(createElement(TerminalStage, stageProps({ kind: "empty" })));
    expect(out).toContain('aria-label="Terminal — Nothing on the stage"');
    expect(out).toContain("data-empty");
    expect(stageName({ kind: "empty" })).toBe("Nothing on the stage");
  });

  it("draws no divider in the takeover, where there is no board to divide from", () => {
    const narrow = stageGeometry({ appW: 760, bodyH: 650, cellW: 8, cellH: 18, expanded: false, narrow: true, storedCols: null });
    const out = html(createElement(TerminalStage, stageProps(session, { geometry: narrow })));
    expect(out).toContain("data-takeover");
    expect(out).not.toContain('role="separator"');
  });

  it("hands the session hook a subject that names the session, or the launch, and nothing else", () => {
    expect(subjectOf(session)).toEqual({ kind: "session", ref: { sessionId: "s1", provider: "claude", cwd: "/w/paycore" } });
    expect(subjectOf({ kind: "launch", agent: "codex", cwd: "/w", name: "w", hue: 3, key: "n1" })).toEqual({ kind: "launch", agent: "codex", cwd: "/w", key: "n1" });
    expect(subjectOf({ kind: "empty" })).toEqual({ kind: "empty" });
  });
});

describe("what the stage costs the page that never opens it", () => {
  const web = (path: string) => withoutComments(readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8"));

  it("loads xterm, and its stylesheet with it, only through dynamic imports inside the session hook", () => {
    const hook = web("use-terminal-session.ts");
    const statics = [...hook.matchAll(/^\s*import\s+(?!type\b)[^;]*from\s+"(@xterm\/[^"]+)"/gm)].map(m => m[1]);
    expect(statics, "a static xterm import would put it in whatever chunk imports the hook").toEqual([]);
    expect(hook).toMatch(/import\("@xterm\/xterm"\)/);
    expect(hook).toMatch(/import\("@xterm\/addon-webgl"\)/);
    expect(hook).toMatch(/import\("@xterm\/addon-unicode11"\)/);
    // The sheet rides xterm's own import (xterm-sheet.ts): imported by the
    // stage, it made the lazy chunk one with a CSS dependency, and the entry
    // chunk every visit loads had to carry Vite's dependency map for it.
    expect(hook).toMatch(/import\("\.\/xterm-sheet"\)/);
    expect(web("xterm-sheet.ts")).toContain('import "@xterm/xterm/css/xterm.css";');
    expect(web("components/terminal/TerminalStage.tsx")).not.toMatch(/@xterm\//);
    for (const f of ["components/terminal/StageHeader.tsx", "components/terminal/StageBody.tsx", "components/terminal/KeysBar.tsx",
      "components/terminal/Divider.tsx", "components/terminal/NewSessionPopover.tsx", "stage-geometry.ts"]) {
      expect(web(f), f).not.toMatch(/@xterm\//);
    }
  });
});

describe("the stage's sheet", () => {
  const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = (sel: string) => {
    const at = css.indexOf(`${sel} {`);
    expect(at, `${sel} has a rule`).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf("}", at));
  };

  it("draws the header at 64px with its spine, and the keys bar at 36px", () => {
    expect(rule(".ts-head")).toContain("height: var(--ts-head-h, 64px)");
    expect(rule(".ts-spine")).toMatch(/width: 3px;[\s\S]*height: 32px/);
    expect(rule(".ts-bar")).toContain("height: 36px");
  });

  it("travels a light down the spine only while live, and takes it away under reduced motion", () => {
    expect(css).toContain(".ts-stage[data-live] .ts-spine::after {");
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce) {\n  .ts-stage[data-live]"));
    expect(reduced).toMatch(/\.ts-stage\[data-live\] \.ts-spine::after \{ display: none; \}/);
  });

  it("keeps the stage's marks under a Contrast theme, in the deck's one forced-colours block", () => {
    const forced = css.slice(css.indexOf("@media (forced-colors: active) {"));
    expect(forced).toMatch(/\.ts-spine \{ background: Highlight; \}/);
    expect(forced).toMatch(/\.ts-keys\[data-owner="pane"\] \.ts-lamp \{ background: Highlight;/);
    expect(css.split("@media (forced-colors: active) {").length - 1, "one block, as #871 holds").toBe(1);
  });

  it("opens the popover opaque from its first frame: it scales, it does not fade", () => {
    const pop = css.slice(css.indexOf("@keyframes ns-pop-in"), css.indexOf("}", css.indexOf("@keyframes ns-pop-in")) + 1);
    expect(pop).toContain("scale(0.97)");
    expect(pop).not.toContain("opacity");
  });
});
