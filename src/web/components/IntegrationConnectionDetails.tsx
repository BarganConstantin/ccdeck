import { useRef, type RefObject } from "react";
import { currentLanguage, useT } from "../i18n";
import type { IntegrationConnection, IntegrationWebDef } from "../integrations/types";

/** Historical evidence only; a saved connection is not a live health check. */
export function verificationTime(connection: IntegrationConnection): string | null {
  const raw = connection.meta?.checkedAt;
  if (!raw) return null;
  const at = new Date(String(raw));
  return Number.isNaN(at.getTime()) ? null : at.toLocaleString(currentLanguage(), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", ...(at.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
}

export function connectionServer(connection: IntegrationConnection): string | null {
  const meta = connection.meta ?? {};
  if (connection.kind === "gitlab") return typeof meta.serverVersion === "string" && meta.serverVersion ? `GitLab ${meta.serverVersion}` : null;
  if (connection.kind !== "jira") return null;
  if (meta.deploymentType === "Cloud") return "Jira Cloud";
  if (!meta.deploymentType) return null;
  return `Jira ${meta.deploymentType === "DataCenter" ? "Data Center" : String(meta.deploymentType)}${meta.serverVersion ? ` ${meta.serverVersion}` : ""}`;
}

export default function IntegrationConnectionDetails({ connection, provider, available, busy, armed, note, headingRef,
  onTest, onEdit, onDisconnect, onCancelDisconnect }: {
  connection: IntegrationConnection;
  provider: IntegrationWebDef | null;
  available: boolean;
  busy: string | null;
  armed: boolean;
  note?: { tone: "ok" | "err"; text: string; scope?: "disconnect" };
  headingRef: RefObject<HTMLHeadingElement>;
  onTest: () => void;
  onEdit: (button: HTMLButtonElement) => void;
  onDisconnect: (button: HTMLButtonElement) => void;
  onCancelDisconnect: () => void;
}) {
  const t = useT();
  const disconnectRef = useRef<HTMLButtonElement>(null);
  const label = provider?.label ?? connection.kind;
  const account = connection.account.name || connection.account.login || t("integrations.conn.noAccount");
  const login = connection.account.name && connection.account.login !== connection.account.name ? connection.account.login : "";
  const verified = verificationTime(connection);
  const server = connectionServer(connection);
  const warnings = Array.isArray(connection.meta?.warnings) ? connection.meta.warnings.filter(w => typeof w === "string") : [];
  const testing = busy === `test:${connection.id}`;
  const deleting = busy === `delete:${connection.id}`;
  return <section className="ig-connection-details" aria-labelledby="ig-managed-title">
    <header className="ig-managed-header">
      {provider && <span className="ig-provider-glyph" aria-hidden><provider.Glyph /></span>}
      <div className="ig-managed-identity">
        <h2 ref={headingRef} tabIndex={-1} id="ig-managed-title" className="ig-managed-title">{connection.name || connection.baseUrl}</h2>
        <p>{t("integrations.conn.saved", { label })}</p>
      </div>
    </header>
    <dl className="ig-detail-facts">
      <div><dt>{t("integrations.conn.host")}</dt><dd>{connection.baseUrl}</dd></div>
      <div><dt>{t("integrations.conn.account")}</dt><dd>{account}{login ? ` (${login})` : ""}</dd></div>
      <div><dt>{t("integrations.conn.lastVerified")}</dt><dd>{verified ?? t("integrations.conn.noVerificationTime")}</dd></div>
      <div><dt>{t("integrations.conn.credentials")}</dt><dd>{connection.tokenSaved ? t("integrations.conn.storedLocally") : t("integrations.conn.noToken")}</dd></div>
      {server && <div><dt>{t("integrations.conn.server")}</dt><dd>{server}</dd></div>}
    </dl>
    {!available && <p className="ig-stranded">{t("integrations.conn.strandedDisconnect", { label })}</p>}
    {warnings.length > 0 && <ul className="ig-warnings">{warnings.map(w => <li key={w}>{w}</li>)}</ul>}
    {available && <div className="ig-manage-actions">
      <button type="button" className="btn" aria-busy={testing} aria-disabled={busy !== null || undefined} onClick={onTest}>{testing ? t("integrations.conn.testing") : t("integrations.conn.test")}</button>
      <button type="button" className="btn" aria-disabled={busy !== null || undefined} onClick={event => { if (busy === null) onEdit(event.currentTarget); }}>{t("integrations.conn.edit")}</button>
    </div>}
    {note && note.scope !== "disconnect" && <p className="ig-note" data-tone={note.tone} role={note.tone === "err" ? "alert" : "status"}>{note.text}</p>}
    <div className="ig-disconnect-section">
      <h3>{t("integrations.conn.removeTitle")}</h3>
      <p>{t("integrations.conn.removeBody")}</p>
      <div className="ig-manage-actions" data-integration-disconnect-actions onBlur={event => {
        if (armed && !event.currentTarget.contains(event.relatedTarget)) onCancelDisconnect();
      }}>
      <button ref={disconnectRef} type="button" data-integration-disconnect className={`btn danger${armed ? " armed" : ""}`}
        aria-busy={deleting} aria-disabled={busy !== null || undefined}
        onKeyDown={event => { if (event.repeat) event.preventDefault(); }}
        aria-label={armed ? t("integrations.conn.confirmAria", { name: connection.name }) : t("integrations.conn.disconnectAria", { name: connection.name })}
        onClick={event => onDisconnect(event.currentTarget)}>{deleting ? t("integrations.conn.disconnecting") : armed ? t("integrations.conn.confirmDisconnect") : t("integrations.conn.disconnect")}</button>
      {armed && <button type="button" className="btn" data-integration-cancel-disconnect aria-disabled={busy !== null || undefined} aria-label={t("integrations.conn.cancelDisconnect")} onClick={() => { if (busy !== null) return; onCancelDisconnect(); disconnectRef.current?.focus(); }}>{t("integrations.cancel")}</button>}
      </div>
      {armed && <p className="ig-note" role="status">{t("integrations.conn.pressConfirm")}</p>}
      {note?.scope === "disconnect" && <p className="ig-note" data-tone={note.tone} role={note.tone === "err" ? "alert" : "status"}>{note.text}</p>}
    </div>
  </section>;
}
