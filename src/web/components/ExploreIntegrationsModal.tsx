// Native discovery catalog. Connection state belongs to the shared client;
// authentication and provider content stay in their existing surfaces.
import { createPortal } from "react-dom";
import { connectionsOf, kindOffered, kindOpenable, type IntegrationsState } from "../integrations/client";
import { integrationDefs } from "../integrations/registry";
import type { IntegrationKind } from "../integrations/types";
import { useModalDismiss, useScrimDismiss } from "./use-modal-dismiss";
import { ExternalLinkGlyph } from "./action-glyphs";

export interface ExploreIntegrationsProps {
  integrations: IntegrationsState;
  onClose: () => void;
  onOpen: (kind: IntegrationKind) => void;
  onConnect: (kind: IntegrationKind) => void;
  onManage: (connectionId?: string) => void;
}

const capabilities: Record<IntegrationKind, string> = {
  jira: "Boards, sprints, backlog and issues",
  github: "Repositories, pull requests and Actions",
  gitlab: "Projects, merge requests and pipelines",
};

function exploreLauncher(): HTMLElement | null {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-rail-item="explore-integrations"], [data-rail-item="more"]'))
    .find(el => el.checkVisibility ? el.checkVisibility() : el.getClientRects().length > 0) ?? null;
}

export default function ExploreIntegrationsModal({ integrations, onClose, onOpen, onConnect, onManage }: ExploreIntegrationsProps) {
  const dialogRef = useModalDismiss(onClose, { restoreFocusFallback: exploreLauncher });
  const scrimPress = useScrimDismiss(onClose);
  // A backend may offer only some registered UI providers. Stranded saved
  // connections remain discoverable for management, never for invalid reads.
  const providers = integrationDefs().filter(def =>
    integrations.providers.some(p => p.kind === def.kind) || connectionsOf(integrations, def.kind).length > 0);
  const connected = providers.filter(def => kindOpenable(integrations, def.kind)).length;
  const go = (action: () => void) => { onClose(); action(); };

  return createPortal(
    <div className="modal-backdrop" role="presentation" {...scrimPress}>
      <div ref={dialogRef} className="modal explore-integrations" role="dialog" aria-modal="true"
        aria-labelledby="explore-integrations-title" aria-describedby="explore-integrations-description">
        <div className="explore-head">
          <div>
            <h2 id="explore-integrations-title">Explore integrations</h2>
            <p id="explore-integrations-description">Connect your project tools and keep the work behind each agent close by.</p>
          </div>
          <button type="button" className="glyph-btn" aria-label="Close Explore integrations" title="Close (Esc)" onClick={onClose}>×</button>
        </div>
        <div className="explore-body">
          {integrations.error && <p className="explore-status" role="alert">{integrations.error} Connection status may be out of date. Manage connections in Settings.</p>}
          {integrations.connections === null ? (
            <p className="explore-status" role="status">{integrations.error ? "Connection status is unavailable." : "Reading integrations…"}</p>
          ) : providers.length === 0 ? (
            <p className="explore-status" role="status">No integrations are available on this deck.</p>
          ) : <>
            <div className="explore-caption"><span>Available integrations</span><span>{connected} connected</span></div>
            <ul className="explore-providers">
              {providers.map(def => {
                const offered = kindOffered(integrations, def.kind);
                const openable = kindOpenable(integrations, def.kind);
                const first = connectionsOf(integrations, def.kind)[0];
                return (
                  <li key={def.kind} className="explore-provider">
                    <span className="explore-glyph" aria-hidden><def.Glyph /></span>
                    <div className="explore-info">
                      <h3>{def.label}</h3>
                      <p>{capabilities[def.kind]}</p>
                      <span className="explore-connection" data-connected={openable || undefined}>
                        {offered ? openable ? "Connected" : "Not connected" : "Unavailable on this deck"} · Read only
                      </span>
                    </div>
                    <div className="explore-actions">
                      {openable ? <>
                        <button type="button" className="btn" aria-label={`Open ${def.label}`} onClick={() => go(() => onOpen(def.kind))}>Open <ExternalLinkGlyph /></button>
                        <button type="button" className="btn explore-text-action" aria-label={`Manage ${def.label}`} onClick={() => go(() => onManage(first?.id))}>Manage</button>
                      </> : offered ? (
                        <button type="button" className="btn primary" aria-label={`Connect ${def.label}`} onClick={() => go(() => onConnect(def.kind))}>Connect</button>
                      ) : first ? (
                        <button type="button" className="btn explore-text-action" aria-label={`Manage ${def.label}`} onClick={() => go(() => onManage(first.id))}>Manage</button>
                      ) : <span className="explore-unavailable">Not available</span>}
                    </div>
                  </li>
                );
              })}
            </ul>
          </>}
        </div>
        <div className="explore-footer">
          <span>Read only · Tokens stay on this machine</span>
          <button type="button" className="btn explore-text-action" onClick={() => go(() => onManage())}>Manage in Settings <ExternalLinkGlyph /></button>
        </div>
      </div>
    </div>, document.body,
  );
}
