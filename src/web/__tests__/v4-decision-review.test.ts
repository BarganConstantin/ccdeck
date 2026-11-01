// The review's findings on Chat, the Decision card and the phone at 640, one
// test group each, written to fail on the commit they were found in. The
// machine's are pure; the card's keys and focus are held through the pure
// functions it calls and, where only the DOM can say, through its source (the
// repo has no DOM test environment).
import { describe, expect, it } from "vitest";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  CHECK_FAILED_ANNOUNCE, initialState, LOCKED_ANNOUNCE, step,
  type DecisionContext, type DecisionEffect, type DecisionEvent, type DecisionState,
} from "../components/decision/decision-machine";
import { cardKeyEvent, decisionEventFor, keyTargetOf } from "../components/decision/decision-keys";
import DecisionCard from "../components/decision/DecisionCard";
import DecisionFooter, { footNote } from "../components/decision/DecisionFooter";
import DecisionOption from "../components/decision/DecisionOption";
import { PHONE_BAR_H, PHONE_HEAD_H } from "../stage-geometry";
import { withoutComments } from "./tsx-scan";
import { MULTI, PERMISSION, PLAN } from "./screens-fixtures";

const web = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string) => readFileSync(join(web, rel), "utf8");
const bare = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "");
const ctx = (model = PERMISSION, canRecheck = true): DecisionContext => ({ model, canRecheck });

function play(start: DecisionState, events: DecisionEvent[], c: DecisionContext) {
  let state = start;
  const effects: DecisionEffect[] = [];
  for (const e of events) {
    const out = step(state, e, c);
    state = out.state;
    effects.push(...out.effects);
  }
  return { state, effects };
}
const types = (effects: DecisionEffect[]) => effects.map(e => e.type);

describe("1 a locked row is never a send target, in any mode", () => {
  it("focusing another row leaves the free field, keeps the text, and Enter then sends nothing", () => {
    const c = ctx();
    const out = play(initialState(PERMISSION), [
      { type: "pick", index: 2 }, { type: "typeFree", text: "Run only the unit tests" },
      { type: "focus", index: 1 }, { type: "submit" },
    ], c);
    expect(out.state.mode).toBe("choose");
    expect(out.state.text).toBe("Run only the unit tests");
    expect(types(out.effects)).not.toContain("recheck");
    // The text comes back when the free row is picked again.
    const back = play(out.state, [{ type: "pick", index: 2 }], c).state;
    expect(back).toMatchObject({ mode: "free", text: "Run only the unit tests" });
  });

  it("a state that has the free field open on a locked row sends nothing either", () => {
    const start = { ...initialState(PERMISSION), mode: "free" as const, focus: 1, text: "x" };
    expect(play(start, [{ type: "submit" }], ctx()).effects).toEqual([]);
    const onFirst = { ...start, focus: 0 };
    expect(play(onFirst, [{ type: "submit" }], ctx()).effects).toEqual([]);
  });

  it("focusing the free row itself keeps the field", () => {
    const out = play(initialState(PERMISSION), [{ type: "pick", index: 2 }, { type: "focus", index: 2 }], ctx());
    expect(out.state.mode).toBe("free");
  });
});

describe("2 Esc cancels a pick that is being checked", () => {
  it("a late ok after Esc sends nothing, and neither does one after the card closed", () => {
    const out = play(initialState(PERMISSION), [{ type: "pick", index: 0 }, { type: "escape" }, { type: "result", result: "ok" }], ctx());
    expect(types(out.effects)).toEqual(["recheck", "close"]);
    expect(out.state.closed).toBe(true);
    expect(out.state.outcome.kind).toBe("none");
  });

  it("Esc in the free field while a pick is checked cancels it and goes back to the choices", () => {
    const start = { ...initialState(PERMISSION), mode: "free" as const, focus: 2, text: "x" };
    const out = play(start, [{ type: "submit" }, { type: "escape" }, { type: "result", result: "ok" }], ctx());
    expect(types(out.effects)).toEqual(["recheck"]);
    expect(out.state).toMatchObject({ mode: "choose", closed: false });
  });
});

describe("3 several answers: a locked row cannot be checked", () => {
  const locked: typeof MULTI = { ...MULTI, options: [MULTI.options[0], { ...MULTI.options[1], locked: true, lockNote: "Only here" }, MULTI.options[2]] };
  it("toggling it checks nothing and says it is locked", () => {
    const out = play(initialState(locked), [{ type: "toggle", index: 1 }, { type: "pick", index: 1 }], ctx(locked));
    expect(out.state.checked).toEqual([]);
    expect(out.effects).toEqual([{ type: "announce", text: LOCKED_ANNOUNCE }, { type: "announce", text: LOCKED_ANNOUNCE }]);
  });

  it("a checked set that holds a locked row is not sent", () => {
    const start = { ...initialState(locked), checked: [0, 1] };
    expect(play(start, [{ type: "submit" }], ctx(locked)).effects).toEqual([]);
  });
});

