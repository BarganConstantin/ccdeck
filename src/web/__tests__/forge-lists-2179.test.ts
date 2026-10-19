// #2179: the GitHub and GitLab panel's four lists — Branches, Merge requests /
// Pull requests, Pipelines / Actions, Issues — and the project picker above.
//
// What these pin: the words a row is made of (`!12` inside a project, the full
// key across them; a draft's "Draft:" lifted into a badge; "merged 3h ago"
// once merged; GitLab's 999+; what started a pipeline; GitHub's workflow name
// moved under the run's title); where "Create merge request ↗" goes; which of
// its five states a list is in and the sentence each empty list says; and,
// drawn from a kept answer, that the tabs keep the Branches page's order and
// folds, split review requests, never put a control inside a row's button,
// and open every forge link outside the deck. Every name here is invented.
import { describe, expect, it } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  allReposLabel, changeMoment, countWords, defaultFirst, divergeWords, draftTitle, emptyChangesWords, emptyIssuesWords,
  emptyPipelinesWords, issueClosedMark, itemLabel, labelColor, listPhase, moreLabel, newChangeUrl, noMatchWords,
  pipelineSourceWords, pipelineTitle, repoNounPlural, splitRepoPath,
} from "../forge-lists";
import { DEFAULT_VIEW, forgeReadPath, keepRead, type ForgeView } from "../forge-panel";
import type { ChangeCounts, ForgeBranch, ForgeChange, ForgeIssue, ForgeKind, ForgePipeline, Page } from "../forge-types";
import { ForgeProvider, type ForgeContextValue, type ForgeSelection } from "../components/forge/ForgeContext";
import BranchesTab from "../components/forge/BranchesTab";
import ChangesTab from "../components/forge/ChangesTab";
import PipelinesTab from "../components/forge/PipelinesTab";
import IssuesTab from "../components/forge/IssuesTab";
import RepoPicker from "../components/forge/RepoPicker";

// ── words ────────────────────────────────────────────────────────────────

