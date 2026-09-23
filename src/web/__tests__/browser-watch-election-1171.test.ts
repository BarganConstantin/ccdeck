// Which deck writes the browser-watch log, decided against real records on
// disk (#1171).
//
// One machine, one store, and usually more than one deck — the code's own
// comment calls two decks the ordinary case, and it was measured that way. The
// election is what keeps one browsing episode from being written twice and
// notified twice, or, in the shape that was actually reported, from being
// written by nobody at all: a v1.46 deck out of an npx cache held port 4317,
// won by holding the lower number, and then wrote nothing because it predates
// the feature.
//
// Every existing case about this hands `deps.isReactingDeck` the answer, so the
// election itself — the `watch: true` filter, the liveness probe, the lowest
// port, the pid tie-break, a corrupt record — had never run. Those five lines
// were held by `readFileSync` pins, which a rewrite that keeps the strings and
// changes the order passes.
//
// Driven the way `single-log-writer.test.ts` drives the other election: a real
// `agent-dag` directory under a temporary CLAUDE_CONFIG_DIR, with real records
// in it. Nothing here can reach the developer's own ~/.claude — the override is
// set before the module is imported, and asserted below.
import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flooredReader } from "./floored-reader";

const CONFIG = mkdtempSync(join(tmpdir(), "ccdeck-election-"));
const DAG = join(CONFIG, "agent-dag");
const prev = process.env.CLAUDE_CONFIG_DIR;
process.env.CLAUDE_CONFIG_DIR = CONFIG;

import {
  browserWatchSnapshot,
  invalidateBrowserWatchCache,
  registeredDeckPorts,
  // @ts-expect-error — plain .mjs server module, no types
} from "../../server/browser-watch.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { claudeConfigDir } from "../../server/claude-dir.mjs";

// Belt and braces, the same check single-log-writer makes: the election reads
// whatever this resolves to, so if the override were ignored the cases below
// would be reading a running deck's registry and writing nothing that means
// anything.
beforeAll(() => {
  expect(String(claudeConfigDir()), "the config override did not take").toBe(CONFIG);
});
afterAll(() => {
  if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prev;
  rmSync(CONFIG, { recursive: true, force: true });
});

/** A pid nothing can hold: above every platform's ceiling, so `process.kill`
 *  answers ESRCH rather than reaching somebody else's process. The alternative
 *  — a pid this suite once spawned — can be reused by the time it is asked
 *  about, which would make the case pass or fail on timing. */
const GONE = 2_147_483_646;

/** One record in the shape the deck writes at startup. Named for the deck
 *  rather than `Record`, which is a built-in type name this file would
 *  otherwise shadow for every line below it. */
type DeckRecord = { pid?: number; port?: number; watch?: boolean };
function registry(...decks: Array<DeckRecord | string>) {
  rmSync(DAG, { recursive: true, force: true });
  mkdirSync(DAG, { recursive: true });
  decks.forEach((d, i) => {
    writeFileSync(join(DAG, `deck-${i}.json`), typeof d === "string" ? d : JSON.stringify(d));
  });
  // Only what was just written, so one case cannot inherit another's rivals.
  expect(readdirSync(DAG)).toHaveLength(decks.length);
}

/** This deck's own record, which the election recognises by pid. */
const self = (port: number): DeckRecord => ({ pid: process.pid, port, watch: true });

const PROFILE = {
  browser: "brave", name: "Brave", profile: "Default", dir: "/p",
  historyPath: "/p/History", securePrefsPath: "/p/Secure Preferences", hasClaudeExt: true,
};
/** One program navigation in silence, recent enough to be an episode — so
 *  there IS something to write, which is what lets these cases fail. */
const FROM_API = 0x08000000;

/** The armed fixture from browser-watch.test.ts with the one dep that matters
 *  here left OUT, so the election runs for real. Every store call is stubbed:
 *  nothing below may read or write a real deck's state.
 *
 *  Each call gets its own profile key, for the reason floored-reader.ts gives —
 *  what a profile has contributed is process-scoped and survives a cache
 *  invalidation, so two cases sharing one key would inherit each other's
 *  findings. */
