import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  layoutGraph, graphTones, rowDrawing, graphColumns, graphWidth, fixedSlot, isSeen, remoteBranch,
  parseSlotMemory, rememberSlots, repoSlots, historyAge, workDuration, conventionalPrefix,
  WIP_ID, ROW_H, type GraphRow, type LogCommit, type NodeShape, type RepoHead, type Tone,
} from "../git-graph-layout";
import { dismissesCard, historyKey } from "../git-graph-keys";
import { fitBranchWidth, monoWidth, type Measure } from "../git-branch-fit";
import { sessionHue } from "../session-hue";
import { placePopover } from "../popover-place";
import { readStored, writeStored } from "../storage";
import { copyText } from "../copy-text";
import { shortModel } from "../model-label";
import type { GraphFocus } from "../git-view-types";

export interface GitGraphProps {
  /** The repository's identity, for the colours it remembers. */
  repoKey: string;
  /** `/api/git/log`'s commits, the session's older ones (`outsideWindow`) last. */
  commits: LogCommit[];
  head: RepoHead | null;
  /** The first row: how many files git reports changed, and how many of them
   *  the focus edited; `label` names the focus ("3 by api-fix"). */
  uncommitted: { files: number; byFocus: number; label: string };
  focus: GraphFocus;
  /** The selected row: a SHA, or "uncommitted". */
  selected: string;
  onSelect: (id: string) => void;
  /** Enter or → on a row: into its files. */
  onOpen: (id: string) => void;
  /** `i` on a row an agent made, or a press on its agent chip. */
  onAgentCard: (sha: string) => void;
  /** Commits that arrived since the last render. */
  liveInsert: { newShas: string[] } | null;
  /** The name a canvas card goes by, for an agent the history knows only by
   *  its session; optional, the label the server sent is the fallback. */
  agentName?: (sessionId: string, agentId: string | null) => string | null;
}

/** Where the colours each repository's branches were given are kept. */
export const LANE_MEMORY_KEY = "agent-dag.gitLaneSlots";
/** How long a hover rests on an agent chip, or a keyboard focus on its row,
 *  before the card shows; within WARM_MS of one closing the next is instant. */
const HOVER_MS = 700;
const WARM_MS = 300;
/** The most rows a live insert slides; past it they move without motion. */
const FLIP_MAX = 20;
const EASE = "cubic-bezier(0.23, 1, 0.32, 1)";
/** The most ref chips a row shows before folding the rest into `+N`. */
const REF_CHIPS = 3;
/** A ref chip's widest box, as git-graph.css draws it, and under a 560px pane. */
const REF_ROOM = 230;
const REF_ROOM_NARROW = 120;
/** What the hidden label measuring one character says. */
const PROBE = "0123456789abcdefghij";

const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// ─── live insert ──────────────────────────────────────────────────────────

/** What one arrival of commits is known by: the commits themselves, so the
 *  same arrival handed in again is the same arrival; "" for none. */
export function liveInsertKey(live: GitGraphProps["liveInsert"]): string {
  return live && live.newShas.length ? live.newShas.join(" ") : "";
}

/**
 * Where a scrolled reader's list goes when commits arrive: the first row they
 * could see before stays where it was on screen, and the arrivals listed
 * above it are what the pill counts. `before` and `tops` are each row's top,
 * in pixels, before and after; `arrived` the new commits that are listed.
 */
export function keepReaderPlace(before: ReadonlyMap<string, number>, tops: ReadonlyMap<string, number>, arrived: readonly string[], scrollTop: number): { scrollTop: number; above: number } {
  const anchor = [...before].filter(([id]) => tops.has(id)).sort((a, b) => a[1] - b[1]).find(([, top]) => top + ROW_H > scrollTop);
  if (!anchor) return { scrollTop, above: arrived.length };
  const now = tops.get(anchor[0])!;
  return { scrollTop: scrollTop + (now - anchor[1]), above: arrived.filter(s => tops.get(s)! < now).length };
}

// ─── agent words ──────────────────────────────────────────────────────────

interface AgentView {
  level: "seen" | "matched" | "trailer";
  name: string;
  sub: boolean;
  hue: number | null;
  /** Not one of the focus's agents: the chip steps back. */
  quiet: boolean;
  cli: string;
  model: string | null;
  duration: string | null;
}

