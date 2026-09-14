// #833: the details rail called a session "root · 118m 13s" while its card
// called the same agent "session". One thing with two names, and "root" is the
// reducer's word, not the reader's. Every surface now says session or subagent.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const web = fileURLToPath(new URL("..", import.meta.url));
const app = readFileSync(join(web, "App.tsx"), "utf8");
const node = readFileSync(join(web, "components/AgentNode.tsx"), "utf8");

function modulesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : modulesUnder(path);
    return /\.tsx$/.test(path) ? [path] : [];
  });
}

const WORDS = 'kind === "root" ? "session" : "subagent"';

describe("a session is called a session everywhere (#833)", () => {
  it("says session or subagent in the details rail, as the card does", () => {
    expect(app).toContain(`<span className="hero-meta-item">{agent.${WORDS}}</span>`);
    expect(node).toContain(`{data.${WORDS}}`);
  });

  it("renders no agent's raw kind as text anywhere", () => {
    // `{agent.kind}` between tags is the defect: whatever the reducer calls it
    // reaches the reader verbatim.
    const offenders = modulesUnder(web)
      .filter(p => />\s*\{\s*\w+\.kind\s*\}\s*</.test(readFileSync(p, "utf8")))
      .map(p => p.slice(web.length));
    expect(offenders).toEqual([]);
  });
});
