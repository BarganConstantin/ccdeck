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
  accountKey, addTrusted, beaconPayload, beaconVerdict, cleanName, dropTrusted, fingerprint,
  isPresent, manifestFor, notePeer, open, peerRows, plan, proof, proofOk, readBeacon,
  handshakeTranscript, identityFrom, readPub, seal, sessionKey, stillListed, syncAction,
  transferChallenge, trustedPeer,
  ANNOUNCE_MS, FORGET_MS, MAGIC, MAX_BEACON_BYTES, MAX_NAME, PRESENT_MS, PROTOCOL,
} from "../../server/lan-sync.mjs";

const A = identityFrom("");
const B = identityFrom("");
/** One connection's key, which is what everything below is keyed on now. There
 *  is no long-lived key any more: see sessionKey. */
const KEY = sessionKey(A.secret, B.pub, "test-transcript");
const FP = fingerprint(Buffer.from("this deck"));
const OTHER = fingerprint(Buffer.from("that deck"));

const beacon = (over: Record<string, unknown> = {}) => Buffer.from(JSON.stringify({
  ...beaconPayload({ name: "MacBook", fp: OTHER, port: 4319, instance: "0badc0de" }),
  ...over,
}));

describe("what a stranger on the same wifi learns", () => {
  // The beacon is the one packet anybody can receive, so its contents ARE the
  // exposure. Every field is enumerated rather than spot-checked: a field added
  // later without thinking is exactly how an email ends up being broadcast.
  it("says a deck is here, and nothing about what is on it", () => {
    const p = beaconPayload({ name: "MacBook", fp: FP, port: 4319, instance: "0badc0de" });
    expect(Object.keys(p).sort()).toEqual(["f", "i", "m", "n", "p", "v"]);
    const wire = JSON.stringify(p);
    for (const secret of ["amber-canyon-forty-drift", "@", "claude", "sapec", "refresh", "oauth"]) {
      expect(wire, `the beacon carries ${secret}`).not.toContain(secret);
    }
  });

  it("carries nothing derived from a secret at all any more", () => {
    // THE GROUP TAG IS GONE, and with it the last field in this packet that had
    // to be argued about. It was HMAC over a scrypt'd passphrase — defensible,
    // and the reason the derivation had to stay expensive. What is left is a
    // name, a port, and a hash of a PUBLIC key, none of which is worth grinding
    // because none of them is secret.
    const p = beaconPayload({ name: "x", fp: FP, port: 1, instance: "aa" });
    expect(p).not.toHaveProperty("g");
    const id = identityFrom("");
    // The fingerprint is a hash of the public half, so publishing it publishes
    // nothing the public half does not.
    expect(fingerprint(Buffer.from(id.pub, "base64"))).toBe(id.fp);
    expect(JSON.stringify(p)).not.toContain(id.secret);
  });

  it("stays small enough that a beacon is never worth fragmenting", () => {
    const long = beaconPayload({ name: "x".repeat(200), fp: FP, port: 65_535, instance: "f".repeat(32) });
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

  it("refuses a fingerprint that is the wrong shape, and ignores a field it does not know", () => {
    // Shape-checked because both are used as map keys and as hex buffers; a
    // field that reaches Buffer.from with the wrong length is a throw in a
    // packet handler, which is a crash rather than a refusal.
    for (const f of ["", "zzz-816-bf8-f01", "ba7816bf8f01", "ba7-816-bf8", 42]) {
      expect(readBeacon(beacon({ f })), `fp ${f}`).toBeNull();
    }
    // The tag it used to check here does not exist any more, and a field a
    // reader does not know is ignored rather than refused — that is what keeps
    // a deck a version behind discoverable. An UNKNOWN `g` must not be fatal.
    expect(readBeacon(beacon({ g: "ZZ93c0ee3690c4f1" })), "an unknown field").not.toBeNull();
  });

  it("takes a good packet, and hands back only fields it validated", () => {
    const got = readBeacon(beacon());
    expect(got).toEqual({ name: "MacBook", fp: OTHER, port: 4319, instance: "0badc0de" });
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
    expect(beaconVerdict(readBeacon(beacon({ f: FP })), { selfFp: FP })).toBe("self");
  });

  it("tells its own packet from another deck wearing its name", () => {
    // The key is stored in prefs, so two decks sharing a config directory hold
    // the same one — and so does the second machine when somebody copies their
    // ~/.claude across, which people do. Both would file every one of the
    // other's beacons as "that is me" and be permanently invisible to each
    // other with nothing on screen to say why.
    //
    // `instance` is fresh per process, so our own packet carries the instance
    // we are running and another deck's cannot.
    const mine = readBeacon(beacon({ f: FP, i: "aaaaaaaa" }));
    expect(beaconVerdict(mine, { selfFp: FP, selfInstance: "aaaaaaaa" })).toBe("self");
    expect(beaconVerdict(mine, { selfFp: FP, selfInstance: "bbbbbbbb" })).toBe("id-clash");
  });

  it("still reads a bare self-check as self, for a caller with no instance", () => {
    expect(beaconVerdict(readBeacon(beacon({ f: FP })), { selfFp: FP })).toBe("self");
  });

  it("calls a deck nobody has accepted a stranger, rather than dropping it", () => {
    // THE SHAPE OF THE WHOLE FEATURE CHANGED HERE. A group tag used to sort
    // strangers from peers before any handshake existed to attack, which is a
    // real property — and it only worked when two people held the same
    // passphrase, which is exactly what neither of them could check. A stranger
    // is a name and an address now: a row somebody accepts, or does not.
    expect(beaconVerdict(readBeacon(beacon()), { selfFp: FP, trusted: [] })).toBe("stranger");
    expect(beaconVerdict(readBeacon(beacon()), { selfFp: FP })).toBe("stranger");
  });

  it("calls a deck somebody accepted a peer", () => {
    const heard = readBeacon(beacon());
    expect(beaconVerdict(heard, { selfFp: FP, trusted: [{ fp: heard!.fp, pub: "x" }] })).toBe("peer");
  });

  it("has nothing to say to an unreadable packet", () => {
    expect(beaconVerdict(null, { selfFp: FP })).toBe("unreadable");
  });
});

describe("this deck's own key", () => {
  it("is the same deck after a restart, which is what a pin is worth", () => {
    const first = identityFrom("");
    expect(first.fresh).toBe(true);
    const again = identityFrom(first.secret);
    expect(again.fresh).toBe(false);
    expect(again.fp).toBe(first.fp);
    expect(again.pub).toBe(first.pub);
  });

  it("replaces a key it cannot use rather than refusing to start", () => {
    // A corrupt secret is not something anybody can act on mid-session, and
    // refusing to start would take the whole feature away over one bad string.
    // The cost is real and is stated where it happens: this deck gets a new
    // fingerprint, so every peer that pinned the old one asks again.
    for (const junk of ["", "not-base64-at-all!!", "aGVsbG8="]) {
      expect(identityFrom(junk).fresh, junk).toBe(true);
    }
  });

  it("is a fingerprint of the PUBLIC half, so a peer can check what it pinned", () => {
    const id = identityFrom("");
    expect(readPub(id.pub)?.fp).toBe(id.fp);
    expect(id.fp).toMatch(/^[0-9a-f]{3}(-[0-9a-f]{3}){3}$/);
  });

  it("refuses a public key that is not one, before anything tries to use it", () => {
    for (const junk of ["", "x", "!!!!", "a".repeat(200), null, 5]) {
      expect(readPub(junk as string), String(junk)).toBeNull();
    }
  });
});

describe("the key for one connection, and no other", () => {
  it("is the same on both sides and derived by neither of them alone", () => {
    const t = handshakeTranscript(A.fp, B.fp, "aaaa", "bbbb");
    expect(sessionKey(A.secret, B.pub, t).equals(sessionKey(B.secret, A.pub, t))).toBe(true);
  });

  it("is bound to the transcript, so a recording derives a different one", () => {
    const mine = sessionKey(A.secret, B.pub, handshakeTranscript(A.fp, B.fp, "aaaa", "bbbb"));
    const other = sessionKey(A.secret, B.pub, handshakeTranscript(A.fp, B.fp, "aaaa", "cccc"));
    expect(mine.equals(other)).toBe(false);
  });

  it("builds the transcript one way, whichever end is asking", () => {
    // Caller first, always. A transcript the two sides build differently is a
    // handshake that never agrees and a bug that only appears between two
    // machines.
    expect(handshakeTranscript("a", "b", "1", "2")).toBe("a|b|1|2");
    expect(handshakeTranscript("a", "b", "1", "2")).not.toBe(handshakeTranscript("b", "a", "2", "1"));
  });

  it("is 32 bytes, which is what AES-256-GCM below is expecting", () => {
    expect(sessionKey(A.secret, B.pub, "t")).toHaveLength(32);
  });

  it("gives a third deck nothing, holding only what travelled in the clear", () => {
    const C = identityFrom("");
    const t = handshakeTranscript(A.fp, B.fp, "aaaa", "bbbb");
    expect(sessionKey(C.secret, B.pub, t).equals(sessionKey(A.secret, B.pub, t))).toBe(false);
  });
});

describe("the decks somebody accepted", () => {
  it("keeps the public key, because a fingerprint alone cannot be checked later", () => {
    const { list, added } = addTrusted([], { fp: "aaa-bbb-ccc-ddd", pub: "PUB", name: "laptop" });
    expect(added).toBe(true);
    expect(trustedPeer(list, "aaa-bbb-ccc-ddd")).toEqual({ fp: "aaa-bbb-ccc-ddd", pub: "PUB", name: "laptop" });
  });

  it("never lets a pinned key change under us", () => {
    // A fingerprint we hold, presented with a different key, is not a peer
    // whose details changed. 48 bits is far past accident.
    const { list } = addTrusted([], { fp: "aaa-bbb-ccc-ddd", pub: "PUB", name: "laptop" });
    const again = addTrusted(list, { fp: "aaa-bbb-ccc-ddd", pub: "OTHER", name: "laptop" });
    expect(again.added).toBe(false);
    expect(trustedPeer(again.list, "aaa-bbb-ccc-ddd")?.pub).toBe("PUB");
  });

  it("does update the name, which is the peer's to change", () => {
    const { list } = addTrusted([], { fp: "aaa-bbb-ccc-ddd", pub: "PUB", name: "laptop" });
    const renamed = addTrusted(list, { fp: "aaa-bbb-ccc-ddd", pub: "PUB", name: "the laptop" });
    expect(renamed.added).toBe(false);
    expect(trustedPeer(renamed.list, "aaa-bbb-ccc-ddd")?.name).toBe("the laptop");
    expect(renamed.list).toHaveLength(1);
  });

  it("refuses an entry with no key at all", () => {
    expect(addTrusted([], { fp: "aaa-bbb-ccc-ddd" }).added).toBe(false);
    expect(addTrusted([], null).added).toBe(false);
  });

  it("takes one back out, which stops what has not happened yet and nothing else", () => {
    const { list } = addTrusted([], { fp: "aaa-bbb-ccc-ddd", pub: "PUB", name: "laptop" });
    expect(dropTrusted(list, "aaa-bbb-ccc-ddd")).toEqual([]);
    expect(dropTrusted(list, "nobody")).toHaveLength(1);
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
    expect(proof(sessionKey(B.secret, A.pub, "another-connection"), ctx)).not.toBe(proof(KEY, ctx));
  });

  it("compares without leaking how close a guess was", () => {
    const good = proof(KEY, ctx);
    expect(proofOk(good, good)).toBe(true);
    // Changed to a character it is NOT. `slice(0, -1) + "0"` rebuilds the same
    // string one time in sixteen, and the key here is derived from a keypair
    // made fresh per run — so that version passed on this machine and failed on
    // a CI runner, which is the worst possible way for a test to be wrong.
    const last = good.slice(-1);
    expect(proofOk(good, good.slice(0, -1) + (last === "0" ? "1" : "0"))).toBe(false);
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
    expect(open(sessionKey(B.secret, A.pub, "another-connection"), sealed, aad)).toBeNull();
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
  const b = { fp: OTHER, name: "MacBook", port: 4319, instance: "0badc0de" };

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
    expect(beaconPayload({ name: "x", fp: FP, port: 1, instance: "aa" }).m).toBe(MAGIC);
  });
});
