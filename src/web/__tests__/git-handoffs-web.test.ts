// The hand-off row on the page: one shared answer about which apps the deck's
// machine has and whether this page is on it, the launch and pick requests it
// makes, and the rules the row draws by — launch buttons only for a page on
// the deck's machine, words in every icon's title and label, several copy
// values folded into one menu where the launch buttons need the room.
import { afterEach, describe, expect, it, vi } from "vitest";
import { sourceOf } from "./client-source";
import { sheetText } from "./sheet-source";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

const fresh = async () => import("../git-handoffs");
const answer = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const SLOTS = {
  git: { apps: [{ id: "fork", name: "Fork" }], chosen: "fork" },
  editor: { apps: [{ id: "vscode", name: "VS Code" }, { id: "zed", name: "Zed" }], chosen: "zed" },
  terminal: { apps: [], chosen: null },
};

describe("what the page knows", () => {
  it("starts knowing nothing, and never as a page on the deck's machine", async () => {
    const h = await fresh();
    expect(h.handoffsNow()).toMatchObject({ state: "idle", local: false });
  });

  it("takes the server's answer: the apps, the one chosen, and whether it is local", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer(200, { ok: true, local: true, machine: "studio", slots: SLOTS })));
    const h = await fresh();
    await h.loadHandoffs();
    expect(h.handoffsNow()).toEqual({ state: "ready", local: true, machine: "studio", slots: SLOTS });
  });

  it("asks once while an answer is on its way, and again only when told to", async () => {
    const fetch = vi.fn(async () => answer(200, { ok: true, local: true, machine: "m", slots: SLOTS }));
    vi.stubGlobal("fetch", fetch);
    const h = await fresh();
    await Promise.all([h.loadHandoffs(), h.loadHandoffs()]);
    await h.loadHandoffs();
    expect(fetch).toHaveBeenCalledTimes(1);
    await h.loadHandoffs(true, true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]).toEqual(["/api/git/handoffs?fresh=1"]);
  });

  it("drops what it cannot use: a chosen app that is not listed falls to the first", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer(200, {
      ok: true, local: true, machine: "m",
      slots: { git: { apps: [{ id: "fork", name: "Fork" }, { id: 7 }], chosen: "tower" }, editor: "nope" },
    })));
    const h = await fresh();
    await h.loadHandoffs();
    expect(h.handoffsNow().slots).toEqual({
      git: { apps: [{ id: "fork", name: "Fork" }], chosen: "fork" },
      editor: { apps: [], chosen: null },
      terminal: { apps: [], chosen: null },
    });
  });

  it("says off while Git is switched off, and is not local after a failed read", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer(409, { error: "off" })));
    let h = await fresh();
    await h.loadHandoffs();
    expect(h.handoffsNow()).toMatchObject({ state: "off", local: false });
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    h = await fresh();
    await h.loadHandoffs();
    expect(h.handoffsNow()).toMatchObject({ state: "error", local: false });
  });
});

describe("what the page asks for", () => {
  it("names a session and a slot — and a subagent or a file only when there is one", async () => {
    const posted: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: { body: string }) => {
      posted.push(JSON.parse(init?.body ?? "null"));
      return answer(200, { ok: true, app: { id: "zed", name: "Zed" } });
    }));
    const h = await fresh();
    expect(await h.openHandoff({ sessionId: "S1", slot: "editor" })).toEqual({ ok: true, app: { id: "zed", name: "Zed" } });
    await h.openHandoff({ sessionId: "S1", agentId: "ag-1", slot: "editor", file: "src/a.ts" });
    expect(posted).toEqual([{ session: "S1", slot: "editor" }, { session: "S1", slot: "editor", agent: "ag-1", file: "src/a.ts" }]);
  });

  it("hands back the server's reason, and asks again whether it is local when refused for not being", async () => {
    const fetch = vi.fn(async (url: string) => (url === "/api/git/open"
      ? answer(403, { error: "apps open only from a browser on the deck's own machine" })
      : answer(200, { ok: true, local: false, machine: "m", slots: SLOTS })));
    vi.stubGlobal("fetch", fetch);
    const h = await fresh();
    expect(await h.openHandoff({ sessionId: "S1", slot: "terminal" }))
      .toEqual({ ok: false, error: "apps open only from a browser on the deck's own machine" });
    await new Promise(r => setTimeout(r, 0));
    expect(fetch.mock.calls.map(c => c[0])).toContain("/api/git/handoffs");
  });

  it("shows a pick at once, writes it to the deck's prefs, and ignores an app the machine does not have", async () => {
    const posted: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body: string }) => {
      if (url === "/api/prefs") posted.push(JSON.parse(init!.body));
      return answer(200, { ok: true, local: true, machine: "m", slots: SLOTS });
    }));
    const h = await fresh();
    await h.loadHandoffs();
    h.pickHandoff("editor", "vscode");
    expect(h.handoffsNow().slots.editor.chosen).toBe("vscode");
    h.pickHandoff("editor", "emacs");
    expect(posted).toEqual([{ gitApps: { editor: "vscode" } }]);
  });
});

