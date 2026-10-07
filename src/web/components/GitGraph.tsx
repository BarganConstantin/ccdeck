import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  layoutGraph, graphTones, rowDrawing, onFocusLine, graphColumns, graphWidth, fixedSlot, isSeen, remoteBranch,
  parseSlotMemory, rememberSlots, repoSlots, historyAge, workDuration, conventionalPrefix,
  forkRowDrawing, forkLane, lookGraphWidth, DECK_GEOMETRY, FORK_GEOMETRY, FORK_DIAMOND, FORK_CHEVRON, FORK_LANE_OF_SLOT, VISIBLE_LANES,
  WIP_ID, ROW_H, type GraphLayout, type GraphRow, type LogCommit, type NodeShape, type RepoHead, type Tone,
} from "../git-graph-layout";
import { FkRefBadge, FkMoreBadge, fkRefChips, fkChipWords, fkMeasure, FK_REF_ROOM, FK_REF_ROOM_NARROW } from "./FkRefBadge";
import { FkAvatar } from "./FkAvatar";
import { forkDate, forkDateLong } from "../git-fork-date";
import { dismissesCard, historyKey } from "../git-graph-keys";
import { fitBranch } from "../git-chip";
import { monoMeasure, type Measure } from "../git-path-fit";
import { sessionHue } from "../session-hue";
import { placePopover } from "../popover-place";
import { readStored, writeStored } from "../storage";
import { copyText } from "../copy-text";
import { shortModel } from "../model-label";
import type { GitLook, GraphFocus } from "../git-view-types";

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
  /** Draw only the first this many commits (the uncommitted row aside), for
   *  a first frame: the graph is still laid out on every commit, so its
   *  width, its fold and every row drawn are the ones the whole history
   *  gets. Omitted, every row is drawn. */
  rowLimit?: number;
  /** The branch the repository's remote calls its default (`/api/git/repo`'s
   *  `defaultBranch`): a trunk HEAD's branch is measured against, ranked
   *  with develop. Optional; the usual trunk names stand without it. */
  defaultBranch?: string | null;
  /** "fork" draws Fork's history: its rows, columns, graph, badges and dots,
   *  and no uncommitted row, pane head or legend. "deck" when omitted. */
  look?: GitLook;
  /** Fork look: the list holds the keyboard in a window that has focus, so
   *  its selection is the accent pill rather than the grey one. */
  listFocused?: boolean;
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
/** A ref chip's words: `font: 600 10px var(--font-mono)` (git-graph.css). */
const REF_PX = 10;
const REF_WEIGHT = 600;

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

const RowLanes = memo(function RowLanes({ row, shape, focusKey, folded, width, isHead, noWip }: {
  row: GraphRow; shape: NodeShape; focusKey: string | null; folded: number; width: number; isHead: boolean;
  /** The uncommitted row is not drawn: neither is its dashed line to HEAD. */
  noWip: boolean;
}) {
  const d = useMemo(() => rowDrawing(row, shape, focusKey, folded), [row, shape, focusKey, folded]);
  const strokes = noWip ? d.strokes.filter(s => !s.wip) : d.strokes;
  const nodeDim = focusKey !== null && !onFocusLine(row, focusKey);
  const cls = `gv-node${nodeDim ? " is-dim" : ""}`;
  const slot = row.slot + 1;
  let node: React.ReactNode;
  if (shape === "wip") node = <circle className="gv-wip-node" cx={d.x} cy={d.y} r="3.6" />;
  // A folded agent commit keeps its diamond, in the fold's grey: a round dot
  // there would read as "no agent seen".
  else if (d.folded && shape === "seen") node = <path className="gv-fold-node is-seen" d={diamond(d.foldX, d.y, 4.2)} />;
  else if (d.folded && shape === "trailer") node = <path className="gv-fold-node is-trailer" d={diamond(d.foldX, d.y, 4.2)} />;
  else if (d.folded) node = <circle className="gv-fold-node" cx={d.foldX} cy={d.y} r="2.6" />;
  else if (shape === "seen") node = <path className={`${cls} is-seen`} data-slot={slot} d={diamond(d.x, d.y, 5.2)} />;
  else if (shape === "trailer") node = <path className={`${cls} is-trailer`} data-slot={slot} d={diamond(d.x, d.y, 4.8)} />;
  else if (shape === "merge") node = <circle className={`${cls} is-merge`} data-slot={slot} cx={d.x} cy={d.y} r="4.2" />;
  else node = <circle className={`${cls} is-commit`} data-slot={slot} cx={d.x} cy={d.y} r="3.4" />;
  return (
    <svg className="gv-lanes" width={width} height={ROW_H} viewBox={`0 0 ${width} ${ROW_H}`} aria-hidden="true" focusable="false">
      {d.fold && <path className="gv-fold-line" d={d.fold} />}
      {strokes.map((s, i) => (
        <path key={i} className={`gv-e${s.dim ? " is-dim" : ""}${s.focus ? " is-focus" : ""}${s.wip ? " is-wip" : ""}`} data-slot={s.slot + 1} d={s.d} />
      ))}
      {node}
      {isHead && !d.folded && <circle className="gv-head-ring" cx={d.x} cy={d.y} r="7.6" />}
    </svg>
  );
});

