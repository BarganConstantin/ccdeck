// The wire two decks speak, pinned to the byte.
//
// lan-sync.test.ts proves what each piece of the channel refuses and why, and
// lan-sealed-frames-810.test.ts and lan-forward-secrecy-1120.test.ts prove the
// handshake and the sealed frames end to end, through lan-sync.mjs, which
// re-exports all of lan-wire.mjs. Every one of those cases makes fresh keys,
// so none of them would notice a label, a field order or a nonce layout
// changing on both ends at once — which is exactly what a deck of the next
// version would then fail to talk to. So these are known answers: fixed keys
// and fixed nonces in, and the bytes the deck produced before lan-wire.mjs was
// lifted out of lan-sync.mjs out. A change to any of them is a change to the
// protocol, and belongs with a PROTOCOL bump rather than in a refactor.
import { describe, it, expect } from "vitest";
import { createPrivateKey, createPublicKey } from "node:crypto";
// @ts-expect-error — plain .mjs server module, no types
import * as wire from "../../server/lan-wire.mjs";
// @ts-expect-error — plain .mjs server module, no types
import * as sync from "../../server/lan-sync.mjs";

/** An X25519 private key in the PKCS#8 DER a deck keeps in prefs.json, made
 *  from 32 copies of one byte: fixed, and plainly not anybody's. */
const PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");
const der = (byte: number) => Buffer.concat([PKCS8, Buffer.alloc(32, byte)]);
const eph = (byte: number) => createPrivateKey({ key: der(byte), format: "der", type: "pkcs8" });
const pubOf = (k: ReturnType<typeof eph>) => createPublicKey(k).export({ type: "spki", format: "der" }).toString("base64");
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const A = wire.identityFrom(der(1).toString("base64"));
const B = wire.identityFrom(der(2).toString("base64"));
const TRANSCRIPT = wire.handshakeTranscript(A.fp, B.fp, "aa.seal1", "bb.seal1");
const K = wire.sessionKey(A.secret, B.pub, TRANSCRIPT);

describe("a deck's key and the name it goes by", () => {
  it("is the same fingerprint and public key for the same secret", () => {
    expect(A).toMatchObject({ fp: "c75-efc-246-e00", pub: "MCowBQYDK2VuAyEApOCSkrZRwni5dyxWn1+puxPZBrRqtoyd+dwrRAn4ogk=", fresh: false });
    expect(B).toMatchObject({ fp: "5a2-553-587-5f5", pub: "MCowBQYDK2VuAyEAzo060cy2M+x7cMF4FKXHbs0CloUFDTRHRboFhw5YfVk=", fresh: false });
  });
});

describe("the key for one connection", () => {
  it("is the same key from the same transcript, at both ends", () => {
    expect(hex(K)).toBe("7843bc9101dbebfcd0de6f9ecd25e4459534baf6b4ff81b0ac8ea6d948b262b0");
    expect(hex(wire.sessionKey(B.secret, A.pub, TRANSCRIPT))).toBe(hex(K));
  });

  it("is the same key with a key pair made for the connection mixed in, at both ends", () => {
    const t = wire.handshakeTranscript(A.fp, B.fp, "aa.seal1", "bb.seal1", pubOf(eph(3)), pubOf(eph(4)));
    const caller = wire.sessionKey(A.secret, B.pub, t, { role: "caller", priv: eph(3), peer: pubOf(eph(4)) });
    const listener = wire.sessionKey(B.secret, A.pub, t, { role: "listener", priv: eph(4), peer: pubOf(eph(3)) });
    expect(hex(caller)).toBe("3507112e7ba81fe7b0521d477959b3df50bf1b5eae4e302cc9aa47f357ac8298");
    expect(hex(listener)).toBe(hex(caller));
  });
});

describe("the proofs made over it", () => {
  it("is the same proof of the key, and the same challenge for a login", () => {
    expect(wire.proof(K, { challenge: "aa.seal1", peerChallenge: "bb.seal1", fromFp: A.fp, toFp: B.fp, direction: "hello" }))
      .toBe("4b180a7f6ddd2967bb3cc4f0998d88dcfe8398f484b7ca666ef396ae0a566335");
    expect(wire.transferChallenge(K, { nonce: "00ff", accountKey: "a@x@@org", fromFp: A.fp, toFp: B.fp }))
      .toBe("99988b7baad69ea422cbc0e57b876aa0459991d64b13ee1fcba1d25f4f08b99c");
  });
});

describe("the seals", () => {
  it("seals a login under the same additional data to the same bytes", () => {
    const aad = wire.credentialAad(A.fp, B.fp, "a@x@@org");
    const sealed = wire.seal(K, "blob", aad, Buffer.alloc(12, 9));
    expect(sealed).toEqual({ iv: "CQkJCQkJCQkJCQkJ", tag: "U5wnTX+uDandKmNPaN7bag==", body: "c+rmDA==" });
    expect(wire.open(K, sealed, aad)).toBe("blob");
  });

  it("derives the same key and IV for each direction, and seals the first frames to the same bytes", () => {
    const keys = wire.frameKeys(K);
    expect([hex(keys.caller.key), hex(keys.caller.iv)])
      .toEqual(["4b4a866d7a05e38e017bc9ae1a52352ad9d8df23e53fee1a178aa76596631695", "c605fc874a41f0066a554581"]);
    expect([hex(keys.listener.key), hex(keys.listener.iv)])
      .toEqual(["011d0443287dc90717ff6dfde99c59168a160cb7f30b9a0fd4639403da8dc1ba", "1f1e5110116d1037b63711ab"]);
    const out = wire.frameChannel(K, "caller");
    const frames = [out.wrap({ t: "manifest" }), out.wrap({ t: "want", key: "a@x@@org" })];
    expect(frames).toEqual([
      { sealed: "Cw9YTfAupUXfp4SMeUYeQg==", tag: "BhDp5Ht8rbMcksPwl1Njhg==" },
      { sealed: "NFN6zRwg7g7IDEYfVbDQTxjAK2aGFV0f66KGUXA=", tag: "HxMKaaWS60G6C0zQ+R0SvA==" },
    ]);
    const back = wire.frameChannel(K, "listener");
    expect(frames.map(f => back.unwrap(f))).toEqual([{ t: "manifest" }, { t: "want", key: "a@x@@org" }]);
  });
});

describe("lan-sync.mjs", () => {
  it("hands out these functions and values, not copies of them", () => {
    for (const name of Object.keys(wire)) {
      expect(sync[name], name).toBe(wire[name]);
    }
  });
});
