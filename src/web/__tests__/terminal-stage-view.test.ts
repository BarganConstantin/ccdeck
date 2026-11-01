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
import StageHeader, { BACK_EMPTY_LABEL, BACK_LABEL, CLOSE_EMPTY_LABEL, CLOSE_LABEL, FULL_LABEL, FULL_LEAVE_LABEL, type StageHeaderProps } from "../components/terminal/StageHeader";
import StageBody, { EMPTY_NEW_SESSION_ID, STILL_RUNNING_NOTE, StateCard, downloadNote, setupLine, setupShare, tmuxFact, type StageBodyProps } from "../components/terminal/StageBody";
import KeysBar, { ArrivalNote, AsksTrack, type KeysBarProps } from "../components/terminal/KeysBar";
import { ASSUMED_CELL, stageGeometry } from "../stage-geometry";
import { POPOVER_MARGIN } from "../popover-place";
import { LAUNCHED_UNREACHABLE, PROVENANCE_UNKNOWN, launchedUnreachable, provenanceUnknown, type StagePhase, type StageStatus } from "../components/terminal/stage-model";
import { subjectKey } from "../use-terminal-session";

const html = (el: ReactElement) => renderToStaticMarkup(el);
const press = (el: Drawn | null, event: Record<string, unknown> = {}) => {
  expect(el, "the control is drawn").not.toBeNull();
  (el!.props.onClick as (e: unknown) => void)({ preventDefault() {}, ...event });
};
const button = (tree: unknown, name: string) =>
  one(tree, el => el.type === "button" && (el.props["aria-label"] === name || textOf(el).trim() === name));

/** The engine's own refusals of a launch, in its own words: the Windows
 *  console's (agent-missing, full, stopping, host-generations), and for
 *  `exists`, which only an attach is ever answered, the tmux backend's. */
const ENGINE_SAID = {
  "agent-missing": "Claude Code is not installed here as a program the deck can start. Install it with the standalone installer or WinGet.",
  exists: "The deck is already attached to that session.",
  full: "The deck is running as many sessions as it can; end one to start another.",
  stopping: "The deck is stopping, so it starts nothing new.",
  "host-generations": "Sessions still run on two older session hosts. End or restart them to start new sessions.",
} as const;

const working: StageStatus = { state: "working", phrase: "working", tool: "Task", arg: "3 subagents running", seconds: "7m 38s" };

