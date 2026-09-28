// Two exports of lan-sync.mjs that only lan-sync.test.ts ever called.
//
// `isPresent` said whether a heard deck counted as here, and `peerRows` sorted
// the peer table present-first, then by name. Nothing in src or bin read
// either. The panel decides both on its own side: lan-roster.ts's isOnline,
// on ONLINE_MS and on whether the last round got through, and deckRows' own
// name order, which compares numerically where peerRows did not. So the suite
// was pinning an order the product never drew, the drift
// dead-surface-798.test.ts warns about. Both functions are gone, with the
// cases that ran them.
//
// Both halves, the way the other dead-surface files assert theirs: the
// exports are gone, and the table and the window they sat beside still work.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isOnline, ONLINE_MS } from "../lan-roster";
import type { Peer } from "../lan-types";
// @ts-expect-error — plain .mjs server module, no types
import * as lanSync from "../../server/lan-sync.mjs";
import { lanSyncSurface } from "./lan-sync-surface";

const source = readFileSync(fileURLToPath(new URL("../../server/lan-sync.mjs", import.meta.url)), "utf8");

describe("isPresent and peerRows", () => {
  it("are neither exported nor declared by lan-sync.mjs", () => {
    // Declared: asked of lan-sync.mjs and every file lifted out of it, so a
    // move cannot let either come back unnoticed — see lan-sync-surface.ts.
    for (const name of ["isPresent", "peerRows"]) {
      expect(Object.keys(lanSync), name).not.toContain(name);
      expect(lanSyncSurface(), `${name} is declared again`).not.toMatch(new RegExp(`function ${name}\\b`));
    }
  });
});

describe("what they sat beside", () => {
  const now = 1_800_000_000_000;
  const beacon = { fp: "aaa-aaa-aaa-aaa", name: "MacBook", port: 4319, instance: "0badc0de" };

  it("still keeps a deck that went quiet in the table, until the day is out", () => {
    const peers = new Map();
    lanSync.notePeer(peers, beacon, "192.168.1.5", now);
    const row = peers.get(beacon.fp);
    expect(lanSync.stillListed(row, now + lanSync.PRESENT_MS + 1)).toBe(true);
    expect(lanSync.stillListed(row, now + lanSync.FORGET_MS + 1)).toBe(false);
  });

  it("still draws the window every server reader of presence is built on", () => {
    // pairable offers only decks heard inside it, and notePeer keeps the local
    // route while it has answered inside it.
    expect(source).toMatch(/presentMs = PRESENT_MS/);
    expect(source).toMatch(/now - lanAt < PRESENT_MS/);
    expect(lanSync.PRESENT_MS).toBeGreaterThan(lanSync.ANNOUNCE_MS * 2);
  });

  it("leaves presence on the panel to the rule that ships", () => {
    const heard = { fp: beacon.fp, name: "MacBook", lastSeen: now } as unknown as Peer;
    expect(isOnline(heard, now + ONLINE_MS - 1)).toBe(true);
    expect(isOnline(heard, now + ONLINE_MS + 1)).toBe(false);
    expect(ONLINE_MS).toBeGreaterThan(lanSync.ANNOUNCE_MS * 3);
  });
});
