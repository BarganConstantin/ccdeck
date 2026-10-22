// The small pieces the Jira panel draws in more than one place (#2178): an
// issue's type and priority icons, its epic chip in Jira's own colour, an
// estimate and a status. A failed read is the shared IntegrationFailureNote.
import { useEffect, useState, type ReactNode } from "react";
import type { JiraEpic, JiraIssue, JiraPriority, JiraStatus, JiraType, TimeTracking } from "../jira-api";
import { jiraDuration } from "../jira-board";

/** Icons that would not load, for the life of the page: a list of a hundred
 *  rows with the same broken icon asks the deck for it once. */
const failedIcons = new Set<string>();

/** An icon Jira serves (an issue type, a priority), through the deck's asset
 *  route; `fallback` (or nothing) when there is none or it will not load —
 *  which is every SVG, since the route serves raster images only. */
export function JiraIcon({ src, label, fallback, className = "jr-icon" }: {
  src: string | null | undefined; label: string; fallback?: ReactNode; className?: string;
}) {
  const [failed, setFailed] = useState(() => !src || failedIcons.has(src));
  useEffect(() => setFailed(!src || failedIcons.has(src)), [src]);
  if (!src || failed) return fallback ? <>{fallback}</> : <span className={className} title={label} aria-hidden />;
  return <img className={className} src={src} alt="" title={label} width={16} height={16} loading="lazy" decoding="async"
    referrerPolicy="no-referrer" draggable={false} onError={() => { failedIcons.add(src); setFailed(true); }} />;
}

type TypeShape = "bug" | "story" | "task" | "subtask" | "epic" | "other";

/** Which of Jira's standard issue types a name is, for the icon the panel
 *  draws itself when Jira's will not load. */
export function typeShape(name: string, subtask = false): TypeShape {
  const n = name.trim().toLowerCase();
  if (subtask || /^sub-?\s?task/.test(n)) return "subtask";
  if (/bug|defect|incident/.test(n)) return "bug";
  if (/story|feature|improvement|requirement/.test(n)) return "story";
  if (/epic/.test(n)) return "epic";
  if (/task|chore|spike|support|request/.test(n)) return "task";
  return "other";
}

const TYPE_MARKS: Record<TypeShape, ReactNode> = {
  bug: <circle className="jr-glyph-mark" cx="8" cy="8" r="2.6" />,
  story: <path className="jr-glyph-mark" d="M5.5 4h5v8L8 10.2 5.5 12z" />,
  task: <path className="jr-glyph-mark jr-glyph-stroke" d="m4.8 8.2 2.2 2.2 4.2-4.6" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />,
  subtask: <path className="jr-glyph-mark" d="M4.5 4.5h4.2v4.2H4.5zM7.3 7.3h4.2v4.2H7.3z" fillRule="evenodd" />,
  epic: <path className="jr-glyph-mark" d="M9 3 5 9h2.6L7 13l4-6H8.4z" />,
  other: <circle className="jr-glyph-mark" cx="8" cy="8" r="1.8" />,
};

/** An issue type as the panel draws it without Jira's icon: Jira's shapes —
 *  a bug's dot, a story's bookmark, a task's tick — in the type's hue. */
export function TypeGlyph({ type, subtask }: { type: JiraType; subtask?: boolean }) {
  const shape = type.epic ? "epic" : typeShape(type.name, subtask ?? type.subtask);
  return (
    <svg className="jr-icon jr-type-glyph" data-shape={shape} width="16" height="16" viewBox="0 0 16 16" role="img" aria-label={type.name}>
      <title>{type.name}</title>
      <rect className="jr-glyph-tile" x="1" y="1" width="14" height="14" rx="3" />
      {TYPE_MARKS[shape]}
    </svg>
  );
}

type PriorityLevel = "highest" | "high" | "medium" | "low" | "lowest";

/** A priority's place on Jira's five-step scale, under either of the names
 *  Jira has shipped (Highest…Lowest, and the older Blocker…Trivial). */
