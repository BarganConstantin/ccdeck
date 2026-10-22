// One issue in full (#2178), in the Jira panel's detail column: where it sits
// (project, parent, the issues opened on the way here), every field the
// backlog row had no room for, the description, its sub-tasks — each opens
// here, with the way back in the breadcrumb — its attachments, which open in
// Jira, and the last ten comments.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { IntegrationConnection as Connection } from "../integrations/types";
import { jiraImage, type JiraApi, type JiraIssue, type TimeTracking } from "../jira-api";
import { fileSize, jiraDate, jiraDuration } from "../jira-board";
import JiraHtml, { type HtmlContext } from "../jira-html";
import { copyText } from "../copy-text";
import { useJiraIssue } from "../use-jira-board";
import IntegrationAvatar from "./IntegrationAvatar";
import { EpicChip, ExternalGlyph, FailureNote, FlagGlyph, PriorityIcon, StatusLozenge, TypeIcon } from "./JiraParts";

export interface JiraIssueDetailProps {
  conn: Connection;
  api: JiraApi;
  assetUrl: (url: string) => string;
  /** The issues opened on the way here, the last being the one on show. */
  trail: string[];
  estimation: "time" | "points" | "count";
  time: TimeTracking;
  /** Open another issue here: a sub-task (pushed onto the trail) or a parent. */
  onOpen: (key: string, how: "push" | "replace") => void;
  /** Go back along the trail to the issue at `index`. */
  onTrail: (index: number) => void;
  onReconnect: () => void;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  if (children == null || children === "" || (Array.isArray(children) && children.length === 0)) return null;
  return <div className="jr-field"><dt>{label}</dt><dd>{children}</dd></div>;
}

function Person({ person, fallback }: { person: { name: string; avatar: string | null } | null; fallback: string }) {
  if (!person) return <span className="jr-dim">{fallback}</span>;
  return <span className="jr-person"><IntegrationAvatar src={person.avatar} name={person.name} size={18} />{person.name}</span>;
}

function SubtaskList({ issues, onOpen }: { issues: JiraIssue[]; onOpen: (key: string) => void }) {
  return (
    <ul className="jr-detail-subtasks">
      {issues.map(sub => (
        <li key={sub.key}>
          <button type="button" className="jr-detail-sub" data-mine={sub.mine || undefined} data-done={sub.status.category === "done" || undefined}
            onClick={() => onOpen(sub.key)} aria-label={`${sub.key}: ${sub.summary}. ${sub.status.name}${sub.assignee ? `, ${sub.assignee.name}` : ", unassigned"}${sub.mine ? ", yours" : ""}`}>
            <TypeIcon type={sub.type} />
            <span className="jr-key">{sub.key}</span>
            <span className="jr-summary">{sub.summary}</span>
            <StatusLozenge status={sub.status} />
            {sub.assignee ? <IntegrationAvatar src={sub.assignee.avatar} name={sub.assignee.name} size={18} /> : <span className="jr-avatar-blank" aria-hidden />}
          </button>
        </li>
      ))}
    </ul>
  );
}