describe("4 a failed re-read leaves only its own checking", () => {
  it("goes back to the choices and says it failed", () => {
    const out = play(initialState(PERMISSION), [{ type: "pick", index: 0 }, { type: "checkFailed" }], ctx());
    expect(out.state.outcome.kind).toBe("none");
    expect(out.effects.at(-1)).toEqual({ type: "announce", text: CHECK_FAILED_ANNOUNCE });
  });

  it("leaves ended, elsewhere and held on screen", () => {
    for (const input of [{ kind: "ended" }, { kind: "elsewhere", at: "14:03" }, { kind: "held" }] as const) {
      const out = play(initialState(PERMISSION), [{ type: "outcome", input }, { type: "checkFailed" }], ctx());
      expect(out.state.outcome.kind).toBe(input.kind);
    }
  });

  it("the card sends the failure as its own event, not as a dismissal", () => {
    const card = bare("components/decision/DecisionCard.tsx");
    expect(card).toContain('type: "checkFailed"');
    expect(card).not.toMatch(/\(\) => \{ if \(alive\.current\) dispatch\(\{ type: "dismissOutcome" \}\)/);
  });
});

describe("5 a re-read answer belongs to the pick that asked", () => {
  it("a stale token is ignored, the current one sends", () => {
    const c = ctx(PLAN);
    const asked = play(initialState(PLAN), [{ type: "pick", index: 1 }], c);
    const first = asked.state.token;
    const again = play(asked.state, [{ type: "outcome", input: { kind: "held" } }, { type: "pick", index: 2 }], c);
    expect(again.state.token).not.toBe(first);
    const stale = play(again.state, [{ type: "result", result: "ok", token: first }], c);
    expect(stale.effects).toEqual([]);
    expect(stale.state.outcome).toMatchObject({ kind: "checking", answer: { kind: "option", index: 2 } });
    const fresh = play(again.state, [{ type: "result", result: "ok", token: again.state.token }], c);
    expect(fresh.effects[0]).toEqual({ type: "send", answer: { kind: "option", index: 2 } });
    expect(play(again.state, [{ type: "checkFailed", token: first }], c).state.outcome.kind).toBe("checking");
  });

  it("the card hands the pick's token to both answers", () => {
    const card = bare("components/decision/DecisionCard.tsx");
    expect(card).toMatch(/type: "result", result, token/);
    expect(card).toMatch(/type: "checkFailed", token/);
  });
});

describe("9 a new question starts the card over", () => {
  it("reset drops the mode, outcome and checked set, and answers to the old pick are stale", () => {
    const c = ctx(MULTI);
    const used = play(initialState(MULTI), [{ type: "toggle", index: 0 }, { type: "submit" }], c).state;
    const reset = play(used, [{ type: "reset" }, { type: "result", result: "ok", token: used.token }], ctx(PERMISSION));
    expect(reset.state).toMatchObject({ mode: "choose", checked: [], focus: null, closed: false });
    expect(reset.state.outcome.kind).toBe("none");
    expect(reset.effects).toEqual([]);
  });

  it("the model has an id, ChatView keys the card by it, and the card resets when it changes", () => {
    expect(bare("components/decision/decision-model.ts")).toMatch(/\bid\?: string;/);
    expect(bare("components/chat/ChatView.tsx")).toContain("<DecisionCard key={decision.model.id}");
    const card = bare("components/decision/DecisionCard.tsx");
    expect(card).toMatch(/\[model\.id, dispatch\]/);
    expect(card).toContain('dispatch({ type: "reset" })');
  });
});

describe("6 Space checks the focused box whatever the single-key switch says", () => {
  it("toggles the focused row in the several-answers card, with the switch on or off", () => {
    for (const singleKeys of [true, false]) {
      expect(decisionEventFor({ key: " " }, singleKeys, 3, { multi: true, focus: 1 })).toEqual({ type: "toggle", index: 1 });
    }
    expect(decisionEventFor({ key: "Enter" }, false, 3, { multi: true, focus: 1 })).toEqual({ type: "submit" });
  });

  it("is nothing in the single-answer card, with the ring nowhere, or with a chord", () => {
    expect(decisionEventFor({ key: " " }, true, 3, { multi: false, focus: 1 })).toBeNull();
    expect(decisionEventFor({ key: " " }, true, 3, { multi: true, focus: null })).toBeNull();
    expect(decisionEventFor({ key: " ", ctrlKey: true }, true, 3, { multi: true, focus: 1 })).toBeNull();
  });
});

describe("7 the card's keys are for its rows and its field", () => {
  const el = (hit: string) => ({ closest: (sel: string) => (sel === hit ? {} : null) });
  it("names where a key was pressed", () => {
    expect(keyTargetOf(el(".dc-opt"))).toBe("row");
    expect(keyTargetOf(el(".dc-input"))).toBe("field");
    expect(keyTargetOf(el(".nothing"))).toBe("other");
    expect(keyTargetOf(null)).toBe("other");
  });

  it("leaves Enter and Tab on a link or button to the browser", () => {
    for (const key of ["Enter", "Tab", "ArrowDown", "Escape", "1"]) expect(cardKeyEvent({ key }, "other", true, 3), key).toBeNull();
    expect(cardKeyEvent({ key: "Tab", shiftKey: true }, "other", true, 3)).toBeNull();
  });

  it("keeps the field's own keys, but Enter and Esc", () => {
    expect(cardKeyEvent({ key: "ArrowDown" }, "field", true, 3)).toBeNull();
    expect(cardKeyEvent({ key: "1" }, "field", true, 3)).toBeNull();
    expect(cardKeyEvent({ key: "Enter" }, "field", true, 3)).toEqual({ type: "submit" });
    expect(cardKeyEvent({ key: "Escape" }, "field", true, 3)).toEqual({ type: "escape" });
    expect(cardKeyEvent({ key: "Tab" }, "row", true, 3)).toEqual({ type: "move", by: 1 });
  });

  it("the card asks for the target before it takes a key", () => {
    const card = bare("components/decision/DecisionCard.tsx");
    expect(card).toContain("keyTargetOf(e.target as Element | null)");
    expect(card).toContain("cardKeyEvent(");
  });
});

describe("8 and 13b focus", () => {
  const card = withoutComments(read("components/decision/DecisionCard.tsx"));
  it("Esc in the field gives focus back to the free row", () => {
    expect(card).toMatch(/backToRow\.current = true; dispatch\(\{ type: "escape" \}\)/);
    expect(card).toMatch(/was === "free" && state\.mode !== "free" && backToRow\.current/);
    expect(card).toMatch(/rows\.current\[state\.focus\]\?\.focus\(\)/);
  });

  it("the field takes focus only when the reader moves into free mode, never on arrival", () => {
    expect(card).toContain("const prevMode = useRef(state.mode);");
    expect(card).toMatch(/state\.mode === "free" && was !== "free"\) input\.current\?\.focus\(\)/);
    // A card that arrives in free mode draws the field and no autofocus.
    const out = renderToStaticMarkup(createElement(DecisionCard, { model: PERMISSION, initial: { mode: "free", focus: 2 } }));
    expect(out).toContain('class="dc-input"');
    expect(out).not.toMatch(/autofocus/i);
  });
});

