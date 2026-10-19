// Settings → Integrations (#2178): the trackers this deck is connected to, and
// the one place to add, check, change or remove a connection.
//
// Provider-agnostic: the list, the Add integration picker, Test, Edit and the
// two-press Disconnect are the core's, and so is the form — drawn from the
// provider's fields and token help (integrations/registry.ts). Nothing here
// ever holds a saved token: a connection only says whether one is saved, and
// an edit form left blank keeps it.
import { useEffect, useRef, useState } from "react";
import {
  connectionHost, createConnection, deleteConnection, IntegrationFailure, takeIntegrationFocus, testConnection,
  updateConnection, useIntegrations,
} from "../integrations/client";
import { clearConnectionPrefs } from "../integrations/prefs";
import { integrationDef, integrationDefs } from "../integrations/registry";
import type { IntegrationConnection as Connection, IntegrationKind } from "../integrations/types";
import { armedPress, CONFIRM_GAP_MS, focusDropped } from "../panel-press";
import IntegrationAvatar from "./IntegrationAvatar";
import IntegrationConnectionForm from "./IntegrationConnectionForm";
import { SettingRow, SettingsGroup } from "./SettingsParts";

type Editing = { mode: "pick" } | { mode: "add"; kind: IntegrationKind } | { mode: "edit"; id: string } | null;
type Note = { id: string; tone: "ok" | "err"; text: string };

/** What one connection's facts line says: the server and how it is reached. */
function connectionFacts(conn: Connection): string {
  const m = conn.meta ?? {};
  const parts: string[] = [];
  if (m.deploymentType === "Cloud") parts.push("Jira Cloud");
  else if (m.deploymentType) parts.push(`Jira ${m.deploymentType === "DataCenter" ? "Data Center" : String(m.deploymentType)}${m.serverVersion ? ` ${m.serverVersion}` : ""}`);
  if (m.checkedAt) {
    const at = new Date(String(m.checkedAt));
    if (!Number.isNaN(at.getTime())) parts.push(`checked ${at.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`);
  }
  return parts.join(" · ");
}

