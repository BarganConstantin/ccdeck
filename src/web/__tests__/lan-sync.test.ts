// The rules for finding other decks on this network, and for deciding whose
// copy of an account wins.
//
// EVERY DECISION IN THIS FEATURE IS PURE, and this file is why. There is one
// machine here. A design whose correctness lives inside a socket callback is a
// design nobody can check until it is running on two laptops on somebody's
// office wifi, which is the worst possible place to find out that the wrong
// copy overwrote the right one. So lan-sync.mjs holds the decisions and
// lan-socket.mjs holds the plumbing, and this covers the decisions completely.
//
// The cases below are grouped by what would go wrong. Not by function, which is
// how a test file ends up with ninety assertions and no argument: the headings
// are failures, and each case is the failure it exists to prevent.
import { describe, it, expect } from "vitest";
import { createHash, randomBytes } from "node:crypto";
// @ts-expect-error — plain .mjs server module, no types
import {
  accountKey, beaconPayload, beaconVerdict, cleanName, fingerprint, groupKey, groupTag,
  isPresent, manifestFor, notePeer, open, peerRows, plan, proof, proofOk, readBeacon,
  seal, stillListed, suggestPassphrase, syncAction, transferChallenge,
  ANNOUNCE_MS, FORGET_MS, MAGIC, MAX_BEACON_BYTES, MAX_NAME, PRESENT_MS, PROTOCOL, WORDS,
} from "../../server/lan-sync.mjs";

const KEY = groupKey("amber-canyon-forty-drift");
const TAG = groupTag(KEY);
const FP = fingerprint(Buffer.from("this deck"));
const OTHER = fingerprint(Buffer.from("that deck"));

const beacon = (over: Record<string, unknown> = {}) => Buffer.from(JSON.stringify({
  ...beaconPayload({ name: "MacBook", fp: OTHER, port: 4319, group: TAG, instance: "0badc0de" }),
  ...over,
}));

describe("what a stranger on the same wifi learns", () => {
  // The beacon is the one packet anybody can receive, so its contents ARE the
  // exposure. Every field is enumerated rather than spot-checked: a field added
  // later without thinking is exactly how an email ends up being broadcast.
  it("says a deck is here, and nothing about what is on it", () => {
    const p = beaconPayload({ name: "MacBook", fp: FP, port: 4319, group: TAG, instance: "0badc0de" });
    expect(Object.keys(p).sort()).toEqual(["f", "g", "i", "m", "n", "p", "v"]);
    const wire = JSON.stringify(p);
    for (const secret of ["amber-canyon-forty-drift", "@", "claude", "sapec", "refresh", "oauth"]) {
      expect(wire, `the beacon carries ${secret}`).not.toContain(secret);
    }
  });

  it("does not carry the passphrase, nor anything reversible to it in one step", () => {
    // `g` IS derived from the passphrase and that is the point of it — what has
    // to hold is that the derivation is the expensive one, so the tag is worth
    // no more to a listener than a scrypt grind.
    const p = beaconPayload({ name: "x", fp: FP, port: 1, group: TAG, instance: "aa" });
    expect(p.g).toBe(TAG);
    expect(p.g).not.toBe(KEY.toString("hex"));
    // A plain hash of the passphrase would be a different value; if these ever
    // matched, the tag had become a cheap oracle.
    expect(p.g).not.toBe(createHash("sha256").update("amber-canyon-forty-drift").digest("hex").slice(0, 16));
  });

  it("stays small enough that a beacon is never worth fragmenting", () => {
    const long = beaconPayload({ name: "x".repeat(200), fp: FP, port: 65_535, group: TAG, instance: "f".repeat(32) });
    expect(JSON.stringify(long).length).toBeLessThan(MAX_BEACON_BYTES);
  });
});

