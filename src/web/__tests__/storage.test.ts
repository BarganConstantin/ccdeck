// A deck that upgrades itself can hand a tab a new bundle without anyone
// clearing anything, so saved state outlives the version that wrote it. These
// pin which half survives: preferences always, shape-bearing state only while
// the shape is unchanged.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pruneStaleState, SCHEMA_KEY, SHAPE_KEYS, STATE_SCHEMA } from "../storage";

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

describe("boot", () => {
  const main = readFileSync(fileURLToPath(new URL("../main.tsx", import.meta.url)), "utf8");

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
