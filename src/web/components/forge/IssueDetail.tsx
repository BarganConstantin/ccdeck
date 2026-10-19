// An issue (#2179): its title and state, who opened it and when, the facts the
// forge's side column keeps (assignees, labels, milestone, its parent), the
// description, its child items — GitLab's tasks, GitHub's sub-issues — and its
// comments, folded behind "Show N comments" and read only when that is pressed:
// an issue opened to check its state should not cost a comment thread.
import { useState } from "react";
import type { ForgeComment, IssueDetail as Issue, IssueRef } from "../../forge-types";
import { issueMark } from "../../forge-detail";
import { useForgePages, useForgeRead } from "../../use-forge-read";
import ForgeHtml, { renderForgeNodes } from "../ForgeHtml";
import { useForge, type ForgeSelection } from "./ForgeContext";
import { Ago, Badge, ListEnd, LoadingRows, Person, ReadFailure, StateMark } from "./ForgeParts";
import {
  DetailBar, DetailFrame, DetailHeading, DetailPending, LabelsFact, PeopleFact, SideFact, SideFacts, useForgeNodes,
} from "./DetailParts";
import { Comment } from "./DetailThreads";

type Selection = Extract<ForgeSelection, { type: "issue" }>;

export default function IssueDetail({ selection }: { selection: Selection }) {
  const { api, scope, refresh } = useForge();
  const read = useForgeRead<Issue>(api, scope, "issue", { repo: selection.repo, number: selection.number }, refresh);
  const issue = read.data;
  const reference = issue?.key ?? `${selection.repo}#${selection.number}`;
  return (
    <DetailFrame label={`Issue ${reference}`}>
      <DetailBar reference={reference} copyLabel="reference" href={issue?.webUrl ?? null} />
      <DetailPending data={issue} loading={read.loading} error={read.error} onRetry={read.reload} what="issue" />
      {issue && (
        <>
          {read.error && <ReadFailure error={read.error} onRetry={read.reload} compact />}
          <IssueBody selection={selection} issue={issue} />
        </>
      )}
    </DetailFrame>
  );
}

function IssueBody({ selection, issue: i }: { selection: Selection; issue: Issue }) {
  const { select } = useForge();
  const titleNodes = useForgeNodes(i.titleHtml, true);
  const nodes = useForgeNodes(i.descriptionHtml);
  return (
    <>
      <header className="fd-head">
        <h2 className="fd-title">{titleNodes.length ? renderForgeNodes(titleNodes) : i.title}</h2>
        <p className="fd-byline">
          <Badge mark={issueMark(i.state, i.stateReason)} />
          <span><code>#{i.number}</code> opened</span>
          {i.createdAt != null && <Ago at={i.createdAt} />}
          {i.author && <><span>by</span><Person user={i.author} size={18} /></>}
          {i.state === "closed" && i.closedAt != null && <span className="fd-when">· closed <Ago at={i.closedAt} /></span>}
        </p>
      </header>
      <div className="fd-layout">
        <SideFacts label="About this issue">
          <SideFact label={i.assignees.length > 1 ? "Assignees" : "Assignee"}><PeopleFact users={i.assignees} /></SideFact>
          {i.labels.length > 0 && <SideFact label="Labels"><LabelsFact labels={i.labels} /></SideFact>}
          {i.milestone && (
            <SideFact label="Milestone">
              {i.milestone.webUrl
                ? <a className="fd-plain-link" href={i.milestone.webUrl} target="_blank" rel="noreferrer noopener">{i.milestone.title}</a>
                : i.milestone.title}
            </SideFact>
          )}
          {i.parent && (
            <SideFact label="Parent">
              <IssueLink item={i.parent} onOpen={() => select({ type: "issue", repo: i.parent!.repo, number: i.parent!.number })} />
            </SideFact>
          )}
        </SideFacts>
        <div className="fd-main">
          {nodes.length ? <ForgeHtml className="fd-description" nodes={nodes} /> : <p className="fd-none fd-description">No description.</p>}
          {i.childItems.length > 0 && (
            <section className="fd-block">
              <DetailHeading
                count={i.childItems.length}
                aside={i.children && <span className="fd-progress">{i.children.completed} of {i.children.total} done</span>}
              >
                Child items
              </DetailHeading>
              <ul className="fg-rows fd-rows">
                {i.childItems.map(child => (
                  <li key={child.key}>
                    <IssueRow item={child} onOpen={() => select({ type: "issue", repo: child.repo, number: child.number })} />
                  </li>
                ))}
              </ul>
            </section>
          )}
          <Comments selection={selection} count={i.comments} />
        </div>
      </div>
    </>
  );
}

function childMark(state: IssueRef["state"]) {
  return state === "open" ? { mark: "○", word: "open", tone: "busy" as const } : { mark: "✓", word: "closed", tone: "ok" as const };
}

function IssueRow({ item, onOpen }: { item: IssueRef; onOpen: () => void }) {
  const { selected } = useForge();
  const current = selected?.type === "issue" && selected.repo === item.repo && selected.number === item.number;
  return (
    <button type="button" className="fg-row fd-child-row" onClick={onOpen} aria-current={current || undefined} data-selected={current || undefined}>
      <StateMark mark={childMark(item.state)} />
      <span className="fd-child-title">{item.title}</span>
      <span className="fd-child-meta">
        {item.type && <span>{item.type}</span>}
        <code>#{item.number}</code>
      </span>
    </button>
  );
}

function IssueLink({ item, onOpen }: { item: IssueRef; onOpen: () => void }) {
  return (
    <button type="button" className="fd-jump" onClick={onOpen}>
      <StateMark mark={childMark(item.state)} quiet />
      <span className="fd-jump-title">{item.title}</span>
      <span className="fd-jump-arrow" aria-hidden="true">›</span>
    </button>
  );
}

function Comments({ selection, count }: { selection: Selection; count: number }) {
  const [shown, setShown] = useState(false);
  if (!count) {
    return (
      <section className="fd-block">
        <DetailHeading count={0}>Comments</DetailHeading>
        <p className="fd-none">No comments.</p>
      </section>
    );
  }
  return (
    <section className="fd-block">
      <DetailHeading count={count}>Comments</DetailHeading>
      {shown
        ? <CommentList selection={selection} />
        : (
          <button type="button" className="btn fd-show-comments" onClick={() => setShown(true)}>
            Show {count.toLocaleString()} comment{count === 1 ? "" : "s"}
          </button>
        )}
    </section>
  );
}

function CommentList({ selection }: { selection: Selection }) {
  const { api, scope, refresh } = useForge();
  const pages = useForgePages<ForgeComment>(api, scope, "issue/comments", { repo: selection.repo, number: selection.number }, refresh);
  if (!pages.data) {
    return pages.error
      ? <ReadFailure error={pages.error} onRetry={pages.reload} />
      : <LoadingRows rows={3} label="Loading comments" />;
  }
  return (
    <>
      {pages.error && <ReadFailure error={pages.error} onRetry={pages.reload} compact />}
      {pages.data.items.length
        ? <ol className="fd-threads fd-issue-comments">{pages.data.items.map(c => <li key={c.id} className="fd-thread"><ol className="fd-comments"><Comment comment={c} /></ol></li>)}</ol>
        : <p className="fd-none">No comments.</p>}
      <ListEnd pages={pages} label="Load more comments" />
    </>
  );
}