describe("the row", () => {
  const row = sourceOf("components/GitHandoffs.tsx");

  it("draws launch buttons only for a page the deck says is on its own machine", () => {
    expect(row).toContain('const local = handoffs.state === "ready" && handoffs.local;');
    expect(row).toMatch(/const launches = local\s*\?/);
    expect(row).toContain("Open buttons are hidden here: this deck runs on");
  });

  it("puts every button's words in its title and its label", () => {
    for (const tag of row.match(/<button[\s\S]*?>/g) ?? []) {
      if (tag.includes('role="menuitem"')) { expect(tag, tag).toContain("title="); continue; }
      expect(tag, tag).toContain("aria-label=");
      expect(tag, tag).toContain("title=");
    }
    expect(row).toContain("{!compact && <span>{word}</span>}");
  });

  it("folds several copy values into one menu except where the copy buttons have the row to themselves", () => {
    expect(row).toContain("const wordyCopies = !compact && elsewhere;");
    expect(row).toContain("const folded = items.length > 1 && !wordyCopies;");
    expect(row).toContain('aria-haspopup="menu"');
    expect(row).toContain('role="menu"');
  });

  it("keeps the menu's keys to itself: Escape closes only the menu, and no letter reaches a canvas shortcut", () => {
    expect(row).toContain("if (isEscapeKey(e.key)) { e.preventDefault(); e.stopPropagation(); closeMenu(true); return; }");
    // Tab leaves through the button, as the deck's other menus do.
    expect(row).toMatch(/if \(e\.key === "Tab"\) \{\s*e\.stopPropagation\(\);\s*document\.getElementById\(buttonId\)\?\.focus\(\);/);
    expect(row).toContain("if (e.key.length === 1) e.stopPropagation();");
  });

  it("copies through the deck's one clipboard helper and says so for a moment", () => {
    expect(row).toContain('import { copyText } from "../copy-text";');
    expect(row).toContain("const COPIED_MS = 1_600;");
    expect(row).toContain('role="status" aria-live="polite"');
  });

  it("animates the menu in only for the pointer, with a reduced-motion answer", () => {
    expect(row).toContain('data-motion={menuByPointer ? "pointer" : undefined}');
    const sheet = sheetText();
    expect(sheet).toContain('.gv-ho-menu[data-motion="pointer"] { animation: gv-ho-pop 120ms cubic-bezier(0.23, 1, 0.32, 1); }');
    expect(sheet).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.gv-ho-menu\[data-motion="pointer"\] \{ animation: gv-ho-fade 120ms ease-out; \}/);
  });

  it("has no colour of its own in the component", () => {
    expect(row).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});

describe("Appearance", () => {
  const menu = sourceOf("components/AppearanceMenu.tsx");
  const picks = sourceOf("components/GitHandoffPicks.tsx");

  it("draws the picks under the Git switch, before the next section", () => {
    const at = menu.indexOf("<GitHandoffPicks />");
    expect(at).toBeGreaterThan(menu.indexOf('id="appearance-git-note"'));
    expect(at).toBeLessThan(menu.indexOf('id="appearance-fm-caption"'));
  });

  it("asks for a pick only for a slot with more than one app, with the sound menu's select", () => {
    expect(picks).toContain("HANDOFF_SLOTS.filter(slot => handoffs.slots[slot].apps.length > 1)");
    expect(picks).toContain('className="sm-select"\n            value={handoffs.slots[slot].chosen ?? ""}');
    expect(picks).toContain("onChange={e => pickHandoff(slot, e.target.value)}");
    expect(picks).toContain('{ git: "Git client", editor: "Editor", terminal: "Terminal" }');
    expect(picks).toContain("Only apps found on this machine are listed.");
    expect(picks).toContain('<label htmlFor={`appearance-git-pick-${slot}`}>');
  });

  it("looks at the machine afresh each time it opens, and shows nothing while Git is off", () => {
    expect(picks).toContain("useEffect(() => { if (gitOn) void loadHandoffs(true, true); }, [gitOn]);");
    expect(picks).toContain('const slots = gitOn && handoffs.state === "ready"');
  });
});
