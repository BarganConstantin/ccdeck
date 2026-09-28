// One function per kind of row on the Local network list, and the three small
// rules they share.
//
// deckRows built all five kinds inline, in one function of 170 lines, and
// wrote three things out more than once: the `via` a tailnet deck carries, the
// `self` a renamed deck carries, and the cut that drops a round's clock. They
// are askingRow, diallingRow, pairedRow, nearbyRow and declinedRow now, with
// named, tailnet and roundWords beside them, all private to lan-roster.ts —
// deckRows is their one reader, and each kind of row comes from exactly one of
// them. So each is run here through deckRows, handed a status holding only the
// kind it builds, and its whole row is checked, key order included: the order
// is what JSON.stringify prints, and it is the same order the inline literals
// had. An old-against-new run over generated rosters was done by hand, both
// builds, and found no row that differs.
import { describe, expect, it } from "vitest";

import { deckRows, type DeckRow } from "../lan-roster";
import type { LanStranger, Peer } from "../lan-types";

const NOW = 1_790_550_000_000;
const MIN = 60_000;

const one = (s: Parameters<typeof deckRows>[0]): DeckRow => {
  const rows = deckRows(s, NOW);
  expect(rows).toHaveLength(1);
  return rows[0];
};

const stranger = (over: Partial<LanStranger> = {}): LanStranger =>
  ({ fp: "aaa-aaa-aaa-aaa", name: "Studio", addr: "192.168.1.5", at: NOW - 30_000, ...over });

const peer = (over: Partial<Peer> = {}): Peer => ({
  fp: "bbb-bbb-bbb-bbb", peerFp: "bbb-bbb-bbb-bbb", name: "MacBook", addr: "192.168.1.6", port: 4319,
  paired: true, lastSeen: NOW - 5_000, last: { at: NOW - 5_000, done: [] }, ...over,
});

const typed = (over: Partial<Peer> = {}): Peer => ({
  fp: "manual:10.0.0.9:4319", peerFp: null, name: "10.0.0.9", addr: "10.0.0.9", port: 4319,
  manual: true, met: false, paired: false, ...over,
});

describe("askingRow", () => {
  it("draws a request as waiting on this keyboard, with how long it has waited", () => {
    const row = one({ pending: [stranger({ at: NOW - 5 * MIN })] });
    expect(row).toEqual({
      fp: "aaa-aaa-aaa-aaa", name: "Studio", addr: "192.168.1.5",
      kind: "asks", state: "wants to pair · 5m ago", tone: "wait", here: true,
      hint: "Studio at 192.168.1.5 is waiting for an answer.",
    });
    expect(Object.keys(row)).toEqual(["fp", "name", "addr", "kind", "state", "tone", "here", "hint"]);
  });

  it("says a request came over the tailnet, and carries the route last", () => {
    const row = one({ pending: [stranger({ via: "tailscale" })] });
    expect(row.hint).toBe("Studio at 192.168.1.5, over Tailscale, is waiting for an answer.");
    expect(Object.keys(row)).toEqual(["fp", "name", "addr", "kind", "state", "tone", "here", "hint", "via"]);
    expect(row.via).toBe("tailscale");
  });
});

describe("diallingRow", () => {
  it("names an address nothing has answered at by the address, and says it is trying", () => {
    const row = one({ peers: [typed({ last: null })] });
    expect(row).toEqual({
      fp: "10.0.0.9:4319", name: "10.0.0.9:4319", addr: "10.0.0.9",
      kind: "dialling", state: "trying…", tone: "idle", here: false,
      hint: "Dialling 10.0.0.9:4319 until something answers.",
    });
    expect(Object.keys(row)).toEqual(["fp", "name", "addr", "kind", "state", "tone", "here", "hint"]);
  });

  it("says what the last attempt met, without its clock, and the whole error in the hint", () => {
    const row = one({ peers: [typed({ last: { at: NOW - MIN, error: "connect ECONNREFUSED 10.0.0.9:4319" } })] });
    expect(row.state).toBe("not listening");
    expect(row.tone).toBe("bad");
    expect(row.hint).toBe("Nothing has answered at 10.0.0.9:4319 yet — connect ECONNREFUSED 10.0.0.9:4319.");
  });

  it("drops the clock a finished round carries", () => {
    const row = one({ peers: [typed({ last: { at: NOW - 3 * MIN, done: [] } })] });
    expect(row.state).toBe("all logins fine");
  });

  it("falls back to the deck's name, then its fingerprint, with no address", () => {
    expect(one({ peers: [typed({ addr: "", name: "Typed" })] }).name).toBe("Typed");
    expect(one({ peers: [typed({ addr: "", name: "" })] }).name).toBe("manual:10.0.0.9:4319");
  });
});

