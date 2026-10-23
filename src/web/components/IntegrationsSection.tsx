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
import IntegrationConnectionDetails, { connectionServer, verificationTime } from "./IntegrationConnectionDetails";
import { SettingsGroup } from "./SettingsParts";

type Editing = { mode: "add"; kind: IntegrationKind } | { mode: "edit"; id: string } | null;
type Note = { id: string; tone: "ok" | "err"; text: string; scope?: "disconnect" };

/** A shared modal dismissal goes back one level while a form is open. */
export type SettingsLeaveGuard = (action: () => void, back?: boolean) => void;

export default function IntegrationsSection({ onBeforeLeaveChange }: {
  onBeforeLeaveChange?: (guard: SettingsLeaveGuard | null) => void;
} = {}) {
  const integrations = useIntegrations();
  const { connections, error: listError } = integrations;
  const [managedId, setManagedId] = useState<string | null>(null);
  const [overviewNotice, setOverviewNotice] = useState("");
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  const formTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef<string | null>(null);
  const [formError, setFormError] = useState<IntegrationFailure | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [armed, setArmed] = useState<string | null>(null);
  const armedAt = useRef(0);
  const [focused, setFocused] = useState<string | null>(null);
  const focusAfterChange = useRef<(() => HTMLElement | null | undefined) | null>(null);
  const addRefs = useRef(new Map<IntegrationKind, HTMLButtonElement>());
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const overviewScroll = useRef(0);
  const [dirty, setDirty] = useState(false);
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const manageRefs = useRef(new Map<string, HTMLButtonElement>());
  const rowRefs = useRef(new Map<string, HTMLElement>());

  // A panel's Reconnect opens this at its connection, with its form up.
  useEffect(() => {
    const id = takeIntegrationFocus();
    if (id) { triggerRef.current = manageRefs.current.get(id) ?? null; setManagedId(id); setFocused(id); setEditing({ mode: "edit", id }); }
  }, []);
  useEffect(() => {
    if (!focused || !connections) return;
    rowRefs.current.get(focused)?.scrollIntoView?.({ block: "nearest" });
  }, [focused, connections]);
  useEffect(() => {
    if (!armed) return;
    const cancel = () => {
      // Cancel can disappear while the window loses focus; retain its return target.
      if (document.activeElement?.getAttribute("aria-label") === "Cancel disconnect") {
        document.querySelector<HTMLButtonElement>(".ig-manage-view .ig-disconnect")?.focus();
      }
      setArmed(null);
    };
    const onVisibility = () => { if (document.hidden) cancel(); };
    const t = window.setTimeout(() => {
      // Reading an engaged confirmation has no deadline. Leaving its action
      // cancels immediately; four seconds remains an unfocused safety fallback.
      if (!document.querySelector(".ig-disconnect-actions")?.contains(document.activeElement)) cancel();
    }, 4_000);
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [armed]);

  const note = (id: string, tone: Note["tone"], text: string, scope?: Note["scope"]) => setNotes(list => [...list.filter(n => n.id !== id), { id, tone, text, scope }]);
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
      setManagedId(null);
      setOverviewNotice("Connection added.");
      note(conn.id, "ok", `Connection saved and tested as ${conn.account.name || conn.account.login}.`);
      setFocused(conn.id);
      focusAfterChange.current = () => {
        const target = manageRefs.current.get(conn.id);
        target?.scrollIntoView?.({ block: "nearest" });
        return target;
      };
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
      focusAfterChange.current = () => formTriggerRef.current ?? (managedId ? detailHeadingRef.current : manageRefs.current.get(connection.id));
      note(connection.id, "ok", validated ? `Saved. Connection test passed as ${connection.account.name || connection.account.login}.` : "Saved.");
    } catch (err) {
      setFormError(err instanceof IntegrationFailure ? err : new IntegrationFailure("upstream", "The change could not be saved."));
    }
  });

  const test = (conn: Connection) => void run(`test:${conn.id}`, async () => {
    setArmed(null);
    clearNote(conn.id);
    try {
      const fresh = await testConnection(conn.id);
      note(conn.id, "ok", `Connection test passed. Signed in as ${fresh.account.name || fresh.account.login}.`);
    } catch (err) {
      note(conn.id, "err", err instanceof Error ? err.message : "The test failed.");
    }
  });

  const disconnect = (conn: Connection, pressed: HTMLButtonElement) => {
    if (busyRef.current) return;
    const now = Date.now();
    const press = armedPress({ armedFor: armed, target: conn.id, armedAt: armedAt.current, now, gapMs: CONFIRM_GAP_MS });
    if (press === "arm") { pressed.focus({ preventScroll: true }); setArmed(conn.id); armedAt.current = now; return; }
    if (press === "ignore") return;
    setArmed(null);
    void run(`delete:${conn.id}`, async () => {
      try {
        await deleteConnection(conn.id);
        clearConnectionPrefs(conn.kind, conn.id);
        clearNote(conn.id);
        if (editing?.mode === "edit" && editing.id === conn.id) setEditing(null);
        setManagedId(null);
        setOverviewNotice("Connection disconnected.");
        const active = document.activeElement;
        // Restore focus after the overview has actually committed. A frame
        // callback can run while its controls still have a hidden ancestor.
        if (active === pressed || focusDropped(active?.tagName ?? null)) focusAfterChange.current = () => {
          const remaining = (connections ?? []).find(c => c.kind === conn.kind && c.id !== conn.id);
          return remaining && manageRefs.current.get(remaining.id) || addRefs.current.get(conn.kind) || document.getElementById("settings-tab-integrations");
        };
      } catch (err) {
        note(conn.id, "err", err instanceof Error ? err.message : "The connection could not be removed. Try again.", "disconnect");
      }
    });
  };

  useEffect(() => {
    if (busy !== null || pendingLeave || !focusAfterChange.current) return;
    const target = focusAfterChange.current();
    focusAfterChange.current = null;
    if (target?.isConnected && (target.checkVisibility ? target.checkVisibility() : target.getClientRects().length > 0)) {
      target.focus({ preventScroll: true });
    }
  }, [connections, managedId, editing, busy, pendingLeave]);

  const list = connections ?? [];
  // The kinds this deck offers, and nothing until the list is read: a deck
  // that offers none must not be asked to connect one.
  const offered = offeredKinds(integrations);
  const order = ["github", "gitlab", "jira"];
  const known = integrationDefs().filter(p => offered.has(p.kind)).sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  const reach = integrationsReach(integrations);

  const backToOverview = useCallback(() => {
    setEditing(null); setManagedId(null); setDirty(false); setPendingLeave(null); setFormError(null); setArmed(null);
    focusAfterChange.current = () => {
      const trigger = triggerRef.current;
      const pane = trigger?.closest<HTMLElement>(".settings-pane");
      if (pane) pane.scrollTop = overviewScroll.current;
      return trigger?.isConnected ? trigger : document.getElementById("settings-tab-integrations");
    };
  }, []);

  const closeForm = useCallback(() => {
    if (!managedId) { backToOverview(); return; }
    setEditing(null); setDirty(false); setPendingLeave(null); setFormError(null);
    focusAfterChange.current = () => formTriggerRef.current ?? detailHeadingRef.current;
  }, [managedId, backToOverview]);

  const leave = useCallback<SettingsLeaveGuard>((action, back = false) => {
    if (busyRef.current) return;
    if (pendingLeave && back) {
      setPendingLeave(null);
      requestAnimationFrame(() => document.querySelector<HTMLInputElement>(".ig-config-view input:not([disabled])")?.focus());
      return;
    }
    const accepted = back ? (editing ? closeForm : backToOverview) : () => { setEditing(null); setManagedId(null); action(); };
    if (dirty) setPendingLeave(() => accepted);
    else { setDirty(false); accepted(); }
  }, [dirty, pendingLeave, editing, closeForm, backToOverview]);

  useEffect(() => {
    onBeforeLeaveChange?.(editing || managedId ? leave : null);
    return () => onBeforeLeaveChange?.(null);
  }, [editing, managedId, leave, onBeforeLeaveChange]);
  useEffect(() => { if (pendingLeave) keepRef.current?.focus(); }, [pendingLeave]);
  useEffect(() => { if (managedId) detailHeadingRef.current?.focus(); }, [managedId]);

  const begin = (next: NonNullable<Editing>, trigger: HTMLButtonElement) => {
    if (busyRef.current) return;
    focusAfterChange.current = null;
    setPendingLeave(null); setOverviewNotice(""); setArmed(null);
    if (managedId) formTriggerRef.current = trigger;
    else {
      overviewScroll.current = trigger.closest<HTMLElement>(".settings-pane")?.scrollTop ?? 0;
      triggerRef.current = trigger;
      formTriggerRef.current = null;
    }
    setDirty(false); setFormError(null); setEditing(next);
    const pane = trigger.closest<HTMLElement>(".settings-pane");
    if (pane) pane.scrollTop = 0;
  };

  const openManage = (conn: Connection, trigger: HTMLButtonElement) => {
    if (busyRef.current) return;
    focusAfterChange.current = null;
    overviewScroll.current = trigger.closest<HTMLElement>(".settings-pane")?.scrollTop ?? 0;
    triggerRef.current = trigger; formTriggerRef.current = null;
    setOverviewNotice(""); setArmed(null); setManagedId(conn.id);
    const pane = trigger.closest<HTMLElement>(".settings-pane");
    if (pane) pane.scrollTop = 0;
  };

  const renderConnection = (conn: Connection, showName = false) => {
    const provider = integrationDef(conn.kind);
    const unavailable = !kindOffered(integrations, conn.kind);
    const verified = verificationTime(conn);
    const account = conn.account.login || conn.account.name;
    const server = conn.kind === "jira" ? connectionServer(conn) : null;
    return <div key={conn.id} className="ig-conn" ref={el => { if (el) rowRefs.current.set(conn.id, el); else rowRefs.current.delete(conn.id); }}>
      <div className="ig-summary-row">
        <div className="ig-summary-text">
          <span className="ig-conn-name">{connectionHost(conn)}</span>
          <span className="ig-conn-line">{[showName && conn.name !== connectionHost(conn) ? conn.name : "", account, server || (verified ? `Last verified ${verified}` : "Not verified yet")].filter(Boolean).join(" · ") || "No account read yet"}</span>
          {!conn.tokenSaved && <span className="ig-bad">No token saved</span>}
          {unavailable && <span className="ig-stranded">{provider?.label ?? conn.kind} is not available on this deck. Manage this connection to disconnect it.</span>}
        </div>
        <button type="button" className="btn ig-manage" ref={el => { if (el) manageRefs.current.set(conn.id, el); else manageRefs.current.delete(conn.id); }}
          aria-label={`Manage ${provider?.label ?? conn.kind}: ${conn.name} (${account || connectionHost(conn)})`} onClick={event => openManage(conn, event.currentTarget)}>Manage <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg></button>
      </div>
    </div>;
  };

  const stranded = list.filter(conn => !known.some(provider => provider.kind === conn.kind));
  const managedConnection = list.find(conn => conn.id === managedId);
  const editedConnection = editing?.mode === "edit" ? list.find(conn => conn.id === editing.id) : undefined;
  const formProvider = editing?.mode === "add" ? known.find(provider => provider.kind === editing.kind)
    : editedConnection && known.find(provider => provider.kind === editedConnection.kind);

  return (
    <div className="ig-settings" data-view={editing ? "form" : managedId ? "connection" : "overview"}>
      {editing && <div className="ig-config-view">
        <button type="button" className="btn ig-back-to-overview" disabled={busy !== null} onClick={() => leave(closeForm, true)}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m7 3-5 5 5 5M2 8h12" /></svg>
          {managedId ? "Back to connection" : "All integrations"}
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
          onCancel={() => leave(closeForm, true)} />
          : <div role="status"><p>This provider or connection is no longer available.</p><button type="button" className="btn" onClick={closeForm}>Back to integrations</button></div>}
        </div>
      </div>}
      {managedId && <div className="ig-manage-view" hidden={editing !== null}>
        <div className="ig-manage-navigation">
        <button type="button" className="btn ig-back-to-overview" disabled={busy !== null} onClick={() => leave(backToOverview, true)}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m7 3-5 5 5 5M2 8h12" /></svg>All integrations
        </button>
        {managedConnection && kindOffered(integrations, managedConnection.kind) && <button type="button" className="btn" disabled={busy !== null}
          onClick={event => begin({ mode: "add", kind: managedConnection.kind }, event.currentTarget)}>Add {integrationDef(managedConnection.kind)?.label ?? managedConnection.kind} connection</button>}
        </div>
        {managedConnection ? <IntegrationConnectionDetails connection={managedConnection} provider={integrationDef(managedConnection.kind)}
          available={kindOffered(integrations, managedConnection.kind)} busy={busy} armed={armed === managedId}
          note={notes.find(n => n.id === managedId)} headingRef={detailHeadingRef}
          onTest={() => test(managedConnection)} onEdit={button => begin({ mode: "edit", id: managedConnection.id }, button)}
          onDisconnect={button => disconnect(managedConnection, button)} onCancelDisconnect={() => setArmed(null)} />
          : <p role="status">This connection is no longer saved.</p>}
      </div>}
      <div className="ig-overview" hidden={editing !== null || managedId !== null}>
        {listError && <div className="ig-list-error" role="alert">
          <p>{listError}</p><button type="button" className="btn" onClick={() => void refreshIntegrations()}>Retry</button>
        </div>}
        {connections === null && !listError && <p role="status">Reading connections…</p>}
        {overviewNotice && <p className="ig-note" role="status">{overviewNotice}</p>}
        <div className="ig-connection-list" data-setting="integrations-connections">
        {reach === "all" && <div className="ig-providers" data-setting="integrations-add" id="integrations-add-title">
            {known.map(provider => {
              const saved = list.filter(conn => conn.kind === provider.kind);
              return <section key={provider.kind} className="ig-provider" id={`ig-provider-${provider.kind}`} aria-labelledby={`ig-provider-name-${provider.kind}`} data-setting={`integration-${provider.kind}`}>
                <span className="ig-provider-glyph" aria-hidden><provider.Glyph /></span>
                <div className="ig-provider-content">
                  {saved.length > 0 && <div className="ig-provider-heading">
                    <h3 id={`ig-provider-name-${provider.kind}`}>{provider.label}</h3>
                    <button type="button" className="btn" disabled={busy !== null} aria-label={`Add connection to ${provider.label}`}
                      ref={el => { if (el) addRefs.current.set(provider.kind, el); else addRefs.current.delete(provider.kind); }}
                      onClick={event => begin({ mode: "add", kind: provider.kind }, event.currentTarget)}>Add connection</button>
                  </div>}
                  {saved.length === 0 ? <div className="ig-summary-row"><div className="ig-summary-text"><h3 id={`ig-provider-name-${provider.kind}`}>{provider.label}</h3><span className="ig-conn-line">Not connected</span></div>
                    <button type="button" className="btn ig-manage" ref={el => { if (el) addRefs.current.set(provider.kind, el); else addRefs.current.delete(provider.kind); }}
                      aria-label={`Connect ${provider.label}`} onClick={event => begin({ mode: "add", kind: provider.kind }, event.currentTarget)}>Connect</button></div>
                    : <>{saved.length > 1 && <p className="ig-connection-count">{saved.length} connections</p>}<div className="ig-connections">{saved.map(conn => renderConnection(conn, saved.length > 1))}</div></>}
                </div>
              </section>;
            })}
          </div>}
        {(stranded.length > 0 || (reach !== "all" && connections !== null)) && <SettingsGroup
          id="integrations-list-title" title="Connections"
          aside={<span className="settings-caption-count">{stranded.length}</span>}>
          {stranded.map(conn => renderConnection(conn, true))}
          {list.length === 0 && <p className="settings-row settings-row-status">Nothing connected.</p>}
        </SettingsGroup>}
        </div>
        {reach === "all" && <>
          <div className="ig-overview-info">
            <details className="ig-access"><summary>Access and token storage</summary><p>ccdeck only reads from connected services. Tokens stay on this machine and are never shown again or shared with paired decks.</p></details>
            <span className="ig-total">{list.length} saved connection{list.length === 1 ? "" : "s"}</span>
          </div>
        </>}
      </div>
    </div>
  );
}
