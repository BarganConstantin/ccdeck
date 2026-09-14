// #835: token counts used two formats side by side. The details rail printed
// raw grouped integers (111,053,708) while the usage panel beside it printed
// fmtTokens (177.08M), and next to each other they read as two different kinds
// of measurement. The rail uses fmtTokens now, with the exact count in a title.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fmtTokens } from "../token-format";

const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
const grid = /<div className="tokens-grid">([\s\S]*?)<\/div>\s*<\/section>/.exec(app)?.[1] ?? "";

const FIELDS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreateTokens"];

describe("the details rail counts tokens the way the usage panel does (#835)", () => {
  it("finds the rail's token grid at all", () => {
    expect(grid, "no .tokens-grid in App.tsx").not.toBe("");
  });

  it("prints each count through fmtTokens, with the exact value in a title", () => {
    for (const field of FIELDS) {
      expect(grid, field).toContain(`{fmtTokens(agent.usage.${field})}`);
      expect(grid, field).toContain(`title={agent.usage.${field}.toLocaleString()}`);
    }
  });

  it("prints no grouped integer as the count itself", () => {
    expect(grid).not.toMatch(/>\{agent\.usage\.\w+\.toLocaleString\(\)\}</);
  });

  it("reads the format from the module every other token surface imports", () => {
    expect(app).toMatch(/import \{ fmtTokens \} from "\.\/token-format";/);
    expect(app).not.toMatch(/function fmtTokens\(/);
  });

  it("turns the issue's own figure into the usage panel's shape", () => {
    expect(fmtTokens(111_053_708)).toBe("111.05M");
  });
});
