// A session's collisions as its main thread speaks for them, in the git view's
// collision line and the glance's: the team's own first, a subagent's own
// named as its ("↳ docs-sync and web-ui both edited README.md"), never
// claimed for the main thread — as the session's card says them.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CollisionLine } from "../components/GitViewParts";
import { andList, focusCollisions } from "../git-view-words";
import type { GitCollisions } from "../types";
import { sourceOf } from "./client-source";

let quiet: ReturnType<typeof vi.spyOn>;
beforeAll(() => { quiet = vi.spyOn(console, "error").mockImplementation(() => {}); });
afterAll(() => { quiet.mockRestore(); });

const TEAM = { sessionId: "s1", agentIds: null };
// "docs" works in a folder of its own; "near" in the session's folder.
const elsewhere = (k: string) => k === "docs";

describe("the collisions a main node speaks for", () => {
  it("leads with the team's own: its main thread's, and a subagent's in its folder", () => {
    const c: GitCollisions = {
      quiet: [],
      sharp: [
        { agentId: "docs", with: { sessionId: "s2", agentId: null }, files: ["README.md"] },
        { agentId: "near", with: { sessionId: "s3", agentId: null }, files: ["src/a.ts"] },
        { agentId: null, with: { sessionId: "s4", agentId: null }, files: ["src/b.ts"] },
      ],
    };
    const list = focusCollisions(c, TEAM, elsewhere);
    expect(list.map(x => [x.with.sessionId, x.who, x.away])).toEqual([
      ["s3", [], false], ["s4", [], false], ["s2", ["docs"], true],
    ]);
  });

  it("names a subagent's own collision as its, never the main thread's", () => {
    const c: GitCollisions = { quiet: [], sharp: [{ agentId: "docs", with: { sessionId: "s2", agentId: null }, files: ["README.md"] }] };
    expect(focusCollisions(c, TEAM, elsewhere)[0]).toMatchObject({ who: ["docs"], away: true });
  });

  it("says two of the session's own agents on one file once, both named", () => {
    const c: GitCollisions = {
      quiet: [],
      sharp: [
        { agentId: "w1", with: { sessionId: "s1", agentId: "w2" }, files: ["x.ts"] },
        { agentId: "w2", with: { sessionId: "s1", agentId: "w1" }, files: ["x.ts"] },
      ],
    };
    const list = focusCollisions(c, TEAM, elsewhere);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ who: ["w1"], with: { sessionId: "s1", agentId: "w2" }, files: ["x.ts"] });
  });

  it("puts sharp before quiet whoever it is about", () => {
    const c: GitCollisions = {
      quiet: [{ agentId: null, with: { sessionId: "s5", agentId: null }, reason: "same-worktree", branch: null }],
      sharp: [{ agentId: "docs", with: { sessionId: "s2", agentId: null }, files: ["README.md"] }],
    };
    expect(focusCollisions(c, TEAM, elsewhere).map(x => x.level)).toEqual(["sharp", "quiet"]);
  });

  it("names nobody when the view is narrowed to the subagent: each is its own", () => {
    const c: GitCollisions = { quiet: [], sharp: [{ agentId: "docs", with: { sessionId: "s2", agentId: null }, files: ["README.md"] }] };
    expect(focusCollisions(c, { sessionId: "s1", agentIds: ["docs"] }, elsewhere)[0]).toMatchObject({ who: [], away: false });
  });

  it("lists names the way a sentence does", () => {
    expect(andList(["a"])).toBe("a");
    expect(andList(["a", "b"])).toBe("a and b");
    expect(andList(["a", "b", "c"])).toBe("a, b and c");
  });
});

describe("the collision line", () => {
  const sharp = { level: "sharp" as const, with: { sessionId: "s2", agentId: null }, files: ["README.md"], by: ["docs"] };
  const line = (who: string[], where: "wide" | "glance", c: Parameters<typeof CollisionLine>[0]["c"] = sharp) =>
    renderToStaticMarkup(createElement(CollisionLine, { c, who, other: "web-ui", otherCli: null, where, onFocus: () => {} }))
      .replace(/<[^>]+>/g, "");

  it("names a subagent before the other agent, in the wide view and the glance", () => {
    expect(line(["↳ docs-sync"], "wide")).toContain("↳ docs-sync and web-ui both edited README.md since it was last committed. Neither has ended.");
    expect(line(["↳ docs-sync"], "glance")).toContain("README.md edited by ↳ docs-sync and web-ui");
  });

  it("says the main thread's own as before", () => {
    expect(line([], "wide")).toContain("web-ui also edited README.md since it was last committed.");
    expect(line([], "glance")).toContain("README.md also edited by web-ui");
  });

  it("says a subagent's shared folder as its", () => {
    const q = { level: "quiet" as const, with: { sessionId: "s2", agentId: null }, files: [], reason: "same-worktree" as const, by: ["docs"] };
    expect(line(["↳ docs-sync"], "glance", q)).toContain("↳ docs-sync shares a folder with web-ui");
    expect(line([], "glance", q)).toContain("Shares this folder with web-ui");
  });

  it("counts the other agents of the same kind after the first, as the card does, and names them all on hover", () => {
    const q = { level: "quiet" as const, with: { sessionId: "s2", agentId: null }, files: [], reason: "same-worktree" as const, by: [null] };
    const html = (c: Parameters<typeof CollisionLine>[0]["c"], where: "wide" | "glance") =>
      renderToStaticMarkup(createElement(CollisionLine, { c, who: [], other: "develop-hotfix", otherCli: null, where, onFocus: () => {}, also: [{ name: "shop-api · 0005", files: [] }] }));
    for (const where of ["wide", "glance"] as const) {
      const out = html(q, where);
      expect(out.replace(/<[^>]+>/g, ""), where).toContain("Shares this folder with develop-hotfix +1");
      expect(out, where).toMatch(/title="develop-hotfix and shop-api · 0005 work in the same folder\. Select develop-hotfix\."/);
    }
    const two = { ...sharp, by: [null] };
    const sharpHtml = renderToStaticMarkup(createElement(CollisionLine, { c: two, who: [], other: "web-ui", otherCli: null, where: "wide", onFocus: () => {}, also: [{ name: "web-bugfix", files: ["src/app.ts"] }] }));
    expect(sharpHtml.replace(/<[^>]+>/g, "")).toContain("web-ui +1 also edited README.md");
    expect(sharpHtml).toContain("Also web-bugfix: src/app.ts.");
    // One other agent: nothing is counted.
    expect(line([], "wide", q)).not.toContain("+");
  });

  it("is fed the team's collisions with who they are about, in the view and the glance", () => {
    for (const file of ["components/GitView.tsx", "components/GitGlance.tsx"]) {
      const src = sourceOf(file);
      expect(src, file).toMatch(/focusCollisions\(root\?\.gitCollisions, focus,/);
      expect(src, file).toMatch(/<CollisionLine c=\{collision\} who=\{/);
      // The rest of its kind, counted and named.
      expect(src, file).toMatch(/collisions\.filter\(c => c !== collision && c\.level === collision\.level\)/);
      expect(src, file).toMatch(/also=\{also\}/);
    }
    // A subagent's collision in a folder of its own marks no file of this folder.
    expect(sourceOf("components/GitView.tsx")).toMatch(/collisions\.filter\(c => c\.level === "sharp" && !c\.away\)/);
  });
});