function agentView(c: LogCommit, focus: GraphFocus, agentName: GitGraphProps["agentName"]): AgentView | null {
  const a = c.agent;
  if (!a) return null;
  if (!isSeen(a)) {
    const name = a.agent === "codex" ? "Codex" : "Claude";
    return { level: "trailer", name, sub: false, hue: null, quiet: false, cli: name, model: null, duration: null };
  }
  const codex = a.kind === "codex";
  const name = agentName?.(a.sessionId, a.agentId) ?? a.label ?? a.agentType ?? (codex ? "Codex" : "Claude");
  const mine = a.sessionId === focus.sessionId && (focus.agentIds === null || focus.agentIds.includes(a.agentId ?? ""));
  const ms = a.durationMs ?? null;
  return {
    level: a.confidence, name, sub: a.agentId !== null, hue: sessionHue(a.sessionId), quiet: !mine,
    cli: codex ? "Codex" : "Claude Code", model: a.model ? shortModel(a.model) : null,
    duration: ms !== null && ms >= 1000 ? workDuration(ms) : null,
  };
}

const who = (v: AgentView) => `${v.sub ? "↳ " : ""}${v.name}`;

/** What a screen reader hears after a row's name, and what the hover card says. */
function agentSentence(v: AgentView): string {
  if (v.level === "trailer") return `${v.name}, from the commit message: ccdeck did not see this commit being made. Press i for actions.`;
  const how = v.level === "matched" ? "matched after an amend or a rebase" : "seen by ccdeck";
  const model = v.model ? `${v.cli}, ${v.model}.` : `${v.cli}.`;
  return `Made by ${who(v)}, ${how}. ${model}${v.duration ? ` Worked ${v.duration}.` : ""} Press i for actions.`;
}

const levelWords = (v: AgentView | null) => !v ? "No agent seen" : v.level === "trailer" ? `${v.name}, from the commit message` : `Made by ${who(v)}, ${v.level === "matched" ? "matched" : "seen by ccdeck"}`;

// ─── marks ────────────────────────────────────────────────────────────────

function Mark({ level }: { level: "seen" | "trailer" | "round" }) {
  return (
    <svg className="gv-mark" data-level={level} viewBox="0 0 10 10" width="10" height="10" aria-hidden="true" focusable="false">
      {level === "round" ? <circle cx="5" cy="5" r="3.2" /> : <path d="M5 0.9 9.1 5 5 9.1 0.9 5z" />}
    </svg>
  );
}

function CloudGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M4.3 10.6h5.8a2.3 2.3 0 0 0 .3-4.6 3.2 3.2 0 0 0-6.2.9 1.9 1.9 0 0 0 .1 3.7z" />
    </svg>
  );
}

function TagGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M2.2 2.6h4.4l5.2 5.2-4 4-5.4-5.2z" /><circle cx="4.7" cy="5.1" r=".7" />
    </svg>
  );
}

function UpGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M7 11.4V2.8M3.6 6.2 7 2.8l3.4 3.4" />
    </svg>
  );
}

// ─── one row's lanes ──────────────────────────────────────────────────────

const diamond = (x: number, y: number, r: number) => `M${x} ${y - r}L${x + r} ${y}L${x} ${y + r}L${x - r} ${y}Z`;

const RowLanes = memo(function RowLanes({ row, shape, focusKey, folded, width, isHead }: {
  row: GraphRow; shape: NodeShape; focusKey: string | null; folded: number; width: number; isHead: boolean;
}) {
  const d = useMemo(() => rowDrawing(row, shape, focusKey, folded), [row, shape, focusKey, folded]);
  const nodeDim = focusKey !== null && row.key !== focusKey;
  const cls = `gv-node${nodeDim ? " is-dim" : ""}`;
  const slot = row.slot + 1;
  let node: React.ReactNode;
  if (shape === "wip") node = <circle className="gv-wip-node" cx={d.x} cy={d.y} r="3.6" />;
  else if (d.folded) node = <circle className="gv-fold-node" cx={d.foldX} cy={d.y} r="2.6" />;
  else if (shape === "seen") node = <path className={`${cls} is-seen`} data-slot={slot} d={diamond(d.x, d.y, 5.2)} />;
  else if (shape === "trailer") node = <path className={`${cls} is-trailer`} data-slot={slot} d={diamond(d.x, d.y, 4.8)} />;
  else if (shape === "merge") node = <circle className={`${cls} is-merge`} data-slot={slot} cx={d.x} cy={d.y} r="4.2" />;
  else node = <circle className={`${cls} is-commit`} data-slot={slot} cx={d.x} cy={d.y} r="3.4" />;
  return (
    <svg className="gv-lanes" width={width} height={ROW_H} viewBox={`0 0 ${width} ${ROW_H}`} aria-hidden="true" focusable="false">
      {d.fold && <path className="gv-fold-line" d={`M${d.foldX} 0V${ROW_H}`} />}
      {d.strokes.map((s, i) => (
        <path key={i} className={`gv-e${s.dim ? " is-dim" : ""}${s.focus ? " is-focus" : ""}${s.wip ? " is-wip" : ""}`} data-slot={s.slot + 1} d={s.d} />
      ))}
      {node}
      {isHead && !d.folded && <circle className="gv-head-ring" cx={d.x} cy={d.y} r="7.6" />}
    </svg>
  );
});