export default function JiraIssueDetail({ conn, api, assetUrl, trail, estimation, time, onOpen, onTrail, onReconnect }: JiraIssueDetailProps) {
  const key = trail[trail.length - 1] ?? null;
  const { data, loading, error, reload } = useJiraIssue(api, conn.id, key);
  const [copied, setCopied] = useState<"key" | "link" | null>(null);
  const ctx = useMemo<HtmlContext>(() => ({ baseUrl: conn.baseUrl, image: abs => jiraImage(conn, assetUrl, abs) }), [conn, assetUrl]);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(null), 2_000);
    return () => window.clearTimeout(t);
  }, [copied]);

  const issue = data && data.issue.key === key ? data.issue : null;
  const copy = async (what: "key" | "link") => {
    if (!issue) return;
    if (await copyText(what === "key" ? issue.key : issue.url)) setCopied(what);
  };

  // Where the issue sits: its project, its parent unless the trail already
  // passes through it, and every issue opened on the way here.
  const crumbs: { label: string; title: string; go?: () => void }[] = [];
  if (issue?.project.name) crumbs.push({ label: issue.project.name, title: issue.project.key });
  const parentKey = issue?.parent?.key;
  if (parentKey && !trail.slice(0, -1).includes(parentKey)) {
    crumbs.push({ label: parentKey, title: issue!.parent!.summary, go: () => onOpen(parentKey, "replace") });
  }
  trail.slice(0, -1).forEach((k, i) => crumbs.push({ label: k, title: `Back to ${k}`, go: () => onTrail(i) }));

  if (!key) return null;
  return (
    <article className="jr-detail" aria-busy={loading || undefined} aria-labelledby="jira-detail-title">
      <ol className="jr-crumbs" role="list" aria-label="Where this issue is">
        {crumbs.map((c, i) => (
          <li key={`${c.label}-${i}`}>
            {c.go ? <button type="button" className="jr-crumb" title={c.title} onClick={c.go}>{c.label}</button> : <span className="jr-crumb-text" title={c.title}>{c.label}</span>}
          </li>
        ))}
        <li aria-current="page"><span className="jr-crumb-text jr-crumb-here">{key}</span></li>
      </ol>

      {error && <FailureNote error={error} conn={conn} stale={Boolean(issue)} onRetry={reload} onReconnect={onReconnect} compact />}

      {!issue && loading && (
        <div className="jr-skeleton" role="status" aria-label={`Reading ${key}`}><i /><i /><i /><i /></div>
      )}

      {issue && (
        <>
          <header className="jr-detail-head">
            <div className="jr-detail-kicker">
              <TypeIcon type={issue.type} />
              <a className="jr-key jr-key-link" href={issue.url} target="_blank" rel="noreferrer noopener" data-done={issue.status.category === "done" || undefined}>{issue.key}</a>
              <StatusLozenge status={issue.status} />
              {issue.flagged && <span className="jr-flagged"><FlagGlyph /> Flagged</span>}
            </div>
            <h3 id="jira-detail-title" tabIndex={-1} className="jr-detail-title">{issue.summary}</h3>
            <div className="jr-detail-actions">
              <a className="jr-open" href={issue.url} target="_blank" rel="noreferrer noopener">Open in Jira <ExternalGlyph /></a>
              <button type="button" className="btn" onClick={() => void copy("key")}>{copied === "key" ? "Copied" : "Copy key"}</button>
              <button type="button" className="btn" onClick={() => void copy("link")}>{copied === "link" ? "Copied" : "Copy link"}</button>
              <span className="vis-hidden" role="status">{copied ? `Copied the ${copied === "key" ? "key" : "link"}` : ""}</span>
            </div>
          </header>

          <dl className="jr-fields">
            <Field label="Status">{issue.status.name}{issue.resolution ? <span className="jr-dim"> · {issue.resolution}</span> : null}</Field>
            <Field label="Assignee"><Person person={issue.assignee} fallback="Unassigned" /></Field>
            <Field label="Reporter"><Person person={issue.reporter} fallback="Nobody" /></Field>
            <Field label="Type">{issue.type.name}</Field>
            <Field label="Priority">{issue.priority ? <span className="jr-person"><PriorityIcon priority={issue.priority} />{issue.priority.name}</span> : null}</Field>
            <Field label="Sprint">{issue.sprint ? <>{issue.sprint.name}{issue.sprint.state ? <span className="jr-dim"> · {issue.sprint.state}</span> : null}</> : null}</Field>
            <Field label="Epic">{issue.epic ? <EpicChip epic={issue.epic} /> : null}</Field>
            <Field label="Fix versions">{issue.fixVersions.length ? <span className="jr-chips">{issue.fixVersions.map(v => <span key={v} className="jr-version">{v}</span>)}</span> : null}</Field>
            <Field label="Labels">{issue.labels.length ? <span className="jr-chips">{issue.labels.map(l => <span key={l} className="jr-label">{l}</span>)}</span> : null}</Field>
            <Field label="Components">{issue.components.join(", ")}</Field>
            {estimation === "points" && <Field label="Story points">{issue.points != null ? String(issue.points) : null}</Field>}
            <Field label="Original estimate">{jiraDuration(issue.estimate, time)}</Field>
            <Field label="Remaining">{jiraDuration(issue.remaining, time)}</Field>
            <Field label="Time spent">{jiraDuration(issue.timeSpent, time)}</Field>
            <Field label="Due">{jiraDate(issue.dueDate)}</Field>
            <Field label="Created">{jiraDate(issue.created, true)}</Field>
            <Field label="Updated">{jiraDate(issue.updated, true)}</Field>
          </dl>

          <section className="jr-detail-section" aria-labelledby="jira-detail-desc">
            <h4 id="jira-detail-desc">Description</h4>
            <JiraHtml html={issue.descriptionHtml} ctx={ctx} empty={<p className="jr-dim">No description.</p>} />
          </section>

          {data!.subtasks.length > 0 && (
            <section className="jr-detail-section" aria-labelledby="jira-detail-subs">
              <h4 id="jira-detail-subs">Sub-tasks <span className="jr-count">{data!.subtasks.length}</span></h4>
              <SubtaskList issues={data!.subtasks} onOpen={k => onOpen(k, "push")} />
            </section>
          )}

          {data!.attachments.length > 0 && (
            <section className="jr-detail-section" aria-labelledby="jira-detail-files">
              <h4 id="jira-detail-files">Attachments <span className="jr-count">{data!.attachments.length}</span></h4>
              <ul className="jr-files">
                {data!.attachments.map(a => (
                  <li key={a.id}>
                    {a.url
                      ? <a href={a.url} target="_blank" rel="noreferrer noopener" title="Opens in Jira">{a.filename}<ExternalGlyph /></a>
                      : <span>{a.filename}</span>}
                    <span className="jr-dim">{[fileSize(a.size), jiraDate(a.created)].filter(Boolean).join(" · ")}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="jr-detail-section" aria-labelledby="jira-detail-comments">
            <h4 id="jira-detail-comments">
              Comments <span className="jr-count">{data!.comments.total > data!.comments.items.length ? `${data!.comments.items.length} of ${data!.comments.total}` : data!.comments.total}</span>
            </h4>
            {data!.comments.items.length === 0 && <p className="jr-dim">No comments.</p>}
            <ol className="jr-comments">
              {data!.comments.items.map(c => (
                <li key={c.id} className="jr-comment">
                  <div className="jr-comment-head">
                    <Person person={c.author} fallback="Someone" />
                    <time className="jr-dim" dateTime={c.created}>{jiraDate(c.created, true)}</time>
                    {c.updated && c.updated !== c.created && <span className="jr-dim">edited</span>}
                  </div>
                  <JiraHtml html={c.html} ctx={ctx} empty={<p className="jr-dim">(empty)</p>} />
                </li>
              ))}
            </ol>
            {data!.comments.total > data!.comments.items.length && (
              <p className="jr-dim"><a href={issue.url} target="_blank" rel="noreferrer noopener">The older comments are in Jira</a></p>
            )}
          </section>
        </>
      )}
    </article>
  );
}
