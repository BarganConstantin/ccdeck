// The large modal a connected tracker's panel is drawn in (#2178): Tool
// activity's shell — 90vw × 90dvh, portalled to the body, Escape and the Tab
// trap from useModalDismiss, a press on the scrim closes it, focus goes back to
// the rail button that opened it.
//
// THE HOST DRAWS THE FRAME AND THE HEADER, and nothing else: the provider's
// glyph and name, which connection is on show (a selector once there is more
// than one, remembered per kind), and Close. Everything under the header —
// the toolbar, the filters, Refresh, the list and its detail — is the
// provider's panel (integrations/registry.ts), handed the connection, a way to
// read through it, its images, its own memory and whether the window is narrow.
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { connectionApi, connectionAssetUrl, connectionHost } from "../integrations/client";
import { connectionPrefs, loadActiveConnection, saveActiveConnection } from "../integrations/prefs";
import { integrationDef } from "../integrations/registry";
import type { IntegrationConnection, IntegrationKind } from "../integrations/types";
import { useFeatureUse } from "../feature-use";
import { useDrillIn } from "./IntegrationSplit";
import { useModalDismiss, useScrimDismiss } from "./use-modal-dismiss";

export interface IntegrationModalProps {
  kind: IntegrationKind;
  /** This kind's connections; the modal closes itself when the last one goes. */
  connections: IntegrationConnection[];
  onClose: () => void;
  /** Settings → Integrations at one connection. */
  onReconnect: (connId: string) => void;
}

export default function IntegrationModal({ kind, connections, onClose, onReconnect }: IntegrationModalProps) {
  const def = integrationDef(kind);
  const selectId = useId();
  const narrow = useDrillIn();
  // Read once, while focus is still on the rail button that opened this.
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  const close = useCallback(() => {
    onClose();
    requestAnimationFrame(() => {
      const fallback = Array.from(document.querySelectorAll<HTMLElement>(`[data-rail-item="integration-${kind}"], [data-rail-item="more"]`)).find(el => el.checkVisibility?.() ?? true);
      (opener && opener !== document.body && opener.isConnected && (opener.checkVisibility?.() ?? true) ? opener : fallback)?.focus({ preventScroll: true });
    });
  }, [onClose, opener, kind]);
  const dialogRef = useModalDismiss(close);
  const scrimPress = useScrimDismiss(close);
  // The provider's name, once a day, for the usage reports: never the
  // connection or anything read through it.
  useFeatureUse(kind);

  const [active, setActive] = useState<string>(() => {
    const remembered = loadActiveConnection(kind);
    return connections.some(c => c.id === remembered) ? remembered! : connections[0]?.id ?? "";
  });
  // A connection removed elsewhere (Settings, another tab) takes the panel to
  // the next one; the last one removed closes it.
  useEffect(() => {
    if (connections.length === 0) { onClose(); return; }
    if (!connections.some(c => c.id === active)) setActive(connections[0].id);
  }, [connections, active, onClose]);
  const choose = (id: string) => { setActive(id); saveActiveConnection(kind, id); };

  const connection = connections.find(c => c.id === active) ?? null;
  // One set of helpers per connection, so a panel's effects keyed on them run
  // when the connection changes and not on every list refresh.
  const connId = connection?.id ?? "";
  const helpers = useMemo(() => (connId ? {
    api: connectionApi({ kind, id: connId }),
    assetUrl: connectionAssetUrl({ kind, id: connId }),
    prefs: connectionPrefs(kind, connId),
  } : null), [kind, connId]);
  if (!def || !connection || !helpers) return null;
  const { Panel, Glyph } = def;

  return createPortal(
    <div className="modal-backdrop" role="presentation" {...scrimPress}>
      <div ref={dialogRef} id={`integration-${kind}-modal`} className="modal ig-modal" role="dialog" aria-modal="true" aria-labelledby="integration-modal-title"
        data-kind={kind} onClick={event => event.stopPropagation()}>
        <header className="ig-head">
          <h2 className="ig-title" id="integration-modal-title"><span className="ig-title-glyph" aria-hidden><Glyph /></span>{def.label}</h2>
          {connections.length > 1 ? (
            <label className="ig-conn-select">
              <span className="vis-hidden">Connection</span>
              <select id={selectId} className="sm-select" value={connection.id} onChange={e => choose(e.target.value)}>
                {connections.map(c => <option key={c.id} value={c.id}>{c.name}{c.name !== connectionHost(c) ? ` · ${connectionHost(c)}` : ""}</option>)}
              </select>
            </label>
          ) : (
            <span className="ig-conn-name" title={connection.baseUrl}>{connection.name}</span>
          )}
          <button type="button" className="glyph-btn ig-close" onClick={close} aria-label={`Close ${def.label}`} title="Close (Esc)">×</button>
        </header>
        <div className="ig-body">
          <Panel
            key={connection.id}
            connection={connection}
            connections={connections}
            api={helpers.api}
            assetUrl={helpers.assetUrl}
            prefs={helpers.prefs}
            narrow={narrow}
            onReconnect={() => { close(); onReconnect(connection.id); }}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
