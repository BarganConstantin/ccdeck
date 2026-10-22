// The login a deck is on, in its dialog about a paired deck that does not
// offer that login back (#2192).
//
// The login this deck is on stays here while it is, so a paired deck that
// lacks it — the very case keeping it here makes — has nothing to offer for it
// in return. The dialog read that lane as a login this deck promises and
// cannot honour, and said under the lanes "Paired decks get nothing from
// work@example.test until you sign in again here": about a login that works,
// to somebody who would sign in again for nothing. 3.43.3 never said it there.
// The sentence still stands for a login that is expired here, which is what it
// is for.
//
// Two whole decks on loopback through lan-engine-rig.ts, the pairing switches
// as shipped, every credential a synthetic string. The dialog is drawn from
// the status the engine serves, the way the panel draws it: this deck's
// accounts through offeredHere, as LanSyncSection hands them.
import { describe, it, expect, afterEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
// @ts-expect-error — plain .mjs server module, no types
import { accountKey } from "../../server/lan-sync.mjs";
import { offeredHere } from "../account-lan";
import LanPeerMap from "../components/LanPeerMap";
import { deckRows, rowSource } from "../lan-roster";
import { peerView } from "../lan-peer";
import type { LanAccount, LanStatus } from "../lan-types";
import { announce, rigDeck, stopAll, type StoreRow } from "./lan-engine-rig";

afterEach(stopAll);

const SHIPPED = { autoAsk: true, autoAccept: true, pairingMode: "automatic" };
const WORK = "work@example.test";
const HOME = "home@example.test";
const X = accountKey(WORK, "org-w");
const Y = accountKey(HOME, "org-h");

/** A store row as claude-swap's reader hands it over (see live-login-lan-2192). */
type Row = StoreRow & { active?: boolean; collector?: string | null };

const SPENT = /Paired decks get nothing from \S+ until you sign in again here\./;

/** Deck A, on X, paired by the switch with a deck B that offers nothing back:
 *  A's dialog about B, as text, and the view it was drawn from. */
async function dialogAboutB({ rows, held, shared, settings = {} }: {
  rows: Row[]; held: LanAccount[]; shared: string[]; settings?: Record<string, unknown>;
}) {
  const a = await rigDeck("A", {
    rows, shared, settings: { ...SHIPPED, ...settings },
    deps: { exportAccount: async () => "dummy-refresh-live", importAccount: async () => true },
  });
  const b = await rigDeck("B", { settings: SHIPPED, deps: { importAccount: async () => true } });
  announce(b, { fp: a.id.fp, port: a.port, name: "A" });
  for (let i = 0; i < 4; i++) { await b.e.round(); await a.e.round(); }
  const status = a.e.status() as LanStatus;
  const now = Date.now();
  const row = deckRows(status, now).find(r => r.fp === b.id.fp);
  expect(row?.kind, "the rounds never paired the two decks").toBe("paired");
  const accounts = offeredHere(held, status);
  const view = peerView({ row: row!, source: rowSource(status, row!), status, accounts, now });
  const html = renderToStaticMarkup(createElement(LanPeerMap, {
    view, row: row!, status, asking: false, drawn: 0, onSettings: () => {},
  }));
  return { view, text: html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() };
}

describe("a deck's dialog about a paired deck that does not offer back the login this deck is on", () => {
  const rows: Row[] = [{ num: 5, email: WORK, orgUuid: "org-w", alive: true, active: true, collector: "ok" }];
  const held: LanAccount[] = [{ key: X, email: WORK, alive: true, shareable: true, active: true }];

  it("does not tell its owner to sign in again to a login that works", async () => {
    const { view, text } = await dialogAboutB({ rows, held, shared: [X] });
    expect(view.spent.map(l => l.key)).toEqual([]);
    expect(text.match(SPENT)?.[0] ?? null, "a working login is called one to sign in again to").toBeNull();
  }, 30_000);

  it("says nothing of the kind either with that login sent on purpose", async () => {
    const { view, text } = await dialogAboutB({ rows, held, shared: [X], settings: { sendInUse: true } });
    expect(view.spent).toEqual([]);
    expect(text.match(SPENT)?.[0] ?? null).toBeNull();
  }, 30_000);

  it("still says it for a ticked login that is expired here, beside the one in use", async () => {
    const { view, text } = await dialogAboutB({
      rows: [...rows, { num: 6, email: HOME, orgUuid: "org-h", alive: false, active: false, collector: "relogin_required" }],
      held: [...held, { key: Y, email: HOME, alive: false, shareable: false }],
      shared: [X, Y],
    });
    expect(view.spent.map(l => l.key)).toEqual([Y]);
    expect(text.match(SPENT)?.[0] ?? null).toBe(`Paired decks get nothing from ${HOME} until you sign in again here.`);
  }, 30_000);
});
