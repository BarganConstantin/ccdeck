// A deck that upgrades itself can hand a tab a new bundle without anyone
// clearing anything, so saved state outlives the version that wrote it. These
// pin which half survives: preferences always, shape-bearing state only while
// the shape is unchanged.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FIRST_RUN_PANEL_KEYS, forgetRetired, PANEL_DEFAULTS_KEY, pruneStaleState, RETIRED_KEYS, SCHEMA_KEY, settlePanelDefaults, SHAPE_KEYS, STATE_SCHEMA } from "../storage";
import { floatKey, PLACE_KEYS } from "../panel-place";

function store(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
  };
}

describe("pruneStaleState", () => {
  it("does nothing when the stamp matches", () => {
    const s = store({ [SCHEMA_KEY]: STATE_SCHEMA, "agent-dag.layout": "{}" });
    expect(pruneStaleState(s)).toEqual([]);
    expect(s.getItem("agent-dag.layout")).toBe("{}");
  });

  it("drops shape-bearing state written under a different schema", () => {
    const s = store({ [SCHEMA_KEY]: "0", "agent-dag.layout": "{}", "agent-dag.viewport": "{}" });
    expect(pruneStaleState(s, "1").sort()).toEqual([...SHAPE_KEYS].sort());
    expect(s.getItem("agent-dag.layout")).toBeNull();
    expect(s.getItem(SCHEMA_KEY)).toBe("1");
  });

  it("keeps preferences — an upgrade must not reset the theme", () => {
    const s = store({ [SCHEMA_KEY]: "0", "agent-dag.theme": "dark", "agent-dag.autoRestart": "0", "agent-dag.layout": "{}" });
    pruneStaleState(s, "1");
    expect(s.getItem("agent-dag.theme")).toBe("dark");
    expect(s.getItem("agent-dag.autoRestart")).toBe("0");
  });

  it("treats an unstamped store as current, so existing layouts survive", () => {
    // Everyone upgrading into the first stamped version has no stamp. Reading
    // that as "stale" would wipe every hand-arranged canvas exactly once, for
    // nothing.
    const s = store({ "agent-dag.layout": "{}" });
    expect(pruneStaleState(s, "1")).toEqual([]);
    expect(s.getItem("agent-dag.layout")).toBe("{}");
    expect(s.getItem(SCHEMA_KEY)).toBe("1");
  });

  it("survives a storage that throws — boot must not depend on it", () => {
    const dead = {
      getItem() { throw new Error("denied"); },
      setItem() { throw new Error("denied"); },
      removeItem() { throw new Error("denied"); },
    };
    expect(pruneStaleState(dead)).toEqual([]);
  });

  it("skips a key it cannot remove and still drops the rest and stamps the store", () => {
    // The dead store above fails on the first read and returns before either
    // of these. A store that reads and then refuses one removal gets further:
    // the other shape key still has to go, and the stamp still has to land, or
    // the next boot compares against "0" again and finds nothing new.
    const s = store({ [SCHEMA_KEY]: "0", "agent-dag.layout": "{}", "agent-dag.viewport": "{}" });
    const locked = {
      ...s,
      removeItem: (k: string) => {
        if (k === "agent-dag.layout") throw new Error("denied");
        s.removeItem(k);
      },
    };
    let removed: string[] = [];
    expect(() => { removed = pruneStaleState(locked, "1"); }).not.toThrow();
    expect(removed).toEqual(["agent-dag.viewport"]);
    expect(s.getItem("agent-dag.viewport")).toBeNull();
    expect(s.getItem(SCHEMA_KEY)).toBe("1");
  });

  it("drops the stale keys even when the stamp cannot be written", () => {
    // Private mode takes the write and not the removals. The shape keys are
    // the whole point; the stamp is only what saves the next boot a check.
    const s = store({ [SCHEMA_KEY]: "0", "agent-dag.layout": "{}", "agent-dag.viewport": "{}" });
    const readOnly = { ...s, setItem: () => { throw new Error("QuotaExceededError"); } };
    let removed: string[] = [];
    expect(() => { removed = pruneStaleState(readOnly, "1"); }).not.toThrow();
    expect(removed.sort()).toEqual([...SHAPE_KEYS].sort());
    expect(s.getItem("agent-dag.layout")).toBeNull();
    expect(s.getItem("agent-dag.viewport")).toBeNull();
  });
});

