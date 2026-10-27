// The login a deck is signed in to is not handed to a paired deck on its own
// (#2192) — two whole decks on loopback, with the pairing switches as shipped.
//
// A Claude refresh token renews once: the copy that renews it first gets a new
// one, and every other copy of the old one is refused from then on, which
// Claude Code shows as "Login expired · Please run /login". Before this, a
// paired deck whose copy of a login had expired was "healed" from the deck
// that was signed in to that login right now — so the two machines held one
// token, and the next renewal signed the slower one out. On the shipped
// defaults (asking and accepting both on) nobody pressed anything for that.
//
// What these pin, each against the engine as a deck runs it:
//   - the live login is not taken by a round, as an add or as a heal;
//   - so the renewal race that signs the working machine out never starts;
//   - a deck too old to read the mark, asking anyway, is refused "in use";
//   - every other ticked login still goes out exactly as before, and the live
//     one goes out the moment that deck switches away;
//   - "Send the login this deck is using too" still sends it, on purpose;
//   - pairing itself is untouched.
//
// LOOPBACK ONLY, through lan-engine-rig.ts: every listener binds 127.0.0.1 on a
// port the OS picks, the beacon socket sends nothing, and prefs never touch
// disk. Every credential is a synthetic string made here.
import { describe, it, expect, afterEach } from "vitest";
// @ts-expect-error — plain .mjs server module, no types
import { DEFAULTS } from "../../server/deck-prefs.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { accountKey, transferChallenge } from "../../server/lan-sync.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { connectToPeer } from "../../server/lan-socket.mjs";
import { announce, rigDeck, stopAll, type RigDeck, type StoreRow } from "./lan-engine-rig";

afterEach(stopAll);

/** The pairing settings a deck ships with, read off the defaults themselves. */
const SHIPPED = {
  autoAsk: DEFAULTS.lan.autoAsk,
  autoAccept: DEFAULTS.lan.autoAccept,
  pairingMode: DEFAULTS.lan.pairingMode,
};

const WORK = "work@example.test";
const HOME = "home@example.test";
const X = accountKey(WORK, "org-w");

/** A store row as claude-swap's reader hands it over: `active` is the slot the
 *  CLI is signed in to, and `collector: "ok"` the verdict that lets the active
 *  slot be exported at all (see cachedExportReadable). */
type Row = StoreRow & { active?: boolean; collector?: string | null };

/** Anthropic's renewal rule, as far as this needs it: a token renews once. */
function renewals() {
  const spent = new Set<string>();
  let n = 0;
  return {
    renew(token: string): string | null {
      if (spent.has(token)) return null;
      spent.add(token);
      n += 1;
      return `dummy-refresh-renewed-${n}`;
    },
  };
}

/** One machine's Claude login: the synthetic refresh token it is on, and
 *  whether Claude Code there has been signed out ("Login expired"). */
interface Login { token: string; signedOut: boolean }

/** A deck whose store hands out `tokens[num]` for a slot and records what it
 *  was asked for, what it took in, and through which step. */
async function machine(name: string, {
  rows, shared = [], settings = {}, tokens = {}, onImport,
}: {
  rows: Row[]; shared?: string[]; settings?: Record<string, unknown>;
  tokens?: Record<number, () => string>; onImport?: (blob: string) => void;
}) {
  const exported: number[] = [];
  const imported: string[] = [];
  const d = await rigDeck(name, {
    rows, shared, settings,
    deps: {
      exportAccount: async (num: number) => { exported.push(num); return tokens[num]?.() ?? null; },
      importAccount: async (blob: string) => { imported.push(blob); onImport?.(blob); return true; },
    },
  });
  return { d, exported, imported };
}

/** Whether `here` holds `far`'s pin as one the switch made — read off what
 *  prefs was asked to keep, as lan-switch-pairing.test.ts reads it. */
const pinnedBySwitch = (here: RigDeck, far: RigDeck) =>
  (here.trustWrites.at(-1) ?? []).some(t => t.fp === far.id.fp && t.auto === true);

/** The other deck's row in `here`'s status. */
const peerRow = (here: RigDeck, far: RigDeck) =>
  (here.e.status().peers as Array<Record<string, any>>).find(p => (p.peerFp ?? p.fp) === far.id.fp);

/** Rounds until one moves something, or four — the pairing by the switch
 *  takes the first one or two. */
async function rounds(here: RigDeck, most = 4) {
  let done: Array<Record<string, unknown>> = [];
  for (let i = 0; i < most && !done.length; i++) done = await here.e.round();
  return done;
}

