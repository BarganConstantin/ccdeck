// The git view's Fork look, as a frame: the switch between the looks (the
// deck header's button, the Fork toolbar's Deck look tool, f, Settings), where
// the Fork look opens (Local Changes or All Commits), and its layout's parts.
import { describe, expect, it } from "vitest";
import { sourceOf } from "./client-source";
import { sheetParts } from "./sheet-source";
import { UNCOMMITTED, type Edit, type LogCommit, type StatusEntry } from "../git-view-types";
import { forkCommitPick, forkOpening, viewOf, EMPTY_GIT_DATA } from "../use-git-view";

const view = sourceOf("components/GitView.tsx");
const toolbar = sourceOf("components/FkToolbar.tsx");
const appearance = sourceOf("components/GitSection.tsx");
const fork = sheetParts().find(([path]) => path === "styles/git-fork.css")![1];

const commit = (sha: string, date: string, agent: LogCommit["agent"] = null, extra: Partial<LogCommit> = {}): LogCommit => ({
  sha, parents: [], author: { name: "A", email: "a@x" }, date, subject: sha, trailers: [],
  refs: { local: [], remote: [], tags: [], head: false }, agent, ...extra,
});
const seen = (sessionId: string, agentId: string | null = null): LogCommit["agent"] =>
  ({ sessionId, agentId, label: null, confidence: "seen" });
const focus = { sessionId: "s1", agentIds: null };
const entry = (path: string): StatusEntry => ({ path, area: "unstaged", change: "modified" });
const edit = (path: string, at: number, agentId: string | null = null): Edit => ({ path, agentId, label: null, at });
const repo = { ...EMPTY_GIT_DATA.repo, head: { branch: "main", detached: false, sha: "head000", short: "head000", unborn: false } } as never;

describe("where the Fork look opens", () => {
  const T = Date.parse("2026-10-05T16:00:00Z");
  const commits = [commit("other01", "2026-10-05T17:00:00Z"), commit("mine001", "2026-10-05T16:00:00Z", seen("s1"))];

  it("opens on Local Changes when the focus edited files still uncommitted after its last commit", () => {
    expect(forkOpening({ commits, repo, entries: [entry("a.ts")], edits: [edit("a.ts", T + 60_000)] }, focus)).toBe(UNCOMMITTED);
  });

  it("opens on All Commits at the focus's latest commit when its edits are older, or committed, or someone else's", () => {
    expect(forkOpening({ commits, repo, entries: [entry("a.ts")], edits: [edit("a.ts", T - 60_000)] }, focus)).toBe("mine001");
    expect(forkOpening({ commits, repo, entries: [], edits: [edit("a.ts", T + 60_000)] }, focus)).toBe("mine001");
    expect(forkOpening({ commits, repo, entries: [entry("a.ts")], edits: [edit("a.ts", T + 60_000, "sub-x")] }, { sessionId: "s1", agentIds: ["sub-y"] })).toBe("head000");
  });

  it("falls back to HEAD, then to the newest commit, and to Local Changes in a repository with none", () => {
    expect(forkCommitPick({ commits: [commit("c1", "2026-10-05T10:00:00Z")], repo }, focus)).toBe("head000");
    expect(forkCommitPick({ commits: [commit("c1", "2026-10-05T10:00:00Z")], repo: null }, focus)).toBe("c1");
    expect(forkOpening({ commits: [], repo: null, entries: [entry("README.md")], edits: [] }, focus)).toBe(UNCOMMITTED);
  });

  it("calls the working tree Local Changes and every commit All Commits", () => {
    expect(viewOf(UNCOMMITTED)).toBe("local");
    expect(viewOf("abc1234")).toBe("all");
  });

  it("decides once per request and per agent and worktree followed, never over a row or file the request named", () => {
    const hook = sourceOf("use-git-view.ts");
    expect(hook).toMatch(/const of = `\$\{seq\}\|\$\{owner\}`;/);
    expect(hook).toMatch(/export const selectionOwner = \(sessionId: string, agent: string \| null, top: string \| null\) => `\$\{sessionId\}\|\$\{agent \?\? ""\}\|\$\{top \?\? ""\}`;/);
    // A request's row or file settles it (startPick), and so does every choice, the reader's included.
    expect(hook).toMatch(/picked: hints && initial\.file != null, settled: hints,/);
    expect(hook).toMatch(/if \(pick\.settled\) return;\n    if \(!forkOpen \|\| \(data\.state !== "repo" && data\.state !== "loading"\)\) \{ settle\(\); return; \}/);
    expect(view).toMatch(/forkOpen: prefs\.look === "fork",/);
  });
});