let identities = 0;
function armed() {
  const wrote: unknown[] = [];
  const reacted: unknown[] = [];
  const nth = ++identities;
  const profile = { ...PROFILE, profile: `Default${nth}`, historyPath: `/p/History-${nth}` };
  const reader = flooredReader(() => [
    { url: "https://gitlab.example.com/-/jobs", timeMs: Date.now() - 5_000, transition: FROM_API },
  ]);
  const deps = {
    readStore: async () => ({
      settings: { v: 1, enabled: true, reaction: "notify", quietMinutes: 15, gapMinutes: 15 },
      episodes: [],
      migrated: false,
    }),
    writeStore: async (state: unknown) => { wrote.push(state); },
    appendLog: async () => {},
    react: async () => { reacted.push(1); return ["notified"]; },
    discoverProfiles: () => [profile],
    statSync: () => ({ mtimeMs: 1 }),
    readVisitsSince: reader.read,
    readFileSync: () => { throw new Error("ENOENT"); },
    logSize: async () => 0,
  };
  return { deps, wrote, reacted };
}

/** Whether this deck wrote the store on one poll — the whole of what the
 *  election decides. */
async function recorded() {
  const h = armed();
  const snap = await browserWatchSnapshot({ deps: h.deps });
  // The panel is drawn either way: only the writing is exclusive, and a case
  // that passed by finding nothing to show would prove nothing.
  expect(snap.episodes.length, "there was no episode, so this case could not fail").toBeGreaterThan(0);
  return { wrote: h.wrote.length, reacted: h.reacted.length };
}

beforeEach(() => invalidateBrowserWatchCache());