function headerProps(over: Partial<StageHeaderProps> = {}): StageHeaderProps {
  return {
    identity: "session:a", name: "paycore", provider: "claude", status: working,
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
    expect(out).toMatch(/class="ts-meta-state">working<.*class="ts-meta-rest">· Task · 3 subagents running · 7m 38s</);
  });

  it("says waiting with how long, beside the rail's alert glyph and no ping", () => {
    const out = html(createElement(StageHeader, headerProps({ status: { state: "waiting", phrase: "waiting", emphasis: "6m", tool: "Bash", arg: "git push" } })));
    // CHANGED ON PURPOSE: Figma V4 (Term header 22:13272) draws "waiting 6m" in
    // one regular weight, the state colour doing the work; it was bold.
    expect(out).toContain("waiting 6m");
    expect(out).not.toContain("<b>");
    expect(out).toContain('data-glyph="waiting"');
    expect(out).not.toContain("ap-pulse");
    expect(out).not.toMatch(/blocked/i);
  });

  it("names the provider in words for a screen reader, where the model chip used to say it", () => {
    // V4's Term header has no model chip (the rail's row and the agent card
    // carry the model); the provider is still said, hidden from the eye.
    const out = html(createElement(StageHeader, headerProps()));
    expect(out).toContain('<span class="vis-hidden">Claude Code</span>');
    expect(html(createElement(StageHeader, headerProps({ provider: "codex" })))).toContain('<span class="vis-hidden">Codex</span>');
    expect(out).not.toContain("model-chip");
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

  it("on Windows, says a session this deck launched and cannot reach is its own launch, not ended, with no Reopen here", () => {
    const target = { kind: "C" as const, label: "This session was started outside the deck, so there is no pane to attach to.", adoptable: true };
    const phase: StagePhase = { kind: "not-attachable", target, stillRunning: false, busy: false };
    const ours = bodyProps(phase, { windows: true, launched: true });
    const out = html(createElement(StateCard, ours));
    expect(out).toContain(LAUNCHED_UNREACHABLE);
    expect(LAUNCHED_UNREACHABLE).toBe("This session was started from the Command Panel, but this deck cannot reach it: it may be running under another Windows sign-in, or its owner cannot be verified from here. It has not been ended.");
    expect(out).not.toContain(target.label);
    expect(out).not.toContain("Reopen here");
    expect(out).not.toMatch(/has ended|tmux/);
    const tree = StateCard(ours);
    press(button(tree, "Not now"));
    expect(ours.onNotNow).toHaveBeenCalled();
    expect(launchedUnreachable(target, { windows: true, launched: true })).toBe(true);

    // No launch record, or not Windows: the deck's own sentence and Reopen here, as before.
    for (const over of [{ windows: true }, { windows: true, launched: false }, { launched: true }, {}]) {
      const said = html(createElement(StateCard, bodyProps(phase, over)));
      expect(said, JSON.stringify(over)).toContain(target.label);
      expect(said, JSON.stringify(over)).toContain("Reopen here");
      expect(said, JSON.stringify(over)).not.toContain(LAUNCHED_UNREACHABLE);
    }
    // Only case C: a launched session that has gone is still said to be gone.
    const gone = { kind: "gone" as const, label: "This session has ended.", adoptable: true };
    expect(launchedUnreachable(gone, { windows: true, launched: true })).toBe(false);
  });

  it("after a reload, tells the three cases apart from the deck's record: its launch, outside the deck, or cannot tell (F6-R)", () => {
    const label = "This session was started outside the deck, so there is no pane to attach to.";
    const card = (provenance: "panel" | "external" | "unknown" | undefined, over: Record<string, unknown> = { windows: true }) => {
      const target = { kind: "C" as const, label, adoptable: true, ...(provenance ? { provenance } : {}) };
      const phase: StagePhase = { kind: "not-attachable", target, stillRunning: false, busy: false };
      return { target, out: html(createElement(StateCard, bodyProps(phase, over))) };
    };

    // The tab that launched it is gone (no `launched`): the deck's record says it was the panel's.
    const panel = card("panel");
    expect(panel.out).toContain(LAUNCHED_UNREACHABLE);
    expect(panel.out).not.toContain(label);
    expect(panel.out).not.toContain("Reopen here");
    expect(launchedUnreachable(panel.target, { windows: true })).toBe(true);
    expect(provenanceUnknown(panel.target, { windows: true })).toBe(false);

    // Genuinely outside the deck: its own sentence, and Reopen here as before.
    const external = card("external");
    expect(external.out).toContain(label);
    expect(external.out).toContain("Reopen here");
    expect(external.out).not.toContain(LAUNCHED_UNREACHABLE);
    expect(external.out).not.toContain(PROVENANCE_UNKNOWN);

    // The deck cannot tell: neither claim, nothing ended, and no Reopen here (it fails closed).
    const unknown = card("unknown");
    expect(unknown.out).toContain(PROVENANCE_UNKNOWN);
    expect(PROVENANCE_UNKNOWN).toBe("This deck cannot reach this session, and cannot tell whether it was started from the Command Panel: it may be running under another Windows sign-in or in a terminal outside the deck. It has not been ended.");
    expect(unknown.out).not.toContain(label);
    expect(unknown.out).not.toContain(LAUNCHED_UNREACHABLE);
    expect(unknown.out).not.toContain("Reopen here");
    expect(unknown.out).not.toMatch(/has ended/);
    expect(provenanceUnknown(unknown.target, { windows: true })).toBe(true);

    // This tab's own launch outranks a record that cannot tell.
    const launchedHere = card("unknown", { windows: true, launched: true });
    expect(launchedHere.out).toContain(LAUNCHED_UNREACHABLE);
    expect(provenanceUnknown(launchedHere.target, { windows: true, launched: true })).toBe(false);

    // Off Windows the deck's own sentence stands whatever the record says; and a
    // target with no provenance (an older answer) reads as before.
    for (const provenance of ["panel", "external", "unknown", undefined] as const) {
      const off = card(provenance, {});
      expect(off.out, String(provenance)).toContain(label);
      expect(off.out, String(provenance)).toContain("Reopen here");
    }
    expect(card(undefined).out).toContain(label);
    expect(card(undefined).out).toContain("Reopen here");

    // Only case C.
    for (const provenance of ["panel", "unknown"] as const) {
      const gone = { kind: "gone" as const, label: "This session has ended.", adoptable: true, provenance };
      expect(launchedUnreachable(gone, { windows: true })).toBe(false);
      expect(provenanceUnknown(gone, { windows: true })).toBe(false);
    }
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

  it("draws a launch the engine refused as the engine's sentence with Try again, nothing of tmux", () => {
    for (const sentence of Object.values(ENGINE_SAID)) {
      const card = StateCard(bodyProps({ kind: "error", message: sentence }));
      expect(textOf(card)).toContain(sentence);
      expect(all(card, el => el.type === "button").map(b => textOf(b)), "a way back, and no Check again that loops").toEqual(["Try again", "Not now"]);
      // Nothing but the engine's own words: no tmux card, no install line of the card's own.
      const rest = html(createElement(StateCard, bodyProps({ kind: "error", message: sentence }))).split(sentence).join("");
      for (const word of ["tmux", "Install", "Check again"]) expect(rest, `${word}: ${sentence}`).not.toContain(word);
    }
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
    // CHANGED ON PURPOSE: Figma V4 (Keys bar 91:536) draws one key cap "j k",
    // not two.
    expect(out).toMatch(/<kbd class="kbd">j k<\/kbd> sessions/);
    expect(out).toContain("next ask");
    const props = barProps();
    press(button(KeysBar(props), "type here"));
    expect(props.onTypeHere).toHaveBeenCalled();
    expect(html(createElement(KeysBar, barProps({ canType: false, asksWaiting: false })))).not.toMatch(/type here|next ask/);
  });

  it("does not claim the keys reach the session while the pane reconnects", () => {
    const out = html(createElement(KeysBar, barProps({ owner: "pane", reconnecting: true })));
    // CHANGED ON PURPOSE: the sentence is Figma V4's (Keys bar 91:554, owner
    // answer 18), with a full stop and a capital, not "— nothing typed now is sent".
    expect(out).toContain("Reconnecting to paycore. Nothing typed now is sent.");
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
    // CHANGED ON PURPOSE: the label is one phrase in --text (Figma 91:545); the
    // name is no longer set apart in a span of its own.
    expect(out).toContain('<span class="ts-label" data-strong="true">Typing into paycore</span>');
    expect(out).toContain("goes to the session");
    expect(out).toMatch(/<kbd class="kbd" aria-hidden="true">Ctrl\+Shift\+X<\/kbd><span class="kbd-spoken">Control Shift X<\/span> back to the board/);
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
    // line read "Typing goes to the session, included. closes the Command
    // Panel…". The clause that names Esc is its own element, so it goes
    // whole (the sheet's side is "the keys bar under a fingertip"), and ✕,
    // the header's control rather than a key, is marked to stay.
    // CHANGED ON PURPOSE: the line is Figma V4's (Keys bar 91:551): ", Esc
    // included" with a comma where it had a dash.
    const out = html(createElement(KeysBar, barProps({ owner: "pane", firstRun: true })));
    const line = out.match(/<span class="ts-first">([\s\S]*?)<\/span><button/)?.[1];
    expect(line, "the sentence is its own element, before Got it").toBeTruthy();
    const words = (s: string) => s.replace(/<[^>]+>/g, "");
    expect(words(line!)).toBe("Typing goes to the session, Esc included. ✕ closes the Command Panel; the session keeps running.");
    const keys = line!.match(/<span class="ts-first-keys">([\s\S]*?)<\/span>/)?.[0];
    expect(keys && words(keys)).toBe(", Esc included");
    expect(words(line!.replace(keys!, ""))).toBe("Typing goes to the session. ✕ closes the Command Panel; the session keeps running.");
    expect(line).toContain('<kbd class="kbd" data-control="true">✕</kbd>');
    expect(line).toContain('<kbd class="kbd">Esc</kbd>');
    expect(out.indexOf(">Got it</button>"), "Got it follows the sentence").toBeGreaterThan(out.indexOf("keeps running."));
  });

  it("turns into the end bar for a finished session, with Reopen here", () => {
    const onAction = vi.fn();
    const props = barProps({ end: { sentence: "The session ended 14m ago. This is its last frame.", action: "Reopen here", onAction } });
    const out = html(createElement(KeysBar, props));
    expect(out).toContain("The session ended 14m ago. This is its last frame.");
    // CHANGED ON PURPOSE: Figma V4 draws no square mark before the sentence.
    expect(out).not.toContain("ts-end-mark");
    expect(out).not.toContain("Keys on the board");
    press(button(KeysBar(props), "Reopen here"));
    expect(onAction).toHaveBeenCalled();
  });

  it("runs the asks: where the stage is in them, then Next ask, then no more", () => {
    const now = html(createElement(KeysBar, barProps({ asks: { position: { index: 0, total: 2 } } })));
    // CHANGED ON PURPOSE: Figma V4 (Keys bar 91:590) says "Asks  1 of 2" with
    // no segment track between the words.
    expect(now).toMatch(/Asks<\/span><span class="ts-count">1 of 2<\/span>/);
    expect(now).not.toContain("ts-track");

    const onNextAsk = vi.fn();
    const props = barProps({ asks: { resumed: "paycore", next: { name: "travel-portal", waited: "2m", tool: "Edit" } }, onNextAsk });
    const out = html(createElement(KeysBar, props));
    // CHANGED ON PURPOSE: Figma V4 (Keys bar 91:600) leads with the Done glyph,
    // not a "✓" character in --ok.
    expect(out).toMatch(/data-glyph="done"[\s\S]*paycore resumed/);
    expect(out).not.toContain("✓");
    expect(out).toContain('aria-label="Next ask: travel-portal, waiting 2m on Edit"');
    press(button(AsksTrack({ asks: props.asks!, onNextAsk }), "Next ask: travel-portal, waiting 2m on Edit"));
    expect(onNextAsk).toHaveBeenCalled();

    // CHANGED ON PURPOSE: Done glyph and "No more asks" (Figma 91:609), no "✓"
    // character; and the segments, with their fresh one, are no longer drawn.
    const clear = html(createElement(KeysBar, barProps({ asks: { clear: true } })));
    expect(clear).toMatch(/data-glyph="done"[\s\S]*No more asks/);
    expect(clear).not.toContain("✓");
    expect(html(createElement(KeysBar, barProps({ asks: { position: { index: 0, total: 3 } } }))))
      .not.toContain("<i ");
  });

  it("says once, quietly, that another session asks — and answering is a press, never automatic", () => {
    const onAnswerArrival = vi.fn();
    const props = barProps({ owner: "pane", arrival: { name: "boom-next-gen", tool: "Bash" }, onAnswerArrival });
    const out = html(createElement(KeysBar, props));
    // CHANGED ON PURPOSE: Figma V4 (Keys bar 91:583) leads with the Waiting
    // glyph (not the pulse dot), says "name asks · tool" with the name not bold,
    // then the key cap n and the word Answer, in that order.
    expect(out).toMatch(/data-glyph="waiting"[\s\S]*boom-next-gen asks · Bash/);
    expect(out).not.toMatch(/ap-pulse|<b>/);
    expect(out).toMatch(/<kbd class="kbd">n<\/kbd> Answer/);
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
    expect(out).toContain("--ts-term-top:8px");
    expect(out, "the header is drawn at its token, so the stage hands it no height").not.toContain("--ts-head-h");
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
    expect(ended).toMatchObject({ sentence: "Codex exited. This is its last frame.", action: "Start Codex again" });
    ended?.onAction();
    expect(act.launchAgain).toHaveBeenCalledTimes(1);
    expect(act.reopen).not.toHaveBeenCalled();
    expect(endView({ kind: "ended" }, { ...codex, agent: "claude" }, act)).toMatchObject({ action: "Start Claude Code again" });
    expect(endView({ kind: "ended" }, codex, { ...act, launchAgain: undefined }), "with nothing to start it, the old answer").toMatchObject({ action: "Reopen here" });

    const gone: StageShow = { ...session, session: { ...(session as Extract<StageShow, { kind: "session" }>).session, endedAgo: "14m ago" } } as StageShow;
    const reopen = endView({ kind: "ended" }, gone, act);
    expect(reopen).toMatchObject({ sentence: "The session ended 14m ago. This is its last frame.", action: "Reopen here" });
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
    expect(coarse).toContain(".ts-keys .kbd { display: none; }");
  });

  it("drops the first-run line's Esc clause whole, and keeps ✕ there", () => {
    const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
    const coarse = [...css.matchAll(/@media \(pointer: coarse\) \{([\s\S]*?)\n\}/g)].map(m => m[1]).join("\n");
    expect(coarse).toContain(".ts-keys .ts-first-keys { display: none; }");
    // Outranks the chips' own rule above: one attribute more.
    const keep = coarse.indexOf(".ts-keys .kbd[data-control] { display: inline-flex; }");
    expect(keep).toBeGreaterThan(coarse.indexOf(".ts-keys .kbd { display: none; }"));
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
    // In the takeover two lines of 15px fit the bar's 32px; past that the bar
    // grows rather than spilling the line over the terminal. Beside the board
    // the one line keeps the type it had.
    expect(first).not.toContain("line-height");
    expect(css).toContain(".ts-stage[data-takeover] .ts-first { line-height: 15px; }");
    expect(css).toMatch(/\.ts-bar:has\(\.ts-first\) \{ height: auto; min-height: 32px;/);
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
    // And they fit the header: 32px squares inside V4's 36px pane header.
    expect(px(coarse(".ts-stage .glyph-btn"), "min-height")).toBeLessThanOrEqual(36);
    // (The takeover's spine, which moved with the name past a wider ‹, left
    // with the spine: the row's gap does that on its own now.)
    expect(css).not.toContain(".ts-spine");
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
    // The bar is drawn at 32px beside a mouse (V4) and at 36px under a
    // fingertip — the height its buttons need, with a 1px rule on top — and
    // with the first-run line as tall as its content plus 1px above and
    // below: a button that needed more would grow the bar under every
    // fingertip.
    expect(px(plain(".ts-bar"), "height")).toBe(32);
    const barH = px(coarse(".ts-bar"), "height");
    expect(barH).toBe(36);
    expect(css).toMatch(/\.ts-bar:has\(\.ts-first\) \{ height: auto; min-height: 32px; padding-block: 1px; \}/);
    for (const sel of [".ts-keys .btn", ".ts-asks .ts-next"]) {
      expect(px(coarse(sel), "min-height") + 1 + 2, sel).toBeLessThanOrEqual(barH);
    }
  });

  it("leaves the panel as a mouse draws it", () => {
    expect(plain(".ts-keys .btn")).toContain("min-height: 28px");
    expect(plain(".ts-asks .ts-next")).toContain("min-height: 28px");
    expect(plain(".ts-divider")).toMatch(/left: -6px;[\s\S]*width: 12px;/);
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

  it("draws the header at V4's pane header height, one row, and the keys bar at 32px", () => {
    expect(rule(".ts-head")).toContain("height: var(--pane-head-h)");
    expect(rule(".ts-bar")).toContain("height: 32px");
  });

  it("has no spine and no light travelling down it: the hue left the header, so there is none to take away", () => {
    expect(css).not.toMatch(/\.ts-spine|ts-spine-flow/);
    expect(css).not.toContain("@keyframes ts-spine-flow");
  });

  it("keeps the stage's marks under a Contrast theme, in the deck's one forced-colours block", () => {
    const forced = css.slice(css.indexOf("@media (forced-colors: active) {"));
    // The state glyphs draw in currentColor and need nothing here; the marks
    // that are fills do (the card's fact mark, the context chip's bar).
    // CHANGED ON PURPOSE: the ended bar's square is gone (Figma V4 draws none),
    // and the header's context bar is a fill that needs its own track and fill.
    expect(forced).toMatch(/\.ts-fact-mark \{ background: CanvasText; \}/);
    expect(forced).not.toContain("ts-end-mark");
    expect(forced).toMatch(/\.ts-ctxbar \{ background: Canvas; outline: 1px solid CanvasText; \}/);
    expect(forced).toMatch(/\.ts-ctxbar i \{ background: CanvasText; \}/);
    expect(forced).not.toMatch(/\.ts-lamp|\.ts-spine/);
    expect(css.split("@media (forced-colors: active) {").length - 1, "one block, as #871 holds").toBe(1);
  });

  it("keeps New session inside a phone's width, and at its 368px wherever that fits", () => {
    // At 320px the popover kept its 368px and ran 56px past the screen's
    // edge (16px at 360): Codex, Haiku, Plan, the worktree switch and Start
    // were cut or out of reach. Placed with the window's margin on each side
    // (popover-place.ts), it takes no more than the window leaves.
    expect(rule(".anchored-popover.ns-pop")).toContain(`width: min(368px, calc(100vw - ${2 * POPOVER_MARGIN}px));`);
  });

  it("opens the popover opaque from its first frame: it scales, it does not fade", () => {
    const pop = css.slice(css.indexOf("@keyframes ns-pop-in"), css.indexOf("}", css.indexOf("@keyframes ns-pop-in")) + 1);
    expect(pop).toContain("scale(0.97)");
    expect(pop).not.toContain("opacity");
  });
});
