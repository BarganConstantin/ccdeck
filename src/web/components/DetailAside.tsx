// The detail panel's frame: the landmark it is, the button that closes it, and
// the download its Export starts. What it shows about the agent is Detail.tsx's.
//
// Moved out of App.tsx's markup unchanged, with exportSessionJson, the one
// thing only this panel does with the graph. App.tsx mounts it while an agent
// is selected and the panel is open.
import type { MutableRefObject } from "react";

import { useFeatureUse } from "../feature-use";
import type { GraphState } from "../reducer";
import { exportFileName, sessionExport } from "../session-export";
import type { AgentNodeData } from "../types";
import Detail from "./Detail";

/** Build a portable JSON snapshot of a single session (root + every subagent)
 *  and trigger a browser download.
 *
 *  What goes IN the file, and what the file is called, are session-export.ts's
 *  — the format is the half people keep, and it was unreachable by any test
 *  while it lived in here (#1175). This is the download around it. */
function exportSessionJson(state: GraphState, sessionId: string): void {
  const payload = sessionExport(state, sessionId, new Date().toISOString());
  if (!payload) return;
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = exportFileName(payload.label, sessionId);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function DetailAside({ selected, now, openTool, setSummaryFor, onClose, stateRef, removeSelectedNode }: {
  /** The primary selection, which is what the panel is about. */
  selected: AgentNodeData;
  now: number;
  openTool: (agentId: string, toolId: string) => void;
  setSummaryFor: (sessionId: string) => void;
  /** The × — closes the panel, and hands keyboard focus to the card it was about. */
  onClose: () => void;
  /** Read when Export is pressed, for the graph as it is then. */
  stateRef: MutableRefObject<GraphState>;
  removeSelectedNode: () => void;
}) {
  // Drawn: one of the features the usage reports name (feature-use.ts). Said
  // here rather than off `detailOpen`, which stays on across a reload that
  // left nothing selected and so nothing on screen.
  useFeatureUse("detail-panel");
  return (
    // Already the right element and still an unnamed one: the rotor listed
    // it as a bare "complementary" beside the session list's "Sessions",
    // which is the entry a reader cannot tell from the next. The name is
    // fixed rather than the selected agent's label — the panel keeps its
    // identity when nothing is selected, and a landmark whose name changes
    // under the reader is a landmark they cannot come back to. The agent's
    // name is the panel's <h2>, which is where a changing title belongs.
    <aside className="detail" aria-label="Detail">
      <button
        type="button"
        className="glyph-btn detail-close"
        title="Close panel"
        aria-label="Close detail panel"
        onClick={onClose}
      >×</button>
      <Detail
            agent={selected}
            now={now}
            onOpenTool={openTool}
            onShowSummary={setSummaryFor}
            onExportSession={(sid) => exportSessionJson(stateRef.current, sid)}
            onRemove={removeSelectedNode}
          />
    </aside>
  );
}
