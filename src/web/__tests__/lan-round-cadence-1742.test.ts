// #1742: a row that was taken off the list kept the rounds fast.
//
// Rounds come every ASKING_MS instead of every SYNC_MS while a deck this one
// dialled is still deciding whether to accept it — which the round timer reads
// off the round record. That record keeps one line per row and was asked about
// every line it held, including lines for rows nothing dials any more: an
// address removed in the panel while it said "waiting for the other deck to
// accept this one", one dropped by a settings write, or an automatic row
// evicted by the cap. Nothing dialled that row again to overwrite its line, so
// the deck ran a full round with every paired deck every eight seconds until
// it restarted.
//
// Two engines on loopback, and a fake clock for the gap between rounds; the
// sockets stay real. See lan-engine-rig.ts.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
// @ts-expect-error — plain .mjs server module, no types
import { ASKING_MS, SYNC_MS } from "../../server/lan-engine.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { createRoundRecord } from "../../server/lan-round-record.mjs";
import { rigDeck, stopAll, type RigDeck } from "./lan-engine-rig";

/** The sentence a dialler reads the far deck's refusal as while nobody there
 *  has accepted this deck yet — see REFUSALS in lan-call.mjs. */
const NOT_YET = "waiting for the other deck to accept this one";

beforeEach(() => {
  // Timers and the clock only: the sockets under the engines are real, and
  // their I/O has to keep running while the clock is moved by hand.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
});
afterEach(() => {
  stopAll();
  vi.useRealTimers();
});

const HAND = { autoAsk: false, autoAccept: false };

type Row = { addr: string; port: number; last?: { error?: string } | null };

/** A dials B by address and B never says yes; `drop` then takes B's row
 *  away. Whether the next round after that is a minute away or eight
 *  seconds. */
async function afterDropping(drop: (a: RigDeck, port: number) => void) {
  const b = await rigDeck("Deck-B", { settings: HAND });
  // The engine's clock read at call time, so it is the fake one.
  const a = await rigDeck("Deck-A", { settings: HAND, deps: { now: () => Date.now() } });
  a.e.addPeer("127.0.0.1", b.port);
  await a.e.round();
  const row = (a.e.status().peers as Row[]).find(p => p.port === b.port);
  expect(row?.last?.error, "B was not left deciding").toBe(NOT_YET);

  drop(a, b.port);
  expect(a.e.status().peers).toEqual([]);

  // Re-armed: the first round a whole SYNC_MS from now.
  await a.e.apply({ name: "Deck-A renamed" });
  await vi.advanceTimersByTimeAsync(SYNC_MS);
  const at = a.e.status().checkedAt;
  expect(at, "the timer's round never ran").not.toBeNull();
  await vi.advanceTimersByTimeAsync(ASKING_MS + 10);
  return { at, now: a.e.status().checkedAt };
}

describe("the gap after a waiting row is taken off the list (#1742)", () => {
  it("is back to a minute once the row is removed by hand", async () => {
    const { at, now } = await afterDropping((a, port) => a.e.removePeer("127.0.0.1", port));
    expect(now, "a round ran ASKING_MS later for a row nothing dials").toBe(at);
  }, 30_000);

  it("is back to a minute once a settings write drops the row", async () => {
    const { at, now } = await afterDropping(a => a.e.setPeers([]));
    expect(now, "a round ran ASKING_MS later for a row nothing dials").toBe(at);
  }, 30_000);
});

describe("somebody still deciding, in the record (#1742)", () => {
  it("is asked only of the rows the last round asked", () => {
    const rec = createRoundRecord({ now: () => 0 });
    rec.keep("manual:10.0.0.5:4800", { error: NOT_YET, done: [] });
    rec.finished();
    expect(rec.waitingOnSomebody()).toBe(true);
    // The next round no longer has that row to ask, and asks somebody else.
    rec.keep("fp-a", { offered: 1, done: [] });
    rec.finished();
    expect(rec.waitingOnSomebody(), "a line nothing asks any more kept the rounds fast").toBe(false);
    // And a row the round asks again is read again.
    rec.keep("manual:10.0.0.5:4800", { error: NOT_YET, done: [] });
    expect(rec.waitingOnSomebody()).toBe(true);
  });
});
