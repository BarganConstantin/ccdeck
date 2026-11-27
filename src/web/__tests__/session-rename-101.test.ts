// Internal #101: a reader names a session in place, and every surface that
// names the session draws that name. This file is the page's half: the rules
// the field follows (session-rename.ts), the reducer that draws the name
// ahead of the provider's, and the places the field is opened from.
//
// The name is the deck's own: the provider keeps its name, and clearing the
// deck's brings the provider's back.
import { describe, expect, it } from "vitest";
import { applyEvent, initialState } from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";
import { sessionNames } from "../rail-row-copy";
import { fuzzyMatch } from "../quick-open";
import {
  cleanTyped, isRenameKey, nameFieldKey, renameFacts, saveAsk, saveSessionName, SESSION_NAME_MAX,
  type RenameFacts,
} from "../session-rename";
import { sourceOf } from "./client-source";

const SID = "sess-101";
let seq = 0;
const envelope = (payload: HookPayload): HookEnvelope =>
  ({ seq: ++seq, receivedAt: Date.now(), source: "hook", payload });
const rooted = (provider?: "codex") => applyEvent(initialState(), envelope({
  hook_event_name: "SessionStart", session_id: SID, cwd: "/repo/billing", ...(provider ? { provider } : {}),
}));
const named = (s: ReturnType<typeof rooted>, p: Partial<HookPayload>) =>
  applyEvent(s, envelope({ hook_event_name: "SessionNamed", session_id: SID, ...p }));

describe("the name drawn for a session", () => {
  it("is the deck's name, ahead of the provider's", () => {
    let s = named(rooted(), { sessionName: "account-oauth-flow" });
    s = named(s, { deckName: "Billing fix" });
    const root = s.agents.get(SID)!;
    expect(root.sessionName).toBe("Billing fix");
    expect(root.deckName).toBe("Billing fix");
    expect(root.providerSessionName).toBe("account-oauth-flow");
  });

  it("is never overwritten by the provider renaming the session later", () => {
    let s = named(rooted(), { deckName: "Billing fix" });
    s = named(s, { sessionName: "provider-slug-2", sessionTitle: "A later sentence" });
    const root = s.agents.get(SID)!;
    expect(root.sessionName).toBe("Billing fix");
    expect(root.providerSessionName).toBe("provider-slug-2");
    expect(root.sessionTitle).toBe("A later sentence");
  });

  it("goes back to the provider's when the deck's is cleared", () => {
    let s = named(rooted(), { sessionName: "account-oauth-flow" });
    s = named(s, { deckName: "Billing fix" });
    s = named(s, { deckName: null });
    const root = s.agents.get(SID)!;
    expect(root.sessionName).toBe("account-oauth-flow");
    expect(root.deckName).toBeUndefined();
  });

  it("goes back to no name at all for a session the provider never named", () => {
    let s = named(rooted(), { deckName: "Billing fix" });
    s = named(s, { deckName: null });
    expect(s.agents.get(SID)!.sessionName).toBeUndefined();
  });

  it("keeps a payload without the field from saying anything about the deck's name", () => {
    let s = named(rooted(), { deckName: "Billing fix" });
    s = named(s, { sessionTitle: "Only a title" });
    expect(s.agents.get(SID)!.sessionName).toBe("Billing fix");
  });

  it("reads a name that is only spaces as cleared", () => {
    let s = named(rooted(), { sessionName: "slug" });
    s = named(s, { deckName: "Mine" });
    s = named(s, { deckName: "   " });
    expect(s.agents.get(SID)!.sessionName).toBe("slug");
  });

  it("still drops the title the provider copied its own name into, not the reader's", () => {
    let s = named(rooted(), { deckName: "Inspect repository" });
    s = named(s, { sessionName: "inspect-repo", sessionTitle: "inspect-repo" });
    expect(s.agents.get(SID)!.sessionTitle).toBeUndefined();
    expect(s.agents.get(SID)!.sessionName).toBe("Inspect repository");
  });

  it("is what the list, the card and quick open name the session by", () => {
    const s = named(named(rooted(), { sessionName: "account-oauth-flow" }), { deckName: "Billing fix" });
    expect(sessionNames(s.agents.get(SID)!).title).toBe("Billing fix");
    // Quick open's session rows are the list's rows (quick-open-items.tsx):
    // their title is that name, so typing it finds the session.
    expect(fuzzyMatch("bill", "Billing fix")).not.toBeNull();
    const items = sourceOf("quick-open-items.tsx");
    expect(items).toMatch(/title: row\.label,/);
    expect(sourceOf("components/SessionList.tsx")).toMatch(/const \{ title: label, folder, task \} = sessionNames\(a\);/);
  });
});

