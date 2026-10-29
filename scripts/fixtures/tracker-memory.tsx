// Synthetic data only. Render the actual detail components and use their real
// read/cache hooks, without contacting a deck or a tracker.
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import JiraIssueDetail from "../../src/web/components/JiraIssueDetail";
import IssueDetail from "../../src/web/components/forge/IssueDetail";
import IssuesTab from "../../src/web/components/forge/IssuesTab";
import { JobStages } from "../../src/web/components/forge/DetailJobs";
import JiraBacklog from "../../src/web/components/JiraBacklog";
import { useJiraBoard } from "../../src/web/use-jira-board";
import { DEFAULT_VIEW } from "../../src/web/forge-panel";
import { ForgeProvider, type ForgeContextValue } from "../../src/web/components/forge/ForgeContext";
import type { JiraIssueDetail as JiraDetail, JiraBoardOverview } from "../../src/web/jira-api";
import type { IssueDetail as ForgeDetail } from "../../src/web/forge-types";
import type { IntegrationConnection } from "../../src/web/integrations/types";

const noop = () => {};
const conn = { id: "memory-fixture", name: "Synthetic tracker", kind: "jira", baseUrl: "https://tracker.example" } as IntegrationConnection;
let requests = 0;
let root = createRoot(document.getElementById("root")!);

// Distinct, deterministic 64 KiB descriptions; fixtures are generated per
// request rather than held in a second, unbounded test-side database.
function description(id: number) {
  let x = id + 1;
  const chars: string[] = [];
  for (let i = 0; i < 65536; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) | 0;
    chars.push(String.fromCharCode(97 + ((x >>> 16) % 26)));
  }
  return `<p>${chars.join("")}</p>`;
}

function jiraDetail(id: number, withDescription = true): JiraDetail {
  return {
    issue: {
      id: String(id), key: `MOCK-${id}`, summary: `Synthetic issue ${id}`, url: `https://tracker.example/MOCK-${id}`,
      type: { name: "Task", icon: null, subtask: false, epic: false }, status: { name: "To Do", category: "new" },
      priority: null, assignee: null, mine: false, parent: null, subtaskKeys: [], epic: null, fixVersions: [],
      estimate: null, remaining: null, points: null, flagged: false, updated: "2026-01-01T00:00:00Z",
      project: { key: "MOCK", name: "Synthetic project", avatar: null }, reporter: null, labels: [], components: [],
      dueDate: null, created: "2026-01-01T00:00:00Z", resolution: null, timeSpent: null, sprint: null,
      descriptionHtml: withDescription ? description(id) : "",
    },
    comments: { total: 0, items: [] }, attachments: [], subtasks: [],
  };
}

function forgeDetail(id: number, withDescription = true): ForgeDetail {
  return {
    kind: "gitlab", key: `synthetic/project#${id}`, repo: "synthetic/project", number: id,
    title: `Synthetic issue ${id}`, titleHtml: null, state: "open", stateReason: null,
    webUrl: `https://tracker.example/issues/${id}`, author: null, assignees: [], labels: [], milestone: null,
    createdAt: null, updatedAt: null, closedAt: null, comments: 0, children: null, parent: null,
    descriptionHtml: withDescription ? description(id) : "", childItems: [],
  };
}

const jiraApi = async (path: string, init?: RequestInit) => {
  if (init?.method && init.method !== "GET") throw new Error("Writes are forbidden in the fixture");
  const match = /^issue\/MOCK-(\d+)$/.exec(path);
  if (!match) throw new Error(`Unexpected Jira read: ${path}`);
  requests++;
  return Response.json(jiraDetail(Number(match[1])));
};
const forgeApi = async (path: string, init?: RequestInit) => {
  if (init?.method && init.method !== "GET") throw new Error("Writes are forbidden in the fixture");
  const url = new URL(path, "https://tracker.example");
  if (url.pathname === "/issues") {
    requests++;
    const project = Number(url.searchParams.get("repo"));
    const start = Number(url.searchParams.get("cursor") ?? 0);
    return Response.json({ ok: true, data: {
      items: Array.from({ length: 250 }, (_, n) => {
        const { descriptionHtml, childItems, ...issue } = forgeDetail(project * 1000 + start + n, false);
        return issue;
      }), next: start === 0 ? "250" : null, total: 500,
    } });
  }
  if (url.pathname === "/job-log") {
    requests++;
    const count = Number(url.searchParams.get("lines"));
    const id = url.searchParams.get("id");
    return Response.json({ ok: true, data: {
      lines: Array.from({ length: count }, (_, n) => `Job ${id} line ${n}: ${"synthetic log ".repeat(10)}`),
      truncated: true, webUrl: "https://tracker.example/full-log",
    } });
  }
  if (url.pathname !== "/issue") throw new Error(`Unexpected forge read: ${path}`);
  requests++;
  return Response.json({ ok: true, data: forgeDetail(Number(url.searchParams.get("number"))) });
};