// ─── ref chips ────────────────────────────────────────────────────────────

interface Chip {
  kind: "local" | "remote" | "tag" | "head";
  name: string;
  label: string;
  title: string;
  slot: number | null;
  head?: boolean;
  synced?: boolean;
}

function refChips(c: LogCommit, head: RepoHead | null, slotOf: (name: string) => number | null, room: number, measure: Measure | null): { chips: Chip[]; more: string[] } {
  const r = c.refs;
  const onHead = r.head && head !== null;
  const headBranch = onHead && head && !head.detached && head.branch && r.local.includes(head.branch) ? head.branch : null;
  const chips: Chip[] = [];
  // Each chip's words get the chip's widest box less its own chrome: the
  // padding and edge, the HEAD segment, a cloud, a remote's name.
  const fit = (name: string, chrome: number) => (measure ? fitBranchWidth(name, Math.max(48, room - chrome), measure) : name);
  if (onHead && !headBranch) chips.push({ kind: "head", name: "HEAD", label: "HEAD", title: "HEAD, detached: not on a branch", slot: null });
  const locals = headBranch ? [headBranch, ...r.local.filter(l => l !== headBranch)] : r.local;
  for (const name of locals) {
    const synced = r.remote.some(x => x === `origin/${name}`);
    const here = name === headBranch;
    const lines = [name];
    if (synced) lines.push(`origin/${name} is here too`);
    if (here) lines.push("checked out here (HEAD)");
    chips.push({ kind: "local", name, label: fit(name, 12 + (here ? 38 : 0) + (synced ? 15 : 0)), title: lines.join(" · "), slot: slotOf(name), head: here, synced });
  }
  for (const ref of r.remote) {
    const name = remoteBranch(ref);
    if (ref === `origin/${name}` && r.local.includes(name)) continue;
    const remote = ref.slice(0, ref.length - name.length);
    // The remote's name goes first when there is room for it; in a narrow
    // pane the cloud and the dashed edge say "remote" and the title names it.
    const withRemote = fit(name, 27 + (measure ? measure(remote) : remote.length * 6));
    const roomy = !measure || measure(`${remote}${withRemote}`) <= room - 27;
    chips.push({ kind: "remote", name: ref, label: roomy ? `${remote}${withRemote}` : fit(name, 27), title: `${ref}: remote-tracking branch, as of the last fetch`, slot: slotOf(name) });
  }
  for (const t of r.tags) chips.push({ kind: "tag", name: t, label: fit(t, 27), title: `tag ${t}`, slot: null });
  if (chips.length <= REF_CHIPS) return { chips, more: [] };
  return { chips: chips.slice(0, REF_CHIPS - 1), more: chips.slice(REF_CHIPS - 1).map(x => x.name) };
}

// ─── one row ──────────────────────────────────────────────────────────────

interface RowProps {
  rowId: string;
  row: GraphRow;
  commit: LogCommit | null;
  tone: Tone;
  selected: boolean;
  tabStop: boolean;
  isHead: boolean;
  focusKey: string | null;
  folded: number;
  width: number;
  agent: AgentView | null;
  head: RepoHead | null;
  slots: ReadonlyMap<string, number>;
  refRoom: number;
  /** One character of a ref chip's words, in pixels; 0 before it is read. */
  charPx: number;
  now: number;
  fresh: boolean;
  copied: boolean;
  uncommitted: GitGraphProps["uncommitted"];
  focusHue: number;
}

