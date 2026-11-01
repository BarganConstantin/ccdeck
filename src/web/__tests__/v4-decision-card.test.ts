// The Decision card's markup, one frame at a time: the twelve states with
// their verbatim texts (the strings are asserted here, from a table, and not
// copied into the component's tests), the tree's one tick per option, the
// ARIA roles, the live region, and the sheet's geometry and motion.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import DecisionCard, { type DecisionCardProps } from "../components/decision/DecisionCard";
import type { DecisionState } from "../components/decision/decision-machine";
import { sheetText } from "./sheet-source";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MULTI, OUTSIDE, PERMISSION, PLAN, words } from "./screens-fixtures";

const draw = (props: DecisionCardProps) => renderToStaticMarkup(createElement(DecisionCard, props));
const css = readFileSync(fileURLToPath(new URL("../components/decision/decision.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const checking: Partial<DecisionState> = { focus: 0, outcome: { kind: "checking", answer: { kind: "option", index: 0 } } };

const BODY = [
  "Allow this command?", "npm test -- rate-limit", "Run the rate limiter's tests · Bash in ~/work/web-api",
  "Yes, run it", "Runs once. The next command asks again.",
  "Yes, and don't ask again for npm test here", "Changes the session's rules, so only in the terminal",
  "No, tell Claude what to do instead", "The command doesn't run",
];

/** [frame, props, texts the frame holds, texts it must not]. */
const FRAMES: Array<[string, DecisionCardProps, string[], string[]]> = [
  ["1 Default", { model: PERMISSION }, [...BODY, "Pick", "Sent only when you pick, after re-reading the prompt", "See it in Term"], ["data-focus", "Checking"]],
  ["2 Keyboard focus", { model: PERMISSION, initial: { focus: 0 } }, [...BODY, "↵ sends the highlighted answer, after re-reading the prompt"], ["Sent only when you pick"]],
  ["3 Checking the prompt", { model: PERMISSION, initial: checking }, ["Checking the prompt is still on screen", "Nothing is sent if it changed."], []],
  ["4 Sent", { model: PERMISSION, initial: { focus: 0, outcome: { kind: "sent", answer: { kind: "option", index: 0 } } } }, ["Sent to web-api", 'Running <code class="dc-mono">npm test -- rate-limit</code>.'], ["Checking the prompt"]],
  ["5 The question changed", { model: PERMISSION, outcome: { kind: "changed", now: "npm run lint" } }, ["The question changed, so nothing was sent", "Claude now asks about npm run lint", "Show it"], []],
  ["6 The session ended", { model: PERMISSION, outcome: { kind: "ended" } }, ["web-api ended before the answer went out", "Nothing was sent.", "Open the transcript"], []],
  ["7 Tell Claude what to do", { model: PERMISSION, initial: { mode: "free", focus: 2, text: "Run only the unit tests" } }, ["No, tell Claude what to do instead", "↵ sends what you wrote · Esc goes back to the choices", "Send ↵"], ["Sent only when you pick"]],
  ["8 Several answers", { model: MULTI, initial: { checked: [0, 1] } }, [
    "Which docs move to the new theme first?", "Pick any. Claude moves those first and asks before the rest.",
    "Getting started", "Six pages new readers see first", "API reference", "Fourteen pages built from the schema", "Blog", "Forty posts that read fine as they are",
    "Send 2 answers ↵",
  ], ["Sent only when you pick"]],
  ["9 Read only", { model: OUTSIDE }, [
    "./gradlew publishRelease", "Publish the release build · Bash in ~/work/mobile-app", "Yes, and don't ask again for ./gradlew here",
    "Started outside ccdeck, so it is answered in its own terminal",
  ], ["Pick", "See it in Term"]],
  ["10 Plan to approve", { model: PLAN }, [
    "Approve this plan?", "A token bucket on the public routes", "Limits read from config/rate.json", "Tests for burst and refill",
    "3 steps · plan mode in ~/work/web-api", "Yes, and auto-accept edits", "Changes the session’s mode, so only in the terminal",
    "Yes, and I approve each edit", "Claude starts; every edit still asks you", "No, keep planning", "Tell Claude what to change",
  ], []],
  ["11 Held", { model: PERMISSION, initial: { focus: 0 }, outcome: { kind: "held" } }, ["Held: you have unsent text in the terminal", "Send it or clear it there, then pick again.", "Open Term"], []],
  ["12 Answered in the terminal", { model: PERMISSION, outcome: { kind: "elsewhere", at: "14:03" } }, ["Answered in the terminal at 14:03", "Nothing to send from here."], ["Open Term"]],
];

describe("the twelve frames, word for word", () => {
  for (const [name, props, has, hasNot] of FRAMES) {
    it(name, () => {
      const markup = draw(props);
      const spoken = words(markup);
      for (const text of has) expect(markup.includes(text) || spoken.includes(text), `${name}: "${text}"`).toBe(true);
      for (const text of hasNot) expect(spoken.includes(text) || markup.includes(text), `${name} must not hold "${text}"`).toBe(false);
    });
  }

  it("keeps the two spaces of 'Send 2 answers  ↵' and the record's spacing in the markup", () => {
    expect(draw({ model: MULTI, initial: { checked: [0, 1] } })).toContain("Send 2 answers  ↵");
  });
});

describe("the structure", () => {
  const markup = draw({ model: PERMISSION });

  it("draws one tree tick per option, a stub and a spine, hidden from assistive technology", () => {
    expect((markup.match(/class="dc-tick"/g) ?? [])).toHaveLength(3);
    expect(markup).toContain('class="dc-tree" aria-hidden="true"');
    expect(draw({ model: PLAN }).match(/class="dc-tick"/g)).toHaveLength(3);
    expect(markup).toContain('class="dc-stub"');
    expect(markup).toContain('class="dc-spine"');
  });

  it("is a group named by its title, the options a radio group of radios", () => {
    expect(markup).toMatch(/role="group" aria-labelledby="(dc-\d+)-title"/);
    expect(markup).toMatch(/role="radiogroup" aria-labelledby="dc-\d+-title"/);
    expect(markup.match(/role="radio"/g)).toHaveLength(3);
    expect(draw({ model: MULTI })).toContain('role="group" aria-labelledby');
    expect(draw({ model: MULTI }).match(/role="checkbox"/g)).toHaveLength(3);
  });

  it("marks the locked row aria-disabled, described by its lock note, and dashed in the sheet", () => {
    const locked = /<div[^>]*aria-disabled="true"[^>]*aria-describedby="([^"]*-lock-1)"[^>]*>/.exec(markup);
    expect(locked).not.toBeNull();
    expect(markup).toContain(`id="${locked![1]}"`);
    expect(css).toMatch(/\.dc-opt\[data-locked\]\s*\{[^}]*border-style:\s*dashed;/);
  });

  it("holds a live region for the outcome whether or not there is one", () => {
    expect(markup).toContain('class="dc-out-empty" role="status"');
    expect(draw({ model: PERMISSION, outcome: { kind: "ended" } })).toContain('class="dc-out" role="status"');
  });

  it("does not take focus on arrival: no autofocus, no ring in the first frame", () => {
    expect(markup).not.toContain("autofocus");
    expect(markup).not.toContain("data-focus");
  });

  it("draws the ring on the focused row only", () => {
    expect(draw({ model: PERMISSION, initial: { focus: 0 } }).match(/data-focus/g)).toHaveLength(1);
  });

  it("opens the third row in place with a field, and Claude's pick tag when the model carries one", () => {
    const typing = draw({ model: PERMISSION, initial: { mode: "free", focus: 2, text: "Run only the unit tests" } });
    expect(typing).toContain('class="dc-input"');
    expect(typing).toContain('value="Run only the unit tests"');
    const picked = draw({ model: { ...PERMISSION, options: [{ ...PERMISSION.options[0], pick: true }, ...PERMISSION.options.slice(1)] } });
    expect(picked).toContain("Claude’s pick");
    expect(markup).not.toContain("dc-pick");
  });

  it("states the card's border colour by outcome: waiting in --warn, neutral once settled", () => {
    expect(css).toMatch(/\.dc-dq\s*\{[^}]*border:\s*1px solid var\(--warn\);/);
    expect(css).toMatch(/\.dc-dq\[data-outcome="sent"\],\s*\.dc-dq\[data-outcome="ended"\],\s*\.dc-dq\[data-outcome="elsewhere"\]\s*\{\s*border-color:\s*var\(--line\);/);
  });

  it("answers nothing in the read-only card: rows are not tab stops", () => {
    const out = draw({ model: OUTSIDE });
    expect(out).not.toContain("tabindex");
    expect(out).toContain('data-mode="readOnly"');
  });

  it("closes into nothing when its state says closed", () => {
    expect(draw({ model: PERMISSION, initial: { closed: true } })).toBe("");
  });
});

describe("the sheet", () => {
  const rule = (sel: string) => {
    const at = css.indexOf(`\n${sel} {`);
    expect(at, `${sel} has a rule`).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf("}", at));
  };

  it("is 300 + 24 + 460 wide on the dock's tokens", () => {
    expect(rule(".dc-decision")).toContain("grid-template-columns: 300px 24px minmax(0, 460px);");
    const dock = rule(".dc-dock");
    // 12/16 as drawn, with the 1px top border counted in the top: one decision is 192.
    expect(dock).toContain("padding: 11px 16px 12px;");
    expect(rule(".dc-decision")).toContain("row-gap: 4px;");
    expect(dock).toContain("background: var(--dock);");
    expect(dock).toContain("border-top: 1px solid var(--line-soft);");
  });

  it("makes the card --panel at --r-node with --shadow-overlay, and the options --row-option at --r-panel", () => {
    const dq = rule(".dc-dq");
    expect(dq).toContain("background: var(--panel);");
    expect(dq).toContain("border-radius: var(--r-node);");
    expect(dq).toContain("box-shadow: var(--shadow-overlay);");
    const opt = rule(".dc-opt");
    expect(opt).toContain("min-height: var(--row-option);");
    expect(opt).toContain("border-radius: var(--r-panel);");
    expect(opt).toContain("padding: 3px 11px 3px 7px;");
  });

  it("arrives on opacity and 8px at Base; the loader waits --delay-loader; reduced motion fades only", () => {
    expect(css).toMatch(/@keyframes dc-arrive \{ from \{ opacity: 0; transform: translateY\(8px\); \} \}/);
    expect(rule(".dc-dock")).toContain("animation: dc-arrive var(--dur-base) var(--ease);");
    expect(css).toMatch(/\.dc-out\[data-kind="checking"\]\s*\{\s*animation-delay:\s*var\(--delay-loader\);/);
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toContain("animation-name: dc-swap;");
    expect(reduced).not.toMatch(/translate/);
  });

  it("has no filled button: the card's only controls are rows and text links", () => {
    expect(css).not.toMatch(/\.btn|button\.primary/);
    expect(rule(".dc-link")).toContain("background: none;");
  });

  it("is imported by the card and by no sheet of the first load", () => {
    expect(sheetText()).not.toContain(".dc-");
  });
});
