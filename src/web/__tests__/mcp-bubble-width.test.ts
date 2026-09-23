// Reserve enough width for the visible primary label across tool families so
// a chained sub-bubble does not overlap it. Bound long labels to fit the lane.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AgentNodeData, ToolCall } from "../types";
import { collectBursts, cutSubLabel, primaryBubbleWidth, primaryDisplayFor } from "../components/ToolBursts";

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
    // Emoji, gap and padding, then approximately 6.8px per visible character.
    expect(w).toBeCloseTo(61 + "supabase-local".length * 6.8);
  });

  it("keeps a uuid-named MCP server's sub-bubble outside the primary", () => {
    const uuid = "3f2a9c1e-7b45-4d8a-9f10-c6e5b2d84a37";
    expect(subOffset(`mcp__${uuid}__list_tables`, uuid))
      .toBeGreaterThan(primaryBubbleWidth(`mcp__${uuid}__list_tables`, uuid));
    // The old fixed estimate buried the method bubble deep inside the primary.
    expect(subOffset(`mcp__${uuid}__list_tables`, uuid))
      .toBeGreaterThan(ESTIMATED_BUBBLE_W + SUB_GAP);
  });

  it("reserves space for the displayed label of known MCP servers", () => {
    expect(primaryBubbleWidth("mcp__github__create_pr", "GitHub")).toBeCloseTo(61 + 6 * 6.8);
    expect(primaryBubbleWidth("mcp__linear__list_issues", "Linear")).toBeCloseTo(61 + 6 * 6.8);
  });

  it("reserves width for long Claude labels as well as Codex labels", () => {
    expect(primaryBubbleWidth("exec_command", "Shell")).toBe(ESTIMATED_BUBBLE_W);
    expect(primaryBubbleWidth("shell_command", "a-very-long-label")).toBeGreaterThan(ESTIMATED_BUBBLE_W);
    expect(primaryBubbleWidth("Bash", "Bash")).toBe(ESTIMATED_BUBBLE_W);
    expect(primaryBubbleWidth("NotebookEdit", "NotebookEdit")).toBeGreaterThan(ESTIMATED_BUBBLE_W);
    expect(subOffset("NotebookEdit", "NotebookEdit")).toBeGreaterThan(ESTIMATED_BUBBLE_W + SUB_GAP);
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

  it("bounds both halves of a long MCP call within the 420px trail lane", () => {
    const tool = `mcp__${"server-".repeat(12)}__${"very_long_method_".repeat(12)}`;
    const primary = primaryDisplayFor(tool);
    const primaryWidth = Math.min(190, primaryBubbleWidth(tool, primary.label));
    const subWidth = 140;
    expect([...primary.label].length).toBeLessThanOrEqual(18);
    expect(60 + primaryWidth + SUB_GAP + subWidth).toBeLessThanOrEqual(420);
  });
});

// ── the sub-bubble's word, cut once ─────────────────────────────────────────
//
// A sub is 140px at 10px monospace — about thirteen characters of name once its
// chrome is paid. It used to be cut at the primary's eighteen and then cut
// AGAIN by the sheet's ellipsis, at the end, so `package-lock.json` drew as
// `package-lock.…`: the extension went, and the tooltip repeated the cut word.
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

function subFor(name: string, input: unknown) {
  const now = 1_000_000;
  const tool: ToolCall = { id: "t1", name, inputPreview: "", input, startedAt: now - 100 };
  const agent: AgentNodeData = {
    id: "a1", sessionId: "s1", label: "a1", kind: "root", state: "active",
    startedAt: now - 1000, tools: [tool], prompts: [], toolCount: 1, childCount: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
  };
  const all = collectBursts(new Map([[agent.id, agent]]), new Set([agent.id]),
    new Map([[agent.id, { x: 0, y: 0 }]]), new Map(), new Map([[agent.id, { width: 260, height: 130 }]]), now);
  return all.find(b => b.isSub);
}

describe("a sub-bubble's word is cut to what its pill shows", () => {
  it("keeps a file's extension, cutting the middle", () => {
    expect(cutSubLabel("package-lock.json", "file")).toBe("package….json");
    expect(cutSubLabel("AccountProjectsModal.tsx", "file")).toBe("AccountP….tsx");
    // Thirteen code points, the ellipsis counted — the whole of what the pill shows.
    expect([...cutSubLabel("AccountProjectsModal.tsx", "file")]).toHaveLength(13);
  });

  it("leaves a name that fits, and cuts anything else at the end", () => {
    expect(cutSubLabel("styles.css", "file")).toBe("styles.css");
    expect(cutSubLabel("thirteen-char", "file")).toBe("thirteen-char");
    // Not a file: a command or a method is cut the way every label is.
    expect(cutSubLabel("create_pull_request", "mcp")).toBe("create_pull_…");
    // An "extension" too long to be one is part of the name.
    expect(cutSubLabel("Dockerfile.production", "file")).toBe("Dockerfile.p…");
    // A dotfile's leading dot is not an extension.
    expect(cutSubLabel(".eslintrc-with-a-long-name", "file")).toBe(".eslintrc-wi…");
  });

  it("draws the cut word on the pill and the whole one in its tooltip", () => {
    const sub = subFor("Read", { file_path: "/repo/package-lock.json" });
    expect(sub?.name).toBe("package….json");
    expect(sub?.fullName).toBe("package-lock.json");
    const bursts = read("../components/ToolBursts.tsx");
    expect(bursts).toMatch(/const titleHead = b\.isSub \? `\$\{b\.toolName\} · \$\{b\.fullName \?\? b\.name\}` : b\.toolName;/);
    // The memo compares it, or a new full name would never reach the title.
    expect(bursts).toMatch(/a\.fullName === c\.fullName/);
  });

  it("counts against the same 140px the sheet caps the pill at, which the lane cannot grow", () => {
    const css = read("../styles.css");
    const sub = /\.tool-burst\.sub \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(sub).toMatch(/max-width: 140px;/);
    // The longest word the cut lets through, at 10px monospace (~6.1px each,
    // letter-spacing included), plus the pill's chrome: 2px edge, 18px padding,
    // a 12px emoji at ~15px, two 6px gaps and a ~12px status mark.
    const longest = [...cutSubLabel("x".repeat(40), "shell")].length;
    expect(longest * 6.1 + 2 + 18 + 15 + 6 + 6 + 12).toBeLessThanOrEqual(140);
    // Widest primary + gap + this sub, from the agent's 60px offset: the lane
    // has no room for a wider sub.
    expect(60 + 190 + SUB_GAP + 140).toBeLessThanOrEqual(420);
  });
});
