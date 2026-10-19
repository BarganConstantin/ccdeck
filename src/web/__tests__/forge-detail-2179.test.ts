// #2179: the GitHub and GitLab panels' item pages — a merge request or pull
// request, a branch, a pipeline, an issue — and the rules under them in
// forge-detail.ts.
//
// What these pin: how a change is referred to and how a pipeline's ref names
// the change it ran for; the forge's "new merge request" address; a draft's
// title said once (the badge), not twice; the merge request page's three
// discussion groups; a path drawn as folder and file; the approvals line;
// each changed file's and label's words; issue and pipeline-source words;
// jobs grouped by stage in run order, a stage's state summed the way GitLab
// sums it, which stages and jobs start open; how a log tail grows; and, drawn
// from kept answers with no network, what each page shows: the header, the
// sections with their counts, the groups, Close only on a wide window, the
// "Create merge request" link, comments behind a button, and a sentence for an
// item that is gone. Every name in here is invented.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  BranchDetail, ChangeDetail, ForgeComment, ForgeErrorInfo, ForgeJob, ForgeUser, IssueDetail, PipelineDetail, ReviewThread,
} from "../forge-types";
import { forgeReadPath, keepRead } from "../forge-panel";
import {
  annotationMark, approvalWords, changeFromRef, changeReference, changeSections, changeStateMark, fileStatusWord,
  issueMark, jobStartsOpen, labelColor, labelParts, logLineTone, MANY_JOBS, namesWords, newChangeUrl, nextLogLines,
  nodesWithoutDraftPrefix, pathParts, pipelineIdFromUrl, shortRef, sourceWords, splitDiscussions, stagesOf, stageStartsOpen,
  stageState, threadPlace, withoutDraftPrefix,
} from "../forge-detail";
import { ForgeProvider, type ForgeContextValue, type ForgeSelection } from "../components/forge/ForgeContext";
import ChangeDetailPage from "../components/forge/ChangeDetail";
import BranchDetailPage from "../components/forge/BranchDetail";
import PipelineDetailPage from "../components/forge/PipelineDetail";
import IssueDetailPage from "../components/forge/IssueDetail";

// ── data ────────────────────────────────────────────────────────────────

const alice: ForgeUser = { login: "alice", name: "Alice Doe", avatarUrl: null, webUrl: null };
const bob: ForgeUser = { login: "bob", name: null, avatarUrl: null, webUrl: null };
const carol: ForgeUser = { login: "carol", name: "Carol Roe", avatarUrl: null, webUrl: null };

function comment(id: string, at: number, author: ForgeUser | null = alice): ForgeComment {
  return { id, author, bodyHtml: "", createdAt: at, webUrl: `https://gitlab.example.com/acme/web/-/merge_requests/12#note_${id}` };
}

function thread(id: string, over: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id, resolvable: true, resolved: false, path: "src/app/login.ts", line: 42, outdated: false,
    comments: [comment(`${id}-1`, 1_000)], webUrl: null, ...over,
  };
}

function job(id: string, over: Partial<ForgeJob> = {}): ForgeJob {
  return {
    id, name: `job-${id}`, stage: "test", state: "success", allowFailure: false, startedAt: null, finishedAt: null,
    durationSec: 30, webUrl: `https://gitlab.example.com/acme/web/-/jobs/${id}`, failureReason: null, annotations: [],
    logAvailable: true, ...over,
  };
}

function change(over: Partial<ChangeDetail> = {}): ChangeDetail {
  return {
    kind: "gitlab", key: "acme/web!12", number: 12, repo: "acme/web", title: "Draft: Add the login page", titleHtml: null,
    state: "open", draft: true, webUrl: "https://gitlab.example.com/acme/web/-/merge_requests/12", author: alice,
    assignees: [alice], reviewers: [{ ...bob, state: "approved" }], sourceBranch: "feature/login", targetBranch: "main",
    createdAt: Date.now() - 3_600_000, updatedAt: null, mergedAt: null, closedAt: null, comments: 3, unresolvedThreads: 1,
    approved: false, approvedByMe: false, approvalsRequired: null, approvalsLeft: null,
    ci: { state: "failed", webUrl: "https://gitlab.example.com/acme/web/-/pipelines/901" },
    labels: [{ name: "priority::high", color: "#cc3333" }], descriptionHtml: "", milestone: { title: "v2", webUrl: null },
    participants: [alice, bob], approvedBy: [], counts: { discussions: 3, commits: 4, pipelines: 2, files: 7 },
    threads: [thread("t1"), thread("t2", { resolved: true })], generalComments: [comment("g1", 500, carol)], ...over,
  };
}

