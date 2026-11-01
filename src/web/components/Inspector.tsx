// The Inspector: the detail panel's header with its tabs, and what each tab shows.
//
// V4 turns the detail panel into one column with a tablist at the top (its
// Inspector / Header) over a body that scrolls. The Agents tab draws the
// session as a tree of the very cards the board draws, and then everything the
// detail panel has always shown about the selected agent, in its order. The
// Context tab is the context breakdown the modal shows, set in the panel.
//
// The Time tab is "where the time went" for the session's current turn, or its
// last: the three lanes come from /api/tool-audit?session=, the spans from the
// calls the session holds (InspectorTime.tsx).
import { memo, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { agentAriaLabel } from "../agent-copy";
import { useT } from "../i18n";
import { agentTree, sessionCostLabel, subagentCount, type TreeRow } from "../inspector-tree";
import {
  INSPECTOR_TAB_LABEL, INSPECTOR_TABS, loadInspectorTab, saveInspectorTab, type InspectorTab,
} from "../inspector-tab";
import { modelChipText } from "../model-label";
import { tabStripMove } from "../tablist-keys";
import { contextFigure, contextFill } from "../context-figure";
import type { AgentNodeData } from "../types";
import { AgentCard } from "./AgentNode";
import { ContextView } from "./ContextModal";
import InspectorTime from "./InspectorTime";
import { CapacityGlyph, ClockGlyph, SessionListGlyph } from "./rail-glyphs";

const TAB_GLYPH: Record<InspectorTab, () => ReactNode> = {
  agents: SessionListGlyph,
  time: ClockGlyph,
  context: CapacityGlyph,
};

export default function Inspector({ selected, agents, revision = 0, onSelectAgent, onClose, detail }: {
  /** The primary selection, which is what the panel is about. */
  selected: AgentNodeData;
  /** Every agent on the board, from which the session's tree is read. */
  agents: ReadonlyMap<string, AgentNodeData>;
  /** The graph's `revision` (graph-state.ts). The reducer mutates agents in
   *  place and keeps their identity, so the revision is what says the tree's
   *  rows, and the cards in them, may have changed. */
  revision?: number;
  /** A card in the tree was pressed: select that agent, as pressing it on the board does. */
  onSelectAgent: (id: string) => void;
  /** Fold: what the panel's close has always done. */
  onClose: () => void;
  /** The detail panel's own sections (Detail.tsx), shown under the tree. */
  detail: ReactNode;
}) {
  const t = useT();
  const [tab, setTab] = useState<InspectorTab>(loadInspectorTab);
  const tabRefs = useRef<Partial<Record<InspectorTab, HTMLButtonElement | null>>>({});
  const choose = (next: InspectorTab) => { setTab(next); saveInspectorTab(next); };
  // Roving tabindex: only the chosen tab is in the Tab order, and the arrows
  // (with Home and End) move the choice and the focus together.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const move = tabStripMove(e, INSPECTOR_TABS.indexOf(tab), INSPECTOR_TABS.length);
    if (move.kind !== "select") return;
    e.preventDefault();
    const next = INSPECTOR_TABS[move.index];
    choose(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <>
      <header className="insp-h">
        <div className="insp-tabs" role="tablist" aria-label="Inspector" onKeyDown={onKeyDown}>
          {INSPECTOR_TABS.map(t => {
            const Glyph = TAB_GLYPH[t];
            return (
              <button
                key={t}
                type="button"
                role="tab"
                id={`insp-tab-${t}`}
                className="insp-tab"
                aria-selected={tab === t}
                aria-controls={`insp-panel-${t}`}
                tabIndex={tab === t ? 0 : -1}
                ref={el => { tabRefs.current[t] = el; }}
                onClick={() => choose(t)}
              ><Glyph /><span>{INSPECTOR_TAB_LABEL[t]}</span></button>
            );
          })}
        </div>
        <button
          type="button"
          className="glyph-btn insp-fold"
          title={t("board.detailPanel.close")}
          aria-label={t("board.detailPanel.closeLabel")}
          onClick={onClose}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4"
            strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M8.6 3.2 4.8 7l3.8 3.8" /></svg>
        </button>
      </header>
      {INSPECTOR_TABS.map(t => (
        <div
          key={t}
          role="tabpanel"
          id={`insp-panel-${t}`}
          aria-labelledby={`insp-tab-${t}`}
          className="insp-b"
          hidden={tab !== t}
        >
          {tab === t && t === "agents" && <AgentsTab selected={selected} agents={agents} revision={revision} onSelectAgent={onSelectAgent} detail={detail} />}
          {tab === t && t === "time" && <InspectorTime selected={selected} agents={agents} revision={revision} />}
          {tab === t && t === "context" && <ContextTab agent={selected} />}
        </div>
      ))}
    </>
  );
}

/** WORKSPACE, the pane empty: the Inspector's column with no session in focus
 *  (Figma, "Empty workspace"). The same header and tabs, none of them
 *  pressable, over two lines saying so. No Fold: the Inspector is a column
 *  here (workspace.css), not a panel to close. */
export const EMPTY_INSPECTOR_TITLE = "No session in focus";
export const EMPTY_INSPECTOR_LINE = "Open one from the list.";

export function EmptyInspector() {
  return (
    <aside className="detail" aria-label="Detail" data-empty="">
      <header className="insp-h">
        {/* The tabs' look, with nothing to switch between: not a tablist. */}
        <div className="insp-tabs" aria-hidden="true">
          {INSPECTOR_TABS.map(t => {
            const Glyph = TAB_GLYPH[t];
            return (
              <span key={t} className="insp-tab" aria-current={t === INSPECTOR_TABS[0] ? "true" : undefined}>
                <Glyph /><span>{INSPECTOR_TAB_LABEL[t]}</span>
              </span>
            );
          })}
        </div>
      </header>
      <div className="insp-b insp-none">
        <p className="insp-none-title">{EMPTY_INSPECTOR_TITLE}</p>
        <p className="insp-note">{EMPTY_INSPECTOR_LINE}</p>
      </div>
    </aside>
  );
}

/** The head row every tab starts with: a title, what it is about, and a figure
 *  at the far end. */
function InspectorHead({ title, qualifier, figure }: { title: string; qualifier?: string | null; figure?: string | null }) {
  return (
    <div className="insp-head">
      <span className="insp-title">{title}</span>
      {qualifier && <span className="insp-qual">{qualifier}</span>}
      <span className="insp-spacer" />
      {figure && <span className="insp-fig">{figure}</span>}
    </div>
  );
}

function AgentsTab({ selected, agents, revision, onSelectAgent, detail }: {
  selected: AgentNodeData;
  agents: ReadonlyMap<string, AgentNodeData>;
  revision: number;
  onSelectAgent: (id: string) => void;
  detail: ReactNode;
}) {
  // `agents` is the graph's own Map, mutated in place, so its identity never
  // moves; the revision is what does (the board's nodeDataFor memo keys on it
  // the same way).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rows = useMemo(() => agentTree(agents, selected.sessionId), [agents, selected.sessionId, revision]);
  return (
    <>
      <InspectorHead
        title="Agents"
        qualifier={subagentCount(rows)}
        figure={rows.length > 0 ? sessionCostLabel(rows[0].agent) : null}
      />
      <ul className="insp-tree">
        {rows.map(row => <TreeItem key={row.agent.id} row={row} revision={revision} current={row.agent.id === selected.id} onSelectAgent={onSelectAgent} />)}
      </ul>
      <p className="insp-note">Who started whom, read from the transcript. Each card shows its own model, cost and time.</p>
      <div className="insp-detail">{detail}</div>
    </>
  );
}

/** One agent of the tree: its gutter of tree lines, then its card. The card is
 *  read-only here, so the cell around it takes the press and the keys. */
const TreeItem = memo(function TreeItem({ row, current, onSelectAgent }: { row: TreeRow; revision: number; current: boolean; onSelectAgent: (id: string) => void }) {
  const id = row.agent.id;
  return (
    <li className="insp-row" data-depth={row.depth}>
      {row.more.map((more, i) => (
        <span
          key={i}
          className="insp-gut"
          // Its own column draws the elbow (down to the card's middle, and on
          // to the next sibling when there is one); an outer column only
          // carries its ancestor's line past this row, when that ancestor has
          // another child still to come.
          data-line={i < row.depth - 1 ? (more ? "through" : undefined) : (more ? "tee" : "elbow")}
          aria-hidden="true"
        />
      ))}
      {/* A press anywhere on the card bubbles to the cell (the card's own
          buttons stop theirs). The keyboard reaches it through the real button
          first in the cell: invisible and out of the pointer's way, named for
          the card, and its Enter is a click that bubbles to the same cell. It
          stands in for a focusable <div>, and carries the ring and the mark of
          the agent the panel is about onto the card beside it (detail-panel.css). */}
      <div className="insp-card" data-current={current || undefined} onClick={() => onSelectAgent(id)}>
        <button type="button" className="insp-pick" aria-label={agentAriaLabel(row.agent)} aria-current={current || undefined} />
        <AgentCard data={row.agent} />
      </div>
    </li>
  );
}, (a, b) =>
  // The agent object keeps its identity while its fields change, so the
  // revision stands in for "unchanged": a tick that moved nothing skips every
  // card, an event re-draws them.
  a.row.agent === b.row.agent && a.revision === b.revision && a.row.depth === b.row.depth
  && a.row.more.length === b.row.more.length && a.row.more.every((m, i) => m === b.row.more[i])
  && a.current === b.current && a.onSelectAgent === b.onSelectAgent);

function ContextTab({ agent }: { agent: AgentNodeData }) {
  // Whole k and a whole percent (V4's Figma), the Term header chip's figure.
  const { used, limit } = contextFill(agent);
  return (
    <>
      <InspectorHead
        title="Context window"
        qualifier={agent.model ? modelChipText(agent.model) : null}
        figure={contextFigure(used, limit)}
      />
      {/* Figma's treemap and its legend need a token count per category (tool
          results, files read, system prompt…), which the deck does not have: it
          counts messages and tool calls, not the tokens in them. Neither is
          drawn, and neither of Figma's two notes is true of what is shown, so
          the one note is the modal's, under the meter. */}
      <ContextView agent={agent} />
    </>
  );
}