describe("the login a deck is signed in to, between two decks paired by the switch", () => {
  it("ships the switches on, the login in use included since 3.48.1", () => {
    // SHIPPED leaves sendInUse to the engine's own default, off: the cases
    // below are a deck whose owner turned it off. A real deck takes it from
    // its prefs (lanApplyFields), where it ships on.
    expect(SHIPPED).toEqual({ autoAsk: true, autoAccept: true, pairingMode: "automatic" });
    expect(DEFAULTS.lan.sendInUse).toBe(true);
  });

  it("is not added to a deck that lacks it", async () => {
    const far = await machine("Working", {
      rows: [{ num: 5, email: WORK, orgUuid: "org-w", alive: true, active: true, collector: "ok" }],
      shared: [X], settings: SHIPPED, tokens: { 5: () => "dummy-refresh-live" },
    });
    const here = await machine("Here", { rows: [], settings: SHIPPED });
    announce(here.d, { fp: far.d.id.fp, port: far.d.port, name: "Working" });

    expect(await rounds(here.d)).toEqual([]);
    expect(pinnedBySwitch(here.d, far.d), "the rounds never reached the pairing this case is about").toBe(true);
    expect(far.exported, "the deck's live login was exported").toEqual([]);
    expect(here.imported).toEqual([]);
    // Listed — `current` names it — as in use and not offered.
    const offers = peerRow(here.d, far.d)?.offers;
    expect(offers?.accounts).toEqual([{ key: X, email: WORK, alive: true, shareable: false, inUse: true }]);
    expect(offers?.current).toEqual({ key: X });
  }, 30_000);

  it("does not heal another deck's expired copy from it, so the working machine is never signed out", async () => {
    // The reported shape: this deck is on X and its copy expired; the paired
    // deck is on X and working. Healing here from there put one refresh token
    // on two machines, and whichever renewed second was signed out — the
    // working one, when this deck renewed first.
    const auth = renewals();
    const working: Login = { token: "dummy-refresh-live", signedOut: false };
    const expired: Login = { token: "dummy-refresh-spent", signedOut: true };
    const far = await machine("Working", {
      rows: [{ num: 5, email: WORK, orgUuid: "org-w", alive: true, active: true, collector: "ok" }],
      shared: [X], settings: SHIPPED, tokens: { 5: () => working.token },
    });
    const here = await machine("Expired", {
      rows: [{ num: 1, email: WORK, orgUuid: "org-w", alive: false, active: true }],
      settings: SHIPPED,
      onImport: blob => { expired.token = blob; expired.signedOut = false; },
    });
    announce(here.d, { fp: far.d.id.fp, port: far.d.port, name: "Working" });

    const done = await rounds(here.d);
    expect(pinnedBySwitch(here.d, far.d), "the rounds never reached the pairing this case is about").toBe(true);

    // Both machines renew within minutes of each other: the expired one first.
    const renew = (l: Login) => {
      if (l.signedOut) return;
      const next = auth.renew(l.token);
      if (next) l.token = next; else l.signedOut = true;
    };
    renew(expired);
    renew(working);
    expect(working.signedOut, "the working machine was signed out (\"Login expired\")").toBe(false);
    expect(done).toEqual([]);
    expect(far.exported, "the deck's live login was exported").toEqual([]);
    expect(here.imported).toEqual([]);
    // The expired one stays as it was — signing in there gives it a login of its own.
    expect(expired.signedOut).toBe(true);
  }, 30_000);

  it("is refused \"in use\" to a deck too old to read the mark, which asks anyway", async () => {
    const far = await machine("Working", {
      rows: [{ num: 5, email: WORK, orgUuid: "org-w", alive: true, active: true, collector: "ok" }],
      shared: [X], settings: SHIPPED, tokens: { 5: () => "dummy-refresh-live" },
    });
    const here = await machine("Old", { rows: [], settings: SHIPPED });
    announce(here.d, { fp: far.d.id.fp, port: far.d.port, name: "Working" });
    await rounds(here.d);
    expect(pinnedBySwitch(here.d, far.d), "the rounds never reached the pairing this case is about").toBe(true);

    // The same paired key, on its own connection, asking for X with a proof
    // that holds — what a deck from before the mark does with the manifest.
    const conn = await connectToPeer({
      host: "127.0.0.1", port: far.d.port, fp: here.d.id.fp, pub: here.d.id.pub, secret: here.d.id.secret,
      name: "Old", expectPub: far.d.id.pub,
    });
    const ask = (frame: Record<string, unknown>) => new Promise<Record<string, unknown>>(resolve => {
      let buf = "";
      const onData = (chunk: string) => {
        buf += chunk;
        const i = buf.indexOf("\n");
        if (i === -1) return;
        conn.sock.off("data", onData);
        resolve(conn.read(JSON.parse(buf.slice(0, i))));
      };
      conn.sock.on("data", onData);
      conn.send(frame);
    });
    try {
      const proof = transferChallenge(conn.key, { nonce: "n1", accountKey: X, fromFp: here.d.id.fp, toFp: far.d.id.fp });
      expect(await ask({ t: "want", key: X, nonce: "n1", proof })).toEqual({ t: "no", why: "in use" });
      expect(far.exported, "the deck's live login was exported").toEqual([]);
    } finally {
      conn.sock.destroy();
    }
  }, 30_000);

  it("goes out like any other the moment that deck switches away", async () => {
    const rows: Row[] = [
      { num: 5, email: WORK, orgUuid: "org-w", alive: true, active: true, collector: "ok" },
      { num: 6, email: HOME, orgUuid: "org-h", alive: true, active: false, collector: "ok" },
    ];
    const far = await machine("Working", {
      rows, shared: [X], settings: SHIPPED, tokens: { 5: () => "dummy-refresh-x", 6: () => "dummy-refresh-y" },
    });
    const here = await machine("Here", { rows: [], settings: SHIPPED });
    announce(here.d, { fp: far.d.id.fp, port: far.d.port, name: "Working" });
    expect(await rounds(here.d)).toEqual([]);
    expect(far.exported).toEqual([]);

    // The working deck moves to HOME, which it does not share.
    rows[0].active = false;
    rows[1].active = true;
    expect(await here.d.e.round()).toEqual([{ key: X, email: WORK, action: "add", ok: true, why: null }]);
    expect(far.exported).toEqual([5]);
    expect(here.imported).toEqual(["dummy-refresh-x"]);
  }, 30_000);
});

