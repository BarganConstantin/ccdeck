// WCAG 2.1.4 Character Key Shortcuts, on the git view's surfaces: with
// Settings › General's "Single-key shortcuts" off, `g` no longer opens the view
// from the canvas, so no hint names it — the Git section's Open button and its
// "+N more · g open" line, the commit lane's "+N earlier · g", the shortcuts
// sheet's G and N rows. On, which is where every deck starts, each says what it
// always said. The card's branch chip names no key either way, and Settings ›
// Git's "Press F in the view" stays: F is the view's own key, answered only
// while the view has focus. The keys themselves are
// single-key-shortcuts-git-keys.test.ts's.
//
// Drawn with renderToStaticMarkup; no DOM.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider } from "reactflow";
import type { GitData } from "../use-git-view";
import type { AgentNodeData } from "../types";
import type { GraphState } from "../reducer";
import { sourceOf } from "./client-source";
import { sheetParts } from "./sheet-source";

const read = vi.hoisted(() => ({ data: null as GitData | null }));
vi.mock("../use-git-view", async () => {
  const actual = await vi.importActual<typeof import("../use-git-view")>("../use-git-view");
  return { ...actual, useGitData: () => read.data ?? actual.EMPTY_GIT_DATA };
});

import { setSingleKeyShortcuts } from "../single-key-shortcuts";
import { KEY_HELP, keyHelpFor } from "../key-help";
import { branchChip } from "../git-chip";
import { loadGitPrefs } from "../git-pref";
import { nodeDataFor } from "../canvas-flow";
import { EMPTY_GIT_DATA } from "../use-git-view";
import AgentNode from "../components/AgentNode";
import GitGlance from "../components/GitGlance";
import GitSection from "../components/GitSection";
import KeyboardHelp from "../components/KeyboardHelp";
import { API, MIN, board, commit } from "./git-commit-band-fixture";

let quiet: ReturnType<typeof vi.spyOn>;
beforeAll(() => { quiet = vi.spyOn(console, "error").mockImplementation(() => {}); });
afterAll(() => { quiet.mockRestore(); });
afterEach(() => {
  setSingleKeyShortcuts(true);
  loadGitPrefs({ prefs: { git: true } });
  read.data = null;
});

const noop = () => {};
const titles = (html: string) => [...html.matchAll(/title="([^"]*)"/g)].map(m => m[1]);

// ── the Git section of the detail panel ─────────────────────────────────────

const NOW = Date.parse("2026-10-06T12:00:00Z");
const ROOT = {
  id: "s1", sessionId: "s1", label: "app", kind: "root", state: "done", startedAt: NOW - 3_600_000, tools: [],
  cwd: "/code/app", git: { state: "repo", stale: 1, branch: "main" },
} as unknown as AgentNodeData;
/** A repository with three changed files, two of them this session's: the
 *  section shows those two and folds the third into its more line. */
const REPO: GitData = {
  ...EMPTY_GIT_DATA, state: "repo", at: NOW,
  repo: { head: { branch: "main", detached: false, sha: "abc1234", short: "abc1234", unborn: false }, upstream: null, name: "app" } as GitData["repo"],
  commits: [],
  entries: [
    { path: "README.md", area: "untracked", change: "untracked", added: 3, removed: 0, binary: false },
    { path: "src/merge.ts", area: "unstaged", change: "modified", added: 1, removed: 1, binary: false },
    { path: "src/other.ts", area: "unstaged", change: "modified", added: 2, removed: 0, binary: false },
  ],
  edits: [
    { path: "README.md", agentId: null, label: "app", at: NOW },
    { path: "src/merge.ts", agentId: null, label: "app", at: NOW },
  ],
};
const glance = () => {
  read.data = REPO;
  return renderToStaticMarkup(createElement(GitGlance, { agent: ROOT, root: ROOT, now: NOW, stateRef: { current: { agents: new Map() } } as never }));
};
const openButton = (html: string) => /<button type="button" class="gv-open"[^>]*>[\s\S]*?<\/button>/.exec(html)?.[0] ?? "";
const moreLine = (html: string) => /<button type="button" class="gv-g-more"[^>]*>[\s\S]*?<\/button>/.exec(html)?.[0] ?? "";

