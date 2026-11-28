// The MCP servers configured for a Claude Code session's project, read-only:
// opened from the foot of the MCP tools list in the Context tab
// (ContextSnapshot.tsx). Each one says where it is configured, how Claude Code
// talks to it, and what the session's last /context saw of it. Nothing here
// connects, signs in or starts anything: the one line in the foot says where
// that is done, in the session's own terminal.
//
// Portalled to the body, as the memory file viewer is: the Inspector can be a
// sheet with a transform, which would give the fixed scrim the sheet's box.
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { currentLanguage, useT } from "../i18n";
import { MCP_SOURCE_KEYS, mcpInventory, readSessionMcpServers, type McpRow, type McpServersRead } from "../context-inventory";
import type { ContextSnapshot } from "../types";
import { Dialog, DialogHeader } from "./Dialog";
import { Loader } from "./Loader";
import PathText from "./PathText";
import { useModalDismiss, useScrimDismiss } from "./use-modal-dismiss";

const fmtN = (n: number): string => n.toLocaleString(currentLanguage());

export default function McpServersDialog({ session, snapshot, cwd, onClose }: {
  session: string;
  /** The session's last /context, which says which servers were connected. */
  snapshot: ContextSnapshot | null;
  /** The project the servers are configured for. */
  cwd?: string;
  onClose: () => void;
}) {
  const t = useT();
  // No focusRef: the × is the first control, where the hook starts. Escape and
  // the focus back on the button that opened it are the hook's too.
  const dialogRef = useModalDismiss(onClose);
  const scrimPress = useScrimDismiss(onClose);
  const [read, setRead] = useState<McpServersRead | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setRead(null);
    void readSessionMcpServers(session, undefined, controller.signal).then(answer => {
      if (!controller.signal.aborted) setRead(answer);
    });
    return () => controller.abort();
  }, [session]);

  const ready = read?.kind === "ready";
  const rows = useMemo(() => (read?.kind === "ready" ? mcpInventory(read.servers, snapshot) : []), [read, snapshot]);
  const status = (row: McpRow): string => !row.status ? ""
    : row.status.seen ? t("insights.context.mcp.connected", { count: row.status.tools, n: fmtN(row.status.tools) })
      : t("insights.context.mcp.unseen");

  return createPortal(
    <Dialog scrim={scrimPress} dialogRef={dialogRef} className="ctx-inventory" labelledBy="mcp-dialog-title">
      <DialogHeader titleId="mcp-dialog-title" title={t("insights.context.mcp.title")} note={ready ? fmtN(rows.length) : undefined}
        onClose={onClose} closeLabel={t("insights.audit.closeEsc")} />
      <div className="modal-body inv-body">
        {cwd && <PathText className="inv-cwd" path={cwd} keep={2} />}
        {!snapshot && <p className="inv-note">{t("insights.context.mcp.noSnapshot")}</p>}
        {!ready ? (
          <p className="inv-state" role="status">
            {read === null && <Loader />}
            <span>{t(read === null ? "insights.context.mcp.loading" : "insights.context.mcp.failed")}</span>
          </p>
        ) : rows.length === 0 ? (
          <p className="inv-state">{t("insights.context.mcp.none")}</p>
        ) : (
          <ul className="inv-list">
            {rows.map(row => (
              <li key={`${row.source}:${row.name}`} className="inv-server">
                <span className="inv-row-top">
                  <span className="inv-row-name">{row.name}</span>
                  <span className="inv-row-state">{[t(MCP_SOURCE_KEYS[row.source]), row.transport ?? ""].filter(Boolean).join(" · ")}</span>
                </span>
                {row.status && <span className="inv-row-sub">{status(row)}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <footer className="modal-foot">
        <span className="mf-readonly">{t("insights.context.mcp.reconnect")}</span>
      </footer>
    </Dialog>,
    document.body,
  );
}
