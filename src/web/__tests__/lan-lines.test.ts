// The line both ends of a connection speak, driven on the module that now owns
// it, with no socket.
//
// lan-socket.test.ts proves what the reader does with chunks — several frames
// in one, one split across two, a buffer grown past the cap, a line that is
// not a record — and lan-refusal-ends-the-connection.test.ts what a throwing
// handler does to a live listener. What is pinned here is the rest of the
// contract both halves lean on: the cap is a manifest's, the writer puts the
// newline the reader waits for and never throws, the reader hands a throwing
// handler's error on with its refusal and reads nothing after, and lan-socket
// hands out these very functions.
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs server module, no types
import * as lines from "../../server/lan-lines.mjs";
// @ts-expect-error — plain .mjs server module, no types
import * as socket from "../../server/lan-socket.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { MAX_MANIFEST_BYTES } from "../../server/lan-sync.mjs";

const { frameReader, sendFrame, MAX_FRAME_BYTES } = lines;

describe("the bounds on a line", () => {
  it("lets a frame be as large as the largest manifest, and no larger", () => {
    expect(MAX_FRAME_BYTES).toBe(MAX_MANIFEST_BYTES);
    const refusals: string[] = [];
    const read = frameReader(() => {}, (why: string) => refusals.push(why));
    read("x".repeat(MAX_FRAME_BYTES));
    expect(refusals).toEqual([]);
    read("x");
    expect(refusals).toEqual(["frame too large"]);
  });

  it("takes a smaller cap when it is handed one", () => {
    const refusals: string[] = [];
    frameReader(() => {}, (why: string) => refusals.push(why), 8)("123456789");
    expect(refusals).toEqual(["frame too large"]);
  });
});

describe("a line out", () => {
  it("is the frame as JSON and the newline the reader is waiting for", () => {
    const written: string[] = [];
    sendFrame({ write: (s: string) => written.push(s) }, { t: "hello", n: 1 });
    expect(written).toEqual(['{"t":"hello","n":1}\n']);
    const frames: unknown[] = [];
    frameReader((f: unknown) => frames.push(f), () => {})(written.join(""));
    expect(frames).toEqual([{ t: "hello", n: 1 }]);
  });

  it("says nothing to a socket that has gone away", () => {
    expect(() => sendFrame({ write: () => { throw new Error("EPIPE"); } }, { t: "hello" })).not.toThrow();
  });
});

describe("a handler that throws", () => {
  it("ends the reader with the error as the refusal's cause, and nothing after it is read", () => {
    const seen: unknown[] = [];
    const refusals: Array<[string, unknown]> = [];
    const boom = new Error("boom");
    const read = frameReader((f: { t: string }) => {
      seen.push(f);
      if (f.t === "b") throw boom;
    }, (why: string, cause: unknown) => refusals.push([why, cause]));
    read('{"t":"a"}\n{"t":"b"}\n{"t":"c"}\n');
    read('{"t":"d"}\n');
    expect(seen).toEqual([{ t: "a" }, { t: "b" }]);
    expect(refusals).toEqual([["bad frame", boom]]);
  });
});

describe("lan-socket.mjs", () => {
  it("hands out these functions and values, not copies of them", () => {
    for (const name of Object.keys(lines)) {
      expect(socket[name], name).toBe(lines[name]);
    }
  });
});