describe("what does not change", () => {
  it("a ticked login the deck is not on goes out as it always did", async () => {
    const far = await machine("Working", {
      rows: [
        { num: 5, email: WORK, orgUuid: "org-w", alive: true, active: false, collector: "ok" },
        { num: 6, email: HOME, orgUuid: "org-h", alive: true, active: true, collector: "ok" },
      ],
      shared: [X], settings: SHIPPED, tokens: { 5: () => "dummy-refresh-x" },
    });
    const here = await machine("Here", { rows: [], settings: SHIPPED });
    announce(here.d, { fp: far.d.id.fp, port: far.d.port, name: "Working" });
    expect(await rounds(here.d)).toEqual([{ key: X, email: WORK, action: "add", ok: true, why: null }]);
    expect(pinnedBySwitch(here.d, far.d)).toBe(true);
    expect(far.exported).toEqual([5]);
    expect(here.imported).toEqual(["dummy-refresh-x"]);
    // Offered exactly as before: no mark on a login the deck is not on.
    expect(peerRow(here.d, far.d)?.offers?.accounts).toEqual([{ key: X, email: WORK, alive: true }]);
  }, 30_000);

  it("an expired copy is still healed from a deck that holds the login and is not on it", async () => {
    const far = await machine("Working", {
      rows: [
        { num: 5, email: WORK, orgUuid: "org-w", alive: true, active: false, collector: "ok" },
        { num: 6, email: HOME, orgUuid: "org-h", alive: true, active: true, collector: "ok" },
      ],
      shared: [X], settings: SHIPPED, tokens: { 5: () => "dummy-refresh-x" },
    });
    const here = await machine("Expired", {
      rows: [{ num: 1, email: WORK, orgUuid: "org-w", alive: false, active: true }], settings: SHIPPED,
    });
    announce(here.d, { fp: far.d.id.fp, port: far.d.port, name: "Working" });
    expect(await rounds(here.d)).toEqual([{ key: X, email: WORK, action: "heal", ok: true, why: null }]);
    expect(far.exported).toEqual([5]);
  }, 30_000);

  it("the owner can still send the login the deck is on, by turning that on", async () => {
    const far = await machine("Working", {
      rows: [{ num: 5, email: WORK, orgUuid: "org-w", alive: true, active: true, collector: "ok" }],
      shared: [X], settings: { ...SHIPPED, sendInUse: true }, tokens: { 5: () => "dummy-refresh-live" },
    });
    const here = await machine("Here", { rows: [], settings: SHIPPED });
    announce(here.d, { fp: far.d.id.fp, port: far.d.port, name: "Working" });
    expect(await rounds(here.d)).toEqual([{ key: X, email: WORK, action: "add", ok: true, why: null }]);
    expect(far.exported).toEqual([5]);
    expect(here.imported).toEqual(["dummy-refresh-live"]);
  }, 30_000);

  it("pairing: the switch pairs the two decks as before, and each still says which login it is on", async () => {
    for (const live of [true, false]) {
      // On X, which it shares — or on HOME, which it does not.
      const far = await machine("Working", {
        rows: [
          { num: 5, email: WORK, orgUuid: "org-w", alive: true, active: live, collector: "ok" },
          { num: 6, email: HOME, orgUuid: "org-h", alive: true, active: !live, collector: "ok" },
        ],
        shared: [X], settings: SHIPPED, tokens: { 5: () => "dummy-refresh" },
      });
      const here = await machine("Here", { rows: [], settings: SHIPPED });
      announce(here.d, { fp: far.d.id.fp, port: far.d.port, name: "Working" });
      await rounds(here.d);
      // A pin the switch made, kept as one, on the deck that asked…
      expect(here.d.trustWrites.at(-1), String(live)).toMatchObject([{ fp: far.d.id.fp, auto: true }]);
      // …and the row is a paired deck, which says where it is working.
      const row = peerRow(here.d, far.d);
      expect(row?.paired, String(live)).toBe(true);
      expect(row?.offers?.current, String(live)).toEqual(live ? { key: X } : { other: true });
      stopAll();
    }
  }, 60_000);
});
