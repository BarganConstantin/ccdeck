// The one secret this deck has ever written to disk, and the two rules that
// keep it from getting out.
//
// prefs.json held nothing but booleans until LAN sync. A booleans file at the
// umask default is unremarkable; this deck's PRIVATE KEY at the umask default
// is handed to every other account on a shared machine, and with it they are
// this deck to every peer that pinned it. So the file has a mode now, and the
// key never reaches a page.
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs server module, no types
import { ALIAS_MAX, DEFAULTS, cleanAlias, isAliasKey, normalise, publicPrefs, PREFS_MODE, writePrefs } from "../../server/deck-prefs.mjs";

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
    await writePrefs({ lan: { secret: "a-private-key" } }, "/tmp/nowhere", {
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
    await writePrefs({ lan: { secret: "x" } }, "/tmp/nowhere", {
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
  const withSecret = normalise({
    lan: {
      enabled: true, name: "MacBook", secret: "AAAAsecret-private-keyAAAA",
      trusted: [{ fp: "aaa-bbb-ccc-ddd", pub: "THEIR-PUBLIC-KEY", name: "Desktop" }],
    },
  });

  it("never sends the private key, because anything on loopback can ask", () => {
    const out = JSON.stringify(publicPrefs(withSecret));
    expect(out).not.toContain("AAAAsecret-private-keyAAAA");
    expect(publicPrefs(withSecret).lan).not.toHaveProperty("secret");
  });

  it("sends a paired deck as a name and a fingerprint, not as a key", () => {
    // The pinned key is not secret and no page draws it. What a page shows is
    // the name somebody recognises and the fingerprint they compare.
    const out = publicPrefs(withSecret);
    expect(JSON.stringify(out)).not.toContain("THEIR-PUBLIC-KEY");
    expect(out.lan.trusted).toEqual([{ fp: "aaa-bbb-ccc-ddd", name: "Desktop" }]);
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
    // `port` is 0 until this deck has listened once. It is remembered so an
    // address typed on the other machine still reaches this one after a
    // restart — broadcast not arriving is the whole reason that field exists.
    // The two pairing switches ship ON, and this is the line that says why
    // that is not the same as a feature that is on. Nothing they describe can
    // happen while `enabled` is false, and a deck that pairs is offered nothing
    // while `shared` is empty — both of which a person has to change on purpose.
    expect(normalise({}).lan).toEqual({
      enabled: false, name: "", secret: "", shared: [], manual: [], trusted: [], port: 0,
      autoAsk: true, autoAccept: true, aliases: {},
    });
    // Absent is the default; only a real boolean overrides it, because a
    // truthy string from a hand-edited file is not an answer.
    expect(normalise({ lan: { autoAccept: false } }).lan.autoAccept).toBe(false);
    expect(normalise({ lan: { autoAsk: "yes" } }).lan.autoAsk).toBe(true);
  });

  it("does not lose the private key when a page toggles the switch", async () => {
    // The LAN section merges rather than replaces, which is what lets a page
    // change one field without sending back a secret it was never given.
    let saved: Record<string, unknown> | null = null;
    const deps = {
      readFile: async () => JSON.stringify({ lan: { enabled: false, secret: "kept", shared: ["a@@1"] } }),
      mkdir: async () => {},
      writeFile: async (_p: string, body: string) => { saved = JSON.parse(body); },
      rename: async () => {},
    };
    await writePrefs({ lan: { enabled: true } }, "/tmp/nowhere", deps);
    expect(saved!.lan).toEqual({
      enabled: true, name: "", secret: "kept", shared: ["a@@1"], manual: [], trusted: [], port: 0,
      autoAsk: true, autoAccept: true, aliases: {},
    });
  });

  it("refuses a paired deck that has no key to check it against later", () => {
    // The pinned public key is the load-bearing half: a fingerprint is a hash
    // of it, so an entry without one cannot be checked against whatever answers
    // at that address later — and an entry that cannot be checked is worse than
    // no entry, because it looks like a pairing and is not one.
    const good = { fp: "aaa-bbb-ccc-ddd", pub: "PUB", name: "Desktop" };
    expect(normalise({ lan: { trusted: [good] } }).lan.trusted).toEqual([good]);
    for (const junk of [{ fp: "aaa-bbb-ccc-ddd" }, { pub: "PUB" }, "nope", 5, null, {}]) {
      expect(normalise({ lan: { trusted: [junk] } }).lan.trusted, JSON.stringify(junk)).toEqual([]);
    }
  });

  it("keeps the private key exactly as it was written", () => {
    // It is base64 of a DER key. Anything else is replaced on the next start
    // rather than refused here — see identityFrom, which owns that decision.
    expect(normalise({ lan: { secret: "AAAA" } }).lan.secret).toBe("AAAA");
    for (const junk of [5, null, {}, []]) {
      expect(normalise({ lan: { secret: junk } }).lan.secret, String(junk)).toBe("");
    }
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

  it("keeps when a deck was accepted, and invents no date for one that has none", () => {
    const dated = { fp: "aaa-bbb-ccc-ddd", pub: "PUB", name: "Desktop", at: 1_790_000_000_000 };
    expect(normalise({ lan: { trusted: [dated] } }).lan.trusted).toEqual([dated]);
    // Pinned before the date was kept: it stays undated rather than getting
    // today's, which would be a lie about when somebody said yes.
    const old = { fp: "aaa-bbb-ccc-ddd", pub: "PUB", name: "Desktop" };
    expect(normalise({ lan: { trusted: [old] } }).lan.trusted).toEqual([old]);
    for (const junk of ["yesterday", -5, 0, NaN, null]) {
      expect(normalise({ lan: { trusted: [{ ...old, at: junk }] } }).lan.trusted, String(junk)).toEqual([old]);
    }
  });
});

describe("what somebody here calls another deck", () => {
  it("keeps a name per fingerprint, cleaned", () => {
    const p = normalise({ lan: { aliases: { "aaa-bbb-ccc-ddd": "  Dorin   Office  " } } });
    expect(p.lan.aliases).toEqual({ "aaa-bbb-ccc-ddd": "Dorin Office" });
  });

  it("drops an empty name, which is how an alias is taken away", () => {
    expect(normalise({ lan: { aliases: { "aaa-bbb-ccc-ddd": "   " } } }).lan.aliases).toEqual({});
  });

  it("never keys one by a typed address, which names no deck", () => {
    // A row nothing has answered at carries `manual:host:port` as its
    // fingerprint. An alias stored under that would follow an address, not a
    // machine, and outlive whatever answers there next.
    const p = normalise({ lan: { aliases: { "manual:192.168.1.5:5000": "Office", __proto__x: "x" } } });
    expect(p.lan.aliases).toEqual({});
    expect(isAliasKey("manual:192.168.1.5:5000")).toBe(false);
    expect(isAliasKey("aaa-bbb-ccc-ddd")).toBe(true);
  });

  it("takes control characters out and stops at the length the column can hold", () => {
    const esc = String.fromCharCode(27);
    expect(cleanAlias(`Dorin${esc}[2J Office`)).toBe("Dorin [2J Office");
    expect([...cleanAlias("x".repeat(200))]).toHaveLength(ALIAS_MAX);
    for (const junk of [5, null, {}, []]) expect(cleanAlias(junk), String(junk)).toBe("");
  });

  it("refuses a map that is not a map", () => {
    for (const junk of ["Office", 5, null, ["a"]]) {
      expect(normalise({ lan: { aliases: junk } }).lan.aliases, JSON.stringify(junk)).toEqual({});
    }
  });

  it("is sent to the page, because the page is what draws it", () => {
    const p = normalise({ lan: { aliases: { "aaa-bbb-ccc-ddd": "Dorin Office" } } });
    expect(publicPrefs(p).lan.aliases).toEqual({ "aaa-bbb-ccc-ddd": "Dorin Office" });
  });
});
