// A GitLab pipeline or a GitHub Actions workflow run (#2179): its state, what
// it ran on (ref, commit, the change when it ran for one), who or what started
// it and how long it took; then its jobs by stage, each failed job with its
// reason, annotations and the end of its log (DetailJobs.tsx).
//
// A running pipeline is not followed: the panel reads, it does not poll. The
// toolbar's Refresh asks again.
import type { PipelineDetail as Pipeline } from "../../forge-types";
import { forgeNouns } from "../../forge-types";
import { ciMark, durationWords } from "../../forge-panel";
import { useT } from "../../i18n";
import { changeFromRef, changeReference, shortRef, sourceWords } from "../../forge-detail";
import { useForgeRead } from "../../use-forge-read";
import { useForge, type ForgeSelection } from "./ForgeContext";
import { AgoIn, Badge, Copyable, Person, ReadFailure, StateMark } from "./ForgeParts";
import { DetailFrame, DetailHeading, DetailPending, useDetailBar } from "./DetailParts";
import { JobStages } from "./DetailJobs";
import IntegrationDetailBar from "../IntegrationDetailBar";

type Selection = Extract<ForgeSelection, { type: "pipeline" }>;

export default function PipelineDetail({ selection }: { selection: Selection }) {
  const { kind, api, scope, refresh } = useForge();
  const bar = useDetailBar();
  const t = useT();
  const words = forgeNouns(kind, t);
  const read = useForgeRead<Pipeline>(api, scope, "pipeline", { repo: selection.repo, id: selection.id }, refresh);
  const p = read.data;
  return (
    <DetailFrame label={`${words.pipeline} #${selection.id}`}>
      <IntegrationDetailBar {...bar} reference={`${selection.repo} #${selection.id}`} copyValue={selection.id} copyLabel={t("forge.copy.pipelineId", { pipeline: words.pipelineLc })} href={p?.webUrl ?? null} />
      <DetailPending data={p} loading={read.loading} error={read.error} onRetry={read.reload} what={words.pipelineLc} />
      {p && (
        <>
          {read.error && <ReadFailure error={read.error} onRetry={read.reload} compact />}
          <PipelineHead pipeline={p} />
          <section className="fd-block">
            <DetailHeading count={p.jobs.length}>{t("forge.jobs.title")}</DetailHeading>
            <JobStages repo={p.repo} jobs={p.jobs} />
          </section>
        </>
      )}
    </DetailFrame>
  );
}

function PipelineHead({ pipeline: p }: { pipeline: Pipeline }) {
  const { kind, select } = useForge();
  const t = useT();
  const words = forgeNouns(kind, t);
  const changeNumber = changeFromRef(p.ref);
  const took = durationWords(p.durationSec, t);
  const source = sourceWords(p.source, t);
  return (
    <header className="fd-head">
      <h2 className="fd-title">{p.title || `${words.pipeline} #${p.id}`}</h2>
      <p className="fd-byline">
        <Badge mark={ciMark(p.state)} />
        {p.triggeredBy && <><span>{t("forge.pipe.startedBy")}</span><Person user={p.triggeredBy} size={18} /></>}
        {source && <span className="fd-when">· {source}</span>}
        {p.createdAt != null && <span className="fd-when">· <AgoIn at={p.createdAt} text={t("forge.when.created")} /></span>}
        {took
          ? <span className="fd-when">· {t("forge.pipe.took", { duration: took })}</span>
          : p.state === "running" && p.startedAt != null && <span className="fd-when">· <AgoIn at={p.startedAt} text={t("forge.when.started")} /></span>}
      </p>
      <ul className="fd-status">
        <li className="fd-status-line">
          <span className="fd-status-key">{t("forge.pipe.ranOn")}</span>
          <Copyable value={p.ref} label={t("forge.copy.ref")}><code className="fd-branch" title={p.ref}>{shortRef(kind, p.ref)}</code></Copyable>
          <Copyable value={p.sha} label={t("forge.copy.commitSha")}><code>{p.shortSha}</code></Copyable>
        </li>
        {changeNumber != null && (
          <li>
            <button type="button" className="fd-jump" onClick={() => select({ type: "change", repo: p.repo, number: changeNumber })}>
              <StateMark mark={{ mark: "linked", word: words.change, tone: "idle" }} quiet />
              <span>{words.change} <code>{changeReference(kind, "", changeNumber)}</code></span>
              <span className="fd-jump-arrow" aria-hidden="true">›</span>
            </button>
          </li>
        )}
      </ul>
    </header>
  );
}