const HistoryRow = memo(function HistoryRow(p: RowProps) {
  const { commit: c, row, agent } = p;
  if (!c) {
    const { files, byFocus, label } = p.uncommitted;
    const name = files ? `Uncommitted, ${files} file${files === 1 ? "" : "s"}${byFocus ? `, ${byFocus} by ${label}` : ""}` : "Working tree clean";
    return (
      <div role="option" id={p.rowId} className={`gv-row is-wip${p.selected ? " is-sel" : ""}`} data-id={WIP_ID} data-tone="own"
        aria-selected={p.selected} tabIndex={p.tabStop ? 0 : -1} aria-label={name}>
        <span className="gv-cell-graph"><RowLanes row={row} shape="wip" focusKey={p.focusKey} folded={p.folded} width={p.width} isHead={false} /></span>
        <span className="gv-cell-subj">
          {files ? (
            <>
              <span className="gv-wip-label">Uncommitted</span>
              <span className="gv-wip-n">{files} file{files === 1 ? "" : "s"}</span>
              {byFocus > 0 && (
                <span className="gv-wip-mine" title={`${byFocus} by ${label}`} style={{ "--session-hue": p.focusHue } as React.CSSProperties}>
                  <i className="gv-swatch" /><span className="gv-wip-who">{byFocus} by {label}</span>
                </span>
              )}
            </>
          ) : <span className="gv-wip-label">Working tree clean</span>}
        </span>
        <span className="gv-cell-author" />
        <span className="gv-cell-sha" />
        <span className="gv-cell-time">now</span>
      </div>
    );
  }
  const shape: NodeShape = agent && agent.level !== "trailer" ? "seen" : agent ? "trailer" : row.kind === "merge" ? "merge" : "commit";
  const slotOf = (name: string) => fixedSlot(name) ?? p.slots.get(name) ?? null;
  const { chips, more } = refChips(c, p.head, slotOf, p.refRoom, p.charPx > 0 ? monoWidth(p.charPx) : null);
  const cc = p.tone === "own" ? conventionalPrefix(c.subject) : null;
  const seconds = (p.now - Date.parse(c.date)) / 1000;
  const age = Number.isFinite(seconds) ? historyAge(seconds) : "";
  const when = Number.isFinite(Date.parse(c.date)) ? new Date(c.date).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";
  const short = c.sha.slice(0, 7);
  const refWords = [...chips.map(x => (x.kind === "tag" ? `tag ${x.name}` : x.head ? `${x.name}, checked out` : x.name)), ...more].join(", ");
  const label = `${c.subject || "No subject"}. ${short}, ${c.author.name}${age ? `, ${age === "now" ? "just now" : `${age} ago`}` : ""}${refWords ? `. ${refWords}` : ""}. ${levelWords(agent)}${row.outside ? ". Older than the history above" : ""}`;
  const descId = agent ? `${p.rowId}-d` : undefined;
  return (
    <div role="option" id={p.rowId} className={`gv-row${p.selected ? " is-sel" : ""}${p.fresh ? " is-new" : ""}${row.outside ? " is-older" : ""}`}
      data-id={c.sha} data-tone={p.tone} data-head={p.isHead ? "" : undefined}
      aria-selected={p.selected} tabIndex={p.tabStop ? 0 : -1} aria-label={label} aria-describedby={descId}>
      <span className="gv-cell-graph">
        <RowLanes row={row} shape={shape} focusKey={p.focusKey} folded={p.folded} width={p.width} isHead={p.isHead} />
      </span>
      <span className="gv-cell-subj">
        {chips.map(x => (
          <span key={`${x.kind}:${x.name}`} className="gv-ref" data-slot={x.slot !== null ? x.slot + 1 : undefined} data-kind={x.kind} data-tone={p.tone} title={x.title}>
            {x.head && <span className="gv-ref-head">HEAD</span>}
            {x.kind === "remote" && <CloudGlyph />}
            {x.kind === "tag" && <TagGlyph />}
            <span className="gv-ref-name" title={x.title}>{x.label}</span>
            {x.synced && <span className="gv-ref-cloud"><CloudGlyph /></span>}
          </span>
        ))}
        {more.length > 0 && <span className="gv-ref" data-kind="more" data-tone={p.tone} title={more.join("\n")}>+{more.length}</span>}
        <span className="gv-subj" title={c.subject}>
          {cc ? <><b className="gv-cc">{cc.prefix}</b>{cc.rest}</> : c.subject || "No subject"}
        </span>
        {agent && (
          <span className={`gv-agent-chip${agent.quiet ? " is-quiet" : ""}`} data-level={agent.level === "trailer" ? "trailer" : "seen"}
            data-sha={c.sha} title={agent.level === "trailer" ? `${agent.name}, from the commit message` : `${who(agent)}, ${agent.level === "matched" ? "matched" : "seen by ccdeck"}`}
            style={agent.hue !== null ? ({ "--session-hue": agent.hue } as React.CSSProperties) : undefined}>
            {agent.hue !== null && <i className="gv-swatch" />}
            <span className="gv-agent-name">{who(agent)}</span>
          </span>
        )}
      </span>
      <span className="gv-cell-author" title={`${c.author.name} <${c.author.email}>`}>{c.author.name}</span>
      <span className="gv-cell-sha" data-copy={c.sha} title={`Copy ${c.sha}`}>{p.copied ? "copied" : short}</span>
      <span className="gv-cell-time" title={when}>{age}</span>
      {agent && <span id={descId} className="vis-hidden">{agentSentence(agent)}</span>}
    </div>
  );
});

