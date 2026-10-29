// One issue in full (#2178), in the Jira panel's detail column: where it sits
// (project, parent, the issues opened on the way here), every field the
// backlog row had no room for, the description, its sub-tasks — each opens
// here, with the way back in the breadcrumb — its attachments, which open in
// Jira, and the last ten comments.
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import type { IntegrationConnection as Connection } from "../integrations/types";
import { jiraImage, type JiraApi, type JiraIssue, type TimeTracking } from "../jira-api";
import { detailNameTakesFocus, fileSize, jiraDate, shownResolution, timeLine } from "../jira-board";
import JiraTransition from "./JiraTransition";
import JiraCommentForm from "./JiraCommentForm";
import JiraHtml, { type HtmlContext } from "../jira-html";
import { useJiraIssue } from "../use-jira-board";
import { connectionHost } from "../integrations/client";
import IntegrationAvatar, { IntegrationPerson, UnassignedAvatar } from "./IntegrationAvatar";
import IntegrationDetailBar from "./IntegrationDetailBar";
import IntegrationFailureNote from "./IntegrationFailureNote";
import IntegrationSkeleton from "./IntegrationSkeleton";
import { ExternalLinkGlyph } from "./action-glyphs";
import { EpicChip, FlagGlyph, PriorityIcon, StatusLozenge, TypeIcon } from "./JiraParts";

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
  /** The detail is a screen of its own, with the host's Back for a Close. */
  narrow: boolean;
  /** The panel put this issue back (integrations/use-list-view.ts); the reader
   *  did not open it, so focus stays where it is. */
  auto?: boolean;
  /** Close the issue: back to the row that opened it. */
  onClose: () => void;
  onStatusChanged?: () => void;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  if (children == null || children === "" || (Array.isArray(children) && children.length === 0)) return null;
  return <div className="jr-field"><dt>{label}</dt><dd>{children}</dd></div>;
}

function Person({ person, fallback, you = false }: { person: { name: string; avatar: string | null } | null; fallback: string; you?: boolean }) {
  if (!person) return <span className="jr-dim">{fallback}</span>;
  return <IntegrationPerson src={person.avatar} name={person.name} size={18} you={you} />;
}

function SubtaskList({ issues, onOpen }: { issues: JiraIssue[]; onOpen: (key: string) => void }) {
  return (
    <ul className="jr-detail-subtasks">
      {issues.map(sub => (
        <li key={sub.key}>
          <button type="button" className="jr-detail-sub" data-mine={sub.mine || undefined} data-done={sub.status.category === "done" || undefined}
            onClick={() => onOpen(sub.key)} aria-label={`${sub.key}: ${sub.summary}. ${sub.status.name}${sub.assignee ? `, ${sub.assignee.name}${sub.mine ? ", assigned to you" : ""}` : ", unassigned"}`}>
            <TypeIcon type={sub.type} />
            <span className="jr-key">{sub.key}</span>
            <span className="jr-summary">{sub.summary}</span>
            <StatusLozenge status={sub.status} />
            {sub.assignee ? <IntegrationAvatar src={sub.assignee.avatar} name={sub.assignee.name} size={18} you={sub.mine} /> : <UnassignedAvatar size={18} />}
          </button>
        </li>
      ))}
    </ul>
  );
}

