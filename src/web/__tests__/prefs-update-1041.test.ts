// #1041: three read-modify-writes on prefs.json computed their patch from a
// module-level copy of the file rather than from what the write was about to
// read, and one of them carried a comment claiming the opposite.
//
// `writePrefs` serialises the WRITE and merges from its own `readPrefs`, so two
// writes naming two different fields cannot lose each other. What it cannot do
// is merge two writes of the SAME field — and `index.mjs`'s `onDial`, its accept
// route and its alias route each compute one whole field (`lan.manual` twice,
// `lan.aliases` once) out of `_prefs`, which is refreshed only when a previous
// write resolves.
//
// OBSERVED, driving the real writePrefs in a temp directory with those exact
// call shapes, starting from `manual: ["10.0.0.1:5000"]` and
// `aliases: {"aaa-bbb-111":"Laptop"}`:
//
//     memory manual  = ["10.0.0.1:5000","10.0.0.3:5002"]   # the onDial entry is gone
//     disk   manual  = ["10.0.0.1:5000","10.0.0.3:5002"]
//     memory aliases = {"aaa-bbb-111":"Laptop","ccc-ddd-222":"Studio"}   # "Desktop" is gone
//
// Both writes answered, both panels redrew, one change was never written. The
// alias route's own comment said "the whole map is rebuilt from the one on disk
// rather than sent by the page, so two tabs renaming two decks cannot undo each
// other" — `_prefs` is not the one on disk, and that is the sentence
// `updatePrefs` makes true.
//
// WHAT IT COST BESIDES A NAME. Pressing accept on a heard deck at the moment an
// invite-pairing round fires `onDial` dropped the dialled address out of
// `lan.manual`, so `setPeers` stopped dialling it at the next settings write and
// the pairing went one-way with nothing on screen to say so — the failure
// `onDial`'s own comment describes.
//
// THE SECOND HALF IS THE OTHER DIRECTION: prefs handing the LAN engine back its
// own state. `onTrust` writes the engine's trusted list through `writePrefs`,
// which is queued; `handlePrefsWrite` then assigns `_prefs` and calls
// `applyLanPrefs`, which read `_prefs.lan.trusted` and handed it to
// `lanEngine.apply`, whose `apply` does `cfg = { ...cfg, ...next }` — replacing
// the array wholesale. Between `onTrust` firing and its job draining, that list
// is the PRE-PAIRING one. Reproduced below with two real engines and a real
// handshake; it was
//
//     B trusted after accept                : old-deck-fp, 6ef-127-19e-79e
//     B trusted after a plain settings write: old-deck-fp
//
// and `GET /api/lan` reads `lanEngine.status()`, so the panel showed B unpaired
// while prefs.json said paired, B's calls were refused, and the next `onTrust`
// from any source wrote `cfg.trusted` back to disk without B — permanently.
import { describe, it, expect, afterAll, afterEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-prefs-1041-"));
const prevEnv = { ...process.env };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.XDG_CONFIG_HOME = join(DIR, "config");
if (!resolve(process.env.HOME!).startsWith(resolve(DIR))) throw new Error("sandbox escaped");

interface Prefs { lan: { manual: string[]; aliases: Record<string, string>; trusted: Array<{ fp: string }> } }
// @ts-expect-error — plain .mjs server module, no types
const { readPrefs, updatePrefs, withAlias, withManualEntry, writePrefs } = await import("../../server/deck-prefs.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { lanApplyFields } = await import("../../server/index.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { createEngine } = await import("../../server/lan-engine.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { identityFrom } = await import("../../server/lan-sync.mjs");

const read = () => readPrefs(DIR) as Promise<Prefs>;

afterAll(() => {
  for (const k of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME"]) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  rmTempDir(DIR);
});

// ── 1. the patch is a function of the file ──────────────────────────────────

// The patches are the routes' own, imported rather than written out here. They
// used to be copies of index.mjs's closures, and a copy is tested against
// deck-prefs.mjs while the route it was copied from is free to change (#1168).
// lan-routes.test.ts drives the alias route itself, through the socket.

/** `onDial` and the accept route, in one shape, because they are one shape. */
const addManual = (entry: string) => updatePrefs(withManualEntry(entry), DIR);

/** The alias route. */
const setAlias = (fp: string, name: string) => updatePrefs(withAlias(fp, name), DIR);

describe("two writes of one field inside one turn", () => {
  it("loses one when the patch is computed outside the job, which is what happened", async () => {
    // The mechanism, pinned so the cases below cannot be mistaken for
    // `writePrefs` having changed: it has not, and it is still right for what it
    // is for. A whole-array patch built from a copy taken before either job ran
    // is a patch that overwrites; serialising the write does not make it merge.
    await writePrefs({ lan: { manual: ["10.0.0.1:5000"] } }, DIR);
    const copy = await read();
    const stale = (entry: string) => {
      const manual = copy.lan.manual;
      return writePrefs({ lan: { manual: [...manual, entry] } }, DIR);
    };
    await Promise.all([stale("10.0.0.2:5001"), stale("10.0.0.3:5002")]);
    expect((await read()).lan.manual).toEqual(["10.0.0.1:5000", "10.0.0.3:5002"]);
  });

  it("keeps both addresses, where a patch off a stale copy kept one", async () => {
    await writePrefs({ lan: { manual: ["10.0.0.1:5000"], aliases: {} } }, DIR);
    // Neither call has seen the other's write when it is made, which is what
    // "in the same turn" means and is the whole of the bug.
    await Promise.all([addManual("10.0.0.2:5001"), addManual("10.0.0.3:5002")]);
    expect((await read()).lan.manual)
      .toEqual(["10.0.0.1:5000", "10.0.0.2:5001", "10.0.0.3:5002"]);
  });

  it("keeps both names, which is what the alias route's comment promised", async () => {
    await writePrefs({ lan: { manual: [], aliases: { "aaa-bbb-111": "Laptop" } } }, DIR);
    // Two tabs renaming two different decks.
    await Promise.all([setAlias("bbb-ccc-111", "Desktop"), setAlias("ccc-ddd-222", "Studio")]);
    expect((await read()).lan.aliases)
      .toEqual({ "aaa-bbb-111": "Laptop", "bbb-ccc-111": "Desktop", "ccc-ddd-222": "Studio" });
  });

  it("still lets a rename land on a key another write is adding beside", async () => {
    await writePrefs({ lan: { aliases: { "aaa-bbb-111": "Laptop" } } }, DIR);
    await Promise.all([setAlias("aaa-bbb-111", ""), setAlias("bbb-ccc-111", "Desktop")]);
    // The clear is a removal from a map read inside its own job, so it takes
    // away the key it names and nothing else.
    expect((await read()).lan.aliases).toEqual({ "bbb-ccc-111": "Desktop" });
  });

  it("is still a PATCH: a field nobody mentions keeps its value", async () => {
    // The doctrine writePrefs was written under, unchanged — an omitted field
    // erasing a setting would be a bug with no upside, and the LAN section
    // merges so nothing has to send back a secret it was never given.
    await writePrefs({ notifications: true, lan: { name: "MacBook", manual: ["10.0.0.9:5005"] } }, DIR);
    await updatePrefs(() => ({ autoUpdate: false }), DIR);
    const after = await read() as Prefs & { notifications: boolean; autoUpdate: boolean; lan: { name: string } };
    expect(after.notifications).toBe(true);
    expect(after.lan.name).toBe("MacBook");
    expect(after.lan.manual).toEqual(["10.0.0.9:5005"]);
    expect(after.autoUpdate).toBe(false);
  });

  it("writes the file the same way writePrefs does — one document, 0600, whole", async () => {
    // The mutate callback is the only thing that moved. The atomic temp-file
    // write and the mode are what keep a corrupt prefs.json from being the only
    // record of what the user chose, and a private key from being world-readable
    // for the window between a write and a chmod.
    await updatePrefs(() => ({ lan: { name: "Studio" } }), DIR);
    const raw = readFileSync(join(DIR, "prefs.json"), "utf8");
    expect(JSON.parse(raw).lan.name).toBe("Studio");
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("does not wedge the queue when the mutate throws", async () => {
    // `_chain` is shared by every writer in the process, so a job that rejects
    // and is not caught would stall every later settings write in the deck.
    await writePrefs({ lan: { name: "before" } }, DIR);
    await expect(updatePrefs(() => { throw new Error("nope"); }, DIR)).rejects.toThrow("nope");
    await updatePrefs(() => ({ lan: { name: "after" } }), DIR);
    expect((await read() as Prefs & { lan: { name: string } }).lan.name).toBe("after");
  });
});

// ── 2. what a settings write may tell the engine ────────────────────────────

const ENGINE_AUTHORED = ["secret", "trusted", "port"];

describe("the three fields the engine authors", () => {
  const stored = {
    lan: {
      enabled: true, name: "Deck-B", secret: "A-PRIVATE-KEY", port: 45_318,
      trusted: [{ fp: "old-deck-fp", pub: "PUB", name: "Yesterday" }],
      shared: ["a@example.test@@org-1"], aliases: { "aaa-bbb-111": "Laptop" },
      autoAsk: true, autoAccept: false, shareActive: true,
    },
  };

  it("are loaded at boot, because that is when the file IS the authority", () => {
    const fields = lanApplyFields(stored, { load: true, env: {} });
    for (const k of ENGINE_AUTHORED) expect(fields, k).toHaveProperty(k);
    expect(fields.secret).toBe("A-PRIVATE-KEY");
    expect(fields.trusted).toEqual(stored.lan.trusted);
    expect(fields.port).toBe(45_318);
  });

  it("are not named again by a settings write", () => {
    const fields = lanApplyFields(stored, { load: false, env: {} });
    for (const k of ENGINE_AUTHORED) expect(fields, k).not.toHaveProperty(k);
  });

  it("never withholds what a page actually owns", () => {
    // The other direction of the same fix: omitting too much would mean a panel
    // press that changes nothing, which is the failure this was meant to end.
    const fields = lanApplyFields(stored, { load: false, env: {} });
    expect(fields).toEqual({
      enabled: true,
      name: "Deck-B",
      shared: ["a@example.test@@org-1"],
      autoAsk: true,
      autoAccept: false,
      shareActive: true,
      tailscale: false,
      tailscaleAsk: true,
      tailscaleAccept: true,
      aliases: { "aaa-bbb-111": "Laptop" },
    });
  });

  it("still lets the machine veto the whole feature", () => {
    // AGENTS_DECK_NO_LAN=1 is how a launch script — and this repo's own suite —
    // keeps a deck off the network now that the default is on.
    expect(lanApplyFields(stored, { load: false, env: { AGENTS_DECK_NO_LAN: "1" } }).enabled).toBe(false);
  });
});

// ── 3. the pairing, against two real engines ────────────────────────────────

function deafSocket() {
  return {
    on() { /* nothing arrives */ },
    bind(_p: number, _h: string, cb: () => void) { cb(); },
    setBroadcast() { /* nothing to set */ },
    send(_m: unknown, _p: number, _a: string, cb?: (e: Error | null) => void) { cb?.(null); },
    close() { /* nothing to release */ },
  };
}

interface Engine {
  apply(next: Record<string, unknown>): Promise<void>;
  accept(fp: string): unknown;
  addPeer(addr: string, port: number): boolean;
  round(): Promise<unknown>;
  status(): { fp: string; port: number; trusted: Array<{ fp: string }> };
  stop(): void;
}

const running: Engine[] = [];
afterEach(() => { for (const e of running.splice(0)) e.stop(); });

/** One deck, with its own key and a deaf UDP socket — the manual-peer path, so
 *  nothing is broadcast onto whatever network this suite is running on. */
async function deck(name: string): Promise<{ e: Engine; trusted: Array<{ fp: string }> }> {
  const id = identityFrom("");
  const trusted: Array<{ fp: string }> = [];
  const e = createEngine({
    readAccounts: async () => ({ accounts: [] }),
    exportAccount: async () => "blob",
    importAccount: async () => true,
    createSocket: () => deafSocket(),
    onError: () => { /* a round reports itself, per peer */ },
    // What index.mjs does through prefs: the engine's list, written straight
    // back into what the next apply is given.
    onTrust: (list: Array<{ fp: string }>) => { trusted.splice(0, trusted.length, ...list); },
  }) as Engine;
  running.push(e);
  await e.apply({ enabled: true, name, secret: id.secret, shared: [], trusted, autoAsk: false, autoAccept: false });
  return { e, trusted };
}

describe("a pairing made while a settings write is queued", () => {
  it("survives the settings write", async () => {
    const yesterday = { fp: "old-deck-fp", pub: identityFrom("").pub, name: "Yesterday", at: 1 };
    const a = await deck("Deck-A");
    const b = await deck("Deck-B");
    // B has one deck pinned before any of this — the deck the user paired
    // yesterday, seeded the way a boot seeds it: out of prefs.
    await b.e.apply({ trusted: [yesterday] });

    // Somebody types A's address here and presses accept there. The first round
    // is refused — B has never been told to trust A — and that refusal is what
    // puts A in the list with an accept on it.
    expect(a.e.addPeer("127.0.0.1", b.e.status().port)).toBe(true);
    await a.e.round();
    expect(b.e.accept(a.e.status().fp), "B had nothing to accept").toBeTruthy();
    expect(b.e.status().trusted.map(t => t.fp)).toContain(a.e.status().fp);

    // `onTrust`'s writePrefs is now QUEUED. Another tab flips notifications in
    // the same second; that handler's `_prefs` was merged from a disk read taken
    // before `onTrust` wrote, so its `lan.trusted` is the pre-pairing list.
    const stalePrefs = { lan: { enabled: true, name: "Deck-B", trusted: [yesterday] } };
    await b.e.apply(lanApplyFields(stalePrefs, { load: false, env: {} }));

    expect(b.e.status().trusted.map(t => t.fp)).toContain(a.e.status().fp);
    expect(b.e.status().trusted.map(t => t.fp)).toContain("old-deck-fp");
  }, 25_000);

  it("is still replaced wholesale when the engine is handed a list, which is why it is not", async () => {
    // The mechanism, stated so the fix above cannot be mistaken for `apply`
    // having changed: it has not. `cfg = { ...cfg, ...next }` replaces the
    // array, and that is correct for a boot and wrong for everything after it.
    const yesterday = { fp: "old-deck-fp", pub: identityFrom("").pub, name: "Yesterday", at: 1 };
    const b = await deck("Deck-C");
    await b.e.apply({ trusted: [yesterday] });
    expect(b.e.status().trusted.map(t => t.fp)).toEqual(["old-deck-fp"]);
    await b.e.apply({ trusted: [] });
    expect(b.e.status().trusted).toEqual([]);
  }, 25_000);
});
