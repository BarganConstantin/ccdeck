// AGENTS_DECK_NO_NOTIFY=1 keeps the deck off the desktop entirely (#1677).
//
// It did for a blocked session and not for Browser Watch: a deck launched with
// the variable set still called notify-send (osascript on macOS, a toast on
// Windows) for every new episode, because the reaction notified before it
// looked at anything. The Notifications setting said "off — set at launch", and
// the watch went on raising them.
//
// What must survive the veto is the rest of the reaction. A tab the reaction
// closes is still closed, and the feed line says why no notification came, so
// the finding is explained where the reader looks for it.
import { describe, it, expect } from "vitest";
import { react } from "../../server/browser-react.mjs";

const episode = {
  host: "example.invalid",
  browser: "brave",
  count: 2,
  startMs: 1_000_000,
  endMs: 1_000_000,
  urls: [{ url: "https://example.invalid/x", timeMs: 1_000_000 }],
};

/** Every command the reaction runs, answered as a success. */
function recorder() {
  const calls: Array<[string, string[]]> = [];
  const deps = {
    run: async (cmd: string, args: string[]) => {
      calls.push([cmd, args]);
      return { ok: true, stdout: "closed", stderr: "" };
    },
  };
  return { calls, deps };
}

const VETO = { AGENTS_DECK_NO_NOTIFY: "1" };

describe("a deck launched with AGENTS_DECK_NO_NOTIFY=1", () => {
  it("does not raise the notification, on any platform", async () => {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      const { calls, deps } = recorder();
      const done = await react("notify", episode, { platform, deps, env: VETO });
      expect(calls, platform).toEqual([]);
      expect(done).toEqual(["not notified — AGENTS_DECK_NO_NOTIFY=1"]);
    }
  });

  it("still carries out the rest of the reaction", async () => {
    const { calls, deps } = recorder();
    const done = await react("close-tab", episode, { platform: "darwin", deps, env: VETO });
    // The close ran, and nothing else did: no osascript `display notification`.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some(([, args]) => args.join(" ").includes("display notification"))).toBe(false);
    expect(done[0]).toBe("not notified — AGENTS_DECK_NO_NOTIFY=1");
  });

  it("says so in a line the feed files as a finding, not as a failure", async () => {
    // browser-watch.mjs files `could not …` and `reaction failed …` as warnings.
    // The user asked for this; it is not the deck failing to do something.
    const { deps } = recorder();
    const [line] = await react("notify", episode, { platform: "linux", deps, env: VETO });
    expect(line).not.toMatch(/^(could not|reaction failed)/);
  });
});

describe("a deck launched without it", () => {
  it("notifies as before", async () => {
    const { calls, deps } = recorder();
    const done = await react("notify", episode, { platform: "linux", deps, env: {} });
    expect(calls.map(([cmd]) => cmd)).toEqual(["notify-send"]);
    expect(done).toEqual(["notified"]);
  });

  it("reads only the exact value 1, the way the Notifications setting does", async () => {
    const { calls, deps } = recorder();
    await react("notify", episode, { platform: "linux", deps, env: { AGENTS_DECK_NO_NOTIFY: "0" } });
    expect(calls.map(([cmd]) => cmd)).toEqual(["notify-send"]);
  });
});
