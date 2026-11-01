// V4's Attention rail: the left column's session list as the Board window's
// rail (V4's Figma: Sessions, Rail / Header, Rail / Group header,
// Rail / Row, Rail / Nobody waiting, the fold line, and the motion cards Rail changes order, A row joins
// or leaves,
// Land, Row expand and fold, Status glyph).
//
// Three halves. The rules are pure (rail-model.ts, session-seen.ts,
// rail-row-copy.ts, and rank/buildRows) and are called on sessions the real
// reducer built. The look is read out of the sheet the way v4-settings.test.ts
// and v4-bars.test.ts read theirs: tokens only, no hex. And what a bare-node
// suite cannot see (the FLIP, the pointer hold) is pinned at the source so it
// cannot quietly stop asking the pure rule.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import SessionList, { buildRows, rank, type Row } from "../components/SessionList";
import { applyEvent, initialState, type GraphState } from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";
import { isUnseen, markSeen, resetSessionsSeen, SEEN_CAP, turnEndedAt } from "../session-seen";
import {
  RAIL_FOLD_AT, RAIL_GROUP_LABELS, foldMotion, foldPlan, heldLine, holdOrder, joinMotion, measureGate, membershipChange,
  nobodyWaitingText, railHeld, releaseMotion,
  type Slot,
} from "../rail-model";
import { railGlyph, railLine, railTime, rowSpoken, rowTooltip, runningTool } from "../rail-row-copy";
import { cancelFlights, durationMs } from "../rail-motion";
import { baselineSeen, mergeSeen, syncSeenFromStorage } from "../session-seen";
import { sheetRules } from "./sheet-cascade";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const source = (p: string) => readFileSync(here(p), "utf8");
const code = (p: string) => source(p).replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");

// ── the sheet ───────────────────────────────────────────────────────────────