export default function JiraIssueDetail({ conn, api, assetUrl, trail, estimation, time, onOpen, onTrail, onReconnect, narrow, auto = false, onClose, onStatusChanged }: JiraIssueDetailProps) {
  const key = trail[trail.length - 1] ?? null;
  const { data, loading, error, reload } = useJiraIssue(api, conn.id, key);
  const ctx = useMemo<HtmlContext>(() => ({ baseUrl: conn.baseUrl, image: abs => jiraImage(conn, assetUrl, abs) }), [conn, assetUrl]);
  const issue = data && data.issue.key === key ? data.issue : null;
  const resolution = issue ? shownResolution(issue) : null;

  // Where focus goes once an issue's name is drawn (detailNameTakesFocus). A
  // sub-task, the parent or an issue on the trail, opened from here, replaces
  // the button that opened it, so those buttons hand focus off first. On a
  // narrow screen the detail replaces the list too, and the panel puts focus
  // on Back while the issue is read. An issue the panel put back moves
  // nothing: the modal has put focus where it starts.
  const handedOff = useRef(false);
  const openHere = (go: () => void) => { handedOff.current = true; go(); };
  const shownKey = issue?.key;
  useEffect(() => {
    if (!shownKey) return;
    const handed = handedOff.current;
    handedOff.current = false;
    if (auto) return;
    const at = document.activeElement;
    const focusLost = at == null || at === document.body;
    const focusOnBack = at instanceof HTMLElement && at.matches("[data-ig-back]");
    if (detailNameTakesFocus({ handedOff: handed, narrow, focusLost, focusOnBack })) {
      document.getElementById("jira-detail-title")?.focus();
    }
  }, [narrow, shownKey, auto]);

  // Keep meaningful parent/history navigation; project and current key live
  // together in the sticky reference bar.
  const crumbs: { label: string; title: string; go?: () => void }[] = [];
  const parentKey = issue?.parent?.key;
  if (parentKey && !trail.slice(0, -1).includes(parentKey)) {
    crumbs.push({ label: parentKey, title: issue!.parent!.summary, go: () => openHere(() => onOpen(parentKey, "replace")) });
  }
  trail.slice(0, -1).forEach((k, i) => crumbs.push({ label: k, title: `Back to ${k}`, go: () => openHere(() => onTrail(i)) }));

  if (!key) return null;
  return (
    <article className="jr-detail" aria-busy={loading || undefined} aria-labelledby="jira-detail-title">
      <IntegrationDetailBar reference={key} context={issue?.project.name} copyLabel="key" href={issue?.url ?? null} openLabel="Open in Jira" narrow={narrow} onClose={onClose} />
      {crumbs.length > 0 && <ol className="jr-crumbs" role="list" aria-label="Related issues">
        {crumbs.map((c, i) => (
          <li key={`${c.label}-${i}`}>
            {c.go ? <button type="button" className="jr-crumb" title={c.title} onClick={c.go}>{c.label}</button> : <span className="jr-crumb-text" title={c.title}>{c.label}</span>}
          </li>
        ))}
      </ol>}

      {error && <IntegrationFailureNote error={error} provider="Jira" host={connectionHost(conn)} stale={Boolean(issue)} onRetry={reload} onReconnect={onReconnect} />}

      {!issue && loading && (
        <IntegrationSkeleton label={`Reading ${key}`} rows={4} variant="lines" />
      )}

      {issue && (
        <>
          <header className="jr-detail-head">
            <h2 id="jira-detail-title" tabIndex={-1} className="jr-detail-title">{issue.summary}</h2>
            {/* Where the issue stands, under its name: what kind of issue it
                is, its status (and how it was resolved, unless that is the
                status again), its priority, and the flag when it has one. */}
            <p className="jr-detail-state">
              <span className="jr-with-icon"><TypeIcon type={issue.type} />{issue.type.name}</span>
              <StatusLozenge status={issue.status} />
              {onStatusChanged && <JiraTransition key={issue.key} api={api} connectionId={conn.id} issueKey={issue.key} onChanged={onStatusChanged} />}
              {resolution && <span className="jr-dim">{resolution}</span>}
              {issue.priority && <span className="jr-with-icon"><PriorityIcon priority={issue.priority} />{issue.priority.name}</span>}
              {issue.flagged && <span className="jr-flagged"><FlagGlyph /> Flagged</span>}
            </p>
          </header>

          <dl className="jr-fields">
            <Field label="Assignee"><Person person={issue.assignee} fallback="Unassigned" you={issue.mine} /></Field>
            <Field label="Reporter">{issue.reporter ? <Person person={issue.reporter} fallback="" /> : null}</Field>
            <Field label="Sprint">{issue.sprint ? <>{issue.sprint.name}{issue.sprint.state ? <span className="jr-dim"> · {issue.sprint.state}</span> : null}</> : null}</Field>
            <Field label="Epic">{issue.epic ? <EpicChip epic={issue.epic} /> : null}</Field>
            <Field label="Fix versions">{issue.fixVersions.length ? <span className="jr-chips">{issue.fixVersions.map(v => <span key={v} className="jr-version">{v}</span>)}</span> : null}</Field>
            <Field label="Labels">{issue.labels.length ? <span className="jr-chips">{issue.labels.map(l => <span key={l} className="jr-label">{l}</span>)}</span> : null}</Field>
            <Field label="Components">{issue.components.join(", ")}</Field>
            <Field label="Due">{jiraDate(issue.dueDate)}</Field>
            {estimation === "points" && <Field label="Estimate">{issue.points != null ? `${issue.points} ${issue.points === 1 ? "point" : "points"}` : null}</Field>}
            <Field label="Time">{timeLine(issue, time)}</Field>
          </dl>
          <p className="jr-detail-dates">
            {[issue.created && `Created ${jiraDate(issue.created, true)}`, issue.updated && `Updated ${jiraDate(issue.updated, true)}`].filter(Boolean).join(" · ")}
          </p>

          <section className="jr-detail-section" aria-labelledby="jira-detail-desc">
            <h3 id="jira-detail-desc">Description</h3>
            <JiraHtml html={issue.descriptionHtml} ctx={ctx} empty={<p className="jr-dim">No description.</p>} />
          </section>

          {data!.subtasks.length > 0 && (
            <section className="jr-detail-section" aria-labelledby="jira-detail-subs">
              <h3 id="jira-detail-subs">Sub-tasks <span className="jr-count">{data!.subtasks.length}</span></h3>
              <SubtaskList issues={data!.subtasks} onOpen={k => openHere(() => onOpen(k, "push"))} />
            </section>
          )}

          {data!.attachments.length > 0 && (
            <section className="jr-detail-section" aria-labelledby="jira-detail-files">
              <h3 id="jira-detail-files">Attachments <span className="jr-count">{data!.attachments.length}</span></h3>
              <ul className="jr-files">
                {data!.attachments.map(a => (
                  <li key={a.id}>
                    {a.url
                      ? <a href={a.url} target="_blank" rel="noreferrer noopener" title="Opens in Jira">{a.filename}<ExternalLinkGlyph /></a>
                      : <span>{a.filename}</span>}
                    <span className="jr-dim">{[fileSize(a.size), jiraDate(a.created)].filter(Boolean).join(" · ")}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="jr-detail-section" aria-labelledby="jira-detail-comments">
            <h3 id="jira-detail-comments">
              Comments <span className="jr-count">{data!.comments.total > data!.comments.items.length ? `${data!.comments.items.length} of ${data!.comments.total}` : data!.comments.total}</span>
            </h3>
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
            {onStatusChanged && <JiraCommentForm key={issue.key} api={api} connectionId={conn.id} issueKey={issue.key} onChanged={onStatusChanged} />}
            {data!.comments.total > data!.comments.items.length && (
              <p className="jr-dim"><a className="jr-more-link" href={issue.url} target="_blank" rel="noreferrer noopener">The older comments are in Jira <ExternalLinkGlyph /></a></p>
            )}
          </section>
        </>
      )}
    </article>
  );
}