describe("the facts a field is opened with", () => {
  it("are none for a subagent or a session with no id", () => {
    expect(renameFacts(null)).toBeNull();
    expect(renameFacts({ kind: "subagent", sessionId: SID, label: "x" } as never)).toBeNull();
    expect(renameFacts({ kind: "root", sessionId: "", label: "x" } as never)).toBeNull();
  });

  it("hold the session they rename, the name drawn and the name a reset gives back", () => {
    let s = named(rooted("codex"), { sessionName: "account-oauth-flow" });
    s = named(s, { deckName: "Billing fix" });
    expect(renameFacts(s.agents.get(SID)!)).toEqual({
      provider: "codex", sessionId: SID, current: "Billing fix", fallback: "account-oauth-flow", deckNamed: true,
    });
  });

  it("fall back to the title or the folder for a session the provider never named", () => {
    const s = named(rooted(), { deckName: "Mine" });
    const f = renameFacts(s.agents.get(SID)!)!;
    expect(f.provider).toBe("claude");
    expect(f.current).toBe("Mine");
    expect(f.fallback).not.toBe("Mine");
    expect(f.fallback).not.toBe("");
  });

  it("say there is nothing to reset while the deck holds no name", () => {
    const s = named(rooted(), { sessionName: "slug" });
    expect(renameFacts(s.agents.get(SID)!)).toMatchObject({ current: "slug", fallback: "slug", deckNamed: false });
  });
});

describe("what a save asks for", () => {
  const facts: RenameFacts = { provider: "claude", sessionId: SID, current: "Billing fix", fallback: "slug", deckNamed: true };
  const plain: RenameFacts = { ...facts, current: "slug", deckNamed: false };

  it("asks for the typed name, cleaned", () => {
    expect(saveAsk("  Ship   it\n", facts)).toEqual({ kind: "save", name: "Ship it" });
  });

  it("asks nothing when the name is the one drawn already", () => {
    expect(saveAsk("Billing fix", facts)).toEqual({ kind: "none" });
    expect(saveAsk(" Billing  fix ", facts)).toEqual({ kind: "none" });
  });

  it("clears the deck's name for an empty field or the default typed back", () => {
    expect(saveAsk("", facts)).toEqual({ kind: "save", name: null });
    expect(saveAsk("   ", facts)).toEqual({ kind: "save", name: null });
    expect(saveAsk("slug", facts)).toEqual({ kind: "save", name: null });
  });

  it("asks nothing for an empty field when there is no name of the deck's to clear", () => {
    expect(saveAsk("", plain)).toEqual({ kind: "none" });
    expect(saveAsk("slug", plain)).toEqual({ kind: "none" });
  });

  it("cuts a long name where the server does, counted in characters", () => {
    const typed = "😀".repeat(SESSION_NAME_MAX + 10);
    expect(Array.from(cleanTyped(typed)).length).toBe(SESSION_NAME_MAX);
  });
});

describe("the field's keys", () => {
  it("saves on Enter and cancels on Escape, and leaves the rest to typing", () => {
    expect(nameFieldKey({ key: "Enter" })).toBe("save");
    expect(nameFieldKey({ key: "Escape" })).toBe("cancel");
    expect(nameFieldKey({ key: "a" })).toBeNull();
    expect(nameFieldKey({ key: "Tab" })).toBeNull();
  });

  it("leaves a key pressed mid-composition to the composition", () => {
    expect(nameFieldKey({ key: "Enter", isComposing: true })).toBeNull();
    expect(nameFieldKey({ key: "Escape", isComposing: true })).toBeNull();
  });

  it("starts renaming a row on a bare F2 only", () => {
    expect(isRenameKey({ key: "F2" })).toBe(true);
    for (const mod of ["altKey", "ctrlKey", "metaKey", "shiftKey"]) {
      expect(isRenameKey({ key: "F2", [mod]: true })).toBe(false);
    }
    expect(isRenameKey({ key: "Enter" })).toBe(false);
  });
});

