// #833: the details rail called a session "root · 118m 13s" while its card
// called the same agent "session". One thing with two names, and "root" is the
// reducer's word, not the reader's. Every surface now says session or subagent.
import { agentKindLabel } from "../agent-copy";
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const web = fileURLToPath(new URL("..", import.meta.url));
// The detail panel moved to components/Detail.tsx; App.tsx and it are read as one.
const app = readFileSync(join(web, "App.tsx"), "utf8") + "\n" + readFileSync(join(web, "components/Detail.tsx"), "utf8");
const node = readFileSync(join(web, "components/AgentNode.tsx"), "utf8");

function modulesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : modulesUnder(path);
    return /\.tsx$/.test(path) ? [path] : [];
  });
}


describe("a session is called a session everywhere (#833)", () => {
  it("says session or subagent in the details rail, as the card does", () => {
    expect(app).toContain('<span className="hero-meta-item">{agentKindLabel(agent)}</span>');
    expect(node).toContain("{agentKindLabel(data)}");
    expect(agentKindLabel({ kind: "root", provider: "claude" })).toBe("session");
    expect(agentKindLabel({ kind: "subagent", provider: "claude", parentId: "parent" })).toBe("subagent");
    expect(agentKindLabel({ kind: "root", provider: "codex" })).toBe("session");
    expect(agentKindLabel({ kind: "root", provider: "codex", parentId: "parent" })).toBe("child session");
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
