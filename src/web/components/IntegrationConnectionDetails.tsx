import type { RefObject } from "react";
import type { IntegrationConnection, IntegrationWebDef } from "../integrations/types";

/** Historical evidence only; a saved connection is not a live health check. */
export function verificationTime(connection: IntegrationConnection): string | null {
  const raw = connection.meta?.checkedAt;
  if (!raw) return null;
  const at = new Date(String(raw));
  return Number.isNaN(at.getTime()) ? null : at.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", ...(at.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
}

export function connectionServer(connection: IntegrationConnection): string | null {
  const meta = connection.meta ?? {};
  if (meta.deploymentType === "Cloud") return "Jira Cloud";
  if (!meta.deploymentType) return null;
  return `Jira ${meta.deploymentType === "DataCenter" ? "Data Center" : String(meta.deploymentType)}${meta.serverVersion ? ` ${meta.serverVersion}` : ""}`;
}

export default function IntegrationConnectionDetails({ connection, provider, available, busy, armed, note, headingRef,
  onTest, onEdit, onAdd, onDisconnect }: {
  connection: IntegrationConnection;
  provider: IntegrationWebDef | null;
  available: boolean;
  busy: string | null;
  armed: boolean;
  note?: { tone: "ok" | "err"; text: string };
  headingRef: RefObject<HTMLHeadingElement>;
  onTest: () => void;
  onEdit: (button: HTMLButtonElement) => void;
  onAdd: (button: HTMLButtonElement) => void;
  onDisconnect: (button: HTMLButtonElement) => void;
}) {
  const label = provider?.label ?? connection.kind;
  const account = connection.account.name || connection.account.login || "No account read yet";
  const login = connection.account.name && connection.account.login !== connection.account.name ? connection.account.login : "";
  const verified = verificationTime(connection);
  const server = connectionServer(connection);
  const warnings = Array.isArray(connection.meta?.warnings) ? connection.meta.warnings.filter(w => typeof w === "string") : [];
  const testing = busy === `test:${connection.id}`;
  const deleting = busy === `delete:${connection.id}`;
  return <section className="ig-connection-details" aria-labelledby="ig-managed-title">
    <h3 ref={headingRef} tabIndex={-1} id="ig-managed-title" className="ig-managed-title">
      {provider && <span className="ig-provider-glyph" aria-hidden><provider.Glyph /></span>}{label} connection
    </h3>
    <dl className="ig-detail-facts">
      <div><dt>Connection name</dt><dd>{connection.name}</dd></div>
      <div><dt>Host</dt><dd className="ig-mono">{connection.baseUrl}</dd></div>
      <div><dt>Account</dt><dd>{account}{login ? ` (${login})` : ""}</dd></div>
      {server && <div><dt>Server</dt><dd>{server}</dd></div>}
      <div><dt>Last verified</dt><dd>{verified ?? "No verification time available"}</dd></div>
      <div><dt>Token</dt><dd>{connection.tokenSaved ? "Saved on this machine" : "No token saved"}</dd></div>
    </dl>
    {!available && <p className="ig-stranded">{label} is not available on this deck. Disconnect deletes this connection and its saved token.</p>}
    {warnings.length > 0 && <ul className="ig-warnings">{warnings.map(w => <li key={w}>{w}</li>)}</ul>}
    {available && <div className="ig-manage-actions">
      <button type="button" className="btn primary" disabled={busy !== null} onClick={event => onEdit(event.currentTarget)}>Edit connection</button>
      <button type="button" className="btn" disabled={busy !== null && !testing} aria-busy={testing} aria-disabled={testing || undefined} onClick={onTest}>{testing ? "Testing…" : "Test connection"}</button>
      <button type="button" className="btn" disabled={busy !== null} aria-label={`Add another ${label} connection`} onClick={event => onAdd(event.currentTarget)}>Add connection</button>
    </div>}
    {note && <p className="ig-note" data-tone={note.tone} role={note.tone === "err" ? "alert" : "status"}>{note.text}</p>}
    <div className="ig-disconnect-section">
      <h4>Disconnect</h4>
      <p>Remove this connection and its saved token from this machine.</p>
      <button type="button" className={`btn ig-disconnect${armed ? " danger armed" : ""}`} disabled={busy !== null && !deleting}
        aria-busy={deleting} aria-disabled={deleting || undefined}
        onKeyDown={event => { if (event.repeat) event.preventDefault(); }}
        aria-label={armed ? `Confirm disconnecting ${connection.name}` : `Disconnect ${connection.name}`}
        onClick={event => onDisconnect(event.currentTarget)}>{deleting ? "Disconnecting…" : armed ? "Confirm disconnect" : "Disconnect"}</button>
      {armed && <p className="ig-note" role="status">Press Confirm disconnect to delete this connection and its saved token.</p>}
    </div>
  </section>;
}