// ── rules ───────────────────────────────────────────────────────────────

describe("references", () => {
  it("writes a change the way its forge does", () => {
    expect(changeReference("gitlab", "acme/web", 12)).toBe("acme/web!12");
    expect(changeReference("github", "acme/web", 12)).toBe("acme/web#12");
  });

  it("reads the change a pipeline ran for from its ref, and nothing from a branch", () => {
    expect(changeFromRef("refs/merge-requests/4951/head")).toBe(4951);
    expect(changeFromRef("refs/merge-requests/7/merge")).toBe(7);
    expect(changeFromRef("refs/pull/33/merge")).toBe(33);
    expect(changeFromRef("feature/login")).toBeNull();
    expect(changeFromRef("refs/merge-requests/12/other")).toBeNull();
    expect(changeFromRef(null)).toBeNull();
  });

  it("shortens a ref to what a person reads", () => {
    expect(shortRef("gitlab", "refs/merge-requests/12/head")).toBe("!12");
    expect(shortRef("github", "refs/pull/12/merge")).toBe("#12");
    expect(shortRef("gitlab", "refs/heads/feature/login")).toBe("feature/login");
    expect(shortRef("gitlab", "refs/tags/v1.2.0")).toBe("v1.2.0");
    expect(shortRef("github", "main")).toBe("main");
  });

  it("takes a pipeline's id from its page, and none from a pull request's checks page", () => {
    expect(pipelineIdFromUrl("https://gitlab.example.com/acme/web/-/pipelines/901")).toBe("901");
    expect(pipelineIdFromUrl("https://github.com/acme/web/actions/runs/39282049013/job/1")).toBe("39282049013");
    expect(pipelineIdFromUrl("https://github.com/acme/web/pull/12/checks")).toBeNull();
    expect(pipelineIdFromUrl(null)).toBeNull();
  });

  it("sends a branch without a change to the forge's own new-change page", () => {
    expect(newChangeUrl("gitlab", "https://gitlab.example.com/", "acme/web", "feature/login"))
      .toBe("https://gitlab.example.com/acme/web/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Flogin");
    expect(newChangeUrl("gitlab", "https://example.com/gitlab", "acme/web", "fix #1"))
      .toBe("https://example.com/gitlab/acme/web/-/merge_requests/new?merge_request%5Bsource_branch%5D=fix+%231");
    expect(newChangeUrl("github", "https://github.com", "acme/web", "feature/log in"))
      .toBe("https://github.com/acme/web/compare/feature/log%20in?expand=1");
  });
});