describe("the Git section names g only while it opens the view", () => {
  it("draws Open with its cap and (g) in its title while the keys are on", () => {
    const open = openButton(glance());
    expect(open).toContain('title="Open the git view (g)"');
    expect(open).toContain("Open<kbd>g</kbd>");
  });

  it("draws Open alone, its title whole, once the keys are off", () => {
    setSingleKeyShortcuts(false);
    const open = openButton(glance());
    expect(open).toMatch(/data-plain="" title="Open the git view">Open<\/button>$/);
    expect(open).not.toContain("<kbd");
  });

  it("says “+1 more file · g open” while the keys are on, and “+1 more file · open” once they are off", () => {
    expect(moreLine(glance())).toMatch(/\+1 more file<span aria-hidden="true">·<\/span><kbd>g<\/kbd><span>open<\/span><\/button>$/);
    setSingleKeyShortcuts(false);
    const off = moreLine(glance());
    expect(off).toMatch(/\+1 more file<span aria-hidden="true">·<\/span><span>open<\/span><\/button>$/);
    expect(off).not.toContain("<kbd");
  });

  it("names no key anywhere in the section once the keys are off", () => {
    setSingleKeyShortcuts(false);
    const html = glance();
    expect(html).not.toContain("<kbd");
    expect(html).not.toContain("aria-keyshortcuts");
    for (const t of titles(html)) expect(t, t).not.toMatch(/\([a-zA-Z?]\)/);
  });

  it("evens the Open button's insets when it draws no cap", () => {
    const css = sheetParts().find(([path]) => path === "styles/git-view.css")![1];
    expect(css).toMatch(/\.gv-open \{[^}]*padding: 0 4px 0 8px;[^}]*\}[\s\S]*?\.gv-open\[data-plain\] \{ padding: 0 8px; \}/);
    expect(openButton(glance())).not.toContain("data-plain");
    setSingleKeyShortcuts(false);
    expect(openButton(glance())).toContain('data-plain=""');
  });
});

// ── the card ────────────────────────────────────────────────────────────────

/** A card as the canvas draws it, from the canvas's own node data. */
function card(s: GraphState, id: string): string {
  const data = nodeDataFor(s, () => {})(s.agents.get(id)!);
  return renderToStaticMarkup(createElement(ReactFlowProvider, null, createElement(AgentNode as never, { id, data, selected: false })));
}
const fold = (html: string) => /<button type="button" class="git-band-fold nodrag"[^>]*>[\s\S]*?<\/button>/.exec(html)?.[0] ?? "";
/** Seven commits in the half hour: five rows and a fold of two. */
const busy = () => board(Array.from({ length: 7 }, (_, i) => commit(i + 1, (i + 1) * MIN)));

describe("the commit lane's fold names g only while it opens the view", () => {
  it("says “+2 earlier · g” and ends its title with (g) while the keys are on", () => {
    const f = fold(card(busy(), API));
    expect(f).toContain("+2 earlier");
    expect(f).toContain('<span class="git-band-key" aria-hidden="true"> · <kbd>g</kbd></span>');
    expect(f).toMatch(/title="2 more commits in the last 30 minutes\. Open the git view \(g\)"/);
  });

  it("says “+2 earlier” alone, its title whole, once the keys are off", () => {
    setSingleKeyShortcuts(false);
    const f = fold(card(busy(), API));
    expect(f).toContain("<span>+2 earlier</span></button>");
    expect(f).not.toContain("git-band-key");
    expect(f).not.toContain("<kbd");
    expect(f).toMatch(/title="2 more commits in the last 30 minutes\. Open the git view"/);
    // What a screen reader hears never named the key, so it does not change.
    expect(f).toContain('aria-label="2 earlier commits. Open the git view"');
  });
});

