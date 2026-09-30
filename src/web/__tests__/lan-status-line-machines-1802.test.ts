// #1802. The line under the Local network switch counted keys; the list under
// it counts machines. A colleague's Mac paired under three keys — two deck
// starts, and old keys that never call again — is one row since the list
// learned to draw one row per machine, and the way in at the foot of the
// accounts says `none of 1 online` about it. The line said `this deck cannot
// reach any of its 3 decks`, in the warning ink, into a live region a screen
// reader announces. `N decks ready · M away` and `N decks found · waiting for
// them to accept` counted the same way.
//
// The line now groups the decks it counts by the list's own rule before it
// counts them, so the three places read one number.
import { describe, expect, it } from "vitest";

import { deckRows, entryLine, sectionState } from "../lan-roster";
import type { Peer } from "../lan-types";

const NOW = 1_700_000_000_000;
const HOURS_3 = 3 * 3_600_000;
const ON = { enabled: true, running: true };

/** One of Petrus's decks — lan-one-row-per-machine.test.ts's fixture. */
const peer = (fp: string, over: Partial<Peer> = {}): Peer => ({
  fp, peerFp: fp, name: "Petrus-MacBook-Pro", paired: true,
  addr: "192.168.1.153", port: 57051, lastSeen: NOW, last: { at: NOW, done: [] }, ...over,
});
/** A key the machine held before: paired, no address here, never calls again. */
const oldKey = (fp: string) => peer(fp, { addr: "", port: 0, waiting: true, lastSeen: undefined, last: undefined });
const away = { lastSeen: NOW - HOURS_3, last: { at: NOW - HOURS_3, done: [] } };
const asked = { last: { at: NOW, error: "waiting for the other deck to accept this one" } };

describe("the line under the switch counts machines, as the list does (#1802)", () => {
  it("says one machine is away when the list shows one machine away", () => {
    const s = { ...ON, peers: [peer("759-496-6f5-809", { port: 55899, ...away }), oldKey("585-eb2-55a-7e2"), oldKey("cdf-de5-f8c-263")] };
    const rows = deckRows(s, NOW);
    expect(rows).toHaveLength(1);
    expect(entryLine(s, rows).text).toBe("none of 1 online");
    expect(sectionState(s, NOW)).toEqual({ text: "this deck cannot reach the one it is paired with", tone: "bad" });
  });

  it("counts a machine as ready when one of its keys is, with no away beside it", () => {
    const s = { ...ON, peers: [peer("759-496-6f5-809"), oldKey("585-eb2-55a-7e2"), oldKey("cdf-de5-f8c-263")] };
    expect(sectionState(s, NOW)).toEqual({ text: "1 deck ready", tone: "ok" });
  });

  it("says one machine is waiting to accept when both of its decks are", () => {
    const s = { ...ON, peers: [peer("aaa-aaa-aaa-aaa", asked), peer("bbb-bbb-bbb-bbb", { port: 55899, ...asked })] };
    expect(sectionState(s, NOW)).toEqual({ text: "1 deck found · waiting for them to accept", tone: "wait" });
  });

  it("does not call a machine waiting to accept when another of its decks is ready", () => {
    // The machine is there and one of its decks already takes logins, so the
    // waiting sentence would be about a deck the row does not lead with.
    const s = { ...ON, peers: [peer("aaa-aaa-aaa-aaa", asked), peer("bbb-bbb-bbb-bbb", { port: 55899 })] };
    expect(sectionState(s, NOW)).toEqual({ text: "1 deck ready", tone: "ok" });
  });

  it("keeps apart what the list keeps apart", () => {
    // One name at two addresses is two machines that share a hostname.
    const twoMachines = { ...ON, peers: [peer("aaa-aaa-aaa-aaa"), peer("bbb-bbb-bbb-bbb", { addr: "192.168.1.154", ...away })] };
    expect(deckRows(twoMachines, NOW)).toHaveLength(2);
    expect(sectionState(twoMachines, NOW).text).toBe("1 deck ready · 1 away");
    // And one address under two names is somebody here telling them apart.
    const named = { ...twoMachines, peers: [peer("aaa-aaa-aaa-aaa"), peer("bbb-bbb-bbb-bbb", { port: 55899, ...away })],
      aliases: { "bbb-bbb-bbb-bbb": "Petru work deck" } };
    expect(deckRows(named, NOW)).toHaveLength(2);
    expect(sectionState(named, NOW).text).toBe("1 deck ready · 1 away");
  });

  it("reads the same number as the rows, whatever mix of keys a machine holds", () => {
    const keys: Array<[string, Peer]> = [
      ["live", peer("k-live")],
      ["away", peer("k-away", { port: 55899, ...away })],
      ["asked", peer("k-asked", { port: 55898, ...asked })],
      ["old", oldKey("k-old")],
      ["calling", peer("k-calling", { addr: "", port: 0, waiting: true, lastSeen: NOW - 10_000, last: null })],
    ];
    const other = peer("o-live", { name: "Ana-PC", addr: "192.168.1.20" });
    // Every non-empty mix of Petrus's keys, beside one machine of Ana's that
    // is there, so the count is never only about one row.
    for (let mask = 1; mask < 1 << keys.length; mask++) {
      const mine = keys.filter((_, k) => mask & (1 << k));
      const s = { ...ON, peers: [...mine.map(([, p]) => p), other] };
      const paired = deckRows(s, NOW).filter(r => r.kind === "paired");
      const here = paired.filter(r => r.here).length;
      const text = sectionState(s, NOW).text;
      const said = mine.map(([k]) => k).join("+");
      expect(paired, said).toHaveLength(2);
      // Ana's machine is always ready, so the line is always a count.
      const counted = /^(\d+) decks? ready(?: · (\d+) away)?$/.exec(text);
      expect(counted, `${said}: ${text}`).not.toBeNull();
      expect(Number(counted![1]), `${said}: ${text}`).toBe(here);
      expect(Number(counted![2] ?? 0), `${said}: ${text}`).toBe(paired.length - here);
    }
  });
});
