// #1174: which recap notes were put away, across a reload.
//
// session-recap.test.ts holds the in-memory half: a closed note stays closed
// and the next recap opens again. That suite runs with no window, so neither
// the read at import nor the write on every change ever ran. If the read
// regresses, every note anyone closed is back on the canvas after a reload; if
// a corrupt value is trusted, every recap can read as dismissed; and if the
// cap keeps the oldest 200 instead of the newest, somebody past 200 dismissals
// loses exactly the ones they just made.
//
// The module reads the store once, when it is imported, so each case installs
// a window the way storage-blocked.test.ts does and then imports a fresh copy.
import { describe, it, expect, vi, afterEach } from "vitest";

const KEY = "agent-dag.recapsDismissed";
const glob = globalThis as unknown as Record<string, unknown>;

/** Installs a window whose `localStorage` property behaves as `desc` says —
 *  a value the tab can read, or a getter that refuses. */
function browser(desc: PropertyDescriptor): void {
  glob.window = Object.defineProperty({}, "localStorage", { configurable: true, ...desc });
}

/** A Map-backed store that remembers every payload written to the key. */
function store(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  const writes: string[] = [];
  return {
    writes,
    /** The dismissals as last written, oldest first. */
    last: (): string[] => JSON.parse(writes.at(-1) ?? "null"),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => { map.set(k, v); if (k === KEY) writes.push(v); },
    removeItem: (k: string) => { map.delete(k); },
  };
}

/** What a blocked profile actually raises on the property read. */
function refuse(): never {
  throw new Error("SecurityError: The operation is insecure.");
}

/** A fresh copy of the module, so its import-time read sees this case's store. */
async function fresh() {
  vi.resetModules();
  return import("../recap-note");
}

afterEach(() => { delete glob.window; });

describe("recap dismissals, read at import", () => {
  it("come back from the store, keeping only the entries that are keys", async () => {
    const s = store({ [KEY]: JSON.stringify(["s1@1", 5, null, "s2@2"]) });
    browser({ value: s });
    const recap = await fresh();
    expect(recap.isRecapDismissed("s1@1")).toBe(true);
    expect(recap.isRecapDismissed("s2@2")).toBe(true);
    // And the number and the null are not carried into the next write.
    recap.dismissRecap("s3@3");
    expect(s.last()).toEqual(["s1@1", "s2@2", "s3@3"]);
  });

  it("read as nothing dismissed when the stored value is not a list", async () => {
    for (const raw of ["{", '{"a":1}', '"x"']) {
      browser({ value: store({ [KEY]: raw }) });
      const recap = await fresh();
      for (const key of ["a", "x", "{"]) expect(recap.isRecapDismissed(key), `${raw} → ${key}`).toBe(false);
    }
  });
});

describe("recap dismissals, written on every change", () => {
  it("keep the newest 200, in the order they were put away", async () => {
    const s = store();
    browser({ value: s });
    const recap = await fresh();
    for (let i = 0; i <= 200; i++) recap.dismissRecap(`k${i}`);
    const kept = s.last();
    expect(kept).toHaveLength(200);
    expect(kept[0]).toBe("k1");       // the oldest one is what goes
    expect(kept[199]).toBe("k200");   // and the one just closed stays
  });

  it("move a note brought back and put away again to the newest end", async () => {
    const s = store();
    browser({ value: s });
    const recap = await fresh();
    for (const key of ["k0", "k1", "k2"]) recap.dismissRecap(key);
    recap.toggleRecapDismissed("k1");
    expect(s.last()).toEqual(["k0", "k2"]);
    recap.toggleRecapDismissed("k1");
    expect(s.last()).toEqual(["k0", "k2", "k1"]);
  });

  it("are still remembered for the page when the store refuses the write", async () => {
    browser({ value: { ...store(), setItem: () => { throw new Error("QuotaExceededError"); } } });
    const recap = await fresh();
    expect(() => recap.dismissRecap("s1@1")).not.toThrow();
    expect(recap.isRecapDismissed("s1@1")).toBe(true);
  });

  it("are still remembered for the page when the browser blocks the store outright", async () => {
    browser({ get: refuse });
    const recap = await fresh();
    expect(() => recap.dismissRecap("s1@1")).not.toThrow();
    expect(recap.isRecapDismissed("s1@1")).toBe(true);
  });
});
