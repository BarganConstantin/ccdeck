// The git view's Fork-look sidebar: which sections it lists and in what
// order, how the filter narrows them, what the keys do on the tree, that it
// draws no control that would write to the repository, and that its words
// and marks clear the contrast floors in both themes. Rendered server-side
// where it is rendered at all: no DOM here, so the tree's rows are checked as
// the model builds them and the markup as React writes it.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import FkSidebar, { RefsNote } from "../components/FkSidebar";
import { FkSidebarTree } from "../components/FkSidebarTree";
import { SECTIONS, sidebarKey, sidebarRows, stashLabel, visibleSections, withOpen, type SbRow } from "../fk-sidebar-model";
import { foldRefs, EMPTY_REFS } from "../use-git-refs";
import type { GitRefs, Repo } from "../git-view-types";
import { sheetText } from "./sheet-source";

let quiet: ReturnType<typeof vi.spyOn>;
beforeAll(() => { quiet = vi.spyOn(console, "error").mockImplementation(() => {}); });
afterAll(() => { quiet.mockRestore(); });

const sha = (c: string) => c.repeat(40);
const TOP = "/code/shop-api";

const REFS: GitRefs = {
  branches: [
    { name: "bulk/ticket-2", sha: sha("1"), current: false, upstream: null, ahead: 0, behind: 0, gone: false, worktree: null },
    { name: "bulk/ticket-10", sha: sha("1"), current: false, upstream: null, ahead: 0, behind: 0, gone: false, worktree: null },
    { name: "develop", sha: sha("a"), current: true, upstream: "origin/develop", ahead: 2, behind: 1, gone: false, worktree: TOP },
    { name: "feature/auth-login", sha: sha("b"), current: false, upstream: "origin/feature/auth-login", ahead: 2, behind: 0, gone: false, worktree: "/code/shop-api-auth" },
    { name: "feature/bargan/VCRM-9090-make-the-invoice-builder-understand-everything", sha: sha("c"), current: false, upstream: "origin/feature/bargan/VCRM-9090-make-the-invoice-builder-understand-everything", ahead: 0, behind: 0, gone: false, worktree: null },
    { name: "fix/old-timeout", sha: sha("d"), current: false, upstream: "origin/fix/old-timeout", ahead: 0, behind: 0, gone: true, worktree: null },
    { name: "main", sha: sha("e"), current: false, upstream: "origin/main", ahead: 0, behind: 60, gone: false, worktree: null },
    { name: "aardvark", sha: sha("f"), current: false, upstream: null, ahead: 0, behind: 0, gone: false, worktree: null },
  ],
  remotes: [{ name: "origin", branches: [{ name: "develop", sha: sha("2") }, { name: "feature/graphql-spike", sha: sha("3") }, { name: "main", sha: sha("e") }] }],
  tags: [
    { name: "v1.10.0", sha: sha("4"), annotated: true },
    { name: "v1.2.0", sha: sha("5"), annotated: true },
    { name: "deploy/staging", sha: sha("6"), annotated: false },
  ],
  stashes: [
    { index: 0, sha: sha("7"), subject: "On develop: try a longer cache key", date: "2026-10-04T10:00:00Z" },
    { index: 1, sha: sha("8"), subject: "WIP on develop: eb7170c test(api): pin half-up rounding", date: "2026-10-04T09:00:00Z" },
  ],
  worktrees: [
    { path: TOP, name: "shop-api", branch: "develop", sha: sha("a"), current: true, locked: false, prunable: false, missing: false },
    { path: "/code/shop-api-fix", name: "shop-api-fix", branch: "fix/retry-backoff", sha: sha("9"), current: false, locked: false, prunable: false, missing: false },
    { path: "/code/shop-api-auth", name: "shop-api-auth", branch: "feature/auth-login", sha: sha("b"), current: false, locked: true, prunable: true, missing: true },
  ],
  submodules: [{ path: "vendor/payments-sdk", name: "vendor/payments-sdk", sha: sha("0") }],
  clipped: [],
  unread: [],
};