const rules = sheetRules();
/** The last declaration of `prop` on exactly this selector, outside any @media. */
function decl(selector: string, prop: string, media: string | null = null): string | undefined {
  let found: string | undefined;
  for (const r of rules) {
    if (r.media !== media || !r.selectors.includes(selector)) continue;
    const m = [...r.body.matchAll(new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;]+)`, "g"))].at(-1);
    if (m) found = m[1].trim();
  }
  return found;
}
const rail = readFileSync(here("../styles/session-list.css"), "utf8");

describe("the column (Figma Sessions)", () => {
  it("is the rail token wide, on the panel, with the line on its right", () => {
    expect(decl(".session-list", "width")).toBe("calc(var(--rail-w) + var(--ui-panel-increase, 0px))");
    expect(decl(".session-list", "background")).toBe("var(--panel)");
    expect(decl(".session-list", "border-right")).toBe("1px solid var(--line)");
    expect(decl(".session-list", "display")).toBe("flex");
    expect(decl(".session-list", "flex-direction")).toBe("column");
  });

  it("scrolls its list, between a fixed header and the removed cards' line", () => {
    expect(decl(".session-list .sl-rows", "padding")).toBe("4px");
    expect(decl(".session-list .sl-rows", "overflow-y")).toBe("auto");
    expect(decl(".session-list .sl-rows", "flex")).toBe("1");
    expect(decl(".session-list .sl-foot", "flex")).toBe("none");
  });

  it("takes the width of the density in force, for the column and for the room right of it", () => {
    const hook = code("../use-left-column.ts");
    expect(hook).toContain('getPropertyValue("--rail-w")');
    expect(hook).toMatch(/attributeFilter: \["data-density"\]/);
    expect(code("../App.tsx")).toMatch(/leftColumnWidth\(leftPanel, railWidth\)/);
  });
});

describe("Rail / Header", () => {
  it("is --pane-head-h tall, 12 in and 6 out, a line under it, no fill", () => {
    expect(decl(".session-list .sl-header", "height")).toBe("var(--pane-head-h)");
    expect(decl(".session-list .sl-header", "padding")).toBe("0 6px 0 12px");
    expect(decl(".session-list .sl-header", "border-bottom")).toBe("1px solid var(--line-soft)");
    expect(decl(".session-list .sl-header", "justify-content")).toBe("space-between");
    expect(decl(".session-list .sl-header", "align-items")).toBe("center");
    expect(decl(".session-list .sl-header", "background")).toBeUndefined();
  });

  it("prints Sessions at 13/20 600 and the count in 12/16 mono muted, 6 apart on a baseline", () => {
    expect(decl(".session-list .sl-header h2", "gap")).toBe("6px");
    expect(decl(".session-list .sl-header h2", "align-items")).toBe("baseline");
    expect(decl(".session-list .sl-header h2", "line-height")).toBe("20px");
    expect(decl(".session-list .sl-header h2", "color")).toBe("var(--text)");
    expect(decl(".session-list .sl-header h2", "font-size")).toBe("calc(13px + var(--ui-text-increase, 0px))");
    expect(decl(".session-list .sl-header h2", "font-weight")).toBe("600");
    expect(decl(".session-list .sl-count", "font-family")).toBe("var(--font-mono)");
    expect(decl(".session-list .sl-count", "font-size")).toBe("calc(12px + var(--ui-text-increase, 0px))");
    expect(decl(".session-list .sl-count", "line-height")).toBe("16px");
    expect(decl(".session-list .sl-count", "color")).toBe("var(--muted)");
  });

  it("keeps the close as the one control, a quiet 24x24 with radius 6 (no Group, no Plus)", () => {
    expect(decl(".session-list .sl-close", "width")).toBe("24px");
    expect(decl(".session-list .sl-close", "height")).toBe("24px");
    expect(decl(".session-list .sl-close", "border-radius")).toBe("6px");
    expect(decl(".session-list .sl-close", "background")).toBe("transparent");
    const list = code("../components/SessionList.tsx");
    expect((list.match(/<button type="button" className="sl-close"/g) ?? []).length).toBe(1);
    expect(list).not.toMatch(/aria-label="(?:Group|Plus|New session)|sl-waiting-count|sl-live-count/);
    expect(code("../components/RailParts.tsx")).toMatch(/<svg width="14" height="14"[^>]*>\s*<path d="M3\.5 3\.5l7 7M10\.5 3\.5l-7 7" \/>/);
  });
});

describe("Rail / Group header and the fold line", () => {
  it("is --row-group tall, 8 in, label 12/16 600 secondary, count 11/14 mono muted", () => {
    expect(decl(".session-list .sl-group-head", "height")).toBe("var(--row-group)");
    expect(decl(".session-list .sl-group-head", "padding")).toBe("0 8px");
    expect(decl(".session-list .sl-group-head", "justify-content")).toBe("space-between");
    expect(decl(".session-list .sl-group-head.spaced", "margin-top")).toBe("8px");
    expect(decl(".session-list .sl-group-label", "font-size")).toBe("calc(12px + var(--ui-text-increase, 0px))");
    expect(decl(".session-list .sl-group-label", "line-height")).toBe("16px");
    expect(decl(".session-list .sl-group-label", "font-weight")).toBe("600");
    expect(decl(".session-list .sl-group-label", "color")).toBe("var(--text-secondary)");
    expect(decl(".session-list .sl-group-count", "font-family")).toBe("var(--font-mono)");
    expect(decl(".session-list .sl-group-count", "font-size")).toBe("calc(11px + var(--ui-text-increase, 0px))");
    expect(decl(".session-list .sl-group-count", "line-height")).toBe("14px");
    expect(decl(".session-list .sl-group-count", "color")).toBe("var(--muted)");
  });

  it("folds a group into a 28px row with the chevron first, 6 in and 8 out, 6 apart", () => {
    expect(decl(".session-list .sl-group-head:has(> .sl-fold-btn)", "height")).toBe("28px");
    expect(decl(".session-list .sl-fold-btn", "padding")).toBe("0 8px 0 6px");
    expect(decl(".session-list .sl-fold-btn", "gap")).toBe("6px");
    expect(decl(".session-list .sl-fold-btn .sl-group-count", "margin-left")).toBe("auto");
    expect(code("../components/RailParts.tsx")).toMatch(/<ChevronGlyph \/>\s*<span className="sl-group-label">/);
  });

  it("puts a 26px 'N more' line under the cut, 32 in and 8 out, the chevron after the words", () => {
    expect(decl(".session-list .sl-more", "height")).toBe("26px");
    expect(decl(".session-list .sl-more", "padding")).toBe("0 8px 0 32px");
    expect(decl(".session-list .sl-more", "gap")).toBe("6px");
    expect(decl(".session-list .sl-more", "color")).toBe("var(--muted)");
    expect(code("../components/RailParts.tsx")).toMatch(/\{count\} more\s*<ChevronGlyph \/>/);
  });

  it("turns the chevron a quarter when open, on --dur-base out and --dur-exit back", () => {
    expect(decl('.session-list [aria-expanded="true"] > .sl-chev', "transform")).toBe("rotate(90deg)");
    expect(decl('.session-list [aria-expanded="true"] > .sl-chev', "transition-duration")).toBe("var(--dur-base)");
    expect(decl(".session-list .sl-chev", "transition")).toBe("transform var(--dur-exit) var(--ease)");
  });
});

describe("Rail / Row", () => {
  it("is --row-rail tall at least, 4 and 8 in, --r-panel round, 8 between, nothing at rest", () => {
    expect(decl(".session-list .sl-row", "min-height")).toBe("var(--row-rail)");
    expect(decl(".session-list .sl-row", "padding")).toBe("4px 8px");
    expect(decl(".session-list .sl-row", "border-radius")).toBe("var(--r-panel)");
    expect(decl(".session-list .sl-row", "gap")).toBe("8px");
    expect(decl(".session-list .sl-row", "align-items")).toBe("flex-start");
    expect(decl(".session-list .sl-row", "background")).toBe("transparent");
  });

  it("hovers on the kit's row wash and selects on --selected", () => {
    expect(decl(".session-list .sl-row:hover", "background")).toBe("var(--ctl-fill)");
    expect(decl(".session-list .sl-row.selected", "background")).toBe("var(--selected)");
  });

  it("sets the name 13/20 600, the model 11/14 mono muted, the clock 12/16 mono 500", () => {
    expect(decl(".session-list .sl-label", "font-size")).toBe("calc(13px + var(--ui-text-increase, 0px))");
    expect(decl(".session-list .sl-label", "line-height")).toBe("20px");
    expect(decl(".session-list .sl-label", "font-weight")).toBe("600");
    expect(decl(".session-list .sl-label", "color")).toBe("var(--text)");
    expect(decl(".session-list .sl-name", "gap")).toBe("6px");
    expect(decl(".session-list .sl-line1", "justify-content")).toBe("space-between");
    expect(decl(".session-list .sl-line1", "align-items")).toBe("baseline");
    expect(decl(".session-list .sl-model", "font-family")).toBe("var(--font-mono)");
    expect(decl(".session-list .sl-model", "font-size")).toBe("calc(11px + var(--ui-text-increase, 0px))");
    expect(decl(".session-list .sl-model", "line-height")).toBe("14px");
    expect(decl(".session-list .sl-model", "color")).toBe("var(--muted)");
    expect(decl(".session-list .sl-time", "font-family")).toBe("var(--font-mono)");
    expect(decl(".session-list .sl-time", "font-size")).toBe("calc(12px + var(--ui-text-increase, 0px))");
    expect(decl(".session-list .sl-time", "font-weight")).toBe("500");
    expect(decl(".session-list .sl-time", "line-height")).toBe("16px");
    expect(decl(".session-list .sl-time.warn", "color")).toBe("var(--warn)");
    expect(decl(".session-list .sl-time.quiet", "color")).toBe("var(--text-secondary)");
  });

  it("sets the second line 12/16, one line, the tool name 500 in the secondary tier", () => {
    expect(decl(".session-list .sl-line2", "font-size")).toBe("calc(12px + var(--ui-text-increase, 0px))");
    expect(decl(".session-list .sl-line2", "line-height")).toBe("16px");
    expect(decl(".session-list .sl-line2", "color")).toBe("var(--muted)");
    expect(decl(".session-list .sl-line2", "white-space")).toBe("nowrap");
    expect(decl(".session-list .sl-line2", "text-overflow")).toBe("ellipsis");
    expect(decl(".session-list .sl-line2.mono", "font-family")).toBe("var(--font-mono)");
    expect(decl(".session-list .sl-tool", "font-weight")).toBe("500");
    expect(decl(".session-list .sl-tool", "color")).toBe("var(--text-secondary)");
  });

  it("draws the glyph 14px with 3 above, Working on --pulse-live, Waiting still", () => {
    expect(decl(".session-list .sl-glyph", "padding-top")).toBe("3px");
    expect(decl('.session-list .sl-glyph[data-glyph="working"] .state-mark', "animation")).toBe("pulse var(--pulse-live) infinite");
    expect(rail).not.toMatch(/data-glyph="waiting"\][^{]*\{[^}]*animation/);
    // Changed on purpose (review item 6): the crossfade is no longer the
    // sheet's @starting-style, which replayed whenever a row was moved in the
    // DOM. RailGlyph plays it, from the motion code, when this row's kind changes.
    expect(decl(".session-list .sl-glyph-mark", "transition")).toBeUndefined();
    expect(rail).not.toMatch(/@starting-style\s*\{\s*\.session-list \.sl-rows\[data-live\] \.sl-glyph-mark/);
    const parts = code("../components/RailParts.tsx");
    expect(parts).toContain("if (shown.current === kind) return;");
    expect(parts).toContain("fadeIn(mark.current);");
    expect(parts).toContain("<AlertMark size={14} />");
    expect(parts).toContain('<StateMark kind="live" size={14} />');
  });

  it("steps the muted words up a tier on the fill, where --muted is under 4.5:1", () => {
    expect(decl(".session-list .sl-row:hover .sl-line2", "color")).toBe("var(--text-secondary)");
    expect(decl(".session-list .sl-row.selected .sl-model", "color")).toBe("var(--text-secondary)");
  });

  it("takes a tooltip for everything the old row drew and this one does not", () => {
    const parts = code("../components/RailParts.tsx");
    expect(parts).toContain("title={rowTooltip(r, removed)}");
    expect(parts).not.toMatch(/sl-cost|sl-plan|sl-recap|sl-status|sl-elapsed|model-chip/);
  });

  it("keeps a phone row at 44 or more: the phone frame's 62", () => {
    expect(decl(".session-list .sl-row", "min-height", "(max-width: 640px)")).toBe("62px");
  });

  // control-edges.test.ts used to list this rule as an exemption from its edge
  // sweep. The row draws no edge now, so the ring is the deck's own
  // :focus-visible outline, pulled inside the row so the next row cannot
  // cover it, and rounded with the row's fill.
  it("draws the deck's focus ring inside the row", () => {
    expect(decl(".session-list .sl-row:focus-visible", "outline-offset")).toBe("-2px");
    expect(decl(".session-list .sl-row:focus-visible", "border-radius")).toBe("var(--r-panel)");
    expect(decl(".session-list .sl-row:focus-visible", "outline")).toBeUndefined();
  });
});

describe("Rail / Nobody waiting and the Order held line", () => {
  it("is the quiet 12/16 muted line, 6 and 8 in, 8 between", () => {
    expect(decl(".session-list .sl-nobody", "padding")).toBe("6px 8px");
    expect(decl(".session-list .sl-nobody", "gap")).toBe("8px");
    expect(decl(".session-list .sl-nobody", "color")).toBe("var(--muted)");
    expect(decl(".session-list .sl-nobody", "white-space")).toBe("nowrap");
  });

  // Changed on purpose (review item 1): it was a list item with 10px under it,
  // which pushed every row down ~38px exactly while the pointer was over the
  // list. It is now an overlay on the header's box and takes no space in the list.
  it("sits on --bg-soft, radius 6, 6 and 8 in, 8 between, over the header's box and out of the list's flow", () => {
    expect(decl(".session-list .sl-held", "background")).toBe("var(--bg-soft)");
    expect(decl(".session-list .sl-held", "border-radius")).toBe("6px");
    expect(decl(".session-list .sl-held", "padding")).toBe("6px 8px");
    expect(decl(".session-list .sl-held", "gap")).toBe("8px");
    expect(decl(".session-list .sl-held", "color")).toBe("var(--muted)");
    expect(decl(".session-list .sl-held", "position")).toBe("absolute");
    expect(decl(".session-list .sl-held", "height")).toBe("var(--pane-head-h)");
    expect(decl(".session-list .sl-held", "pointer-events")).toBe("none");
    expect(decl(".session-list .sl-held", "margin-bottom")).toBeUndefined();
    expect(decl(".session-list", "position")).toBe("relative");
    const list = code("../components/SessionList.tsx");
    expect(list).toMatch(/<div className="sl-held"><PauseGlyph \/>/);
    // Not a row of the list: it is drawn before the header, outside the <ul>.
    expect(list).not.toMatch(/nodes\.push\(<li key="held"/);
    expect(list.indexOf('className="sl-held"')).toBeLessThan(list.indexOf('<ul className="sl-rows"'));
    expect(list).not.toMatch(/aria-live|role="status"/);
  });
});

describe("the motion cards, read from the sheet", () => {
  // Changed on purpose (review item 6): the join and leave were the sheet's
  // transitions and @starting-style, which play again whenever a row is moved
  // in the DOM (into a fold body, out of a ghost, to another group) and so
  // replayed on top of the FLIP. They are rail-motion.ts's now, by id, for
  // rows that are really new or really gone; the sheet keeps only the end
  // state of a leaving row. Same durations and easings, from the tokens.
  it("opens a joining row's space and fades it in, --dur-base on --ease, from the motion code and not @starting-style", () => {
    expect(rail).not.toMatch(/@starting-style\s*\{\s*\.session-list \.sl-rows/);
    expect(rail).not.toMatch(/data-live|data-long/);
    expect(decl(".session-list .sl-rows > .sl-row-item", "transition")).toBeUndefined();
    const motion = code("../rail-motion.ts");
    expect(motion).toContain('{ gridTemplateRows: "0fr", opacity: 0 }, { gridTemplateRows: "1fr", opacity: 1 }], { duration: tokenMs("--dur-base"), easing }');
  });

  // The browser check found every move, join and fade over in under a
  // millisecond: the built sheet's minifier writes 240ms as .24s, and the
  // durations were read as bare numbers.
  it("reads a duration token in either unit, as the built sheet writes it", () => {
    expect(durationMs("240ms")).toBe(240);
    expect(durationMs(".24s")).toBe(240);
    expect(durationMs("0.15s")).toBe(150);
    expect(durationMs(" 120ms ")).toBe(120);
    expect(durationMs("")).toBe(0);
    const motion = code("../rail-motion.ts");
    expect(motion).not.toMatch(/parseFloat\(motionToken/);
  });

  it("fades a leaving row over --dur-exit and closes its space --dur-base after 100ms, holding the end state in the sheet", () => {
    expect(decl(".session-list .sl-rows > .sl-row-item.leaving", "transition")).toBeUndefined();
    expect(decl(".session-list .sl-rows > .sl-row-item.leaving", "grid-template-rows")).toBe("0fr");
    expect(decl(".session-list .sl-rows > .sl-row-item.leaving", "opacity")).toBe("0");
    expect(decl(".session-list .sl-rows > .sl-row-item.leaving", "pointer-events")).toBe("none");
    const motion = code("../rail-motion.ts");
    expect(motion).toContain('{ duration: tokenMs("--dur-exit"), easing, fill: "backwards" }');
    expect(motion).toContain('delay: LEAVE_SPACE_DELAY_MS');
  });

  it("plays a join or leave only for ids that are really new or really gone", () => {
    const prev = new Set(["a", "b", "c"]);
    expect(membershipChange(null, prev)).toEqual({ joined: [], left: [] });
    expect(membershipChange(prev, new Set(["c", "b", "a"]))).toEqual({ joined: [], left: [] });
    expect(membershipChange(prev, new Set(["a", "c", "d"]))).toEqual({ joined: ["d"], left: ["b"] });
  });

  it("lights the landed row with --accent-16, fading to nothing over --dur-base, once", () => {
    expect(decl(".session-list .sl-land", "background")).toBe("var(--accent-16)");
    expect(decl(".session-list .sl-land", "animation")).toBe("sl-land var(--dur-base) var(--ease) both");
    expect(rail).toMatch(/@keyframes sl-land \{ from \{ opacity: 1; \} to \{ opacity: 0; \} \}/);
  });

  it("opens a fold by grid rows and opacity, --dur-base in and --dur-exit out", () => {
    expect(decl(".session-list .sl-fold", "grid-template-rows")).toBe("0fr");
    expect(decl(".session-list .sl-fold", "transition")).toBe("grid-template-rows var(--dur-exit) var(--ease), opacity var(--dur-exit) var(--ease)");
    expect(decl(".session-list .sl-fold[data-open]", "grid-template-rows")).toBe("1fr");
    expect(decl(".session-list .sl-fold[data-open]", "transition-duration")).toBe("var(--dur-base)");
    expect(decl('.session-list .sl-fold[data-motion="instant"]', "transition")).toBe("none");
    expect(decl('.session-list .sl-fold[data-motion="fade"]', "transition")).toBe("opacity var(--dur-fast) var(--ease)");
  });

  // Changed on purpose (review item 6): the sheet's reduced-motion join and
  // leave transitions went with the transitions; joinMotion answers "fade"
  // under reduced motion and the motion code plays the opacity alone.
  it("answers reduced motion: space at once, rows fade, the pulse stays", () => {
    expect(decl(".session-list .sl-rows > .sl-row-item", "transition", "(prefers-reduced-motion: reduce)")).toBeUndefined();
    const motion = code("../rail-motion.ts");
    expect(motion).toContain('how === "fade"');
    expect(motion).toContain('{ duration: tokenMs("--dur-fast"), easing }');
    expect(rail).not.toMatch(/prefers-reduced-motion[\s\S]*pulse var\(--pulse-live\) none/);
  });

  it("writes no colour of its own: tokens only", () => {
    expect(rail.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  });
});

// ── the rules, on sessions the reducer built ────────────────────────────────

const T0 = 1_700_000_000_000;
let seq = 0;
const send = (state: GraphState, sid: string, payload: HookPayload, at: number) =>
  applyEvent(state, { seq: ++seq, receivedAt: T0 + at, source: "hook", payload: { session_id: sid, ...payload } } as HookEnvelope);
const begin = (s: GraphState, sid: string, at = 0, prompt = true) => {
  s = send(s, sid, { hook_event_name: "SessionStart", cwd: `/repo/${sid}` }, at);
  return prompt ? send(s, sid, { hook_event_name: "UserPromptSubmit", prompt: "go" }, at + 1) : s;
};
const stop = (s: GraphState, sid: string, at: number) => send(s, sid, { hook_event_name: "Stop" } as HookPayload, at);
const notify = (s: GraphState, sid: string, type: string, message: string, at: number) =>
  send(s, sid, { hook_event_name: "Notification", notification_type: type, message } as HookPayload, at);

function board(): GraphState {
  let s = initialState();
  s = begin(s, "perm", 0);
  s = send(s, "perm", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "p1", tool_input: { command: "npm test" } }, 100);
  s = notify(s, "perm", "permission_prompt", "Claude needs your permission to use Bash", 5_000);
  s = begin(s, "ask", 0);
  s = notify(s, "ask", "agent_needs_input", "which database?", 3_000);
  s = begin(s, "work", 0);
  s = send(s, "work", { hook_event_name: "PreToolUse", tool_name: "Edit", tool_use_id: "w1", tool_input: { file_path: "src/a.ts" } }, 200);
  s = begin(s, "bg", 0);
  s = stop(s, "bg", 1_000);
  s.agents.get("bg")!.job = { id: "j1", state: "working", detail: "2 shells still running", updatedAt: T0 };
  s = begin(s, "idle-unseen", 0);
  s = stop(s, "idle-unseen", 20_000);
  s = notify(s, "idle-unseen", "idle_prompt", "Claude is waiting for your input", 80_000);
  s = begin(s, "failed", 0);
  s = send(s, "failed", { hook_event_name: "StopFailure", error: "rate_limit", last_assistant_message: "Rate limited" } as HookPayload, 30_000);
  s = begin(s, "done-unseen", 0);
  s = stop(s, "done-unseen", 40_000);
  s = begin(s, "done-seen", 0);
  s = stop(s, "done-seen", 10_000);
  s = begin(s, "fresh", 0, false);
  return s;
}

beforeEach(() => { seq = 0; resetSessionsSeen(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("the four groups, in order", () => {
  const rowsOf = () => {
    const s = board();
    markSeen("done-seen", s.agents.get("done-seen")!.endedAt);
    return buildRows(s, T0 + 100_000);
  };
  const groups = (rows: Row[]) => Object.fromEntries(rows.map(r => [r.sessionId, rank(r)]));

  it("puts a permission prompt and a question in Needs you, the longest waiting first", () => {
    const rows = rowsOf();
    expect(groups(rows).perm).toBe(0);
    expect(groups(rows).ask).toBe(0);
    expect(rows.slice(0, 2).map(r => r.sessionId)).toEqual(["ask", "perm"]);
  });

  it("puts a running turn and a background job in Working", () => {
    expect(groups(rowsOf())).toMatchObject({ work: 1, bg: 1 });
  });

  it("puts an ended turn you have not looked at in Done · unseen: idle block, failure and done alike", () => {
    expect(groups(rowsOf())).toMatchObject({ "idle-unseen": 2, failed: 2, "done-unseen": 2 });
  });

  it("puts a turn you have seen, and a session never prompted, in Idle", () => {
    expect(groups(rowsOf())).toMatchObject({ "done-seen": 3, fresh: 3 });
  });

  it("orders Done · unseen by the turn's end, newest first, and fills the rest by group", () => {
    const rows = rowsOf();
    // Idle goes by the latest activity: the ended turn, else the start. Working
    // goes by when its turn began (newest first, then id), checked on its own below;
    // bg and work began together here, so the id decides.
    expect(rows.map(r => r.sessionId))
      .toEqual(["ask", "perm", "bg", "work", "done-unseen", "failed", "idle-unseen", "done-seen", "fresh"]);
  });

  it("reads the turn's end from the root's endedAt, and the idle block only when there is none", () => {
    const rows = rowsOf();
    const idle = rows.find(r => r.sessionId === "idle-unseen")!;
    // The Stop came at +20s and the idle notification at +80s: the end is the Stop.
    expect(idle.turnEndedAt).toBe(T0 + 20_000);
    expect(idle.waiting?.since).toBe(T0 + 80_000);
    expect(turnEndedAt({ state: "active", waiting: { kind: "idle", since: 7, message: "" } })).toBe(7);
    expect(turnEndedAt({ state: "active" })).toBeNull();
    expect(turnEndedAt({ state: "done", endedAt: 5, waiting: { kind: "idle", since: 7, message: "" } })).toBe(5);
  });

  it("draws each state's glyph: Waiting, Working (Background too), Done, Error, Idle", () => {
    const rows = rowsOf();
    const glyph = (id: string) => railGlyph(rows.find(r => r.sessionId === id)!, rank(rows.find(r => r.sessionId === id)!));
    expect(glyph("perm")).toBe("waiting");
    expect(glyph("work")).toBe("working");
    expect(glyph("bg")).toBe("working");
    expect(glyph("done-unseen")).toBe("done");
    expect(glyph("failed")).toBe("error");
    expect(glyph("fresh")).toBe("idle");
  });
});

describe("what each row says", () => {
  const rows = () => { const s = board(); return buildRows(s, T0 + 100_000); };
  const row = (id: string) => rows().find(r => r.sessionId === id)!;
  const line = (id: string) => railLine(row(id), rank(row(id)));
  const time = (id: string) => railTime(row(id), rank(row(id)), T0 + 100_000);

  it("names the blocked tool and what it wants, or asks the question", () => {
    expect(line("perm")).toMatchObject({ kind: "tool", name: "Bash" });
    expect((line("perm") as { rest: string }).rest).toContain("npm test");
    expect(line("ask")).toEqual({ kind: "mono", text: "Asks · which database?" });
  });

  it("names the running tool; a background row says the job's own line", () => {
    expect(line("work")).toMatchObject({ kind: "tool", name: "Edit" });
    expect(line("bg")).toEqual({ kind: "sans", text: "Turn ended · 2 shells still running" });
  });

  it("invites a first prompt on a session that never had one, and gives it no clock", () => {
    expect(line("fresh")).toEqual({ kind: "sans", text: "Ready for a first prompt" });
    expect(time("fresh")).toBeNull();
  });

  it("counts the wait in the warn tone, the turn quietly, and says how long ago a turn ended", () => {
    expect(time("perm")).toMatchObject({ tone: "warn", text: "1m" });
    expect(time("work")).toMatchObject({ tone: "quiet" });
    expect(time("done-unseen")).toEqual({ text: "1m ago", tone: "quiet", spoken: "ended " });
    expect(time("idle-unseen")?.spoken).toBe("your turn, ended ");
  });

  it("keeps the figures the row left out, whole, in its tooltip", () => {
    const r: Row = { ...row("work"), toolCount: 1, cost: 2.5, plan: null, planTitle: "" };
    const title = rowTooltip({ ...r, planTitle: "1. read\n2. write", plan: { done: 0, total: 2, current: "read", next: false, allDone: false } as Row["plan"] }, false);
    expect(title).toContain("1 tool · $2.50 session spend");
    expect(title).toContain("1. read");
    expect(rowTooltip(r, true).split("\n")[0]).toBe(`Bring ${r.label} back to the board`);
  });
});

// ── the seen marker ─────────────────────────────────────────────────────────

describe("the seen marker", () => {
  it("is unseen until looked at, and a new finished turn makes it unseen again", () => {
    expect(isUnseen("s", 100)).toBe(true);
    markSeen("s", 100);
    expect(isUnseen("s", 100)).toBe(false);
    expect(isUnseen("s", 101)).toBe(true);
    markSeen("s", 50);
    expect(isUnseen("s", 100)).toBe(false);
  });

  it("is never unseen while the turn is still running", () => {
    expect(isUnseen("s", null)).toBe(false);
    markSeen("s", null);
    expect(isUnseen("s", 1)).toBe(true);
  });

  it("counts a look only while the tab is the one on screen", () => {
    vi.stubGlobal("document", { visibilityState: "hidden" });
    markSeen("s", 100);
    expect(isUnseen("s", 100)).toBe(true);
    vi.stubGlobal("document", { visibilityState: "visible" });
    markSeen("s", 100);
    expect(isUnseen("s", 100)).toBe(false);
  });

  it("keeps the newest 200 and drops the oldest", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } } });
    for (let i = 0; i < SEEN_CAP + 5; i++) markSeen(`s${i}`, 10);
    expect(isUnseen("s0", 10)).toBe(true);
    expect(isUnseen("s4", 10)).toBe(true);
    expect(isUnseen("s5", 10)).toBe(false);
    expect(isUnseen(`s${SEEN_CAP + 4}`, 10)).toBe(false);
    expect(Object.keys(JSON.parse(store.get("agent-dag.sessionsSeen")!)).length).toBe(SEEN_CAP);
  });

  it("survives a store that throws, remembering for the page and not the next", () => {
    vi.stubGlobal("window", { get localStorage(): never { throw new Error("blocked"); } });
    expect(() => markSeen("s", 100)).not.toThrow();
    expect(isUnseen("s", 100)).toBe(false);
  });

  it("is marked by what is selected or open on the stage, through one hook and no route", () => {
    const hook = code("../use-mark-seen.ts");
    expect(hook).toContain("markSeen(root.sessionId, turnEndedAt(root))");
    expect(code("../App.tsx")).toMatch(/useMarkSeen\(stateRef, \[\.\.\.selectedIds, stage\.enabled/);
    expect(code("../session-seen.ts")).toContain('"agent-dag.sessionsSeen"');
    expect(code("../session-seen.ts")).not.toMatch(/fetch\(|\/api\//);
  });
});

// ── the fold, the hold and the motion, as rules ─────────────────────────────

describe("the fold past 8", () => {
  it("draws 8 rows of 14 sessions (2 + 4 + 4 + 4): all of Needs you and Working, 2 of Done, Idle folded", () => {
    expect(RAIL_FOLD_AT).toBe(8);
    expect(foldPlan([2, 4, 4, 4])).toEqual([
      { shown: 2, rest: 0 }, { shown: 4, rest: 0 }, { shown: 2, rest: 2 }, { shown: 0, rest: 4 },
    ]);
  });

  it("never cuts Needs you or Working, however many there are", () => {
    expect(foldPlan([3, 9, 5, 5])).toEqual([
      { shown: 3, rest: 0 }, { shown: 9, rest: 0 }, { shown: 0, rest: 5 }, { shown: 0, rest: 5 },
    ]);
    expect(foldPlan([0, 0, 3, 3])).toEqual([
      { shown: 0, rest: 0 }, { shown: 0, rest: 0 }, { shown: 3, rest: 0 }, { shown: 3, rest: 0 },
    ]);
  });

  it("renders 2 more and a folded Idle row at 14 sessions", () => {
    let s = initialState();
    for (const id of ["w1", "w2"]) { s = begin(s, id, 0); s = notify(s, id, "permission_prompt", "ok?", 500); }
    for (const id of ["r1", "r2", "r3", "r4"]) s = begin(s, id, 0);
    for (const id of ["d1", "d2", "d3", "d4"]) { s = begin(s, id, 0); s = stop(s, id, 1_000 + seq); }
    for (const id of ["i1", "i2", "i3", "i4"]) { s = begin(s, id, 0); s = stop(s, id, 1_000 + seq); markSeen(id, s.agents.get(id)!.endedAt); }
    const html = renderToStaticMarkup(createElement(SessionList, {
      state: s, now: T0 + 60_000, selectedIds: new Set<string>(), onSelect: () => {}, onClose: () => {},
    }));
    expect((html.match(/<li class="sl-row-item"/g) ?? []).length).toBe(8);
    expect(html).toContain("2 more");
    expect(html).toMatch(/<button type="button" class="sl-more" aria-expanded="false">2 more/);
    expect(html).toMatch(/<button type="button" class="sl-fold-btn" aria-expanded="false" data-motion="animate">[\s\S]*?<span class="sl-group-label">Idle<\/span><span class="sl-group-count">4<\/span>/);
    expect(RAIL_GROUP_LABELS).toEqual(["Needs you", "Working", "Done · unseen", "Idle"]);
  });
});

describe("Nobody’s waiting", () => {
  it("counts the rows at work, or says nothing more when none is", () => {
    expect(nobodyWaitingText(3)).toBe("Nobody’s waiting · 3 working");
    expect(nobodyWaitingText(0)).toBe("Nobody’s waiting");
  });

  it("takes the place of an empty Needs you, and only then", () => {
    const draw = (s: GraphState) => renderToStaticMarkup(createElement(SessionList, {
      state: s, now: T0 + 60_000, selectedIds: new Set<string>(), onSelect: () => {}, onClose: () => {},
    }));
    let calm = initialState();
    for (const id of ["a", "b", "c"]) calm = begin(calm, id, 0);
    expect(draw(calm)).toContain("Nobody’s waiting · 3 working");
    expect(draw(notify(calm, "a", "permission_prompt", "ok?", 500))).not.toContain("Nobody’s waiting");
  });
});

describe("the order held under the pointer", () => {
  const s = (...ids: string[]): Slot[] => ids.map(id => ({ id: id.slice(1), group: Number(id[0]) as Slot["group"] }));

  it("keeps every row where it is and counts the ones that would travel", () => {
    const held = s("0a", "0b", "1c");
    const swapped = holdOrder(held, s("0b", "0a", "1c"));
    expect(swapped.order).toEqual(held);
    expect(swapped.moves).toBe(1);
    expect(holdOrder(held, held).moves).toBe(0);
  });

  it("lets a session that joins take the end of its group, and moves nothing for it", () => {
    const joined = holdOrder(s("0a", "0b", "1c"), s("0a", "0x", "0b", "1c"));
    expect(joined.order.map(x => x.id)).toEqual(["a", "b", "x", "c"]);
    expect(joined.moves).toBe(0);
  });

  it("holds a row in its group when its state changes under the pointer, and counts it", () => {
    const changed = holdOrder(s("0a", "0b", "1c"), s("0c", "0a", "0b"));
    expect(changed.order).toEqual(s("0a", "0b", "1c"));
    expect(changed.moves).toBe(1);
  });

  it("drops a session that has gone", () => {
    expect(holdOrder(s("0a", "0b", "1c"), s("0a", "1c")).order.map(x => x.id)).toEqual(["a", "c"]);
  });

  it("says what waits in the card's words", () => {
    expect(heldLine(1)).toBe("1 move waits until you leave the list");
    expect(heldLine(2)).toBe("2 moves wait until you leave the list");
  });

  // Changed on purpose (review item 2): focus-inside used to be state set by
  // focusin/blur, which a removed or inert focused element left set for good.
  // It is computed when needed from document.activeElement (on every render
  // and on document focusin/focusout) and the rule is a pure function.
  it("asks the pointer and the keyboard focus, not a click's focus", () => {
    const list = code("../components/SessionList.tsx");
    expect(list).toContain("const aimed = railHeld({ pointerInside: pointerIn, focusInside, focusVisible: focusInside && focusIsVisible(active) });");
    expect(list).toContain('el.matches(":focus-visible")');
    expect(list).toContain('document.addEventListener("focusin", ask);');
    expect(list).toContain('document.addEventListener("focusout", ask);');
    expect(list).not.toMatch(/setFocusIn|onFocus=|onBlur=/);
    expect(list).toContain("holdOrder(heldRef.current ?? drawnRef.current, fresh)");
    expect(list).toContain("useRailFlip(list,");
  });

  it("holds for the pointer, or for focus that is inside AND shows a ring; a click's focus, or none, never holds", () => {
    expect(railHeld({ pointerInside: true, focusInside: false, focusVisible: false })).toBe(true);
    expect(railHeld({ pointerInside: false, focusInside: true, focusVisible: true })).toBe(true);
    expect(railHeld({ pointerInside: false, focusInside: true, focusVisible: false })).toBe(false);
    expect(railHeld({ pointerInside: false, focusInside: false, focusVisible: true })).toBe(false);
  });
});

describe("motion answers", () => {
  it("travels up to 12 rows, crossfades past it, fades the moved rows under reduced motion", () => {
    expect(releaseMotion({ moved: 0, reduced: false })).toBe("none");
    expect(releaseMotion({ moved: 12, reduced: false })).toBe("flip");
    expect(releaseMotion({ moved: 13, reduced: false })).toBe("crossfade");
    expect(releaseMotion({ moved: 5, reduced: true })).toBe("fade-moved");
    expect(releaseMotion({ moved: 40, reduced: true })).toBe("fade-moved");
  });

  it("opens a fold by animation, at once by key, content-fade over 20 rows or reduced", () => {
    expect(foldMotion({ rowsInside: 4, byKey: false, reduced: false })).toBe("animate");
    expect(foldMotion({ rowsInside: 4, byKey: true, reduced: false })).toBe("instant");
    expect(foldMotion({ rowsInside: 21, byKey: false, reduced: false })).toBe("fade");
    expect(foldMotion({ rowsInside: 20, byKey: false, reduced: false })).toBe("animate");
    expect(foldMotion({ rowsInside: 4, byKey: false, reduced: true })).toBe("fade");
  });

  it("joins and leaves together, at once past 20 rows, fading alone under reduced motion", () => {
    expect(joinMotion({ rows: 20, reduced: false })).toBe("animate");
    expect(joinMotion({ rows: 21, reduced: false })).toBe("instant");
    expect(joinMotion({ rows: 5, reduced: true })).toBe("fade");
  });

  it("reads its times and curves from the tokens, with no number of its own but the 100ms", () => {
    const motion = code("../rail-motion.ts");
    for (const token of ["--dur-move", "--ease-stage", "--dur-fast", "--ease", "--dur-base", "--dur-exit"]) expect(motion).toContain(`"${token}"`);
    expect(motion).toMatch(/LEAVE_SPACE_DELAY_MS = 100/);
    expect(motion).toContain("releaseMotion({");
    expect(motion).not.toMatch(/duration: \d/);
  });

  it("lands a jump through the one place jumps go through, not a path of its own per key", () => {
    expect(code("../use-agent-focus.ts")).toContain("onLand?.(sessionId);");
    const app = code("../App.tsx");
    expect(app).toMatch(/onLand: markLanded/);
    expect(app).toMatch(/if \(followSession\(sessionId\)\) \{\s*markLanded\(sessionId\);/);
    expect(app).toMatch(/landed=\{landed\}/);
    const list = code("../components/SessionList.tsx");
    expect(list).toContain('block: "nearest"');
    expect(list).toContain('behavior: "instant"');
  });
});

describe("what the rail may import", () => {
  it("is first-load code: nothing the lazy terminal stage owns, and not the navigator's FLIP", () => {
    const files = [
      "../components/SessionList.tsx", "../components/RailParts.tsx", "../rail-model.ts", "../rail-motion.ts",
      "../rail-row-copy.ts", "../session-seen.ts", "../use-mark-seen.ts",
    ];
    for (const f of files) {
      const specs = [...code(f).matchAll(/^\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/gm)].map(m => m[1]);
      const lazy = specs.filter(sp => /navigator-flip|BoardNavigator|board-navigator|terminal|xterm/.test(sp));
      expect(lazy, f).toEqual([]);
    }
  });
});

// ── the review round ────────────────────────────────────────────────────────

describe("review fixes: what the rows sort and say", () => {
  it("sorts Working by when the current turn began, newest first, then id, and a tool call moves nothing", () => {
    let s = initialState();
    s = begin(s, "old", 0);
    s = begin(s, "new", 10_000);
    s = begin(s, "tie-b", 20_000);
    s = begin(s, "tie-a", 20_000);
    const order = () => buildRows(s, T0 + 100_000).map(r => r.sessionId);
    expect(order()).toEqual(["tie-a", "tie-b", "new", "old"]);
    // Tool traffic on the oldest turn is not a reason to move it.
    s = send(s, "old", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "ls" } }, 50_000);
    expect(order()).toEqual(["tie-a", "tie-b", "new", "old"]);
    // A new prompt is a new turn.
    s = send(s, "old", { hook_event_name: "UserPromptSubmit", prompt: "again" }, 60_000);
    expect(order()[0]).toBe("old");
    expect(code("../components/SessionList.tsx")).not.toMatch(/rx === 1\) return y\.lastActivity/);
  });

  it("treats a session you are looking at as seen in the row model, before the marker is written", () => {
    const s = board();
    const now = T0 + 100_000;
    const group = (watching?: Set<string>) => rank(buildRows(s, now, watching).find(r => r.sessionId === "done-unseen")!);
    expect(group()).toBe(2);
    expect(group(new Set(["done-unseen"]))).toBe(3);
    const idle = buildRows(s, now, new Set(["idle-unseen"])).find(r => r.sessionId === "idle-unseen")!;
    expect(idle.unseen).toBe(false);
    expect(code("../App.tsx")).toContain("watching={watchingSessions}");
  });

  it("draws Done in Done · unseen even for a row still marked active under an idle block, and Error for a failure", () => {
    const row = buildRows(board(), T0 + 100_000).find(r => r.sessionId === "idle-unseen")!;
    expect(railGlyph({ ...row, state: "active" }, 2)).toBe("done");
    expect(railGlyph({ ...row, state: "err" }, 2)).toBe("error");
    expect(railGlyph({ ...row, state: "done" }, 2)).toBe("done");
  });

  it("reads the Working line as the command or the path, never as JSON", () => {
    expect(runningTool({ name: "Bash", input: { command: "npm test -- rate-limit" } })).toEqual({ name: "Bash", preview: "npm test -- rate-limit" });
    expect(runningTool({ name: "Read", input: { file_path: "/repo/src/a.ts" } })).toEqual({ name: "Read", preview: "/repo/src/a.ts" });
    const unknown = runningTool({ name: "mcp__thing", input: { depth: 3, options: { a: 1 } } });
    expect(unknown).toEqual({ name: "mcp__thing", preview: "" });
    expect(runningTool({ name: "Bash" }).preview).toBe("");
    for (const t of [{ name: "Bash", input: { command: "ls" } }, { name: "x", input: { q: [1] } }]) expect(runningTool(t).preview).not.toMatch(/[{}"]/);
    const row = buildRows(board(), T0 + 100_000).find(r => r.sessionId === "work")!;
    expect(railLine(row, 1)).toEqual({ kind: "tool", name: "Edit", rest: "src/a.ts" });
  });

  it("keeps in the button what the tooltip alone would lose: the plan, the tag, the tool count, the cost, the suggested reply", () => {
    const base = buildRows(board(), T0 + 100_000).find(r => r.sessionId === "work")!;
    const row: Row = {
      ...base, toolCount: 1, cost: 2.5,
      plan: { done: 1, total: 3, current: "write", next: false, allDone: false } as Row["plan"],
      status: { kind: "last", text: "tests pass", reply: "ship it" } as Row["status"],
    };
    const spoken = rowSpoken(row);
    expect(spoken).toContain("plan 1 of 3 done, now: write");
    expect(spoken).toContain("last");
    expect(spoken).toContain("1 tool");
    expect(spoken).toContain("$2.50 session spend");
    expect(spoken).toContain("suggested reply: ship it");
    const parts = code("../components/RailParts.tsx");
    expect(parts).toMatch(/<span className="vis-hidden">\{rowSpoken\(r\)\}<\/span>/);
    expect(parts).toContain("title={rowTooltip(r, removed)}");
    // The row, rendered: the words are in its button.
    const html = renderToStaticMarkup(createElement(SessionList, {
      state: board(), now: T0 + 100_000, selectedIds: new Set<string>(), onSelect: () => {}, onClose: () => {},
    }));
    expect(html).toMatch(/class="vis-hidden">[^<]*\d+ tools?/);
  });
});

describe("review fixes: the seen marker on a first run and across tabs", () => {
  const fakeStore = () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } } });
    return store;
  };
  const KEY = "agent-dag.sessionsSeen";

  it("takes a baseline once on a first run: turns already ended are seen, later ones are not", () => {
    fakeStore();
    resetSessionsSeen({ firstRun: true });
    // An empty board is a state that has not arrived: no baseline yet.
    expect(baselineSeen([])).toBe(false);
    expect(baselineSeen([["a", 100], ["b", null], ["c", 50]])).toBe(true);
    expect(isUnseen("a", 100)).toBe(false);
    expect(isUnseen("c", 50)).toBe(false);
    expect(isUnseen("a", 101)).toBe(true);
    expect(baselineSeen([["d", 10]])).toBe(false);
    expect(isUnseen("d", 10)).toBe(true);
  });

  it("takes no baseline once the key has been written", () => {
    const store = fakeStore();
    store.set(KEY, "{}");
    resetSessionsSeen();
    expect(baselineSeen([["a", 100]])).toBe(false);
    expect(isUnseen("a", 100)).toBe(true);
  });

  it("merges before every write, so one tab never drops another tab's marks, the later end winning", () => {
    const store = fakeStore();
    resetSessionsSeen();
    markSeen("s1", 10);
    store.set(KEY, JSON.stringify({ s1: 30, s2: 20 }));
    markSeen("s3", 5);
    expect(JSON.parse(store.get(KEY)!)).toEqual({ s1: 30, s2: 20, s3: 5 });
    expect(isUnseen("s2", 20)).toBe(false);
    expect(isUnseen("s1", 30)).toBe(false);
  });

  it("merges what another tab wrote when the storage event arrives", () => {
    const store = fakeStore();
    resetSessionsSeen({ firstRun: true });
    store.set(KEY, JSON.stringify({ x: 40 }));
    syncSeenFromStorage();
    expect(isUnseen("x", 40)).toBe(false);
    // The key exists now: this deck is no longer on a first run.
    expect(baselineSeen([["y", 9]])).toBe(false);
    expect(code("../session-seen.ts")).toContain('window.addEventListener("storage", onStorage)');
  });

  it("merges two maps by the later turn end and keeps the newest 200", () => {
    expect([...mergeSeen(new Map([["a", 5], ["b", 9]]), new Map([["a", 7], ["c", 1]]))].sort()).toEqual([["a", 7], ["b", 9], ["c", 1]]);
    const many = new Map(Array.from({ length: SEEN_CAP + 3 }, (_, i) => [`s${i}`, i] as [string, number]));
    const merged = mergeSeen(many, new Map());
    expect(merged.size).toBe(SEEN_CAP);
    expect(merged.has("s0")).toBe(false);
  });

  it("keeps every read and write in storage.ts's guarded helpers", () => {
    const seenSrc = code("../session-seen.ts");
    expect(seenSrc).not.toMatch(/localStorage|sessionStorage/);
    expect(seenSrc).toContain("readStored(SEEN_KEY)");
    expect(seenSrc).toContain("writeStored(SEEN_KEY");
  });
});

describe("review fixes: the move runs its whole time", () => {
  it("measures only when the drawn order or the hold changes", () => {
    const gate = measureGate();
    expect(gate.check("a|b", false)).toBe(true);
    for (let i = 0; i < 20; i++) expect(gate.check("a|b", false)).toBe(false);
    expect(gate.reads).toBe(1);
    expect(gate.check("b|a", false)).toBe(true);
    expect(gate.check("b|a", true)).toBe(true);
    expect(gate.check("b|a", true)).toBe(false);
    expect(gate.reads).toBe(3);
  });

  it("leaves running animations alone when the signature did not change", () => {
    const cancelled: string[] = [];
    const el = (name: string, ids: string[]) => ({ getAnimations: () => ids.map(id => ({ id, cancel: () => { cancelled.push(`${name}:${id}`); } })) });
    const rows = [el("a", ["rail-flip"]), el("b", ["rail-flip", "other"]), el("c", [])];
    expect(cancelFlights(rows, false)).toBe(0);
    expect(cancelled).toEqual([]);
    // A change retargets: only the rail's own moves are dropped.
    expect(cancelFlights(rows, true)).toBe(2);
    expect(cancelled).toEqual(["a:rail-flip", "b:rail-flip"]);
  });

  it("does not cancel in the render path of a gated hook", () => {
    const motion = code("../rail-motion.ts");
    expect(motion).toContain("if (!changed) { reviveFlights(flights.current, performance.now()); return; }");
    expect(motion).toContain("cancelFlights(rows, true);");
  });

  it("lands once: a landing is handled as soon as it is used, so a row drawn again never replays it", () => {
    const list = code("../components/SessionList.tsx");
    expect(list).toContain("handled.current = landing.nonce;");
    expect(list).not.toContain("scrolled");
    const parts = code("../components/RailParts.tsx");
    expect(parts).toContain("onAnimationEnd={() => setLit(null)}");
  });
});