describe("pairedRow", () => {
  it("says nothing about a deck that is online and whose round found nothing to do", () => {
    const row = one({ peers: [peer()] });
    expect(row).toEqual({
      fp: "bbb-bbb-bbb-bbb", name: "MacBook", addr: "192.168.1.6",
      kind: "paired", state: "online · all logins fine", quiet: true, tone: "idle", here: true,
      hint: "MacBook at 192.168.1.6:4319",
    });
    expect(Object.keys(row)).toEqual(["fp", "name", "addr", "kind", "state", "quiet", "tone", "here", "hint"]);
  });

  it("leads with online and keeps what the round moved, before any clock", () => {
    const row = one({ peers: [peer({ last: { at: NOW - 5_000, done: [
      { email: "a@b.c", action: "heal", ok: true, why: "keychain_unavailable" },
    ] } })] });
    expect(row.state).toBe("online · 1 login arrived, Keychain locked on the other Mac");
    expect(row.quiet).toBe(false);
    expect(row.tone).toBe("warn");
    expect(row.hint).toMatch(/^MacBook at 192\.168\.1\.6:4319 — a@b\.c: the other Mac could not export it\./);
  });

  it("says when a deck that is away was last online, after what its last round did", () => {
    const row = one({ peers: [peer({ lastSeen: NOW - 60 * MIN, last: { at: NOW - 60 * MIN, error: "timed out" } })] });
    expect(row.here).toBe(false);
    expect(row.state).toMatch(/ · last online 1h ago$/);
    expect(row.tone).toBe("bad");
    expect(row.hint).toBe("MacBook at 192.168.1.6:4319 — timed out");
  });

  it("says never reached, or has not called yet, when there is nothing to date", () => {
    expect(one({ peers: [peer({ lastSeen: undefined, last: null })] }).state).toBe("never reached");
    expect(one({ peers: [peer({ waiting: true, lastSeen: undefined, last: null, addr: "", port: 0 })] }).state)
      .toBe("one-way · has not called yet");
  });

  it("draws a deck that calls in by when it last called", () => {
    const fresh = one({ peers: [peer({ waiting: true, addr: "", port: 0, last: null })] });
    expect(fresh).toMatchObject({ state: "online · one-way, it calls in", here: true, quiet: false, tone: "ok" });
    expect(fresh.hint).toMatch(/^MacBook calls this deck, .* It last called now\. Add its address/);
    const stale = one({ peers: [peer({ waiting: true, addr: "", port: 0, last: null, lastSeen: NOW - 40 * MIN })] });
    expect(stale).toMatchObject({ state: "one-way · last online 40m ago", here: false, tone: "idle" });
  });

  it("paints an answer from a person as a wait, not a fault", () => {
    const row = one({ peers: [peer({ last: { at: NOW - 5_000, error: "waiting for the other deck to accept this one" } })] });
    expect(row.tone).toBe("wait");
    expect(row.here).toBe(true);
    expect(one({ peers: [peer({ last: { at: NOW - 5_000, error: "that deck said no" } })] }).tone).toBe("bad");
  });

  it("names a typed address that has not answered by the address, even when paired", () => {
    const row = one({ peers: [typed({ paired: true, last: null })] });
    expect(row.kind).toBe("paired");
    expect(row.name).toBe("10.0.0.9:4319");
    expect(row.fp).toBe("manual:10.0.0.9:4319");
  });

  it("carries the tailnet route between presence and the hint", () => {
    const row = one({ peers: [peer({ via: "tailscale" })] });
    expect(Object.keys(row)).toEqual(["fp", "name", "addr", "kind", "state", "quiet", "tone", "here", "via", "hint"]);
  });
});

