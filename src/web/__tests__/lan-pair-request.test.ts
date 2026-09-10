// Which pairing request gets put in front of somebody, and which one does not.
//
// The picking is the whole of the dialog's behaviour that can be reasoned about
// without a browser: one at a time, oldest first, and never one that was
// already waved away this session. Everything else in LanPairRequestModal is
// two buttons and a fingerprint.
import { describe, expect, it } from "vitest";
import { nextRequest } from "../components/LanPairRequestModal";
import type { LanStranger } from "../components/LanSyncSection";

const ask = (fp: string, at: number): LanStranger => ({ fp, name: `deck-${fp}`, addr: "192.168.1.9", port: 62259, at });

describe("nextRequest", () => {
  it("says nothing when nobody is asking", () => {
    expect(nextRequest([], new Set()).request).toBeNull();
    expect(nextRequest(null, new Set()).request).toBeNull();
    expect(nextRequest(undefined, new Set()).request).toBeNull();
  });

  it("puts the deck that has waited longest in front", () => {
    // Arrival order is not age order: the list comes off a map, and the one
    // whose owner has been staring at an empty roster the longest is the one
    // to answer first.
    const out = nextRequest([ask("bb", 3_000), ask("aa", 1_000), ask("cc", 2_000)], new Set());
    expect(out.request?.fp).toBe("aa");
    expect(out.waiting).toBe(2);
  });

  it("counts the queue rather than listing it", () => {
    expect(nextRequest([ask("aa", 1)], new Set()).waiting).toBe(0);
  });

  it("skips a request that was answered with Escape", () => {
    // "Later" is not "no": the request is still pending on the server and the
    // panel still lists it. This dialog just stops asking.
    const out = nextRequest([ask("aa", 1_000), ask("bb", 2_000)], new Set(["aa"]));
    expect(out.request?.fp).toBe("bb");
    expect(out.waiting).toBe(0);
  });

  it("goes quiet when every request has been deferred", () => {
    expect(nextRequest([ask("aa", 1), ask("bb", 2)], new Set(["aa", "bb"])).request).toBeNull();
  });

  it("ignores a malformed entry rather than drawing a dialog about nothing", () => {
    const junk = [null, { name: "x" }, ask("aa", 5)] as unknown as LanStranger[];
    expect(nextRequest(junk, new Set()).request?.fp).toBe("aa");
  });
});