describe("a change's head", () => {
  it("says Draft once — in the badge, not again in the title", () => {
    expect(withoutDraftPrefix("Draft: Add the login page")).toBe("Add the login page");
    expect(withoutDraftPrefix("[Draft] Add it")).toBe("Add it");
    expect(withoutDraftPrefix("(draft) Add it")).toBe("Add it");
    expect(withoutDraftPrefix("Drafting the login page")).toBe("Drafting the login page");
    expect(withoutDraftPrefix("Draft:")).toBe("Draft:");
    expect(nodesWithoutDraftPrefix([{ t: "text", text: "Draft: " }, { t: "link", href: "https://x.example", title: null, kids: [] }]))
      .toEqual([{ t: "link", href: "https://x.example", title: null, kids: [] }]);
    const linked = [{ t: "link" as const, href: "https://x.example", title: null, kids: [{ t: "text" as const, text: "Draft: x" }] }];
    expect(nodesWithoutDraftPrefix(linked)).toBe(linked);
  });

  it("keeps approval out of the state badge, because it has its own line", () => {
    expect(changeStateMark({ state: "open", draft: false }).word).toBe("Open");
    expect(changeStateMark({ state: "open", draft: true }).word).toBe("Draft");
    expect(changeStateMark({ state: "merged", draft: false }).word).toBe("Merged");
    expect(changeStateMark({ state: "closed", draft: true }).word).toBe("Closed");
  });

  it("names who approved it, or how many approvals are still needed", () => {
    expect(approvalWords({ approvedBy: [alice, bob, carol], approvalsLeft: 0 })?.text).toBe("Approved by Alice Doe, bob and Carol Roe");
    expect(approvalWords({ approvedBy: [], approvalsLeft: 1 })?.text).toBe("Requires 1 more approval");
    expect(approvalWords({ approvedBy: [], approvalsLeft: 2 })?.text).toBe("Requires 2 more approvals");
    expect(approvalWords({ approvedBy: [], approvalsLeft: null })).toBeNull();
    expect(namesWords([])).toBe("");
    expect(namesWords(["Alice"])).toBe("Alice");
  });

  it("has the forge's own tab names, each with its count", () => {
    const counts = { discussions: 3, commits: 4, pipelines: 2, files: 7 };
    expect(changeSections("gitlab", counts).map(s => `${s.label} ${s.count}`)).toEqual(["Overview 3", "Commits 4", "Pipelines 2", "Changes 7"]);
    expect(changeSections("github", counts).map(s => s.label)).toEqual(["Conversation", "Commits", "Actions", "Files changed"]);
  });
});

describe("discussions", () => {
  it("splits them the way the merge request page does", () => {
    const d = splitDiscussions({
      threads: [
        thread("open"),
        thread("done", { resolved: true }),
        thread("note", { resolvable: false, path: null, line: null, comments: [comment("n", 300)] }),
        thread("empty", { comments: [] }),
      ],
      generalComments: [comment("late", 900), comment("early", 100)],
    });
    expect(d.unresolved.map(t => t.id)).toEqual(["open"]);
    expect(d.resolved.map(t => t.id)).toEqual(["done"]);
    // Oldest first, a plain comment drawn as a thread of one.
    expect(d.general.map(t => t.id)).toEqual(["comment:early", "note", "comment:late"]);
    expect(d.general[0]).toMatchObject({ path: null, resolvable: false, comments: [{ id: "early" }] });
  });

  it("says where a thread is as folder, file and line", () => {
    expect(pathParts("src/app/login.ts")).toEqual({ dir: "src/app/", name: "login.ts" });
    expect(pathParts("README.md")).toEqual({ dir: "", name: "README.md" });
    expect(threadPlace({ path: "src/app/login.ts", line: 42 })).toBe("src/app/login.ts:42");
    expect(threadPlace({ path: "src/app/login.ts", line: null })).toBe("src/app/login.ts");
    expect(threadPlace({ path: null, line: 3 })).toBeNull();
  });
});