describe("12c the footer and the rows follow the single-key switch", () => {
  const foot = (singleKeys: boolean) => renderToStaticMarkup(createElement(DecisionFooter, { mode: "choose", focused: false, checked: 0, rows: 3, singleKeys }));
  const row = (singleKeys: boolean) => renderToStaticMarkup(createElement(DecisionOption, {
    index: 0, option: PERMISSION.options[0], selection: "radio", focused: false, checked: false, typing: false, text: "",
    readOnly: false, singleKeys, tabStop: true, onPick() {}, onFocus() {}, onText() {}, onFieldKey() {},
  }));
  it("says 'Pick 1 – 3' and names the digit only with the switch on", () => {
    expect(foot(true)).toContain("Pick");
    expect(foot(false)).not.toContain("Pick");
    expect(row(true)).toContain('aria-keyshortcuts="1"');
    expect(row(false)).not.toContain("aria-keyshortcuts");
  });

  it("the card passes the switch to both", () => {
    const card = bare("components/decision/DecisionCard.tsx");
    expect(card.match(/singleKeys=\{singleKeys\}/g)).toHaveLength(2);
  });
});

describe("12d nothing checked, nothing to send", () => {
  it("draws no 'Send 0 answers' note, and still counts one and two", () => {
    expect(footNote("multi", false, 0).text).toBe("");
    expect(footNote("multi", false, 1).text).toBe("Send 1 answer  ↵");
    expect(footNote("multi", false, 2).text).toBe("Send 2 answers  ↵");
    const out = renderToStaticMarkup(createElement(DecisionCard, { model: MULTI }));
    expect(out).not.toContain("Send 0");
  });
});

