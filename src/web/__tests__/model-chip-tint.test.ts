// The chip's colour and the chip's word must be the same model.
//
// The sheet tinted by tooltip — `.model-chip[title*="opus"]`, four rules at
// equal specificity, so source order decided. Since #686 the tooltip carries
// every model the card's spend covers:
//
//   `${data.model}\nspend on this card also covers:\n${others.join("\n")}`
//
// so a session that ran on Sonnet and then switched to Opus matched two rules
// and took the LAST one in the file. The chip read "Opus 5 +1" and was painted
// Sonnet blue — in both themes, on the card, in the cluster area and in the
// detail hero. Add a Fable turn and it went yellow. That is the same misreading
// #686 set out to remove: a figure and a label that disagree.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { modelFamily, shortModel } from "../model-label";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const css = read("../styles.css");

describe("the family a chip is painted by", () => {
  it("comes from the model id and nothing else", () => {
    expect(modelFamily("claude-opus-5")).toBe("opus");
    expect(modelFamily("claude-sonnet-5-20260101")).toBe("sonnet");
    expect(modelFamily("claude-haiku-4-5")).toBe("haiku");
    expect(modelFamily("claude-fable-5-1")).toBe("fable");
    expect(modelFamily("claude-mythos-5-1")).toBe("mythos");
    expect(modelFamily("gpt-5.6-sol")).toBe("gpt");
  });

  it("says nothing rather than guessing for a model it does not know", () => {
    for (const id of ["", "something-else", "llama-3", "o3-mini"]) {
      expect(modelFamily(id), id).toBe("");
    }
  });

  it("agrees with the word the chip prints", () => {
    // The whole point: whatever `shortModel` calls it, `modelFamily` paints it.
    for (const id of ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5", "claude-fable-5-1"]) {
      expect(shortModel(id).toLowerCase().startsWith(modelFamily(id)), id).toBe(true);
    }
  });

  it("is not fooled by the other models in a mixed card's tooltip", () => {
    // The defect, stated as the case that produced it: the model is Opus and
    // the tooltip also names Sonnet. The family is Opus.
    const model = "claude-opus-5";
    const tooltip = `${model}\nspend on this card also covers:\nclaude-sonnet-5\nclaude-fable-5-1`;
    expect(tooltip).toContain("sonnet");
    expect(modelFamily(model)).toBe("opus");
  });
});

describe("the sheet", () => {
  it("matches the attribute exactly and no longer matches the tooltip", () => {
    expect(css).toContain('.model-chip[data-family="opus"]');
    expect(css).toContain('.model-chip[data-family="sonnet"]');
    expect(css).toContain('.model-chip[data-family="haiku"]');
    expect(css).toContain('.model-chip[data-family="fable"]');
    expect(css).not.toContain('.model-chip[title*=');
  });

  it("paints mythos like fable, which is what the rate table already says", () => {
    expect(css).toContain('.model-chip[data-family="mythos"]');
  });

  it("keeps both themes on the same key", () => {
    // Light overrides matched the tooltip too, so the defect was in both.
    for (const family of ["opus", "sonnet", "haiku", "fable"]) {
      expect(css, family).toContain(`:root[data-theme="light"] .model-chip[data-family="${family}"]`);
    }
  });
});

describe("every surface that draws a chip stamps the family on it", () => {
  const surfaces: Array<[string, string]> = [
    ["AgentNode", "../components/AgentNode.tsx"],
    ["App detail hero", "../App.tsx"],
    ["SessionList", "../components/SessionList.tsx"],
    ["SessionSummary", "../components/SessionSummary.tsx"],
  ];
  for (const [name, rel] of surfaces) {
    it(`${name} passes data-family`, () => {
      const src = read(rel);
      const chips = [...src.matchAll(/className="model-chip"/g)];
      expect(chips.length, `${name} draws no model chip any more`).toBeGreaterThan(0);
      // Every chip that carries a model carries its family. The Codex
      // placeholder in AgentNode names no model and is deliberately untinted.
      const withModel = [...src.matchAll(/className="model-chip"[\s\S]{0,300}?shortModel\(/g)];
      for (const m of withModel) {
        expect(src.slice(m.index!, m.index! + 300), name).toContain("data-family=");
      }
    });
  }
});
