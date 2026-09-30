// #1846: the check lan-sealed-frames-810.test.ts makes of every line two decks
// send after the handshake — that nothing on it can be read — failed now and
// then with nothing read at all. It searched the raw line, and the raw line is
// mostly base64: a four-letter word from its list turns up in random base64
// about once per 64^4 places, which over one round's ciphertext is once in a
// few thousand runs.
//
// So the check is driven here on its own, with lines built for it. The first
// case is the flake itself, made deterministic: a genuine sealed frame — a real
// channel, a fixed key, so AES-GCM hands back the same bytes every run — whose
// ciphertext happens to spell "have". The key was found by counting up until
// one did. The rest hold the other side down, so the check cannot pass by
// having stopped looking: a frame sent in the clear, a plain field beside a
// seal, a seal that is only base64, and one that is not even that.
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
// @ts-expect-error — plain .mjs server module, no types
import * as sync from "../../server/lan-sync.mjs";
import { readableOnWire } from "./lan-wire-readable";

const K = (email: string, org: string): string => sync.accountKey(email, org);

/** The list lan-sealed-frames-810.test.ts checks a round against. */
const SECRETS = [
  "claude1@sapec.md", "claude2@sapec.md", "claude3@sapec.md", "org-1", "org-2", "org-3",
  "manifest", "want", "have", "accounts", "current", "ccdeck2:slot",
];

/** Both ends of one connection under a fixed key: the same frame seals to the
 *  same bytes on every run, because each frame's nonce is its number. */
function channel(seed: string) {
  const key = createHash("sha256").update(`lan-sealed-readable-1846|${seed}`).digest();
  return { caller: sync.frameChannel(key, "caller"), listener: sync.frameChannel(key, "listener") };
}

const WANT = { t: "want", key: K("claude2@sapec.md", "org-2") };

describe("a sealed frame whose ciphertext happens to spell a word", () => {
  it("is not read as that word", () => {
    const { caller, listener } = channel("91211");
    const frame = caller.wrap(WANT);
    // The flake's own shape, or this case proves nothing.
    expect(frame.sealed, "this key no longer seals to a ciphertext that spells the word").toContain("have");
    // And it is a genuine frame: the other end opens it to what was sent.
    expect(listener.unwrap(frame)).toEqual(WANT);

    expect(readableOnWire([JSON.stringify(frame)], SECRETS)).toEqual([]);
  });
});

describe("what the check still reads", () => {
  it("a frame sent in the clear", () => {
    const found = readableOnWire([JSON.stringify(WANT)], SECRETS);
    expect(found.join("\n")).toMatch(/want/);
    expect(found.join("\n")).toMatch(/claude2@sapec\.md/);
  });

  it("a plain field beside the seal", () => {
    const { caller } = channel("beside");
    const found = readableOnWire([JSON.stringify({ ...caller.wrap({ t: "x" }), t: "have" })], SECRETS);
    expect(found.join("\n")).toMatch(/have/);
  });

  it("a frame sent in a base64 coat rather than sealed", () => {
    // Nothing on the raw line spells a secret — base64 of the frame is not the
    // frame — which is why the check decodes what it is handed.
    const coat = Buffer.from(JSON.stringify(WANT), "utf8").toString("base64");
    const line = JSON.stringify({ sealed: coat, tag: Buffer.alloc(16, 7).toString("base64") });
    for (const s of SECRETS) expect(line, "the coat spelled a secret on its own").not.toContain(s);
    expect(readableOnWire([line], SECRETS).join("\n")).toMatch(/want/);
  });

  it("a sealed value that is not base64 at all", () => {
    const line = JSON.stringify({ sealed: "I have it", tag: Buffer.alloc(16, 7).toString("base64") });
    expect(readableOnWire([line], SECRETS)).not.toEqual([]);
  });

  it("a line that is not a frame", () => {
    expect(readableOnWire(["want this"], SECRETS)).not.toEqual([]);
  });
});
