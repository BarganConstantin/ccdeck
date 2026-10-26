import { useId, useState } from "react";
import type { GroupDef } from "../jira-board";
import { issuesMove, moveDestination, moveSelectionProblem, type JiraMove, type JiraMoveItem } from "../jira-move";
import type { BoardSnapshot } from "../use-jira-board";
import AnchoredPopover from "./AnchoredPopover";

interface Props {
  items: readonly JiraMoveItem[];
  groups: GroupDef[];
  snap: BoardSnapshot;
  anchorId: string;
  portalId: string;
  boundaryId?: string;
  busy: boolean;
  onMove: (move: JiraMove, destination: GroupDef) => Promise<boolean>;
  onClose: () => void;
  error: string;
  initialView?: "menu" | "move";
}

/** The same move as a pointer drop, with named controls for touch/keyboard. */
export default function JiraMovePopover({ items, groups, snap, anchorId, portalId, boundaryId, busy, onMove, onClose, error, initialView = "move" }: Props) {
  const id = useId();
  const [view, setView] = useState(initialView);
  const [destination, setDestination] = useState(items[0].group.id);
  const [position, setPosition] = useState("");
  const targets = groups.filter(g => moveDestination(g));
  const to = targets.find(g => g.id === destination);
  const data = to ? snap.groups[to.id] : undefined;
  const selectedKeys = new Set(items.map(i => i.issue.key));
  const issues = (data?.issues ?? []).filter(i => !selectedKeys.has(i.key) && !i.type.subtask && !i.type.epic);
  const anchor = position ? { key: position.slice(position.indexOf(":") + 1), side: position.startsWith("before:") ? "before" as const : "after" as const } : undefined;
  const move = to ? issuesMove(items, to, anchor) : null;
  const problem = moveSelectionProblem(items);
  return (
    <AnchoredPopover anchorId={anchorId} portalRootId={portalId} boundaryId={boundaryId ?? portalId}
      id={`${id}-popover`} className={view === "menu" ? "jr-actions-pop" : "jr-move-pop"} role={view === "menu" ? "menu" : "dialog"}
      labelledBy={view === "menu" ? anchorId : `${id}-title`} onClose={onClose}>
      {view === "menu" ? <>
        <button type="button" className="jr-action-item" role="menuitem" aria-disabled={Boolean(problem) || busy}
          aria-describedby={problem ? `${id}-problem` : undefined} onClick={() => { if (!problem && !busy) setView("move"); }}>
          {items.length === 1 ? "Move…" : `Move ${items.length} issues…`}
        </button>
        {problem && <p id={`${id}-problem`} className="jr-action-hint">{problem}</p>}
      </> : <form onSubmit={e => { e.preventDefault(); if (move && to && !busy) void onMove(move, to); }}>
        <h3 id={`${id}-title`}>Move {items.length === 1 ? items[0].issue.key : `${items.length} issues`}</h3>
        <label htmlFor={`${id}-destination`}>Destination</label>
        <select id={`${id}-destination`} value={destination} disabled={busy} autoFocus
          onChange={e => { setDestination(e.target.value); setPosition(""); }}>
          {targets.map(g => <option key={g.id} value={g.id}>{g.title}</option>)}
        </select>
        <label htmlFor={`${id}-position`}>Position</label>
        <select id={`${id}-position`} value={position} disabled={busy} onChange={e => setPosition(e.target.value)}>
          <option value="">{items.every(i => i.group.id === destination) ? "Choose a position" : "Keep current rank"}</option>
          {issues.map(i => <option key={i.key} value={`before:${i.key}`}>Before {i.key} — {i.summary}</option>)}
          {issues.length > 0 && <option value={`after:${issues[issues.length - 1].key}`}>After {issues[issues.length - 1].key}</option>}
        </select>
        <p className="jr-move-help">Saved in Jira. Status stays the same. {data?.next || data?.capped || !data || data.status !== "ready" ? "Positions are limited to issues already loaded." : ""}</p>
        {error && <p className="jr-move-error" role="alert">{error}</p>}
        <div className="jr-move-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={!move || busy} aria-busy={busy || undefined}>{busy ? "Moving…" : items.length === 1 ? "Move issue" : `Move ${items.length} issues`}</button>
        </div>
      </form>}
    </AnchoredPopover>
  );
}