export default function IntegrationsSection() {
  const { connections, providers, error: listError } = useIntegrations();
  const [editing, setEditing] = useState<Editing>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef<string | null>(null);
  const [formError, setFormError] = useState<IntegrationFailure | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [armed, setArmed] = useState<string | null>(null);
  const armedAt = useRef(0);
  const [focused, setFocused] = useState<string | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const rowRefs = useRef(new Map<string, HTMLElement>());

  // A panel's Reconnect opens this at its connection, with its form up.
  useEffect(() => {
    const id = takeIntegrationFocus();
    if (id) { setFocused(id); setEditing({ mode: "edit", id }); }
  }, []);
  useEffect(() => {
    if (!focused || !connections) return;
    rowRefs.current.get(focused)?.scrollIntoView?.({ block: "nearest" });
  }, [focused, connections]);
  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(null), 4_000);
    return () => window.clearTimeout(t);
  }, [armed]);

  const note = (id: string, tone: Note["tone"], text: string) => setNotes(list => [...list.filter(n => n.id !== id), { id, tone, text }]);
  const clearNote = (id: string) => setNotes(list => list.filter(n => n.id !== id));

  /** One request at a time across the section, refused by the handler too. */
  const run = async (tag: string, work: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = tag;
    setBusy(tag);
    try { await work(); }
    finally { busyRef.current = null; setBusy(null); }
  };

  const submitAdd = (kind: IntegrationKind) => (input: Record<string, string>, name: string) => void run("form", async () => {
    setFormError(null);
    try {
      const conn = await createConnection(kind, input, name || undefined);
      setEditing(null);
      note(conn.id, "ok", `Connected as ${conn.account.name || conn.account.login}.`);
      setFocused(conn.id);
    } catch (err) {
      setFormError(err instanceof IntegrationFailure ? err : new IntegrationFailure("upstream", "The connection could not be saved."));
    }
  });

  const submitEdit = (conn: Connection) => (input: Record<string, string>, name: string) => void run("form", async () => {
    setFormError(null);
    try {
      const { connection, validated } = await updateConnection(conn.id, { name, input });
      setEditing(null);
      note(connection.id, "ok", validated ? `Saved and checked: signed in as ${connection.account.name || connection.account.login}.` : "Saved.");
    } catch (err) {
      setFormError(err instanceof IntegrationFailure ? err : new IntegrationFailure("upstream", "The change could not be saved."));
    }
  });

  const test = (conn: Connection) => void run(`test:${conn.id}`, async () => {
    clearNote(conn.id);
    try {
      const fresh = await testConnection(conn.id);
      note(conn.id, "ok", `Working: signed in as ${fresh.account.name || fresh.account.login}.`);
    } catch (err) {
      note(conn.id, "err", err instanceof Error ? err.message : "The test failed.");
    }
  });

  const disconnect = (conn: Connection, pressed: HTMLButtonElement) => {
    const now = Date.now();
    const press = armedPress({ armedFor: armed, target: conn.id, armedAt: armedAt.current, now, gapMs: CONFIRM_GAP_MS });
    if (press === "arm") { setArmed(conn.id); armedAt.current = now; return; }
    if (press === "ignore") return;
    setArmed(null);
    void run(`delete:${conn.id}`, async () => {
      try {
        await deleteConnection(conn.id);
        clearConnectionPrefs(conn.kind, conn.id);
        clearNote(conn.id);
        if (editing?.mode === "edit" && editing.id === conn.id) setEditing(null);
        const active = document.activeElement;
        if (active === pressed || focusDropped(active?.tagName ?? null)) addRef.current?.focus();
      } catch (err) {
        note(conn.id, "err", err instanceof Error ? err.message : "Disconnect failed.");
      }
    });
  };

  const list = connections ?? [];
  const known = integrationDefs().filter(p => providers.length === 0 || providers.some(s => s.kind === p.kind));

  return (
    <>
      <SettingsGroup
        id="integrations-add-title"
        title="Add integration"
        note="Browse your work in a tracker beside your agents. Tokens stay on this machine: they are never shown again, never logged, and never shared with paired decks."
        settingId="integrations-add"
      >
        {editing?.mode === "add" ? (() => {
          const def = integrationDef(editing.kind);
          if (!def) return null;
          return (
            <div className="settings-row ig-form-row">
              <IntegrationConnectionForm def={def} busy={busy === "form"} error={formError}
                onSubmit={submitAdd(editing.kind)}
                onCancel={() => { setEditing(null); setFormError(null); requestAnimationFrame(() => addRef.current?.focus()); }} />
            </div>
          );
        })() : editing?.mode === "pick" ? (
          <>
            {known.map(provider => (
              <SettingRow key={provider.kind} as="div"
                name={<span className="ig-provider-name"><span className="ig-provider-glyph" aria-hidden><provider.Glyph /></span>{provider.label}</span>}
                note={provider.blurb}
                control={<button type="button" className="btn primary" onClick={() => { setFormError(null); setEditing({ mode: "add", kind: provider.kind }); }}>Connect {provider.label}</button>} />
            ))}
            <SettingRow as="div" name="More trackers" note="Further providers will appear here as the deck learns them."
              control={<button type="button" className="btn" onClick={() => { setEditing(null); requestAnimationFrame(() => addRef.current?.focus()); }}>Cancel</button>} />
          </>
        ) : (
          <SettingRow as="div" name="Connect a tracker" note={known.map(p => p.label).join(", ")}
            control={<button ref={addRef} type="button" className="btn" onClick={() => setEditing({ mode: "pick" })}>Add integration</button>} />
        )}
      </SettingsGroup>

      <SettingsGroup
        id="integrations-list-title"
        title="Connections"
        aside={<span className="settings-caption-count">{list.length}</span>}
        settingId="integrations-connections"
      >
        {connections === null && !listError && <p className="settings-row settings-row-status" role="status">Reading connections…</p>}
        {listError && <p className="settings-row settings-row-status ig-error" role="alert">{listError}</p>}
        {connections !== null && list.length === 0 && (
          <p className="settings-row settings-row-status">Nothing connected yet. A tracker you add gets its own button on the left edge, under Accounts and Session list.</p>
        )}
        {list.map(conn => {
          const provider = integrationDef(conn.kind);
          const editingThis = editing?.mode === "edit" && editing.id === conn.id;
          const rowNote = notes.find(n => n.id === conn.id);
          const warnings = Array.isArray(conn.meta?.warnings) ? conn.meta.warnings.filter(w => typeof w === "string") : [];
          const isArmed = armed === conn.id;
          return (
            <div key={conn.id} className="settings-row ig-conn" data-focused={focused === conn.id || undefined}
              ref={el => { if (el) rowRefs.current.set(conn.id, el); else rowRefs.current.delete(conn.id); }}>
              <div className="ig-conn-head">
                <IntegrationAvatar src={conn.account.avatarUrl} name={conn.account.name || conn.account.login || conn.name} size={32} />
                <div className="ig-conn-text">
                  <span className="ig-conn-name">{conn.name}</span>
                  <span className="ig-conn-line">{provider?.label ?? conn.kind} · <span className="ig-mono">{connectionHost(conn)}</span></span>
                  <span className="ig-conn-line">
                    {conn.account.name || conn.account.login
                      ? <>Signed in as {conn.account.name}{conn.account.login && conn.account.login !== conn.account.name ? <> (<span className="ig-mono">{conn.account.login}</span>)</> : null}</>
                      : "No account read yet"}
                    {!conn.tokenSaved && <> · <span className="ig-bad">no token saved</span></>}
                  </span>
                  {connectionFacts(conn) && <span className="ig-conn-line ig-dim">{connectionFacts(conn)}</span>}
                </div>
                {!editingThis && (
                  <div className="ig-conn-actions">
                    <button type="button" className="btn" aria-busy={busy === `test:${conn.id}`} onClick={() => test(conn)}
                      aria-label={`Test ${conn.name}`}>{busy === `test:${conn.id}` ? "Testing…" : "Test"}</button>
                    <button type="button" className="btn" onClick={() => { setFormError(null); setEditing({ mode: "edit", id: conn.id }); }}
                      aria-label={`Edit ${conn.name}`}>Edit</button>
                    <button type="button" className={`btn danger${isArmed ? " armed" : ""}`} aria-busy={busy === `delete:${conn.id}`}
                      onKeyDown={e => { if (e.repeat) e.preventDefault(); }}
                      onClick={e => disconnect(conn, e.currentTarget)}
                      aria-label={isArmed ? `Confirm disconnecting ${conn.name}` : `Disconnect ${conn.name}`}
                      title={isArmed ? "Press again to disconnect. The saved token is deleted from this machine." : "Disconnect and delete the saved token"}>
                      {isArmed ? "Confirm" : "Disconnect"}
                    </button>
                  </div>
                )}
              </div>
              {warnings.length > 0 && (
                <ul className="ig-warnings">{warnings.map(w => <li key={w}>{w}</li>)}</ul>
              )}
              {rowNote && <p className="ig-note" data-tone={rowNote.tone} role={rowNote.tone === "err" ? "alert" : "status"}>{rowNote.text}</p>}
              {editingThis && provider && (
                <IntegrationConnectionForm def={provider} existing={conn} busy={busy === "form"} error={formError}
                  onSubmit={submitEdit(conn)}
                  onCancel={() => { setEditing(null); setFormError(null); }} />
              )}
            </div>
          );
        })}
      </SettingsGroup>
    </>
  );
}