/** What a commit row is handed for the counts only the uncommitted row says. */
const NO_UNCOMMITTED: GitGraphProps["uncommitted"] = { files: 0, byFocus: 0, label: "" };

// ─── the hover card ───────────────────────────────────────────────────────

interface HoverState { sha: string; anchor: Element; instant: boolean }

function HoverCard({ state, commit, agent, id }: { state: HoverState; commit: LogCommit; agent: AgentView; id: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const p = placePopover(state.anchor.getBoundingClientRect(), { width: el.offsetWidth, height: el.offsetHeight }, { width: window.innerWidth, height: window.innerHeight });
    setPos({ top: p.top, left: p.left });
  }, [state]);
  const level = agent.level === "trailer" ? "from the commit message" : agent.level === "matched" ? "matched" : "seen by ccdeck";
  return createPortal(
    <div ref={ref} id={id} role="tooltip" className={`gv-pop${pos ? " is-in" : ""}${state.instant ? " is-instant" : ""}`}
      style={pos ? { top: pos.top, left: pos.left } : { top: -9999, left: -9999 }}>
      <div className="gv-pop-head" style={agent.hue !== null ? ({ "--session-hue": agent.hue } as React.CSSProperties) : undefined}>
        {agent.hue !== null ? <i className="gv-swatch" /> : <Mark level="trailer" />}
        <b>{who(agent)}</b>
        <span className="gv-pop-level"><Mark level={agent.level === "trailer" ? "trailer" : "seen"} />{level}</span>
      </div>
      {agent.level === "trailer" ? (
        <p className="gv-pop-line">The message carries a <code>Co-authored-by: {agent.name}</code> trailer. ccdeck did not see this commit being made, so it cannot say which session or model.</p>
      ) : (
        <>
          {agent.level === "matched" && <p className="gv-pop-line">ccdeck saw {who(agent)} make a commit with this subject and author time; an amend or a rebase replaced it with this one.</p>}
          <dl className="gv-pop-dl">
            <dt>Model</dt><dd>{agent.cli}{agent.model ? ` · ${agent.model}` : ""}</dd>
            {agent.duration && <><dt>Worked</dt><dd>{agent.duration}</dd></>}
            <dt>Commit</dt><dd>{commit.sha.slice(0, 7)}</dd>
          </dl>
        </>
      )}
      <p className="gv-pop-foot"><kbd>i</kbd><span>or a click on the chip: Show on canvas, Copy SHA</span></p>
    </div>,
    document.body,
  );
}

// ─── the history ──────────────────────────────────────────────────────────

let instance = 0;