describe("the card's branch chip", () => {
  it("names no key in its tooltip or its name, either way: a press opens the view", () => {
    const s = busy();
    const chip = branchChip(s.agents.get(API)!)!;
    expect(chip.title).toBe("feature/auth-login");
    expect(chip.label).toBe("Branch feature/auth-login. Open its git view");
    for (const singleKeys of [true, false]) {
      setSingleKeyShortcuts(singleKeys);
      const html = card(s, API);
      const button = /<button type="button" class="git-chip"[^>]*>/.exec(html)?.[0] ?? "";
      expect(button, `switch ${singleKeys ? "on" : "off"}`).toContain('title="feature/auth-login"');
      expect(button).not.toMatch(/\(g\)|aria-keyshortcuts/);
    }
  });
});

// ── the shortcuts sheet ─────────────────────────────────────────────────────

describe("the shortcuts sheet's git rows", () => {
  const caps = (singleKeys: boolean) => keyHelpFor(singleKeys).flatMap(g => g.rows).map(r => r.cap);

  it("lists G and N while the keys are on", () => {
    expect(caps(true)).toContain("G");
    expect(caps(true)).toContain("N");
    const g = KEY_HELP.flatMap(x => x.rows).find(r => r.cap === "G")!;
    expect(g.binds).toEqual(["g", "G"]);
    expect(g.chord).toBeUndefined();
  });

  it("lists neither once the keys are off: the sheet keeps only the keys that still work", () => {
    expect(caps(false)).not.toContain("G");
    expect(caps(false)).not.toContain("N");
    for (const row of keyHelpFor(false).flatMap(g => g.rows)) expect(row.action, row.cap).not.toMatch(/git view/);
  });

  it("draws G's cap on the sheet only while G does something", () => {
    const draw = () => renderToStaticMarkup(createElement(KeyboardHelp, { onClose: noop, onSettings: noop }));
    expect(draw()).toContain("<kbd>G</kbd><span>git view for the selected agent");
    setSingleKeyShortcuts(false);
    expect(draw()).not.toContain("<kbd>G</kbd>");
    expect(draw()).not.toContain("git view");
  });
});

// ── aria-keyshortcuts ───────────────────────────────────────────────────────

describe("aria-keyshortcuts on the git surfaces", () => {
  it("names only the Fork inspector's 1 2 3, which answer inside the view alone", () => {
    const files = [
      "components/GitGlance.tsx", "components/CommitBand.tsx", "components/GitChip.tsx", "components/GitCardMark.tsx",
      "components/GitView.tsx", "components/GitGraph.tsx", "components/GitDiff.tsx", "components/GitFiles.tsx",
      "components/GitSection.tsx", "components/FkToolbar.tsx", "components/FkInspector.tsx",
    ];
    const named = files.flatMap(rel => [...sourceOf(rel).matchAll(/aria-keyshortcuts=\{?([^\s>]+)/g)].map(m => `${rel}: ${m[1]}`));
    expect(named).toEqual(["components/FkInspector.tsx: String(i"]);
  });
});

// ── Settings › Git ──────────────────────────────────────────────────────────

describe("Settings › Git's note on the look", () => {
  it("still says F switches it in the view with the keys off: F is the view's own key, answered while it has focus", () => {
    const note = "Fork draws the view as Fork&#x27;s window, still read-only. Press F in the view to switch.";
    expect(renderToStaticMarkup(createElement(GitSection))).toContain(note);
    setSingleKeyShortcuts(false);
    expect(renderToStaticMarkup(createElement(GitSection))).toContain(note);
  });
});

// ── the rule ────────────────────────────────────────────────────────────────

describe("every git title that names g", () => {
  it("is built through the switch's own rule", () => {
    expect(sourceOf("components/GitGlance.tsx")).toContain('title={withKey("Open the git view", "g", singleKeys)}');
    expect(sourceOf("components/CommitBand.tsx")).toMatch(/title=\{withKey\(`\$\{earlier\} more [^`]*Open the git view`, "g", singleKeys\)\}/);
    for (const rel of ["components/GitGlance.tsx", "components/CommitBand.tsx"]) {
      expect(sourceOf(rel), rel).not.toContain("(g)");
      expect(sourceOf(rel), rel).toContain("const singleKeys = useSingleKeyShortcuts();");
    }
  });
});
