import { useRef, type RefObject } from "react";
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
  const disconnectRef = useRef<HTMLButtonElement>(null);
  const label = provider?.label ?? connection.kind;
  const account = connection.account.name || connection.account.login || "No account read yet";
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
        <p>{label} · Saved connection</p>
      </div>
    </header>
    <dl className="ig-detail-facts">
      <div><dt>Host</dt><dd>{connection.baseUrl}</dd></div>
      <div><dt>Account</dt><dd>{account}{login ? ` (${login})` : ""}</dd></div>
      <div><dt>Last verified</dt><dd>{verified ?? "No verification time available"}</dd></div>
      <div><dt>Credentials</dt><dd>{connection.tokenSaved ? "Stored locally" : "No token saved"}</dd></div>
      {server && <div><dt>Server</dt><dd>{server}</dd></div>}
    </dl>
    {!available && <p className="ig-stranded">{label} is not available on this deck. Disconnect deletes this connection and its saved token.</p>}
    {warnings.length > 0 && <ul className="ig-warnings">{warnings.map(w => <li key={w}>{w}</li>)}</ul>}
    {available && <div className="ig-manage-actions">
      <button type="button" className="btn" disabled={busy !== null && !testing} aria-busy={testing} aria-disabled={testing || undefined} onClick={onTest}>{testing ? "Testing…" : "Test connection"}</button>
      <button type="button" className="btn" disabled={busy !== null} onClick={event => onEdit(event.currentTarget)}>Edit connection</button>
    </div>}
    {note && note.scope !== "disconnect" && <p className="ig-note" data-tone={note.tone} role={note.tone === "err" ? "alert" : "status"}>{note.text}</p>}
    <div className="ig-disconnect-section">
      <h3>Remove connection</h3>
      <p>Remove this connection and its saved token from this machine.</p>
      <div className="ig-manage-actions" data-integration-disconnect-actions onBlur={event => {
        if (armed && !event.currentTarget.contains(event.relatedTarget)) onCancelDisconnect();
      }}>
      <button ref={disconnectRef} type="button" data-integration-disconnect className={`btn danger${armed ? " armed" : ""}`} disabled={busy !== null && !deleting}
        aria-busy={deleting} aria-disabled={deleting || undefined}
        onKeyDown={event => { if (event.repeat) event.preventDefault(); }}
        aria-label={armed ? `Confirm disconnecting ${connection.name}` : `Disconnect ${connection.name}`}
        onClick={event => onDisconnect(event.currentTarget)}>{deleting ? "Disconnecting…" : armed ? "Confirm disconnect" : "Disconnect"}</button>
      {armed && <button type="button" className="btn" disabled={busy !== null} aria-label="Cancel disconnect" onClick={() => { onCancelDisconnect(); disconnectRef.current?.focus(); }}>Cancel</button>}
      </div>
      {armed && <p className="ig-note" role="status">Press Confirm disconnect to delete this connection and its saved token, or Cancel to keep it.</p>}
      {note?.scope === "disconnect" && <p className="ig-note" data-tone={note.tone} role={note.tone === "err" ? "alert" : "status"}>{note.text}</p>}
    </div>
  </section>;
}