describe("a packet built to be expensive, or to be a lie", () => {
  // KDE Connect's CVE-2020-26164 was in the daemon rather than the protocol.
  // The reading order — length, then shape, then parse, then fields — is what
  // this group pins, one refusal at a time.
  it("refuses on size before it parses anything", () => {
    const huge = Buffer.alloc(MAX_BEACON_BYTES + 1, 0x7b);
    expect(readBeacon(huge)).toBeNull();
    expect(readBeacon(Buffer.alloc(0))).toBeNull();
  });

  it("refuses anything that is not even shaped like our packet", () => {
    expect(readBeacon(Buffer.from("hello"))).toBeNull();
    expect(readBeacon(Buffer.from("[1,2,3]"))).toBeNull();
    expect(readBeacon(Buffer.from("{not json"))).toBeNull();
  });

  it("refuses another protocol's packet that happens to be JSON", () => {
    expect(readBeacon(beacon({ m: "OTHR" }))).toBeNull();
    expect(readBeacon(beacon({ m: undefined }))).toBeNull();
  });

  it("refuses a version it cannot read, rather than guessing at it", () => {
    expect(readBeacon(beacon({ v: PROTOCOL + 1 }))).toBeNull();
    expect(readBeacon(beacon({ v: "1" }))).toBeNull();
  });

  it("refuses a port that is not one", () => {
    for (const p of [0, -1, 70_000, 1.5, "4319", null]) {
      expect(readBeacon(beacon({ p })), `port ${p}`).toBeNull();
    }
  });

  it("refuses a fingerprint or a tag that is the wrong shape", () => {
    // Shape-checked because both are used as map keys and as hex buffers; a
    // field that reaches Buffer.from with the wrong length is a throw in a
    // packet handler, which is a crash rather than a refusal.
    for (const f of ["", "zzz-816-bf8-f01", "ba7816bf8f01", "ba7-816-bf8", 42]) {
      expect(readBeacon(beacon({ f })), `fp ${f}`).toBeNull();
    }
    for (const g of ["", "4393c0ee3690c4f", "4393c0ee3690c4f1f", "ZZ93c0ee3690c4f1"]) {
      expect(readBeacon(beacon({ g })), `tag ${g}`).toBeNull();
    }
  });

  it("takes a good packet, and hands back only fields it validated", () => {
    const got = readBeacon(beacon());
    expect(got).toEqual({ name: "MacBook", fp: OTHER, port: 4319, group: TAG, instance: "0badc0de" });
  });

  it("keeps a peer's name from being a lie about anything but itself", () => {
    // The name is text chosen by whoever is shouting. It reaches a terminal log
    // and a page, so an escape sequence in it is a cursor somebody else moves.
    const esc = String.fromCharCode(27);
    const got = readBeacon(beacon({ n: `evil${esc}[2Kdeck` }));
    expect(got.name).not.toContain(esc);
    expect(cleanName(`a${String.fromCharCode(0)}b`)).toBe("a b");
    // And it cannot pad itself into looking like several rows, or run off the
    // width of the panel.
    expect(cleanName("   spaced    out   ")).toBe("spaced out");
    expect([...cleanName("x".repeat(500))].length).toBe(MAX_NAME);
    // A deck that said nothing is named by what it cannot forge.
    expect(readBeacon(beacon({ n: "" })).name).toBe(OTHER);
    expect(readBeacon(beacon({ n: 5 })).name).toBe(OTHER);
  });
});