const rowsOf = (over: Partial<Parameters<typeof sidebarRows>[0]> = {}) =>
  sidebarRows({ refs: REFS, topLevel: TOP, defaultBranch: "develop", open: {}, query: "", ...over });
const labels = (rows: SbRow[]) => rows.map(r => `${"  ".repeat(r.level - 1)}${r.label}`);

describe("sections: order and contents", () => {
  it("lists Worktrees, Branches, Remotes, Tags, Stashes, Submodules in that order, and no Starred", () => {
    expect(SECTIONS.map(s => s.title)).toEqual(["Worktrees", "Branches", "Remotes", "Tags", "Stashes", "Submodules"]);
    expect(rowsOf().filter(r => r.kind === "section").map(r => r.label)).toEqual(["Worktrees", "Branches", "Remotes", "Tags", "Stashes", "Submodules"]);
    expect(rowsOf().some(r => /starred/i.test(r.label))).toBe(false);
  });

  it("shows Worktrees only with a linked worktree, and Submodules only when there is one", () => {
    const lone = { ...REFS, worktrees: REFS.worktrees.slice(0, 1), submodules: [] };
    expect(visibleSections(lone)).toEqual(["branches", "remotes", "tags", "stashes"]);
  });

  it("opens Branches and shuts the rest by default; the trunk comes first, then folders, then branches", () => {
    expect(labels(rowsOf())).toEqual([
      "Worktrees",
      "Branches",
      "  develop",
      "  main",
      "  bulk",
      "  feature",
      "  fix",
      "  aardvark",
      "Remotes",
      "Tags",
      "Stashes",
      "Submodules",
    ]);
  });

  it("nests a name's folders, 6px of indent a level, in natural order, and opens the folders holding the checked-out branch", () => {
    const rows = rowsOf({ open: { "branches:bulk/": true, "branches:feature/": true, "branches:feature/bargan/": true } });
    const bulk = rows.filter(r => r.parent === "branches:bulk/").map(r => r.label);
    expect(bulk).toEqual(["ticket-2", "ticket-10"]);
    const vcrm = rows.find(r => r.label.startsWith("VCRM-9090"))!;
    expect(vcrm).toMatchObject({ depth: 2, level: 4, kind: "branch", parent: "branches:feature/bargan/" });
    expect(vcrm.title).toContain("feature/bargan/VCRM-9090-make-the-invoice-builder-understand-everything");
    // On a feature branch, its folder starts open so its ✓ is in sight.
    const onFeature = { ...REFS, branches: REFS.branches.map(b => ({ ...b, current: b.name === "feature/auth-login" })) };
    const r2 = sidebarRows({ refs: onFeature, topLevel: TOP, open: {}, query: "" });
    expect(r2.find(r => r.key === "branches:feature/")?.open).toBe(true);
    expect(r2.find(r => r.label === "auth-login")).toMatchObject({ current: true, depth: 1 });
  });

  it("marks the checked-out branch, its counts, a gone upstream and a branch another worktree holds", () => {
    const rows = rowsOf({ open: { "branches:feature/": true, "branches:fix/": true } });
    expect(rows.find(r => r.label === "develop" && r.kind === "branch")).toMatchObject({ current: true, ahead: 2, behind: 1, heldBy: null });
    expect(rows.find(r => r.label === "main" && r.kind === "branch")).toMatchObject({ behind: 60, ahead: 0 });
    expect(rows.find(r => r.label === "old-timeout")).toMatchObject({ gone: true });
    expect(rows.find(r => r.label === "auth-login")).toMatchObject({ heldBy: "/code/shop-api-auth" });
  });

  it("lists worktrees by name with their branch, ✓ on the session's own, and the stash without git's prefix", () => {
    const rows = rowsOf({ open: { "section:worktrees": true, "section:stashes": true } });
    const wt = rows.filter(r => r.kind === "worktree");
    expect(wt.map(r => [r.label, r.detail, !!r.current, !!r.missing])).toEqual([
      ["shop-api", "develop", true, false],
      ["shop-api-auth", "feature/auth-login", false, true],
      ["shop-api-fix", "fix/retry-backoff", false, false],
    ]);
    expect(rows.filter(r => r.kind === "stash").map(r => r.label)).toEqual(["try a longer cache key", "WIP on develop: eb7170c test(api): pin half-up rounding"]);
    expect(stashLabel("On feature/x: wip")).toBe("wip");
  });

  it("groups remote branches under their remote, and tags under their folders", () => {
    const rows = rowsOf({ open: { "section:remotes": true, "remotes:origin/": true, "remotes:origin/feature/": true, "section:tags": true } });
    expect(labels(rows.filter(r => r.section === "remotes"))).toEqual([
      "Remotes", "  origin", "    develop", "    main", "    feature", "      graphql-spike",
    ]);
    expect(labels(rows.filter(r => r.section === "tags"))).toEqual(["Tags", "  deploy", "  v1.2.0", "  v1.10.0"]);
  });

  it("says None for an open empty section, why for one git could not read, and where a list was cut", () => {
    const empty = { ...REFS, stashes: [], unread: ["submodules" as const], submodules: [{ path: "x", name: "x", sha: sha("0") }], clipped: ["refs" as const] };
    const rows = sidebarRows({ refs: { ...empty, submodules: [] , unread: ["stashes"] }, topLevel: TOP, open: { "section:stashes": true, "section:tags": true }, query: "" });
    expect(rows.find(r => r.key === "section:stashes")).toMatchObject({ hasChildren: false, open: true });
    expect(rows.find(r => r.key === "section:stashes:none")?.label).toBe("Could not be read");
    expect(rows.find(r => r.key === "section:tags:clipped")?.title).toMatch(/first 2,000/);
    const none = sidebarRows({ refs: { ...REFS, stashes: [] }, topLevel: TOP, open: { "section:stashes": true }, query: "" });
    expect(none.find(r => r.key === "section:stashes:none")?.label).toBe("None");
  });

  it("remembers what was opened by key, and nothing else", () => {
    const a = withOpen({}, "section:tags", true);
    expect(a).toEqual({ "section:tags": true });
    expect(withOpen(a, "section:tags", true)).toBe(a);
  });
});

