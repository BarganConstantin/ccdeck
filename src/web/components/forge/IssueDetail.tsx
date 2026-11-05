// An issue (#2179): its state as a chip in the bar, its title, one line with
// who opened it, when, and how many comments it has; the facts the forge's
// side column keeps (assignees, labels, milestone, its parent), the
// description under its name, its child items — GitLab's tasks, GitHub's
// sub-issues — and its comments, listed as the forge's own page lists them.
import type { ForgeComment, IssueDetail as Issue, IssueRef } from "../../forge-types";
import { issueMark } from "../../forge-detail";
import type { Mark } from "../../forge-panel";
import { useT } from "../../i18n";
import { formatNumber } from "../../i18n/format";
import { useForgePages, useForgeRead } from "../../use-forge-read";
import ForgeHtml, { renderForgeNodes } from "../ForgeHtml";
import { useForge, type ForgeSelection } from "./ForgeContext";
import { Ago, AgoIn, ListEnd, LoadingRows, ReadFailure, StateChip, StateMark } from "./ForgeParts";
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
      <IntegrationDetailBar {...bar} reference={reference} copyLabel={t("forge.copy.reference")}
        status={issue && <StateChip mark={issueMark(issue.state, issue.stateReason)} />} href={issue?.webUrl ?? null} />
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
  const { kind, select } = useForge();
  const t = useT();
  const author = i.author ? i.author.name || i.author.login : null;
  const titleNodes = useForgeNodes(i.titleHtml, true);
  const nodes = useForgeNodes(i.descriptionHtml);
  return (
    <>
      <header className="fd-head">
        <h2 className="fd-title">{titleNodes.length ? renderForgeNodes(titleNodes) : i.title}</h2>
        {/* "Opened by dan · 2d ago · 2 comments", and when it was closed. */}
        <p className="fd-summary">
          {author ? t("forge.issue.openedBy", { author }) : t("forge.issue.openedPlain")}
          {i.createdAt != null && <> · <Ago at={i.createdAt} /></>}
          {i.comments > 0 && <> · {t("forge.comments", { count: i.comments, n: formatNumber(i.comments, 0) })}</>}
          {i.state === "closed" && i.closedAt != null && <> · <AgoIn at={i.closedAt} text={t("forge.when.closed")} /></>}
        </p>
      </header>
      <div className="fd-layout">
        <SideFacts label={t("forge.issue.about")}>
          {/* GitHub names the field in the plural whatever it holds; GitLab
              says Assignee for one. */}
          <SideFact label={t(kind === "gitlab" && i.assignees.length <= 1 ? "forge.fact.assignee" : "forge.fact.assignees")}><PeopleFact users={i.assignees} /></SideFact>
          <SideFact label={t("forge.fact.labels")}><LabelsFact labels={i.labels} /></SideFact>
          <SideFact label={t("forge.fact.milestone")}>
            {!i.milestone ? <span className="fd-none">{t("forge.none")}</span>
              : i.milestone.webUrl
                ? <a className="fd-plain-link" href={i.milestone.webUrl} target="_blank" rel="noreferrer noopener">{i.milestone.title}</a>
                : i.milestone.title}
          </SideFact>
          {i.parent && (
            <SideFact label={t("forge.fact.parent")}>
              <IssueLink item={i.parent} onOpen={() => select({ type: "issue", repo: i.parent!.repo, number: i.parent!.number })} />
            </SideFact>
          )}
        </SideFacts>
        <div className="fd-main">
          <DetailHeading>{t("forge.description")}</DetailHeading>
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

/** The comments, read with the page when there are any. */
function Comments({ selection, count }: { selection: Selection; count: number }) {
  const t = useT();
  return (
    <section className="fd-block">
      <DetailHeading count={count}>{t("forge.comments.title")}</DetailHeading>
      {count ? <CommentList selection={selection} /> : <p className="fd-none">{t("forge.comments.none")}</p>}
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
      : <LoadingRows variant="lines" rows={3} label={t("forge.loadingNoun", { noun: t("forge.noun.comments") })} />;
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
