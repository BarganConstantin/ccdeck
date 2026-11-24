// "Other accounts" opens as it was left, on each side of the Accounts panel.
//
// It used to shut every time the panel opened, so a reader who keeps it open
// had to open it again after every restart or update: once in Claude, once in
// Codex. Each side keeps its own flag now (accounts-prefs.ts loadFoldOpen). These
// run the two real panels: press the fold, take the panel away, mount it again
// over the same store (what a reload or a restart is to the page), and read
// what the fold is handed. A first run, with nothing stored, still opens shut,
// and a browser that refuses its store costs the memory and nothing more.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async () => (await import("./fake-react")).react);

const { flush, mount, one } = await import("./fake-react");
const { isFold, openOthers } = await import("./codex-panel-helpers");
const { default: AccountsPanel } = await import("../components/AccountsPanel");
const { default: CodexProfilesSection } = await import("../components/CodexProfilesSection");
const { loadFoldOpen, saveFoldOpen } = await import("../accounts-prefs");

const CLAUDE_KEY = "agent-dag.otherAccountsFold.claude";
const CODEX_KEY = "agent-dag.otherAccountsFold.codex";

let store: Map<string, string>;
let blocked: boolean;
const mounted: Array<() => void> = [];

function json(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 503, json: async () => body };
}
const account = (num: number, email: string, active: boolean) => ({
  num, email, alias: null, org: null, active, disabled: false, lanes: [], headroom: null,
  fetchedAt: null, nextAt: null, stale: false, error: null,
});
const codexProfile = (id: string, label: string, active: boolean) => ({
  id, label, active, identityVersion: id, signedInFilePresent: false,
});

beforeEach(() => {
  vi.useFakeTimers();
  store = new Map();
  blocked = false;
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
  };
  vi.stubGlobal("window", {
    setTimeout: (run: () => void, ms: number) => setTimeout(run, ms),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
    setInterval: (run: () => void, ms: number) => setInterval(run, ms),
    clearInterval: (timer: ReturnType<typeof setInterval>) => clearInterval(timer),
    requestAnimationFrame: () => 0,
    dispatchEvent: () => true,
    // The accessor itself throws on a browser that blocks site data.
    get localStorage() {
      if (blocked) throw new Error("SecurityError: blocked");
      return localStorage;
    },
  });
  vi.stubGlobal("document", {
    activeElement: null, body: {}, getElementById: () => null, querySelector: () => null,
  });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.startsWith("/api/claude-accounts")) {
      return json({ ok: true, accounts: [account(1, "live@example.test", true), account(2, "spare@example.test", false)] });
    }
    if (url === "/api/codex-profiles") {
      return json({ revision: 1, profiles: [codexProfile("a", "Personal", true), codexProfile("b", "Work", false)] });
    }
    // Auto-switch and the quota reads: nothing to say, which neither fold needs.
    return json({}, false);
  }));
});

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

type View = ReturnType<typeof mount>;

/** One side of the panel, mounted over whatever the store holds now, with its
 *  roster read. */
async function claudeSide(): Promise<View> {
  const view = mount(AccountsPanel as (p: { onClose: () => void }) => unknown, { onClose: () => {} });
  mounted.push(view.unmount);
  await flush();
  return view;
}
async function codexSide(): Promise<View> {
  const view = mount(() => CodexProfilesSection(), {});
  mounted.push(view.unmount);
  await flush();
  return view;
}
/** What the fold row is told, or a failure that names the side. */
function foldOpen(view: View): boolean {
  const fold = one(view.tree, isFold);
  expect(fold, "the Other accounts row is drawn").not.toBeNull();
  return fold!.props.open as boolean;
}
/** The rows behind the fold are drawn, not only the row told it is open. */
const listDrawn = (view: View, id: string) => one(view.tree, el => el.props.id === id) != null;
/** A reload: the panel goes, and the page comes back over the same store. */
function reload() {
  while (mounted.length) mounted.pop()!();
}