describe("the switch between the looks", () => {
  it("is a button in the deck header, the Deck look tool in the Fork toolbar, f in the view and a row in Settings", () => {
    expect(view).toMatch(/className="glyph-btn gv-look" title="Fork look \(f\)" aria-label="Switch to the Fork look" onClick=\{\(\) => setGitLook\("fork"\)\}/);
    expect(toolbar).toMatch(/label="Deck look" title="Deck look \(f\)"/);
    expect(view).toMatch(/else if \(intent\.kind === "look"\) setGitLook\(fork \? "deck" : "fork"\);/);
    expect(appearance).toMatch(/\{gitOn && <GitLookRow look=\{gitLook\} \/>\}/);
    expect(appearance).toMatch(/role="radiogroup" aria-labelledby="appearance-git-look-label"/);
  });

  it("marks the panel with its look, the one hook every Fork rule hangs off", () => {
    expect(view).toMatch(/data-look=\{prefs\.look\}/);
    for (const m of fork.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(^|\})\s*([^{}@]+)\{/g)) {
      const sel = m[2].trim();
      if (!sel || /^(from|to|\d+%)/.test(sel)) continue;
      // Every rule is the Fork frame's own (fk-*), scoped under the look, or Settings › Git's look row.
      expect(sel, sel).toMatch(/\.fk-|data-look="fork"|\.appearance-git-look|\.gv-look/);
    }
  });

  it("passes the look and the list's focus to the history", () => {
    expect(view).toMatch(/agentName=\{nameOf\} look="fork" listFocused=\{listFocused\}/);
    expect(view).toMatch(/const listFocused = winFocused && focusIn && pane === "graph";/);
  });
});

describe("the commit card", () => {
  it("closes when the look switches: its anchor is the row it was opened beside, in the look before", () => {
    expect(view).toMatch(/useEffect\(\(\) => setCard\(null\), \[agent\.id, request\.seq, prefs\.look\]\);/);
  });
});

describe("the Fork layout", () => {
  it("lays the sidebar column, the toolbar, the history and the inspector out as Fork's window", () => {
    expect(view).toMatch(/<div className="fk-side-col" id="fk-side"/);
    expect(view).toMatch(/<section className="fk-history" id="gv-graph" aria-label="History" data-gv-pane="graph" tabIndex=\{-1\}/);
    expect(view).toMatch(/<FkInspector tab=\{tab\}/);
    expect(view).toMatch(/<section className="fk-local" aria-label="Local Changes" data-gv-pane="files" tabIndex=\{-1\}>/);
    expect(fork).toMatch(/\.fk-toolbar \{[^}]*height: 52px;/);
    expect(fork).toMatch(/\.fk-tabbar \{[^}]*height: 30px;/);
    expect(fork).toMatch(/\.fk-history \{[^}]*flex: 0 1 var\(--gv-graph-h, 35%\);\s*min-height: 110px;/);
    expect(fork).toMatch(/\.fk-inspector \{[^}]*min-height: 160px;/);
  });

  it("keeps its sizes apart from the deck look's", () => {
    expect(view).toMatch(/panelWidth\(fork \? prefs\.fkW : prefs\.w, win, room\)/);
    expect(view).toMatch(/"--gv-graph-h": `\$\{\(\(fork \? prefs\.fkGraphH : prefs\.graphH\) \* 100\)\.toFixed\(1\)\}%`/);
  });
});

