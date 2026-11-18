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
import { useSingleKeyShortcuts } from "../use-single-key-shortcuts";
import { useInspectorStatus } from "../inspector-state";
import Detail from "./Detail";
import Inspector, { useSheetEntry } from "./Inspector";
import { useT } from "../i18n";
import SheetHandle from "./SheetHandle";
import { INSPECTOR_REGION_ID } from "../inspector-corner";

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

export default function DetailAside({ selected, now, openTool, setSummaryFor, onClose, onSelectAgent, stateRef, removeSelectedNode, onOpenSession, stageSession = null, workspace = false, leaving = false, sheet = false }: {
  /** The Workspace is drawn: the title takes the pane's sentence for the state. */
  workspace?: boolean;
  /** A phone's sheet on its way down the bottom edge, the flag already dropped. */
  leaving?: boolean;
  /** Workspace's sheet width (1100 to 1319): the sheet comes in from the right
   *  edge and leaves the same way, on transitions (workspace.css), so a reopen
   *  during the close turns around. `leaving` is then the sheet on its way out. */
  sheet?: boolean;
  /** The primary selection, which is what the panel is about. */
  selected: AgentNodeData;
  now: number;
  openTool: (agentId: string, toolId: string) => void;
  setSummaryFor: (sessionId: string) => void;
  /** Fold — closes the panel, and hands keyboard focus to the card it was about. */
  onClose: () => void;
  /** A card in the Agents tab was pressed: select that agent. */
  onSelectAgent: (id: string) => void;
  /** Read when Export is pressed, for the graph as it is then. */
  stateRef: MutableRefObject<GraphState>;
  removeSelectedNode: () => void;
  /** The title block's next step, Answer or Open (Detail.tsx's
   *  inspectorNextStep): App's openSessionWithKeys, given only where the deck
   *  has a terminal. */
  onOpenSession?: (sessionId: string) => void;
  /** The session the stage shows now, which is not offered Open again. */
  stageSession?: string | null;
}) {
  // Drawn: one of the features the usage reports name (feature-use.ts). Said
  // here rather than off `detailOpen`, which stays on across a reload that
  // left nothing selected and so nothing on screen.
  const t = useT();
  useFeatureUse("detail-panel");
  const singleKeys = useSingleKeyShortcuts();
  const status = useInspectorStatus(selected, stateRef.current.agents, now, workspace);
  // The sheet comes in as a transition, not a pop (Inspector.tsx says how);
  // the Inspector with no session to show comes in the same way.
  const { asideRef, sheetState } = useSheetEntry(sheet, leaving);
  return (
    // Already the right element and still an unnamed one: the rotor listed
    // it as a bare "complementary" beside the session list's "Sessions",
    // which is the entry a reader cannot tell from the next. The name is
    // fixed rather than the selected agent's label — the panel keeps its
    // identity when nothing is selected, and a landmark whose name changes
    // under the reader is a landmark they cannot come back to. The agent's
    // name is the panel's <h2>, which is where a changing title belongs.
    <aside ref={asideRef} id={INSPECTOR_REGION_ID} className={leaving ? "detail leaving" : "detail"} data-sheet={sheetState} aria-label={t("board.detailPanel.title")}>
      <SheetHandle />
      <Inspector
        selected={selected}
        agents={stateRef.current.agents}
        revision={stateRef.current.revision}
        onSelectAgent={onSelectAgent}
        onClose={onClose}
        detail={
          <Detail
            agent={selected}
            now={now}
            onOpenTool={openTool}
            onShowSummary={setSummaryFor}
            onOpenSession={onOpenSession}
            stageSession={stageSession}
            onExportSession={(sid) => exportSessionJson(stateRef.current, sid)}
            onRemove={removeSelectedNode}
            singleKeys={singleKeys}
            status={status}
          />
        }
      />
    </aside>
  );
}
