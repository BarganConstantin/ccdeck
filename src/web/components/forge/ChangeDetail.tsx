// A merge request or pull request, drawn the way GitLab's merge request page
// draws one (#2179) — the page reviewers work from.
//
// The title with its state, "Author requested to merge source into target",
// the pipeline and the approvals; then the page's four tabs with their counts
// — Overview (the description and the discussions: unresolved threads open,
// resolved threads and general comments folded), Commits, Pipelines and
// Changes (a file list with its +/−, never a diff) — and the side column:
// assignee, reviewers with their state, labels, milestone, participants. No
// time tracking, nothing that writes: every action is a link to the forge.
//
// Only the Overview is read when the page opens. Commits and Changes are paged
// and asked for when their tab is first shown; the change's pipelines are read
// with the page, because the pipeline line under the title links to the
// latest one.
import { useId, useState } from "react";
import type { ChangedFile, ChangeDetail as Change, ForgeCommit, ForgePipeline, ForgeReviewer } from "../../forge-types";
import { forgeNouns } from "../../forge-types";
import { ciMark, durationWords, reviewerMark } from "../../forge-panel";
import { useT } from "../../i18n";
import { formatNumber } from "../../i18n/format";
import {
  approvalWords, changeReference, changeRunsWord, changeSections, changeStateMark, commitsWords, fileStatusWord, nodesWithoutDraftPrefix, pathParts,
  pipelineIdFromUrl, shortRef, splitDiscussions, withoutDraftPrefix, type ChangeSection,
} from "../../forge-detail";
import { tabStripMove } from "../../tablist-keys";
import { useForgePages, useForgeRead, type ForgeReadState } from "../../use-forge-read";
import ForgeHtml, { renderForgeNodes } from "../ForgeHtml";
import { useForge, type ForgeSelection } from "./ForgeContext";
import { Ago, AgoIn, Badge, Copyable, FoldGroup, ListEnd, LoadingRows, OpenOnForge, Person, ReadFailure, StateMark } from "./ForgeParts";
import {
  CommitRow, DetailFrame, DetailPending, Faces, LabelsFact, PathDir, PeopleFact, SideFact, SideFacts, useDetailBar, useForgeNodes,
} from "./DetailParts";
import { ThreadList } from "./DetailThreads";
import IntegrationDetailBar from "../IntegrationDetailBar";

type Selection = Extract<ForgeSelection, { type: "change" }>;

const SECTIONS: readonly string[] = ["overview", "commits", "pipelines", "changes"] satisfies ChangeSection[];
const isSection = (v: string | null): v is ChangeSection => v != null && SECTIONS.includes(v);

