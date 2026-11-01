// The large modal a connected tracker's panel is drawn in (#2178): Tool
// activity's shell — 90vw × 90dvh, portalled to the body, Escape and the Tab
// trap from useModalDismiss, a press on the scrim closes it, focus goes back to
// the rail button that opened it.
//
// THE HOST DRAWS THE FRAME AND THE HEADER, and nothing else: the provider's
// glyph and name, which connection is on show (a selector once there is more
// than one, remembered per kind), and Close. Everything under the header —
// the toolbar, the filters, Refresh, the list and its detail — is the
// provider's panel (integrations/panels.tsx), handed the connection, a way to
// read through it, its images, its own memory and whether the window is narrow.
//
// Loaded when it first opens, with every panel, through
// IntegrationModalOnDemand.tsx: nothing here is in the page's own bundle.
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n";
import { connectionApi, connectionAssetUrl, connectionHost } from "../integrations/client";
import { INTEGRATION_PANELS } from "../integrations/panels";
import { connectionPrefs, loadActiveConnection, saveActiveConnection } from "../integrations/prefs";
import { integrationDef } from "../integrations/registry";
import type { IntegrationConnection, IntegrationKind } from "../integrations/types";
import { useFeatureUse } from "../feature-use";
import { isTabbable, TABBABLE_SELECTOR } from "../modal-dismiss";
import { prefersReducedMotion } from "../viewport-motion";
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
  const t = useT();
  const def = integrationDef(kind);
  const Panel = INTEGRATION_PANELS[kind];
  const selectId = useId();
  const narrow = useDrillIn();
  // Read once, while focus is still on the rail button that opened this.
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  // Closing: focus goes back to the opener at once, and the modal leaves in
  // 120ms (opacity and 2px down, integrations.css), inert while it does, and
  // is unmounted when that ends, or after 200ms if the end never arrives.
  // Under reduced motion it is simply gone.
  const [closing, setClosing] = useState(false);
  const closed = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const finish = useCallback(() => {
    if (closed.current) return;
    closed.current = true;
    onCloseRef.current();
  }, []);
  const close = useCallback(() => {
    if (closing || closed.current) return;
    const fallback = Array.from(document.querySelectorAll<HTMLElement>(`[data-rail-item="integration-${kind}"], [data-rail-item="more"]`)).find(el => el.checkVisibility?.() ?? true);
    (opener && opener !== document.body && opener.isConnected && (opener.checkVisibility?.() ?? true) ? opener : fallback)?.focus({ preventScroll: true });
    if (prefersReducedMotion()) finish();
    else setClosing(true);
  }, [closing, opener, kind, finish]);
  useEffect(() => {
    if (!closing) return;
    const t = window.setTimeout(finish, 200);
    return () => window.clearTimeout(t);
  }, [closing, finish]);
  // Where the keyboard starts: the panel's first control (its board or project
  // picker), not the connection selector, whose ring after a pointer open
  // read as an error. A keyboard open still shows the ring there.
  const bodyRef = useRef<HTMLDivElement>(null);
  const firstControl = useMemo<RefObject<HTMLElement | null>>(() => ({
    get current() {
      const body = bodyRef.current;
      if (!body) return null;
      return Array.from(body.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR)).find(el => isTabbable({
        disabled: (el as HTMLElement & { disabled?: boolean }).disabled,
        tabIndex: el.tabIndex,
        rendered: el.checkVisibility ? el.checkVisibility() : el.getClientRects().length > 0,
      })) ?? null;
    },
  }), []);
  const dialogRef = useModalDismiss(close, { focusRef: firstControl });
  const scrimPress = useScrimDismiss(close);
  useLayoutEffect(() => {
    if (dialogRef.current) dialogRef.current.inert = closing;
  }, [closing, dialogRef]);
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
  if (!def || !Panel || !connection || !helpers) return null;
  const { Glyph } = def;

  return createPortal(
    <div className="modal-backdrop" role="presentation" {...scrimPress}>
      <div ref={dialogRef} id={`integration-${kind}-modal`} className="modal ig-modal" role="dialog" aria-modal="true" aria-labelledby="integration-modal-title"
        data-kind={kind} data-closing={closing || undefined} onClick={event => event.stopPropagation()}
        onAnimationEnd={event => { if (closing && event.target === event.currentTarget) finish(); }}>
        {/* A div, not a <header>: the dialog's label already names it, and a
            second banner landmark is one too many (axe). */}
        <div className="ig-head">
          <h2 className="ig-title" id="integration-modal-title"><span className="ig-title-glyph" aria-hidden><Glyph /></span>{def.label}</h2>
          {connections.length > 1 ? (
            <label className="ig-conn-select">
              <span className="vis-hidden">{t("integrations.modal.connection")}</span>
              <select id={selectId} className="sm-select" value={connection.id} onChange={e => choose(e.target.value)}>
                {connections.map(c => <option key={c.id} value={c.id}>{c.name}{c.name !== connectionHost(c) ? ` · ${connectionHost(c)}` : ""}</option>)}
              </select>
            </label>
          ) : (
            <span className="ig-conn-name" title={connection.baseUrl}>{connection.name}</span>
          )}
          <button type="button" className="glyph-btn ig-close" onClick={close} aria-label={t("integrations.closeProvider", { label: def.label })} title={t("integrations.closeEsc")}>×</button>
        </div>
        <div ref={bodyRef} className="ig-body">
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
