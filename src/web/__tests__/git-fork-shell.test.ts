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
const appearance = sourceOf("components/AppearanceMenu.tsx");
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

  it("decides once per request and per agent followed, never over a row or file the request named", () => {
    const hook = sourceOf("use-git-view.ts");
    expect(hook).toMatch(/const opening = `\$\{seq\}\|\$\{sessionId\}\|\$\{agent \?\? ""\}`;/);
    expect(hook).toMatch(/if \(!forkOpen \|\| initial\.sel \|\| initial\.file\) \{ decided\.current = opening; return; \}/);
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
      // Every rule is the Fork frame's own (fk-*), scoped under the look, or the Appearance row's.
      expect(sel, sel).toMatch(/\.fk-|data-look="fork"|\.appearance-git-look|\.gv-look/);
    }
  });

  it("passes the look and the list's focus to the history", () => {
    expect(view).toMatch(/agentName=\{nameOf\} look="fork" listFocused=\{listFocused\}/);
    expect(view).toMatch(/const listFocused = winFocused && focusIn && pane === "graph";/);
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
