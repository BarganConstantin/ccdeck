// #881: `.agent-node { will-change: transform }` promoted every agent card to
// its own compositor layer for as long as it was on the board — twenty-one
// extra layers on the live one — for an animation that runs once: the 600ms
// `nodeExit` when a finished subagent is retired. React Flow moves the node
// wrapper, not the card, so nothing else ever transforms `.agent-node`. The
// hint lives on the exiting rule now, for the length of the exit.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

const body = (selector: string) =>
  new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";

describe("a card is its own layer only while it leaves (#881)", () => {
  it("does not promote a resting card", () => {
    expect(body(".agent-node"), "no .agent-node rule").not.toBe("");
    expect(body(".agent-node")).not.toMatch(/will-change/);
  });

  it("promotes it for the exit, naming what the exit animates", () => {
    const exiting = body(".react-flow__node.rf-exiting .agent-node");
    expect(exiting).toMatch(/animation:\s*nodeExit 600ms/);
    const hinted = /will-change:\s*([^;]+)/.exec(exiting)?.[1].split(",").map(s => s.trim()) ?? [];
    const frames = /@keyframes nodeExit\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    for (const prop of ["transform", "opacity", "filter"]) {
      expect(frames, `nodeExit animates ${prop}`).toMatch(new RegExp(`\\b${prop}:`));
      expect(hinted, `will-change names ${prop}`).toContain(prop);
    }
  });

  it("leaves no other rule promoting every card", () => {
    const promoting = [...css.matchAll(/([^{}\n]*\.agent-node[^{}\n]*)\{([^}]*)\}/g)]
      .filter(([, , b]) => /will-change/.test(b))
      .map(([, sel]) => sel.trim());
    expect(promoting).toEqual([".react-flow__node.rf-exiting .agent-node"]);
  });
});
