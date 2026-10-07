// The git view's switch on the page: read with the rest of the deck's prefs,
// pressed in Settings › Git, written back to the server — which stops its reads
// when it is off — and honoured by every card, which then shows no branch.
import { afterEach, describe, expect, it, vi } from "vitest";
import { sourceOf } from "./client-source";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

const fresh = async () => import("../git-pref");

describe("the switch", () => {
  it("is on until the prefs read says otherwise, and follows that read", async () => {
    const pref = await fresh();
    expect(pref.gitOnNow()).toBe(true);
    pref.loadGitPrefs({ prefs: { git: false } });
    expect(pref.gitOnNow()).toBe(false);
    pref.loadGitPrefs({ prefs: {} });
    expect(pref.gitOnNow()).toBe(true);
  });

  it("writes a press to the server at once, settles on its answer, and outlives a late read", async () => {
    const posted: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      posted.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ ok: true, prefs: { git: false } }) };
    }));
    const pref = await fresh();
    pref.toggleGit();
    expect(pref.gitOnNow()).toBe(false);
    expect(posted).toEqual([{ git: false }]);
    await new Promise(r => setTimeout(r, 0));
    expect(pref.gitOnNow()).toBe(false);
    // The page's prefs read was already in flight when the press happened.
    pref.loadGitPrefs({ prefs: { git: true } });
    expect(pref.gitOnNow()).toBe(false);
  });
});

describe("where the switch reaches", () => {
  it("is read with the deck's other prefs, in the one request", () => {
    expect(sourceOf("use-prefs-read.ts")).toMatch(/loadReportsPrefs\(d\);\s*loadGitPrefs\(d\);/);
  });

  it("takes every branch chip off the cards while it is off", () => {
    const node = sourceOf("components/AgentNode.tsx");
    expect(node).toContain("const gitOn = useGitOn();");
    expect(node).toContain("const chip = gitOn ? branchChip(data) : null;");
  });

  it("is a switch in Settings › Git with the words that say what it reads and never does", () => {
    const menu = sourceOf("components/GitSection.tsx");
    expect(sourceOf("settings.ts")).toContain('{ id: "git", label: "Git" }');
    expect(sourceOf("components/SettingsModal.tsx")).toMatch(/case "git":\s*return <GitSection \/>;/);
    expect(menu).toContain('id="appearance-git-label">Git: branch on cards and the git view</span>');
    expect(menu).toContain('id="appearance-git-note" className="appearance-row-note">Reads your repos locally; never changes them.</span>');
    const sw = menu.slice(menu.indexOf('aria-labelledby="appearance-git-label"') - 200, menu.indexOf('aria-labelledby="appearance-git-label"') + 200);
    expect(sw).toContain('role="switch"');
    expect(sw).toContain("aria-checked={gitOn}");
    expect(sw).toContain("onClick={toggleGit}");
    expect(sw).toContain('aria-describedby="appearance-git-note"');
  });
});