describe("who gets answered at all", () => {
  it("ignores its own shout, which it hears on every interface it owns", () => {
    // By fingerprint rather than by address: a deck hears itself on each
    // interface, and the address list changes when a VPN comes up.
    expect(beaconVerdict(readBeacon(beacon({ f: FP })), { selfFp: FP, selfGroup: TAG })).toBe("self");
  });

  it("tells its own packet from another deck wearing its name", () => {
    // The id is stored in prefs, so two decks sharing a config directory hold
    // the same one — and so does the second machine when somebody copies their
    // ~/.claude across, which people do. Both would file every one of the
    // other's beacons as "that is me" and be permanently invisible to each
    // other with nothing on screen to say why.
    //
    // `instance` is fresh per process, so our own packet carries the instance
    // we are running and another deck's cannot.
    const mine = readBeacon(beacon({ f: FP, i: "aaaaaaaa" }));
    expect(beaconVerdict(mine, { selfFp: FP, selfGroup: TAG, selfInstance: "aaaaaaaa" })).toBe("self");
    expect(beaconVerdict(mine, { selfFp: FP, selfGroup: TAG, selfInstance: "bbbbbbbb" })).toBe("id-clash");
  });

  it("still reads a bare self-check as self, for a caller with no instance", () => {
    // The parameter arrived later than the function; a caller that does not
    // pass one must keep the answer it had rather than start reporting a clash.
    expect(beaconVerdict(readBeacon(beacon({ f: FP })), { selfFp: FP, selfGroup: TAG })).toBe("self");
  });

  it("names a deck in another group as such, so a mistyped passphrase is legible", () => {
    const theirs = groupTag(groupKey("some-other-passphrase"));
    expect(beaconVerdict(readBeacon(beacon({ g: theirs })), { selfFp: FP, selfGroup: TAG })).toBe("other-group");
  });

  it("answers nobody at all while this deck has no passphrase", () => {
    expect(beaconVerdict(readBeacon(beacon()), { selfFp: FP, selfGroup: null })).toBe("no-group");
  });

  it("accepts a deck that holds the same passphrase", () => {
    expect(beaconVerdict(readBeacon(beacon()), { selfFp: FP, selfGroup: TAG })).toBe("peer");
    // Derived independently, the way the other machine would have derived it.
    expect(groupTag(groupKey("amber-canyon-forty-drift"))).toBe(TAG);
  });

  it("has nothing to say to an unreadable packet", () => {
    expect(beaconVerdict(null, { selfFp: FP, selfGroup: TAG })).toBe("unreadable");
  });
});

describe("the passphrase itself", () => {
  it("is expensive to guess, because it is the only gate", () => {
    // scrypt at these parameters, not a hash. The number is the whole defence:
    // a captured beacon plus a fast KDF is a weak passphrase falling in
    // seconds. Measured rather than asserted from the constants, so a
    // parameter quietly lowered fails here.
    const t0 = process.hrtime.bigint();
    groupKey("a-passphrase-to-time");
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    expect(ms, "the group key got cheap to derive").toBeGreaterThan(20);
  });

  it("gives two decks with the same passphrase the same key, and no others", () => {
    expect(groupKey("same").equals(groupKey("same"))).toBe(true);
    expect(groupKey("same").equals(groupKey("other"))).toBe(false);
    // Typed on two keyboards, one of which composed its accents differently.
    expect(groupKey("café-x").equals(groupKey("café-x"))).toBe(true);
  });

  it("treats no passphrase as no group rather than as an empty one", () => {
    for (const v of ["", null, undefined, 5]) expect(groupKey(v as string), String(v)).toBeNull();
  });

  it("suggests one that is worth suggesting", () => {
    const p = suggestPassphrase();
    expect(p.split("-")).toHaveLength(6);
    for (const w of p.split("-")) expect(WORDS).toContain(w);
    // 100 words, six of them: about 40 bits, which is only a defence because
    // the derivation above is slow. Both halves are needed and both are pinned.
    expect(WORDS.length).toBeGreaterThanOrEqual(100);
    expect(new Set(WORDS).size, "the word list repeats itself").toBe(WORDS.length);
  });

  it("picks its words evenly, so the suggestion is worth its bit count", () => {
    // `% WORDS.length` on a byte would make the first 56 words likelier than
    // the rest — a real bias in the one number here that is a security claim.
    const seen = new Map<string, number>();
    for (let i = 0; i < 400; i++) {
      for (const w of suggestPassphrase(6).split("-")) seen.set(w, (seen.get(w) ?? 0) + 1);
    }
    // 2400 draws over 100 words: ~24 each. A modulo bias would show as the
    // early words running well over and the late ones well under.
    const early = WORDS.slice(0, 28).reduce((n: number, w: string) => n + (seen.get(w) ?? 0), 0);
    const late = WORDS.slice(-28).reduce((n: number, w: string) => n + (seen.get(w) ?? 0), 0);
    expect(Math.abs(early - late) / (early + late)).toBeLessThan(0.2);
  });
});

