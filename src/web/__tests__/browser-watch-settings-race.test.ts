// Two quick changes in the Browser Watch panel, and the second undoing the first.
//
// Each control in the panel sends its own one-field POST — the switch
// `{enabled}`, the reaction select `{reaction}` — and the settings route read
// the store BEFORE its write queue, built the whole settings object from that
// read, and then had the queue write it over whatever was there. Two requests
// that both read before either wrote: the second wrote the first's field back
// to what it had been. Turn the watch off and change the reaction straight
// after, and the watch came back on — and the deck went on copying every
// History database in the background, under a switch the panel had just shown
// as off. The window is widest while a poll holds the queue writing the
// archive, which is what the case below sets up.
//
// Run against the real route and a real store in a temp home.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PassThrough } from "node:stream";
import { join, resolve } from "node:path";
import { guardThisMachine } from "./browser-watch-guard";

// The route imports browser-watch.mjs, so the same seal every file that does
// carries (browser-watch-guard.ts).
vi.mock("node:child_process", async (real) =>
  (await import("./browser-watch-guard")).trappedChildProcess(await real()));
const { home: DIR } = guardThisMachine();
vi.stubEnv("CODEX_HOME", join(DIR, "codex"));
if (!resolve(String(process.env.CLAUDE_CONFIG_DIR)).startsWith(resolve(DIR))) throw new Error("sandbox escaped");

// @ts-expect-error — .mjs server module, no types
const store = await import("../../server/browser-watch-store.mjs");
// @ts-expect-error — ditto
const { handleBrowserWatchSettings } = await import("../../server/browser-watch-routes.mjs");

type Reply = { status: number; body: string; headersSent: boolean };

/** One POST to the settings route, as the panel sends it. */
async function post(body: unknown): Promise<Reply> {
  const req = new PassThrough();
  req.end(JSON.stringify(body));
  const res = {
    status: 0, body: "", headersSent: false,
    writeHead(status: number) { res.status = status; res.headersSent = true; },
    end(text: string) { res.body = text; },
  };
  await handleBrowserWatchSettings(req, res);
  return res;
}

beforeEach(async () => {
  await store.writeStore({ settings: { ...store.DEFAULTS }, episodes: [], dismissed: [] });
});

describe("two one-field changes made together", () => {
  it("keep each other, while a poll holds the write queue", async () => {
    // A poll writing the archive: the queue is busy until it lets go.
    let release = () => {};
    const held = new Promise<void>(r => { release = r; });
    const poll = store.updateStore(async (cur: unknown) => { await held; return cur; });

    const off = post({ enabled: false });
    const reaction = post({ reaction: "close-tab" });
    // Long enough for both requests to have read whatever they read before the
    // queue, which is what the panel's two quick presses do.
    await new Promise(r => setTimeout(r, 300));
    release();
    const [, offReply, reactionReply] = await Promise.all([poll, off, reaction]);

    expect(offReply.status).toBe(200);
    expect(reactionReply.status).toBe(200);
    const after = await store.readStore();
    expect(after.settings.enabled, "the second change switched the watch back on").toBe(false);
    expect(after.settings.reaction).toBe("close-tab");
    // And the reply says what was written, not what the request read.
    expect(JSON.parse(reactionReply.body).settings).toMatchObject({ enabled: false, reaction: "close-tab" });
  });

  it("each keep the settings nobody touched", async () => {
    await post({ quietMinutes: 11 });
    await post({ gapMinutes: 9 });
    const after = await store.readStore();
    expect(after.settings).toMatchObject({ enabled: true, quietMinutes: 11, gapMinutes: 9 });
  });
});

describe("a bad value", () => {
  it("still falls back through normalise rather than reaching the store", async () => {
    await post({ reaction: "format-disk", quietMinutes: -5 });
    const after = await store.readStore();
    expect(after.settings.reaction).toBe(store.DEFAULTS.reaction);
    expect(after.settings.quietMinutes).toBe(store.DEFAULTS.quietMinutes);
  });
});
