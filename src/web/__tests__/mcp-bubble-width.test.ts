// The MCP primary bubble is labelled with the server segment, and an
// unrecognised server keeps its raw name — often a long uuid. While the width
// estimate was pinned at 96px for every non-Codex tool, the chained method
// sub-bubble was placed inside the primary and the two drew on top of each
// other. These assert the estimate now tracks the label for MCP calls, and
// that short/known labels still land on the original fixed estimate.
import { describe, it, expect } from "vitest";
import { primaryBubbleWidth, primaryDisplayFor } from "../components/ToolBursts";

/** Same constants the layout uses: the fixed floor and the sub-bubble gap. */
const ESTIMATED_BUBBLE_W = 96;
const SUB_GAP = 28;

/** Where the method sub-bubble starts, relative to the primary's left edge. */
const subOffset = (tool: string, label: string) =>
  primaryBubbleWidth(tool, label) + SUB_GAP;

describe("primaryBubbleWidth", () => {
  it("widens for a long unknown MCP server so the method bubble clears it", () => {
    const w = primaryBubbleWidth("mcp__supabase-local__query", "supabase-local");
    expect(w).toBeGreaterThan(ESTIMATED_BUBBLE_W);
    // 34px of emoji + padding, then ~7.5px per character.
    expect(w).toBeCloseTo(34 + "supabase-local".length * 7.5);
  });

  it("keeps a uuid-named MCP server's sub-bubble outside the primary", () => {
    const uuid = "3f2a9c1e-7b45-4d8a-9f10-c6e5b2d84a37";
    expect(subOffset(`mcp__${uuid}__list_tables`, uuid))
      .toBeGreaterThan(primaryBubbleWidth(`mcp__${uuid}__list_tables`, uuid));
    // The old fixed estimate buried the method bubble deep inside the primary.
    expect(subOffset(`mcp__${uuid}__list_tables`, uuid))
      .toBeGreaterThan(ESTIMATED_BUBBLE_W + SUB_GAP);
  });

  it("leaves known MCP servers on the fixed estimate — their names are short", () => {
    expect(primaryBubbleWidth("mcp__github__create_pr", "GitHub")).toBe(ESTIMATED_BUBBLE_W);
    expect(primaryBubbleWidth("mcp__linear__list_issues", "Linear")).toBe(ESTIMATED_BUBBLE_W);
  });

  it("still scales Codex tools and leaves Claude tools untouched", () => {
    expect(primaryBubbleWidth("exec_command", "Shell")).toBe(ESTIMATED_BUBBLE_W);
    expect(primaryBubbleWidth("shell_command", "a-very-long-label")).toBeGreaterThan(ESTIMATED_BUBBLE_W);
    expect(primaryBubbleWidth("Bash", "Bash")).toBe(ESTIMATED_BUBBLE_W);
    expect(primaryBubbleWidth("NotebookEdit", "NotebookEdit")).toBe(ESTIMATED_BUBBLE_W);
  });
});

// ── what an unbounded label did to the lane ─────────────────────────────────
//
// `primaryBubbleWidth` scales the reserved width off the label, and the label
// for an unrecognised server is the raw segment — routinely a uuid. Nothing
// clipped it: `.tool-burst` is `white-space: nowrap` with no max-width, so a
// 36-character server drew a ~304px pill and pushed its own sub-bubble out of
// the 420px lane `layout.ts` budgets for the whole trail. The cap is on the
// LABEL, at the point it is built, so the space reserved and the pill drawn are
// computed from one bounded string and cannot drift apart.
describe("a bubble's word is bounded before it is measured", () => {
  it("keeps an unrecognised server inside the lane it is given", () => {
    const uuid = "3f2a9c1e-7b45-4d8a-9f10-c6e5b2d84a37";
    const { label } = primaryDisplayFor(`mcp__${uuid}__list_tables`);
    expect([...label].length).toBeLessThanOrEqual(18);
    expect(label.endsWith("…")).toBe(true);
    // TOOL_LANE_W is 420 and the trail is primary + gap + sub.
    expect(primaryBubbleWidth(`mcp__${uuid}__list_tables`, label)).toBeLessThan(220);
  });

  it("leaves a name that already fits exactly as it was", () => {
    expect(primaryDisplayFor("mcp__supabase-local__query").label).toBe("supabase-local");
    expect(primaryDisplayFor("mcp__github__create_pr").label).toBe("GitHub");
  });

  it("still tells two servers apart when their first characters agree", () => {
    const a = primaryDisplayFor("mcp__aaaaaaaaaaaaaaaaaaaaaa-one__x");
    const b = primaryDisplayFor("mcp__aaaaaaaaaaaaaaaaaaaaaa-two__x");
    // The label is cut, so the hue must be hashed from the whole segment.
    expect(a.label).toBe(b.label);
    expect(a.hue).not.toBe(b.hue);
  });

  it("cuts on code points, so a surrogate pair is never split in half", () => {
    const wide = "🧪".repeat(30);
    const { label } = primaryDisplayFor(`mcp__${wide}__run`);
    expect([...label].length).toBeLessThanOrEqual(18);
    expect(label).not.toContain("�");
  });
});