describe("the words a list is made of", () => {
  it("names the project noun the forge's way, plural included", () => {
    expect(repoNounPlural("gitlab")).toBe("projects");
    expect(repoNounPlural("github")).toBe("repositories");
    expect(allReposLabel("gitlab")).toBe("All projects");
    expect(allReposLabel("github")).toBe("All repositories");
  });

  it("splits a path into its quiet group and the project's own name", () => {
    expect(splitRepoPath("acme/tools/web")).toEqual({ group: "acme/tools/", name: "web" });
    expect(splitRepoPath("acme/web")).toEqual({ group: "acme/", name: "web" });
    expect(splitRepoPath("web")).toEqual({ group: "", name: "web" });
  });

  it("writes !12 inside a project and the full key across projects", () => {
    expect(itemLabel("!", { key: "acme/web!12", number: 12 }, false)).toBe("!12");
    expect(itemLabel("!", { key: "acme/web!12", number: 12 }, true)).toBe("acme/web!12");
    expect(itemLabel("#", { key: "acme/web#7", number: 7 }, false)).toBe("#7");
  });

  it("lifts a draft's prefix into the badge, and leaves other titles alone", () => {
    expect(draftTitle("Draft: Add login", true)).toBe("Add login");
    expect(draftTitle("draft:Add login", true)).toBe("Add login");
    expect(draftTitle("[Draft] Add login", true)).toBe("Add login");
    expect(draftTitle("WIP: Add login", true)).toBe("Add login");
    expect(draftTitle("Add login", true)).toBe("Add login");
    expect(draftTitle("Draft: Add login", false)).toBe("Draft: Add login");
    expect(draftTitle("Draft:", true)).toBe("Draft:");
  });

  it("ends a change row on when it was merged or closed, else when it moved", () => {
    const base = { updatedAt: 3, mergedAt: null, closedAt: null };
    expect(changeMoment({ ...base, state: "open" })).toEqual({ verb: "updated", at: 3 });
    expect(changeMoment({ ...base, state: "merged", mergedAt: 2 })).toEqual({ verb: "merged", at: 2 });
    expect(changeMoment({ ...base, state: "closed", closedAt: 1 })).toEqual({ verb: "closed", at: 1 });
    expect(changeMoment({ ...base, state: "merged" })).toEqual({ verb: "updated", at: 3 });
  });

  it("draws a count only when the forge gave one", () => {
    expect(countWords(1868)).toBe("1,868");
    expect(countWords(0)).toBe("0");
    expect(countWords(null)).toBeNull();
    expect(countWords(undefined)).toBeNull();
    expect(countWords(-1)).toBeNull();
  });

  it("lets only a plain hex colour reach a label's style", () => {
    expect(labelColor("#a2eeef")).toBe("#a2eeef");
    expect(labelColor("#FFF")).toBe("#FFF");
    expect(labelColor("red")).toBeNull();
    expect(labelColor("#12345")).toBeNull();
    expect(labelColor("url(https://x)")).toBeNull();
    expect(labelColor("#fff;background:url(x)")).toBeNull();
    expect(labelColor(null)).toBeNull();
  });

  it("says behind | ahead in words, GitLab's 999+ included", () => {
    expect(divergeWords(2, 29, "main")).toBe("2 commits behind, 29 ahead of “main”");
    expect(divergeWords(1, 0, null)).toBe("1 commit behind, 0 ahead of the default branch");
    expect(divergeWords(0, 1000, "main")).toBe("0 commits behind, 999+ ahead of “main”");
    expect(divergeWords(null, 3, "main")).toBeNull();
  });

  it("names what started a pipeline, and keeps a word it does not know", () => {
    expect(pipelineSourceWords("merge_request_event")).toBe("merge request");
    expect(pipelineSourceWords("workflow_dispatch")).toBe("manual");
    expect(pipelineSourceWords("push")).toBe("push");
    expect(pipelineSourceWords("some_new_event")).toBe("some new event");
    expect(pipelineSourceWords(null)).toBeNull();
  });

  it("leads a GitHub run with its own title and moves the workflow under it", () => {
    expect(pipelineTitle("github", "ci · feat: add login")).toEqual({ workflow: "ci", title: "feat: add login" });
    expect(pipelineTitle("github", "nightly")).toEqual({ workflow: null, title: "nightly" });
    expect(pipelineTitle("gitlab", "Merge branch 'a · b'")).toEqual({ workflow: null, title: "Merge branch 'a · b'" });
    expect(pipelineTitle("github", null)).toEqual({ workflow: null, title: null });
  });

  it("badges a closed issue only when it was not done", () => {
    expect(issueClosedMark({ state: "closed", stateReason: "not_planned" })?.word).toBe("Not planned");
    expect(issueClosedMark({ state: "closed", stateReason: "duplicate" })?.word).toBe("Duplicate");
    expect(issueClosedMark({ state: "closed", stateReason: "completed" })).toBeNull();
    expect(issueClosedMark({ state: "open", stateReason: null })).toBeNull();
  });

  it("puts the default branch first and keeps the forge's order otherwise", () => {
    const b = (name: string, isDefault = false) => ({ name, isDefault });
    expect(defaultFirst([b("a"), b("main", true), b("c")]).map(x => x.name)).toEqual(["main", "a", "c"]);
    const already = [b("main", true), b("a")];
    expect(defaultFirst(already)).toBe(already);
    expect(defaultFirst([b("a")]).map(x => x.name)).toEqual(["a"]);
  });
});

describe("Create merge request ↗", () => {
  it("opens GitLab's new merge request form with the branch filled in", () => {
    expect(newChangeUrl("gitlab", { name: "feature/login", webUrl: "https://gitlab.example.com/acme/web/-/tree/feature/login" }))
      .toBe("https://gitlab.example.com/acme/web/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Flogin");
    expect(newChangeUrl("gitlab", { name: "fix/a b", webUrl: "https://gitlab.example.com/acme/web/-/tree/fix/a%20b" }))
      .toBe("https://gitlab.example.com/acme/web/-/merge_requests/new?merge_request%5Bsource_branch%5D=fix%2Fa%20b");
  });

  it("opens GitHub's compare page ready for a pull request", () => {
    expect(newChangeUrl("github", { name: "feature/login", webUrl: "https://github.com/acme/web/tree/feature/login" }))
      .toBe("https://github.com/acme/web/compare/feature/login?expand=1");
  });

  it("falls back to the branch's page when its address is not the shape the clients write", () => {
    const odd = { name: "feature/login", webUrl: "https://gitlab.example.com/acme/web/branches/feature/login" };
    expect(newChangeUrl("gitlab", odd)).toBe(odd.webUrl);
    const bare = { name: "x", webUrl: "/-/tree/x" };
    expect(newChangeUrl("gitlab", bare)).toBe(bare.webUrl);
  });
});