describe("proving membership without spending it", () => {
  const ctx = { challenge: "aaaa", peerChallenge: "bbbb", fromFp: FP, toFp: OTHER, direction: "hello" };

  it("is worthless to anybody who recorded the last one", () => {
    const once = proof(KEY, ctx);
    const twice = proof(KEY, { ...ctx, challenge: "cccc" });
    expect(once).not.toBe(twice);
  });

  it("cannot be replayed in the other direction, or at a different peer", () => {
    const mine = proof(KEY, ctx);
    expect(proof(KEY, { ...ctx, direction: "reply" })).not.toBe(mine);
    expect(proof(KEY, { ...ctx, toFp: "some-oth-erd-eck" })).not.toBe(mine);
    expect(proof(KEY, { ...ctx, fromFp: "some-oth-erd-eck" })).not.toBe(mine);
    // Both challenges are in it, so half a recorded transcript is not enough.
    expect(proof(KEY, { ...ctx, peerChallenge: "zzzz" })).not.toBe(mine);
  });

  it("cannot be produced without the passphrase", () => {
    expect(proof(groupKey("wrong-one"), ctx)).not.toBe(proof(KEY, ctx));
  });

  it("compares without leaking how close a guess was", () => {
    const good = proof(KEY, ctx);
    expect(proofOk(good, good)).toBe(true);
    expect(proofOk(good, good.slice(0, -1) + "0")).toBe(false);
    // A length mismatch must be false rather than a throw: timingSafeEqual
    // throws on unequal lengths, and a throw in a packet handler is a crash
    // where a refusal was wanted.
    expect(proofOk(good, "")).toBe(false);
    expect(proofOk(good, good + "0")).toBe(false);
    expect(proofOk(good, undefined as unknown as string)).toBe(false);
  });

  it("asks again for the transfer itself, not only for the session", () => {
    // A session proves who connected, at the moment they connected. A
    // credential leaving the machine is a later question, and this is the
    // round trip that asks it — named for the account, so a proof for one is
    // not a proof for another.
    const a = transferChallenge(KEY, { nonce: "n1", accountKey: "a@@1", fromFp: FP, toFp: OTHER });
    expect(transferChallenge(KEY, { nonce: "n2", accountKey: "a@@1", fromFp: FP, toFp: OTHER })).not.toBe(a);
    expect(transferChallenge(KEY, { nonce: "n1", accountKey: "b@@1", fromFp: FP, toFp: OTHER })).not.toBe(a);
    expect(transferChallenge(KEY, { nonce: "n1", accountKey: "a@@1", fromFp: OTHER, toFp: FP })).not.toBe(a);
    // And it is a different construction from the session proof, so one can
    // never be presented as the other.
    expect(a).not.toBe(proof(KEY, { ...ctx, challenge: "n1" }));
  });
});

describe("the credential on the wire", () => {
  const aad = `${FP}->${OTHER}|claude@example.com@@org1`;

  it("comes back only to somebody holding the same passphrase", () => {
    const sealed = seal(KEY, "ccdeck2:pretend-blob", aad);
    expect(open(KEY, sealed, aad)).toBe("ccdeck2:pretend-blob");
    expect(open(groupKey("wrong-one"), sealed, aad)).toBeNull();
  });

  it("never puts the plaintext on the wire, even inside the group", () => {
    const sealed = seal(KEY, "ccdeck2:pretend-blob", aad);
    const wire = JSON.stringify(sealed);
    expect(wire).not.toContain("ccdeck2:");
    expect(wire).not.toContain("pretend-blob");
    // A fresh nonce per seal, or two credentials sealed under one key would
    // leak their relationship.
    expect(seal(KEY, "same", aad).iv).not.toBe(seal(KEY, "same", aad).iv);
  });

  it("cannot be replayed as if it were about a different account", () => {
    const sealed = seal(KEY, "ccdeck2:pretend-blob", aad);
    expect(open(KEY, sealed, `${FP}->${OTHER}|other@example.com@@org1`)).toBeNull();
    expect(open(KEY, sealed, `${OTHER}->${FP}|claude@example.com@@org1`)).toBeNull();
  });

  it("refuses a tampered body the same way it refuses a wrong key", () => {
    // One answer for every failure. A caller that could tell "wrong key" from
    // "bad tag" would be telling whoever is probing which half to work on.
    const sealed = seal(KEY, "ccdeck2:pretend-blob", aad);
    expect(open(KEY, { ...sealed, body: Buffer.from("nonsense").toString("base64") }, aad)).toBeNull();
    expect(open(KEY, { ...sealed, tag: Buffer.alloc(16).toString("base64") }, aad)).toBeNull();
    expect(open(KEY, { ...sealed, iv: Buffer.alloc(12).toString("base64") }, aad)).toBeNull();
    expect(open(KEY, { iv: "!", tag: "!", body: "!" }, aad)).toBeNull();
  });
});

