// The Pipelines tab (#2179) — Actions on GitHub: the latest pipelines of one
// project, or with "All projects" the latest of the ten most recently active
// ones, which the server merges into one list.
//
// A row reads the way GitLab's pipelines table does, left to right: the
// status as a mark and a word with how long it ran under it; the commit's
// title (on GitHub the run's title, its workflow named in the line below);
// the project first when the list is across projects, then the ref and short
// sha and what started it; then who started it and how long ago it finished.
import { useMemo } from "react";
import type { ForgeKind, ForgePipeline } from "../../forge-types";
import { forgeWords } from "../../forge-types";
import { ciMark, durationWords, matchesQuery } from "../../forge-panel";
import {
  emptyPipelinesWords, listPhase, moreLabel, noMatchWords, pipelineSourceWords, pipelineTitle, useReportFreshness,
} from "../../forge-lists";
import { useForgePages } from "../../use-forge-read";
import type { ForgeTabProps } from "./ForgePanel";
import { sameSelection, useForge } from "./ForgeContext";
import { Ago, ListEnd, LoadingRows, Person, ReadFailure, StateMark } from "./ForgeParts";

export default function PipelinesTab({ view, query }: ForgeTabProps) {
  const { kind, api, scope, refresh, reportFreshness } = useForge();
  const acrossRepos = view.repo == null;
  const read = useForgePages<ForgePipeline>(api, scope, "pipelines", { repo: view.repo ?? undefined }, refresh);
  useReportFreshness(reportFreshness, read);

  const items = useMemo(() => read.data?.items ?? [], [read.data]);
  const shown = useMemo(
    () => items.filter(p => matchesQuery({ title: p.title ?? "", name: p.ref, key: `${p.repo} ${p.shortSha}` }, query)),
    [items, query],
  );
  const phase = listPhase(read, items.length, shown.length);
  const noun = `${forgeWords[kind].pipeline.toLowerCase()}s`;

  return (
    <div className="fgl">
      {read.error && read.data && <ReadFailure error={read.error} onRetry={read.reload} compact />}
      {phase === "loading" && <LoadingRows label={`Loading ${noun}`} />}
      {phase === "failed" && read.error && <ReadFailure error={read.error} onRetry={read.reload} />}
      {phase === "empty" && <p className="fg-empty">{emptyPipelinesWords(kind, acrossRepos)}</p>}
      {phase === "no-match" && <p className="fg-empty">{noMatchWords(noun, query)}</p>}
      {phase === "rows" && (
        <div className="fgl-flat">
          <ul className="fg-rows">
            {shown.map(p => <PipelineRow key={`${p.repo}/${p.id}`} kind={kind} pipeline={p} acrossRepos={acrossRepos} />)}
          </ul>
        </div>
      )}
      {read.data && (
        <ListEnd pages={read} label={moreLabel(items.length, read.data.total)} />
      )}
    </div>
  );
}

function PipelineRow({ kind, pipeline: p, acrossRepos }: { kind: ForgeKind; pipeline: ForgePipeline; acrossRepos: boolean }) {
  const { selected, select } = useForge();
  const target = { type: "pipeline" as const, repo: p.repo, id: p.id };
  const isSelected = sameSelection(selected, target);
  const { workflow, title } = pipelineTitle(kind, p.title);
  const duration = durationWords(p.durationSec);
  const source = pipelineSourceWords(p.source);
  const running = p.state === "running" && p.startedAt != null && p.finishedAt == null;
  const at = p.finishedAt ?? p.createdAt;
  const who = p.triggeredBy ? p.triggeredBy.name || p.triggeredBy.login : null;
  return (
    <li>
      <button
        type="button"
        className="fg-row fgl-row fgl-pipeline"
        data-selected={isSelected || undefined}
        aria-current={isSelected || undefined}
        onClick={() => select(target)}
      >
        <span className="fgl-status"><StateMark mark={ciMark(p.state)} /></span>
        <span className="fgl-duration">
          {duration
            ? <><span className="fg-sr">ran for </span>{duration}</>
            : running && <>started <Ago at={p.startedAt} /></>}
        </span>
        <span className="fg-row-title fgl-title">
          <span className="fgl-title-text">{title ?? `${forgeWords[kind].pipeline} ${p.id}`}</span>
        </span>
        <span className="fg-meta fgl-meta">
          {acrossRepos && <><span className="fgl-repo-ref">{p.repo}</span> · </>}
          <BranchGlyph />
          <code>{p.ref}</code>
          {p.shortSha && <> · <code>{p.shortSha}</code></>}
          {workflow && <> · {workflow}</>}
          {source && <> · {source}</>}
        </span>
        <span className="fgl-side">
          {p.triggeredBy && <span title={who ?? undefined}><Person user={p.triggeredBy} size={20} nameless /></span>}
        </span>
        <span className="fgl-when">{at != null && <><span className="fgl-when-verb">{p.finishedAt != null ? "finished" : "created"} </span><Ago at={at} /></>}</span>
      </button>
    </li>
  );
}

function BranchGlyph() {
  return (
    <svg className="fgl-ref-glyph" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="5.5" r="1.5" />
      <path d="M4.5 5v6M11.5 7c0 3-7 2-7 4" />
    </svg>
  );
}
