// #822: the same session's elapsed clock read 118m in one tab and 12m in another.
//
// A card's clock starts at `startedAt`, which the reducer sets from the first
// event THIS page applied for the session. A tab open since the session began
// saw its SessionStart; a tab opened later is built from the server's replay
// ring, which is bounded (#775), so for a long session it starts partway in and
// the clock counts from there. The deck already knows when that has happened —
// a root it did not see start is `synthetic`, which is the "?" on the card — it
// just printed the clock as if it knew.
//
// The fix is the one the deck can make honestly with what it holds: when the
// start was not seen, the clock is a floor, and it says so — "≥ 12m" — with the
// reason in its title, on the card and in the detail panel. And the card's
// per-minute burn in the tooltip, which divided the whole session's cost by
// that short clock, is left out for such a card rather than overstated.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const code = (src: string) => src
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");

const card = read("../components/AgentNode.tsx");
const app = read("../App.tsx");

describe("a clock whose start the deck did not see reads as a floor (#822)", () => {
  it("prefixes the card's clock with ≥ for a session joined late", () => {
    // The clock is its own leaf on a one-second beat since #873; the floor mark
    // stays in front of it.
    expect(code(card)).toMatch(/\{data\.synthetic \? "≥ " : ""\}<Elapsed start=\{data\.startedAt\} end=\{data\.endedAt\} \/>/);
  });

  it("says why in the clock's title", () => {
    expect(card).toMatch(/joined this session after it began/);
  });

  it("does the same in the detail panel", () => {
    expect(code(app)).toMatch(/const elapsedLabel = `\$\{agent\.synthetic \? "≥ " : ""\}\$\{elapsed\(agent\.startedAt, agent\.endedAt, now\)\}`;/);
  });

  it("leaves the per-minute burn out of the card's tooltip when the start is unknown", () => {
    expect(code(card)).toMatch(/const rate = data\.state === "active" && !data\.synthetic \? fmtCostRate\(/);
  });
});
