// Settings → Integrations (#2178): the trackers this deck is connected to, and
// the one place to add, check, change or remove a connection.
//
// Provider-agnostic: the focused configuration view, Test, Edit and the
// two-press Disconnect are the core's, and so is the form — drawn from the
// provider's fields and token help (integrations/registry.ts). Nothing here
// ever holds a saved token: a connection only says whether one is saved, and
// an edit form left blank keeps it.
//
// Only the kinds this deck offers are connected here (offeredKinds). A
// connection of a kind it does not offer is stranded: listed, with a line
// saying so and Disconnect alone, which deletes it and its saved token with
// no provider asked. A deck offering none shows only such connections, and
// Settings draws no section at all once they are gone (sectionsDrawn).
import { useCallback, useEffect, useRef, useState } from "react";
import {
  connectionHost, createConnection, deleteConnection, IntegrationFailure, integrationsReach, kindOffered, offeredKinds, refreshIntegrations,
  takeIntegrationFocus, testConnection, updateConnection, useIntegrations,
} from "../integrations/client";
import { clearConnectionPrefs } from "../integrations/prefs";
import { integrationDef, integrationDefs } from "../integrations/registry";
import type { IntegrationConnection as Connection, IntegrationKind } from "../integrations/types";
import { armedPress, CONFIRM_GAP_MS, focusDropped } from "../panel-press";
import IntegrationConnectionForm from "./IntegrationConnectionForm";
import { SettingsGroup } from "./SettingsParts";

type Editing = { mode: "add"; kind: IntegrationKind } | { mode: "edit"; id: string } | null;
type Note = { id: string; tone: "ok" | "err"; text: string };

/** What one connection's facts line says: the server and how it is reached. */
function connectionFacts(conn: Connection): string {
  const m = conn.meta ?? {};
  const parts: string[] = [];
  if (m.deploymentType === "Cloud") parts.push("Jira Cloud");
  else if (m.deploymentType) parts.push(`Jira ${m.deploymentType === "DataCenter" ? "Data Center" : String(m.deploymentType)}${m.serverVersion ? ` ${m.serverVersion}` : ""}`);
  if (m.checkedAt) {
    const at = new Date(String(m.checkedAt));
    if (!Number.isNaN(at.getTime())) parts.push(`Last verified ${at.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`);
  }
  return parts.join(" · ");
}

/** A shared modal dismissal goes back one level while a form is open. */
export type SettingsLeaveGuard = (action: () => void, back?: boolean) => void;

