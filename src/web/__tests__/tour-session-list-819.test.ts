// #819: the tour's first step said waiting sessions "rise to the top" without
// saying of what. It means the session list — which is closed on a fresh
// install — so a newcomer looked at the canvas, the only thing on screen, and
// saw nothing rise. The line now names the list it is about. guide.test.ts
// already holds the README caption and the rendered picture to the same line.
import { describe, it, expect } from "vitest";
import { WELCOME_STEPS } from "../components/guide-art";

describe("the tour says where waiting sessions go (#819)", () => {
  it("names the session list in the first step", () => {
    expect(WELCOME_STEPS[0].line).toMatch(/session list/);
    expect(WELCOME_STEPS[0].line).not.toMatch(/rise to the top,/);
  });
});
