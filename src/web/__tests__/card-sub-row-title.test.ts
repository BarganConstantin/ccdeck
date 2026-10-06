// A card's second row carries its whole text on hover.
//
// The row under a card's name says what kind of agent it is, how many it
// started, the folder a subagent works in and the model, and it ellipsises at
// the card's width. A subagent's row is the one that reaches that width: on a
// board with a subagent in a checkout called `shop-api-auth`, "subagent ·
// shop-api-auth" took the whole row, the model chip after it was cut away
// entirely, and the row had no tooltip, so which model the subagent ran on could
// not be read off its card at all. The name above it, the session's name row and
// the zoomed-out face all carry their whole text in a `title`; this row now does
// too, in the order the row draws it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { subRowTitle } from "../agent-copy";
import type { AgentNodeData } from "../types";
import { sheetRules } from "./sheet-cascade";

const node = readFileSync(fileURLToPath(new URL("../components/AgentNode.tsx", import.meta.url)), "utf8");
const body = (sel: string) => sheetRules().filter(r => r.media == null && r.selectors.includes(sel)).map(r => r.body).join("\n");

const NO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };
const SPENT = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreateTokens: 0 };

/** The fields the row reads, on an otherwise empty card. */
function card(over: Partial<AgentNodeData>): AgentNodeData {
  return { kind: "root", childCount: 0, usage: NO_USAGE, ...over } as AgentNodeData;
}

describe("the card's second row", () => {
  it("ellipsises at the card's width, which is why it needs the tooltip", () => {
    expect(body(".agent-node .sub")).toMatch(/white-space:\s*nowrap;/);
    expect(body(".agent-node .sub")).toMatch(/text-overflow:\s*ellipsis;/);
  });

  it("carries its whole text on hover", () => {
    expect(node).toContain('<div className="sub" title={subRowTitle(data)}>');
  });

  it("says a subagent's kind, folder and model, in the order the row draws them", () => {
    expect(subRowTitle(card({ kind: "subagent", cwdBasename: "shop-api-auth", model: "claude-sonnet-5-5" })))
      .toBe("subagent · shop-api-auth · Sonnet 5.5");
  });

  it("says how many a session started, and the models its spend covers past the current one", () => {
    const root = card({
      childCount: 2,
      cwdBasename: "shop-api-auth",
      model: "claude-opus-5-5",
      usage: SPENT,
      usageByModel: { "claude-opus-5-5": SPENT, "claude-sonnet-5-5": SPENT },
    });
    // A session's folder is its name on the row above, so the row leaves it out
    // and so does its tooltip.
    expect(subRowTitle(root)).toBe("session · → 2 · Opus 5.5 +1");
  });

  it("names Codex where a Codex session has no model yet, and nothing where a Claude one has none", () => {
    expect(subRowTitle(card({ provider: "codex" }))).toBe("session · Codex");
    expect(subRowTitle(card({ provider: "claude" }))).toBe("session");
  });
});
