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
import TerminalStage, { endView, stageName, subjectOf, type StageShow, type TerminalStageProps } from "../components/terminal/TerminalStage";
import StageHeader, { BACK_EMPTY_LABEL, BACK_LABEL, CLOSE_EMPTY_LABEL, CLOSE_LABEL, FULL_LABEL, FULL_LEAVE_LABEL, chipLabel, chipText, type StageHeaderProps } from "../components/terminal/StageHeader";
import StageBody, { EMPTY_NEW_SESSION_ID, STILL_RUNNING_NOTE, StateCard, downloadNote, setupLine, setupShare, tmuxFact, type StageBodyProps } from "../components/terminal/StageBody";
import KeysBar, { ArrivalNote, AsksTrack, type KeysBarProps } from "../components/terminal/KeysBar";
import { ASSUMED_CELL, stageGeometry } from "../stage-geometry";
import type { StagePhase, StageStatus } from "../components/terminal/stage-model";
import { subjectKey } from "../use-terminal-session";

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

  it("names the effort after the model, as the session's card does", () => {
    expect(chipText("claude", "claude-opus-5-5", "max")).toBe("Opus 5.5 · max");
    expect(chipText("claude", "claude-opus-5-5", null)).toBe("Opus 5.5");
    expect(chipText("claude", null, "max"), "an effort with no model is no chip").toBeNull();
    const out = html(createElement(StageHeader, headerProps({ model: "claude-opus-5-5", effort: "xhigh" })));
    expect(out).toContain('aria-label="Claude Code · Opus 5.5 · xhigh"');
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

  it("keeps focus where it is when ⌨ is pressed, so the click still reads who had the keys", () => {
    // A mousedown that moved focus would blur the pane's textarea, hand the
    // keys to the board, and the click would then put them straight back.
    const keys = button(StageHeader(headerProps({ keysOwner: "pane" })), "Type into the session")!;
    const down = { preventDefault: vi.fn() };
    (keys.props.onMouseDown as (e: unknown) => void)(down);
    expect(down.preventDefault).toHaveBeenCalled();
  });

  it("promises nothing about a session when there is none behind the stage", () => {
    expect(button(StageHeader(headerProps({ nothingRunning: true })), CLOSE_EMPTY_LABEL)).not.toBeNull();
    expect(button(StageHeader(headerProps({ nothingRunning: true, takeover: true })), BACK_EMPTY_LABEL)).not.toBeNull();
    expect(CLOSE_EMPTY_LABEL + BACK_EMPTY_LABEL).not.toMatch(/keeps running/);
    const empty = html(createElement(TerminalStage, {
      show: { kind: "empty" }, geometry: stageGeometry({ appW: 1440, bodyH: 848, cellW: 8, cellH: 18, expanded: false, narrow: false, storedCols: null }),
      cell: ASSUMED_CELL, readToken: () => "", expanded: false, firstRun: false, asksWaiting: false,
      onClose: vi.fn(), onToggleExpand: vi.fn(), onFirstRunDone: vi.fn(), onNewSession: vi.fn(), onCols: vi.fn(), onColsReset: vi.fn(),
    } as TerminalStageProps));
    expect(empty).toContain(`aria-label="${CLOSE_EMPTY_LABEL}"`);
  });

  it("marks ✕ as the release chord's last landing, drawn in every state", () => {
    for (const over of [{}, { canType: false }, { takeover: true }, { expanded: true }]) {
      const close = one(StageHeader(headerProps(over)), el => el.type === "button" && el.props["data-stage-close"] === true);
      expect(close, JSON.stringify(over)).not.toBeNull();
    }
  });

  it("leads with ‹ Board in the takeover, with the same promise as ✕, and drops ⤢", () => {
    const tree = StageHeader(headerProps({ takeover: true }));
    expect(button(tree, BACK_LABEL)).not.toBeNull();
    expect(BACK_LABEL).toMatch(/keeps running/);
    expect(button(tree, "Give the Command Panel the width")).toBeNull();
    expect(button(StageHeader(headerProps()), "Give the Command Panel the width")).not.toBeNull();
    expect(button(StageHeader(headerProps({ expanded: true })), "Give the board its room back")).not.toBeNull();
  });

  it("names ⤢ full screen where it is — in the takeover too — and ⤡ by what it does", () => {
    expect(button(StageHeader(headerProps({ canFull: true })), FULL_LABEL)).not.toBeNull();
    expect(FULL_LABEL).toMatch(/Ctrl\+W/);
    expect(button(StageHeader(headerProps({ canFull: true, expanded: true, full: true })), FULL_LEAVE_LABEL)).not.toBeNull();
    // In the takeover there is no width to give, but full screen still helps.
    expect(button(StageHeader(headerProps({ takeover: true, canFull: true })), FULL_LABEL)).not.toBeNull();
    // Refused by the browser: the stage is only wide, and ⤡ says so.
    expect(button(StageHeader(headerProps({ canFull: true, expanded: true, full: false })), "Give the board its room back")).not.toBeNull();
  });

  it("keeps the pane's keys across ⤢, so typing carries on in the wider stage", () => {
    const expand = button(StageHeader(headerProps({ keysOwner: "pane" })), "Give the Command Panel the width")!;
    const down = { preventDefault: vi.fn() };
    (expand.props.onMouseDown as (e: unknown) => void)(down);
    expect(down.preventDefault).toHaveBeenCalled();
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

  it("cuts a long fact with an ellipsis, in a box of its own, with the whole line as its title", () => {
    const target = { kind: "C" as const, label: "Ended.", adoptable: true };
    const fact = "Claude Code · /home/u/scratch/layout/ws/data-pipeline-with-a-long-name";
    const out = html(createElement(StateCard, bodyProps({ kind: "not-attachable", target, stillRunning: false, busy: false }, { context: { prompt: null, fact } })));
    expect(out).toContain(`title="${fact}"`);
    expect(out).toContain(`<span class="ts-fact-text">${fact}</span>`);
    const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = /\.ts-fact-text\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule, "a flex row's bare text never takes the row's ellipsis").toMatch(/min-width:\s*0/);
    expect(rule).toMatch(/text-overflow:\s*ellipsis/);
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

  it("draws the engine's state with its sentence, checking again in place, and only Not now where there is nothing to check", () => {
    const sentence = "The Command Panel's engine is not installed on this machine.";
    const props = bodyProps({ kind: "error", message: sentence, code: "not-installed", busy: false });
    expect(textOf(StateCard(props))).toContain(sentence);
    expect(all(StateCard(props), el => el.type === "button").map(b => textOf(b))).toEqual(["Check again", "Not now"]);
    press(button(StateCard(props), "Check again"));
    expect(props.onRetry).toHaveBeenCalled();
    const busy = button(StateCard(bodyProps({ kind: "error", message: sentence, code: "not-installed", busy: true })), "Checking…")!;
    expect(busy.props["aria-busy"]).toBe(true);
    expect(busy.props.disabled, "busy, never disabled (#620)").toBeUndefined();

    const elsewhere = StateCard(bodyProps({ kind: "error", message: "The Command Panel is not available on this platform yet.", code: "unsupported", busy: false }));
    const buttons = all(elsewhere, el => el.type === "button");
    expect(buttons.map(b => textOf(b)), "nothing to check on a platform with no panel").toEqual(["Not now"]);
    expect(buttons[0].props["data-stage-land"], "and the keys land on it").toBe(true);

    // Any other failure keeps FP-01's Try again.
    expect(all(StateCard(bodyProps({ kind: "error", message: "The deck did not answer." })), el => el.type === "button").map(b => textOf(b)))
      .toEqual(["Try again", "Not now"]);
  });

  it("says the deck is fetching its own tmux, what that means, and lets the stage be left meanwhile", () => {
    const props = bodyProps({ kind: "tmux-installing" });
    const out = html(createElement(StateCard, props));
    expect(out).toContain("tmux · setting up");
    expect(out).toContain("nothing is installed on the system");
    const buttons = all(StateCard(props), el => el.type === "button");
    expect(buttons.map(b => textOf(b))).toEqual(["Not now"]);
    press(buttons[0]);
    expect(props.onNotNow).toHaveBeenCalled();
  });

  it("shows how far the download has got: a bar that fills, then the check", () => {
    const bar = (progress?: Parameters<typeof setupShare>[0]) => {
      const el = all(StateCard(bodyProps({ kind: "tmux-installing", ...(progress ? { progress } : {}) })), e => e.props?.role === "progressbar")[0];
      const fill = all(el, e => e.type === "i")[0];
      return { el, fill };
    };
    // Before the deck has said: a segment that travels, and no number to read.
    const first = bar();
    expect(first.el.props["aria-label"]).toBe("Fetching tmux");
    expect(first.el.props["data-unknown"]).toBe(true);
    expect(first.el.props["aria-valuenow"]).toBeUndefined();
    expect(first.el.props["aria-valuetext"]).toBe("Starting the download…");
    expect(first.fill.props.style).toBeUndefined();

    const half = bar({ stage: "downloading", received: 550_000, total: 1_100_000 });
    expect(half.el.props["data-unknown"]).toBeUndefined();
    expect(half.el.props["aria-valuenow"]).toBe(50);
    expect(half.el.props["aria-valuetext"]).toBe("0.6 of 1.1 MB");
    expect(half.fill.props.style).toEqual({ transform: "scaleX(0.5)" });
    expect(html(createElement(StateCard, bodyProps({ kind: "tmux-installing", progress: { stage: "downloading", received: 550_000, total: 1_100_000 } }))))
      .toContain("0.6 of 1.1 MB");

    const checking = bar({ stage: "checking" });
    expect(checking.el.props["aria-valuenow"]).toBe(100);
    expect(checking.el.props["aria-valuetext"]).toBe("Checking the build…");

    // No size given: the bytes, and the travelling segment.
    expect(setupShare({ stage: "downloading", received: 300_000, total: null })).toBeNull();
    expect(setupLine({ stage: "downloading", received: 300_000, total: null })).toBe("0.3 MB");
    expect(setupShare({ stage: "downloading", received: 2_000, total: 1_000 }), "never past full").toBe(1);
  });

  it("says why the deck's own tmux is not there before the install line, when it tried", () => {
    const out = html(createElement(StateCard, bodyProps({
      kind: "tmux-missing", reason: "missing", install: "sudo apt install tmux", download: "download_failed", busy: false,
    })));
    expect(out).toContain(downloadNote("download_failed"));
    expect(out.indexOf("could not download"), "the why comes first").toBeLessThan(out.indexOf("sudo apt install tmux"));
    expect(html(createElement(StateCard, bodyProps({ kind: "tmux-missing", reason: "missing", busy: false }))))
      .not.toContain('class="ts-note"');
    expect(downloadNote("checksum_mismatch")).toMatch(/not the build this deck trusts/);
    expect(downloadNote("does_not_run")).toMatch(/would not run/);
    expect(downloadNote("something new")).toBe("The deck could not set up its own tmux.");
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
      { kind: "tmux-installing" }, { kind: "tmux-missing", reason: "too-old", busy: false },
      { kind: "error", message: "The deck did not answer." },
      { kind: "error", message: "The Command Panel's engine is not installed on this machine.", code: "not-installed", busy: false },
      { kind: "error", message: "The Command Panel is not available on this platform yet.", code: "unsupported", busy: false },
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

  it("does not claim the keys reach the session while the pane reconnects", () => {
    const out = html(createElement(KeysBar, barProps({ owner: "pane", reconnecting: true })));
    expect(out).toContain("nothing typed now is sent");
    expect(out).not.toContain("Typing into");
  });

  it("leaves out j k in the takeover, where there is no navigator to step through", () => {
    expect(html(createElement(KeysBar, barProps({ takeover: true })))).not.toMatch(/sessions<\/span>/);
    expect(html(createElement(KeysBar, barProps({ takeover: true })))).toContain("Keys on the board");
  });

  it("says what the pane refused, in place of the hints, until it is cleared", () => {
    const out = html(createElement(KeysBar, barProps({ owner: "pane", notice: "That paste is over 1 MB." })));
    expect(out).toContain("That paste is over 1 MB.");
    expect(out).not.toContain("Typing into");
    expect(html(createElement(KeysBar, barProps({ owner: "pane", notice: null })))).toContain("Typing into");
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
    expect(out).toContain("closes the Command Panel; the session keeps running");
    press(button(KeysBar(props), "Got it"));
    expect(props.onFirstRunDone).toHaveBeenCalled();
  });

  it("says the first-run line whole without its key names, for a fingertip", () => {
    // On a phone the coarse-pointer sheet drops the bar's key chips, and the
    // line read "Typing goes to the session — included. closes the Command
    // Panel…". The clause that names Esc is its own element, so it goes
    // whole (the sheet's side is "the keys bar under a fingertip"), and ✕,
    // the header's control rather than a key, is marked to stay.
    const out = html(createElement(KeysBar, barProps({ owner: "pane", firstRun: true })));
    const line = out.match(/<span class="ts-first">([\s\S]*?)<\/span><button/)?.[1];
    expect(line, "the sentence is its own element, before Got it").toBeTruthy();
    const words = (s: string) => s.replace(/<[^>]+>/g, "");
    expect(words(line!)).toBe("Typing goes to the session — Esc included. ✕ closes the Command Panel; the session keeps running.");
    const keys = line!.match(/<span class="ts-first-keys">([\s\S]*?)<\/span>/)?.[0];
    expect(keys && words(keys)).toBe(" — Esc included");
    expect(words(line!.replace(keys!, ""))).toBe("Typing goes to the session. ✕ closes the Command Panel; the session keeps running.");
    expect(line).toContain('<kbd class="ts-kbd" data-control="true">✕</kbd>');
    expect(line).toContain('<kbd class="ts-kbd">Esc</kbd>');
    expect(out.indexOf(">Got it</button>"), "Got it follows the sentence").toBeGreaterThan(out.indexOf("keeps running."));
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
    expect(out).toMatch(/^<section class="ts-stage" role="region" aria-label="Command Panel — paycore" data-kind="empty"/);
    expect(out).toContain("--session-hue:270");
    expect(out).toContain("--ts-term-top:14px");
    expect(out).toContain("--ts-head-h:64px");
    expect(out, "the divider is a separator with a value").toMatch(/role="separator" aria-orientation="vertical" aria-label="Command Panel width" aria-valuemin="80" aria-valuemax="134" aria-valuenow="120" aria-valuetext="120 columns"/);
  });

  it("calls the empty stage what it is, with nothing on the spine", () => {
    const out = html(createElement(TerminalStage, stageProps({ kind: "empty" })));
    expect(out).toContain('aria-label="Command Panel — No session open"');
    expect(out).toContain("data-empty");
    expect(stageName({ kind: "empty" })).toBe("No session open");
  });

  it("draws no divider in the takeover, where there is no board to divide from", () => {
    const narrow = stageGeometry({ appW: 760, bodyH: 650, cellW: 8, cellH: 18, expanded: false, narrow: true, storedCols: null });
    const out = html(createElement(TerminalStage, stageProps(session, { geometry: narrow })));
    expect(out).toContain("data-takeover");
    expect(out).not.toContain('role="separator"');
  });

  it("draws no divider while expanded: the stage is as wide as it goes, and ⤢ is the way back", () => {
    const out = html(createElement(TerminalStage, stageProps(session, { expanded: true })));
    expect(out).not.toContain('role="separator"');
  });

  it("offers to start a launch's agent again when it exits before the board has its session, and to reopen a session", () => {
    // Codex updating itself at its first screen ("Please restart Codex")
    // exits as a launch: there is no conversation, and for a Codex no id, to
    // reopen, so Reopen here did nothing.
    const act = { reopen: vi.fn(), launchAgain: vi.fn(), attachAgain: vi.fn() };
    const codex: StageShow = { kind: "launch", agent: "codex", cwd: "/w/ccdeck", name: "ccdeck", hue: 3, key: "n1" };
    const ended = endView({ kind: "ended" }, codex, act);
    expect(ended).toMatchObject({ sentence: "Codex exited — this is its last frame.", action: "Start Codex again" });
    ended?.onAction();
    expect(act.launchAgain).toHaveBeenCalledTimes(1);
    expect(act.reopen).not.toHaveBeenCalled();
    expect(endView({ kind: "ended" }, { ...codex, agent: "claude" }, act)).toMatchObject({ action: "Start Claude Code again" });
    expect(endView({ kind: "ended" }, codex, { ...act, launchAgain: undefined }), "with nothing to start it, the old answer").toMatchObject({ action: "Reopen here" });

    const gone: StageShow = { ...session, session: { ...(session as Extract<StageShow, { kind: "session" }>).session, endedAgo: "14m ago" } } as StageShow;
    const reopen = endView({ kind: "ended" }, gone, act);
    expect(reopen).toMatchObject({ sentence: "The session ended 14m ago — this is its last frame.", action: "Reopen here" });
    reopen?.onAction();
    expect(act.reopen).toHaveBeenCalledTimes(1);
    expect(endView({ kind: "detached" }, session, act)).toMatchObject({ action: "Attach again" });
    expect(endView({ kind: "live", sizeOwner: "panel", readOnly: false } as StagePhase, session, act)).toBeNull();
  });

  it("hands the session hook a subject that names the session, or the launch, and nothing else", () => {
    expect(subjectOf(session)).toEqual({ kind: "session", ref: { sessionId: "s1", provider: "claude", cwd: "/w/paycore" } });
    expect(subjectOf({ kind: "launch", agent: "codex", cwd: "/w", name: "w", hue: 3, key: "n1" })).toEqual({ kind: "launch", agent: "codex", cwd: "/w", key: "n1" });
    expect(subjectOf({ kind: "empty" })).toEqual({ kind: "empty" });
    expect(subjectOf({ ...session, launch: "n1" } as StageShow), "and the launch a session came from, so its pane is kept")
      .toEqual({ kind: "session", ref: { sessionId: "s1", provider: "claude", cwd: "/w/paycore" }, launch: "n1" });
  });
});

describe("the keys typed before the pane could take them", () => {
  const web = (path: string) => withoutComments(readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8"));

  it("go to the pane that met their request, after the focus, and are let go by any other end of it", () => {
    // The hold itself is use-stage.test.ts's; the request's ends are
    // use-focus-request.test.ts's. This is the wire between them, which needs
    // a real xterm to run.
    const stage = web("components/terminal/TerminalStage.tsx");
    expect(stage).toMatch(/focus: request => \{\s*session\.focus\(\);\s*const ahead = p\.takeTypeAhead\?\.\(request\);\s*if \(ahead\) session\.type\(ahead\);\s*\}/);
    expect(stage).toMatch(/unmet: request => \{ p\.takeTypeAhead\?\.\(request\); \}/);
    expect(web("components/terminal/StageShell.tsx")).toContain("takeTypeAhead={stage.takeTypeAhead}");
  });

  it("stay with a launch the board names before its pane is live: the session goes on from the launch's key", () => {
    // SessionStart can reach the board before the launch's pane takes keys (a
    // slow page, a quick agent). The stage then shows the session on the same
    // pane, and the launch's request, with the keys it holds, goes on with it
    // (the hook's side is use-focus-request.test.ts's).
    const launch: StageShow = { kind: "launch", agent: "claude", cwd: "/w/paycore", name: "paycore", hue: 3, key: "n1" };
    expect(subjectKey(subjectOf(launch)), "the key the launch's request was made under").toBe("launch:n1");
    const stage = web("components/terminal/TerminalStage.tsx");
    expect(stage).toMatch(/from: subject\.kind === "session" && subject\.launch \? `launch:\$\{subject\.launch\}` : null,/);
  });

  it("meet a request only on the shown subject's own pane or card, never the last one's", () => {
    // In the render that moves the stage the session hook's snapshot is still
    // the last subject's: a live pane there spent the next session's request,
    // and its typed keys, on a pane about to attach elsewhere.
    const stage = web("components/terminal/TerminalStage.tsx");
    expect(stage).toMatch(/const current = session\.subject === key;/);
    expect(stage).toMatch(/typing: current && typing,/);
    expect(stage).toMatch(/settled: current && settlesFocus\(phase\)/);
  });
});

describe("asking for the session again from the stage", () => {
  const web = (path: string) => withoutComments(readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8"));

  it("asks for the keys too, as a card click does, so they are in the pane it comes back with", () => {
    // Try again after tmux stalled brought the pane back with the keys left on
    // the board ("↵ type here"): the button had gone, and the focus with it.
    // The request is the shell's own (use-focus-request.ts): met by the pane,
    // or landed on the card's action again if the retry fails.
    const stage = web("components/terminal/TerminalStage.tsx");
    expect(stage).toMatch(/const retry = \(\) => \{\s*if \(phase\.kind === "tmux-missing" && phase\.busy\) return;\s*session\.retry\(\);\s*p\.onWantKeys\?\.\(\);\s*\};/);
    expect(stage).toContain("onRetry={retry}");
    expect(stage).toMatch(/action: "Attach again", onAction: act\.attachAgain \}/);
    expect(stage).toMatch(/endView\(phase, p\.show, \{[^}]*attachAgain: retry \}\)/);
    expect(stage).not.toContain("session.retry}");
    expect(web("components/terminal/StageShell.tsx")).toContain("onWantKeys={stage.focusPane}");
  });

  it("starts an exited launch again as a new launch, in its folder with its options", () => {
    // A new key, so the deck starts an agent rather than finding the one that exited.
    expect(web("components/terminal/StageShell.tsx"))
      .toContain('onLaunchAgain={show.kind === "launch" ? () => stage.launch(show.agent, show.cwd, show.options) : undefined}');
    expect(web("components/terminal/TerminalStage.tsx")).toContain("launchAgain: p.onLaunchAgain");
  });

  it("reports a recognised Codex with the launch it was recognised for", () => {
    // The stage takes it only while that launch is still the one on it (use-stage's onLaunched).
    expect(web("components/terminal/StageShell.tsx"))
      .toContain("useCodexLaunch(shell.target, agents, (sessionId, key) => stage.onLaunched({ sessionId, key }));");
  });

  it("lands a request still holding keys with a catch, so a sentence mid-way never presses the card", () => {
    // Try again with tmux still stalled: the retry failed, a new Try again took
    // the focus plainly, and the rest of the sentence pressed it or took the
    // next ask (landFocus's own rule is stage-focus-landing.test.ts's).
    const stage = web("components/terminal/TerminalStage.tsx");
    expect(stage).toContain("land: request => landFocus(rootRef.current, p.holdsTypeAhead?.(request) ?? null),");
    expect(web("components/terminal/StageShell.tsx")).toContain("holdsTypeAhead={stage.holdsTypeAhead}");
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
    expect(hook).toMatch(/import\("@xterm\/addon-unicode-graphemes"\)/);
    expect(hook).toMatch(/import\("@xterm\/addon-web-links"\)/);
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

describe("the keys bar under a fingertip", () => {
  it("drops the keys it names under a coarse pointer, and keeps type here as its button", () => {
    const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
    const coarse = [...css.matchAll(/@media \(pointer: coarse\) \{([\s\S]*?)\n\}/g)].map(m => m[1]).join("\n");
    expect(coarse).toContain(".ts-keys .ts-hint:not(:has(button)) { display: none; }");
    expect(coarse).toContain(".ts-keys .ts-kbd { display: none; }");
  });

  it("drops the first-run line's Esc clause whole, and keeps ✕ there", () => {
    const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
    const coarse = [...css.matchAll(/@media \(pointer: coarse\) \{([\s\S]*?)\n\}/g)].map(m => m[1]).join("\n");
    expect(coarse).toContain(".ts-keys .ts-first-keys { display: none; }");
    // Outranks the chips' own rule above: one attribute more.
    const keep = coarse.indexOf(".ts-keys .ts-kbd[data-control] { display: inline-flex; }");
    expect(keep).toBeGreaterThan(coarse.indexOf(".ts-keys .ts-kbd { display: none; }"));
  });

  it("wraps the first-run line on a narrow stage, so Got it is never pushed off the end", () => {
    // The bar is nowrap, and the sentence kept its one line's width: at 390px
    // it ran past the bar, and Got it was drawn off screen, out of reach.
    const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
    const at = css.indexOf(".ts-first {");
    expect(at, ".ts-first has a rule").toBeGreaterThan(-1);
    const first = css.slice(at, css.indexOf("}", at));
    expect(first).toContain("min-width: 0");
    expect(first).toContain("white-space: normal");
    // In the takeover two lines of 15px fit the bar's 36px; past that the bar
    // grows rather than spilling the line over the terminal. Beside the board
    // the one line keeps the type it had.
    expect(first).not.toContain("line-height");
    expect(css).toContain(".ts-stage[data-takeover] .ts-first { line-height: 15px; }");
    expect(css).toMatch(/\.ts-bar:has\(\.ts-first\) \{ height: auto; min-height: 36px;/);
  });
});

describe("the Command Panel under a fingertip (#884)", () => {
  // Under a coarse pointer the deck's floor is 32px (touch-targets-884). The
  // keys bar's buttons were 26px tall, the cards' and New session's 30px, the
  // popover's strips and rows 19–20px, the header's glyphs 24px boxes whose
  // drawn reach was 28px wide, and the divider 12px wide.
  const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
  /** Every `@media (pointer: coarse)` block's rules, by brace depth. */
  const coarseRules = (() => {
    const open = "@media (pointer: coarse) {";
    const out: { sels: string[]; body: string }[] = [];
    for (let at = css.indexOf(open); at > -1; at = css.indexOf(open, at + open.length)) {
      let depth = 0, i = at + open.length - 1;
      for (; i < css.length; i++) {
        if (css[i] === "{") depth++;
        else if (css[i] === "}" && --depth === 0) break;
      }
      for (const m of css.slice(at + open.length, i).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        out.push({ sels: m[1].split(",").map(s => s.trim().replace(/\s+/g, " ")).filter(Boolean), body: m[2] });
      }
    }
    return out;
  })();
  const coarse = (sel: string) => coarseRules.filter(r => r.sels.includes(sel)).map(r => r.body).join("\n");
  /** A property's px value in a rule's body, signed; NaN when it has none. */
  const px = (body: string, prop: string) => Number(new RegExp(`(?:^|[;\\s])${prop}:\\s*(-?\\d+)px`).exec(body)?.[1] ?? NaN);
  /** The rule outside every @media block for `sel`, as the desktop draws it. */
  const plain = (sel: string) => {
    const at = css.indexOf(`\n${sel} {`);
    expect(at, `${sel} has a rule`).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf("}", at));
  };

  it("stands every button of the panel's bars, cards and New session at 32px", () => {
    for (const sel of [
      ".ts-keys .btn", // Got it, type here, Reopen here, Attach again, Start … again
      ".ts-asks .ts-next", // Next ask, Answer
      ".ts-acts .btn", // the cards: New session, Reopen here, Check again, Try again, Not now
      ".ns-pop .uh-range-btn", // New session's agent, model and permission strips
      ".ns-pop .ns-option", // its projects
      ".ns-pop .ns-field", // its folder field
      ".ns-pop .ns-acts .btn", // Cancel, Start
      ".board-nav button.btn.nav-new", // the navigator's New session
    ]) {
      expect(px(coarse(sel), "min-height"), sel).toBeGreaterThanOrEqual(32);
    }
    // The rail's New session is a square, as wide as it is tall.
    expect(px(coarse('.board-nav[data-density="rail"] button.btn.nav-new'), "width")).toBeGreaterThanOrEqual(32);
  });

  it("gives the header's glyphs a 32px square each, whose reach never overlaps a neighbour's", () => {
    // ✕, ⤢, ⌨, ‹ and the install line's copy: the deck's .glyph-btn, a 24px
    // box whose drawn target reached 4px above and below and 2px aside — 28px
    // wide, and ⤢'s and ✕'s overlapping in their 2px gap.
    const glyph = coarse(".ts-stage .glyph-btn");
    expect(px(glyph, "min-width"), "min-width").toBeGreaterThanOrEqual(32);
    expect(px(glyph, "min-height"), "min-height").toBeGreaterThanOrEqual(32);
    expect(coarse(".ts-stage .glyph-btn::after")).toMatch(/inset:\s*-4px 0;/);
    // In the takeover ‹ leads, 8px wider: the spine moves with the name it
    // stands before (8px padding, a 32px ‹, the header's 12px gap).
    expect(px(coarse(".ts-stage[data-takeover] .ts-spine"), "left")).toBe(8 + 32 + 12);
  });

  it("widens the divider to 32px over the stage's own inset, its line still on the edge", () => {
    // 8px over the navigator and 24px over the stage, which is the stage's
    // inset before its first column (INSET_LEFT): no cell is covered.
    const div = coarse(".ts-divider");
    const left = px(div, "left");
    expect(px(div, "width")).toBe(32);
    expect(left + 32, "no further into the stage than its inset").toBeLessThanOrEqual(24);
    // The hairline and the grip stay centred on the stage's edge, as they
    // are drawn beside a mouse (-6px + 5px; -6px + 2px).
    expect(left + px(coarse(".ts-divider::before"), "left")).toBe(-6 + 5);
    expect(left + px(coarse(".ts-grip"), "left")).toBe(-6 + 2);
  });

  it("keeps the grown buttons inside the keys bar's own height, the first-run line's included", () => {
    // The bar is drawn at its height with a 1px rule on top, and with the
    // first-run line as tall as its content plus 1px above and below: a
    // button that needed more would grow the bar under every fingertip.
    const barH = px(plain(".ts-bar"), "height");
    expect(barH).toBe(36);
    expect(css).toMatch(/\.ts-bar:has\(\.ts-first\) \{ height: auto; min-height: 36px; padding-block: 1px; \}/);
    for (const sel of [".ts-keys .btn", ".ts-asks .ts-next"]) {
      expect(px(coarse(sel), "min-height") + 1 + 2, sel).toBeLessThanOrEqual(barH);
    }
  });

  it("leaves the panel as a mouse draws it", () => {
    expect(plain(".ts-keys .btn")).toContain("min-height: 26px");
    expect(plain(".ts-asks .ts-next")).toContain("min-height: 26px");
    expect(plain(".ts-divider")).toMatch(/left: -6px;[\s\S]*width: 12px;/);
    expect(plain(".ts-stage[data-takeover] .ts-spine")).toContain("left: 44px");
    // The floors above are the coarse pointer's alone: no rule a mouse reads
    // gives these a size of their own.
    for (const sel of [".ts-stage .glyph-btn", ".ts-acts .btn", ".ns-pop .uh-range-btn", ".ns-pop .ns-option", ".ns-pop .ns-field", ".board-nav button.btn.nav-new"]) {
      const at = css.indexOf(`\n${sel} {`);
      if (at > -1) expect(css.slice(at, css.indexOf("}", at)), sel).not.toMatch(/min-(height|width)/);
    }
  });
});

describe("the stage's place in the phone's grid", () => {
  it("stays in the one track a phone has, with a left panel open over the canvas", () => {
    // Beside a left panel the stage moves to the canvas's second track; under
    // 641px the panel lies over the canvas and the grid has one track, so a
    // stage left in a second one would add it back and the canvas would fall
    // to nothing on every other measure.
    const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
    const phone = [...css.matchAll(/@media \(max-width: 640px\) \{([\s\S]*?)\n\}/g)].map(m => m[1]).join("\n");
    expect(phone).toMatch(/\.app:has\(\.session-list\) \.stage-dock,\s*\.app:has\(\.accounts-panel\) \.stage-dock \{ grid-column: 1; \}/);
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