describe("nearbyRow", () => {
  it("says what pairing takes, by the pairing mode", () => {
    const row = one({ strangers: [stranger()] });
    expect(row).toEqual({
      fp: "aaa-aaa-aaa-aaa", name: "Studio", addr: "192.168.1.5",
      kind: "nearby", state: "not paired yet", tone: "idle", here: true,
      hint: "Studio at 192.168.1.5 is on this network and nothing is shared with it.",
    });
    expect(Object.keys(row)).toEqual(["fp", "name", "addr", "kind", "state", "tone", "here", "hint"]);
    expect(one({ strangers: [stranger()], pairingMode: "invite" }).state).toBe("needs an invite");
    expect(one({ strangers: [stranger()], pairingMode: "automatic" }).state).toBe("not paired yet");
  });

  it("says a deck is on the tailnet when it was heard there", () => {
    const row = one({ strangers: [stranger({ via: "tailscale" })] });
    expect(row.hint).toBe("Studio at 192.168.1.5 is on your tailnet and nothing is shared with it.");
    expect(row.via).toBe("tailscale");
  });
});

describe("declinedRow", () => {
  it("says no was the answer, and carries no route", () => {
    const row = one({ declined: [stranger({ via: "tailscale" })] });
    expect(row).toEqual({
      fp: "aaa-aaa-aaa-aaa", name: "Studio", addr: "192.168.1.5",
      kind: "declined", state: "you said no", tone: "idle", here: false,
      hint: "Studio asked and was turned away. It is not asking any more.",
    });
    expect(Object.hasOwn(row, "via")).toBe(false);
  });
});

describe("named, tailnet and roundWords, the three rules every kind shares", () => {
  it("named: draws the alias, keeps the deck's own name as self, and adds self only when they differ", () => {
    const aliases = { "aaa-aaa-aaa-aaa": "Office Mac", "bbb-bbb-bbb-bbb": "MacBook" };
    for (const s of [
      { pending: [stranger()], aliases },
      { strangers: [stranger()], aliases },
      { declined: [stranger()], aliases },
    ]) {
      const row = one(s);
      expect(row.name).toBe("Office Mac");
      expect(row.self).toBe("Studio");
      expect(Object.keys(row).slice(0, 4)).toEqual(["fp", "name", "self", "addr"]);
      expect(row.hint.startsWith("Office Mac ")).toBe(true);
    }
    const renamed = one({ peers: [peer({ fp: "ccc-ccc-ccc-ccc", peerFp: "aaa-aaa-aaa-aaa" })], aliases });
    expect([renamed.name, renamed.self]).toEqual(["Office Mac", "MacBook"]);
    // An alias that says what the deck already calls itself is no alias.
    const same = one({ peers: [peer()], aliases });
    expect(same.name).toBe("MacBook");
    expect(Object.hasOwn(same, "self")).toBe(false);
    // A typed address that has not answered takes no alias: there is nobody to name.
    const bare = one({ peers: [typed({ paired: true, peerFp: "aaa-aaa-aaa-aaa" })], aliases });
    expect(bare.name).toBe("10.0.0.9:4319");
    expect(Object.hasOwn(bare, "self")).toBe(false);
  });

  it("tailnet: gives a row `via` only for the tailnet, since absent means the local network", () => {
    for (const via of [undefined, "lan"] as const) {
      for (const row of [
        one({ pending: [stranger({ via })] }),
        one({ peers: [typed({ via })] }),
        one({ peers: [peer({ via })] }),
        one({ strangers: [stranger({ via })] }),
      ]) expect(Object.hasOwn(row, "via"), `${row.kind} via ${via}`).toBe(false);
    }
    for (const row of [
      one({ pending: [stranger({ via: "tailscale" })] }),
      one({ peers: [typed({ via: "tailscale" })] }),
      one({ peers: [peer({ via: "tailscale" })] }),
      one({ strangers: [stranger({ via: "tailscale" })] }),
    ]) expect(row.via, row.kind).toBe("tailscale");
  });

  it("roundWords: keeps what a round says before its first ` · ` and nothing after", () => {
    // A partial round names both problems before the clock, and the row keeps
    // both; offline, the presence clause goes where the clock was.
    const last = { at: NOW - 60 * MIN, done: [
      { email: "a@b.c", action: "heal", ok: true, why: null },
      { email: "s@b.c", action: "heal", ok: false, why: "keychain_unavailable" },
    ] };
    expect(one({ peers: [typed({ last })] }).state).toBe("1 of 2 logins arrived, Keychain locked on the other Mac");
    expect(one({ peers: [peer({ last, lastSeen: NOW - 60 * MIN })] }).state)
      .toBe("1 of 2 logins arrived, Keychain locked on the other Mac · last online 1h ago");
    expect(one({ peers: [peer({ last: { ...last, at: NOW - 5_000 } })] }).state)
      .toBe("online · 1 of 2 logins arrived, Keychain locked on the other Mac");
  });
});