describe("what a list says", () => {
  it("is in one of five phases", () => {
    expect(listPhase({ data: null, error: null }, 0, 0)).toBe("loading");
    expect(listPhase({ data: null, error: { kind: "auth" } }, 0, 0)).toBe("failed");
    expect(listPhase({ data: {}, error: null }, 0, 0)).toBe("empty");
    expect(listPhase({ data: {}, error: null }, 5, 0)).toBe("no-match");
    expect(listPhase({ data: {}, error: { kind: "unreachable" } }, 5, 2)).toBe("rows");
  });

  it("says what the search hid, and how much is still to load", () => {
    expect(noMatchWords("branches", "  login ")).toBe("No branches match “login”.");
    expect(moreLabel(20, 56)).toBe("Load more · 20 of 56");
    expect(moreLabel(20, null)).toBe("Load more");
    expect(moreLabel(20, 20)).toBe("Load more");
  });

  it("says which merge request list is empty", () => {
    expect(emptyChangesWords("gitlab", { state: "open", filter: "all", acrossRepos: false })).toBe("No open merge requests in this project.");
    expect(emptyChangesWords("gitlab", { state: "merged", filter: "all", acrossRepos: true })).toBe("No merged merge requests.");
    expect(emptyChangesWords("github", { state: "open", filter: "mine", acrossRepos: false })).toBe("You have no open pull requests in this repository.");
    expect(emptyChangesWords("gitlab", { state: "open", filter: "review", acrossRepos: true })).toBe("Nothing is waiting for your review.");
    expect(emptyChangesWords("gitlab", { state: "closed", filter: "review", acrossRepos: true })).toBe("No closed merge requests asked for your review.");
  });

  it("says which pipeline and issue list is empty", () => {
    expect(emptyPipelinesWords("gitlab", false)).toBe("No pipelines in this project yet.");
    expect(emptyPipelinesWords("github", true)).toBe("No workflow runs in your most recently active repositories.");
    expect(emptyIssuesWords("gitlab", "open", true)).toBe("No open issues are assigned to you.");
    expect(emptyIssuesWords("gitlab", "closed", false)).toBe("No closed issues were assigned to you in this project.");
    expect(emptyIssuesWords("github", "open", false)).toBe("This repository has no open issues.");
  });
});

// ── drawn ────────────────────────────────────────────────────────────────

let scopeN = 0;

function ctx(kind: ForgeKind, over: Partial<ForgeContextValue> = {}): ForgeContextValue {
  return {
    kind,
    connection: { id: "c1", name: "Test", baseUrl: kind === "github" ? "https://github.com" : "https://gitlab.example.com" },
    scope: `${kind}:test-${++scopeN}`,
    api: async () => new Response("{}"),
    asset: () => null,
    refresh: 0,
    selected: null,
    select: () => {},
    isOpen: () => false,
    toggle: () => {},
    reportFreshness: () => {},
    onReconnect: () => {},
    narrow: false,
    ...over,
  };
}

/** Keeps an answer for a read, the way a loaded panel has it, so the first
 *  render draws it without asking. */
function keep<T>(c: ForgeContextValue, read: string, params: Record<string, string | undefined>, data: T) {
  keepRead(`${c.scope}\n${forgeReadPath(read, params)}`, { data, loadedAt: Date.now(), error: null });
}

function draw(c: ForgeContextValue, el: ReactElement): string {
  return renderToStaticMarkup(createElement(ForgeProvider, { value: c }, el));
}

const view = (over: Partial<ForgeView> = {}): ForgeView => ({ ...DEFAULT_VIEW, ...over });
const tab = (Tab: (p: { view: ForgeView; setView: (p: Partial<ForgeView>) => void; query: string }) => ReactElement | null, v: ForgeView, query = "") =>
  createElement(Tab, { view: v, setView: () => {}, query });

/** No button inside a button, and no link inside one: each control is its own. */
function noNestedControls(html: string): boolean {
  let open = 0;
  for (const m of html.matchAll(/<(\/?)(button|a)\b/g)) {
    if (m[1]) open--;
    else if (++open > 1) return false;
  }
  return true;
}

const page = <T,>(items: T[], next: string | null = null, total: number | null = items.length): Page<T> => ({ items, next, total });

function branch(name: string, over: Partial<ForgeBranch> = {}): ForgeBranch {
  return {
    name,
    webUrl: `https://gitlab.example.com/acme/web/-/tree/${name}`,
    isDefault: false,
    protected: false,
    commit: { sha: "a".repeat(40), shortSha: "aaaaaaaa", title: `work on ${name}`, committedAt: Date.now() - 3_600_000, authorName: "Alice", webUrl: null },
    ahead: 3,
    behind: 1,
    ci: null,
    change: null,
    stale: false,
    ...over,
  };
}