export default function ChangeDetail({ selection }: { selection: Selection }) {
  const { kind, api, scope, refresh, recallSection, keepSection } = useForge();
  const bar = useDetailBar();
  const t = useT();
  const words = forgeNouns(kind, t);
  const params = { repo: selection.repo, number: selection.number };
  const read = useForgeRead<Change>(api, scope, "change", params, refresh);
  const c = read.data;
  // The pipelines are read with the page: the line under the title needs the
  // latest one's id, and the Pipelines tab draws the same answer.
  const wantsPipelines = !!c && (c.ci != null || c.counts.pipelines > 0);
  const pipelines = useForgeRead<ForgePipeline[]>(api, scope, wantsPipelines ? "change/pipelines" : null, params, refresh);
  // The section it was left on, when this is the page put back on reopening
  // the panel; a page the reader opens starts on the Overview.
  const [section, setSectionState] = useState<ChangeSection>(() => {
    const kept = recallSection();
    return isSection(kept) ? kept : "overview";
  });
  const setSection = (next: ChangeSection) => { setSectionState(next); keepSection(next); };
  const reference = c?.key ?? changeReference(kind, selection.repo, selection.number);
  const uid = useId();
  const sectionTabId = (id: ChangeSection) => `${uid}-tab-${id}`;
  const sectionPanelId = (id: ChangeSection) => `${uid}-panel-${id}`;
  const sections = c ? changeSections(kind, c.counts, t) : [];

  return (
    <DetailFrame label={`${words.change} ${reference}`}>
      <IntegrationDetailBar {...bar} reference={reference} copyLabel={t("forge.copy.reference")} href={c?.webUrl ?? null} />
      <DetailPending data={c} loading={read.loading} error={read.error} onRetry={read.reload} what={words.changeLc} />
      {c && (
        <>
          {read.error && <ReadFailure error={read.error} onRetry={read.reload} compact />}
          <ChangeHead change={c} pipelines={pipelines.data} />
          <div className="fd-layout">
            <ChangeSide change={c} />
            <div className="fd-main">
              {/* The page's tabs: one tab stop, the arrows between them (#581). */}
              <div
                className="uh-range fd-sections"
                role="tablist"
                aria-label={t("forge.change.sections", { change: words.change })}
                onKeyDown={event => {
                  const move = tabStripMove(event, sections.findIndex(s => s.id === section), sections.length);
                  if (move.kind === "pass") return;
                  event.preventDefault();
                  event.stopPropagation();
                  setSection(sections[move.index].id);
                  event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=tab]')[move.index]?.focus();
                }}
              >
                {sections.map(s => (
                  <button
                    key={s.id}
                    id={sectionTabId(s.id)}
                    type="button"
                    role="tab"
                    className="uh-range-btn"
                    aria-selected={section === s.id}
                    aria-controls={sectionPanelId(s.id)}
                    tabIndex={section === s.id ? 0 : -1}
                    onClick={() => setSection(s.id)}
                  >
                    <span className="fd-section-label">{s.label}</span>
                    <span className="fd-section-count">{formatNumber(s.count, 0)}</span>
                  </button>
                ))}
              </div>
              {/* A panel per section; only the chosen one is drawn, and reads. */}
              {sections.map(s => (
                <div key={s.id} className="fd-section" id={sectionPanelId(s.id)} role="tabpanel" aria-labelledby={sectionTabId(s.id)} hidden={section !== s.id}>
                  {section !== s.id ? null
                    : s.id === "overview" ? <Overview change={c} />
                    : s.id === "commits" ? <Commits selection={selection} />
                    : s.id === "pipelines" ? <Pipelines repo={selection.repo} read={pipelines} />
                    : <Files selection={selection} />}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </DetailFrame>
  );
}

function ChangeHead({ change: c, pipelines }: { change: Change; pipelines: ForgePipeline[] | null }) {
  const { kind, select } = useForge();
  const t = useT();
  const words = forgeNouns(kind, t);
  const draftShown = c.state === "open" && c.draft;
  const titleNodes = useForgeNodes(c.titleHtml, true);
  const title = titleNodes.length
    ? renderForgeNodes(draftShown ? nodesWithoutDraftPrefix(titleNodes) : titleNodes)
    : draftShown ? withoutDraftPrefix(c.title) : c.title;
  const latest = pipelines?.[0] ?? null;
  const pipelineId = pipelineIdFromUrl(c.ci?.webUrl) ?? latest?.id ?? null;
  const pipelineState = c.ci?.state ?? latest?.state ?? null;
  const approvals = approvalWords(c, t);
  const commits = commitsWords(c.counts.commits, t);
  return (
    <header className="fd-head">
      <h2 className="fd-title">{title}</h2>
      <p className="fd-byline">
        <Badge mark={changeStateMark(c)} />
        {c.author && <Person user={c.author} size={18} />}
        {kind === "github"
          ? (
            // GitHub's own sentence: "wants to merge 7 commits into main from
            // feature/login", and once merged, that the commits were merged.
            // Each language writes it around the two branches, so the
            // sentence is cut at {target} and {source}.
            <ByLine
              text={t(c.state === "merged"
                ? (commits ? "forge.change.gh.mergedCommits" : "forge.change.gh.merged")
                : (commits ? "forge.change.gh.wantsCommits" : "forge.change.gh.wants"), { commits: commits ?? "" })}
              target={c.targetBranch}
              source={c.sourceBranch}
              sourceLabel={t("forge.copy.sourceBranch")}
            />
          )
          : (
            <ByLine text={t("forge.change.gl.requested")} target={c.targetBranch} source={c.sourceBranch} sourceLabel={t("forge.copy.sourceBranch")} />
          )}
        {c.createdAt != null && <span className="fd-when">· <AgoIn at={c.createdAt} text={t("forge.when.created")} /></span>}
        {c.state === "merged" && c.mergedAt != null && <span className="fd-when">· <AgoIn at={c.mergedAt} text={t("forge.when.merged")} /></span>}
        {c.state === "closed" && c.closedAt != null && <span className="fd-when">· <AgoIn at={c.closedAt} text={t("forge.when.closed")} /></span>}
      </p>
      {(pipelineState || approvals) && (
        <ul className="fd-status">
          {pipelineState && (
            <li>
              {pipelineId
                ? (
                  <button type="button" className="fd-jump" onClick={() => select({ type: "pipeline", repo: c.repo, id: pipelineId })}>
                    <StateMark mark={ciMark(pipelineState)} />
                    <span>{words.pipeline} <code>#{pipelineId}</code></span>
                    <span className="fd-jump-arrow" aria-hidden="true">›</span>
                  </button>
                )
                : (
                  <span className="fd-status-line">
                    <StateMark mark={ciMark(pipelineState)} />
                    <OpenOnForge href={c.ci?.webUrl ?? null}>{t("forge.section.checks")}</OpenOnForge>
                  </span>
                )}
            </li>
          )}
          {approvals && (
            <li className="fd-status-line">
              <StateMark mark={approvals.mark} quiet />
              <span>{approvals.text}</span>
            </li>
          )}
        </ul>
      )}
    </header>
  );
}

/** The byline's sentence, cut where the two branches go: the words around
 *  {source} and {target} are the language's, the branches are code. */
function ByLine({ text, target, source, sourceLabel }: { text: string; target: string; source: string; sourceLabel: string }) {
  return (
    <>
      {text.split(/(\{target\}|\{source\})/).map((part, i) => {
        if (part === "{target}") return <code key={i} className="fd-branch">{target}</code>;
        if (part === "{source}") return <Copyable key={i} value={source} label={sourceLabel}><code className="fd-branch">{source}</code></Copyable>;
        const words = part.trim();
        return words ? <span key={i}>{words}</span> : null;
      })}
    </>
  );
}

function ChangeSide({ change: c }: { change: Change }) {
  const t = useT();
  return (
    <SideFacts label={t("forge.change.about")}>
      <SideFact label={t(c.assignees.length > 1 ? "forge.fact.assignees" : "forge.fact.assignee")}>
        <PeopleFact users={c.assignees} />
      </SideFact>
      <SideFact label={t(c.reviewers.length > 1 ? "forge.fact.reviewers" : "forge.fact.reviewer")}>
        <PeopleFact users={c.reviewers} extra={u => <StateMark className="fd-review" mark={reviewerMark((u as ForgeReviewer).state)} />} />
      </SideFact>
      {c.labels.length > 0 && <SideFact label={t("forge.fact.labels")}><LabelsFact labels={c.labels} /></SideFact>}
      {c.milestone && (
        <SideFact label={t("forge.fact.milestone")}>
          {c.milestone.webUrl
            ? <a className="fd-plain-link" href={c.milestone.webUrl} target="_blank" rel="noreferrer noopener">{c.milestone.title}</a>
            : c.milestone.title}
        </SideFact>
      )}
      {c.participants.length > 0 && (
        <SideFact label={t("forge.fact.participants", { n: formatNumber(c.participants.length, 0) })}>
          <Faces users={c.participants} />
        </SideFact>
      )}
    </SideFacts>
  );
}

function Overview({ change: c }: { change: Change }) {
  const t = useT();
  const nodes = useForgeNodes(c.descriptionHtml);
  const { unresolved, resolved, general } = splitDiscussions(c);
  const nothing = !unresolved.length && !resolved.length && !general.length;
  return (
    <>
      {nodes.length ? <ForgeHtml className="fd-description" nodes={nodes} /> : <p className="fd-none fd-description">{t("forge.noDescription")}</p>}
      <div className="fd-discussions">
        {nothing && <p className="fg-empty">{t("forge.change.noDiscussions")}</p>}
        {unresolved.length > 0 && (
          <FoldGroup id="change:unresolved" title={t("forge.threads.unresolved")} count={unresolved.length} defaultOpen>
            <ThreadList threads={unresolved} />
          </FoldGroup>
        )}
        {!unresolved.length && resolved.length > 0 && (
          <p className="fd-status-line fd-all-resolved"><StateMark mark={{ mark: "resolved", word: "All threads resolved", tone: "ok" }} /></p>
        )}
        {resolved.length > 0 && (
          <FoldGroup id="change:resolved" title={t("forge.threads.resolved")} count={resolved.length} defaultOpen={false}>
            <ThreadList threads={resolved} />
          </FoldGroup>
        )}
        {general.length > 0 && (
          <FoldGroup id="change:general" title={t("forge.threads.general")} count={general.length} defaultOpen={false}>
            <ThreadList threads={general} />
          </FoldGroup>
        )}
      </div>
    </>
  );
}

function Commits({ selection }: { selection: Selection }) {
  const { api, scope, refresh } = useForge();
  const t = useT();
  const pages = useForgePages<ForgeCommit>(api, scope, "change/commits", { repo: selection.repo, number: selection.number }, refresh);
  if (!pages.data) {
    return pages.error
      ? <ReadFailure error={pages.error} onRetry={pages.reload} />
      : <LoadingRows rows={4} label={t("forge.loadingNoun", { noun: t("forge.noun.commits") })} />;
  }
  return (
    <>
      {pages.error && <ReadFailure error={pages.error} onRetry={pages.reload} compact />}
      {pages.data.items.length
        ? <ul className="fd-items">{pages.data.items.map(cm => <CommitRow key={cm.sha} commit={cm} />)}</ul>
        : <p className="fg-empty">{t("forge.commits.none")}</p>}
      <ListEnd pages={pages} label={t("forge.commits.more")} />
    </>
  );
}

function Pipelines({ repo, read }: { repo: string; read: ForgeReadState<ForgePipeline[]> & { reload: () => void } }) {
  const { kind, select, selected } = useForge();
  const t = useT();
  const words = forgeNouns(kind, t);
  const runs = kind === "github" ? t("forge.noun.checks") : words.pipelinesLc;
  const none = t("forge.change.noRuns", { runs, change: words.changeLc });
  if (!read.data) {
    if (read.error) return <ReadFailure error={read.error} onRetry={read.reload} />;
    return read.loading ? <LoadingRows rows={3} label={t("forge.loadingNoun", { noun: runs })} /> : <p className="fg-empty">{none}</p>;
  }
  if (!read.data.length) return <p className="fg-empty">{none}</p>;
  return (
    <>
      {read.error && <ReadFailure error={read.error} onRetry={read.reload} compact />}
      <ul className="fg-rows fd-rows">
        {read.data.map(p => {
          const current = selected?.type === "pipeline" && selected.id === p.id;
          const time = durationWords(p.durationSec, t);
          return (
            <li key={p.id}>
              <button
                type="button"
                className="fg-row fd-pipe-row"
                aria-current={current || undefined}
                data-selected={current || undefined}
                onClick={() => select({ type: "pipeline", repo, id: p.id })}
              >
                <StateMark mark={ciMark(p.state)} />
                <span className="fd-pipe-id"><code>#{p.id}</code></span>
                <span className="fd-pipe-meta">
                  <code className="fd-branch" title={p.ref}>{shortRef(kind, p.ref)}</code>
                  <code>{p.shortSha}</code>
                  {p.title && <span className="fd-pipe-title">{p.title}</span>}
                </span>
                <span className="fd-pipe-when">
                  {time && <span>{time}</span>}
                  {p.createdAt != null && <Ago at={p.createdAt} />}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function Files({ selection }: { selection: Selection }) {
  const { api, scope, refresh } = useForge();
  const t = useT();
  const pages = useForgePages<ChangedFile>(api, scope, "change/files", { repo: selection.repo, number: selection.number }, refresh);
  if (!pages.data) {
    return pages.error
      ? <ReadFailure error={pages.error} onRetry={pages.reload} />
      : <LoadingRows rows={5} label={t("forge.loadingNoun", { noun: t("forge.noun.changedFiles") })} />;
  }
  return (
    <>
      {pages.error && <ReadFailure error={pages.error} onRetry={pages.reload} compact />}
      {pages.data.items.length
        ? <ul className="fd-files">{pages.data.items.map(f => <FileRow key={`${f.oldPath ?? ""}>${f.path}`} file={f} />)}</ul>
        : <p className="fg-empty">{t("forge.files.none")}</p>}
      <ListEnd pages={pages} label={t("forge.files.more")} />
    </>
  );
}

function FileRow({ file: f }: { file: ChangedFile }) {
  const t = useT();
  const status = fileStatusWord(f.status, t);
  const { dir, name } = pathParts(f.path);
  const body = (
    <>
      <span className="fd-file-path">
        {f.oldPath && f.oldPath !== f.path && (
          <span className="fd-file-old"><code>{f.oldPath}</code> <span aria-hidden="true">→</span><span className="fd-sr"> {t("forge.file.renamedTo")}</span> </span>
        )}
        <code><PathDir dir={dir} /><span className="fd-path-name">{name}</span></code>
      </span>
      <span className="fd-file-end">
        {status && <span className="fd-file-status" data-status={f.status}>{status}</span>}
        <span className="fd-diffstat" title={t("forge.file.diffstat", { added: formatNumber(f.additions, 0), removed: formatNumber(f.deletions, 0) })}>
          <span className="fd-add" data-zero={f.additions === 0 || undefined}>+{formatNumber(f.additions, 0)}</span>
          <span className="fd-del" data-zero={f.deletions === 0 || undefined}>−{formatNumber(f.deletions, 0)}</span>
        </span>
        {f.webUrl && <span className="fd-out-mark" aria-hidden="true">↗</span>}
      </span>
    </>
  );
  return (
    <li>
      {f.webUrl
        ? <a className="fd-file" href={f.webUrl} target="_blank" rel="noreferrer noopener">{body}</a>
        : <span className="fd-file">{body}</span>}
    </li>
  );
}