describe("the save itself", () => {
  const facts = { provider: "codex" as const, sessionId: SID };
  const reply = (status: number, body: unknown) => (async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("posts the session and the name, and answers the name kept", async () => {
    let sent: { url: string; init: RequestInit } | null = null;
    const send = (async (url: string, init: RequestInit) => {
      sent = { url, init };
      return new Response(JSON.stringify({ ok: true, name: "Ship it" }), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(saveSessionName(facts, "Ship it", send)).resolves.toEqual({ ok: true, name: "Ship it" });
    expect(sent!.url).toBe("/api/session-name");
    expect(sent!.init.method).toBe("POST");
    expect(JSON.parse(String(sent!.init.body))).toEqual({ provider: "codex", sessionId: SID, name: "Ship it", syncProvider: true });
  });

  it("keeps a Claude deck name when the native transcript cannot be renamed", async () => {
    const requests: unknown[] = [];
    const send = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      requests.push(body);
      return body.syncProvider
        ? new Response(JSON.stringify({ ok: false, reason: "provider_name_not_saved" }), { status: 409 })
        : new Response(JSON.stringify({ ok: true, name: body.name }), { status: 200 });
    }) as unknown as typeof fetch;
    const claude = { ...facts, provider: "claude" as const };
    await expect(saveSessionName(claude, "Developer", send)).resolves.toEqual({ ok: true, name: "Developer" });
    const payload = { ...claude, name: "Developer" };
    expect(requests).toEqual([{ ...payload, syncProvider: true }, { ...payload, syncProvider: false }]);
  });

  it("answers a clear as null", async () => {
    await expect(saveSessionName(facts, null, reply(200, { ok: true, name: null }))).resolves.toEqual({ ok: true, name: null });
  });

  it("answers a failure, never throws, for every way a save can fail", async () => {
    await expect(saveSessionName(facts, "x", reply(500, { ok: false, reason: "not_saved" }))).resolves.toEqual({ ok: false });
    await expect(saveSessionName(facts, "x", reply(403, { error: "cross-site request blocked" }))).resolves.toEqual({ ok: false });
    await expect(saveSessionName(facts, "x", reply(200, "not json"))).resolves.toEqual({ ok: false });
    await expect(saveSessionName(facts, "x", reply(200, { ok: false }))).resolves.toEqual({ ok: false });
    const offline = (async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    await expect(saveSessionName(facts, "x", offline)).resolves.toEqual({ ok: false });
  });
});

// ── Where the field opens. The suite has no DOM, so the wiring is read from
// the source, as the other focus and key cases here are. ──────────────────────

describe("where a session is renamed from", () => {
  const field = sourceOf("components/SessionNameField.tsx");
  const header = sourceOf("components/terminal/StageHeader.tsx");
  const stage = sourceOf("components/terminal/TerminalStage.tsx");
  const row = sourceOf("components/RailParts.tsx");
  const detail = sourceOf("components/Detail.tsx");

  it("is the Workspace header: a pencil, a double click on the name, and the ⋯ menu", () => {
    expect(header).toMatch(/className="glyph-btn ts-rename"/);
    expect(header).toMatch(/onDoubleClick=\{renaming\?\.start\}/);
    expect(header).toMatch(/id: "rename", label: renameLabel, run: renaming\.start/);
  });

  it("holds the header's renaming in the stage, so the header calls no hook", () => {
    // StageHeader and Detail are drawn by calling them in this suite.
    expect(stage).toMatch(/const renaming = useRenaming\(renameFacts\?\.sessionId, renameBack\);/);
    expect(header).not.toMatch(/useRenaming\(|useRef\(/);
    expect(detail).toMatch(/<HeroTitle agent=\{agent\} now=\{now\} \/>/);
  });

  it("is a row of the Sessions list, by double click or F2", () => {
    expect(row).toMatch(/isRenameKey\(e\)/);
    expect(row).toMatch(/aria-keyshortcuts=\{rename \? "F2" : undefined\}/);
    expect(row).toMatch(/onDoubleClick=\{rename \? renaming\.start : undefined\}/);
    expect(row).toMatch(/place="row"/);
  });

  it("is the Inspector's title", () => {
    expect(detail).toMatch(/className="glyph-btn hero-rename"/);
    expect(detail).toMatch(/place="hero"/);
  });

  it("saves to the session it was opened on, whatever is selected after", () => {
    // The facts are read once, into state the field never updates.
    expect(field).toMatch(/const \[facts\] = useState\(given\);/);
    expect(field).not.toMatch(/setFacts/);
    // And a place whose session changes closes its field.
    expect(field).toMatch(/const on = editing != null && editing === sessionId;/);
  });

  it("keeps every key typed in it from the row, the list and the stage around it", () => {
    expect(field).toMatch(/onKeyDown=\{e => \{\s*e\.stopPropagation\(\);\s*const act = nameFieldKey\(/);
  });

  it("saves on leaving, but not on leaving the window", () => {
    expect(field).toMatch(/if \(!document\.hasFocus\(\)\) return;/);
  });

  it("says a failed save, and keeps what was typed", () => {
    expect(field).toMatch(/role="alert"/);
    expect(field).toMatch(/aria-invalid=\{failed \|\| undefined\}/);
    expect(field).not.toMatch(/setDraft\(given\.current\)|setDraft\(facts\.current\)/);
  });
});
