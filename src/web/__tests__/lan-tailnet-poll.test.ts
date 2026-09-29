// When the engine reads the tailnet, driven on its own: a fake reader, a fake
// beacon and the fake clock, so the three rules are three cases — read on a
// timer only while the switch is on, announce once after the first read, and
// never announce for a listener that has gone since that read began.
import { describe, it, expect, vi, afterEach } from "vitest";
// @ts-expect-error — plain .mjs server module, no types
import { createTailnetPoll } from "../../server/lan-tailnet-poll.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { TAILNET_MS } from "../../server/tailscale.mjs";

afterEach(() => { vi.useRealTimers(); });

/** A reader whose reads the test finishes by hand, and a beacon that counts. */
function rig() {
  const reads: Array<() => void> = [];
  const tailnet = { refresh: () => new Promise<void>(r => { reads.push(r); }) };
  const beacon = { announced: 0, announce() { this.announced++; } };
  const state = { beacon: beacon as typeof beacon | null, on: true };
  const poll = createTailnetPoll({ tailnet, beaconNow: () => state.beacon, wanted: () => state.on });
  return { poll, reads, beacon, state };
}

describe("reading the tailnet", () => {
  it("starts with one read and announces once it lands", async () => {
    const r = rig();
    r.poll.sync();
    expect(r.reads).toHaveLength(1);
    // Asked again while it runs: nothing new is started.
    r.poll.sync();
    expect(r.reads).toHaveLength(1);
    r.reads[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(r.beacon.announced).toBe(1);
  });

  it("reads again on its own timer until the switch goes off", () => {
    vi.useFakeTimers();
    const r = rig();
    r.poll.sync();
    vi.advanceTimersByTime(TAILNET_MS);
    expect(r.reads).toHaveLength(2);
    r.state.on = false;
    r.poll.sync();
    vi.advanceTimersByTime(TAILNET_MS * 3);
    expect(r.reads).toHaveLength(2);
  });

  it("does nothing at all without a beacon, a reader, or the switch", () => {
    const r = rig();
    r.state.beacon = null;
    r.poll.sync();
    r.state.beacon = r.beacon;
    r.state.on = false;
    r.poll.sync();
    expect(r.reads).toHaveLength(0);
    const none = createTailnetPoll({ tailnet: null, beaconNow: () => r.beacon, wanted: () => true });
    expect(() => none.sync()).not.toThrow();
  });
});

describe("a read that lands late", () => {
  it("announces nothing once the poll was stopped under it", async () => {
    const r = rig();
    r.poll.sync();
    r.poll.stop();
    r.reads[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(r.beacon.announced).toBe(0);
  });

  it("announces nothing for a beacon that was replaced while it ran", async () => {
    const r = rig();
    r.poll.sync();
    r.state.beacon = { announced: 0, announce() { this.announced++; } };
    r.reads[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(r.beacon.announced).toBe(0);
    expect(r.state.beacon.announced).toBe(0);
  });

  it("announces nothing once the switch went off while it ran", async () => {
    const r = rig();
    r.poll.sync();
    r.state.on = false;
    r.reads[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(r.beacon.announced).toBe(0);
  });
});
