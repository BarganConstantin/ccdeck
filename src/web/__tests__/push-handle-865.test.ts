// #865: during a canvas push, the session group nodes eased width and height as
// well as transform. Those nodes are the session's drag handle — transparent,
// painting nothing — while the box a reader sees is `.cluster-card`, which has
// its own easing. Resizing an invisible element on every frame of a push was a
// layout pass bought for nothing, so the handle takes its size at once and
// travels on the transform the push already gives every node.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

/** [selector list, body] for every rule, @media bodies included. */
const RULES = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => [m[1].trim(), m[2]] as const);

describe("the session handle during a push (#865)", () => {
  it("eases no size on the group node, in any rule", () => {
    const sized = RULES
      .filter(([sel]) => sel.includes("react-flow__node-sessionGroup"))
      .filter(([, body]) => /transition:[^;]*\b(width|height)\b/.test(body))
      .map(([sel]) => sel);
    expect(sized).toEqual([]);
  });

  it("still travels with its cards on the push every node gets", () => {
    const push = RULES.find(([sel]) => sel === ".canvas-wrap.bubbling .react-flow__node");
    expect(push, "the push rule is gone").toBeTruthy();
    expect(push![1]).toMatch(/transition:\s*transform 420ms/);
  });

  it("is a handle that paints nothing, which is why its size needs no easing", () => {
    const handle = RULES.find(([sel]) => sel === ".session-group-handle");
    expect(handle?.[1]).toMatch(/background:\s*transparent/);
  });
});
