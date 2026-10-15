import { describe, it } from "vitest";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import type { FmPlayer, FmPlayerOptions } from "../use-fm-player";

// Exercises the real bundled hook with controlled media and a small hook runner.
// Real React/browser lifecycles are covered by the separate browser QA evidence.
interface Harness {
  p: FmPlayer; commands: { event: string; func: string; args: unknown[] }[];
  timerCount: number; listenerCount: number;
  update(next: Partial<FmPlayerOptions>): void;
  settle(): Promise<void>; mountFrame(): unknown;
  message(data: unknown, options?: { source?: unknown; origin?: string }): void;
  advance(ms: number): void; press(): void; dispose(): void;
}
const { createHarness } = createRequire(import.meta.url)("./fm-player-harness.cjs") as {
  createHarness(repo: string, options: FmPlayerOptions): Promise<Harness>;
};
const repo = fileURLToPath(new URL("../../..", import.meta.url));
describe("FM playback lifecycle regressions", () => {
  const availability: unknown[][] = [];
  const base: FmPlayerOptions = {
    volume: 40, muted: false, source: "lofi-relax", playRequest: 0,
    fetchImpl: async () => new Response(JSON.stringify({ video: "abcdefghijk" })),
    onAvailabilityChange: (...args) => availability.push(args),
  };
  function check(name: string, fn: (h: Harness) => void | Promise<void>) {
    it(name, async () => {
      const h = await createHarness(repo, base);
      try {
        await h.settle(); h.update({ playRequest: 1 }); await h.settle();
        await fn(h);
      } finally { h.dispose(); }
    });
  }
  check('request does not confirm playback; silent startup expires at 15s', h => {
    assert.equal(h.p.playing, false); h.advance(14999); assert.equal(h.p.dead, false);
    h.advance(1); assert.equal(h.p.dead, true); assert.equal(h.p.armed, false);
  });
  check('state 1 cancels startup timeout', h => {
    h.message({ event: 'onStateChange', info: 1 }); h.advance(60000);
    assert.equal(h.p.playing, true); assert.equal(h.p.dead, false); assert.equal(h.timerCount, 0);
  });
  check('repeated buffering does not extend deadline', h => {
    h.message({ event: 'onStateChange', info: 1 });
    h.message({ event: 'onStateChange', info: 3 }); h.advance(10000);
    h.message({ event: 'infoDelivery', info: { playerState: 3 } });
    assert.equal(h.p.playing, false); assert.equal(h.p.buffering, true);
    h.advance(5000); assert.equal(h.p.dead, true);
  });
  check('recovery clears buffering timeout', h => {
    h.message({ event: 'onStateChange', info: 3 }); h.advance(10000);
    h.message({ event: 'onStateChange', info: 1 }); h.advance(60000);
    assert.equal(h.p.playing, true); assert.equal(h.p.buffering, false); assert.equal(h.p.dead, false);
  });
  check('pause during buffering cancels timer and listener', h => {
    h.message({ event: 'onStateChange', info: 3 }); h.press();
    assert.equal(h.commands.at(-1).func, 'pauseVideo');
    assert.equal(h.p.armed, false); assert.equal(h.p.buffering, false);
    assert.equal(h.timerCount, 0); assert.equal(h.listenerCount, 0);
    h.advance(60000); assert.equal(h.p.dead, false);
  });
  for (const stopped of [0, 2]) check(`stopped state ${stopped} releases session without failure`, h => {
    h.message({ event: 'onStateChange', info: 3 });
    h.message({ event: 'onStateChange', info: stopped }); h.advance(60000);
    assert.equal(h.p.armed, false); assert.equal(h.p.playing, false);
    assert.equal(h.p.buffering, false); assert.equal(h.p.dead, false); assert.equal(h.timerCount, 0);
  });
  check('volume/mute changes do not reset startup deadline; ready uses latest values', h => {
    h.mountFrame(); h.advance(10000); h.update({ volume: 17, muted: true });
    h.message({ event: 'onReady' });
    assert.deepEqual(h.commands.slice(-3), [
      { event: 'command', func: 'setVolume', args: [17] },
      { event: 'command', func: 'mute', args: [] },
      { event: 'command', func: 'playVideo', args: [] },
    ]);
    h.advance(5000); assert.equal(h.p.dead, true);
  });
  check('live volume/mute changes do not install timeout', h => {
    h.message({ event: 'onStateChange', info: 1 }); h.update({ volume: 65, muted: true });
    h.update({ muted: false }); h.advance(60000);
    assert.equal(h.commands.at(-1).func, 'unMute'); assert.equal(h.p.dead, false); assert.equal(h.timerCount, 0);
  });
  check('source switch cancels old deadline and rejects old frame', async h => {
    const oldFrame = h.mountFrame(); h.advance(10000);
    h.update({ source: 'lofi-game', playRequest: 2 }); await h.settle(); h.mountFrame();
    h.message({ event: 'onError', info: 153 }, { source: oldFrame });
    h.advance(5000); assert.equal(h.p.dead, false);
    h.advance(10000); assert.equal(h.p.dead, true);
  });
  check('blocked playback returns idle; retry arms again', h => {
    h.message({ event: 'onAutoplayBlocked' });
    assert.equal(h.p.armed, false); assert.equal(h.p.playing, false); assert.equal(h.p.dead, false);
    assert.equal(h.timerCount, 0); h.press(); assert.equal(h.p.armed, true); assert.equal(h.p.playing, false);
  });
  check('error 153 resets all playback flags and reports unavailable', h => {
    const before = availability.length;
    h.message({ event: 'onStateChange', info: 3 }); h.message({ event: 'onError', info: 153 });
    assert.equal(h.p.dead, true); assert.equal(h.p.armed, false); assert.equal(h.p.buffering, false);
    assert.deepEqual(availability.slice(before), [['lofi-relax', true]]);
  });
  check('unmount removes watchdog and listener', h => {
    h.dispose(); assert.equal(h.timerCount, 0); assert.equal(h.listenerCount, 0); h.advance(60000);
  });

  for (const failure of ["http", "empty", "reject"] as const) {
    it(`custom YouTube ${failure} probe resets all playback flags`, async () => {
      const fetchImpl: typeof fetch = async () => {
        if (failure === "reject") throw new Error("offline");
        return new Response(JSON.stringify({}), { status: failure === "http" ? 503 : 200 });
      };
      const h = await createHarness(repo, { ...base, source: "custom:youtube-qa", customStation: { id: "youtube-qa", name: "QA", url: "https://www.youtube.com/watch?v=abcdefghijk" }, fetchImpl });
      try {
        await h.settle(); h.update({ playRequest: 1 }); await h.settle();
        assert.equal(h.p.dead, true); assert.equal(h.p.armed, false);
        assert.equal(h.p.playing, false); assert.equal(h.p.buffering, false);
        assert.equal(h.timerCount, 0);
      } finally { h.dispose(); }
    });
  }
});