function change(number: number, over: Partial<ForgeChange> = {}): ForgeChange {
  return {
    kind: "gitlab", key: `acme/web!${number}`, number, repo: "acme/web", title: `Change ${number}`, titleHtml: null,
    state: "open", draft: false, webUrl: `https://gitlab.example.com/acme/web/-/merge_requests/${number}`,
    author: { login: "alice", name: "Alice", avatarUrl: null, webUrl: null }, assignees: [], reviewers: [],
    sourceBranch: `feature/${number}`, targetBranch: "main", createdAt: Date.now() - 7_200_000, updatedAt: Date.now() - 600_000,
    mergedAt: null, closedAt: null, comments: 0, unresolvedThreads: 0, approved: false, approvedByMe: false,
    approvalsRequired: null, approvalsLeft: null, ci: null, labels: [],
    ...over,
  };
}

describe("the Branches tab", () => {
  const c = ctx("gitlab");
  keep(c, "branches", { repo: "acme/web" }, page([
    branch("feature/login", { change: { number: 12, key: "acme/web!12", state: "open", draft: true, approved: false, webUrl: "https://gitlab.example.com/acme/web/-/merge_requests/12" }, ci: { state: "failed", webUrl: null } }),
    branch("main", { isDefault: true, protected: true, ahead: null, behind: null }),
    branch("feature/search", { ahead: 1200 }),
    branch("old/thing", { stale: true, ahead: null, behind: null }),
  ], "cursor-2", 56));
  const html = draw(c, tab(BranchesTab, view({ repo: "acme/web" })));

  it("lists the default branch first, marked default and protected", () => {
    expect(html.indexOf("main</code>")).toBeLessThan(html.indexOf("feature/login</code>"));
    expect(html).toContain(">default</span>");
    expect(html).toContain(">protected</span>");
  });

  it("folds the stale branches by default, with their count", () => {
    expect(html).toContain("Stale branches");
    expect(html).not.toContain("old/thing</code>");
    const opened = draw({ ...c, isOpen: g => g === "branches-stale" }, tab(BranchesTab, view({ repo: "acme/web" })));
    expect(opened).toContain("old/thing</code>");
  });

  it("shows the merge request's badge, or the way to create one", () => {
    expect(html).toContain("<code>!12</code> Draft");
    expect(html).toContain('href="https://gitlab.example.com/acme/web/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Fsearch"');
    expect(html).toMatch(/<a class="fg-open fgl-create" href="[^"]+" target="_blank" rel="noreferrer noopener">Create merge request/);
  });

  it("writes behind | ahead with GitLab's cap, and the pipeline as a mark and a word", () => {
    expect(html).toContain(">999+</span>");
    expect(html).toContain("1 commit behind, 999+ ahead of “main”");
    expect(html).toMatch(/data-tone="bad"[^>]*><span aria-hidden="true">✕<\/span><span class="fg-mark-word">failed<\/span>/);
  });

  it("keeps the copy button and the Create link out of the row's button", () => {
    expect(noNestedControls(html)).toBe(true);
    expect(html).toContain('aria-label="Copy branch name"');
  });

  it("marks the selected row, which is the branch's merge request when it has one", () => {
    const selected: ForgeSelection = { type: "change", repo: "acme/web", number: 12 };
    const sel = draw({ ...c, selected }, tab(BranchesTab, view({ repo: "acme/web" })));
    expect(sel).toMatch(/<li class="fgl-branch" data-selected="true"><button type="button" class="fgl-hit" aria-current="true" aria-label="feature\/login, merge request !12"/);
    expect(sel.match(/aria-current="true"/g)).toHaveLength(1);
  });

  it("says how many are loaded of how many", () => {
    expect(html).toContain("Load more · 4 of 56");
  });

  it("says when the search hides every branch", () => {
    expect(draw(c, tab(BranchesTab, view({ repo: "acme/web" }), "nothing-like-this"))).toContain("No branches match “nothing-like-this”.");
  });

  it("shows loading rows before the first answer", () => {
    expect(draw(ctx("gitlab"), tab(BranchesTab, view({ repo: "acme/web" })))).toContain('role="status" aria-label="Loading branches"');
  });
});