describe("whose copy of an account wins", () => {
  // Two outcomes, and neither overwrites something that works. A third —
  // "replace", take a peer's copy when it is newer — was designed and dropped:
  // measuring "newer" needs the OAuth payload's expiresAt, which means the deck
  // opening a credential it does not own, and on macOS reading a Keychain a
  // background process cannot reliably reach. What settled it is that a working
  // credential replaced by a newer working credential changes nothing today.
  const live = { key: "a@@1", email: "a@x", alive: true };
  const dead = { key: "a@@1", email: "a@x", alive: false };

  it("adds an account this deck has never had", () => {
    expect(syncAction(null, live)).toBe("add");
  });

  it("heals one this machine has PROVEN is dead", () => {
    // "Dead" is claude-swap's quarantine — an invalid_grant from Anthropic,
    // counted, not a guess from an expiry field. A plain import replaces
    // exactly this case, so no --force is involved.
    expect(syncAction(dead, live)).toBe("heal");
  });

  it("never touches a credential that works", () => {
    // The whole safety property, and it is claude-swap's rather than ours: a
    // plain import skips an account that is present and healthy. Nothing here
    // ever asks for anything else, so a peer cannot overwrite a working
    // credential even by lying about its own.
    expect(syncAction(live, live)).toBeNull();
  });

  it("refuses a dead copy even when mine is dead too", () => {
    // Replacing a broken credential with another broken one is churn that
    // looks like repair, and it clears a quarantine that was telling the truth.
    expect(syncAction(dead, dead)).toBeNull();
    expect(syncAction(live, dead)).toBeNull();
    expect(syncAction(null, dead)).toBeNull();
  });

  it("asks for nothing when the peer offers nothing", () => {
    expect(syncAction(dead, null)).toBeNull();
    expect(syncAction(null, undefined)).toBeNull();
  });

  it("never asks for the one import flag that could overwrite my work", () => {
    // Stated as an invariant over every combination rather than as three cases,
    // because the danger is a fourth outcome being added later without anybody
    // noticing it needs --force.
    const states = [null, live, dead];
    for (const mine of states) {
      for (const theirs of states) {
        expect(["add", "heal", null]).toContain(syncAction(mine, theirs));
      }
    }
  });

  it("plans the same work in the same order on both machines", () => {
    // A failure halfway through is then repeatable rather than a different half
    // each time.
    const localSide = [
      { key: "a@@1", email: "a@x", alive: true },
      { key: "b@@1", email: "b@x", alive: false },
    ];
    const remote = [
      { key: "c@@1", email: "c@x", alive: true },
      { key: "b@@1", email: "b@x", alive: true },
      { key: "a@@1", email: "a@x", alive: true },
    ];
    expect(plan(localSide, remote)).toEqual([
      { key: "b@@1", email: "b@x", action: "heal" },
      { key: "c@@1", email: "c@x", action: "add" },
    ]);
    expect(plan(localSide, [...remote].reverse())).toEqual(plan(localSide, remote));
  });

  it("has nothing to do when both stores already agree", () => {
    const both = [{ key: "a@@1", email: "a@x", alive: true }];
    expect(plan(both, both)).toEqual([]);
  });
});

describe("which account is which", () => {
  it("is the email and the org, never the slot number", () => {
    // claude-swap assigns slots max+1 per store, so the account that is 4 here
    // is 2 there. Anything keyed on the number swaps the wrong pair the first
    // time two stores grew in a different order.
    expect(accountKey("A@X.com", "org-1")).toBe(accountKey("a@x.com", "org-1"));
    expect(accountKey("a@x.com", "org-1")).not.toBe(accountKey("a@x.com", "org-2"));
    expect(accountKey(" a@x.com ", "org-1")).toBe(accountKey("a@x.com", "org-1"));
  });

  it("survives a missing org rather than colliding on one", () => {
    expect(accountKey("a@x.com", null)).not.toBe(accountKey("a@x.com", "org-1"));
    expect(accountKey("a@x.com", undefined)).toBe(accountKey("a@x.com", null));
  });
});