describe("which deck writes the log when two are running", () => {
  it("stands down for a live deck on a lower port", async () => {
    // The ordinary case, and the one whose cost reaches the user: without the
    // rule each deck writes its own line for one episode and fires its own
    // notification — including, for the browser-quit reaction, its own quit.
    registry(self(4393), { pid: process.ppid, port: 4317, watch: true });
    expect(await recorded()).toEqual({ wrote: 0, reacted: 0 });
  });

  it("records when it holds the lowest port itself", async () => {
    // The other half, without which every case here could pass by never
    // writing at all.
    registry(self(4317), { pid: process.ppid, port: 4393, watch: true });
    expect(await recorded()).toEqual({ wrote: 1, reacted: 1 });
  });

  it("gives no vote to a deck that does not run the watch", async () => {
    // THE BUG THIS CLOSES, measured on a real machine. Elected on port alone, a
    // v1.46 deck out of an npx cache won by holding 4317 and then wrote nothing
    // — it answers the watch route with the SPA's index.html. The deck that HAS
    // the watch stood down. Findings on screen, an empty disk, and not one line
    // anywhere saying why. An older deck has no such field, so it loses by
    // construction rather than by a version comparison this would have to keep.
    registry(self(4393), { pid: process.ppid, port: 4317 });
    expect(await recorded()).toEqual({ wrote: 1, reacted: 1 });
    // And the field has to be the boolean, not merely present.
    registry(self(4393), { pid: process.ppid, port: 4317, watch: "yes" } as unknown as DeckRecord);
    expect(await recorded()).toEqual({ wrote: 1, reacted: 1 });
  });

  it("gives no vote to a record whose process is gone", async () => {
    // A deck that crashed or was quit leaves its record behind. A leftover that
    // kept its vote would silence this machine's watch until somebody found the
    // file and deleted it.
    registry(self(4393), { pid: GONE, port: 4317, watch: true });
    expect(await recorded()).toEqual({ wrote: 1, reacted: 1 });
  });

  it("ignores a record it cannot read rather than falling silent over it", async () => {
    // Half-written, because the file is written by another process and read by
    // this one with nothing between them. Neither a crash nor a vote.
    registry(self(4393), "{ not json", { pid: process.ppid, port: 4317, watch: true });
    expect(await recorded(), "a corrupt record cost the live rival its vote").toEqual({ wrote: 0, reacted: 0 });

    registry(self(4393), "{ not json");
    expect(await recorded(), "a corrupt record took this deck's own turn with it").toEqual({ wrote: 1, reacted: 1 });
  });

  it("breaks a tie on the port with the pid, so the answer is never a coin toss", async () => {
    // Two decks CAN advertise one port: a record left by a deck that has since
    // restarted on the same number, or the registry read mid-write. Whatever
    // the reason, both sides of the election must reach the same answer from
    // the same directory — otherwise both stand down and nothing is written at
    // all, which is the failure this whole rule exists to prevent.
    //
    // WHICH WAY THE TIE FALLS IS READ, NOT ASSUMED. The rival has to be a
    // process that is really alive, so it is one this case did not choose the
    // pid of, and pid numbers are not handed out in a useful order: Windows
    // reuses them from a pool, and this runner's parent came back 8224 against
    // its own 5972 on the Windows leg. The RULE is the claim — the lower pid
    // records and the higher one stands down — so the case states the rule and
    // takes the direction from the two numbers in front of it.
    const rival = process.ppid;
    expect(rival, "no live rival to tie with").toBeGreaterThan(0);
    expect(rival).not.toBe(process.pid);
    registry(self(4317), { pid: rival, port: 4317, watch: true });

    const lower = process.pid < rival;
    expect(
      await recorded(),
      lower ? "this deck held the lower pid and stood down" : "this deck held the higher pid and recorded anyway",
    ).toEqual(lower ? { wrote: 1, reacted: 1 } : { wrote: 0, reacted: 0 });
  });

  it("counts a deck it is not allowed to signal as alive", async () => {
    // A deck started by another account, or elevated. `process.kill(pid, 0)`
    // answers EPERM for it — on Windows, EACCES — and both mean RUNNING.
    // Reading them as gone is how a machine ends up with two elected writers:
    // duplicate lines, duplicate notifications, and two writers racing the same
    // rename.
    //
    // pid 1 is the one process every POSIX machine has and an ordinary account
    // may not signal. Windows has no pid 1, so that leg asks about the process
    // that started this one — which is alive, and which the probe therefore has
    // to count whichever way `kill` answered for it. Nothing is skipped: both
    // legs make the claim the election rests on, that a deck this process
    // cannot reach is still a deck.
    const unreachable = process.platform === "win32" ? process.ppid : 1;
    registry(self(4393), { pid: unreachable, port: 4317, watch: true });
    expect(await recorded()).toEqual({ wrote: 0, reacted: 0 });
  });

  it("assumes it is alone when there is no registry to read", async () => {
    // A deck that cannot look must not fall silent: for the common case of one
    // deck, alone is the right answer anyway, and the opposite choice is a
    // watch that never reports and never says why.
    rmSync(DAG, { recursive: true, force: true });
    expect(await recorded()).toEqual({ wrote: 1, reacted: 1 });
  });
});

describe("the ports the watch is told to excuse", () => {
  it("lists a live deck's port and leaves a leftover record's out", async () => {
    // The same directory and the same liveness rule the election uses, read
    // for a different question: a tab on one of these ports is a deck's own
    // panel, not somebody browsing. A dead deck's port left in the list would
    // excuse whatever process took that port next.
    registry({ pid: process.pid, port: 4317, watch: true }, { pid: GONE, port: 4399, watch: true });
    expect(await registeredDeckPorts()).toEqual([4317]);

    registry({ pid: GONE, port: 4317, watch: true });
    expect(await registeredDeckPorts()).toEqual([]);
  });

  it("takes a record with no watch field, because this is not the election", async () => {
    // An older deck's tabs are still its own. The `watch: true` filter belongs
    // to who may WRITE; being excused from the report is about who is running.
    registry({ pid: process.pid, port: 4317 });
    expect(await registeredDeckPorts()).toEqual([4317]);
  });
});
