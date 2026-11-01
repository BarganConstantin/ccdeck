// V4's Term pane (Phase 3, PR b): the stage's header, its state cards, its keys
// bar, the divider and the morph's motion, held to the values Figma V4 draws —
// Workspace "Pane header · Term", Command Panel "Term pane · stage states",
// "Keys bar", "Divider, dragging" and "Stage motion".
//
// Markup is rendered to a string and pressed through the element tree (the
// way terminal-stage-view.test.ts does); the sheet is read as text, a rule at
// a time. What is held here is the look. What the stage does (focus, the
// xterm host staying mounted, roles, names and promises) is held by the suites
// that already hold it, and the few of those pins this restyle touches are
// repeated below where the look could have broken them.
import { describe, it, expect, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { all, one, textOf } from "./fake-react";
import { withoutComments } from "./tsx-scan";
import StageHeader, { CLOSE_LABEL, contextChipView, contextFigure, metaRest, type StageHeaderProps } from "../components/terminal/StageHeader";
import StageBody, { StateCard, type StageBodyProps } from "../components/terminal/StageBody";
import KeysBar, { type KeysBarProps } from "../components/terminal/KeysBar";
import { glyphForState } from "../components/terminal/stage-icons";
import { agentName, type StagePhase, type StageState, type StageStatus } from "../components/terminal/stage-model";
import { FLIP_CLOSE_MS, FLIP_EASE, FLIP_OPEN_MS } from "../navigator-flip";

const html = (el: ReactElement) => renderToStaticMarkup(el);
const read = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
const stage = read("styles/terminal-stage.css").replace(/\/\*[\s\S]*?\*\//g, "");
const shell = read("styles/stage-shell.css").replace(/\/\*[\s\S]*?\*\//g, "");
const touch = read("styles/touch-and-forced-colours.css").replace(/\/\*[\s\S]*?\*\//g, "");
const tokens = read("styles/tokens.css").replace(/\/\*[\s\S]*?\*\//g, "");

/** The body of the rule whose selector is exactly `sel` (at a line's start). */
function rule(css: string, sel: string): string {
  const at = css.indexOf(`\n${sel} {`);
  expect(at, `${sel} has a rule`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at));
}
/** A declaration's value in a rule body, whitespace collapsed. */
const decl = (body: string, prop: string) =>
  new RegExp(`(?:^|[;{\\s])${prop}:\\s*([^;]+);`).exec(body)?.[1].replace(/\s+/g, " ").trim();
const button = (tree: unknown, name: string) =>
  one(tree, el => el.type === "button" && (el.props["aria-label"] === name || textOf(el).trim() === name));

const waiting: StageStatus = { state: "waiting", phrase: "waiting", emphasis: "6m", tool: "Bash", arg: "npm test -- rate-limit" };
const working: StageStatus = { state: "working", phrase: "working", tool: "Task", arg: "3 subagents running", seconds: "7m 38s" };

function headerProps(over: Partial<StageHeaderProps> = {}): StageHeaderProps {
  return {
    identity: "session:a", name: "web-api", provider: "claude", status: waiting,
    keysOwner: "board", chordLabel: "Ctrl+]", canType: true, expanded: false, takeover: false,
    onKeys: vi.fn(), onExpand: vi.fn(), onClose: vi.fn(), ...over,
  };
}
function bodyProps(phase: StagePhase, over: Partial<StageBodyProps> = {}): StageBodyProps {
  return {
    hostRef: { current: null }, phase, ghostLine: "❯ Add rate limiting to the API",
    context: { prompt: "Add rate limiting to the API", fact: "running in another terminal" },
    onAdopt: vi.fn(), onNotNow: vi.fn(), onRetry: vi.fn(), onNewSession: vi.fn(), ...over,
  };
}
function barProps(over: Partial<KeysBarProps> = {}): KeysBarProps {
  return {
    owner: "board", name: "web-api", chordLabel: "Ctrl+]", canType: true, asksWaiting: true,
    firstRun: false, onFirstRunDone: vi.fn(), onTypeHere: vi.fn(), ...over,
  };
}

// ---------------------------------------------------------------------------

describe("the Term header: one row", () => {
  it("is a row the pane header's height, on --panel, with a soft rule under it", () => {
    const head = rule(stage, ".ts-head");
    expect(decl(head, "height")).toBe("var(--pane-head-h)");
    expect(decl(head, "background")).toBe("var(--panel)");
    expect(decl(head, "border-bottom")).toBe("1px solid var(--line-soft)");
    expect(decl(head, "padding")).toBe("0 6px 0 12px");
    expect(decl(head, "gap")).toBe("8px");
    expect(decl(head, "display")).toBe("flex");
    expect(decl(head, "align-items")).toBe("center");
    // The token is V4's: 36 at Compact, 44 at the roomier steps.
    expect(tokens).toMatch(/--pane-head-h:\s*44px/);
    expect(read("styles/reading.css")).toMatch(/--pane-head-h:\s*36px/);
    // The v3 header's 64px is not read by the sheet any more.
    expect(stage).not.toContain("--ts-head-h");
  });

  it("goes in this order: the state glyph, the name, the provider for a reader, the sentence, then the end group", () => {
    const out = html(createElement(StageHeader, headerProps()));
    const at = (s: string) => out.indexOf(s);
    expect(at('class="ts-glyph"')).toBeGreaterThan(-1);
    expect(at('class="ts-glyph"')).toBeLessThan(at('<h2 class="ts-name">'));
    expect(at('<h2 class="ts-name">')).toBeLessThan(at('<span class="vis-hidden">Claude Code</span>'));
    expect(at('<span class="vis-hidden">Claude Code</span>')).toBeLessThan(at('class="ts-meta"'));
    expect(at('class="ts-meta"')).toBeLessThan(at('class="ts-ctl"'));
    // One row: the old second line is gone with its class names.
    expect(out).not.toMatch(/ts-l1|ts-l2|ts-phrase/);
  });

  it("draws the glyph the rail draws for the same state, 14px", () => {
    const cases: Array<[StageState, string]> = [
      ["working", "working"], ["attaching", "working"], ["starting", "working"], ["waiting", "waiting"],
      ["idle", "idle"], ["ready", "idle"], ["elsewhere", "idle"], ["detached", "idle"], ["ended", "done"],
    ];
    for (const [state, kind] of cases) expect(glyphForState(state), state).toBe(kind);
    expect(glyphForState("none"), "the empty stage has no session to mark").toBeNull();
    const out = html(createElement(StageHeader, headerProps()));
    expect(out).toContain('data-glyph="waiting"');
    expect(out).toMatch(/class="alert-mark"[^>]*width="14" height="14"/);
    expect(html(createElement(StageHeader, headerProps({ status: working })))).toMatch(/class="state-mark" data-kind="live"[^>]*width="14" height="14"/);
    expect(html(createElement(StageHeader, headerProps({ status: { state: "none", phrase: "" } })))).not.toContain("ts-glyph");
  });

  it("sets the name 13/20 SemiBold in --text with an ellipsis", () => {
    const name = rule(stage, ".ts-name");
    expect(decl(name, "font-size")).toBe("13px");
    expect(decl(name, "font-weight")).toBe("600");
    expect(decl(name, "line-height")).toBe("20px");
    expect(decl(name, "color")).toBe("var(--text)");
    expect(decl(name, "text-overflow")).toBe("ellipsis");
    expect(decl(name, "white-space")).toBe("nowrap");
  });

  it("sets the sentence in mono 12/16 with a 6px gap: the state in its colour, the tool and argument --muted, one line", () => {
    const meta = rule(stage, ".ts-meta");
    expect(decl(meta, "font")).toBe("400 12px/16px var(--font-mono)");
    expect(decl(meta, "gap")).toBe("6px");
    expect(decl(meta, "color")).toBe("var(--muted)");
    expect(decl(meta, "white-space")).toBe("nowrap");
    expect(decl(rule(stage, ".ts-meta-state"), "color")).toBe("var(--text-secondary)");
    expect(decl(rule(stage, '.ts-meta[data-state="waiting"] .ts-meta-state'), "color")).toBe("var(--warn)");
    expect(decl(rule(stage, ".ts-meta-rest"), "text-overflow")).toBe("ellipsis");
    expect(decl(rule(stage, ".ts-meta-rest"), "overflow")).toBe("hidden");
    // The words are the face's: the state part, then "· Bash · npm test …".
    const out = html(createElement(StageHeader, headerProps()));
    expect(out).toContain('<span class="ts-meta-state">waiting <b>6m</b></span>');
    expect(out).toContain('<span class="ts-meta-rest">· Bash · npm test -- rate-limit</span>');
    expect(metaRest(working)).toBe("Task · 3 subagents running · 7m 38s");
    expect(metaRest({ state: "idle", phrase: "idle" }), "no tool, no rest of the sentence").toBeNull();
    expect(html(createElement(StageHeader, headerProps({ status: { state: "idle", phrase: "idle" } })))).not.toContain("ts-meta-rest");
  });

  it("has no hue spine, no light travelling down one, and no model chip", () => {
    const out = html(createElement(StageHeader, headerProps({ model: "claude-opus-5-5", effort: "max" })));
    expect(out).not.toMatch(/ts-spine|model-chip|ts-chip\b/);
    expect(out).not.toMatch(/Opus/);
    expect(stage).not.toMatch(/ts-spine|data-live/);
    // The stage still hands the live flag to the section; nothing here reads it.
    expect(shell).not.toMatch(/ts-spine|\.ts-l2|\.ts-chip\b/);
  });

  it("still names the provider in words for a screen reader", () => {
    expect(html(createElement(StageHeader, headerProps()))).toContain('<span class="vis-hidden">Claude Code</span>');
    expect(html(createElement(StageHeader, headerProps({ provider: "codex" })))).toContain('<span class="vis-hidden">Codex</span>');
    expect(agentName("claude")).toBe("Claude Code");
    expect(html(createElement(StageHeader, headerProps({ provider: null })))).not.toContain("vis-hidden");
  });

  it("draws no Chat/Term toggle and no Split: Chat is a later phase and a dead control is worse than none", () => {
    const tree = StageHeader(headerProps());
    const names = all(tree, el => el.type === "button").map(b => String(b.props["aria-label"] ?? textOf(b)));
    expect(names).toEqual(["Type into the session", "Give the Command Panel the width", CLOSE_LABEL]);
    const out = html(createElement(StageHeader, headerProps()));
    expect(out).not.toMatch(/Chat|Split|aria-pressed="false"[^>]*>(?:(?!<\/button>).)*Term/i);
  });

  it("keeps the actions the code's: 24px icon buttons at the control radius, 2px apart", () => {
    const tools = rule(stage, ".ts-tools");
    expect(decl(tools, "gap")).toBe("2px");
    const btn = rule(stage, ".ts-head .glyph-btn");
    expect(decl(btn, "width")).toBe("24px");
    expect(decl(btn, "height")).toBe("24px");
    expect(decl(btn, "border-radius")).toBe("var(--r-ctl)");
    expect(html(createElement(StageHeader, headerProps()))).toContain('class="glyph-btn"');
    expect(decl(rule(stage, ".ts-ctl"), "gap")).toBe("4px");
    // The takeover's ‹ still leads, with the promise ✕ keeps.
    expect(button(StageHeader(headerProps({ takeover: true })), "Back to the board — the session keeps running")).not.toBeNull();
  });
});

describe("the context chip", () => {
  it("is drawn only when the stage knows how full the context is, and reads \"61.4k / 200k\" over a bar at the percent", () => {
    const view = contextChipView({ used: 61_400, limit: 200_000 });
    expect(view).toMatchObject({ text: "61.4k / 200k", pct: 31 });
    const out = html(createElement(StageHeader, headerProps({ context: { used: 61_400, limit: 200_000 } })));
    expect(out).toContain('<span class="ts-ctxchip-text">61.4k / 200k</span>');
    expect(out).toContain('<i style="width:31%"></i>');
    expect(out).toContain('aria-label="Context: 61.4k / 200k tokens, 31% full"');
    // Without a figure there is no chip, not an empty one.
    for (const none of [undefined, null]) {
      expect(html(createElement(StageHeader, headerProps({ context: none })))).not.toContain("ts-ctxchip");
    }
    expect(contextChipView({ used: 10, limit: 0 })).toBeNull();
    expect(contextChipView({ used: -1, limit: 200_000 })).toBeNull();
    expect(contextChipView({ used: 250_000, limit: 200_000 })?.pct, "never past full").toBe(100);
  });

  it("takes its figures from the deck's own: the CLI's window when it said one, else the model's", () => {
    expect(contextFigure(61_400, 200_000, "claude-opus-5-5")).toEqual({ used: 61_400, limit: 200_000 });
    expect(contextFigure(61_400, undefined, "claude-sonnet-5")).toMatchObject({ used: 61_400 });
    expect(contextFigure(undefined, 200_000, "x"), "no figure yet").toBeNull();
    expect(contextFigure(Number.NaN, 200_000, "x")).toBeNull();
  });

  it("is 24 tall, mono 11/14 Medium in --muted, with a 4px bar: --line track, --text-secondary fill", () => {
    const chip = rule(stage, ".ts-ctxchip");
    expect(decl(chip, "height")).toBe("24px");
    expect(decl(chip, "padding")).toBe("0 6px");
    expect(decl(chip, "gap")).toBe("6px");
    expect(decl(chip, "border-radius")).toBe("var(--r-ctl)");
    expect(decl(chip, "font")).toBe("500 11px/14px var(--font-mono)");
    expect(decl(chip, "color")).toBe("var(--muted)");
    const bar = rule(stage, ".ts-ctxchip-bar");
    expect(decl(bar, "height")).toBe("4px");
    expect(decl(bar, "background")).toBe("var(--line)");
    expect(decl(bar, "border-radius")).toBe("var(--r-pill)");
    expect(decl(rule(stage, ".ts-ctxchip-bar i"), "background")).toBe("var(--text-secondary)");
  });

  it("is not wired by the stage yet: the figure is not on what the stage is handed", () => {
    // StageSessionInfo (TerminalStage.tsx, lifecycle-bound) carries no context
    // figure, so the chip waits for one to be passed through.
    const header = /<StageHeader[\s\S]*?\/>/.exec(withoutComments(read("components/terminal/TerminalStage.tsx")))?.[0] ?? "";
    expect(header).toContain("identity={key}");
    expect(header).not.toContain("context=");
  });
});

describe("the state cards: centred in the pane", () => {
  it("is a column centred both ways, 10px between lines, a line of about 60 characters", () => {
    const card = rule(stage, ".ts-card");
    expect(decl(card, "position")).toBe("absolute");
    expect(decl(card, "inset")).toBe("0");
    expect(decl(card, "display")).toBe("flex");
    expect(decl(card, "flex-direction")).toBe("column");
    expect(decl(card, "align-items")).toBe("center");
    expect(decl(card, "justify-content")).toBe("center");
    expect(decl(card, "gap")).toBe("10px");
    expect(decl(card, "text-align")).toBe("center");
    // Not top-left 24px in, as v3's card was.
    expect(card).not.toMatch(/top:\s*var\(--ts-term-top/);
    expect(decl(rule(stage, ".ts-text"), "max-width")).toBe("60ch");
  });

  it("sets the sentence 13/20 --text-secondary, the context line mono 12/16 --muted, the title 13/20 SemiBold --text", () => {
    const text = rule(stage, ".ts-text");
    expect(decl(text, "font-size")).toBe("13px");
    expect(decl(text, "line-height")).toBe("20px");
    expect(decl(text, "color")).toBe("var(--text-secondary)");
    const ctx = rule(stage, ".ts-ctx");
    expect(decl(ctx, "font")).toBe("400 12px/16px var(--font-mono)");
    expect(decl(ctx, "color")).toBe("var(--muted)");
    const title = rule(stage, ".ts-title");
    expect(decl(title, "font-size")).toBe("13px");
    expect(decl(title, "font-weight")).toBe("600");
    expect(decl(title, "line-height")).toBe("20px");
    expect(decl(title, "color")).toBe("var(--text)");
  });

  it("puts the context line above the sentence, and the title first where a card has one", () => {
    const e = html(createElement(StateCard, bodyProps({ kind: "not-attachable", target: { kind: "C", label: "Started outside the deck.", adoptable: true }, stillRunning: false, busy: false })));
    expect(e.indexOf("Add rate limiting to the API")).toBeLessThan(e.indexOf("Started outside the deck."));
    const tmux = html(createElement(StateCard, bodyProps({ kind: "tmux-installing" })));
    expect(tmux.indexOf('class="ts-title">tmux · setting up')).toBeLessThan(tmux.indexOf('class="ts-text"'));
  });

  it("centres the actions in a row 8px apart, Primary where the card has a way forward and Quiet for Not now", () => {
    expect(decl(rule(stage, ".ts-acts"), "gap")).toBe("8px");
    expect(decl(rule(stage, ".ts-acts"), "justify-content")).toBe("center");
    const cls = (phase: StagePhase, name: string, over: Partial<StageBodyProps> = {}) =>
      button(StateCard(bodyProps(phase, over)), name)?.props.className;
    const c = { kind: "C" as const, label: "x", adoptable: true };
    expect(cls({ kind: "not-attachable", target: c, stillRunning: false, busy: false }, "Reopen here")).toBe("btn primary");
    expect(cls({ kind: "not-attachable", target: c, stillRunning: true, busy: false }, "Check again")).toBe("btn primary");
    expect(cls({ kind: "not-attachable", target: c, stillRunning: false, busy: false }, "Not now")).toBe("btn");
    expect(cls({ kind: "tmux-missing", reason: "missing", busy: false }, "Check again")).toBe("btn primary");
    expect(cls({ kind: "error", message: "x" }, "Try again")).toBe("btn primary");
    expect(cls({ kind: "error", message: "x" }, "Not now")).toBe("btn");
    expect(cls({ kind: "error", message: "x", code: "not-installed", busy: false }, "Check again")).toBe("btn primary");
    expect(cls({ kind: "empty" }, "New session")).toBe("btn primary");
    expect(cls({ kind: "tmux-installing" }, "Not now")).toBe("btn");
    // The cards set no size of their own for the kit's buttons.
    expect(rule(stage, ".ts-acts .btn")).not.toMatch(/(?:min-)?(?:height|width)/);
  });

  it("draws attaching as the working glyph and the word in one row, never a spinner, over the last line the board knew", () => {
    const out = html(createElement(StateCard, bodyProps({ kind: "attaching", reconnect: false })));
    expect(out).toContain('data-glyph="working"');
    expect(out).toContain("<span>attaching…</span>");
    expect(out).toContain("❯ Add rate limiting to the API");
    expect(out.indexOf("Add rate limiting")).toBeLessThan(out.indexOf("attaching…"));
    expect(decl(rule(stage, ".ts-wait"), "gap")).toBe("6px");
    expect(out).not.toMatch(/spin|loader/i);
    // A reconnect keeps the frozen frame; the keys bar says nothing typed is sent.
    expect(html(createElement(StateCard, bodyProps({ kind: "attaching", reconnect: true })))).toBe("");
    expect(html(createElement(KeysBar, barProps({ owner: "pane", reconnecting: true })))).toContain("nothing typed now is sent");
  });

  it("restyles the install line to 360 by 32 and the progress to a 320 by 2 bar, behaviour as it was", () => {
    const cmd = rule(stage, ".ts-cmd");
    expect(decl(cmd, "width")).toBe("360px");
    expect(decl(cmd, "height")).toBe("32px");
    expect(decl(cmd, "font")).toBe("400 12px/16px var(--font-mono)");
    expect(decl(rule(stage, ".ts-setup"), "width")).toBe("320px");
    expect(decl(rule(stage, ".ts-setup-bar"), "height")).toBe("2px");
    expect(decl(rule(stage, ".ts-setup-line"), "font")).toBe("400 12px/16px var(--font-mono)");
    const out = html(createElement(StateCard, bodyProps({ kind: "tmux-installing", progress: { stage: "downloading", received: 400_000, total: 1_000_000 } })));
    expect(out).toContain("0.4 of 1.0 MB");
    expect(out).toContain('role="progressbar"');
    expect(out).toContain("transform:scaleX(0.4)");
    expect(html(createElement(StateCard, bodyProps({ kind: "tmux-missing", reason: "missing", install: "brew install tmux", busy: false })))).toContain('aria-label="Copy the command"');
  });

  it("keeps the terminal's host mounted, only hidden, under every card", () => {
    for (const phase of [{ kind: "empty" }, { kind: "attaching", reconnect: false }, { kind: "error", message: "x" }] as StagePhase[]) {
      expect(html(createElement(StageBody, bodyProps(phase))), phase.kind).toMatch(/<div class="ts-host" data-terminal-panel=""/);
    }
  });

  it("takes Figma's colon in the still-running note where the code had a dash, and no other sentence", () => {
    const body = read("components/terminal/StageBody.tsx");
    expect(body).toContain("Reopening needs it stopped first: finish or quit it there, then check again.");
    expect(body).not.toContain("stopped first —");
  });
});

describe("the keys bar", () => {
  it("is 32 tall on --bg-soft with a soft rule above, 12px padding, 6px gap, 12/16 --muted", () => {
    const bar = rule(stage, ".ts-bar");
    expect(decl(bar, "height")).toBe("32px");
    expect(decl(bar, "background")).toBe("var(--bg-soft)");
    expect(decl(bar, "border-top")).toBe("1px solid var(--line-soft)");
    expect(decl(bar, "padding")).toBe("0 12px");
    expect(decl(bar, "gap")).toBe("6px");
    expect(decl(bar, "align-items")).toBe("center");
    expect(decl(bar, "font-size")).toBe("12px");
    expect(decl(bar, "line-height")).toBe("16px");
    expect(decl(bar, "color")).toBe("var(--muted)");
    expect(decl(rule(stage, ".ts-who"), "color"), "the session's name is the one thing set apart").toBe("var(--text-secondary)");
  });

  it("holds its keys in the kit's Kbd, 16 tall, and the chord by its label", () => {
    const board = html(createElement(KeysBar, barProps()));
    expect(board).toContain('<kbd class="kbd">j</kbd><kbd class="kbd">k</kbd> sessions');
    expect(board).toContain('<kbd class="kbd" aria-hidden="true">↵</kbd><span class="kbd-spoken">Enter</span>');
    expect(board).toContain('<kbd class="kbd">n</kbd> next ask');
    const pane = html(createElement(KeysBar, barProps({ owner: "pane", chordLabel: "Ctrl+]" })));
    expect(pane).toContain('Typing into <span class="ts-who">web-api</span>');
    expect(pane).toContain('<kbd class="kbd">Esc</kbd> goes to the session');
    expect(pane).toContain('<kbd class="kbd" aria-hidden="true">Ctrl+]</kbd><span class="kbd-spoken">Control Shift X</span> back to the board');
    // The stage's own cap is gone; the kit's, at 16: its 14px line, no padding above or below.
    expect(stage).not.toContain("ts-kbd");
    expect(decl(rule(stage, ".ts-bar .kbd"), "padding")).toBe("0 4px");
    expect(read("styles/status-bar.css")).toMatch(/\.kbd \{[^}]*line-height: calc\(14px/);
  });

  it("says who has the keys with the rail's 14px glyph: working for the pane, idle for the board", () => {
    const pane = html(createElement(KeysBar, barProps({ owner: "pane" })));
    expect(pane).toMatch(/data-owner="pane"><span class="ts-glyph" data-glyph="working"/);
    const board = html(createElement(KeysBar, barProps()));
    expect(board).toMatch(/data-owner="board"><span class="ts-glyph" data-glyph="idle"/);
    expect(board).toMatch(/class="state-mark" data-kind="idle"[^>]*width="14" height="14"/);
    expect(board + pane).not.toContain("ts-lamp");
    expect(stage).not.toContain("ts-lamp");
    // Reconnecting keeps what the hollow lamp meant: nothing is reaching the session.
    expect(html(createElement(KeysBar, barProps({ owner: "pane", reconnecting: true })))).toMatch(/data-glyph="idle"/);
  });

  it("puts the buttons in the kit's Quiet at 28, and the owner sentence in no live region", () => {
    expect(decl(rule(stage, ".ts-keys .btn"), "min-height")).toBe("28px");
    expect(decl(rule(stage, ".ts-asks .ts-next"), "min-height")).toBe("28px");
    const run = html(createElement(KeysBar, barProps({
      end: { sentence: "The session ended 14m ago — this is its last frame.", action: "Reopen here", onAction: vi.fn() },
    })));
    expect(run).toContain('<button type="button" class="btn"');
    expect(run).not.toContain("btn primary");
    const everything = [
      html(createElement(KeysBar, barProps())), html(createElement(KeysBar, barProps({ owner: "pane" }))),
      html(createElement(KeysBar, barProps({ firstRun: true }))), run,
      html(createElement(KeysBar, barProps({ asks: { segments: ["done", "todo"], next: { name: "docs-site", waited: "4m" }, resumed: "web-api" } }))),
      html(createElement(KeysBar, barProps({ arrival: { name: "docs-site", tool: "Bash" }, onAnswerArrival: vi.fn() }))),
    ].join("");
    expect(everything).not.toMatch(/aria-live|role="status"|role="alert"/);
  });

  it("runs the asks in the same type, behaviour as it was", () => {
    const out = html(createElement(KeysBar, barProps({ asks: { segments: ["done", "now", "todo"], position: { index: 1, total: 3 } } })));
    expect(out).toContain('<span class="ts-count">2 of 3</span>');
    const next = html(createElement(KeysBar, barProps({ asks: { segments: ["done", "todo"], resumed: "web-api", next: { name: "docs-site", waited: "4m" } } })));
    expect(next).toContain("✓ web-api resumed");
    expect(next).toContain("Next ask <span class=\"ts-next-name\">docs-site</span> <b>4m</b>");
    expect(html(createElement(KeysBar, barProps({ asks: { segments: ["done"], clear: true } })))).toContain("✓ No more asks");
    expect(html(createElement(KeysBar, barProps({ arrival: { name: "docs-site", tool: "Bash" } })))).toContain('<kbd class="kbd">n</kbd>');
    // No pill, no waiting colour on the button: the kit's Quiet.
    expect(rule(stage, ".ts-asks .ts-next")).not.toMatch(/border-radius|color:/);
    expect(decl(rule(stage, ".ts-asks-label"), "color")).toBe("var(--muted)");
  });

  it("offers no \"Answer in Chat\": Chat is a later phase", () => {
    expect(html(createElement(KeysBar, barProps({ arrival: { name: "docs-site" }, onAnswerArrival: vi.fn() })))).not.toMatch(/Chat/);
  });

  it("gives a fingertip a 36px bar for its 32px buttons, and drops the key names there as it did", () => {
    expect(touch).toMatch(/@media \(pointer: coarse\)[\s\S]*\.ts-bar \{ height: 36px; \}/);
    expect(touch).toContain(".ts-keys .kbd { display: none; }");
    expect(touch).toContain(".ts-keys .kbd[data-control] { display: inline-flex; }");
  });
});

describe("the divider", () => {
  it("draws a 1px --line at rest on a hit area of at least 8px", () => {
    expect(rule(stage, ".ts-divider::before")).toMatch(/width:\s*1px;/);
    expect(decl(rule(stage, ".ts-divider::before"), "background")).toBe("var(--line)");
    expect(Number(/width:\s*(\d+)px/.exec(rule(stage, ".ts-divider"))?.[1])).toBeGreaterThanOrEqual(8);
  });

  it("turns --accent and 2px wide on hover, focus and drag", () => {
    expect(rule(stage, ".ts-divider:hover::before")).toMatch(/width:\s*2px;\s*background:\s*var\(--accent\)/);
    const held = rule(stage, ".ts-divider[data-held]::before,\n.ts-divider:focus-visible::before");
    expect(held).toMatch(/width:\s*2px;\s*background:\s*var\(--accent\)/);
  });

  it("reads its size while dragging in mono 13/20 --text, and keeps its role, its one tab stop and its detents", () => {
    const readout = rule(stage, ".ts-readout");
    expect(decl(readout, "font")).toBe("400 13px/20px var(--font-mono)");
    expect(decl(readout, "color")).toBe("var(--text)");
    const src = withoutComments(read("components/terminal/Divider.tsx"));
    expect(src).toContain('role="separator"');
    expect(src.match(/tabIndex=/g)?.length, "exactly one tabIndex").toBe(1);
    expect(src).toContain("ts-detents");
  });
});

describe("the morph's motion", () => {
  it("already matches Figma's Stage motion, so nothing was changed: 280ms in, 200ms out, one curve, travel only by size and position", () => {
    expect(FLIP_OPEN_MS).toBe(280);
    expect(FLIP_CLOSE_MS).toBe(200);
    expect([...FLIP_EASE]).toEqual([0.32, 0.72, 0, 1]);
    expect(tokens).toMatch(/--dur-stage-in:\s*280ms/);
    expect(tokens).toMatch(/--dur-stage-out:\s*200ms/);
    expect(tokens).toMatch(/--ease-stage:\s*cubic-bezier\(0\.32, 0\.72, 0, 1\)/);
    // The morph is clip-path and the rider's transform: size and position.
    const morph = read("stage-morph.ts");
    expect(morph).toMatch(/clip-path|clipPath/);
    expect(shell).not.toMatch(/transition:[^;]*(?:opacity|color)/);
  });

  it("takes no time under reduced motion", () => {
    expect(withoutComments(read("components/terminal/StageShell.tsx"))).toContain("reduced ? 0 : dir === \"open\" ? FLIP_OPEN_MS : FLIP_CLOSE_MS");
  });

  it("flies the rider at the header's name size, 13px", () => {
    expect(decl(rule(shell, ".stage-rider"), "font-size")).toBe("13px");
    expect(decl(rule(stage, ".ts-name"), "font-size")).toBe("13px");
    expect(shell).toMatch(/\.stage-dock\[data-rider\] \.ts-ctxchip \{ opacity: var\(--stage-chip, 1\); \}/);
  });
});

describe("the geometry follows the header as it is drawn", () => {
  const ts = withoutComments(read("components/terminal/TerminalStage.tsx"));
  const shellSrc = withoutComments(read("components/terminal/StageShell.tsx"));
  const useStage = withoutComments(read("use-stage.ts"));

  it("TerminalStage measures .ts-head and reports it through onHeadH, rounded like the bar", () => {
    expect(ts).toContain("onHeadH?(height: number): void;");
    expect(ts).toContain('querySelector<HTMLElement>(".ts-head")');
    expect(ts).toContain("onHeadH.current?.(Math.ceil(Math.round(head.getBoundingClientRect().height * 100) / 100))");
    expect(ts).toMatch(/watch\.observe\(head\);\s*return \(\) => watch\.disconnect\(\);/);
  });

  it("StageShell passes it on, and use-stage fits the geometry to it", () => {
    expect(shellSrc).toContain("onHeadH={stage.onHeadH}");
    expect(useStage).toContain("const [headH, setHeadH] = useState(HEAD_H);");
    expect(useStage).toContain("barH, headH })");
    expect(useStage).toMatch(/onCell, onBarH, onHeadH,/);
  });
});

describe("tokens only", () => {
  it("writes no literal colour in the stage's sheets or its components", () => {
    const literal = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\((?!var\()/;
    for (const [name, css] of [["terminal-stage.css", stage], ["stage-shell.css", shell]] as const) {
      expect(css, name).not.toMatch(literal);
    }
    for (const f of ["StageHeader", "StageBody", "KeysBar", "Divider", "stage-icons"]) {
      expect(withoutComments(read(`components/terminal/${f}.tsx`)), f).not.toMatch(literal);
    }
  });
});