describe("what the group is told about my accounts", () => {
  const accounts = [
    { key: "a@@1", email: "a@x", alive: true },
    { key: "b@@1", email: "b@x", alive: false },
    { key: "c@@1", email: "c@x", alive: true },
  ];

  it("carries only what the user ticked", () => {
    const m = manifestFor(accounts, ["a@@1", "c@@1"]);
    expect(m.map((a: { key: string }) => a.key)).toEqual(["a@@1", "c@@1"]);
  });

  it("does not mention that a withheld account exists", () => {
    // Listing it as withheld would tell the group an account is being kept
    // back, and that is itself the fact being kept back.
    const wire = JSON.stringify(manifestFor(accounts, ["a@@1"]));
    expect(wire).not.toContain("b@x");
    expect(wire).not.toContain("b@@1");
  });

  it("is empty when nothing is shared, rather than absent", () => {
    expect(manifestFor(accounts, [])).toEqual([]);
  });

  it("says whether this machine can actually use each one", () => {
    // An account this deck cannot use is worth nothing to a peer, and saying so
    // plainly is what stops a peer asking for it.
    const [a] = manifestFor(accounts, ["a@@1"]);
    expect(Object.keys(a).sort()).toEqual(["alive", "email", "key"]);
    expect(manifestFor(accounts, ["b@@1"])[0].alive).toBe(false);
  });

  it("carries nothing about the credential itself", () => {
    // Not the expiry, not a fingerprint of the token, not a slot number. A
    // manifest is a list of what exists and whether it works.
    const wire = JSON.stringify(manifestFor(accounts, ["a@@1", "b@@1", "c@@1"]));
    for (const leak of ["expiresAt", "refresh", "token", "num", "slot"]) {
      expect(wire, `the manifest carries ${leak}`).not.toContain(leak);
    }
  });
});