const context: ForgeContextValue = {
  kind: "gitlab", connection: conn, scope: "gitlab:memory-fixture", api: forgeApi, asset: () => null,
  refresh: 0, selected: null, select: noop, isOpen: () => false, toggle: noop, reportFreshness: noop,
  onReconnect: noop, narrow: false, listKey: "synthetic", reportRows: noop, recallSection: () => null, keepSection: noop,
};

const boardApi = async (path: string, init?: RequestInit) => {
  if (init?.method && init.method !== "GET") throw new Error("Writes are forbidden in the fixture");
  const url = new URL(path, "https://tracker.example");
  const match = /^\/board\/(\d+)(\/issues)?$/.exec(url.pathname);
  if (!match) throw new Error(`Unexpected board read: ${path}`);
  requests++;
  const id = Number(match[1]);
  if (match[2]) return Response.json({
    issues: Array.from({ length: 1000 }, (_, n) => jiraDetail(id * 1000 + n, false).issue),
    next: "", total: 1000, capped: false,
  });
  const overview: JiraBoardOverview = {
    board: { id, name: `Board ${id}`, type: "scrum", projectKey: "MOCK", projectName: "Synthetic project" },
    estimation: { kind: "count", fieldId: null, label: "Issues" }, quickFilters: [],
    sprints: { active: [{ id, name: `Sprint ${id}`, state: "active", startDate: null, endDate: null, completeDate: null, goal: "" }], future: [] },
    hasSprints: true, hasBacklog: false, timeTracking: { hoursPerDay: 8, daysPerWeek: 5 },
  };
  return Response.json(overview);
};

function LargeJiraBoard({ id }: { id: number }) {
  const board = useJiraBoard(boardApi, conn.id, String(id), { mine: false, quick: [] });
  if (!board.snap.overview) return null;
  return <JiraBacklog conn={conn} overview={board.snap.overview} groups={board.groups} snap={board.snap}
    expanded={{}} onToggleGroup={noop} filter={{ search: "", hideDone: false }} mine={false} filtered={false}
    selected={null} onOpen={noop} rowsOpen={{}} onToggleRow={noop} onRetryGroup={noop} onMore={noop}
    onShowClosed={noop} onMoreClosed={noop} loadSubtasks={noop} onReconnect={noop} />;
}

function surface(kind: string, id: number) {
  if (kind === "jira-board") return <LargeJiraBoard id={id} />;
  if (kind === "forge-list") return <ForgeProvider value={context}>
    <IssuesTab view={{ ...DEFAULT_VIEW, tab: "issues", repo: String(id) }} setView={noop} query="" />
  </ForgeProvider>;
  if (kind === "job-log") return <ForgeProvider value={context}><JobStages key={id} repo="synthetic/project" jobs={[{
    id: String(id), name: `Job ${id}`, stage: null, state: "failed", allowFailure: false,
    startedAt: null, finishedAt: null, durationSec: null, webUrl: null, failureReason: null, annotations: [], logAvailable: true,
  }]} /></ForgeProvider>;
  return kind === "jira"
    ? <JiraIssueDetail conn={conn} api={jiraApi} assetUrl={url => url} trail={[`MOCK-${id}`]}
        estimation="count" time={{ hoursPerDay: 8, daysPerWeek: 5 }} onOpen={noop} onTrail={noop}
        onReconnect={noop} narrow={false} onClose={noop} />
    : <ForgeProvider value={context}><IssueDetail selection={{ type: "issue", repo: "synthetic/project", number: id }} /></ForgeProvider>;
}

Object.assign(window, {
  trackerMemory: {
    show(kind: string, id: number) {
      flushSync(() => root.render(surface(kind, id)));
    },
    close() { flushSync(() => root.unmount()); root = createRoot(document.getElementById("root")!); },
    requests: () => requests,
  },
});