describe("the Merge requests tab", () => {
  it("names a change by !iid in one project and by its key across all of them", () => {
    const c = ctx("gitlab");
    keep(c, "changes", { repo: "acme/web", filter: "all", state: "open", sort: "created" }, page([change(5, { draft: true, title: "Draft: Add login" })]));
    keep(c, "changes", { repo: undefined, filter: "all", state: "open", sort: "created" }, page([change(5)]));
    const one = draw(c, tab(ChangesTab, view({ tab: "changes", repo: "acme/web" })));
    expect(one).toContain('<code>!5</code>');
    expect(one).toContain("◌</span> Draft</span><span class=\"fgl-title-text\">Add login</span>");
    const all = draw(c, tab(ChangesTab, view({ tab: "changes", repo: null })));
    expect(all).toContain('<code>acme/web!5</code>');
  });

  it("puts the forge's counts on Open / Merged / Closed and marks the chosen filter", () => {
    const c = ctx("gitlab");
    keep<ChangeCounts>(c, "change-counts", { repo: undefined, filter: "all" }, { open: 2, merged: null, closed: 1868 });
    keep(c, "changes", { repo: undefined, filter: "all", state: "open", sort: "created" }, page([change(1)]));
    const html = draw(c, tab(ChangesTab, view({ tab: "changes" })));
    expect(html).toContain('aria-pressed="true">Open<span class="fgl-seg-count">2</span>');
    expect(html).toContain('aria-pressed="false">Merged</button>');
    expect(html).toContain('<span class="fgl-seg-count">1,868</span>');
    expect(html).toContain('aria-pressed="true">All</button>');
  });

  it("splits review requests: waiting for me open, approved by me folded", () => {
    const c = ctx("gitlab");
    keep(c, "changes", { repo: undefined, filter: "review", state: "open", sort: "created" }, page([
      change(1, { title: "Needs me" }),
      change(2, { title: "Already approved", approvedByMe: true, approved: true }),
    ]));
    const html = draw(c, tab(ChangesTab, view({ tab: "changes", filter: "review" })));
    expect(html).toContain("Waiting for my review");
    expect(html).toContain("Needs me");
    expect(html).toContain("Approved by me");
    expect(html).not.toContain("Already approved");
  });

  it("draws the reviewers with how each stands, the comments and Approved", () => {
    const c = ctx("gitlab");
    keep(c, "changes", { repo: "acme/web", filter: "all", state: "open", sort: "created" }, page([change(3, {
      approved: true,
      comments: 4,
      reviewers: [{ login: "bob", name: "Bob", avatarUrl: null, webUrl: null, state: "approved" }],
    })]));
    const html = draw(c, tab(ChangesTab, view({ tab: "changes", repo: "acme/web" })));
    expect(html).toContain('title="Bob: approved"');
    // In words for a screen reader, since a plain span cannot carry a label.
    expect(html).toContain('<span class="fg-sr">Reviewer: </span>');
    expect(html).toContain('<span class="fg-sr">, approved</span>');
    expect(html).not.toMatch(/class="fgl-people"[^>]*aria-label/);
    expect(html).toContain("✓</span> Approved");
    expect(html).toContain('title="4 comments"');
    expect(noNestedControls(html)).toBe(true);
  });

  it("ends a merged row on when it was merged", () => {
    const c = ctx("gitlab");
    keep(c, "changes", { repo: "acme/web", filter: "all", state: "merged", sort: "created" }, page([change(4, { state: "merged", mergedAt: Date.now() - 60_000 })]));
    expect(draw(c, tab(ChangesTab, view({ tab: "changes", repo: "acme/web", state: "merged" })))).toContain("merged <time");
  });

  it("says Pull requests and # on GitHub", () => {
    const c = ctx("github");
    keep(c, "changes", { repo: "acme/web", filter: "all", state: "open", sort: "created" }, page([change(9, { kind: "github", key: "acme/web#9" })]));
    const html = draw(c, tab(ChangesTab, view({ tab: "changes", repo: "acme/web" })));
    expect(html).toContain('aria-label="Pull requests by state"');
    expect(html).toContain('<code>#9</code>');
  });
});

