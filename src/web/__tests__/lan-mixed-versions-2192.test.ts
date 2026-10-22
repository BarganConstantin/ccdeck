// The login a deck is on, between decks of two versions (#2192).
//
// A deck from before #2192 reads no `inUse` mark: it skips a login listed
// `shareable: false`, as every deck since 3.29.0 does, and asks for anything
// else. So what it learns, and what it is sent, is only what this deck's frames
// say. It is played here the way live-login-lan-2192 plays one: the same paired
// key, on its own connection, sending the frames such a deck sends.
//
// A deck from before #2192 that SENDS lists the login it is on like any other
// and hands it out when asked, with nothing to switch off. On the wire that is
// a deck of this version with "Send the login this deck is using too" on — the
// same list and the same answer — and it is played by one below, to pin what a
// deck of this version draws about it.
//
// LOOPBACK ONLY, through lan-engine-rig.ts, with the pairing switches as
// shipped and every credential a synthetic string.
import { describe, it, expect, afterEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
// @ts-expect-error — plain .mjs server module, no types
import { accountKey, transferChallenge } from "../../server/lan-sync.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { connectToPeer } from "../../server/lan-socket.mjs";
import { offeredHere, sharedLine, sharedMarks } from "../account-lan";
import LanPeerMap from "../components/LanPeerMap";
import { laneSaid, peerView } from "../lan-peer";
import { deckRows, rowSource } from "../lan-roster";
import type { LanAccount, LanStatus } from "../lan-types";
import { announce, rigDeck, stopAll, type RigDeck, type StoreRow } from "./lan-engine-rig";

afterEach(stopAll);

const SHIPPED = { autoAsk: true, autoAccept: true, pairingMode: "automatic" };
const WORK = "work@example.test";
const HOME = "home@example.test";
const SPARE = "spare@example.test";
const X = accountKey(WORK, "org-w");
const Y = accountKey(HOME, "org-h");
const Z = accountKey(SPARE, "org-s");

/** A store row as claude-swap's reader hands it over (see live-login-lan-2192). */
type Row = StoreRow & { active?: boolean; collector?: string | null };

async function rounds(here: RigDeck, most = 4) {
  let done: Array<Record<string, unknown>> = [];
  for (let i = 0; i < most && !done.length; i++) done = await here.e.round();
  return done;
}

/** `who`'s key on its own connection to `far`, and one frame asked and answered on it. */
async function wire(who: RigDeck, far: RigDeck) {
  const conn = await connectToPeer({
    host: "127.0.0.1", port: far.port, fp: who.id.fp, pub: who.id.pub, secret: who.id.secret,
    name: "Old", expectPub: far.id.pub,
  });
  const ask = (frame: Record<string, unknown>) => new Promise<Record<string, any>>(resolve => {
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
  const want = (key: string, nonce: string) => ask({
    t: "want", key, nonce, proof: transferChallenge(conn.key, { nonce, accountKey: key, fromFp: who.id.fp, toFp: far.id.fp }),
  });
  return { ask, want, close: () => conn.sock.destroy() };
}

describe("an older deck, paired with a deck that hides which account it is on", () => {
  it("is told nothing about the login that deck is on, and is refused it as a login not ticked", async () => {
    const exported: number[] = [];
    const far = await rigDeck("Private", {
      rows: [
        { num: 5, email: WORK, orgUuid: "org-w", alive: true, active: true, collector: "ok" },
        { num: 6, email: HOME, orgUuid: "org-h", alive: true, active: false, collector: "ok" },
        { num: 7, email: SPARE, orgUuid: "org-s", alive: true, active: false, collector: "ok" },
      ] as Row[],
      // X is the one it is on; Z is held and not ticked.
      shared: [X, Y], settings: { ...SHIPPED, shareActive: false },
      deps: { exportAccount: async (num: number) => { exported.push(num); return `dummy-refresh-${num}`; } },
    });
    const old = await rigDeck("Old", { settings: SHIPPED, deps: { importAccount: async () => true } });
    announce(old, { fp: far.id.fp, port: far.port, name: "Private" });
    await rounds(old);
    expect(exported, "Y, which that deck is not on, goes out as before").toEqual([6]);

    const w = await wire(old, far);
    try {
      // The list an older deck reads: no row for X at all, so no mark to read or to drop.
      const frame = await w.ask({ t: "manifest" });
      expect(frame.accounts).toEqual([{ key: Y, email: HOME, alive: true }]);
      expect(frame.current).toEqual({ hidden: true });
      // Nothing else rides with it but the sealed card.
      expect(Object.keys(frame).filter(k => !["t", "accounts", "current", "about"].includes(k))).toEqual([]);
      expect(JSON.stringify([frame.accounts, frame.current])).not.toMatch(/work@|inUse/);
      // Asked anyway, with a proof that holds: the answer a login not ticked gets.
      expect(await w.want(X, "n1")).toEqual({ t: "no", why: "not shared" });
      expect(await w.want(Z, "n2")).toEqual({ t: "no", why: "not shared" });
      expect(exported).toEqual([6]);
    } finally {
      w.close();
    }
  }, 30_000);

  it("is still told \"in use\" while that deck shows which account it is on", async () => {
    const far = await rigDeck("Shown", {
      rows: [{ num: 5, email: WORK, orgUuid: "org-w", alive: true, active: true, collector: "ok" }] as Row[],
      shared: [X], settings: SHIPPED,
    });
    const old = await rigDeck("Old", { settings: SHIPPED, deps: { importAccount: async () => true } });
    announce(old, { fp: far.id.fp, port: far.port, name: "Shown" });
    await rounds(old);
    const w = await wire(old, far);
    try {
      expect((await w.ask({ t: "manifest" })).accounts).toEqual([{ key: X, email: WORK, alive: true, shareable: false, inUse: true }]);
      expect(await w.want(X, "n1")).toEqual({ t: "no", why: "in use" });
    } finally {
      w.close();
    }
  }, 30_000);
});

describe("a deck of this version, about an older deck that sends the login it is on", () => {
  it("draws that login as working and in use there, and does not tell anyone to sign in again", async () => {
    // The older deck, played by one with the switch on: it is on X and offers it.
    const old = await rigDeck("Old", {
      rows: [{ num: 5, email: WORK, orgUuid: "org-w", alive: true, active: true, collector: "ok" }] as Row[],
      shared: [X], settings: { ...SHIPPED, sendInUse: true },
    });
    // This deck is on X too, ticks it, and holds Y, which the older deck lacks.
    const here = await rigDeck("New", {
      rows: [
        { num: 1, email: WORK, orgUuid: "org-w", alive: true, active: true, collector: "ok" },
        { num: 2, email: HOME, orgUuid: "org-h", alive: true, active: false, collector: "ok" },
      ] as Row[],
      shared: [X, Y], settings: SHIPPED,
    });
    announce(here, { fp: old.id.fp, port: old.port, name: "Old" });
    for (let i = 0; i < 4; i++) { await here.e.round(); await old.e.round(); }

    const status = here.e.status() as LanStatus;
    const now = Date.now();
    const row = deckRows(status, now).find(r => r.fp === old.id.fp);
    expect(row?.kind, "the rounds never paired the two decks").toBe("paired");
    const held: LanAccount[] = [
      { key: X, email: WORK, alive: true, shareable: true, active: true },
      { key: Y, email: HOME, alive: true, shareable: true },
    ];
    const accounts = offeredHere(held, status);
    const view = peerView({ row: row!, source: rowSource(status, row!), status, accounts, now });
    expect(view.lanes.map(laneSaid)).toEqual([
      "in use here, works there, offered both ways, in use there.",
      "works here, not offered by that deck, offered by this deck.",
    ]);
    expect(view.spent).toEqual([]);
    const text = renderToStaticMarkup(createElement(LanPeerMap, {
      view, row: row!, status, asking: false, drawn: 0, onSettings: () => {},
    })).replace(/<[^>]+>/g, " ");
    expect(text).not.toMatch(/sign in again/);
    expect(text).not.toMatch(/cannot share/);
    // And this deck's own row for X names the older deck as one X is not sent to.
    const mark = new Map(sharedMarks(accounts, status)).get(X)!;
    expect(sharedLine(mark.to, mark.inUse)).toBe("Shared on Local network: in use here · not sent to Old while this deck is on it.");
  }, 30_000);
});