describe("12e the lock note's id is unique per card", () => {
  it("two cards on one page describe their rows with two different ids", () => {
    const two = renderToStaticMarkup(createElement(Fragment, null, createElement(DecisionCard, { model: PERMISSION }), createElement(DecisionCard, { model: PERMISSION })));
    const ids = [...two.matchAll(/ id="([^"]*-lock-1)"/g)].map(m => m[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(two).toContain(`aria-describedby="${id}"`);
  });
});

describe("10 the phone drawer narrows when it closes", () => {
  const sheet = bare("styles/left-column.css");
  const phone = sheet.slice(sheet.indexOf("@media (max-width: 640px)"));
  it("is full width only while it is not closing, so the width variable animates the close", () => {
    expect(phone).toMatch(/\.left-column:not\(\.closing\)\s*\{\s*width:\s*100vw;/);
    expect(phone).not.toMatch(/\.left-column\s*\{\s*width:\s*100vw;/);
    expect(sheet.slice(0, sheet.indexOf("@media (max-width: 640px)"))).toContain("width: var(--left-col-w);");
  });
});

describe("11 forced colours", () => {
  const css = bare("components/decision/decision.css");
  const forced = css.slice(css.indexOf("@media (forced-colors: active)"));
  it("gives the focused row a real outline and the checked and locked states a system-colour cue", () => {
    expect(css).toContain("@media (forced-colors: active)");
    expect(forced).toMatch(/\.dc-opt\[data-focus\][^{]*\{[^}]*outline:\s*2px solid Highlight;/);
    expect(forced).toMatch(/\.dc-opt\[data-checked\][^{]*\{[^}]*border-color:\s*Highlight;/);
    expect(forced).toMatch(/\.dc-opt\[data-locked\]\s*\{[^}]*GrayText;/);
  });
});

describe("12a targets of 44 on the phone", () => {
  it("the takeover's back button is drawn at 32 and hit at 44 by 44", () => {
    const sheet = bare("styles/stage-shell.css");
    const phone = sheet.slice(sheet.indexOf("@media (max-width: 640px)"));
    expect(phone).toMatch(/\.ts-head > \.glyph-btn\s*\{\s*width:\s*32px;\s*height:\s*44px;/);
    expect(phone).toMatch(/\.ts-head > \.glyph-btn::after\s*\{\s*inset:\s*0 -6px;/);
  });

  it("the card's links and field are 44 high at 640 and under", () => {
    const css = bare("components/decision/decision.css");
    const phone = css.slice(css.indexOf("@media (max-width: 640px)"));
    expect(phone).toMatch(/\.dc-link\s*\{\s*min-height:\s*44px;/);
    expect(phone).toMatch(/\.dc-input\s*\{\s*height:\s*44px;/);
  });
});

describe("12f and 12g Chat's sheet", () => {
  const css = bare("components/chat/chat.css");
  it("writes its radii as tokens", () => {
    expect(css).not.toMatch(/border-radius:\s*12px 12px 4px 12px/);
    expect(css).toContain("border-radius: var(--r-overlay) var(--r-overlay) var(--r-tag) var(--r-overlay);");
  });

  it("lets the divider's words shrink and end in an ellipsis", () => {
    const at = css.indexOf(".chat-since-text {");
    const rule = css.slice(at, css.indexOf("}", at));
    expect(rule).not.toContain("flex: none");
    expect(rule).toContain("min-width: 0;");
    expect(rule).toContain("text-overflow: ellipsis;");
    expect(rule).toContain("overflow: hidden;");
  });
});

describe("12h the stage guesses the phone takeover's chrome before it measures", () => {
  it("is 56 and 52, and use-stage reads them at 640 and under", () => {
    expect([PHONE_HEAD_H, PHONE_BAR_H]).toEqual([56, 52]);
    const stage = bare("use-stage.ts");
    expect(stage).toContain('matchMedia("(max-width: 640px)")');
    expect(stage).toContain("if (phoneWidth()) return PHONE_HEAD_H;");
    expect(stage).toContain("phoneWidth() ? PHONE_BAR_H");
  });
});

describe("13d the flags file says where it is read", () => {
  it("does not claim the first-load chunk", () => {
    const text = read("use-screen-flags.ts");
    expect(text).not.toContain("IN THE FIRST-LOAD CHUNK");
    expect(text).toContain("lazy StageShell chunk");
  });
});
