// The Fork look draws Fork's window without one of its write controls: no
// Fetch, Pull, Push, Stash, New Branch, Commit, Amend, Stage or Unstage, and no
// checkout menu on the branch. The view reads a repository and never writes
// to it, whichever look it wears. Rendered on the server with the hand-offs
// stood in for, so nothing is fetched.
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { sourceOf } from "./client-source";

vi.mock("../git-handoffs", async () => {
  const actual = await vi.importActual<typeof import("../git-handoffs")>("../git-handoffs");
  const ready = {
    state: "ready", local: true, machine: "box",
    slots: {
      git: { apps: [{ id: "fork", name: "Fork" }], chosen: "fork" },
      editor: { apps: [{ id: "code", name: "VS Code" }], chosen: "code" },
      terminal: { apps: [{ id: "term", name: "Terminal" }], chosen: "term" },
    },
  };
  return { ...actual, useHandoffs: () => ready, loadHandoffs: async () => {} };
});

import FkToolbar from "../components/FkToolbar";
import FkInspector from "../components/FkInspector";
import FkBanner from "../components/FkBanner";
import GitHandoffs from "../components/GitHandoffs";

/** Fork's own write controls, and git's verbs that write, as a control's name. */
const WRITES = /^(fetch|pull|push|stash|new branch|branch|commit|amend|stage|unstage|stage all|discard|checkout|check out|reset|merge|rebase|cherry-pick|revert|tag|delete|apply|pop)\b/i;

/** Every control the markup draws, by the name it is announced by. */
function controlNames(html: string): Array<{ role: string; name: string }> {
  const out: Array<{ role: string; name: string }> = [];
  for (const m of html.matchAll(/<(button|a|input|select)\b([^>]*)>([\s\S]*?)<\/\1>|<(input)\b([^>]*)\/?>/g)) {
    const attrs = m[2] ?? m[5] ?? "";
    const role = /\brole="([^"]+)"/.exec(attrs)?.[1] ?? m[1] ?? m[4];
    const label = /\baria-label="([^"]*)"/.exec(attrs)?.[1];
    const text = (m[3] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    out.push({ role, name: (label ?? text).trim() });
  }
  return out;
}

const toolbar = () => renderToStaticMarkup(createElement(FkToolbar, {
  sheet: true, onBack: () => {}, sidebarShown: true, onToggleSidebar: () => {},
  agent: { name: "api-fix", hue: 200, narrow: true, counts: "3 commits · 4 files", title: "api-fix", widen: { label: "Show the whole session", onWiden: () => {} } },
  repo: {
    name: "shop-api-auth", mainName: "shop-api", title: "worktree", branch: "feature/auth-login", detached: false, shortSha: "abc1234",
    unborn: false, ahead: 2, behind: 1, upstreamTitle: "Against origin", loading: true,
  },
  handoffs: createElement(GitHandoffs, { sessionId: "s1", branch: "feature/auth-login", sha: "abc1234", path: "/code/shop-api-auth", compact: true, tools: true }),
  onLook: () => {}, onClose: () => {},
}));

describe("the Fork look has no write control", () => {
  it("draws its toolbar with read-only tools only: the sidebar, the agent, the repository, open in, copy, the look", () => {
    const names = controlNames(toolbar());
    expect(names.length).toBeGreaterThan(4);
    for (const { role, name } of names) expect(name, `${role} "${name}"`).not.toMatch(WRITES);
    expect(names.map(n => n.name)).toEqual(expect.arrayContaining([
      "Back to the canvas", "Hide the sidebar", "Open shop-api-auth in an app", "Copy the branch, commit SHA or folder path", "Deck look (f)",
    ]));
  });

  it("keeps the branch a line of text, not a checkout menu", () => {
    const html = toolbar();
    const box = html.slice(html.indexOf('class="fk-repo"'), html.indexOf('class="fk-tb-end"'));
    expect(box).toContain("feature/auth-login");
    expect(box).not.toMatch(/<button|aria-haspopup|role="menu"/);
  });

  it("names its inspector's tabs and its fold, and nothing that commits", () => {
    const html = renderToStaticMarkup(createElement(FkInspector, { tab: "changes", onTab: () => {}, collapsed: false, onToggleCollapsed: () => {}, children: null }));
    const names = controlNames(html);
    // "Commit" is the tab that shows a commit's details: a view, not the verb.
    expect(names.filter(n => n.role === "tab").map(n => n.name)).toEqual(["Commit", "Changes"]);
    for (const { role, name } of names.filter(n => n.role !== "tab")) expect(name, `${role} "${name}"`).not.toMatch(WRITES);
  });

  it("says a detached HEAD in its banner without offering to check anything out", () => {
    const html = renderToStaticMarkup(createElement(FkBanner, { collision: null, detached: { short: "56aee3d", clean: true } }));
    expect(html).toContain("HEAD is detached at <b>56aee3d</b>, not on a branch.");
    expect(controlNames(html)).toEqual([]);
  });

  it("writes none of Fork's write commands into any of its parts", () => {
    const dir = fileURLToPath(new URL("../components/", import.meta.url));
    const parts = readdirSync(dir).filter(f => /^Fk\w+\.tsx$/.test(f));
    expect(parts.length).toBeGreaterThanOrEqual(4);
    for (const f of parts) {
      const literals = [...readFileSync(join(dir, f), "utf8").matchAll(/"([^"\n]*)"|`([^`]*)`|>\s*([^<>{}\n]+?)\s*</g)].map(m => (m[1] ?? m[2] ?? m[3] ?? "").trim());
      for (const s of literals) expect(s, `${f}: "${s}"`).not.toMatch(/^(Fetch|Pull|Push|Stash|New Branch|Amend|Stage|Unstage|Stage All|Discard|Checkout)\b/);
    }
  });

  it("asks the server for nothing but the reads the deck look already makes", () => {
    // Every request the view makes goes through the shared reads; the Fork
    // parts post nothing.
    const fork = readdirSync(fileURLToPath(new URL("../components/", import.meta.url))).filter(f => /^Fk\w+\.tsx$/.test(f));
    for (const f of fork) expect(sourceOf(`components/${f}`), f).not.toMatch(/method:\s*"(POST|PUT|PATCH|DELETE)"/);
  });
});
