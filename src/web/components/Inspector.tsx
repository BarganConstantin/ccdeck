// The Inspector: the detail panel's header with its tabs, and what each tab shows.
//
// V4 turns the detail panel into one column with a tablist at the top (its
// Inspector / Header) over a body that scrolls. The Agents tab draws the
// session as a tree of the very cards the board draws, and then everything the
// detail panel has always shown about the selected agent, in its order. The
// Context tab is the context breakdown the modal shows, set in the panel.
//
// THERE IS NO TIME TAB. Figma draws one ("where the time went, this turn"), but
// it needs the turn's waiting time and the thinking between tool calls, and the
// deck holds neither for a past turn: a tool call has its two timestamps and the
// reducer keeps only the block a session is in right now (`waiting.since`). The
// only measured split is /api/tool-audit's, which has no per-session filter; a
// panel built on guesses would print numbers the deck does not have. See
// inspector-tab.ts.
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { agentAriaLabel } from "../agent-copy";
import { effectiveContextWindow } from "../context-window";
import { agentTree, sessionCostLabel, subagentCount, type TreeRow } from "../inspector-tree";
import {
  INSPECTOR_TAB_LABEL, INSPECTOR_TABS, loadInspectorTab, saveInspectorTab, type InspectorTab,
} from "../inspector-tab";
import { modelChipText } from "../model-label";
import { tabStripMove } from "../tablist-keys";
import { fmtTokens } from "../token-format";
import type { AgentNodeData } from "../types";
import { AgentCard } from "./AgentNode";
import { ContextView, contextCopy } from "./ContextModal";
import { CapacityGlyph, SessionListGlyph } from "./rail-glyphs";

const TAB_GLYPH: Record<InspectorTab, () => ReactNode> = {
  agents: SessionListGlyph,
  context: CapacityGlyph,
};

export default function Inspector({ selected, agents, onSelectAgent, onClose, detail }: {
  /** The primary selection, which is what the panel is about. */
  selected: AgentNodeData;
  /** Every agent on the board, from which the session's tree is read. */
  agents: ReadonlyMap<string, AgentNodeData>;
  /** A card in the tree was pressed: select that agent, as pressing it on the board does. */
  onSelectAgent: (id: string) => void;
  /** Fold: what the panel's close has always done. */
  onClose: () => void;
  /** The detail panel's own sections (Detail.tsx), shown under the tree. */
  detail: ReactNode;
}) {
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
  const root = agents.get(selected.sessionId) ?? selected;

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
          title="Close panel"
          aria-label="Close detail panel"
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
          {tab === t && t === "agents" && <AgentsTab selected={selected} agents={agents} onSelectAgent={onSelectAgent} detail={detail} />}
          {tab === t && t === "context" && <ContextTab agent={root} />}
        </div>
      ))}
    </>
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

function AgentsTab({ selected, agents, onSelectAgent, detail }: {
  selected: AgentNodeData;
  agents: ReadonlyMap<string, AgentNodeData>;
  onSelectAgent: (id: string) => void;
  detail: ReactNode;
}) {
  const rows = agentTree(agents, selected.sessionId);
  return (
    <>
      <InspectorHead
        title="Agents"
        qualifier={subagentCount(rows)}
        figure={rows.length > 0 ? sessionCostLabel(rows[0].agent) : null}
      />
      <ul className="insp-tree">
        {rows.map(row => <TreeItem key={row.agent.id} row={row} current={row.agent.id === selected.id} onSelectAgent={onSelectAgent} />)}
      </ul>
      <p className="insp-note">Who started whom, read from the transcript. Each card shows its own model, cost and time.</p>
      <div className="insp-detail">{detail}</div>
    </>
  );
}

/** One agent of the tree: its gutter of tree lines, then its card. The card is
 *  read-only here, so the cell around it takes the press and the keys. */
function TreeItem({ row, current, onSelectAgent }: { row: TreeRow; current: boolean; onSelectAgent: (id: string) => void }) {
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
}

function ContextTab({ agent }: { agent: AgentNodeData }) {
  const used = agent.context?.currentContextTokens ?? 0;
  const limit = effectiveContextWindow(agent.contextWindow, agent.model);
  const pct = Math.min(100, Math.round((used / limit) * 100));
  return (
    <>
      <InspectorHead
        title="Context window"
        qualifier={agent.model ? modelChipText(agent.model) : null}
        figure={`${fmtTokens(used)} / ${fmtTokens(limit)} · ${pct}%`}
      />
      <ContextView agent={agent} />
      {/* Figma's treemap and its legend need a token count per category (tool
          results, files read, system prompt…), which the deck does not have: it
          counts messages and tool calls, not the tokens in them. Neither is
          drawn, and neither of Figma's two notes is true of what is shown, so
          the one note here is the one the modal prints. */}
      <p className="insp-note">{contextCopy(agent.provider).subtitle}</p>
    </>
  );
}