// A first run opens no panel now; Accounts, Usage and the machine panel used
// to open on one. Nobody who has loaded the deck before may lose a panel to
// that: a flag they never stored read as open, and is pinned open once.
describe("settlePanelDefaults", () => {
  const [ACCOUNTS, USAGE, MACHINE] = FIRST_RUN_PANEL_KEYS;

  it("names the three panels the first run used to open", () => {
    expect(FIRST_RUN_PANEL_KEYS).toEqual(["agent-dag.accountsPanelOpen", "agent-dag.usagePanelOpen", "agent-dag.systemPanelOpen"]);
  });

  it("leaves a fresh profile empty, so it gets the closed default", () => {
    const s = store();
    expect(settlePanelDefaults(s)).toEqual([]);
    for (const key of FIRST_RUN_PANEL_KEYS) expect(s.getItem(key), key).toBeNull();
    expect(s.getItem(PANEL_DEFAULTS_KEY)).toBe("1");
  });

  it("pins open what an earlier load never stored, and keeps what it did", () => {
    // A phone that never opened Usage, a window always too narrow for the
    // machine panel, a reader who closed Accounts: only the first two change.
    const s = store({ "agent-dag.detailOpen": "0", [ACCOUNTS]: "0" });
    expect(settlePanelDefaults(s).sort()).toEqual([USAGE, MACHINE].sort());
    expect(s.getItem(ACCOUNTS)).toBe("0");
    expect(s.getItem(USAGE)).toBe("1");
    expect(s.getItem(MACHINE)).toBe("1");
  });

  it("knows an earlier load by any flag it wrote, or by the schema stamp", () => {
    for (const seen of [SCHEMA_KEY, "agent-dag.detailOpen", "agent-dag.sessionListOpen", USAGE]) {
      const s = store({ [seen]: "1" });
      settlePanelDefaults(s);
      expect(s.getItem(ACCOUNTS), seen).toBe("1");
    }
  });

  it("runs once, so a flag a later load left unwritten keeps the closed default", () => {
    // A first load that lands in Workspace does not write Accounts' flag; the
    // next boot must not take the profile for an old one and open the panel.
    const s = store();
    settlePanelDefaults(s);
    s.setItem("agent-dag.detailOpen", "0");
    expect(settlePanelDefaults(s)).toEqual([]);
    expect(s.getItem(ACCOUNTS)).toBeNull();
  });

  it("survives a storage that throws", () => {
    const dead = {
      getItem() { throw new Error("denied"); },
      setItem() { throw new Error("denied"); },
      removeItem() { throw new Error("denied"); },
    };
    expect(settlePanelDefaults(dead)).toEqual([]);
  });
});

describe("boot", () => {
  const main = readFileSync(fileURLToPath(new URL("../main.tsx", import.meta.url)), "utf8");

  it("settles the panel flags before the prune stamps the schema, and before App mounts", () => {
    const settle = main.search(/try \{ settlePanelDefaults\(window\.localStorage\); \} catch/);
    expect(settle, "main.tsx no longer settles the panel flags inside a try").toBeGreaterThan(-1);
    expect(main.search(/try \{ pruneStaleState\(window\.localStorage\); \} catch/)).toBeGreaterThan(settle);
    expect(main.indexOf(".render(")).toBeGreaterThan(settle);
  });

  it("prunes before App mounts, since App reads the layout and viewport while it does", () => {
    // Moved after render — or dropped — the new canvas reads the old shape in
    // its useState initialisers: the broken canvas with no visible cause that
    // this module exists to prevent, latent until the next STATE_SCHEMA bump.
    const prune = main.search(/try \{ pruneStaleState\(window\.localStorage\); \} catch/);
    expect(prune, "main.tsx no longer prunes inside a try").toBeGreaterThan(-1);
    expect(main.indexOf("createRoot(")).toBeGreaterThan(prune);
    expect(main.indexOf(".render(")).toBeGreaterThan(prune);
  });
});

describe("forgetRetired", () => {
  const BOARD_USAGE = "agent-dag.usagePanelPlace";
  const BOARD_MACHINE = "agent-dag.machinePanelPlace";

  it("forgets the Board's panel places and keeps Workspace's floating ones", () => {
    const s = store();
    s.setItem(BOARD_USAGE, JSON.stringify({ edge: "right", x: 40, y: 120 }));
    s.setItem(BOARD_MACHINE, JSON.stringify({ edge: "left", x: 10, y: 300 }));
    s.setItem(floatKey(PLACE_KEYS.usage), JSON.stringify({ edge: "left", x: 300, y: 90 }));
    s.setItem("agent-dag.usagePanelHeight", "420");
    expect(forgetRetired(s)).toEqual([BOARD_USAGE, BOARD_MACHINE]);
    expect(s.getItem(BOARD_USAGE)).toBeNull();
    expect(s.getItem(BOARD_MACHINE)).toBeNull();
    expect(s.getItem(floatKey(PLACE_KEYS.usage))).not.toBeNull();
    expect(s.getItem("agent-dag.usagePanelHeight")).toBe("420");
    expect(forgetRetired(s)).toEqual([]);
  });

  it("names the Board's own keys, the ones panel-place.ts reads on the Board", () => {
    expect([...RETIRED_KEYS].sort()).toEqual(Object.values(PLACE_KEYS).sort());
  });

  it("survives a storage that throws", () => {
    const dead = {
      getItem() { throw new Error("denied"); },
      setItem() { throw new Error("denied"); },
      removeItem() { throw new Error("denied"); },
    };
    expect(forgetRetired(dead)).toEqual([]);
  });

  it("runs at boot before App mounts", () => {
    const main = readFileSync(fileURLToPath(new URL("../main.tsx", import.meta.url)), "utf8");
    const forget = main.search(/try \{ forgetRetired\(window\.localStorage\); \} catch/);
    expect(forget, "main.tsx no longer forgets the retired keys inside a try").toBeGreaterThan(-1);
    expect(main.indexOf(".render(")).toBeGreaterThan(forget);
  });
});
