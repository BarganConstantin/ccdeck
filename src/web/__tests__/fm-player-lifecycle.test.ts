import { describe, it } from "vitest";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import type { FmPlayer, FmPlayerOptions } from "../use-fm-player";

// Exercises the real bundled hook with controlled media and a small hook runner.
// Real React/browser lifecycles are covered by the separate browser QA evidence.
/** The harness's <audio>: a play() stays pending until settled, and a pause()
 *  or load() rejects every pending one with an AbortError, as a browser's do. */
interface MediaFake {
  plays: number; loads: number;
  play(): Promise<void>; pause(): void; load(): void;
  settlePlays(error?: unknown): void;
}
interface HlsFake { destroyed?: boolean; emit(event: string, data?: unknown): void }
interface Harness {
  p: FmPlayer; commands: { event: string; func: string; args: unknown[] }[];
  audio: MediaFake[]; hls: HlsFake[]; event(type: string): void;
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

// A direct HLS station (#1208) in a browser without native HLS, Firefox's case:
// the hook's own hls.js path, with a play() that behaves like a browser's.
describe("a direct HLS stream's play() (#2164)", () => {
  const station = { id: "hls-qa", name: "QA", url: "https://radio.example/live.m3u8" };
  const source = "custom:hls-qa" as const;
  /** Picked, attached, the manifest parsed, and its play() still pending. */
  async function connecting(marks: unknown[][]) {
    const h = await createHarness(repo, {
      volume: 40, muted: false, source, playRequest: 0, customStation: station,
      fetchImpl: async () => new Response(JSON.stringify({ video: "abcdefghijk" })),
      onAvailabilityChange: (...args) => marks.push(args),
    });
    await h.settle(); h.update({ playRequest: 1 }); await h.settle();
    h.hls[0].emit("parsed"); await h.settle();
    assert.equal(h.audio[0].plays, 1);
    return h;
  }
  const unavailable = (marks: unknown[][]) => marks.filter(([, off]) => off === true);

  it("is not failed by a pause and play that are not ccdeck's, and leaves that play() alone", async () => {
    const marks: unknown[][] = [];
    const h = await connecting(marks);
    try {
      const player = h.audio[0];
      // What the media keys or another script do: pause the stream while it
      // connects and play it again, with nothing holding the play() it makes.
      let theirs = "pending";
      player.pause();
      player.play().then(() => { theirs = "resolved"; }, () => { theirs = "rejected"; });
      await h.settle();
      assert.equal(theirs, "pending");
      assert.equal(h.hls[0].destroyed, undefined);
      assert.equal(h.p.dead, false); assert.equal(h.p.armed, true);
      assert.deepEqual(unavailable(marks), []);
      // And the stream plays on it.
      player.settlePlays(); h.event("playing"); await h.settle();
      assert.equal(h.p.playing, true); assert.equal(theirs, "resolved");
    } finally { h.dispose(); }
  });

  it("is not failed when hls.js reloads the media, and plays the reloaded stream", async () => {
    const marks: unknown[][] = [];
    const h = await connecting(marks);
    try {
      // recoverMediaError: a detach, which loads the element, and an attach.
      h.audio[0].load(); await h.settle();
      h.hls[0].emit("attached"); h.hls[0].emit("parsed"); await h.settle();
      assert.equal(h.p.dead, false); assert.equal(h.hls[0].destroyed, undefined);
      assert.equal(h.audio[0].plays, 2);
      assert.deepEqual(unavailable(marks), []);
    } finally { h.dispose(); }
  });

  it("is not failed by a stop or a station switch while it connects", async () => {
    for (const leave of ["stop", "switch"] as const) {
      const marks: unknown[][] = [];
      const h = await connecting(marks);
      try {
        if (leave === "stop") h.press();
        else h.update({ source: "lofi-relax", playRequest: 2 });
        await h.settle();
        assert.equal(h.hls[0].destroyed, true);
        assert.equal(h.p.dead, false);
        assert.deepEqual(unavailable(marks), []);
      } finally { h.dispose(); }
    }
  });

  it("still fails a stream the browser cannot play, and idles on a refused autoplay", async () => {
    const marks: unknown[][] = [];
    const h = await connecting(marks);
    try {
      h.audio[0].settlePlays(new DOMException("not suitable", "NotSupportedError")); await h.settle();
      assert.equal(h.p.dead, true); assert.equal(h.p.armed, false);
      assert.equal(h.hls[0].destroyed, true);
      assert.deepEqual(unavailable(marks), [[source, true]]);
    } finally { h.dispose(); }
    const idle: unknown[][] = [];
    const g = await connecting(idle);
    try {
      g.audio[0].settlePlays(new DOMException("no gesture", "NotAllowedError")); await g.settle();
      assert.equal(g.p.dead, false); assert.equal(g.p.armed, false);
      assert.deepEqual(unavailable(idle), []);
    } finally { g.dispose(); }
  });
});
