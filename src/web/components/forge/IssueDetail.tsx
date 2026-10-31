// An issue (#2179): its title and state, who opened it and when, the facts the
// forge's side column keeps (assignees, labels, milestone, its parent), the
// description, its child items — GitLab's tasks, GitHub's sub-issues — and its
// comments, folded behind "Show N comments" and read only when that is pressed:
// an issue opened to check its state should not cost a comment thread.
import { useState } from "react";
import type { ForgeComment, IssueDetail as Issue, IssueRef } from "../../forge-types";
import { issueMark } from "../../forge-detail";
import type { Mark } from "../../forge-panel";
import { useT } from "../../i18n";
import { formatNumber } from "../../i18n/format";
import { useForgePages, useForgeRead } from "../../use-forge-read";
import ForgeHtml, { renderForgeNodes } from "../ForgeHtml";
import { useForge, type ForgeSelection } from "./ForgeContext";
import { Ago, AgoIn, Badge, ListEnd, LoadingRows, Person, ReadFailure, StateMark } from "./ForgeParts";
import {
  DetailFrame, DetailHeading, DetailPending, LabelsFact, PeopleFact, SideFact, SideFacts, useDetailBar, useForgeNodes,
} from "./DetailParts";
import { Comment } from "./DetailThreads";
import IntegrationDetailBar from "../IntegrationDetailBar";

type Selection = Extract<ForgeSelection, { type: "issue" }>;

export default function IssueDetail({ selection }: { selection: Selection }) {
  const { api, scope, refresh } = useForge();
  const bar = useDetailBar();
  const t = useT();
  const read = useForgeRead<Issue>(api, scope, "issue", { repo: selection.repo, number: selection.number }, refresh);
  const issue = read.data;
  const reference = issue?.key ?? `${selection.repo}#${selection.number}`;
  return (
    <DetailFrame label={t("forge.issue.frame", { ref: reference })}>
      <IntegrationDetailBar {...bar} reference={reference} copyLabel={t("forge.copy.reference")} href={issue?.webUrl ?? null} />
      <DetailPending data={issue} loading={read.loading} error={read.error} onRetry={read.reload} what={t("forge.noun.issue")} />
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
  const t = useT();
  const titleNodes = useForgeNodes(i.titleHtml, true);
  const nodes = useForgeNodes(i.descriptionHtml);
  return (
    <>
      <header className="fd-head">
        <h2 className="fd-title">{titleNodes.length ? renderForgeNodes(titleNodes) : i.title}</h2>
        <p className="fd-byline">
          <Badge mark={issueMark(i.state, i.stateReason)} />
          <span><code>#{i.number}</code> {t("forge.issue.opened")}</span>
          {i.createdAt != null && <Ago at={i.createdAt} />}
          {i.author && <><span>{t("forge.issue.by")}</span><Person user={i.author} size={18} /></>}
          {i.state === "closed" && i.closedAt != null && <span className="fd-when">· <AgoIn at={i.closedAt} text={t("forge.when.closed")} /></span>}
        </p>
      </header>
      <div className="fd-layout">
        <SideFacts label={t("forge.issue.about")}>
          <SideFact label={t(i.assignees.length > 1 ? "forge.fact.assignees" : "forge.fact.assignee")}><PeopleFact users={i.assignees} /></SideFact>
          {i.labels.length > 0 && <SideFact label={t("forge.fact.labels")}><LabelsFact labels={i.labels} /></SideFact>}
          {i.milestone && (
            <SideFact label={t("forge.fact.milestone")}>
              {i.milestone.webUrl
                ? <a className="fd-plain-link" href={i.milestone.webUrl} target="_blank" rel="noreferrer noopener">{i.milestone.title}</a>
                : i.milestone.title}
            </SideFact>
          )}
          {i.parent && (
            <SideFact label={t("forge.fact.parent")}>
              <IssueLink item={i.parent} onOpen={() => select({ type: "issue", repo: i.parent!.repo, number: i.parent!.number })} />
            </SideFact>
          )}
        </SideFacts>
        <div className="fd-main">
          {nodes.length ? <ForgeHtml className="fd-description" nodes={nodes} /> : <p className="fd-none fd-description">{t("forge.noDescription")}</p>}
          {i.childItems.length > 0 && (
            <section className="fd-block">
              <DetailHeading
                count={i.childItems.length}
                aside={i.children && <span className="fd-progress">{t("forge.issue.progress", { done: formatNumber(i.children.completed, 0), total: formatNumber(i.children.total, 0) })}</span>}
              >
                {t("forge.issue.childItems")}
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

function childMark(state: IssueRef["state"]): Mark {
  return state === "open" ? { mark: "open", word: "open", tone: "busy" } : { mark: "done", word: "closed", tone: "ok" };
}

function IssueRow({ item, onOpen }: { item: IssueRef; onOpen: () => void }) {
  const { selected } = useForge();
  const current = selected?.type === "issue" && selected.repo === item.repo && selected.number === item.number;
  return (
    <button type="button" className="fg-row fd-child-row ig-row" onClick={onOpen} aria-current={current || undefined} data-selected={current || undefined}>
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
  const t = useT();
  const [shown, setShown] = useState(false);
  if (!count) {
    return (
      <section className="fd-block">
        <DetailHeading count={0}>{t("forge.comments.title")}</DetailHeading>
        <p className="fd-none">{t("forge.comments.none")}</p>
      </section>
    );
  }
  return (
    <section className="fd-block">
      <DetailHeading count={count}>{t("forge.comments.title")}</DetailHeading>
      {shown
        ? <CommentList selection={selection} />
        : (
          <button type="button" className="btn fd-show-comments" onClick={() => setShown(true)}>
            {t("forge.comments.show", { count, n: formatNumber(count, 0) })}
          </button>
        )}
    </section>
  );
}

function CommentList({ selection }: { selection: Selection }) {
  const { api, scope, refresh } = useForge();
  const t = useT();
  const pages = useForgePages<ForgeComment>(api, scope, "issue/comments", { repo: selection.repo, number: selection.number }, refresh);
  if (!pages.data) {
    return pages.error
      ? <ReadFailure error={pages.error} onRetry={pages.reload} />
      : <LoadingRows rows={3} label={t("forge.loadingNoun", { noun: t("forge.noun.comments") })} />;
  }
  return (
    <>
      {pages.error && <ReadFailure error={pages.error} onRetry={pages.reload} compact />}
      {pages.data.items.length
        ? <ol className="fd-threads fd-issue-comments">{pages.data.items.map(c => <li key={c.id} className="fd-thread"><ol className="fd-comments"><Comment comment={c} /></ol></li>)}</ol>
        : <p className="fd-none">{t("forge.comments.none")}</p>}
      <ListEnd pages={pages} label={t("forge.comments.more")} />
    </>
  );
}