describe("words", () => {
  it("gives a changed file a word only when it is not a plain edit", () => {
    expect(fileStatusWord("added")).toBe("new");
    expect(fileStatusWord("deleted")).toBe("deleted");
    expect(fileStatusWord("renamed")).toBe("renamed");
    expect(fileStatusWord("modified")).toBeNull();
  });

  it("splits a scoped label and keeps only a real colour", () => {
    expect(labelParts("priority::high")).toEqual({ scope: "priority", value: "high" });
    expect(labelParts("team::web::ui")).toEqual({ scope: "team::web", value: "ui" });
    expect(labelParts("bug")).toEqual({ scope: null, value: "bug" });
    expect(labelParts("::odd")).toEqual({ scope: null, value: "::odd" });
    expect(labelColor("#a2eeef")).toBe("#a2eeef");
    expect(labelColor("#fff")).toBe("#fff");
    expect(labelColor("red; background: url(x)")).toBeNull();
    expect(labelColor(null)).toBeNull();
  });

  it("marks an issue's state with GitHub's reason when it gives one", () => {
    expect(issueMark("open")).toMatchObject({ word: "Open", tone: "busy" });
    expect(issueMark("closed", "completed").word).toBe("Closed");
    expect(issueMark("closed", "not_planned").word).toBe("Closed · not planned");
    expect(issueMark("closed", "duplicate").word).toBe("Closed · duplicate");
  });

  it("says what started a pipeline", () => {
    expect(sourceWords("merge_request_event")).toBe("merge request");
    expect(sourceWords("workflow_dispatch")).toBe("manual run");
    expect(sourceWords("some_new_source")).toBe("some new source");
    expect(sourceWords(null)).toBeNull();
  });

  it("gives every annotation level a mark and a word", () => {
    for (const level of ["failure", "warning", "notice"] as const) {
      const m = annotationMark(level);
      expect(m.mark).not.toBe("");
      expect(m.word).toBe(level);
    }
  });
});

describe("jobs", () => {
  it("groups jobs by stage in the order the pipeline runs them", () => {
    const stages = stagesOf([
      job("1", { stage: "build" }), job("2", { stage: "test" }), job("3", { stage: "build" }), job("4", { stage: "deploy" }),
    ]);
    expect(stages.map(s => `${s.name}:${s.jobs.map(j => j.id).join(",")}`)).toEqual(["build:1,3", "test:2", "deploy:4"]);
    expect(stagesOf([job("1", { stage: null }), job("2", { stage: null })]).map(s => s.name)).toEqual([null]);
  });

  it("sums a stage the way GitLab does", () => {
    expect(stageState([job("1"), job("2", { state: "failed" })])).toBe("failed");
    expect(stageState([job("1"), job("2", { state: "failed", allowFailure: true })])).toBe("success");
    expect(stageState([job("1", { state: "running" }), job("2", { state: "pending" })])).toBe("running");
    expect(stageState([job("1", { state: "skipped" })])).toBe("skipped");
    expect(stageState([job("1", { state: "manual" }), job("2", { state: "skipped" })])).toBe("manual");
    expect(stageState([job("1"), job("2", { state: "canceled" })])).toBe("canceled");
    expect(stageState([])).toBe("none");
  });

  it("opens a failed stage always, and every stage of a short pipeline", () => {
    const failed = { name: "build", jobs: [], state: "failed" as const };
    const quiet = { name: "deploy", jobs: [], state: "canceled" as const };
    expect(stageStartsOpen(failed, 40)).toBe(true);
    expect(stageStartsOpen(quiet, MANY_JOBS)).toBe(true);
    expect(stageStartsOpen(quiet, MANY_JOBS + 1)).toBe(false);
  });

  it("opens a job with its reason and log only when its failure counts", () => {
    expect(jobStartsOpen(job("1", { state: "failed" }))).toBe(true);
    expect(jobStartsOpen(job("1", { state: "failed", allowFailure: true }))).toBe(false);
    expect(jobStartsOpen(job("1", { state: "canceled" }))).toBe(false);
  });

  it("grows a log tail 80, 200, 500 and then stops", () => {
    expect(nextLogLines(null)).toBe(80);
    expect(nextLogLines(80)).toBe(200);
    expect(nextLogLines(200)).toBe(500);
    expect(nextLogLines(500)).toBeNull();
  });

  it("picks out the lines that say what went wrong", () => {
    expect(logLineTone("ERROR: Job failed: exit status 1")).toBe("err");
    expect(logLineTone("error Command failed with exit code 1.")).toBe("err");
    expect(logLineTone("::error::the suite did not run")).toBe("err");
    expect(logLineTone("warning: deprecated option")).toBe("warn");
    expect(logLineTone("errors: 0")).toBeNull();
    expect(logLineTone("Running after_script")).toBeNull();
  });
});

// ── pages, drawn from kept answers ───────────────────────────────────────

const SCOPE = "gitlab:test";

