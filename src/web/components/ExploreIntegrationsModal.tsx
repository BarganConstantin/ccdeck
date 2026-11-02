// Native discovery catalog. Connection state belongs to the shared client;
// authentication and provider content stay in their existing surfaces.
import { createPortal } from "react-dom";
import { useT } from "../i18n";
import { connectionsOf, kindOffered, kindOpenable, type IntegrationsState } from "../integrations/client";
import { integrationDefs } from "../integrations/registry";
import type { IntegrationKind } from "../integrations/types";
import { Dialog } from "./Dialog";
import { useModalDismiss, useScrimDismiss } from "./use-modal-dismiss";
import { WaitingLoader } from "./Loader";

export interface ExploreIntegrationsProps {
  integrations: IntegrationsState;
  onClose: () => void;
  onOpen: (kind: IntegrationKind) => void;
  onConnect: (kind: IntegrationKind) => void;
  onManage: (connectionId?: string) => void;
}

const capabilities: Record<IntegrationKind, string> = {
  jira: "integrations.explore.cap.jira",
  github: "integrations.explore.cap.github",
  gitlab: "integrations.explore.cap.gitlab",
};
// What each provider does with your token: Jira also moves issues, by drag or Move
// (since 3.48.0); GitHub and GitLab only read.
const access: Record<IntegrationKind, string> = {
  jira: "integrations.explore.access.jira",
  github: "integrations.explore.access.read",
  gitlab: "integrations.explore.access.read",
};

function exploreLauncher(): HTMLElement | null {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-rail-item="explore-integrations"], [data-rail-item="more"]'))
    .find(el => el.checkVisibility ? el.checkVisibility() : el.getClientRects().length > 0) ?? null;
}

export default function ExploreIntegrationsModal({ integrations, onClose, onOpen, onConnect, onManage }: ExploreIntegrationsProps) {
  const t = useT();
  const dialogRef = useModalDismiss(onClose, { restoreFocusFallback: exploreLauncher });
  const scrimPress = useScrimDismiss(onClose);
  // A backend may offer only some registered UI providers. Stranded saved
  // connections remain discoverable for management, never for invalid reads.
  const providers = integrationDefs().filter(def =>
    integrations.providers.some(p => p.kind === def.kind) || connectionsOf(integrations, def.kind).length > 0);
  const connected = providers.filter(def => kindOpenable(integrations, def.kind)).length;
  const go = (action: () => void) => { onClose(); action(); };

  return createPortal(
    <Dialog scrim={scrimPress} dialogRef={dialogRef} className="explore-integrations"
      labelledBy="explore-integrations-title" aria-describedby="explore-integrations-description">
        <div className="modal-head explore-head">
          <h2 id="explore-integrations-title">{t("integrations.explore.title")}</h2>
          <button type="button" className="glyph-btn" aria-label={t("integrations.explore.closeAria")} title={t("integrations.closeEsc")} onClick={onClose}>×</button>
        </div>
        <div className="explore-body">
          <p id="explore-integrations-description" className="explore-intro">{t("integrations.explore.intro")}</p>
          {integrations.error && <p className="explore-status" role="alert">{integrations.error} {t("integrations.explore.stale")}</p>}
          {integrations.connections === null ? (
            <p className="explore-status" role="status">{integrations.error ? t("integrations.explore.statusUnavailable") : <span className="loader-line"><WaitingLoader busy />{t("integrations.explore.reading")}</span>}</p>
          ) : providers.length === 0 ? (
            <p className="explore-status" role="status">{t("integrations.explore.none")}</p>
          ) : <>
            <div className="explore-caption"><span>{t("integrations.explore.available")}</span><span>{t("integrations.explore.connectedCount", { n: connected })}</span></div>
            <ul className="explore-providers">
              {providers.map(def => {
                const offered = kindOffered(integrations, def.kind);
                const openable = kindOpenable(integrations, def.kind);
                const first = connectionsOf(integrations, def.kind)[0];
                return (
                  <li key={def.kind} className="explore-provider">
                    <div className="explore-info">
                      <div className="explore-name"><h3>{def.label}</h3><span className="explore-tag">{t(access[def.kind])}</span></div>
                      <p>{t(capabilities[def.kind])}</p>
                    </div>
                    <span className="explore-connection">
                      {offered ? openable ? t("integrations.explore.connected") : t("integrations.explore.notConnected") : t("integrations.explore.unavailableOnDeck")}
                    </span>
                    <div className="explore-actions">
                      {openable ? <>
                        <button type="button" className="btn primary" aria-label={t("integrations.explore.openAria", { label: def.label })} onClick={() => go(() => onOpen(def.kind))}>{t("integrations.explore.open")}</button>
                        <button type="button" className="btn explore-text-action" aria-label={t("integrations.manageProvider", { label: def.label })} onClick={() => go(() => onManage(first?.id))}>{t("integrations.manage")}</button>
                      </> : offered ? (
                        <button type="button" className="btn" aria-label={t("integrations.form.connect", { provider: def.label })} onClick={() => go(() => onConnect(def.kind))}>{t("integrations.form.connectBtn")}</button>
                      ) : first ? (
                        <button type="button" className="btn explore-text-action" aria-label={t("integrations.manageProvider", { label: def.label })} onClick={() => go(() => onManage(first.id))}>{t("integrations.manage")}</button>
                      ) : <span className="explore-unavailable">{t("integrations.explore.notAvailable")}</span>}
                    </div>
                  </li>
                );
              })}
            </ul>
          </>}
          <p className="explore-footnote">{t("integrations.explore.footer")}</p>
        </div>
        <div className="explore-footer">
          <button type="button" className="btn" onClick={() => go(() => onManage())}>{t("integrations.explore.manageInSettings")}</button>
          <button type="button" className="btn primary" onClick={onClose}>{t("shell.done")}</button>
        </div>
    </Dialog>, document.body,
  );
}
