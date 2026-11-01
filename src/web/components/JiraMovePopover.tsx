import { useId, useRef, useState } from "react";
import { useT } from "../i18n";
import { groupTitle, type GroupDef } from "../jira-board";
import { issueMoveBlocker, moveDestination, moveSelectionProblem, type JiraMove, type JiraMoveItem } from "../jira-move";
import type { BoardSnapshot } from "../use-jira-board";
import { selfPressAccepted, selfPressProps } from "../panel-press";
import AnchoredPopover from "./AnchoredPopover";

interface Props {
  items: readonly JiraMoveItem[];
  groups: GroupDef[];
  snap: BoardSnapshot;
  anchorId: string;
  portalId: string;
  boundaryId?: string;
  busy: boolean;
  uncertain?: boolean;
  outcome?: string;
  onChecked?: () => void;
  onMove: (move: JiraMove, destination: GroupDef) => Promise<boolean>;
  onClose: () => void;
  error: string;
  initialView?: "menu" | "move";
}

/** The same move as a pointer drop, with named controls for touch/keyboard. */
export default function JiraMovePopover({ items, groups, anchorId, portalId, boundaryId, busy, uncertain = false, outcome = "", onChecked, onMove, onClose, error, initialView = "move" }: Props) {
  const t = useT();
  const id = useId();
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const submitting = useRef(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [view, setView] = useState(initialView);
  const [destination, setDestination] = useState(items[0].group.id);
  const isMenu = view === "menu";
  const targets = groups.filter(g => moveDestination(g));
  const to = targets.find(g => g.id === destination);
  const move = to ? (() => {
    const target = moveDestination(to);
    if (!target || !items.length || items.length > 50 || items.some(item => issueMoveBlocker(item))) return null;
    const keys = items.map(item => item.issue.key);
    if (new Set(keys).size !== keys.length) return null;
    return { ...(keys.length === 1 ? { issueKey: keys[0] } : { issueKeys: keys }), target, atEnd: true as const };
  })() : null;
  const blocker = items.length === 1 ? issueMoveBlocker(items[0], t) : null;
  const problem = blocker ? t("integrations.move.cannot", { key: items[0].issue.key, blocker }) : moveSelectionProblem(items, t);
  const submit = async () => {
    if (!move || !to || uncertain || !selfPressAccepted(busyRef.current || submitting.current)) return;
    submitting.current = true;
    try { await onMove(move, to); }
    finally { submitting.current = false; }
  };
  return (
    <AnchoredPopover anchorId={anchorId} portalRootId={portalId} boundaryId={boundaryId ?? portalId}
      id={`${id}-popover`} className={isMenu ? "jr-actions-pop" : "jr-move-pop"} role={isMenu ? "menu" : "dialog"}
      labelledBy={isMenu ? anchorId : `${id}-title`} onClose={onClose}>
      {isMenu ? <>
        <button type="button" className="jr-action-item" role="menuitem" aria-disabled={Boolean(problem) || busy}
          aria-describedby={problem ? `${id}-problem` : undefined} onClick={() => { if (!problem && selfPressAccepted(busyRef.current || submitting.current)) setView("move"); }}>
          {items.length === 1 ? t("integrations.movePop.move") : t("integrations.movePop.moveN", { count: items.length })}
        </button>
        {problem && <p id={`${id}-problem`} className="jr-action-hint">{problem}</p>}
      </> : <form onSubmit={e => { e.preventDefault(); void submit(); }}>
        <h3 id={`${id}-title`}>{t("integrations.movePop.title", { what: items.length === 1 ? items[0].issue.key : t("integrations.movePop.nIssues", { count: items.length }) })}</h3>
        <label htmlFor={`${id}-destination`}>{t("integrations.movePop.destination")}</label>
        <select id={`${id}-destination`} value={destination} {...selfPressProps(busy)} autoFocus
          onChange={e => { if (!selfPressAccepted(busyRef.current || submitting.current)) return; setDestination(e.target.value); }}>
          {targets.map(g => <option key={g.id} value={g.id}>{groupTitle(g, t)}</option>)}
        </select>
        <p className="jr-move-help">{t("integrations.movePop.help")}</p>
        {error && <p className="jr-move-error" role="alert">{error}</p>}
        {uncertain && outcome && <p className="jr-move-help">{outcome}</p>}
        <div className="jr-move-actions">
          <button ref={cancelRef} type="button" className="btn" onClick={onClose}>{t("integrations.cancel")}</button>
          {uncertain && <button type="button" className="btn" onClick={event => { if (document.activeElement === event.currentTarget) cancelRef.current?.focus(); onChecked?.(); }}>{t("integrations.movePop.checked")}</button>}
          <button type="submit" className="btn primary" {...selfPressProps(busy, !move)} aria-disabled={uncertain || undefined}>{busy ? t("integrations.movePop.moving") : items.length === 1 ? t("integrations.movePop.moveIssue") : t("integrations.movePop.moveIssues", { count: items.length })}</button>
        </div>
      </form>}
    </AnchoredPopover>
  );
}