export function priorityLevel(name: string): PriorityLevel | null {
  const n = name.trim().toLowerCase();
  if (/highest|blocker|critical|urgent/.test(n)) return "highest";
  if (/high|major/.test(n)) return "high";
  if (/medium|normal|moderate/.test(n)) return "medium";
  if (/lowest|trivial/.test(n)) return "lowest";
  if (/low|minor/.test(n)) return "low";
  return null;
}

const PRIORITY_PATHS: Record<PriorityLevel, string> = {
  highest: "m4 8.5 4-4 4 4M4 12l4-4 4 4",
  high: "m4 10 4-4 4 4",
  medium: "M4 6h8M4 10h8",
  low: "m4 6 4 4 4-4",
  lowest: "m4 4 4 4 4-4M4 7.5l4 4 4-4",
};

/** A priority as Jira draws it, arrows up for urgent and down for not. */
export function PriorityGlyph({ priority }: { priority: JiraPriority }) {
  const level = priorityLevel(priority.name);
  if (!level) return <span className="jr-icon" title={`Priority: ${priority.name}`} aria-hidden />;
  return (
    <svg className="jr-icon jr-priority-glyph" data-level={level} width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label={`Priority: ${priority.name}`}>
      <title>{`Priority: ${priority.name}`}</title>
      <path d={PRIORITY_PATHS[level]} />
    </svg>
  );
}

export const TypeIcon = ({ type, subtask }: { type: JiraType; subtask?: boolean }) =>
  <JiraIcon src={type.icon} label={type.name} fallback={<TypeGlyph type={type} subtask={subtask} />} />;
export const PriorityIcon = ({ priority }: { priority: JiraPriority | null }) =>
  priority ? <JiraIcon src={priority.icon} label={`Priority: ${priority.name}`} fallback={<PriorityGlyph priority={priority} />} /> : <span className="jr-icon" aria-hidden />;

/** An epic, in the colour Jira gave it (1-14), or neutral when it gave none. */
export function EpicChip({ epic }: { epic: JiraEpic }) {
  return <span className="jr-epic ig-chip" data-color={epic.color ?? undefined} title={`Epic ${epic.key}: ${epic.name}`}>{epic.name}</span>;
}

/** Jira's status lozenge: grey for to do, blue for in progress, green for done,
 *  in sentence case and cut at 16 characters, with the whole name on hover. */
export function StatusLozenge({ status }: { status: JiraStatus }) {
  return <span className="jr-status ig-chip" data-cat={status.category} title={status.name}>{status.name}</span>;
}

/** What a row says about the work in it: the estimate and, when Jira has a
 *  different one, what remains — or story points on a board that counts them. */
export function Estimate({ issue, estimation, time }: { issue: JiraIssue; estimation: "time" | "points" | "count"; time: TimeTracking }) {
  if (estimation === "points") {
    return issue.points == null ? null : <span className="jr-estimate ig-chip" title="Story points">{Number.isInteger(issue.points) ? issue.points : issue.points.toFixed(1)}</span>;
  }
  const estimate = jiraDuration(issue.estimate, time);
  const remaining = issue.remaining != null && issue.remaining !== issue.estimate ? jiraDuration(issue.remaining, time) : "";
  if (!estimate && !remaining) return null;
  return (
    <span className="jr-estimate ig-chip" title={`${estimate ? `Original estimate ${estimate}` : "No original estimate"}${remaining ? ` · ${remaining} remaining` : ""}`}>
      {estimate || "–"}{remaining && <span className="jr-remaining"> · {remaining} left</span>}
    </span>
  );
}

export function FlagGlyph() {
  return <svg className="jr-flag" width="12" height="12" viewBox="0 0 14 14" fill="currentColor" stroke="currentColor" strokeWidth="1.2"
    strokeLinejoin="round" aria-hidden><path d="M3.5 12.5V1.8" fill="none" strokeLinecap="round" /><path d="M3.5 2.2h7l-1.6 2.9 1.6 2.9h-7z" /></svg>;
}

export function Chevron({ open }: { open: boolean }) {
  return <svg className="jr-chevron" data-open={open || undefined} width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor"
    strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m5.2 3 4 4-4 4" /></svg>;
}
