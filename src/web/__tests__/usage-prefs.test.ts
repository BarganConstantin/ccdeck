// What the usage panel remembers between reloads, called rather than read.
//
// The two preferences lived as private functions inside UsagePanel.tsx, so the
// only thing a test could check was their spelling. They are usage-prefs.ts's
// now, and what each falls back to — on a first visit, on a value some older
// build or a hand edit left in the store, and on a browser that refuses site
// data outright — can be asked of them directly.
import { describe, it, expect, afterEach } from "vitest";
import { PERIODS } from "../usage-from-ccusage";
import { loadPeriod, loadSessionsOpen, savePeriod, saveSessionsOpen } from "../usage-prefs";

const glob = globalThis as unknown as Record<string, unknown>;

/** A tab whose localStorage holds `initial`, and the map behind it. */
function storeWith(initial: Record<string, string> = {}): Map<string, string> {
  const map = new Map(Object.entries(initial));
  glob.window = {
    localStorage: {
      getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
      setItem: (k: string, v: string) => { map.set(k, String(v)); },
      removeItem: (k: string) => { map.delete(k); },
    },
  };
  return map;
}

/** A tab that blocks site data: the property read itself throws. */
function blocked(): void {
  glob.window = Object.defineProperty({}, "localStorage", {
    configurable: true,
    get() { throw new Error("SecurityError: The operation is insecure."); },
  });
}

afterEach(() => { delete glob.window; });

describe("the period the panel was reading", () => {
  it("comes back as it was left, for every period the strip offers", () => {
    for (const { key } of PERIODS) {
      storeWith({ "agent-dag.usagePeriod": key });
      expect(loadPeriod()).toBe(key);
    }
  });

  it("is today on a first visit", () => {
    storeWith();
    expect(loadPeriod()).toBe("today");
  });

  it("is today when the store holds a period this build cannot spell", () => {
    // An older build's key or a hand edit. Cast rather than checked, it would
    // ask /api/ccusage for a range nothing on the server understands.
    for (const junk of ["week", "", "TODAY", "all ", "__proto__"]) {
      storeWith({ "agent-dag.usagePeriod": junk });
      expect(loadPeriod(), JSON.stringify(junk)).toBe("today");
    }
  });

  it("is today, not a thrown first render, on a browser that blocks site data", () => {
    blocked();
    expect(() => loadPeriod()).not.toThrow();
    expect(loadPeriod()).toBe("today");
  });

  it("is written under the key it is read from", () => {
    const map = storeWith();
    savePeriod("month");
    expect(map.get("agent-dag.usagePeriod")).toBe("month");
    expect(loadPeriod()).toBe("month");
  });

  it("is not written, and does not throw, on a browser that blocks site data", () => {
    blocked();
    expect(() => savePeriod("all")).not.toThrow();
  });
});

describe("whether the session list is open", () => {
  it("starts shut, which is the deliberate half", () => {
    storeWith();
    expect(loadSessionsOpen()).toBe(false);
  });

  it("is open only for the exact spelling it writes", () => {
    for (const [stored, open] of [["1", true], ["0", false], ["true", false], ["", false], [" 1", false]] as const) {
      storeWith({ "agent-dag.usageSessionsOpen": stored });
      expect(loadSessionsOpen(), JSON.stringify(stored)).toBe(open);
    }
  });

  it("round-trips through the store in both directions", () => {
    const map = storeWith();
    saveSessionsOpen(true);
    expect(map.get("agent-dag.usageSessionsOpen")).toBe("1");
    expect(loadSessionsOpen()).toBe(true);
    saveSessionsOpen(false);
    expect(map.get("agent-dag.usageSessionsOpen")).toBe("0");
    expect(loadSessionsOpen()).toBe(false);
  });

  it("is shut, and does not throw, on a browser that blocks site data", () => {
    blocked();
    expect(loadSessionsOpen()).toBe(false);
    expect(() => saveSessionsOpen(true)).not.toThrow();
  });
});