describe("the list of decks, which outlives their being on", () => {
  const now = 1_800_000_000_000;
  const b = { fp: OTHER, name: "MacBook", port: 4319, group: TAG, instance: "0badc0de" };

  it("remembers a deck that went away rather than dropping it", () => {
    // The list answers "who is in my group", and that does not change when a
    // laptop closes. Presence is a field on the row, not membership in it.
    const peers = new Map();
    notePeer(peers, b, "192.168.1.5", now);
    const later = now + PRESENT_MS + 1;
    expect(peers.size).toBe(1);
    expect(isPresent(peers.get(OTHER), later)).toBe(false);
    expect(peerRows(peers, later)[0].name).toBe("MacBook");
  });

  it("survives two lost packets without flickering out of the list", () => {
    const peers = new Map();
    notePeer(peers, b, "192.168.1.5", now);
    expect(isPresent(peers.get(OTHER), now + ANNOUNCE_MS * 2)).toBe(true);
    expect(PRESENT_MS).toBeGreaterThan(ANNOUNCE_MS * 2);
  });

  it("says nothing changed when a beacon repeats, which is most of them", () => {
    // One per peer every thirty seconds, forever. A "changed" that was always
    // true would be a render and a write on every one of them.
    const peers = new Map();
    expect(notePeer(peers, b, "192.168.1.5", now).changed).toBe(true);
    expect(notePeer(peers, b, "192.168.1.5", now + ANNOUNCE_MS).changed).toBe(false);
    expect(peers.get(OTHER).lastSeen).toBe(now + ANNOUNCE_MS);
  });

  it("notices a move, a rename and a restart, because each means something", () => {
    const peers = new Map();
    notePeer(peers, b, "192.168.1.5", now);
    expect(notePeer(peers, { ...b, name: "Desktop" }, "192.168.1.5", now).changed).toBe(true);
    expect(peers.get(OTHER).prevName, "a renamed deck reads as a new one").toBe("MacBook");
    expect(notePeer(peers, { ...b, name: "Desktop" }, "192.168.1.9", now).changed).toBe(true);
    const r = notePeer(peers, { ...b, name: "Desktop", instance: "feedface" }, "192.168.1.9", now);
    expect(r.restarted, "a restarted deck kept its session state").toBe(true);
  });

  it("holds still, so a row can be pointed at", () => {
    // Present decks first, then by name — NOT by last-seen, which would
    // reorder the list every thirty seconds as packets land in whatever order
    // the network delivers them.
    const peers = new Map();
    notePeer(peers, { ...b, fp: "aaa-aaa-aaa-aaa", name: "Zed" }, "1.1.1.1", now);
    notePeer(peers, { ...b, fp: "bbb-bbb-bbb-bbb", name: "Alpha" }, "1.1.1.2", now);
    notePeer(peers, { ...b, fp: "ccc-ccc-ccc-ccc", name: "Beta" }, "1.1.1.3", now - PRESENT_MS - 1);
    expect(peerRows(peers, now).map((p: { name: string }) => p.name)).toEqual(["Alpha", "Zed", "Beta"]);
    // And again with the map built in the other order.
    const flipped = new Map([...peers.entries()].reverse());
    expect(peerRows(flipped, now).map((p: { name: string }) => p.name)).toEqual(["Alpha", "Zed", "Beta"]);
  });

  it("forgets a deck nobody has heard from since yesterday", () => {
    // Without this the list is a graveyard, and that was measured rather than
    // imagined: on a machine where decks had been restarted a few times, every
    // peer's list held a row per restart, each reporting ECONNREFUSED once a
    // minute against a port nothing had listened on for an hour.
    const heard = { fp: OTHER, lastSeen: now };
    expect(stillListed(heard, now)).toBe(true);
    // Still listed the same evening, with the time beside it — the list answers
    // "who is in my group", and that does not change when a laptop closes.
    expect(stillListed(heard, now + 8 * 60 * 60_000)).toBe(true);
    expect(stillListed(heard, now + FORGET_MS - 1)).toBe(true);
    expect(stillListed(heard, now + FORGET_MS)).toBe(false);
    expect(stillListed(heard, now + 30 * FORGET_MS)).toBe(false);
  });

  it("never forgets an address somebody typed", () => {
    // The whole reason this is a rule rather than a comparison at the call
    // site: a typed address is a decision the user made, and a deck that has
    // been off for a week is exactly the case they typed it for.
    const typed = { fp: "manual:1.2.3.4:5", manual: true, lastSeen: null };
    expect(stillListed(typed, now)).toBe(true);
    expect(stillListed(typed, now + 100 * FORGET_MS)).toBe(true);
  });

  it("does not list a peer that has never been heard at all", () => {
    expect(stillListed({ fp: OTHER, lastSeen: null }, now)).toBe(false);
    expect(stillListed(null, now)).toBe(false);
    expect(stillListed(undefined, now)).toBe(false);
  });

  it("keeps a hand-typed peer hand-typed once a beacon finds it", () => {
    // Otherwise removing it from the list would not remove the address the
    // user typed, and it would come back on the next packet.
    const peers = new Map([[OTHER, { fp: OTHER, name: "x", manual: true, firstSeen: now }]]);
    notePeer(peers, b, "192.168.1.5", now);
    expect(peers.get(OTHER).manual).toBe(true);
    expect(peers.get(OTHER).firstSeen).toBe(now);
  });
});

describe("the fingerprint a person is asked to compare", () => {
  it("is short enough to read out and stable across restarts", () => {
    const key = randomBytes(32);
    expect(fingerprint(key)).toBe(fingerprint(key));
    expect(fingerprint(key)).toMatch(/^[0-9a-f]{3}(-[0-9a-f]{3}){3}$/);
    expect(fingerprint(randomBytes(32))).not.toBe(fingerprint(key));
  });

  it("is the key's hash, so a deck cannot claim another's without its key", () => {
    const key = randomBytes(32);
    const expected = createHash("sha256").update(key).digest("hex").slice(0, 12);
    expect(fingerprint(key).replace(/-/g, "")).toBe(expected);
  });
});

describe("the packet says which protocol it is", () => {
  it("is marked so a stray packet on the port is recognisable as somebody else's", () => {
    expect(MAGIC).toBe("CCDK");
    expect(beaconPayload({ name: "x", fp: FP, port: 1, group: TAG, instance: "aa" }).m).toBe(MAGIC);
  });
});