// ─── ref chips ────────────────────────────────────────────────────────────

export interface Chip {
  kind: "local" | "remote" | "tag" | "head";
  name: string;
  label: string;
  title: string;
  slot: number | null;
  head?: boolean;
  synced?: boolean;
}

/**
 * A commit's ref chips, each name cut to the room its chip gets the way the
 * card's branch chip cuts it (git-chip.ts: the ticket whole, cuts between the
 * characters a reader sees) and measured the way it is measured — in the
 * chip's own font, so wide characters and emoji count as wide as they draw.
 * `measure` is null before the page can measure: names go whole, for the
 * sheet's ellipsis.
 */
export function refChips(c: LogCommit, head: RepoHead | null, slotOf: (name: string) => number | null, room: number, measure: Measure | null): { chips: Chip[]; more: string[] } {
  const r = c.refs;
  const onHead = r.head && head !== null;
  const headBranch = onHead && head && !head.detached && head.branch && r.local.includes(head.branch) ? head.branch : null;
  const chips: Chip[] = [];
  // Each chip's words get the chip's widest box less its own chrome: the
  // padding and edge, the HEAD segment, a cloud, a remote's name.
  const fit = (name: string, chrome: number) => {
    const max = Math.max(48, room - chrome);
    return measure ? fitBranch(name, text => measure(text) <= max) : name;
  };
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
    // The remote's name goes first when there is room for it beside the
    // branch's own words, never by cutting them further; in a narrow pane
    // the cloud and the dashed edge say "remote" and the title names it.
    const alone = fit(name, 27);
    const roomy = !measure || (fit(name, 27 + measure(remote)) === alone && measure(`${remote}${alone}`) <= room - 27);
    chips.push({ kind: "remote", name: ref, label: roomy ? `${remote}${alone}` : alone, title: `${ref}: remote-tracking branch, as of the last fetch`, slot: slotOf(name) });
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
  /** The uncommitted row is not drawn (a clean detached HEAD). */
  noWip: boolean;
  agent: AgentView | null;
  head: RepoHead | null;
  slots: ReadonlyMap<string, number>;
  refRoom: number;
  /** Measures a ref chip's words in its font; null before the page can. */
  measure: Measure | null;
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
        <span className="gv-cell-graph"><RowLanes row={row} shape="wip" focusKey={p.focusKey} folded={p.folded} width={p.width} isHead={false} noWip={false} /></span>
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
  const { chips, more } = refChips(c, p.head, slotOf, p.refRoom, p.measure);
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
        <RowLanes row={row} shape={shape} focusKey={p.focusKey} folded={p.folded} width={p.width} isHead={p.isHead} noWip={p.noWip} />
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

function HoverCard({ state, commit, agent, id, look }: { state: HoverState; commit: LogCommit; agent: AgentView; id: string; look: GitLook }) {
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
    <div ref={ref} id={id} role="tooltip" className={`gv-pop${pos ? " is-in" : ""}${state.instant ? " is-instant" : ""}`} data-look={look === "fork" ? "fork" : undefined}
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

// ─── the Fork look's row ──────────────────────────────────────────────────

/** A node in the Fork look, at (x, y): a filled dot, a ring with a chevron for
 *  a merge, a filled or hollow diamond for an agent's commit. `cased` draws
 *  the casing under it instead, the list's own colour 1px wider all round. */
function forkNode(shape: NodeShape, x: number, y: number, cls: string, lane: number | undefined, cased: boolean): React.ReactNode {
  const pad = cased ? 1 : 0;
  if (shape === "merge") {
    const [ax, ay, bx, by, cx, cy] = FORK_CHEVRON.split(" ").map(Number);
    return (
      <>
        <circle className={`${cls} is-merge`} data-lane={lane} cx={x} cy={y} r={FORK_GEOMETRY.ring} />
        <path className={`${cls} is-chevron`} data-lane={lane} d={`M${x + ax} ${y + ay}L${x + bx} ${y + by}L${x + cx} ${y + cy}`} />
      </>
    );
  }
  if (shape === "seen") return <path className={`${cls} is-seen`} data-lane={lane} d={diamond(x, y, FORK_DIAMOND)} />;
  if (shape === "trailer") return <path className={`${cls} is-trailer`} data-lane={lane} d={diamond(x, y, FORK_DIAMOND)} />;
  return <circle className={`${cls} is-commit`} data-lane={lane} cx={x} cy={y} r={FORK_GEOMETRY.dot + pad} />;
}

const FkRowLanes = memo(function FkRowLanes({ row, shape, focusKey, folded, width, noWip, cased, maskId }: {
  row: GraphRow; shape: NodeShape; focusKey: string | null; folded: number; width: number; noWip: boolean;
  /** On the selected row's pill every line and node sits on a casing in the
   *  list's colour, so each keeps its contrast on the list's colour whatever
   *  the pill under it. */
  cased: boolean;
  /** Unique in the page: the mask that keeps lines out of a ring's hollow. */
  maskId: string;
}) {
  const d = useMemo(() => forkRowDrawing(row, shape, focusKey, folded), [row, shape, focusKey, folded]);
  const strokes = noWip ? d.strokes.filter(s => !s.wip) : d.strokes;
  const H = FORK_GEOMETRY.rowH;
  const nx = d.folded ? d.foldX : d.x;
  const lane = d.folded ? undefined : forkLane(row, focusKey);
  const nodeCls = d.folded ? "fk-node is-fold" : "fk-node";
  const ring = shape === "merge";
  const lines = (cls: string) => (
    <g className={cls} mask={ring ? `url(#${maskId})` : undefined}>
      {d.fold && <path className="fk-fold-line" d={d.fold} />}
      {strokes.map((s, i) => <path key={i} className="fk-e" data-lane={s.focus ? 0 : FORK_LANE_OF_SLOT[s.slot]} d={s.d} />)}
    </g>
  );
  return (
    <svg className="fk-lanes" width={width} height={H} viewBox={`0 0 ${width} ${H}`} aria-hidden="true" focusable="false">
      {ring && (
        <defs>
          <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width={width} height={H}>
            <rect width={width} height={H} fill="white" />
            <circle cx={nx} cy={d.y} r={FORK_GEOMETRY.ring - FORK_GEOMETRY.line / 2} fill="black" />
          </mask>
        </defs>
      )}
      {cased && <g className="fk-case">{lines("fk-case-lines")}{forkNode(shape, nx, d.y, nodeCls, lane, true)}</g>}
      {lines("fk-lines")}
      {forkNode(shape, nx, d.y, nodeCls, lane, false)}
    </svg>
  );
});

function ReturnMark() {
  return (
    <svg className="fk-ret" width="9" height="7" viewBox="0 0 9 7" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M8.2.7v2.3c0 .8-.6 1.4-1.4 1.4H1.3M3.2 2.5 1.3 4.4l1.9 1.9" />
    </svg>
  );
}

interface FkRowProps {
  rowId: string;
  row: GraphRow;
  commit: LogCommit;
  tone: Tone;
  selected: boolean;
  tabStop: boolean;
  isHead: boolean;
  focusKey: string | null;
  folded: number;
  width: number;
  noWip: boolean;
  agent: AgentView | null;
  head: RepoHead | null;
  refRoom: number;
  /** Measures a badge's words in its font; null before the page can. */
  measure: ((text: string, bold: boolean) => number) | null;
  now: number;
  fresh: boolean;
  /** The date column is hidden: its words go in the row's title. */
  dateInTitle: boolean;
}

/** A Fork row's words: 13px (git-graph-fork.css). */
const FK_ROW_PX = 13;

/** The row's dot before its badges, and its words: a commit HEAD has and its
 *  upstream does not, or one HEAD cannot reach. */
const DOT_WORDS = { unpushed: "Not pushed yet", incoming: "Not on the checked-out branch's history" } as const;

const FkHistoryRow = memo(function FkHistoryRow(p: FkRowProps) {
  const { commit: c, row, agent } = p;
  // A merge keeps Fork's ring whoever made it; its chip says who.
  const shape: NodeShape = row.kind === "merge" ? "merge" : agent && agent.level !== "trailer" ? "seen" : agent ? "trailer" : "commit";
  const { chips, more } = fkRefChips(c, p.head, p.refRoom, p.measure);
  const cc = conventionalPrefix(c.subject);
  const date = forkDate(c.date, p.now);
  const long = forkDateLong(c.date);
  const short = c.sha.slice(0, 7);
  const dot = p.tone === "off" ? "incoming" : c.unpushed ? "unpushed" : null;
  const refWords = [...chips.map(fkChipWords), ...more].join(", ");
  const label = `${c.subject || "No subject"}. ${short}, ${c.author.name}${date ? `, ${date}` : ""}${refWords ? `. ${refWords}` : ""}. ${levelWords(agent)}${dot ? `. ${DOT_WORDS[dot]}` : ""}${row.outside ? ". Older than the history above" : ""}`;
  const descId = agent ? `${p.rowId}-d` : undefined;
  return (
    <div role="option" id={p.rowId} className={`fk-row${p.selected ? " is-sel" : ""}${p.fresh ? " is-new" : ""}${p.isHead ? " is-head" : ""}`}
      data-id={c.sha} data-tone={p.tone} data-head={p.isHead ? "" : undefined}
      aria-selected={p.selected} tabIndex={p.tabStop ? 0 : -1} aria-label={label} aria-describedby={descId}
      title={p.dateInTitle && long ? long : undefined}>
      <span className="fk-cell-graph">
        <FkRowLanes row={row} shape={shape} focusKey={p.focusKey} folded={p.folded} width={p.width} noWip={p.noWip} cased={p.selected} maskId={`${p.rowId}-ring`} />
      </span>
      <span className="fk-cell-subj">
        {dot && <i className="fk-dot" data-kind={dot} title={DOT_WORDS[dot]} />}
        {(chips.length > 0 || more.length > 0) && (
          <span className="fk-refs" data-lane={forkLane(row, p.focusKey)}>
            {chips.map(x => <FkRefBadge key={`${x.kind}:${x.name}`} chip={x} />)}
            {more.length > 0 && <FkMoreBadge names={more} />}
          </span>
        )}
        <span className="fk-subj" title={c.subject}>
          {cc ? <><b className="fk-cc">{cc.prefix}</b>{cc.rest}</> : c.subject || "No subject"}
        </span>
        {c.hasBody && <ReturnMark />}
        {agent && (
          <span className="gv-agent-chip fk-chip" data-level={agent.level === "trailer" ? "trailer" : "seen"} data-quiet={agent.quiet ? "" : undefined}
            data-sha={c.sha} title={agent.level === "trailer" ? `${agent.name}, from the commit message` : `${who(agent)}, ${agent.level === "matched" ? "matched" : "seen by ccdeck"}`}
            style={agent.hue !== null ? ({ "--session-hue": agent.hue } as React.CSSProperties) : undefined}>
            {agent.hue !== null && <i className="gv-swatch fk-swatch" />}
            <span className="gv-agent-name">{who(agent)}</span>
          </span>
        )}
      </span>
      <span className="fk-cell-author" title={`${c.author.name} <${c.author.email}>`}>
        <FkAvatar name={c.author.name} email={c.author.email} size="row" />
        <span className="fk-author-name">{c.author.name}</span>
      </span>
      <span className="fk-cell-sha">{short}</span>
      <span className="fk-cell-date" title={long}>{date}</span>
      {agent && <span id={descId} className="vis-hidden">{agentSentence(agent)}</span>}
    </div>
  );
});

/**
 * The layout the Fork look draws: lanes where Fork would start them, with no
 * column held for an uncommitted row — unless that would put HEAD's own line
 * in the fold of a busy repository, where it would be lost; then the column
 * is held for it after all, as the deck look always holds it, and a merge
 * that takes HEAD in runs down that column to it.
 */
export function forkLayout(commits: readonly LogCommit[], head: RepoHead | null, slots: ReadonlyMap<string, number>, defaultBranch: string | null): GraphLayout {
  const bare = layoutGraph(commits, { head, wip: false, slots, defaultBranch });
  const { folded } = graphColumns(bare.columns);
  const at = bare.rows.find(r => r.id === head?.sha) ?? bare.rows.find(r => byRefs(commits, r.id));
  if (!folded || !at || at.col < VISIBLE_LANES) return bare;
  return layoutGraph(commits, { head, wip: true, wipHidden: true, slots, defaultBranch });
}
const byRefs = (commits: readonly LogCommit[], sha: string) => commits.some(c => c.sha === sha && c.refs.head && !c.outsideWindow);

// ─── the history ──────────────────────────────────────────────────────────

let instance = 0;

export default function GitGraph(props: GitGraphProps) {
  const { repoKey, commits, head, uncommitted, focus, selected, onSelect, onOpen, onAgentCard, liveInsert, agentName, rowLimit, defaultBranch = null, look = "deck", listFocused } = props;
  const uid = useMemo(() => `gvh${++instance}`, []);
  const listRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const fork = look === "fork";
  const geo = fork ? FORK_GEOMETRY : DECK_GEOMETRY;

  // A detached HEAD with nothing changed has no working-tree row; anything
  // else does, clean or not. The graph is laid out with it either way, so
  // HEAD keeps the first column and never folds away in a busy repository;
  // without it, the column above HEAD is left blank. The Fork look has no
  // such row: the working tree is the sidebar's Local Changes.
  const showWip = !fork && !(head?.detached && uncommitted.files === 0);

  // The colours this repository's branches were given before, read once per
  // repository; what the layout hands out on top is written back below.
  const slotsRef = useRef<{ repo: string; slots: Map<string, number> } | null>(null);
  if (!slotsRef.current || slotsRef.current.repo !== repoKey) {
    slotsRef.current = { repo: repoKey, slots: repoSlots(parseSlotMemory(readStored(LANE_MEMORY_KEY)), repoKey) };
  }
  const layout = useMemo(
    () => fork ? forkLayout(commits, head, slotsRef.current!.slots, defaultBranch) : layoutGraph(commits, { head, wip: true, slots: slotsRef.current!.slots, defaultBranch }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [commits, head?.sha, head?.branch, head?.detached, repoKey, defaultBranch, fork],
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
  const tones = useMemo(() => graphTones(commits, stableHead, defaultBranch), [commits, stableHead, defaultBranch]);
  const byId = useMemo(() => new Map(commits.map(c => [c.sha, c])), [commits]);
  // HEAD's own line, detached or not: what it cannot reach is dimmed either way.
  const focusKey = layout.headKey;
  const { drawn, folded } = graphColumns(layout.columns);
  const width = fork ? lookGraphWidth(drawn, geo) : graphWidth(drawn);
  const headSha = head?.sha ?? commits.find(c => c.refs.head)?.sha ?? null;
  const agents = useMemo(() => new Map(commits.map(c => [c.sha, agentView(c, focus, agentName)])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [commits, focus.sessionId, focusIds, agentName]);

  // The rows drawn: the uncommitted row when there is one, and the first
  // `rowLimit` commits when a first frame asks for fewer.
  const drawnRows = useMemo(() => {
    let rows = showWip ? layout.rows : layout.rows.filter(r => r.id !== WIP_ID);
    if (rowLimit !== undefined) rows = rows.slice(0, rowLimit + (rows[0]?.id === WIP_ID ? 1 : 0));
    return rows;
  }, [layout, showWip, rowLimit]);
  const ids = useMemo(() => drawnRows.map(r => r.id), [drawnRows]);
  const tabStopId = ids.includes(selected) ? selected : ids[0];
  // A line across the list where commits older than the window begin: HEAD's
  // own line when HEAD is older than the window, then the session's older
  // commits, each under its own words.
  const dividers = useMemo(() => {
    const at = new Map<number, string>();
    drawnRows.forEach((r, i) => {
      const prev = drawnRows[i - 1];
      if (!r.outside || (prev?.outside && !!prev.headLine === !!r.headLine)) return;
      at.set(i, r.headLine ? "HEAD is older than the history above" : "Older commits from this session");
    });
    return at;
  }, [drawnRows]);

  // The minute the ages are counted from, kept for a minute.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);

  // The room a ref chip's words get, from the pane's width.
  const [refRoom, setRefRoom] = useState(REF_ROOM);
  // Fork look: under 480px the date column goes, and its words to the row's title.
  const [paneNarrow, setPaneNarrow] = useState(false);
  useLayoutEffect(() => {
    const el = paneRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => {
      const w = e.contentRect.width;
      if (fork) { setRefRoom(w < 680 ? FK_REF_ROOM_NARROW : FK_REF_ROOM); setPaneNarrow(w < 480); }
      else setRefRoom(w <= 560 ? REF_ROOM_NARROW : REF_ROOM);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fork]);

  // The ref chips' words measured in their own font, on a canvas, as the
  // card's branch chip measures its own (one cached measure per font).
  const [measure, setMeasure] = useState<Measure | null>(null);
  useLayoutEffect(() => { setMeasure(() => monoMeasure(REF_PX, REF_WEIGHT)); }, []);
  // The Fork look's badges and dates, measured in its UI font on a canvas.
  const [fkMeasureFn, setFkMeasure] = useState<((text: string, bold: boolean) => number) | null>(null);
  const [fkRowMeasure, setFkRowMeasure] = useState<((text: string, bold: boolean) => number) | null>(null);
  useLayoutEffect(() => {
    if (!fork) return;
    setFkMeasure(() => fkMeasure());
    setFkRowMeasure(() => fkMeasure(FK_ROW_PX));
  }, [fork]);
  // Fork's date column is sized for its own words (`18 Sep 2026 at 12:53`);
  // a locale that writes the time longer (`Sep 18, 2026 at 12:53 PM`) widens
  // it to the widest date listed, one width for the list, rather than cut
  // every date short.
  const dateRoom = useMemo(() => {
    if (!fork || !fkRowMeasure) return 0;
    let widest = 0;
    for (const r of drawnRows) {
      const c = byId.get(r.id);
      if (c) widest = Math.max(widest, fkRowMeasure(forkDate(c.date, now), c.sha === headSha));
    }
    return Math.ceil(widest) + 2;
  }, [fork, fkRowMeasure, drawnRows, byId, now, headSha]);

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
  // Focus already on another of the list's rows moves with it, so the row
  // focused is always the list's one tab stop (a clean detached HEAD opens
  // the view on the top row, then selects HEAD once the folder is read).
  useLayoutEffect(() => {
    if (lastSelected.current !== selected) {
      reveal(selected);
      const active = document.activeElement as HTMLElement | null;
      const row = active && listRef.current?.contains(active) ? active.closest<HTMLElement>("[data-id]") : null;
      if (row && row.dataset.id !== selected) rowEl(selected)?.focus({ preventScroll: true });
    }
    lastSelected.current = selected;
  }, [selected, reveal, rowEl]);

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
    let lines = 0;
    ids.forEach((id, i) => { if (dividers.has(i)) lines++; m.set(id, (i + lines) * geo.rowH); });
    return m;
  }, [ids, dividers, geo.rowH]);
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
      if (was === undefined || was === top || top > height || top + geo.rowH < 0) continue;
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
  // The pill goes away as it is pressed: with focus on it, the history's tab
  // stop takes focus first, or it would fall to the page and its deck keys.
  const pillRef = useRef<HTMLButtonElement>(null);
  const toTop = useCallback(() => {
    const sc = listRef.current;
    if (!sc) return;
    sc.scrollTo({ top: 0, behavior: reducedMotion() ? "auto" : "smooth" });
    if (pillRef.current?.contains(document.activeElement)) sc.querySelector<HTMLElement>('[role="option"][tabindex="0"]')?.focus({ preventScroll: true });
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
    const page = Math.max(1, Math.floor((listRef.current?.clientHeight ?? geo.rowH * 10) / geo.rowH) - 1);
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
  }, [ids, selected, onSelect, onOpen, onAgentCard, byId, focusRow, hideHover, geo.rowH]);

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
  // A row's card comes on keyboard focus only once the user has moved focus
  // there: a key pressed inside the view, in the task it moves focus in. The
  // focus the view places on its own (opening, a selection that follows HEAD
  // once the folder is read) brings no card nobody asked for.
  const keyed = useRef(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const scope = listRef.current?.closest("[data-key-scope]");
      if (!scope || !(e.target instanceof Node) || !scope.contains(e.target)) return;
      keyed.current = true;
      window.setTimeout(() => { keyed.current = false; }, 0);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);
  const onFocus = useCallback((e: React.FocusEvent<HTMLDivElement>) => {
    const row = e.target as HTMLElement;
    const sha = row.dataset?.id;
    if (!sha || sha === WIP_ID || !byId.get(sha)?.agent) { hideHover(); return; }
    let visible = false;
    try { visible = row.matches(":focus-visible"); } catch { visible = false; }
    if (!visible || !keyed.current) return;
    showHoverSoon(sha, row.querySelector(".gv-agent-chip") ?? row, true);
  }, [byId, showHoverSoon, hideHover]);

  const hoverCommit = hover ? byId.get(hover.sha) : undefined;
  const hoverAgent = hover ? agents.get(hover.sha) : null;
  const focusHue = sessionHue(focus.sessionId);

  return (
    <div className="gv-hist" ref={paneRef} data-look={fork ? "fork" : undefined}>
      {!fork && <div className="gv-pane-head">
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
      </div>}
      <div className="gv-graph-wrap">
        {newAbove > 0 && (
          <button type="button" className="gv-new-pill" ref={pillRef} onClick={toTop}>
            <UpGlyph /><span>{newAbove} new commit{newAbove === 1 ? "" : "s"}</span>
          </button>
        )}
        <div
          ref={listRef}
          className="gv-graph-scroll"
          role="listbox"
          aria-label={fork && folded > 0 ? `History, ${folded} more lanes folded into the last column` : "History"}
          data-focused={fork && listFocused ? "" : undefined}
          style={fork ? ({ "--fk-graph-w": `${width}px`, "--fk-date-min": `${dateRoom}px` } as React.CSSProperties) : undefined}
          onKeyDown={onKeyDown}
          onClick={onClick}
          onDoubleClick={onDoubleClick}
          onPointerOver={onPointerOver}
          onPointerOut={onPointerOut}
          onFocus={onFocus}
          onBlur={hideHover}
          onScroll={onScroll}
        >
          {drawnRows.map((row, i) => {
            const c = row.id === WIP_ID ? null : byId.get(row.id) ?? null;
            const el = fork && c ? (
              <FkHistoryRow
                key={row.id}
                rowId={`${uid}-${row.id.slice(0, 12)}`}
                row={row}
                commit={c}
                tone={tones.get(c.sha) ?? "off"}
                selected={row.id === selected}
                tabStop={row.id === tabStopId}
                isHead={c.sha === headSha}
                focusKey={focusKey}
                folded={folded}
                width={width}
                noWip={!showWip}
                agent={agents.get(c.sha) ?? null}
                head={stableHead}
                refRoom={refRoom}
                measure={fkMeasureFn}
                now={now}
                fresh={fresh.has(c.sha)}
                dateInTitle={paneNarrow}
              />
            ) : (
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
                noWip={!showWip}
                agent={c ? agents.get(c.sha) ?? null : null}
                head={stableHead}
                slots={layout.slots}
                refRoom={refRoom}
                measure={measure}
                now={now}
                fresh={!!c && fresh.has(c.sha)}
                copied={!!c && copied === c.sha}
                uncommitted={c ? NO_UNCOMMITTED : uncommitted}
                focusHue={focusHue}
              />
            );
            const divider = dividers.get(i);
            if (divider === undefined) return el;
            return (
              <React.Fragment key={`older:${row.id}`}>
                <div className={fork ? "fk-older" : "gv-older"} role="presentation">{divider}</div>
                {el}
              </React.Fragment>
            );
          })}
          {commits.length === 0 && fork && <div className="fk-empty" role="presentation">No commits yet</div>}
          {commits.length === 0 && !fork && (
            <div className="gv-graph-empty" role="presentation">
              <b>No commits yet.</b> {head?.branch ? <>{head.branch} has no history</> : <>This repository has no history</>}; the changed files wait for the first commit.
            </div>
          )}
        </div>
      </div>
      <span className="vis-hidden" aria-live="polite">{said}</span>
      {hover && hoverCommit && hoverAgent && <HoverCard state={hover} commit={hoverCommit} agent={hoverAgent} id={`${uid}-pop`} look={look} />}
    </div>
  );
}
