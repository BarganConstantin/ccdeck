// The one secret this deck has ever written to disk, and the two rules that
// keep it from getting out.
//
// prefs.json held nothing but booleans until LAN sync. A booleans file at the
// umask default is unremarkable; a group passphrase at the umask default is
// handed to every other account on a shared machine, and from it they can
// decrypt any credential that crosses the network. So the file has a mode now,
// and the passphrase never reaches a page.
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs server module, no types
import { DEFAULTS, normalise, publicPrefs, PREFS_MODE, writePrefs } from "../../server/deck-prefs.mjs";

describe("where the passphrase is written", () => {
  it("creates the file readable by nobody else", () => {
    expect(PREFS_MODE).toBe(0o600);
  });

  it("names the mode on the write itself, not in a chmod after it", async () => {
    // The difference is the whole point, and claude-swap's transfer.py makes
    // the same argument at length: a write-then-chmod leaves the file at the
    // umask-derived mode for the window between the two, which is exactly when
    // the secret is in it.
    const wrote: Array<{ path: string; opts: unknown }> = [];
    await writePrefs({ lan: { passphrase: "amber-canyon" } }, "/tmp/nowhere", {
      readFile: async () => { throw new Error("no file"); },
      mkdir: async () => {},
      writeFile: async (path: string, _body: string, opts: unknown) => { wrote.push({ path, opts }); },
      rename: async () => {},
    });
    expect(wrote).toHaveLength(1);
    expect(wrote[0].opts).toEqual({ encoding: "utf8", mode: PREFS_MODE });
  });

  it("writes to a temp path and renames, so a crash cannot truncate it", async () => {
    const paths: string[] = [];
    await writePrefs({ lan: { passphrase: "x" } }, "/tmp/nowhere", {
      readFile: async () => { throw new Error("no file"); },
      mkdir: async () => {},
      writeFile: async (path: string) => { paths.push(path); },
      rename: async (from: string, to: string) => { paths.push(`${from} -> ${to}`); },
    });
    expect(paths[0]).toMatch(/\.tmp$/);
    expect(paths[1]).toMatch(/\.tmp -> .*prefs\.json$/);
  });
});

describe("what a page is allowed to see", () => {
  const withSecret = normalise({ lan: { enabled: true, name: "MacBook", passphrase: "amber-canyon-forty" } });

  it("never sends the passphrase, because anything on loopback can ask", () => {
    const out = JSON.stringify(publicPrefs(withSecret));
    expect(out).not.toContain("amber-canyon-forty");
    expect(publicPrefs(withSecret).lan).not.toHaveProperty("passphrase");
  });

  it("says only whether one is set", () => {
    // A boolean rather than a mask: dots in a field invite a page to send them
    // back, and then the dots are the passphrase.
    expect(publicPrefs(withSecret).lan.hasPassphrase).toBe(true);
    expect(publicPrefs(normalise({})).lan.hasPassphrase).toBe(false);
    expect(publicPrefs(normalise({ lan: { passphrase: "" } })).lan.hasPassphrase).toBe(false);
  });

  it("still sends everything that is not a secret", () => {
    const out = publicPrefs(withSecret);
    expect(out.lan.enabled).toBe(true);
    expect(out.lan.name).toBe("MacBook");
    expect(out.notifications).toBe(true);
  });
});

describe("the shape on disk", () => {
  it("is off until somebody turns it on", () => {
    expect(DEFAULTS.lan.enabled).toBe(false);
    expect(normalise({}).lan).toEqual({ enabled: false, name: "", passphrase: "", shared: [], manual: [] });
  });

  it("does not lose the passphrase when a page toggles the switch", async () => {
    // The LAN section merges rather than replaces, which is what lets a page
    // change one field without sending back a secret it was never given.
    let saved: Record<string, unknown> | null = null;
    const deps = {
      readFile: async () => JSON.stringify({ lan: { enabled: false, passphrase: "kept", shared: ["a@@1"] } }),
      mkdir: async () => {},
      writeFile: async (_p: string, body: string) => { saved = JSON.parse(body); },
      rename: async () => {},
    };
    await writePrefs({ lan: { enabled: true } }, "/tmp/nowhere", deps);
    expect(saved!.lan).toEqual({ enabled: true, name: "", passphrase: "kept", shared: ["a@@1"], manual: [] });
  });

  it("refuses anything in the lists that is not a string", () => {
    // Both are compared against account keys and dialled as addresses, and they
    // arrive from a page.
    const p = normalise({ lan: { shared: ["a@@1", 5, null, { x: 1 }], manual: ["1.2.3.4:5", 9] } });
    expect(p.lan.shared).toEqual(["a@@1"]);
    expect(p.lan.manual).toEqual(["1.2.3.4:5"]);
  });

  it("survives a file written by a build that had never heard of LAN sync", () => {
    expect(normalise({ notifications: false }).lan).toEqual(DEFAULTS.lan);
    expect(normalise({ notifications: false, lan: "yes" }).lan).toEqual(DEFAULTS.lan);
  });

  it("keeps dropping keys it does not understand", () => {
    const p = normalise({ notifications: true, somethingNewer: 1, lan: { enabled: true, futureField: 2 } });
    expect(p).not.toHaveProperty("somethingNewer");
    expect(p.lan).not.toHaveProperty("futureField");
  });
});
