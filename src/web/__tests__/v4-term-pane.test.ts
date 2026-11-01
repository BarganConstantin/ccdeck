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
import StageHeader, { CLOSE_LABEL, contextChipText, metaRest, type StageHeaderProps } from "../components/terminal/StageHeader";
import StageBody, { StateCard, type StageBodyProps } from "../components/terminal/StageBody";
import KeysBar, { type KeysBarProps } from "../components/terminal/KeysBar";
import { glyphForState } from "../components/terminal/stage-icons";
import { agentName, headerStatus, type StagePhase, type StageState, type StageStatus } from "../components/terminal/stage-model";
import { contextUseOf } from "../components/terminal/stage-board";
import { contextFill } from "../context-figure";
import type { AgentNodeData } from "../types";
import { crossfadeFrame, morphFrame, type MorphPlan } from "../stage-morph";
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
    // CHANGED ON PURPOSE: V4's Figma draws "waiting 6m" in one regular
    // weight, so the minutes are no longer in a <b>.
    expect(out).toContain('<span class="ts-meta-state">waiting 6m</span>');
    expect(out).not.toContain("<b>");
    expect(stage).not.toContain(".ts-meta-state b");
    expect(out).toContain('<span class="ts-meta-rest">· Bash · npm test -- rate-limit</span>');
    expect(metaRest(working)).toBe("Task · 3 subagents running · 7m 38s");
    expect(metaRest({ state: "idle", phrase: "idle" }), "no tool, no rest of the sentence").toBeNull();
    expect(html(createElement(StageHeader, headerProps({ status: { state: "idle", phrase: "idle" } })))).not.toContain("ts-meta-rest");
  });

  it("has no hue spine, no light travelling down one, and no model chip", () => {
    const out = html(createElement(StageHeader, headerProps()));
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
  // CHANGED ON PURPOSE (the whole block): the chip is drawn now (V4's
  // Figma). It used to be pinned as not drawn, because nothing
  // handed the stage a figure; the tests below prove one is handed, from the
  // same place the Inspector's Context tab reads it.
  it("says the figure at the row's end, before the controls, with a 4px bar of the same percent", () => {
    const out = html(createElement(StageHeader, headerProps({ context: { used: 129_000, window: 200_000 } })));
    expect(out).toContain('<span class="ts-ctxchip" title="Context window"><span class="vis-hidden">Context </span><span class="ts-ctxlead">129k / 200k · </span>65%');
    expect(out).toContain('<span class="ts-ctxbar" aria-hidden="true"><i style="width:65%"></i></span>');
    expect(out.indexOf("ts-ctxchip")).toBeGreaterThan(out.indexOf('class="ts-meta"'));
    expect(out.indexOf("ts-ctxchip")).toBeLessThan(out.indexOf('class="ts-ctl"'));
    expect(out.indexOf("ts-ctxchip"), "before ⌨ ⤢ ✕").toBeLessThan(out.indexOf("glyph-btn"));
  });

  it("says the window full past it, in the text and the bar: the Inspector's tab reads 100.0% there too", () => {
    const out = html(createElement(StageHeader, headerProps({ context: { used: 300_000, window: 200_000 } })));
    expect(out).toContain('<span class="ts-ctxlead">300k / 200k · </span>100%');
    expect(out).not.toContain("150%");
    expect(out).toContain('<i style="width:100%"></i>');
  });

  it("is not drawn when the figure is unknown or nothing is used", () => {
    for (const context of [undefined, null, { used: 0, window: 200_000 }]) {
      expect(html(createElement(StageHeader, headerProps({ context }))), JSON.stringify(context)).not.toContain("ts-ctxchip");
    }
    expect(contextChipText({ used: 0, window: 0 })).toBeNull();
    expect(contextChipText({ used: 850, window: 0 }), "no window: the used part alone").toBe("850");
  });

  it("is Mono Medium 11/14 --muted, 24 high at the control radius, over a --line track filled --text-secondary", () => {
    const chip = rule(stage, ".ts-ctxchip");
    expect(decl(chip, "font")).toBe("500 11px/14px var(--font-mono)");
    expect(decl(chip, "color")).toBe("var(--muted)");
    expect(decl(chip, "height")).toBe("24px");
    expect(decl(chip, "border-radius")).toBe("var(--r-ctl)");
    const bar = rule(stage, ".ts-ctxbar");
    expect(decl(bar, "height")).toBe("4px");
    expect(decl(bar, "background")).toBe("var(--line)");
    expect(decl(rule(stage, ".ts-ctxbar i"), "background")).toBe("var(--text-secondary)");
  });

  it("fades in on the morph's chip ramp, last of all, and not with the controls", () => {
    expect(shell).toMatch(/\.stage-dock\[data-rider\] \.ts-ctxchip \{ opacity: var\(--stage-chip, 1\); \}/);
    expect(shell).not.toMatch(/\.ts-ctxchip[^{]*\.ts-ctl|\.ts-ctl[^{]*\.ts-ctxchip/);
    // A sibling of the controls, so the controls' own fade does not double it.
    const out = html(createElement(StageHeader, headerProps({ context: { used: 1000, window: 200_000 } })));
    expect(out).not.toMatch(/class="ts-ctl"[^]*ts-ctxchip/);
  });

  it("is handed a figure from where the data lives: the board's context numbers, through the show, to the header", () => {
    // The Inspector's Context tab reads contextFill(agent); the stage takes the
    // same two numbers from the same function (stage-board.ts) ...
    const board = withoutComments(read("components/terminal/stage-board.ts"));
    expect(board).toContain('import { contextFill } from "../../context-figure"');
    expect(board, "no component module behind the stage's data").not.toContain("ContextModal");
    expect(board).toMatch(/contextUse: contextUseOf\(root\)/);
    expect(withoutComments(read("components/Inspector.tsx"))).toContain("contextFill(agent)");
    // ... and TerminalStage hands the session's figure to the header.
    const header = /<StageHeader[\s\S]*?\/>/.exec(withoutComments(read("components/terminal/TerminalStage.tsx")))?.[0] ?? "";
    expect(header).toContain('context={p.show.kind === "session" ? p.show.session.contextUse : null}');
  });

  it("takes the used tokens and the window of a board agent as the Inspector counts them", () => {
    const agent = { context: { currentContextTokens: 129_000 }, contextWindow: 200_000, model: "claude-opus-4" } as unknown as AgentNodeData;
    expect(contextUseOf(agent)).toEqual({ used: 129_000, window: 200_000 });
    expect(contextUseOf(agent)).toEqual({ used: contextFill(agent).used, window: contextFill(agent).limit });
    expect(contextUseOf({ ...agent, context: undefined } as unknown as AgentNodeData).used, "nothing read yet").toBe(0);
  });
});

describe("the reconnect sentence", () => {
  it("adds what the frozen frame cannot say to the header's phrase, and draws no card over the frame", () => {
    const status = headerStatus(null, { kind: "attaching", reconnect: true });
    expect(status).toMatchObject({ phrase: "reconnecting…", arg: "Nothing typed now is sent." });
    expect(metaRest(status)).toBe("Nothing typed now is sent.");
    expect(html(createElement(StageHeader, headerProps({ status })))).toContain('<span class="ts-meta-rest">· Nothing typed now is sent.</span>');
    // V4's Figma card is noted, not built: the last frame stays.
    expect(html(createElement(StateCard, bodyProps({ kind: "attaching", reconnect: true })))).toBe("");
    expect(headerStatus(null, { kind: "attaching", reconnect: false })).toEqual({ state: "attaching", phrase: "attaching…" });
  });

  it("says it in the keys bar in --warn, 12/16 sans, as one sentence with no glyph", () => {
    const out = html(createElement(KeysBar, barProps({ owner: "pane", reconnecting: true })));
    expect(out).toContain('<span class="ts-reconnecting" title="Reconnecting to web-api. Nothing typed now is sent.">Reconnecting to web-api. Nothing typed now is sent.</span>');
    expect(out).not.toContain("ts-glyph");
    expect(decl(rule(stage, ".ts-reconnecting"), "color")).toBe("var(--warn)");
    expect(rule(stage, ".ts-reconnecting")).not.toMatch(/font/);
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
    expect(decl(card, "justify-content")).toBe("safe center");
    expect(decl(card, "gap")).toBe("10px");
    expect(decl(card, "text-align")).toBe("center");
    // Taller than a short pane, it scrolls from its top rather than spilling
    // past both edges with its title and its buttons out of reach.
    expect(decl(card, "overflow-y")).toBe("auto");
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
    // CHANGED ON PURPOSE: the sentence is V4's Figma.
    expect(html(createElement(KeysBar, barProps({ owner: "pane", reconnecting: true })))).toContain("Nothing typed now is sent.");
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
  it("is 32 tall on --panel with a soft rule above, 12px padding, 12px gap, 12/16 --muted", () => {
    // CHANGED ON PURPOSE: Figma V4 (Keys bar, every variant) fills the bar
    // --panel (was --bg-soft) and puts 12px between its items (was 6px).
    const bar = rule(stage, ".ts-bar");
    expect(decl(bar, "height")).toBe("32px");
    expect(decl(bar, "background")).toBe("var(--panel)");
    expect(decl(bar, "border-top")).toBe("1px solid var(--line-soft)");
    expect(decl(bar, "padding")).toBe("0 12px");
    expect(decl(bar, "gap")).toBe("12px");
    expect(decl(rule(stage, ".ts-keys"), "gap")).toBe("12px");
    expect(decl(bar, "align-items")).toBe("center");
    expect(decl(bar, "font-size")).toBe("12px");
    expect(decl(bar, "line-height")).toBe("16px");
    expect(decl(bar, "color")).toBe("var(--muted)");
    // CHANGED ON PURPOSE: the name is no longer set apart (V4's Figma draws
    // "Typing into web-api" whole in --text); the label's colour says who has the keys.
    expect(stage).not.toContain(".ts-who");
    expect(decl(rule(stage, ".ts-label"), "color")).toBe("var(--text-secondary)");
    expect(decl(rule(stage, '.ts-label[data-strong]'), "color")).toBe("var(--text)");
  });

  it("sets the hints --muted with 4px between a key and its word, and no mark between hints", () => {
    expect(decl(rule(stage, ".ts-hint"), "gap")).toBe("4px");
    expect(decl(rule(stage, ".ts-hint"), "color")).toBe("var(--muted)");
    expect(stage).not.toContain(".ts-hint + .ts-hint");
    expect(stage).not.toContain('content: "·"');
  });

  it("holds its keys in the kit's Kbd as it is, and the chord by its label", () => {
    const board = html(createElement(KeysBar, barProps()));
    // CHANGED ON PURPOSE: one key cap "j k" (V4's Figma), not two.
    expect(board).toContain('<kbd class="kbd">j k</kbd> sessions');
    expect(board).toContain('<kbd class="kbd" aria-hidden="true">↵</kbd><span class="kbd-spoken">Enter</span>');
    expect(board).toContain('<kbd class="kbd">n</kbd> next ask');
    const pane = html(createElement(KeysBar, barProps({ owner: "pane", chordLabel: "Ctrl+]" })));
    expect(pane).toContain('Typing into web-api');
    expect(pane).toContain('<kbd class="kbd">Esc</kbd> goes to the session');
    expect(pane).toContain('<kbd class="kbd" aria-hidden="true">Ctrl+]</kbd><span class="kbd-spoken">Control Shift X</span> back to the board');
    // The stage's own cap is gone, and so is the override that squeezed the
    // kit's: CHANGED ON PURPOSE, the bar's cap takes the kit's own 1px 5px
    // (Figma Keys bar), where it was 0 4px.
    expect(stage).not.toContain("ts-kbd");
    expect(stage).not.toContain(".ts-bar .kbd");
    expect(read("styles/status-bar.css")).toMatch(/\.kbd \{[^}]*padding: 1px 5px/);
  });

  it("leads no bar with a glyph: the label says who has the keys", () => {
    // CHANGED ON PURPOSE: V4's Figma draws no leading glyph; the
    // pane's label is --text and the board's --text-secondary instead.
    const pane = html(createElement(KeysBar, barProps({ owner: "pane" })));
    expect(pane).toMatch(/data-owner="pane"><span class="ts-label" data-strong="true">Typing into web-api<\/span>/);
    const board = html(createElement(KeysBar, barProps()));
    expect(board).toMatch(/data-owner="board"><span class="ts-label">Keys on the board<\/span>/);
    for (const out of [board, pane, html(createElement(KeysBar, barProps({ owner: "pane", firstRun: true }))),
      html(createElement(KeysBar, barProps({ owner: "pane", reconnecting: true })))]) {
      expect(out).not.toContain("ts-glyph");
    }
    expect(board + pane).not.toContain("ts-lamp");
    expect(stage).not.toContain("ts-lamp");
  });

  it("draws \"type here\" as plain --muted text that lifts to --text, still a button", () => {
    const out = html(createElement(KeysBar, barProps()));
    expect(out).toContain('<button type="button" class="btn ts-type ts-plain">type here</button>');
    const plain = rule(stage, ".btn.ts-plain");
    expect(decl(plain, "color")).toBe("var(--muted)");
    expect(decl(plain, "font-weight")).toBe("400");
    expect(decl(plain, "background")).toBe("none");
    expect(decl(rule(stage, ".btn.ts-plain:hover"), "color")).toBe("var(--text)");
    expect(stage).not.toMatch(/\.ts-type\s*\{[^}]*(accent|600)/);
  });

  it("puts the buttons in the kit's Quiet at 28, and the owner sentence in no live region", () => {
    expect(decl(rule(stage, ".ts-keys .btn"), "min-height")).toBe("28px");
    expect(decl(rule(stage, ".ts-asks .ts-next"), "min-height")).toBe("28px");
    const run = html(createElement(KeysBar, barProps({
      end: { sentence: "The session ended 14m ago. This is its last frame.", action: "Reopen here", onAction: vi.fn() },
    })));
    expect(run).toContain('<button type="button" class="btn"');
    expect(run).not.toContain("btn primary");
    const everything = [
      html(createElement(KeysBar, barProps())), html(createElement(KeysBar, barProps({ owner: "pane" }))),
      html(createElement(KeysBar, barProps({ firstRun: true }))), run,
      html(createElement(KeysBar, barProps({ asks: { next: { name: "docs-site", waited: "4m" }, resumed: "web-api" } }))),
      html(createElement(KeysBar, barProps({ arrival: { name: "docs-site", tool: "Bash" }, onAnswerArrival: vi.fn() }))),
    ].join("");
    expect(everything).not.toMatch(/aria-live|role="status"|role="alert"/);
  });

  it("runs the asks in the same type, behaviour as it was", () => {
    const out = html(createElement(KeysBar, barProps({ asks: { position: { index: 1, total: 3 } } })));
    // CHANGED ON PURPOSE (this block, V4's Figma keys bar):
    // "Asks" --muted then "2 of 3" --text-secondary with no segment track;
    // the Done glyph and --text-secondary text instead of "✓" in --ok; and
    // Next ask as plain --muted text, with no bold wait and no chevron.
    expect(out).toContain('<span class="ts-count">2 of 3</span>');
    expect(out).not.toContain("ts-track");
    expect(decl(rule(stage, ".ts-count"), "color")).toBe("var(--text-secondary)");
    expect(stage).not.toMatch(/\.ts-track|ts-seg-in/);
    const next = html(createElement(KeysBar, barProps({ asks: { resumed: "web-api", next: { name: "docs-site", waited: "4m" } } })));
    expect(next).toMatch(/<span class="ts-resumed"><span class="ts-glyph" data-glyph="done"[\s\S]*<\/span>web-api resumed<\/span>/);
    expect(next).not.toContain("✓");
    expect(decl(rule(stage, ".ts-resumed"), "color")).toBe("var(--text-secondary)");
    expect(next).toContain("Next ask <span class=\"ts-next-name\">docs-site</span> 4m</button>");
    expect(next).toContain("btn ts-next ts-plain");
    const clear = html(createElement(KeysBar, barProps({ asks: { clear: true } })));
    expect(clear).toMatch(/data-glyph="done"[\s\S]*No more asks/);
    expect(clear).not.toContain("✓");
    // The ask note: the Waiting glyph, "name asks · tool" in --text-secondary,
    // then the key cap n and the word Answer.
    const arrival = html(createElement(KeysBar, barProps({ arrival: { name: "docs-site", tool: "Bash" } })));
    expect(arrival).toMatch(/<span class="ts-arrival"><span class="ts-glyph" data-glyph="waiting"[\s\S]*<\/span>docs-site asks · Bash<\/span>/);
    expect(arrival).toContain('<kbd class="kbd">n</kbd> Answer</button>');
    expect(arrival).not.toMatch(/ap-pulse|<b>/);
    expect(decl(rule(stage, ".ts-arrival"), "color")).toBe("var(--text-secondary)");
    // No pill, no waiting colour on the button: plain text.
    expect(rule(stage, ".ts-asks .ts-next")).not.toMatch(/border-radius|color:/);
    expect(decl(rule(stage, ".ts-asks-label"), "color")).toBe("var(--muted)");
  });

  it("ends the end and notice bars without a square mark, in one forced-colours block", () => {
    // CHANGED ON PURPOSE: Figma V4 draws the sentence alone.
    expect(stage).not.toContain("ts-end-mark");
    expect(touch).not.toContain("ts-end-mark");
    expect(html(createElement(KeysBar, barProps({ notice: "That paste is over 1 MB." })))).toContain('<span class="ts-end">That paste is over 1 MB.</span>');
    expect(touch.split("@media (forced-colors: active) {").length - 1).toBe(1);
  });

  it("says the hosts line in --muted on one line with an ellipsis, Review beside it", () => {
    const out = html(createElement(KeysBar, barProps({ hosts: { said: "2 sessions on an older host", onReview: vi.fn() } })));
    expect(out).toContain('<span class="ts-hosts-said" title="2 sessions on an older host">2 sessions on an older host</span>');
    expect(out).toContain(">Review</button>");
    const said = rule(stage, ".ts-hosts-said");
    expect(decl(said, "color")).toBe("var(--muted)");
    expect(decl(said, "text-overflow")).toBe("ellipsis");
    expect(said).not.toMatch(/white-space:\s*normal/);
    expect(stage).not.toContain(":has(.ts-hosts)");
  });

  it("grows the bar for the hosts line under a coarse pointer, so a fingertip reads the whole sentence", () => {
    // Fine pointer: one line, an ellipsis, the title. Coarse: the sentence
    // wraps and the bar (height auto, 36 at least) grows with it.
    expect(touch).toMatch(/@media \(pointer: coarse\)[\s\S]*\.ts-bar:has\(\.ts-asks\) \{ min-height: 36px; \}/);
    expect(touch).toMatch(/\.ts-asks > \.ts-hosts-said \{[^}]*white-space: normal;[^}]*\}/);
    expect(decl(rule(stage, ".ts-bar:has(.ts-asks:not(.ts-hosts))"), "flex-wrap")).toBe("wrap");
    expect(touch).toMatch(/\.ts-bar:has\(\.ts-hosts\) \{ height: auto;[^}]*flex-wrap: wrap;/);
    expect(stage, "a fine pointer keeps the hosts line on one row").not.toContain(":has(.ts-hosts)");
    // Review is the keys bar's 28 high everywhere, 32 under a fingertip.
    expect(decl(rule(stage, ".ts-hosts .btn"), "min-height")).toBe("28px");
    expect(touch).toMatch(/\.ts-hosts \.btn,/);
  });

  it("keeps a long name from pushing the buttons beside it out of reach", () => {
    // The ask note, the resumed note, the keys bar's sentences: cut with an
    // ellipsis; the buttons keep their size.
    const notes = rule(stage, ".ts-asks > .ts-arrival,\n.ts-asks > .ts-resumed");
    expect(decl(notes, "min-width")).toBe("0");
    expect(decl(notes, "text-overflow")).toBe("ellipsis");
    expect(decl(rule(stage, ".ts-asks > *"), "flex")).toBe("none");
    expect(decl(rule(stage, ".ts-keys > *"), "flex")).toBe("none");
    expect(rule(stage, ".ts-keys > .ts-label,\n.ts-keys > .ts-reconnecting,\n.ts-keys > .ts-end")).toContain("text-overflow: ellipsis");
    const out = html(createElement(KeysBar, barProps({ owner: "pane", reconnecting: true, name: "a-very-long-session-name" })));
    expect(out).toContain('title="Reconnecting to a-very-long-session-name. Nothing typed now is sent."');
  });

  it("gives a bar under 480px its way out first: the Esc hint goes, the release chord stays", () => {
    expect(decl(rule(stage, ".ts-bar"), "container")).toBe("ts-bar / inline-size");
    expect(stage).toMatch(/@container ts-bar \(max-width: 480px\) \{\s*\.ts-hint\[data-optional\] \{ display: none; \}/);
    const out = html(createElement(KeysBar, barProps({ owner: "pane", chordLabel: "Ctrl+]" })));
    expect(out).toContain('<span class="ts-hint" data-optional="true"><kbd class="kbd">Esc</kbd> goes to the session</span>');
    expect(out.match(/data-optional/g)).toHaveLength(1);
  });

  it("gives the Waiting and Done marks their own colours wherever the text beside them is quieter", () => {
    expect(decl(rule(stage, '.ts-glyph[data-glyph="waiting"]'), "color")).toBe("var(--warn)");
    expect(decl(rule(stage, '.ts-glyph[data-glyph="done"]'), "color")).toBe("var(--ok)");
  });

  it("drops the chip to its percent alone in a header too narrow for the name", () => {
    expect(decl(rule(stage, ".ts-head"), "container")).toBe("ts-head / inline-size");
    expect(stage).toMatch(/@container ts-head \(max-width: 480px\) \{\s*\.ts-ctxlead \{[^}]*clip-path: inset\(50%\)/);
    // The words stay in the text for a screen reader; only the sight loses them.
    const out = html(createElement(StageHeader, headerProps({ context: { used: 640, window: 200_000 } })));
    expect(out).toContain('<span class="ts-ctxlead">640 / 200k · </span>0%');
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

  it("crossfades under reduced motion over the house Fast duration, with no travel", () => {
    // CHANGED ON PURPOSE: this pinned duration 0 (an instant cut). V4's Figma
    // and V4's motion rules say "Crossfade, no travel", and
    // "Travel goes, fades stay", over --dur-fast.
    const src = withoutComments(read("components/terminal/StageShell.tsx"));
    expect(src).toContain('reduced ? tokenMs("--dur-fast") : dir === "open" ? FLIP_OPEN_MS : FLIP_CLOSE_MS');
    expect(src).toContain("(reduced ? crossfadeFrame : morphFrame)(plan, eased)");
    expect(src).toMatch(/rider: !reduced && card/);
  });

  it("holds the stage in its column and moves only opacity when it crossfades", () => {
    const column = { x: 400, y: 0, w: 600, h: 800 };
    const card = { x: 40, y: 40, w: 200, h: 100 };
    const open: MorphPlan = { direction: "open", w: 1000, h: 800, from: card, to: column, rider: { card, header: { x: 412, y: 10, w: 80, h: 20 } } };
    const close: MorphPlan = { direction: "close", w: 1000, h: 800, from: column, to: card, rider: null };
    for (const plan of [open, close]) {
      const a = crossfadeFrame(plan, 0), b = crossfadeFrame(plan, 0.5), c = crossfadeFrame(plan, 1);
      // Never a travelling rect, rider or edge: the same cut and no rider in every frame.
      expect(b.clip).toBe(a.clip);
      expect(c.clip).toBe(a.clip);
      expect(a.clip).toBe("inset(0px 0px 0px 400px round 0px)");
      expect([a.rider, b.rider, c.rider]).toEqual([null, null, null]);
      expect([a.edge.opacity, b.edge.opacity, c.edge.opacity]).toEqual([0, 0, 0]);
      expect([a.content, a.late, a.chip]).toEqual([1, 1, 1]);
    }
    expect([crossfadeFrame(open, 0).stage, crossfadeFrame(open, 1).stage]).toEqual([0, 1]);
    expect([crossfadeFrame(close, 0).stage, crossfadeFrame(close, 1).stage]).toEqual([1, 0]);
    expect(crossfadeFrame(open, 0.5).stage).toBe(0.5);
    expect(crossfadeFrame(close, 0.25).stage).toBe(0.75);
    // The full morph does travel, so the two are not the same thing.
    expect(morphFrame({ ...open }, 0.5).clip).not.toBe(crossfadeFrame(open, 0.5).clip);
  });

  it("flies the rider at the header's name size, 13px", () => {
    expect(decl(rule(shell, ".stage-rider"), "font-size")).toBe("13px");
    expect(decl(rule(stage, ".ts-name"), "font-size")).toBe("13px");
    // Only the header's glyph waits for the rider: the keys bar's and the
    // cards' sit beside text that is already there.
    expect(shell).toMatch(/\.stage-dock\[data-rider\] \.ts-head \.ts-glyph,/);
    expect(shell).not.toMatch(/\.stage-dock\[data-rider\] \.ts-glyph/);
  });
});

describe("the geometry follows the header as it is drawn", () => {
  const ts = withoutComments(read("components/terminal/TerminalStage.tsx"));
  const shellSrc = withoutComments(read("components/terminal/StageShell.tsx"));
  const useStage = withoutComments(read("use-stage.ts"));

  it("TerminalStage measures .ts-head and reports it through onHeadH, with the bar's one measure", () => {
    // keys-bar-rows.test.ts runs that measure (rounding, a part not laid out).
    expect(ts).toContain("onHeadH?(height: number): void;");
    expect(ts).toContain('useDrawnHeight(rootRef, ".ts-bar", p.onBarH);');
    expect(ts).toContain('useDrawnHeight(rootRef, ".ts-head", p.onHeadH);');
  });

  it("StageShell passes it on, and use-stage fits the geometry to it, from the density until it has said", () => {
    expect(shellSrc).toContain("onHeadH={stage.onHeadH}");
    expect(useStage).toContain("const [headH, setHeadH] = useState(paneHeadH);");
    expect(useStage).toContain("headHFor(typeof document === \"undefined\" ? undefined : document.documentElement?.dataset?.density)");
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