describe("the Pipelines tab", () => {
  const run = (id: string, over: Partial<ForgePipeline> = {}): ForgePipeline => ({
    id, repo: "acme/web", ref: "main", sha: "b".repeat(40), shortSha: "bbbbbbb", title: "ci · Add login", state: "success",
    source: "pull_request", triggeredBy: null, createdAt: Date.now() - 600_000, startedAt: Date.now() - 600_000,
    finishedAt: Date.now() - 300_000, durationSec: 192, webUrl: `https://github.com/acme/web/actions/runs/${id}`, ...over,
  });

  it("reads status, duration, run title, workflow and source; the project leads across projects", () => {
    const c = ctx("github");
    keep(c, "pipelines", { repo: undefined }, page([run("1"), run("2", { repo: "acme/api", state: "running", finishedAt: null, durationSec: null })]));
    const html = draw(c, tab(PipelinesTab, view({ tab: "pipelines" })));
    expect(html).toContain('<span class="fg-mark-word">passed</span>');
    expect(html).toContain("3m 12s");
    expect(html).toContain('<span class="fgl-title-text">Add login</span>');
    expect(html).toContain(" · ci · pull request");
    expect(html).toContain('<span class="fgl-repo-ref">acme/api</span> · ');
    expect(html).toContain("started <time");
  });

  it("says when nothing ran", () => {
    const c = ctx("gitlab");
    keep(c, "pipelines", { repo: "acme/web" }, page([]));
    expect(draw(c, tab(PipelinesTab, view({ tab: "pipelines", repo: "acme/web" })))).toContain("No pipelines in this project yet.");
  });
});

describe("the Issues tab", () => {
  const issue = (number: number, over: Partial<ForgeIssue> = {}): ForgeIssue => ({
    kind: "gitlab", key: `acme/web#${number}`, number, repo: "acme/web", title: `Issue ${number}`, titleHtml: null,
    state: "open", stateReason: null, webUrl: `https://gitlab.example.com/acme/web/-/issues/${number}`,
    author: { login: "alice", name: "Alice", avatarUrl: null, webUrl: null }, assignees: [], labels: [], milestone: null,
    createdAt: Date.now() - 86_400_000, updatedAt: Date.now() - 3_600_000, closedAt: null, comments: 0, children: null, parent: null,
    ...over,
  });

  it("is the issues assigned to the user on GitLab, labels and child items drawn", () => {
    const c = ctx("gitlab");
    keep(c, "issues", { repo: undefined, state: "open" }, page([issue(7, {
      labels: [{ name: "bug", color: "#d73a4a" }, { name: "evil", color: "red;x" }],
      children: { total: 5, completed: 2 },
      assignees: ["bob", "carol", "dave", "erin"].map(login => ({ login, name: login, avatarUrl: null, webUrl: null })),
    })]));
    const html = draw(c, tab(IssuesTab, view({ tab: "issues" })));
    expect(html).toContain("Assigned to you");
    expect(html).toContain('<code>acme/web#7</code>');
    expect(html).toContain('style="background:#d73a4a"');
    expect(html).not.toContain("red;x\"");
    expect(html).toContain("2/5");
    // Three faces, then +1 — and the same list in words.
    expect(html).toContain('<span class="fg-sr">Assigned to: </span>');
    expect(html).toContain('<span class="fgl-people-more" aria-hidden="true">+1</span><span class="fg-sr"> and 1 more</span>');
    expect(html).not.toMatch(/class="fgl-people"[^>]*aria-label/);
  });

  it("badges an issue GitHub closed as not planned", () => {
    const c = ctx("github");
    keep(c, "issues", { repo: "acme/web", state: "closed" }, page([issue(3, { kind: "github", state: "closed", stateReason: "not_planned", closedAt: Date.now() - 1000 })]));
    const html = draw(c, tab(IssuesTab, view({ tab: "issues", repo: "acme/web", issueState: "closed" })));
    expect(html).toContain("Not planned");
    expect(html).toContain("closed <time");
    expect(html).not.toContain("Assigned to you");
  });
});

describe("the project picker", () => {
  const pick = (kind: ForgeKind, value: string | null, allowAll: boolean) =>
    draw(ctx(kind), createElement(RepoPicker, { value, allowAll, onChange: () => {} }));

  it("names the current project with its group quiet and its own name last", () => {
    const html = pick("gitlab", "acme/tools/web", true);
    expect(html).toContain('<span class="fgl-repo-group">acme/tools/</span><span class="fgl-repo-name">web</span>');
    expect(html).toContain('aria-label="Project: acme/tools/web"');
    expect(html).toContain('aria-haspopup="dialog" aria-expanded="false"');
  });

  it("says All where the tab reads across projects, and asks for one where it cannot", () => {
    expect(pick("gitlab", null, true)).toContain(">All projects<");
    expect(pick("github", null, true)).toContain(">All repositories<");
    expect(pick("github", null, false)).toContain(">Choose a repository<");
  });
});
