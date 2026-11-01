// A branch, the way a row of GitLab's Branches page opens up (#2179): its
// name to copy, whether it is the default or protected, its latest commit,
// how far it has moved from the default branch, its latest pipeline, and the
// change it is the source of — or the forge's "Create merge request" page
// when there is none. Then the commits it has that the default branch does
// not.
import { useState } from "react";
import type { BranchDetail as Branch, ForgeRepo, Page } from "../../forge-types";
import { forgeNouns } from "../../forge-types";
import { changeBadge, ciMark, divergeCount, durationWords } from "../../forge-panel";
import { useT } from "../../i18n";
import { formatNumber } from "../../i18n/format";
import { newChangeUrl } from "../../forge-detail";
import { useForgeRead } from "../../use-forge-read";
import { useForge, type ForgeSelection } from "./ForgeContext";
import { Ago, Badge, Copyable, OpenOnForge, ReadFailure, StateMark } from "./ForgeParts";
import { CommitRow, DetailFrame, DetailHeading, DetailPending, useDetailBar } from "./DetailParts";
import IntegrationDetailBar from "../IntegrationDetailBar";

type Selection = Extract<ForgeSelection, { type: "branch" }>;

/** Past this many, the commits ahead wait behind "Show all". */
const COMMITS_SHOWN = 10;

export default function BranchDetail({ selection }: { selection: Selection }) {
  const { kind, api, scope, refresh } = useForge();
  const bar = useDetailBar();
  const t = useT();
  const read = useForgeRead<Branch>(api, scope, "branch", { repo: selection.repo, name: selection.name }, refresh);
  const d = read.data;
  return (
    <DetailFrame label={t("forge.branch.frame", { name: selection.name })}>
      <IntegrationDetailBar {...bar} reference={selection.repo} copyLabel={forgeNouns(kind, t).repoLc} href={d?.branch.webUrl ?? null} />
      <DetailPending data={d} loading={read.loading} error={read.error} onRetry={read.reload} what={t("forge.noun.branch")} />
      {d && (
        <>
          {read.error && <ReadFailure error={read.error} onRetry={read.reload} compact />}
          <BranchBody repo={selection.repo} detail={d} />
        </>
      )}
    </DetailFrame>
  );
}

/** "3 behind": the number in bold, the rest of the phrase from the catalog
 *  with {n} where the number goes. */
function Counted({ text, n }: { text: string; n: string }) {
  const [before, ...rest] = text.split("{n}");
  return <span>{before}<strong>{n}</strong>{rest.join("{n}")}</span>;
}

function BranchBody({ repo, detail }: { repo: string; detail: Branch }) {
  const { kind, api, scope, refresh, connection, select } = useForge();
  const t = useT();
  const words = forgeNouns(kind, t);
  const sigil = kind === "gitlab" ? "!" : "#";
  const b = detail.branch;
  // The default branch's name is the project's, not the branch's: the
  // project list (already read for the picker) says it, when it holds this one.
  const repos = useForgeRead<Page<ForgeRepo>>(api, scope, b.isDefault ? null : "repos", {}, refresh);
  const defaultName = repos.data?.items.find(r => r.path === repo)?.defaultBranch ?? null;
  const [allCommits, setAllCommits] = useState(false);
  const p = detail.pipeline;
  const pipelineTime = p ? durationWords(p.durationSec, t) : null;
  const defaultLabel = defaultName ?? t("forge.defaultBranch");
  const commits = allCommits ? detail.commitsAhead : detail.commitsAhead.slice(0, COMMITS_SHOWN);

  return (
    <>
      <header className="fd-head">
        <h2 className="fd-title fd-title-mono">
          <Copyable value={b.name} label={t("forge.copy.branchName")}><code>{b.name}</code></Copyable>
        </h2>
        {(b.isDefault || b.protected || b.stale) && (
          <p className="fd-byline">
            {b.isDefault && <span className="fg-badge">{t("forge.badge.default")}</span>}
            {b.protected && <span className="fg-badge">{t("forge.badge.protected")}</span>}
            {b.stale && <span className="fg-badge">{t("forge.badge.stale")}</span>}
          </p>
        )}
      </header>

      <dl className="fd-facts fd-facts-page">
        <div className="fd-fact">
          <dt>{t("forge.branch.latestCommit")}</dt>
          <dd>
            <ul className="fd-items fd-items-bare"><CommitRow commit={{ ...b.commit, authoredAt: b.commit.committedAt }} /></ul>
          </dd>
        </div>
        {!b.isDefault && (
          <div className="fd-fact">
            <dt>{t("forge.branch.comparedWith", { branch: defaultLabel })}</dt>
            <dd className="fd-diverge">
              <Counted text={t("forge.branch.behind")} n={divergeCount(b.behind)} />
              <span aria-hidden="true">·</span>
              <Counted text={t("forge.branch.ahead")} n={divergeCount(b.ahead)} />
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
                    <span><code>{sigil}{b.change.number}</code></span>
                    <span className="fd-jump-arrow" aria-hidden="true">›</span>
                  </button>
                )
                : <OpenOnForge href={newChangeUrl(kind, connection.baseUrl, repo, b.name)}>{t("forge.createChange", { change: words.changeLc })}</OpenOnForge>}
            </dd>
          </div>
        )}
      </dl>

      {!b.isDefault && (
        <section className="fd-block">
          <DetailHeading count={b.ahead ?? detail.commitsAhead.length}>{t("forge.branch.commitsNotIn", { branch: defaultLabel })}</DetailHeading>
          {detail.commitsAhead.length
            ? (
              <>
                <ul className="fd-items">{commits.map(c => <CommitRow key={c.sha} commit={c} />)}</ul>
                {!allCommits && detail.commitsAhead.length > COMMITS_SHOWN && (
                  <button type="button" className="btn fg-more" onClick={() => setAllCommits(true)}>
                    {t("forge.branch.showAll", { n: formatNumber(detail.commitsAhead.length, 0) })}
                  </button>
                )}
              </>
            )
            : <p className="fg-empty">{b.ahead === 0 ? t("forge.branch.allIn", { branch: defaultLabel }) : t("forge.branch.listedNone")}</p>}
        </section>
      )}
    </>
  );
}
