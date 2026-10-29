// Synthetic data only. Render the actual detail components and use their real
// read/cache hooks, without contacting a deck or a tracker.
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import JiraIssueDetail from "../../src/web/components/JiraIssueDetail";
import IssueDetail from "../../src/web/components/forge/IssueDetail";
import { ForgeProvider, type ForgeContextValue } from "../../src/web/components/forge/ForgeContext";
import type { JiraIssueDetail as JiraDetail } from "../../src/web/jira-api";
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

function jiraDetail(id: number): JiraDetail {
  return {
    issue: {
      id: String(id), key: `MOCK-${id}`, summary: `Synthetic issue ${id}`, url: `https://tracker.example/MOCK-${id}`,
      type: { name: "Task", icon: null, subtask: false, epic: false }, status: { name: "To Do", category: "new" },
      priority: null, assignee: null, mine: false, parent: null, subtaskKeys: [], epic: null, fixVersions: [],
      estimate: null, remaining: null, points: null, flagged: false, updated: "2026-01-01T00:00:00Z",
      project: { key: "MOCK", name: "Synthetic project", avatar: null }, reporter: null, labels: [], components: [],
      dueDate: null, created: "2026-01-01T00:00:00Z", resolution: null, timeSpent: null, sprint: null,
      descriptionHtml: description(id),
    },
    comments: { total: 0, items: [] }, attachments: [], subtasks: [],
  };
}

function forgeDetail(id: number): ForgeDetail {
  return {
    kind: "gitlab", key: `synthetic/project#${id}`, repo: "synthetic/project", number: id,
    title: `Synthetic issue ${id}`, titleHtml: null, state: "open", stateReason: null,
    webUrl: `https://tracker.example/issues/${id}`, author: null, assignees: [], labels: [], milestone: null,
    createdAt: null, updatedAt: null, closedAt: null, comments: 0, children: null, parent: null,
    descriptionHtml: description(id), childItems: [],
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
  if (url.pathname !== "/issue") throw new Error(`Unexpected forge read: ${path}`);
  requests++;
  return Response.json({ ok: true, data: forgeDetail(Number(url.searchParams.get("number"))) });
};

const context: ForgeContextValue = {
  kind: "gitlab", connection: conn, scope: "gitlab:memory-fixture", api: forgeApi, asset: () => null,
  refresh: 0, selected: null, select: noop, isOpen: () => false, toggle: noop, reportFreshness: noop,
  onReconnect: noop, narrow: false, listKey: "synthetic", reportRows: noop, recallSection: () => null, keepSection: noop,
};

Object.assign(window, {
  trackerMemory: {
    show(kind: string, id: number) {
      flushSync(() => root.render(kind === "jira"
        ? <JiraIssueDetail conn={conn} api={jiraApi} assetUrl={url => url} trail={[`MOCK-${id}`]}
            estimation="count" time={{ hoursPerDay: 8, daysPerWeek: 5 }} onOpen={noop} onTrail={noop}
            onReconnect={noop} narrow={false} onClose={noop} />
        : <ForgeProvider value={context}><IssueDetail selection={{ type: "issue", repo: "synthetic/project", number: id }} /></ForgeProvider>));
    },
    close() { flushSync(() => root.unmount()); root = createRoot(document.getElementById("root")!); },
    requests: () => requests,
  },
});
