// A branch, the way a row of GitLab's Branches page opens up (#2179): its
// name to copy, whether it is the default or protected, its latest commit,
// how far it has moved from the default branch, its latest pipeline, and the
// change it is the source of — or the forge's "Create merge request" page
// when there is none. Then the commits it has that the default branch does
// not.
import { useState } from "react";
import type { BranchDetail as Branch, ForgeRepo, Page } from "../../forge-types";
import { forgeWords } from "../../forge-types";
import { changeBadge, ciMark, divergeCount, durationWords } from "../../forge-panel";
import { newChangeUrl } from "../../forge-detail";
import { useForgeRead } from "../../use-forge-read";
import { useForge, type ForgeSelection } from "./ForgeContext";
import { Ago, Badge, Copyable, OpenOnForge, ReadFailure, StateMark } from "./ForgeParts";
import { CommitRow, DetailBar, DetailFrame, DetailHeading, DetailPending } from "./DetailParts";

type Selection = Extract<ForgeSelection, { type: "branch" }>;

/** Past this many, the commits ahead wait behind "Show all". */
const COMMITS_SHOWN = 10;

export default function BranchDetail({ selection }: { selection: Selection }) {
  const { kind, api, scope, refresh } = useForge();
  const read = useForgeRead<Branch>(api, scope, "branch", { repo: selection.repo, name: selection.name }, refresh);
  const d = read.data;
  return (
    <DetailFrame label={`Branch ${selection.name}`}>
      <DetailBar reference={selection.repo} copyLabel={forgeWords[kind].repo.toLowerCase()} href={d?.branch.webUrl ?? null} />
      <DetailPending data={d} loading={read.loading} error={read.error} onRetry={read.reload} what="branch" />
      {d && (
        <>
          {read.error && <ReadFailure error={read.error} onRetry={read.reload} compact />}
          <BranchBody repo={selection.repo} detail={d} />
        </>
      )}
    </DetailFrame>
  );
}

function BranchBody({ repo, detail }: { repo: string; detail: Branch }) {
  const { kind, api, scope, refresh, connection, select } = useForge();
  const words = forgeWords[kind];
  const b = detail.branch;
  // The default branch's name is the project's, not the branch's: the
  // project list (already read for the picker) says it, when it holds this one.
  const repos = useForgeRead<Page<ForgeRepo>>(api, scope, b.isDefault ? null : "repos", {}, refresh);
  const defaultName = repos.data?.items.find(r => r.path === repo)?.defaultBranch ?? null;
  const [allCommits, setAllCommits] = useState(false);
  const p = detail.pipeline;
  const pipelineTime = p ? durationWords(p.durationSec) : null;
  const commits = allCommits ? detail.commitsAhead : detail.commitsAhead.slice(0, COMMITS_SHOWN);

  return (
    <>
      <header className="fd-head">
        <h2 className="fd-title fd-title-mono">
          <Copyable value={b.name} label="branch name"><code>{b.name}</code></Copyable>
        </h2>
        {(b.isDefault || b.protected || b.stale) && (
          <p className="fd-byline">
            {b.isDefault && <span className="fg-badge">default</span>}
            {b.protected && <span className="fg-badge">protected</span>}
            {b.stale && <span className="fg-badge">stale</span>}
          </p>
        )}
      </header>

      <dl className="fd-facts fd-facts-page">
        <div className="fd-fact">
          <dt>Latest commit</dt>
          <dd>
            <ul className="fd-items fd-items-bare"><CommitRow commit={{ ...b.commit, authoredAt: b.commit.committedAt }} /></ul>
          </dd>
        </div>
        {!b.isDefault && (
          <div className="fd-fact">
            <dt>Compared with {defaultName ?? "the default branch"}</dt>
            <dd className="fd-diverge">
              <span><strong>{divergeCount(b.behind)}</strong> behind</span>
              <span aria-hidden="true">·</span>
              <span><strong>{divergeCount(b.ahead)}</strong> ahead</span>
            </dd>
          </div>
        )}
        <div className="fd-fact">
          <dt>{words.pipeline}</dt>
          <dd>
            {p
              ? (
                <button type="button" className="fd-jump" onClick={() => select({ type: "pipeline", repo, id: p.id })}>
                  <StateMark mark={ciMark(p.state)} />
                  <span><code>#{p.id}</code></span>
                  {pipelineTime && <span className="fd-jump-meta">{pipelineTime}</span>}
                  {p.createdAt != null && <span className="fd-jump-meta"><Ago at={p.createdAt} /></span>}
                  <span className="fd-jump-arrow" aria-hidden="true">›</span>
                </button>
              )
              : b.ci
                ? <span className="fd-status-line"><StateMark mark={ciMark(b.ci.state)} /><OpenOnForge href={b.ci.webUrl} /></span>
                : <StateMark mark={ciMark("none")} />}
          </dd>
        </div>
        {!b.isDefault && (
          <div className="fd-fact">
            <dt>{words.change}</dt>
            <dd>
              {b.change
                ? (
                  <button type="button" className="fd-jump" onClick={() => select({ type: "change", repo, number: b.change!.number })}>
                    <Badge mark={changeBadge(b.change)} />
                    <span><code>{words.changeSigil}{b.change.number}</code></span>
                    <span className="fd-jump-arrow" aria-hidden="true">›</span>
                  </button>
                )
                : <OpenOnForge href={newChangeUrl(kind, connection.baseUrl, repo, b.name)}>Create {words.change.toLowerCase()}</OpenOnForge>}
            </dd>
          </div>
        )}
      </dl>

      {!b.isDefault && (
        <section className="fd-block">
          <DetailHeading count={b.ahead ?? detail.commitsAhead.length}>Commits not in {defaultName ?? "the default branch"}</DetailHeading>
          {detail.commitsAhead.length
            ? (
              <>
                <ul className="fd-items">{commits.map(c => <CommitRow key={c.sha} commit={c} />)}</ul>
                {!allCommits && detail.commitsAhead.length > COMMITS_SHOWN && (
                  <button type="button" className="btn fg-more" onClick={() => setAllCommits(true)}>
                    Show all {detail.commitsAhead.length.toLocaleString()}
                  </button>
                )}
              </>
            )
            : <p className="fg-empty">{b.ahead === 0 ? `Every commit here is already in ${defaultName ?? "the default branch"}.` : "The forge listed none."}</p>}
        </section>
      )}
    </>
  );
}