function keep(read: string, params: Record<string, string | number>, data: unknown, error: ForgeErrorInfo | null = null) {
  keepRead(`${SCOPE}\n${forgeReadPath(read, params)}`, { data, loadedAt: data ? Date.now() : null, error });
}

function page(node: ReactNode, over: Partial<ForgeContextValue> = {}): string {
  const value: ForgeContextValue = {
    kind: "gitlab",
    connection: { id: "test", name: "Test", baseUrl: "https://gitlab.example.com" },
    scope: SCOPE,
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
  return renderToStaticMarkup(createElement(ForgeProvider, { value, children: node }));
}

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

// The pages reset the pane's scroll and pin a log to its end before paint
// (useLayoutEffect); a server render cannot, and React says so once per page.
// That one warning is expected here and nothing else is hidden.
const consoleError = console.error;
beforeAll(() => {
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].includes("useLayoutEffect does nothing on the server")) return;
    consoleError(...args);
  });
});
afterAll(() => vi.restoreAllMocks());

describe("the change page", () => {
  const sel: Extract<ForgeSelection, { type: "change" }> = { type: "change", repo: "acme/web", number: 12 };

  it("draws the merge request page's head, side column, sections and discussions", () => {
    keep("change", { repo: "acme/web", number: 12 }, change());
    const html = page(createElement(ChangeDetailPage, { selection: sel }));
    const words = text(html);
    expect(words).toContain("acme/web!12");
    expect(words).toContain("Add the login page");
    expect(words).not.toContain("Draft: Add");
    expect(words).toContain("Draft");
    expect(words).toMatch(/Alice Doe requested to merge feature\/login .*into main/);
    // The pipeline line reads its id from the ci address and links inside the panel.
    expect(words).toContain("failed Pipeline #901");
    expect(words).toMatch(/Overview 3 Commits 4 Pipelines 2 Changes 7/);
    expect(words).toContain("Unresolved threads 1");
    expect(words).toContain("Resolved threads 1");
    expect(words).toContain("General comments 1");
    expect(words).toContain("src/ app/ login.ts :42");
    // A long path wraps between folders, never inside one.
    expect(html).toContain("src/<wbr/>");
    expect(html).toContain("app/<wbr/>");
    expect(words).toContain("approved");
    expect(words).toMatch(/priority\s+high/);
    expect(html).toContain('aria-label="Close details"');
    expect(html).toContain('aria-selected="true"');
  });

  it("leaves Close to the host's Back on a narrow window", () => {
    keep("change", { repo: "acme/web", number: 12 }, change());
    expect(page(createElement(ChangeDetailPage, { selection: sel }), { narrow: true })).not.toContain('aria-label="Close details"');
  });

  it("can take focus, for when the row that opened it is out of sight", () => {
    keep("change", { repo: "acme/web", number: 12 }, change());
    expect(page(createElement(ChangeDetailPage, { selection: sel }), { narrow: true })).toMatch(/<article class="fd"[^>]*tabindex="-1"/);
  });

  it("says all threads are resolved, and says so with a mark and a word", () => {
    keep("change", { repo: "acme/web", number: 13 }, change({ number: 13, key: "acme/web!13", threads: [thread("t", { resolved: true })], generalComments: [] }));
    const words = text(page(createElement(ChangeDetailPage, { selection: { ...sel, number: 13 } })));
    expect(words).toContain("All threads resolved");
    expect(words).not.toContain("Unresolved threads");
  });

  it("says when the change is gone rather than drawing an empty page", () => {
    keep("change", { repo: "acme/web", number: 404 }, null, { kind: "not-found", message: "gone" });
    const words = text(page(createElement(ChangeDetailPage, { selection: { ...sel, number: 404 } })));
    expect(words).toContain("This merge request no longer exists, or this token cannot see it.");
    expect(words).toContain("acme/web!404");
  });
});

