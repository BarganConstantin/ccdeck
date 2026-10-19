// A pipeline's jobs and a job's log (#2179): the jobs grouped by stage in the
// order the pipeline runs them — a failed stage open, the quiet ones folded
// once there are many — and each job's failure reason, its annotations, and
// the end of its log on demand.
//
// THE LOG IS A TAIL, ASKED FOR. Nothing is read until "Show log": then the
// last 80 lines, then 200, then 500 (the deck's ceiling), and past that the
// forge's own page has the rest. The tail is drawn scrolled to its end, where
// a failure says why; asking for more lines keeps the reader's place, so the
// earlier lines arrive above what they were reading. A running job is not
// followed — the panel's Refresh asks again.
import { useLayoutEffect, useRef, useState } from "react";
import type { ForgeJob, LogTail } from "../../forge-types";
import { ciMark, durationWords } from "../../forge-panel";
import {
  annotationMark, jobStartsOpen, LOG_STEPS, logLineTone, nextLogLines, stagesOf, stageStartsOpen,
} from "../../forge-detail";
import { useForgeRead } from "../../use-forge-read";
import { useForge } from "./ForgeContext";
import { LoadingRows, OpenOnForge, ReadFailure, StateMark } from "./ForgeParts";
import { DetailFold } from "./DetailParts";

/** The jobs by stage. */
export function JobStages({ repo, jobs }: { repo: string; jobs: ForgeJob[] }) {
  const stages = stagesOf(jobs);
  if (!jobs.length) return <p className="fg-empty">This pipeline has no jobs.</p>;
  // A forge without stages (GitHub's check runs) is one list, not one fold.
  if (stages.length === 1 && stages[0].name == null) return <JobList repo={repo} jobs={jobs} />;
  return (
    <div className="fd-stages">
      {stages.map(stage => (
        <DetailFold
          key={stage.name ?? ""}
          title={stage.name ?? "Other jobs"}
          count={stage.jobs.length}
          startsOpen={stageStartsOpen(stage, jobs.length)}
          aside={<StateMark mark={ciMark(stage.state)} />}
        >
          <JobList repo={repo} jobs={stage.jobs} />
        </DetailFold>
      ))}
    </div>
  );
}

function JobList({ repo, jobs }: { repo: string; jobs: ForgeJob[] }) {
  return <ul className="fd-jobs">{jobs.map(j => <JobRow key={j.id} repo={repo} job={j} />)}</ul>;
}

function JobRow({ repo, job }: { repo: string; job: ForgeJob }) {
  const [open, setOpen] = useState(() => jobStartsOpen(job));
  const time = durationWords(job.durationSec);
  const bodyId = `fd-job-${job.id}`;
  return (
    <li className="fd-job" data-open={open || undefined}>
      <button type="button" className="fg-row fd-job-row" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(o => !o)}>
        <span className="fg-fold-chevron" aria-hidden="true" />
        <StateMark mark={ciMark(job.state)} />
        <span className="fd-job-name">{job.name}</span>
        {job.allowFailure && job.state === "failed" && <span className="fd-job-note">allowed to fail</span>}
        {time && <span className="fd-job-time">{time}</span>}
      </button>
      {open && (
        <div className="fd-job-body" id={bodyId}>
          {job.failureReason && <p className="fd-job-reason">{job.failureReason}</p>}
          {job.annotations.length > 0 && (
            <ul className="fd-annotations">
              {job.annotations.map((a, i) => (
                <li key={i}>
                  <StateMark mark={annotationMark(a.level)} />
                  {a.path && <code className="fd-ann-place">{a.line != null ? `${a.path}:${a.line}` : a.path}</code>}
                  {a.title && <strong className="fd-ann-title">{a.title}</strong>}
                  <span className="fd-ann-message">{a.message}</span>
                </li>
              ))}
            </ul>
          )}
          {job.logAvailable
            ? <JobLog repo={repo} job={job} />
            : <p className="fd-log-bar"><OpenOnForge href={job.webUrl}>Open the job</OpenOnForge></p>}
        </div>
      )}
    </li>
  );
}

function JobLog({ repo, job }: { repo: string; job: ForgeJob }) {
  const { api, scope, refresh } = useForge();
  const [lines, setLines] = useState<number | null>(null);
  const read = useForgeRead<LogTail>(api, scope, lines ? "job-log" : null, { repo, id: job.id, lines }, refresh);
  // The longer tail is a new read; the shorter one stays on screen until it lands.
  const last = useRef<LogTail | null>(null);
  if (read.data) last.current = read.data;
  const tail = read.data ?? (lines ? last.current : null);
  const pre = useRef<HTMLPreElement>(null);
  const fromEnd = useRef(0);

  useLayoutEffect(() => {
    const el = pre.current;
    if (el) el.scrollTop = el.scrollHeight - el.clientHeight - fromEnd.current;
    fromEnd.current = 0;
  }, [tail]);

  const more = nextLogLines(lines);
  const askMore = () => {
    const el = pre.current;
    fromEnd.current = el ? el.scrollHeight - el.clientHeight - el.scrollTop : 0;
    setLines(more);
  };
  const full = tail?.webUrl ?? job.webUrl;

  if (!lines) {
    return (
      <p className="fd-log-bar">
        <button type="button" className="btn" onClick={() => setLines(LOG_STEPS[0])}>Show log</button>
        <OpenOnForge href={full}>Full log</OpenOnForge>
      </p>
    );
  }
  return (
    <div className="fd-log-wrap">
      <p className="fd-log-bar">
        <span className="fd-log-count">
          {tail ? (tail.truncated ? `Last ${tail.lines.length.toLocaleString()} lines` : `All ${tail.lines.length.toLocaleString()} lines`) : "Log"}
        </span>
        {tail?.truncated && more && (
          <button type="button" className="btn" onClick={askMore} disabled={read.loading} aria-busy={read.loading}>
            {read.loading ? "Loading…" : "Show more lines"}
          </button>
        )}
        <OpenOnForge href={full}>Full log</OpenOnForge>
      </p>
      {read.error && (tail ? <ReadFailure error={read.error} onRetry={read.reload} compact /> : <ReadFailure error={read.error} onRetry={read.reload} />)}
      {!tail && !read.error && <LoadingRows rows={3} label="Loading the log" />}
      {tail && (
        tail.lines.length
          ? (
            // No tab stop of its own: the browser makes a scrolling box with
            // nothing focusable inside it reachable by the keyboard.
            <pre ref={pre} className="fd-log">
              {tail.lines.map((line, i) => {
                const tone = logLineTone(line);
                return <span key={i} className="fd-log-line" data-tone={tone ?? undefined}>{line || " "}</span>;
              })}
            </pre>
          )
          : <p className="fd-none">The log is empty.</p>
      )}
    </div>
  );
}