describe("the Fork toolbar", () => {
  it("draws the hand-offs as its Open in and Copy tools, from the same row the deck look uses", () => {
    expect(view).toMatch(/path=\{folder\} compact tools/);
    const handoffs = sourceOf("components/GitHandoffs.tsx");
    expect(handoffs).toMatch(/<span className="fk-tool-label">Open in<\/span>/);
    expect(handoffs).toMatch(/<Words now="Copy" then="Copied" done=\{copied === "menu"\} \/>/);
  });

  it("lines Open in and Copy up with the other tools, never shrunk under the separator beside them", () => {
    // The glance's row keeps its 10px over the hand-offs; the toolbar's tools do not.
    expect(fork).toMatch(/\.gv-wide\[data-look="fork"\] \.gv-handoffs-wrap\[data-tools\] \{ flex: none; margin-top: 0; \}/);
    // Their words go before the end of the toolbar is too narrow for them, so nothing overlaps the repository box.
    expect(fork).toMatch(/@container fk \(max-width: 900px\) \{\s*\.fk-toolbar \{ grid-template-columns: minmax\(0, 1fr\) minmax\(84px, min\(240px, calc\(100% - 536px\)\)\) minmax\(0, 1fr\); \}/);
    expect(fork).toMatch(/@container fk \(max-width: 700px\) \{\s*\.fk-tool \.fk-tool-label \{ display: none; \}/);
  });

  it("turns its spinner while any read is on its way, beside the name so nothing moves", () => {
    expect(view).toMatch(/loading: data\.state === "loading" \|\| data\.pending > 0,/);
    expect(fork).toMatch(/\.fk-spin \{\s*position: absolute;/);
  });

  it("gives the repository box way before the tools at a phone's width, and folds nothing into a menu", () => {
    expect(fork).toMatch(/@container fk \(max-width: 520px\) \{\s*\.fk-toolbar \{ grid-template-columns: auto minmax\(84px, 1fr\) auto; \}/);
    expect(toolbar).not.toMatch(/»/);
  });

  it("starts with Canvas on a sheet and draws its close only beside the canvas", () => {
    expect(toolbar).toMatch(/\{sheet && <FkTool className="fk-tool-back"/);
    expect(toolbar).toMatch(/\{!sheet && \(/);
  });
});

describe("a floating sidebar", () => {
  it("is out only while it is needed: a pick in it, Esc or a press outside it puts it away", () => {
    expect(view).toMatch(/onView=\{v => \{ floatAway\(\); view\.setView\(v\); \}\}/);
    expect(view).toMatch(/onJump=\{sha => \{ floatAway\(\); jump\(sha\); \}\}/);
    expect(view).toMatch(/if \(fork && p !== "sidebar"\) floatAway\(\);/);
    expect(view).toMatch(/if \(t\?\.closest\?\.\("\.fk-side-col, \.fk-sidebar-toggle"\)\) return;\s*setFloatSide\(false\);/);
  });

  it("opens a folded inspector when the history is asked into it", () => {
    expect(view).toMatch(/if \(fork && collapsed && view\.view === "all" && \(p === "files" \|\| p === "diff" \|\| p === "commit"\)\) \{\s*patchPrefs\(\{ inspectorCollapsed: false \}\);/);
  });
});

describe("what a floating sidebar covers", () => {
  it("is inert while it is out, and the sidebar takes focus when brought out", () => {
    expect(view).toMatch(/const covering = fork && sidebarOver && sidebarShown;/);
    expect(view).toMatch(/if \(el\) el\.inert = covering;/);
    expect(view).toMatch(/<div className="fk-body" ref=\{fkBodyRef\}>/);
    expect(view).toMatch(/if \(!sidebarShown\) requestAnimationFrame\(\(\) => focusPane\("sidebar"\)\);/);
  });
});

describe("a ref the history does not list", () => {
  it("is said in a short note at the view's foot for a few seconds, and to a screen reader, never a dead press", () => {
    expect(view).toMatch(/const text = !data\.commits \? "The history is still loading\." : `\$\{sha\.slice\(0, 7\)\} is not in the last 100 commits\.`;/);
    expect(view).toMatch(/<p className="fk-note" key=\{jumpNote\.n\} aria-hidden="true">/);
    expect(view).toMatch(/const t = window\.setTimeout\(\(\) => setJumpNote\(null\), 5000\);/);
    expect(view).toMatch(/<span className="vis-hidden" role="status" aria-live="polite">\{jumpNote\?\.text \?\? ""\}<\/span>/);
    expect(fork).toMatch(/\.fk-note \{[^}]*pointer-events: none;/);
  });
});