describe("the pipeline page", () => {
  it("draws jobs by stage, a failed job open with its reason and a log button", () => {
    const p: PipelineDetail = {
      id: "901", repo: "acme/web", ref: "refs/merge-requests/12/head", sha: "a".repeat(40), shortSha: "aaaaaaaa",
      title: "Add the login page", state: "failed", source: "merge_request_event", triggeredBy: alice,
      createdAt: Date.now() - 60_000, startedAt: null, finishedAt: null, durationSec: 125, webUrl: "https://gitlab.example.com/acme/web/-/pipelines/901",
      jobs: [
        job("1", { stage: "build", name: "compile" }),
        job("2", { stage: "test", name: "unit", state: "failed", failureReason: "Script failure",
          annotations: [{ path: "src/app/login.ts", line: 7, level: "failure", title: null, message: "expected 2" }] }),
        job("3", { stage: "test", name: "lint", state: "failed", allowFailure: true }),
      ],
    };
    keep("pipeline", { repo: "acme/web", id: "901" }, p);
    const words = text(page(createElement(PipelineDetailPage, { selection: { type: "pipeline", repo: "acme/web", id: "901" } })));
    expect(words).toContain("Add the login page");
    expect(words).toContain("took 2m 05s");
    expect(words).toContain("merge request");
    expect(words).toContain("Merge request !12");
    expect(words).toMatch(/build 1 .*passed/);
    expect(words).toContain("Script failure");
    expect(words).toContain("src/app/login.ts:7");
    expect(words).toContain("expected 2");
    expect(words).toContain("allowed to fail");
    expect(words).toContain("Show log");
  });
});

describe("the branch page", () => {
  it("offers the forge's Create merge request when the branch has no change", () => {
    const d: BranchDetail = {
      branch: {
        name: "feature/login", webUrl: "https://gitlab.example.com/acme/web/-/tree/feature/login", isDefault: false, protected: false,
        commit: { sha: "b".repeat(40), shortSha: "bbbbbbbb", title: "Add the form", committedAt: Date.now(), authorName: "Alice Doe", webUrl: null },
        ahead: 2, behind: 1500, ci: null, change: null, stale: false,
      },
      pipeline: null,
      commitsAhead: [{ sha: "c".repeat(40), shortSha: "cccccccc", title: "Add the form", authorName: "Alice Doe", authoredAt: null, webUrl: null }],
    };
    keep("branch", { repo: "acme/web", name: "feature/login" }, d);
    const html = page(createElement(BranchDetailPage, { selection: { type: "branch", repo: "acme/web", name: "feature/login" } }));
    const words = text(html);
    expect(words).toContain("999+ behind");
    expect(words).toContain("2 ahead");
    expect(words).toContain("no pipeline");
    expect(words).toContain("Create merge request");
    expect(html).toContain("merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Flogin");
    expect(html).toContain('rel="noreferrer noopener"');
  });
});

describe("the issue page", () => {
  it("keeps the comments behind a button until they are asked for", () => {
    const issue: IssueDetail = {
      kind: "gitlab", key: "acme/web#7", number: 7, repo: "acme/web", title: "Login fails on Safari", titleHtml: null,
      state: "closed", stateReason: null, webUrl: "https://gitlab.example.com/acme/web/-/issues/7", author: bob, assignees: [alice],
      labels: [{ name: "bug", color: "#d73a4a" }], milestone: null, createdAt: Date.now() - 86_400_000, updatedAt: null, closedAt: Date.now(),
      comments: 3, children: { total: 2, completed: 1 }, parent: null, descriptionHtml: "",
      childItems: [{ key: "acme/web#8", number: 8, repo: "acme/web", title: "Reproduce it", state: "closed", webUrl: "", type: "Task" }],
    };
    keep("issue", { repo: "acme/web", number: 7 }, issue);
    const words = text(page(createElement(IssueDetailPage, { selection: { type: "issue", repo: "acme/web", number: 7 } })));
    expect(words).toContain("Login fails on Safari");
    expect(words).toContain("Closed");
    expect(words).toContain("No description.");
    expect(words).toContain("1 of 2 done");
    expect(words).toContain("Reproduce it");
    expect(words).toContain("Show 3 comments");
    expect(words).not.toContain("Loading comments");
  });
});
