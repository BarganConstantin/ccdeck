// Browser Watch wrote down, logged and reacted to a program visit whose quiet
// window was still open (#1751). The quiet rule looks both ways: a person at
// the browser within `quietMs` AFTER a program page cancels it too, and only a
// later read can bring that visit. So a CLI that opened a login page, followed
// two minutes later by the person clicking in it, was archived and — with
// quit-browser armed — had the browser quit under them on the poll in between.
// The click then withdrew the verdict, and the archived copy stayed.
//
// Driven through the snapshot with an in-memory store, a reader that honours
// its floor (floored-reader.ts), and a clock each poll is handed. `react` is a
// counter: nothing here can reach a browser, a notification or a process.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { flooredReader, type Visit } from "./floored-reader";
import { browserWatchSnapshot, invalidateBrowserWatchCache } from "../../server/browser-watch.mjs";
import { guardThisMachine } from "./browser-watch-guard";

// The survey is stubbed below; the guard is what fails the file if a case ever
// reaches past the stubs to this machine (#1847): see browser-watch-guard.ts.
vi.mock("node:child_process", async (real) =>
  (await import("./browser-watch-guard")).trappedChildProcess(await real()));
guardThisMachine();

const FROM_API = 0x08000000;
const MIN = 60_000;
const HOST = "opened-by-cli.example";

const person = (atMs: number, n = 0): Visit =>
  ({ url: `https://example.invalid/click-${n}`, timeMs: atMs, transition: 0 });
const program = (atMs: number): Visit =>
  ({ url: `https://${HOST}/login?flow=web`, timeMs: atMs, transition: FROM_API });

let seq = 0;
/** One elected deck, watch on, quit-browser armed, and a store in memory. */
function deck() {
  const history: Visit[] = [];
  let mtime = 1;
  const store = {
    settings: { v: 1, enabled: true, reaction: "quit-browser", quietMinutes: 15, gapMinutes: 15 },
    episodes: [] as any[],
    dismissed: [] as string[],
  };
  const reacted: string[] = [];
  const logged: string[] = [];
  const profile = {
    browser: "chrome", name: "Google Chrome", profile: `Settle${++seq}`,
    dir: "/p", historyPath: `/p/History-settle-${seq}`, securePrefsPath: "/p/Secure Preferences",
    hasClaudeExt: false,
  };
  const reader = flooredReader(() => history);
  const deps = {
    readStore: async () => ({ ...store, settings: { ...store.settings }, migrated: false }),
    updateStore: async (mutate: (cur: typeof store) => typeof store) => {
      const next = await mutate({ ...store });
      store.episodes = next.episodes;
      store.dismissed = next.dismissed;
      return next;
    },
    appendLog: async (episodes: any[]) => { for (const e of episodes) logged.push(e.host); },
    react: async (reaction: string, episode: any) => { reacted.push(`${reaction}:${episode.host}`); return ["quit the browser"]; },
    isReactingDeck: () => true,
    logSize: async () => 0,
    browserSurvey: async () => [],
    hostsPath: () => "/nonexistent/hosts",
    readFile: async () => { throw new Error("ENOENT"); },
    readFileSync: () => { throw new Error("ENOENT"); },
    discoverProfiles: () => [profile],
    statSync: () => ({ mtimeMs: mtime }),
    readVisitsSince: reader.read,
  };
  return {
    store, reacted, logged,
    browse: (...rows: Visit[]) => { history.push(...rows); mtime += 1; },
    poll: (now: number) => browserWatchSnapshot({ deps, now, platform: "linux" }),
  };
}

beforeEach(() => invalidateBrowserWatchCache());

describe("a program visit whose quiet window is still open", () => {
  it("is not archived, logged or reacted to, and is gone once a person's visit withdraws it", async () => {
    const t = Date.now() - 3 * 3600_000;
    const d = deck();
    d.browse(person(t, 1), program(t + 30 * MIN));
    const first = await d.poll(t + 31 * MIN);

    // The person clicks in the page the CLI opened, two minutes after it.
    d.browse(person(t + 32 * MIN, 2));
    const after = await d.poll(t + 33 * MIN);

    expect(d.reacted, "the browser was quit before the quiet window closed").toEqual([]);
    expect(d.store.episodes.map(e => e.host), "the withdrawn verdict was archived").not.toContain(HOST);
    expect(d.logged, "the withdrawn verdict was written to watch.log").toEqual([]);
    expect(after.episodes, "the withdrawn verdict is still listed").toEqual([]);

    // Shown while it was open, because it is what the browser held at that
    // moment — and marked, since the next read could still take it back.
    expect(first.episodes.map((e: any) => e.host)).toEqual([HOST]);
    expect(first.episodes[0].provisional, "an open verdict is not marked provisional").toBe(true);
  });

  it("is archived and reacted to exactly once when the window closes with nobody back", async () => {
    // The other half, without which the case above passes by never reacting.
    const t = Date.now() - 3 * 3600_000;
    const d = deck();
    d.browse(person(t, 1), program(t + 30 * MIN));
    await d.poll(t + 31 * MIN);
    expect(d.reacted).toEqual([]);

    // Nobody touches the browser, so the file does not move: the polls that
    // settle the verdict are answered from the mtime cache.
    const settled = await d.poll(t + 47 * MIN);
    expect(d.store.episodes.map(e => e.host)).toEqual([HOST]);
    expect(d.logged).toEqual([HOST]);
    expect(d.reacted).toEqual([`quit-browser:${HOST}`]);
    expect(settled.episodes.map((e: any) => e.host)).toEqual([HOST]);
    expect(settled.episodes[0].provisional).toBeUndefined();

    await d.poll(t + 50 * MIN);
    d.browse(person(t + 90 * MIN, 3));
    await d.poll(t + 91 * MIN);
    expect(d.reacted, "one episode, reacted to more than once").toHaveLength(1);
    expect(d.logged).toHaveLength(1);
  });
});