export default function IntegrationsSection({ onBeforeLeaveChange }: {
  onBeforeLeaveChange?: (guard: SettingsLeaveGuard | null) => void;
} = {}) {
  const integrations = useIntegrations();
  const { connections, error: listError } = integrations;
  const [editing, setEditing] = useState<Editing>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef<string | null>(null);
  const [formError, setFormError] = useState<IntegrationFailure | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [armed, setArmed] = useState<string | null>(null);
  const armedAt = useRef(0);
  const [focused, setFocused] = useState<string | null>(null);
  const addRefs = useRef(new Map<IntegrationKind, HTMLButtonElement>());
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const overviewScroll = useRef(0);
  const [dirty, setDirty] = useState(false);
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const editRefs = useRef(new Map<string, HTMLButtonElement>());
  const rowRefs = useRef(new Map<string, HTMLElement>());

  // A panel's Reconnect opens this at its connection, with its form up.
  useEffect(() => {
    const id = takeIntegrationFocus();
    if (id) { triggerRef.current = editRefs.current.get(id) ?? null; setFocused(id); setEditing({ mode: "edit", id }); }
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
      setPendingLeave(null);
      setDirty(false);
      note(conn.id, "ok", `Connected as ${conn.account.name || conn.account.login}.`);
      setFocused(conn.id);
      requestAnimationFrame(() => editRefs.current.get(conn.id)?.focus());
    } catch (err) {
      setFormError(err instanceof IntegrationFailure ? err : new IntegrationFailure("upstream", "The connection could not be saved."));
    }
  });

  const submitEdit = (conn: Connection) => (input: Record<string, string>, name: string) => void run("form", async () => {
    setFormError(null);
    try {
      const { connection, validated } = await updateConnection(conn.id, { name, input });
      setEditing(null);
      setPendingLeave(null);
      setDirty(false);
      requestAnimationFrame(() => editRefs.current.get(connection.id)?.focus());
      note(connection.id, "ok", validated ? `Saved and checked: signed in as ${connection.account.name || connection.account.login}.` : "Saved.");
    } catch (err) {
      setFormError(err instanceof IntegrationFailure ? err : new IntegrationFailure("upstream", "The change could not be saved."));
    }
  });

  const test = (conn: Connection) => void run(`test:${conn.id}`, async () => {
    clearNote(conn.id);
    try {
      const fresh = await testConnection(conn.id);
      note(conn.id, "ok", `Verified as ${fresh.account.name || fresh.account.login}.`);
    } catch (err) {
      note(conn.id, "err", err instanceof Error ? err.message : "The test failed.");
    }
  });

  const disconnect = (conn: Connection, pressed: HTMLButtonElement) => {
    if (busyRef.current) return;
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
        // The provider's Add connection, or, where nothing can be added, the section's own
        // tab, which stays drawn while the section is on show.
        if (active === pressed || focusDropped(active?.tagName ?? null)) {
          requestAnimationFrame(() => (addRefs.current.get(conn.kind) ?? document.getElementById("settings-tab-integrations"))?.focus());
        }
      } catch (err) {
        note(conn.id, "err", err instanceof Error ? err.message : "Disconnect failed.");
      }
    });
  };

  const list = connections ?? [];
  // The kinds this deck offers, and nothing until the list is read: a deck
  // that offers none must not be asked to connect one.
  const offered = offeredKinds(integrations);
  const order = ["github", "gitlab", "jira"];
  const known = integrationDefs().filter(p => offered.has(p.kind)).sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  const reach = integrationsReach(integrations);

  const closeForm = useCallback(() => {
    setEditing(null);
    setDirty(false);
    setPendingLeave(null);
    setFormError(null);
    requestAnimationFrame(() => {
      const trigger = triggerRef.current;
      const pane = trigger?.closest<HTMLElement>(".settings-pane");
      if (pane) pane.scrollTop = overviewScroll.current;
      (trigger?.isConnected ? trigger : document.getElementById("settings-tab-integrations"))?.focus({ preventScroll: true });
    });
  }, []);

  const leave = useCallback<SettingsLeaveGuard>((action, back = false) => {
    if (busyRef.current) return;
    if (pendingLeave && back) {
      setPendingLeave(null);
      requestAnimationFrame(() => document.querySelector<HTMLInputElement>(".ig-config-view input:not([disabled])")?.focus());
      return;
    }
    if (back) action = closeForm;
    if (dirty) setPendingLeave(() => action);
    else { setEditing(null); setDirty(false); action(); }
  }, [dirty, pendingLeave, closeForm]);

  useEffect(() => {
    onBeforeLeaveChange?.(editing ? leave : null);
    return () => onBeforeLeaveChange?.(null);
  }, [editing, leave, onBeforeLeaveChange]);
  useEffect(() => { if (pendingLeave) keepRef.current?.focus(); }, [pendingLeave]);

  const begin = (next: NonNullable<Editing>, trigger: HTMLButtonElement) => {
    if (busyRef.current) return;
    setPendingLeave(null);
    overviewScroll.current = trigger.closest<HTMLElement>(".settings-pane")?.scrollTop ?? 0;
    triggerRef.current = trigger;
    setDirty(false);
    setFormError(null);
    setEditing(next);
    const pane = trigger.closest<HTMLElement>(".settings-pane");
    if (pane) pane.scrollTop = 0;
  };

  const renderConnection = (conn: Connection) => {
    const provider = integrationDef(conn.kind);
    // A kind this deck does not offer: nothing to test or edit with, so
    // Disconnect alone, which needs no provider.
    const stranded = !kindOffered(integrations, conn.kind);
    const editingThis = !stranded && editing?.mode === "edit" && editing.id === conn.id;
    const rowNote = notes.find(n => n.id === conn.id);
    const warnings = Array.isArray(conn.meta?.warnings) ? conn.meta.warnings.filter(w => typeof w === "string") : [];
    const isArmed = armed === conn.id;
    return (
      <div key={conn.id} className="ig-conn" data-focused={focused === conn.id || undefined}
        ref={el => { if (el) rowRefs.current.set(conn.id, el); else rowRefs.current.delete(conn.id); }}>
        <div className="ig-conn-head">
          <div className="ig-conn-text">
            <span className="ig-conn-heading"><span className="ig-conn-name">{conn.name}</span>{conn.name !== connectionHost(conn) && <span className="ig-conn-line ig-mono">{connectionHost(conn)}</span>}</span>
            <span className="ig-conn-line">
              {conn.account.name || conn.account.login
                ? <>{conn.account.name || conn.account.login}{conn.account.name && conn.account.login && conn.account.login !== conn.account.name ? <> (<span className="ig-mono">{conn.account.login}</span>)</> : null}</>
                : "No account read yet"}
              {!conn.tokenSaved && <> · <span className="ig-bad">no token saved</span></>}
            </span>
            {connectionFacts(conn) && <span className="ig-conn-line ig-dim">{connectionFacts(conn)}</span>}
            {stranded && (
              <span className="ig-stranded">
                {provider?.label ?? conn.kind} is not available on this deck. Disconnect deletes this connection and its saved token.
              </span>
            )}
          </div>
          {!editingThis && (
            <div className="ig-conn-actions">
              {!stranded && <>
                <button type="button" className="btn ig-action" disabled={busy !== null && busy !== `test:${conn.id}`} aria-disabled={busy === `test:${conn.id}` || undefined} aria-busy={busy === `test:${conn.id}`} onClick={() => test(conn)}
                  aria-label={`Test ${conn.name}`}>{busy === `test:${conn.id}` ? "Testing…" : "Test"}</button>
                <button ref={el => { if (el) editRefs.current.set(conn.id, el); else editRefs.current.delete(conn.id); }} type="button" className="btn ig-action ig-edit" disabled={busy !== null || editing !== null} onClick={event => begin({ mode: "edit", id: conn.id }, event.currentTarget)}
                  aria-label={`Edit ${conn.name}`}>Edit</button>
              </>}
              <button type="button" className={`btn ig-disconnect${isArmed ? " danger armed" : ""}`} disabled={busy !== null && busy !== `delete:${conn.id}`} aria-disabled={busy === `delete:${conn.id}` || undefined} aria-busy={busy === `delete:${conn.id}`}
                onKeyDown={e => { if (e.repeat) e.preventDefault(); }}
                onClick={e => disconnect(conn, e.currentTarget)}
                aria-label={isArmed ? `Confirm disconnecting ${conn.name}` : `Disconnect ${conn.name}`}
                title={isArmed ? "Press again to disconnect. The saved token is deleted from this machine." : "Disconnect and delete the saved token"}>
                {busy === `delete:${conn.id}` ? "Disconnecting…" : isArmed ? "Confirm disconnect" : "Disconnect"}
              </button>
            </div>
          )}
        </div>
        {isArmed && <p className="ig-note" role="status">Press Confirm to disconnect and delete the saved token.</p>}
        {warnings.length > 0 && (
          <ul className="ig-warnings">{warnings.map(w => <li key={w}>{w}</li>)}</ul>
        )}
        {rowNote && <p className="ig-note" data-tone={rowNote.tone} role={rowNote.tone === "err" ? "alert" : "status"}>{rowNote.text}</p>}

      </div>
    );
  };

  const stranded = list.filter(conn => !known.some(provider => provider.kind === conn.kind));
  const editedConnection = editing?.mode === "edit" ? list.find(conn => conn.id === editing.id) : undefined;
  const formProvider = editing?.mode === "add" ? known.find(provider => provider.kind === editing.kind)
    : editedConnection && known.find(provider => provider.kind === editedConnection.kind);

  return (
    <div className="ig-settings">
      {editing && <div className="ig-config-view">
        <button type="button" className="btn ig-back-to-overview" disabled={busy !== null} onClick={() => leave(closeForm)}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m7 3-5 5 5 5M2 8h12" /></svg>
          All integrations
        </button>
        {pendingLeave && <div className="ig-leave-confirm" role="group" aria-labelledby="ig-leave-title">
          <strong id="ig-leave-title">Discard unsaved changes?</strong>
          <p>Your changes have not been saved. Discarding clears this form, including any token you entered.</p>
          <div className="ig-form-actions">
            <button ref={keepRef} type="button" className="btn" onClick={() => { setPendingLeave(null); requestAnimationFrame(() => document.querySelector<HTMLInputElement>(".ig-config-view input:not([disabled])")?.focus()); }}>Keep editing</button>
            <button type="button" className="btn danger" onClick={() => { const action = pendingLeave; setPendingLeave(null); setDirty(false); setEditing(null); action(); }}>Discard changes</button>
          </div>
        </div>}
        <div hidden={Boolean(pendingLeave)}>
        {formProvider ? <IntegrationConnectionForm key={editing.mode === "add" ? editing.kind : editing.id}
          def={formProvider} existing={editedConnection} busy={busy === "form"} error={formError} onDirtyChange={setDirty}
          onSubmit={editing.mode === "add" ? submitAdd(editing.kind) : submitEdit(editedConnection!)}
          onCancel={() => leave(closeForm)} />
          : <div role="status"><p>This provider or connection is no longer available.</p><button type="button" className="btn" onClick={closeForm}>Back to integrations</button></div>}
        </div>
      </div>}
      <div className="ig-overview" hidden={editing !== null} data-setting="integrations-connections">
        {listError && <div className="ig-list-error" role="alert">
          <p>{listError}</p><button type="button" className="btn" onClick={() => void refreshIntegrations()}>Retry</button>
        </div>}
        {connections === null && !listError && <p role="status">Reading connections…</p>}
        {reach === "all" && <div className="ig-providers" data-setting="integrations-add" id="integrations-add-title">
          {known.map(provider => {
            const saved = list.filter(conn => conn.kind === provider.kind);
            return <SettingsGroup key={provider.kind} id={`ig-provider-${provider.kind}`}
              className="ig-provider" settingId={`integration-${provider.kind}`} list={false}
              title={<span className="ig-provider-name"><span className="ig-provider-glyph" aria-hidden><provider.Glyph /></span>{provider.label}</span>}
              note={saved.length ? `${saved.length} saved connection${saved.length === 1 ? "" : "s"}` : `Not connected · ${provider.detail}.`}
              aside={<button type="button" className={`btn${saved.length ? "" : " primary"}`}
                ref={el => { if (el) addRefs.current.set(provider.kind, el); else addRefs.current.delete(provider.kind); }}
                disabled={busy !== null}
                aria-label={`${saved.length ? "Add another" : "Connect"} ${provider.label}${saved.length ? " connection" : ""}`}
                onClick={event => begin({ mode: "add", kind: provider.kind }, event.currentTarget)}>{saved.length ? "Add connection" : "Connect"}</button>}>
              {saved.length > 0 && <div className="ig-connections">{saved.map(renderConnection)}</div>}
            </SettingsGroup>;
          })}
          <p className="ig-storage-note">Read-only access. Tokens stay on this machine and are never shown again or shared with paired decks.</p>
        </div>}
        {(stranded.length > 0 || (reach !== "all" && connections !== null)) && <SettingsGroup
          id="integrations-list-title" title="Connections"
          aside={<span className="settings-caption-count">{stranded.length}</span>}>
          {stranded.map(renderConnection)}
          {list.length === 0 && <p className="settings-row settings-row-status">Nothing connected.</p>}
        </SettingsGroup>}
      </div>
    </div>
  );
}
