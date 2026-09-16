// #827: switching accounts decides which account every new session bills to,
// and it was the click in the panel with the least reassurance. A switch that
// took moved the `active` chip and nothing else, with no live region, so a
// screen reader heard nothing. A refusal rendered under the whole auto-switch
// block, far from the row that was pressed. And nothing said what happens to
// sessions already running. Both answers are on the row now, the switch that
// took is announced, and the running-session line is claude-swap's own answer.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { nextFailure, type Failure } from "../accounts-reload";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const panel = read("../components/AccountsPanel.tsx");
const css = read("../styles.css").replace(/\/\*[\s\S]*?\*\//g, "");

const doSwitch = /const doSwitch = async \(num: number, name: string\) => \{[\s\S]*?\n  \};/.exec(panel)?.[0] ?? "";

describe("a switch answers on the row it was about (#827)", () => {
  it("tags a refusal with the row that was pressed, both ways it can fail", () => {
    expect(doSwitch).toMatch(/setFailure\(\{ text: explainCommandFailure\(body, "the switch failed"\), raw: commandOutput\(body\), row: num \}\)/);
    expect(doSwitch).toMatch(/setFailure\(\{ text: "server unreachable", row: num \}\)/);
  });

  it("draws the refusal on that row, and only other messages under the roster", () => {
    expect(panel).toMatch(/\{failure\?\.row === a\.num && \(\s*<div className="ap-failure ap-row-failure" role="alert">/);
    // It stood below the scroll while Auto-switch did. Both moved into the
    // column together, because the refusal is said beside the control that
    // made it — and every branch around it already needs a roster, so the
    // `view` and `data` guards it carried are its container's now.
    expect(panel).toMatch(/\{failure && failure\.row == null && \(\s*<div className="ap-failure" role="alert">/);
    expect(panel.indexOf('{failure && failure.row == null && (')).toBeGreaterThan(panel.indexOf('<ul className="ap-list">'));
    expect(panel.indexOf('{failure && failure.row == null && (')).toBeLessThan(panel.indexOf('className="ap-policy-block"'));
  });

  it("keeps a refused switch on its row through the reload that follows it", () => {
    const refused: Failure = { text: "claude-swap refused the switch", row: 3 };
    expect(nextFailure(refused, null)).toBe(refused);
  });

  it("names the account a switch took to, and clears it when the next one starts", () => {
    expect(doSwitch).toMatch(/else setSwitched\(\{ num, name \}\);/);
    expect(doSwitch).toMatch(/setFailure\(null\);\s*setSwitched\(null\);/);
    expect(panel).toMatch(/const name = a\.alias \?\? a\.email \?\? `account \$\{a\.num\}`;/);
    expect(panel).toMatch(/onClick=\{\(\) => doSwitch\(a\.num, name\)\}/);
  });
});

describe("what a switch that took says (#827)", () => {
  it("says it on the row it took to, while that row is still the active one", () => {
    expect(panel).toMatch(/\{a\.active && switched\?\.num === a\.num && \(\s*<p className="ap-switched">/);
  });

  it("says what happens to sessions already running, as claude-swap does", () => {
    const said = /<p className="ap-switched">([\s\S]*?)<\/p>/.exec(panel)?.[1].replace(/\s+/g, " ").trim() ?? "";
    expect(said).toBe("Now active. New sessions start on it; ones already running pick it up on their next message, up to about 30 seconds later on macOS.");
  });

  it("announces it through a region that is there before it is needed", () => {
    expect(panel).toMatch(/<div className="vis-hidden" role="status" aria-atomic="true">\s*\{switched \? `Now active: \$\{switched\.name\}` : ""\}\s*<\/div>/);
  });

  it("draws both on the row's own inset, in the row's quiet type", () => {
    expect(css).toMatch(/\.ap-row-failure \{ margin: 6px 0 0; \}/);
    const note = /\.ap-switched \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(note).toMatch(/font-size: 10px/);
    expect(note).toMatch(/color: var\(--text-dim\)/);
  });
});
