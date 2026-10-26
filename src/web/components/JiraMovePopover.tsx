import { useId, useState } from "react";
import type { JiraIssue } from "../jira-api";
import type { GroupDef } from "../jira-board";
import { issueMove, moveDestination, type JiraMove } from "../jira-move";
import type { BoardSnapshot } from "../use-jira-board";
import AnchoredPopover from "./AnchoredPopover";

interface Props {
  issue: JiraIssue;
  from: GroupDef;
  groups: GroupDef[];
  snap: BoardSnapshot;
  anchorId: string;
  portalId: string;
  boundaryId?: string;
  busy: boolean;
  onMove: (move: JiraMove, destination: GroupDef) => Promise<boolean>;
  onClose: () => void;
  error: string;
}

/** The same move as a pointer drop, with named controls for touch/keyboard. */
export default function JiraMovePopover({ issue, from, groups, snap, anchorId, portalId, boundaryId, busy, onMove, onClose, error }: Props) {
  const id = useId();
  const [destination, setDestination] = useState(from.id);
  const [position, setPosition] = useState("");
  const targets = groups.filter(g => moveDestination(g));
  const to = targets.find(g => g.id === destination);
  const data = to ? snap.groups[to.id] : undefined;
  const issues = (data?.issues ?? []).filter(i => i.key !== issue.key && !i.type.subtask && !i.type.epic);
  const anchor = position ? { key: position.slice(position.indexOf(":") + 1), side: position.startsWith("before:") ? "before" as const : "after" as const } : undefined;
  const move = to ? issueMove(issue, from, to, anchor) : null;
  return (
    <AnchoredPopover anchorId={anchorId} portalRootId={portalId} boundaryId={boundaryId ?? portalId}
      id={`${id}-popover`} className="jr-move-pop" role="dialog" labelledBy={`${id}-title`} onClose={onClose}>
      <form onSubmit={e => { e.preventDefault(); if (move && to && !busy) void onMove(move, to); }}>
        <h3 id={`${id}-title`}>Move {issue.key}</h3>
        <label htmlFor={`${id}-destination`}>Destination</label>
        <select id={`${id}-destination`} value={destination} disabled={busy}
          onChange={e => { setDestination(e.target.value); setPosition(""); }}>
          {targets.map(g => <option key={g.id} value={g.id}>{g.title}</option>)}
        </select>
        <label htmlFor={`${id}-position`}>Position</label>
        <select id={`${id}-position`} value={position} disabled={busy} onChange={e => setPosition(e.target.value)}>
          <option value="">{destination === from.id ? "Choose a position" : "Keep current rank"}</option>
          {issues.map(i => <option key={i.key} value={`before:${i.key}`}>Before {i.key} — {i.summary}</option>)}
          {issues.length > 0 && <option value={`after:${issues[issues.length - 1].key}`}>After {issues[issues.length - 1].key}</option>}
        </select>
        <p className="jr-move-help">Saved in Jira. Status stays the same. {data?.next || data?.capped || !data || data.status !== "ready" ? "Positions are limited to issues already loaded." : ""}</p>
        {error && <p className="jr-move-error" role="alert">{error}</p>}
        <div className="jr-move-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={!move || busy} aria-busy={busy || undefined}>{busy ? "Moving…" : "Move issue"}</button>
        </div>
      </form>
    </AnchoredPopover>
  );
}
