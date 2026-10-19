// The Issues tab (#2179). On GitLab it is the issues assigned to the user —
// across every project, or inside the one picked — and on GitHub the open or
// closed issues of the repository; Open / Closed is the panel's remembered view.
//
// A row: the title with its labels; `#12 · opened 3d ago by Author` under it
// (the project's path when across projects) and the milestone; on the right
// the child items done of how many, the other assignees, the comment count,
// and when it last moved — or was closed, and why, when GitHub says.
import { useMemo } from "react";
import type { ForgeIssue } from "../../forge-types";
import { matchesQuery } from "../../forge-panel";
import {
  emptyIssuesWords, issueClosedMark, itemLabel, listPhase, moreLabel, noMatchWords, useReportFreshness,
} from "../../forge-lists";
import { useForgePages } from "../../use-forge-read";
import type { ForgeTabProps } from "./ForgePanel";
import { sameSelection, useForge } from "./ForgeContext";
import { Ago, Badge, ListEnd, LoadingRows, ReadFailure } from "./ForgeParts";
import { CommentCount, Labels, People } from "./ChangesTab";

const STATES = [
  { state: "open", label: "Open" },
  { state: "closed", label: "Closed" },
] as const;

export default function IssuesTab({ view, setView, query }: ForgeTabProps) {
  const { kind, api, scope, refresh, reportFreshness, connection } = useForge();
  const acrossRepos = view.repo == null;
  const read = useForgePages<ForgeIssue>(api, scope, "issues", { repo: view.repo ?? undefined, state: view.issueState }, refresh);
  useReportFreshness(reportFreshness, read);

  const items = useMemo(() => read.data?.items ?? [], [read.data]);
  const shown = useMemo(() => items.filter(i => matchesQuery({ key: i.key, title: i.title, number: i.number }, query)), [items, query]);
  const phase = listPhase(read, items.length, shown.length);
  // GitLab's list is the user's own, so their face on every row says nothing.
  const me = kind === "gitlab" ? connection.account?.login ?? null : null;

  return (
    <div className="fgl">
      <div className="fgl-controls">
        <div className="uh-range fgl-seg" role="group" aria-label="Issues by state">
          {STATES.map(({ state, label }) => (
            <button key={state} type="button" className="uh-range-btn" aria-pressed={view.issueState === state} onClick={() => setView({ issueState: state })}>
              {label}
            </button>
          ))}
        </div>
        {kind === "gitlab" && <span className="fgl-controls-note">Assigned to you</span>}
      </div>

      {read.error && read.data && <ReadFailure error={read.error} onRetry={read.reload} compact />}
      {phase === "loading" && <LoadingRows label="Loading issues" />}
      {phase === "failed" && read.error && <ReadFailure error={read.error} onRetry={read.reload} />}
      {phase === "empty" && <p className="fg-empty">{emptyIssuesWords(kind, view.issueState, acrossRepos)}</p>}
      {phase === "no-match" && <p className="fg-empty">{noMatchWords("issues", query)}</p>}
      {phase === "rows" && (
        <div className="fgl-flat">
          <ul className="fg-rows">
            {shown.map(i => <IssueRow key={i.key} issue={i} acrossRepos={acrossRepos} me={me} />)}
          </ul>
        </div>
      )}
      {read.data && (
        <ListEnd pages={read} label={moreLabel(items.length, read.data.total)} />
      )}
    </div>
  );
}

function IssueRow({ issue: i, acrossRepos, me }: { issue: ForgeIssue; acrossRepos: boolean; me: string | null }) {
  const { selected, select } = useForge();
  const target = { type: "issue" as const, repo: i.repo, number: i.number };
  const isSelected = sameSelection(selected, target);
  const author = i.author ? i.author.name || i.author.login : null;
  const assignees = me ? i.assignees.filter(a => a.login !== me) : i.assignees;
  const closed = issueClosedMark(i);
  const at = i.state === "closed" && i.closedAt != null ? i.closedAt : i.updatedAt;
  return (
    <li>
      <button
        type="button"
        className="fg-row fgl-row"
        data-selected={isSelected || undefined}
        aria-current={isSelected || undefined}
        onClick={() => select(target)}
      >
        <span className="fg-row-title fgl-title">
          {closed && <Badge mark={closed} />}
          <span className="fgl-title-text">{i.title}</span>
          <Labels labels={i.labels} />
        </span>
        <span className="fgl-side">
          {i.children && i.children.total > 0 && (
            <span className="fgl-children" title={`${i.children.completed} of ${i.children.total} child items done`}>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
                <path d="M5.5 8.2l1.8 1.8 3.4-4" />
              </svg>
              {i.children.completed}/{i.children.total}
              <span className="fg-sr"> child items done</span>
            </span>
          )}
          <People users={assignees} label="Assigned to" />
          <CommentCount count={i.comments} />
        </span>
        <span className="fg-meta fgl-meta">
          <code>{itemLabel("#", i, acrossRepos)}</code>
          {i.createdAt != null && <> · opened <Ago at={i.createdAt} /></>}
          {author && <> by {author}</>}
          {i.milestone && <> · {i.milestone.title}</>}
        </span>
        <span className="fgl-when">{at != null && <>{i.state === "closed" && i.closedAt != null ? "closed" : "updated"} <Ago at={at} /></>}</span>
      </button>
    </li>
  );
}