export default function GitGraph(props: GitGraphProps) {
  const { repoKey, commits, head, uncommitted, focus, selected, onSelect, onOpen, onAgentCard, liveInsert, agentName } = props;
  const uid = useMemo(() => `gvh${++instance}`, []);
  const listRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);

  // A detached HEAD with nothing changed has no working-tree row; anything
  // else does, clean or not.
  const showWip = !(head?.detached && uncommitted.files === 0);

  // The colours this repository's branches were given before, read once per
  // repository; what the layout hands out on top is written back below.
  const slotsRef = useRef<{ repo: string; slots: Map<string, number> } | null>(null);
  if (!slotsRef.current || slotsRef.current.repo !== repoKey) {
    slotsRef.current = { repo: repoKey, slots: repoSlots(parseSlotMemory(readStored(LANE_MEMORY_KEY)), repoKey) };
  }
  const layout = useMemo(
    () => layoutGraph(commits, { head, wip: showWip, slots: slotsRef.current!.slots }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [commits, head?.sha, head?.branch, head?.detached, showWip, repoKey],
  );
  useEffect(() => {
    slotsRef.current = { repo: repoKey, slots: layout.slots };
    if (!layout.assigned.length) return;
    const used = new Set(layout.rows.flatMap(r => [r.key, ...r.output.filter(Boolean).map(l => l!.key)]));
    const touched = [...layout.slots.keys()].filter(k => used.has(k) && !layout.assigned.includes(k)).concat(layout.assigned);
    writeStored(LANE_MEMORY_KEY, JSON.stringify(rememberSlots(parseSlotMemory(readStored(LANE_MEMORY_KEY)), repoKey, layout.slots, touched)));
  }, [layout, repoKey]);

  // Every answer the view folds in brings a new HEAD object and a new focus
  // object with the same words in them: the rows are handed what they say,
  // so a row the answer did not change keeps its render.
  const headWords = head ? `${head.sha}\u0000${head.branch}\u0000${head.detached}\u0000${head.unborn}` : "";
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableHead = useMemo(() => head, [headWords]);
  const focusIds = focus.agentIds === null ? null : focus.agentIds.join("\u0000");
  const tones = useMemo(() => graphTones(commits, stableHead), [commits, stableHead]);
  const byId = useMemo(() => new Map(commits.map(c => [c.sha, c])), [commits]);
  const focusKey = head && !head.detached ? layout.headKey : null;
  const { drawn, folded } = graphColumns(layout.columns);
  const width = graphWidth(drawn);
  const headSha = head?.sha ?? commits.find(c => c.refs.head)?.sha ?? null;
  const agents = useMemo(() => new Map(commits.map(c => [c.sha, agentView(c, focus, agentName)])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [commits, focus.sessionId, focusIds, agentName]);

  const ids = useMemo(() => layout.rows.map(r => r.id), [layout]);
  const tabStopId = ids.includes(selected) ? selected : ids[0];
  const firstOutside = layout.rows.findIndex(r => r.outside);

  // The minute the ages are counted from, kept for a minute.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);

  // The room a ref chip's words get, from the pane's width.
  const [refRoom, setRefRoom] = useState(REF_ROOM);
  useLayoutEffect(() => {
    const el = paneRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setRefRoom(e.contentRect.width <= 560 ? REF_ROOM_NARROW : REF_ROOM));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // One character of a ref chip's words, read once off a hidden label in the
  // chips' own font: every spelling of a branch is measured from it.
  const probeRef = useRef<HTMLSpanElement>(null);
  const [charPx, setCharPx] = useState(0);
  useLayoutEffect(() => {
    const el = probeRef.current;
    if (!el || !el.textContent) return;
    const w = el.getBoundingClientRect().width / el.textContent.length;
    if (w > 0) setCharPx(w);
  }, []);

  const rowEl = useCallback((id: string) => listRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`) ?? null, []);

  /** Bring a row into the list's view, at once: nearest edge, or centred. */
  const reveal = useCallback((id: string, center = false) => {
    const sc = listRef.current;
    const el = rowEl(id);
    if (!sc || !el) return;
    const top = el.offsetTop, h = el.offsetHeight;
    if (center) { sc.scrollTop = top - sc.clientHeight / 2 + h / 2; return; }
    if (top < sc.scrollTop) sc.scrollTop = top;
    else if (top + h > sc.scrollTop + sc.clientHeight) sc.scrollTop = top + h - sc.clientHeight;
  }, [rowEl]);

  // Opening: the selected row in view, centred (a detached HEAD lands in the
  // middle of the history, not on its edge).
  useLayoutEffect(() => {
    reveal(selected, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoKey]);
  // A selection made outside the list (the glance, a card) comes into view.
  const lastSelected = useRef(selected);
  useLayoutEffect(() => {
    if (lastSelected.current !== selected) reveal(selected);
    lastSelected.current = selected;
  }, [selected, reveal]);

  // ── hover card ──
  const [hover, setHover] = useState<HoverState | null>(null);
  const hoverTimer = useRef<number | null>(null);
  const lastClose = useRef(0);
  const clearHoverTimer = () => { if (hoverTimer.current !== null) { window.clearTimeout(hoverTimer.current); hoverTimer.current = null; } };
  const hideHover = useCallback(() => {
    clearHoverTimer();
    setHover(h => { if (h) lastClose.current = performance.now(); return null; });
  }, []);
  /** The card after the hover delay; one a key brought there appears at
   *  once, since nothing the keyboard does animates. */
  const showHoverSoon = useCallback((sha: string, anchor: Element, byKey = false) => {
    clearHoverTimer();
    const warm = performance.now() - lastClose.current < WARM_MS;
    if (warm) { setHover({ sha, anchor, instant: true }); return; }
    hoverTimer.current = window.setTimeout(() => {
      hoverTimer.current = null;
      if (anchor.isConnected) setHover({ sha, anchor, instant: byKey || reducedMotion() });
    }, HOVER_MS);
  }, []);
  useEffect(() => () => clearHoverTimer(), []);
  // Esc takes the card away first, wherever focus is, and leaves the view and
  // the focus where they were: content shown on hover or focus is dismissed
  // without moving either.
  useEffect(() => {
    if (!hover) return;
    const onKey = (e: KeyboardEvent) => {
      if (!dismissesCard(e) || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      hideHover();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [hover, hideHover]);
  // A new history may have taken the row the card hung off.
  useEffect(() => { hideHover(); }, [commits, hideHover]);

  // ── copy ──
  const [copied, setCopied] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(null), 1200);
    return () => window.clearTimeout(t);
  }, [copied]);

  // ── live insert ──
  const tops = useMemo(() => {
    const m = new Map<string, number>();
    ids.forEach((id, i) => m.set(id, i * ROW_H + (firstOutside >= 0 && i >= firstOutside ? ROW_H : 0)));
    return m;
  }, [ids, firstOutside]);
  const prevTops = useRef<Map<string, number> | null>(null);
  // An arrival is told apart by the commits it brought, never by the object
  // that carries them: the view around the list rebuilds that object on every
  // render, and each rebuild must not count the same commits again or replay
  // their glow. What had already arrived when the list mounted is not news.
  const liveKey = liveInsertKey(liveInsert);
  const handled = useRef(liveKey);
  const [newAbove, setNewAbove] = useState(0);
  const [settled, setSettled] = useState(liveKey);
  const fresh = useMemo(() => new Set(liveKey && liveKey !== settled ? liveInsert!.newShas : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [liveKey, settled]);
  useLayoutEffect(() => {
    const sc = listRef.current;
    const before = prevTops.current;
    prevTops.current = tops;
    if (!sc || !before || !liveKey || handled.current === liveKey) return;
    handled.current = liveKey;
    const arrived = liveInsert!.newShas.filter(s => tops.has(s));
    if (!arrived.length) return;
    if (sc.scrollTop > 0) {
      // A reader down the list stays on the row they were reading: nothing
      // moves, the list grows above them, and a pill says how much.
      const { scrollTop, above } = keepReaderPlace(before, tops, arrived, sc.scrollTop);
      sc.scrollTop = scrollTop;
      if (above) setNewAbove(n => n + above);
      return;
    }
    // At the top: the rows on screen that moved slide to their new place, and
    // nothing moves at all past FLIP_MAX rows or under reduced motion.
    if (reducedMotion()) return;
    const height = sc.clientHeight;
    const moved: Array<[HTMLElement, number]> = [];
    for (const [id, top] of tops) {
      const was = before.get(id);
      if (was === undefined || was === top || top > height || top + ROW_H < 0) continue;
      const el = rowEl(id);
      if (el) moved.push([el, was - top]);
    }
    if (moved.length > FLIP_MAX) return;
    for (const [el, dy] of moved) el.animate([{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }], { duration: 200, easing: EASE });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tops, liveKey, rowEl]);
  useEffect(() => {
    if (!liveKey || liveKey === settled) return;
    const t = window.setTimeout(() => setSettled(liveKey), 1100);
    return () => window.clearTimeout(t);
  }, [liveKey, settled]);

  const onScroll = useCallback(() => {
    hideHover();
    if (listRef.current && listRef.current.scrollTop <= 0) setNewAbove(0);
  }, [hideHover]);
  const toTop = useCallback(() => {
    const sc = listRef.current;
    if (!sc) return;
    sc.scrollTo({ top: 0, behavior: reducedMotion() ? "auto" : "smooth" });
    setNewAbove(0);
  }, []);

  // ── keys and pointer, for the whole list ──
  const focusRow = useCallback((id: string) => {
    const el = rowEl(id);
    if (el) { el.focus({ preventScroll: true }); reveal(id); }
  }, [rowEl, reveal]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-id]");
    const current = row?.dataset.id ?? selected;
    const at = ids.indexOf(current);
    const page = Math.max(1, Math.floor((listRef.current?.clientHeight ?? ROW_H * 10) / ROW_H) - 1);
    const move = historyKey(e, at, ids.length, page);
    if (move.kind === "pass") return;
    e.preventDefault();
    e.stopPropagation();
    hideHover();
    if (move.kind === "select") {
      const id = ids[move.index];
      if (id !== selected) onSelect(id);
      focusRow(id);
    } else if (move.kind === "open") {
      onOpen(current);
    } else if (move.kind === "card") {
      const c = byId.get(current);
      if (c && c.agent) onAgentCard(c.sha);
    }
  }, [ids, selected, onSelect, onOpen, onAgentCard, byId, focusRow, hideHover]);

  const onClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    const row = t.closest<HTMLElement>("[data-id]");
    if (!row) return;
    const id = row.dataset.id!;
    if (id !== selected) onSelect(id);
    const chip = t.closest<HTMLElement>(".gv-agent-chip");
    if (chip?.dataset.sha) { hideHover(); onAgentCard(chip.dataset.sha); return; }
    const sha = t.closest<HTMLElement>("[data-copy]")?.dataset.copy;
    if (sha) {
      void copyText(sha).then(ok => {
        if (!ok) return;
        setCopied(sha);
        setSaid(`Copied ${sha.slice(0, 7)}`);
      });
    }
  }, [selected, onSelect, onAgentCard, hideHover]);

  const onDoubleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (t.closest(".gv-agent-chip, [data-copy]")) return;
    const id = t.closest<HTMLElement>("[data-id]")?.dataset.id;
    if (id) onOpen(id);
  }, [onOpen]);

  const onPointerOver = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>(".gv-agent-chip");
    if (!chip || chip.contains(e.relatedTarget as Node | null) || !chip.dataset.sha) return;
    showHoverSoon(chip.dataset.sha, chip);
  }, [showHoverSoon]);
  const onPointerOut = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>(".gv-agent-chip");
    if (!chip || chip.contains(e.relatedTarget as Node | null)) return;
    hideHover();
  }, [hideHover]);
  const onFocus = useCallback((e: React.FocusEvent<HTMLDivElement>) => {
    const row = e.target as HTMLElement;
    const sha = row.dataset?.id;
    if (!sha || sha === WIP_ID || !byId.get(sha)?.agent) { hideHover(); return; }
    let visible = false;
    try { visible = row.matches(":focus-visible"); } catch { visible = false; }
    if (!visible) return;
    showHoverSoon(sha, row.querySelector(".gv-agent-chip") ?? row, true);
  }, [byId, showHoverSoon, hideHover]);

  const hoverCommit = hover ? byId.get(hover.sha) : undefined;
  const hoverAgent = hover ? agents.get(hover.sha) : null;
  const focusHue = sessionHue(focus.sessionId);

  return (
    <div className="gv-hist" ref={paneRef}>
      <div className="gv-pane-head">
        <span className="gv-pane-title">History</span>
        {folded > 0 && (
          <span className="gv-fold-chip" title={`${folded} more lanes folded into the last column; the checked-out branch keeps its own.`}>
            +{folded} lanes
          </span>
        )}
        <span className="gv-legend">
          <span><Mark level="seen" /><span className="gv-long">seen by ccdeck</span><span className="gv-short">seen</span></span>
          <span><Mark level="trailer" /><span className="gv-long">from the commit message</span><span className="gv-short">message</span></span>
          <span><Mark level="round" /><span className="gv-long">no agent seen</span><span className="gv-short">none</span></span>
        </span>
      </div>
      <div className="gv-graph-wrap">
        {newAbove > 0 && (
          <button type="button" className="gv-new-pill" onClick={toTop}>
            <UpGlyph /><span>{newAbove} new commit{newAbove === 1 ? "" : "s"}</span>
          </button>
        )}
        <div
          ref={listRef}
          className="gv-graph-scroll"
          role="listbox"
          aria-label="History"
          onKeyDown={onKeyDown}
          onClick={onClick}
          onDoubleClick={onDoubleClick}
          onPointerOver={onPointerOver}
          onPointerOut={onPointerOut}
          onFocus={onFocus}
          onBlur={hideHover}
          onScroll={onScroll}
        >
          {layout.rows.map((row, i) => {
            const c = row.id === WIP_ID ? null : byId.get(row.id) ?? null;
            const el = (
              <HistoryRow
                key={row.id}
                rowId={`${uid}-${row.id.slice(0, 12)}`}
                row={row}
                commit={c}
                tone={c ? tones.get(c.sha) ?? "off" : "own"}
                selected={row.id === selected}
                tabStop={row.id === tabStopId}
                isHead={!!c && c.sha === headSha}
                focusKey={focusKey}
                folded={folded}
                width={width}
                agent={c ? agents.get(c.sha) ?? null : null}
                head={stableHead}
                slots={layout.slots}
                refRoom={refRoom}
                charPx={charPx}
                now={now}
                fresh={!!c && fresh.has(c.sha)}
                copied={!!c && copied === c.sha}
                uncommitted={c ? NO_UNCOMMITTED : uncommitted}
                focusHue={focusHue}
              />
            );
            if (i !== firstOutside) return el;
            return (
              <React.Fragment key={`older:${row.id}`}>
                <div className="gv-older" role="presentation">Older commits from this session</div>
                {el}
              </React.Fragment>
            );
          })}
          {commits.length === 0 && (
            <div className="gv-graph-empty" role="presentation">
              <b>No commits yet.</b> {head?.branch ? <>{head.branch} has no history</> : <>This repository has no history</>}; the changed files wait for the first commit.
            </div>
          )}
        </div>
      </div>
      <span className="vis-hidden" aria-live="polite">{said}</span>
      <span ref={probeRef} className="gv-ref-probe" aria-hidden="true">{PROBE}</span>
      {hover && hoverCommit && hoverAgent && <HoverCard state={hover} commit={hoverCommit} agent={hoverAgent} id={`${uid}-pop`} />}
    </div>
  );
}