describe("Other accounts, remembered per side", () => {
  it("opens shut on both sides when nothing is stored, as it always has", async () => {
    const claude = await claudeSide();
    const codex = await codexSide();
    expect(foldOpen(claude)).toBe(false);
    expect(foldOpen(codex)).toBe(false);
    expect(listDrawn(claude, "ap-rest-panel")).toBe(false);
    expect(listDrawn(codex, "ap-codex-rest-panel")).toBe(false);
    // Nothing that reads as open was written by merely looking.
    expect(store.get(CLAUDE_KEY) ?? "0").toBe("0");
    expect(store.get(CODEX_KEY) ?? "0").toBe("0");
  });

  it("brings Claude's back open after a reload and leaves Codex's shut", async () => {
    openOthers(await claudeSide());
    await codexSide();
    expect(store.get(CLAUDE_KEY)).toBe("1");
    reload();

    const claude = await claudeSide();
    const codex = await codexSide();
    expect(foldOpen(claude)).toBe(true);
    expect(listDrawn(claude, "ap-rest-panel")).toBe(true);
    expect(foldOpen(codex)).toBe(false);
    expect(listDrawn(codex, "ap-codex-rest-panel")).toBe(false);
  });

  it("brings Codex's back open after a reload and leaves Claude's shut, the other way round", async () => {
    // Where the previous case left off: Claude open, Codex shut.
    store.set(CLAUDE_KEY, "1");
    const before = await claudeSide();
    expect(foldOpen(before)).toBe(true);
    openOthers(before); // shut Claude's
    openOthers(await codexSide()); // open Codex's
    expect(store.get(CLAUDE_KEY)).toBe("0");
    expect(store.get(CODEX_KEY)).toBe("1");
    reload();

    const claude = await claudeSide();
    const codex = await codexSide();
    expect(foldOpen(claude)).toBe(false);
    expect(listDrawn(claude, "ap-rest-panel")).toBe(false);
    expect(foldOpen(codex)).toBe(true);
    expect(listDrawn(codex, "ap-codex-rest-panel")).toBe(true);
  });

  it("keeps both open when both were left open, through more than one reload", async () => {
    openOthers(await claudeSide());
    openOthers(await codexSide());
    reload();
    await claudeSide();
    await codexSide();
    reload();
    expect(foldOpen(await claudeSide())).toBe(true);
    expect(foldOpen(await codexSide())).toBe(true);
  });

  it("stores a yes or a no under each side's key, and nothing about the accounts", async () => {
    openOthers(await claudeSide());
    openOthers(await codexSide());
    const folds = [...store].filter(([k]) => k.startsWith("agent-dag.otherAccountsFold."));
    expect(folds.map(([k]) => k).sort()).toEqual([CLAUDE_KEY, CODEX_KEY]);
    for (const [, v] of folds) expect(["0", "1"]).toContain(v);
    for (const [k, v] of store) {
      expect(`${k}=${v}`).not.toMatch(/@|example\.test|Personal|Work/);
    }
  });

  it("does not take either side down when the browser refuses its store", async () => {
    blocked = true;
    const claude = await claudeSide();
    const codex = await codexSide();
    expect(foldOpen(claude)).toBe(false);
    expect(foldOpen(codex)).toBe(false);
    // The press still opens the fold for this visit; only the memory is lost.
    expect(() => openOthers(claude)).not.toThrow();
    expect(() => openOthers(codex)).not.toThrow();
    expect(foldOpen(claude)).toBe(true);
    expect(foldOpen(codex)).toBe(true);
    reload();
    expect(foldOpen(await claudeSide())).toBe(false);
    expect(foldOpen(await codexSide())).toBe(false);
  });
});

describe("the flag on its own", () => {
  it("reads only a stored \"1\" as open", () => {
    expect(loadFoldOpen("claude")).toBe(false);
    for (const raw of ["0", "", "true", "open", "{\"open\":true}", "11"]) {
      store.set(CLAUDE_KEY, raw);
      expect(loadFoldOpen("claude"), raw).toBe(false);
    }
    store.set(CLAUDE_KEY, "1");
    expect(loadFoldOpen("claude")).toBe(true);
    expect(loadFoldOpen("codex")).toBe(false);
  });

  it("writes each side under its own key", () => {
    saveFoldOpen("codex", true);
    expect(store.get(CODEX_KEY)).toBe("1");
    expect(store.has(CLAUDE_KEY)).toBe(false);
    saveFoldOpen("codex", false);
    expect(store.get(CODEX_KEY)).toBe("0");
  });

  it("reads shut and writes nothing, without throwing, when the store is refused", () => {
    blocked = true;
    expect(loadFoldOpen("claude")).toBe(false);
    expect(() => saveFoldOpen("claude", true)).not.toThrow();
    blocked = false;
    expect(store.size).toBe(0);
  });

  it("is shut outside a browser, where there is no window at all", () => {
    vi.stubGlobal("window", undefined);
    expect(loadFoldOpen("codex")).toBe(false);
    expect(() => saveFoldOpen("codex", true)).not.toThrow();
  });
});