describe("the filter", () => {
  it("keeps only the refs whose name holds it, in any case, with every folder and section on the way open", () => {
    const rows = rowsOf({ query: "VCRM" });
    expect(labels(rows)).toEqual(["Branches", "  feature", "    bargan", "      VCRM-9090-make-the-invoice-builder-understand-everything"]);
  });

  it("matches remote branches by remote and name, worktrees by branch, stashes by their whole subject", () => {
    expect(labels(rowsOf({ query: "origin/feature" })).slice(0, 4)).toEqual(["Remotes", "  origin", "    feature", "      graphql-spike"]);
    expect(rowsOf({ query: "retry-backoff" }).filter(r => r.kind === "worktree").map(r => r.label)).toEqual(["shop-api-fix"]);
    expect(rowsOf({ query: "on develop" }).filter(r => r.kind === "stash")).toHaveLength(2);
  });

  it("ignores what was shut while it filters, and says so when nothing matches", () => {
    expect(rowsOf({ query: "main", open: { "section:branches": false } }).some(r => r.label === "main")).toBe(true);
    expect(rowsOf({ query: "zzz-nothing" })).toEqual([expect.objectContaining({ kind: "note", label: "No refs match" })]);
  });
});

describe("keys on the tree", () => {
  const rows = rowsOf({ open: { "branches:feature/": true } });
  const at = (label: string) => rows.findIndex(r => r.label === label);
  const k = (key: string, i: number, extra: Partial<{ shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) =>
    sidebarKey({ key, ctrlKey: false, metaKey: false, altKey: false, ...extra }, rows, i, 5);

  it("walks rows with the arrows, Home, End and the page keys", () => {
    expect(k("ArrowDown", at("develop"))).toEqual({ kind: "cursor", index: at("develop") + 1 });
    expect(k("ArrowUp", 0)).toEqual({ kind: "cursor", index: 0 });
    expect(k("End", 0)).toEqual({ kind: "cursor", index: rows.length - 1 });
    expect(k("Home", 4)).toEqual({ kind: "cursor", index: 0 });
    expect(k("PageDown", 0)).toEqual({ kind: "cursor", index: 5 });
  });

  it("opens a shut folder with →, steps into an open one, shuts it with ←, then steps out to its parent", () => {
    expect(k("ArrowRight", at("bulk"))).toEqual({ kind: "toggle", index: at("bulk"), open: true });
    expect(k("ArrowRight", at("feature"))).toEqual({ kind: "cursor", index: at("feature") + 1 });
    expect(k("ArrowLeft", at("feature"))).toEqual({ kind: "toggle", index: at("feature"), open: false });
    expect(k("ArrowLeft", at("auth-login"))).toEqual({ kind: "cursor", index: at("feature") });
    expect(k("ArrowLeft", at("develop"))).toEqual({ kind: "cursor", index: at("Branches") });
    expect(k("ArrowRight", at("develop"))).toEqual({ kind: "stay" });
  });

  it("selects a ref's commit with Enter or Space, opens and shuts a folder with them, and opens the row's menu", () => {
    expect(k("Enter", at("develop"))).toEqual({ kind: "jump", index: at("develop") });
    expect(k(" ", at("main"))).toEqual({ kind: "jump", index: at("main") });
    expect(k("Enter", at("Tags"))).toEqual({ kind: "toggle", index: at("Tags"), open: true });
    expect(k("ContextMenu", at("develop"))).toEqual({ kind: "menu", index: at("develop") });
    expect(k("F10", at("develop"), { shiftKey: true })).toEqual({ kind: "menu", index: at("develop") });
  });

  it("sends a typed character to the filter, and leaves Tab, Escape and the browser's chords alone", () => {
    expect(k("v", at("develop"))).toEqual({ kind: "type", text: "v" });
    expect(k("Tab", 0)).toEqual({ kind: "pass" });
    expect(k("Escape", 0)).toEqual({ kind: "pass" });
    expect(k("f", 0, { ctrlKey: true })).toEqual({ kind: "pass" });
  });
});

// ── what is drawn ─────────────────────────────────────────────────────────

const REPO: Repo = {
  topLevel: TOP, gitDir: `${TOP}/.git`, commonDir: `${TOP}/.git`, linkedWorktree: false, name: "shop-api", mainName: "shop-api",
  folder: TOP, folderName: "shop-api", nameDiffers: false,
  head: { branch: "develop", detached: false, sha: sha("a"), short: "aaaaaaa", unborn: false }, empty: false, upstream: null,
};

const sidebar = (over: Partial<Parameters<typeof FkSidebar>[0]> = {}) => renderToStaticMarkup(createElement(FkSidebar, {
  sessionId: "S1", agent: null, repo: REPO, stale: 0, view: "all", onView: () => {}, localCount: 3, selectedSha: null, onJump: () => {}, focused: false, ...over,
}));
const tree = (rows: SbRow[]) => renderToStaticMarkup(createElement(FkSidebarTree, {
  rows, selKey: null, stopKey: rows[0]?.key ?? null, label: "refs", onCursor: () => {}, onToggle: () => {}, onJump: () => {}, onMenu: () => {}, onType: () => {}, focusSeq: 0,
}));

describe("the panel", () => {
  it("draws the repository's name, Local Changes with its count, All Commits and the filter, in that order", () => {
    const html = sidebar();
    const at = (s: string) => html.indexOf(s);
    expect(at(">shop-api<")).toBeGreaterThan(-1);
    expect(at("Local Changes (3)")).toBeGreaterThan(at(">shop-api<"));
    expect(at("All Commits")).toBeGreaterThan(at("Local Changes (3)"));
    expect(at('placeholder="Filter"')).toBeGreaterThan(at("All Commits"));
    expect(html).toContain('aria-pressed="true"');
    expect(sidebar({ localCount: 0 })).toContain(">Local Changes<");
  });

  it("draws the tree's marks: ✓ for the checked-out branch, behind before ahead, the gone triangle, the held folder", () => {
    const html = tree(rowsOf({ open: { "branches:feature/": true, "branches:fix/": true } }));
    const develop = /data-key="branches:develop"[\s\S]*?<\/div>/.exec(html)![0];
    expect(develop).toContain('data-current=""');
    expect(develop).toMatch(/fk-sb-count[\s\S]*>1<svg[\s\S]*>2<svg/);
    expect(develop).toContain("checked out, 1 behind, 2 ahead");
    expect(/data-key="branches:fix\/old-timeout"[\s\S]*?<\/div>/.exec(html)![0]).toContain("fk-sb-gone");
    expect(/data-key="branches:feature\/auth-login"[\s\S]*?<\/div>/.exec(html)![0]).toContain("fk-sb-held");
    expect(html).toContain('role="tree"');
    expect(html).toMatch(/role="treeitem" aria-level="1"/);
  });

  it("draws only the rows in sight of a long tree, and always the one Tab lands on", () => {
    const many: GitRefs = { ...REFS, branches: Array.from({ length: 3000 }, (_, i) => ({ name: `b-${i}`, sha: sha("1"), current: i === 2999, upstream: null, ahead: 0, behind: 0, gone: false, worktree: null })) };
    const rows = sidebarRows({ refs: many, topLevel: TOP, open: {}, query: "" });
    expect(rows.length).toBeGreaterThan(3000);
    const stop = rows.find(r => r.current)!.key;
    const html = renderToStaticMarkup(createElement(FkSidebarTree, {
      rows, selKey: null, stopKey: stop, label: "refs", onCursor: () => {}, onToggle: () => {}, onJump: () => {}, onMenu: () => {}, onType: () => {}, focusSeq: 0,
    }));
    expect((html.match(/role="treeitem"/g) ?? []).length).toBeLessThan(60);
    expect(html).toContain(`data-key="${stop}"`);
    expect(html).toContain(`height:${rows.length * 24}px`);
  });
});

describe("read-only: no control that writes", () => {
  const WRITES = /\b(Fetch|Pull|Push|Stash changes|Apply stash|Pop|Drop|New branch|Create branch|Delete|Rename|Checkout|Check out|Switch to|Commit|Stage|Unstage|Merge|Rebase|Reset|Cherry-pick|Revert|Prune|Lock|Unlock|Add worktree|Remove|Star)\b/i;
  const visibleText = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

  it("draws no write action in the panel or the tree", () => {
    const html = sidebar() + tree(rowsOf({ open: { "section:worktrees": true, "section:stashes": true, "section:remotes": true, "section:tags": true, "section:submodules": true } }));
    const buttons = [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map(m => visibleText(m[1]) + (/aria-label="([^"]*)"/.exec(m[0])?.[1] ?? ""));
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) expect(b, b).not.toMatch(WRITES);
    expect(html).not.toMatch(/aria-label="[^"]*\b(checkout|delete|push|pull|fetch)\b/i);
  });

  it("offers only copies in its menu, and sends no request but its own read", () => {
    const src = ["../components/FkSidebar.tsx", "../components/FkSidebarTree.tsx", "../use-git-refs.ts", "../fk-sidebar-model.ts"]
      .map(p => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8")).join("\n");
    // Every item the menu is given, by its words.
    const pushes = [...src.matchAll(/items\.push\(\{ id: [^,]+, label: ([^,]+(?:, app\.name\))?)/g)].map(m => m[1]);
    expect(pushes.length).toBe(2);
    for (const p of pushes) expect(p, p).toMatch(/^(row\.kind === "worktree" \? "Copy path" : "Copy name"|"Copy SHA")$/);
    expect(src).not.toMatch(/method:\s*"(POST|PUT|PATCH|DELETE)"/);
    expect(src.match(/fetch\(`?\/api\/[a-z/]+/g)).toEqual(["fetch(`/api/git/refs"]);
    expect(src).not.toMatch(/openHandoff|useHandoffs/);
  });
});

describe("the read", () => {
  it("keeps the last refs through a failed refresh, and says off, not-a-repo and the rest", () => {
    const ok = foldRefs(EMPTY_REFS, 200, { ok: true, state: "repo", ...REFS });
    expect(ok.refs?.branches).toHaveLength(REFS.branches.length);
    expect(foldRefs(ok, 0, { error: "the deck did not answer" })).toMatchObject({ refs: ok.refs, reason: "the deck did not answer" });
    expect(foldRefs(ok, 200, { ok: false, state: "repo", reason: "timeout" })).toMatchObject({ refs: ok.refs, reason: "timeout" });
    expect(foldRefs(ok, 409, {})).toEqual({ state: "off", refs: null, reason: null });
    expect(foldRefs(ok, 200, { ok: true, state: "not-a-repo" })).toEqual({ state: "not-a-repo", refs: null, reason: null });
    expect(foldRefs(EMPTY_REFS, 500, { error: "boom" }).state).toBe("error");
  });
});

describe("what the panel says when it has no refs to list", () => {
  const note = (refs: Parameters<typeof RefsNote>[0]["refs"]) => renderToStaticMarkup(createElement(RefsNote, { refs, onRetry: () => {} }));
  const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  it("says a first read failed and why, with Try again unless reading again cannot mend it", () => {
    expect(text(note({ state: "repo", refs: null, reason: "timeout" }))).toBe("Could not read the branches. git took too long to answer. Try again");
    const big = note({ state: "repo", refs: null, reason: "too-large" });
    expect(text(big)).toBe("Could not read the branches. The answer was too large.");
    expect(big).not.toContain("<button");
  });

  it("calls git timing out or erring on the folder a failed read, not a folder with no repository", () => {
    expect(text(note({ state: "timeout", refs: null, reason: null }))).toBe("Could not read the branches. git took too long to answer. Try again");
    expect(text(note({ state: "error", refs: null, reason: "HTTP 500" }))).toMatch(/^Could not read the branches\. HTTP 500\. Try again$/);
    expect(text(note({ state: "not-a-repo", refs: null, reason: null }))).toBe("No repository here.");
  });

  it("says nothing while the first read is on its way, or with git switched off, and keeps the last refs through a failed refresh", () => {
    expect(note({ state: "loading", refs: null, reason: null })).toBe("");
    expect(note({ state: "off", refs: null, reason: null })).toBe("");
    expect(text(note({ state: "repo", refs: REFS, reason: "timeout" }))).toBe("Showing the last branches read.");
    expect(note({ state: "repo", refs: REFS, reason: null })).toBe("");
  });
});

// ── contrast (spec 1.3 pairs, both themes) ───────────────────────────────

type Rgba = [number, number, number, number];
const css = sheetText();
const parse = (s: string): Rgba => {
  const v = s.trim();
  const fn = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(v);
  if (fn) return [+fn[1], +fn[2], +fn[3], fn[4] === undefined ? 1 : +fn[4]];
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (!hex) throw new Error(`unparseable colour: ${s}`);
  return [parseInt(hex[1].slice(0, 2), 16), parseInt(hex[1].slice(2, 4), 16), parseInt(hex[1].slice(4, 6), 16), 1];
};
const over = (fg: Rgba, bg: Rgba): Rgba => [0, 1, 2].map(i => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1) as Rgba;
const lum = (c: Rgba) => {
  const [r, g, b] = [c[0], c[1], c[2]].map(v => { const n = v / 255; return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: Rgba, b: Rgba) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

const block = (head: RegExp) => {
  const m = head.exec(css);
  if (!m) throw new Error(`no block ${head}`);
  return Object.fromEntries([...m[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(x => [x[1], x[2].trim()]));
};
const TOKENS = {
  dark: block(/:root,\s*\n:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/),
  light: block(/:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/),
};
// The sidebar's own floor-safe values, declared on .fk-sb (light overrides after).
const LOCAL = {
  dark: block(/\n\.fk-sb \{([\s\S]*?)\n\}/),
  light: block(/\n:root\[data-theme="light"\] \.fk-sb \{([\s\S]*?)\n\}/),
};

function colour(name: string, theme: "dark" | "light"): Rgba {
  const raw = (theme === "light" ? LOCAL.light[name] : undefined) ?? LOCAL.dark[name] ?? TOKENS[theme][name];
  if (raw === undefined) throw new Error(`no ${name} in ${theme}`);
  const v = /^var\((--[\w-]+)\)$/.exec(raw);
  if (v) return colour(v[1], theme);
  const mix = /^color-mix\(in srgb,\s*(#[0-9a-f]{6}|var\((--[\w-]+)\))\s*([\d.]+)%,\s*(transparent|var\((--[\w-]+)\))\)$/i.exec(raw);
  if (mix) {
    const a = mix[2] ? colour(mix[2], theme) : parse(mix[1]);
    const p = +mix[3] / 100;
    if (mix[4] === "transparent") return [a[0], a[1], a[2], p];
    const b = colour(mix[5], theme);
    return [0, 1, 2].map(i => a[i] * p + b[i] * (1 - p)).concat(1) as Rgba;
  }
  return parse(raw);
}

describe("contrast in both themes", () => {
  const TEXT = 4.5, MARK = 3;
  for (const theme of ["dark", "light"] as const) {
    const c = (n: string) => colour(n, theme);
    const panel = c("--fk-sidebar");
    const pill = c("--fk-sidebar-select");
    const blue = c("--fk-select");
    const pairs: Array<[string, Rgba, Rgba, number]> = [
      ["row text on the panel", c("--fk-sidebar-text"), panel, TEXT],
      ["row text on the grey pill", c("--fk-sidebar-text"), pill, TEXT],
      ["row text on the focused pill", c("--fk-select-ink"), blue, TEXT],
      ["counts on the panel", c("--fk-sidebar-count"), panel, TEXT],
      ["counts on the grey pill", c("--fk-sidebar-count"), pill, TEXT],
      ["placeholder and None on the panel", c("--fk-sb-dim"), panel, TEXT],
      ["placeholder on the field", c("--fk-sb-dim"), c("--fk-sidebar-field"), TEXT],
      ["worktree branch on the panel", c("--fk-sb-detail"), panel, TEXT],
      ["worktree branch on the grey pill", c("--fk-sb-detail-sel"), pill, TEXT],
      ["glyphs on the panel", c("--fk-sidebar-glyph"), panel, MARK],
      ["glyphs on the grey pill", c("--fk-sidebar-glyph-sel"), pill, MARK],
      ["glyphs on the focused pill", over(c("--fk-sb-on-select"), blue), blue, MARK],
      ["✓ on the panel", c("--fk-sidebar-check"), panel, MARK],
      ["✓ on the grey pill", c("--fk-sidebar-check"), pill, MARK],
      ["gone triangle on the panel", c("--fk-sb-warn"), panel, MARK],
      ["gone triangle on the grey pill", c("--fk-sb-warn"), pill, MARK],
      ["filter rim against its fill", c("--fk-sb-field-line"), c("--fk-sidebar-field"), MARK],
      ["focus ring on the panel", c("--accent"), panel, MARK],
      ["focus ring on the grey pill", c("--accent"), pill, MARK],
    ];
    for (const [what, fg, bg, floor] of pairs) {
      it(`${theme}: ${what} clears ${floor}:1`, () => {
        expect(ratio(over(fg, bg), bg), `${what} (${theme})`).toBeGreaterThanOrEqual(floor);
      });
    }
  }
});

describe("a worktree whose folder is gone, selected", () => {
  it("writes its name in the selection's own ink, as the Changes tree does a quiet file, not the panel's dim grey", () => {
    const flat = css.replace(/\s+/g, " ");
    // The row's ink is the pill's: row text on the grey pill, the select ink
    // on the focused one — both pairs held above.
    expect(flat).toMatch(/\.fk-sb \[aria-selected="true"\]\[data-missing\] > \.fk-sb-label \{ color: inherit; \}/);
    // Later in the sheet than the dim rule it overrides, at the same weight.
    expect(flat.indexOf('.fk-sb [aria-selected="true"][data-missing] > .fk-sb-label')).toBeGreaterThan(flat.indexOf(".fk-sb .fk-sb-row[data-missing] .fk-sb-label"));
  });
});
