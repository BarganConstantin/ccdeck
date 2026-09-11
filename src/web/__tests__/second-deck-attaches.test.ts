// Twenty ccdeck processes were counted on one machine, and not one of them was
// a mistake anybody could see making: `startServer` answers a refused bind on
// 4317 by taking a random port out of 4318–4400, and it ran that fallback
// whether the thing holding 4317 was an OTLP collector or another ccdeck. So
// typing `ccdeck` a second time built a second supervisor, worker, server, hook
// registration, LAN identity and browser tab beside a healthy first one, and
// neither half mentioned the other.
//
// The fallback is not the bug and does not move — 4317 is the standard OTLP
// port, and on Windows `winnat` can reserve it with nothing listening at all.
// What changed is that the deck now asks a different question first: not "is
// this port free" but "is one of MY decks already up", answered from the
// registry and proved with the token handshake before a single byte is trusted.
//
// These tests pin the three ways that could quietly go wrong: attaching when it
// should not, refusing to attach when it should, and trusting a port that has
// not proved itself.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// @ts-expect-error — .mjs server module, no types
const mod = await import("../../server/running-deck.mjs");
const { SHAPING_FLAGS, asksForOwnDeck, runningDeck, sameShape, versionNote } = mod as {
  SHAPING_FLAGS: readonly string[];
  asksForOwnDeck: (flags: Record<string, unknown>) => boolean;
  sameShape: (record: Rec | null, want: Partial<Rec>) => boolean;
  versionNote: (running: unknown, ours: unknown) => string;
  runningDeck: (o: {
    want?: Partial<Rec>;
    dir?: string;
    fs?: { readdir: (d: string) => Promise<string[]>; readFile: (p: string) => Promise<string> };
    self?: number;
    alive?: (pid: number) => boolean;
    prove?: (port: number, token: string) => Promise<boolean>;
  }) => Promise<Rec | null>;
};

type Rec = {
  pid: number; port: number; token: string;
  workspace: string; persist: string | null; codex: boolean; claude: boolean;
  version?: string;
};

const WANT = { workspace: "", persist: "/log/events.jsonl", codex: true, claude: true };

/** A record of the default shape, differing only where asked. */
const rec = (over: Partial<Rec> = {}): Rec => ({
  pid: 4231, port: 4317, token: "t".repeat(64), ...WANT, version: "3.19.0", ...over,
});

/** A registry directory holding exactly these records, one file each. */
function registry(records: Rec[]) {
  const files = new Map(records.map(r => [`${r.pid}.json`, JSON.stringify(r)]));
  return {
    fs: {
      readdir: async () => [...files.keys()],
      // The real readFile is handed an absolute path; only the basename matters.
      readFile: async (p: string) => {
        const hit = files.get(String(p).split(/[\\/]/).pop() ?? "");
        if (hit === undefined) throw new Error("ENOENT");
        return hit;
      },
    },
    files,
  };
}

const SRC = readFileSync(
  fileURLToPath(new URL("../../server/running-deck.mjs", import.meta.url)),
  "utf8",
);
const DECK = readFileSync(fileURLToPath(new URL("../../../bin/deck.js", import.meta.url)), "utf8");
const INDEX = readFileSync(fileURLToPath(new URL("../../server/index.mjs", import.meta.url)), "utf8");

describe("only a bare command line may be answered by an existing deck", () => {
  it("attaches for `ccdeck` and `ccdeck --no-open`, and for nothing else", () => {
    expect(asksForOwnDeck({ unknown: [], incomplete: [] })).toBe(false);
    // --no-open changes what the LAUNCHER does with a URL, not what the deck is.
    expect(asksForOwnDeck({ noOpen: true, unknown: [], incomplete: [] })).toBe(false);
    // --all has been a no-op since it became the default.
    expect(asksForOwnDeck({ all: true, unknown: [], incomplete: [] })).toBe(false);
    expect(asksForOwnDeck({ new: true, unknown: [], incomplete: [] })).toBe(true);
  });

  it("treats every flag that changes what the deck IS as a request for a new one", () => {
    // Not a hand-written list twice over: the export is walked, so a flag added
    // to it is covered here the moment it is added, and one quietly removed
    // fails this test rather than silently starting to attach.
    expect([...SHAPING_FLAGS].sort()).toEqual(
      ["claude", "codex", "history", "noClaude", "noCodex", "noPersist", "port", "scope", "workspace"],
    );
    for (const flag of SHAPING_FLAGS) {
      expect(asksForOwnDeck({ [flag]: "x", unknown: [], incomplete: [] }), flag).toBe(true);
    }
  });

  it("does not let a misspelling build the second deck", () => {
    // THE REGRESSION THIS EXISTS FOR. These two answered `true` at first, so
    // the startup report would run and print the warning that names the bad
    // token — and that is how `ccdeck --stpo`, a typo in the flag that STOPS a
    // deck, came to build one instead. The guard meant to protect against extra
    // decks was the thing creating them.
    expect(asksForOwnDeck({ unknown: ["--stpo"], incomplete: [] })).toBe(false);
    expect(asksForOwnDeck({ unknown: ["--workpace"], incomplete: [] })).toBe(false);
    // `ccdeck --workspace $UNSET` reaches the parser as a bare `--workspace`.
    expect(asksForOwnDeck({ unknown: [], incomplete: [{ flag: "--workspace", expects: "a path" }] }))
      .toBe(false);
  });

  it("prints the warning on the attach path, which is what was actually needed", () => {
    // The report was never the requirement — the message was. Both are printed
    // beside the attach, in the same rows the startup report uses, so nothing a
    // typo would have been told is lost and nothing extra is started.
    const ask = DECK.indexOf("if (!RESPAWN && !asksForOwnDeck(flags))");
    const unknown = DECK.indexOf("reportUnknownFlags(flags.unknown);", ask);
    const incomplete = DECK.indexOf("reportIncompleteFlags(flags.incomplete);", ask);
    const bind = DECK.indexOf("const starting = startServer({");
    expect(unknown).toBeGreaterThan(ask);
    expect(incomplete).toBeGreaterThan(ask);
    // Inside the attach block, not the boot path's own copies further down.
    expect(unknown).toBeLessThan(bind);
    expect(incomplete).toBeLessThan(bind);
  });

  it("is offered by the parser at all", () => {
    const args = readFileSync(
      fileURLToPath(new URL("../../server/args.mjs", import.meta.url)), "utf8",
    );
    expect(args).toContain('a === "--new"');
    expect(DECK).toContain("--new");
  });
});

describe("the deck found must be the deck we would have built", () => {
  it("matches only on every field that decides what a deck serves", () => {
    expect(sameShape(rec(), WANT)).toBe(true);
    // A canvas filtered to a directory the user never mentioned.
    expect(sameShape(rec({ workspace: "/home/u/proj" }), WANT)).toBe(false);
    // A different events log is a different history on screen.
    expect(sameShape(rec({ persist: "/other/events.jsonl" }), WANT)).toBe(false);
    expect(sameShape(rec({ persist: null }), WANT)).toBe(false);
    expect(sameShape(rec({ codex: false }), WANT)).toBe(false);
    // No accounts panel, no hooks, no switcher.
    expect(sameShape(rec({ claude: false }), WANT)).toBe(false);
  });

  it("leaves a deck older than the `claude` field alone, by construction", () => {
    // The strict compare is what does it: an older record has no such key, so
    // `undefined === true` is false and its deck keeps the behaviour it has
    // always had. No version check to remember to update.
    const old = rec();
    delete (old as Partial<Rec>).claude;
    expect(sameShape(old, WANT)).toBe(false);
  });

  it("publishes both new fields, or nothing downstream can compare them", () => {
    const installer = readFileSync(
      fileURLToPath(new URL("../../server/installer.mjs", import.meta.url)), "utf8",
    );
    expect(installer).toMatch(/claude: claude !== false/);
    expect(installer).toMatch(/version: typeof version === "string"/);
    // And the deck actually fills them in — a field published as its default
    // for every deck is a field that decides nothing.
    expect(DECK).toMatch(/claude: wantClaude,\s*\n\s*version: PKG_VERSION,/);
  });
});

describe("a port has to prove itself before it is opened", () => {
  it("returns the prover, and challenges only what already matched the shape", async () => {
    const { fs } = registry([
      rec({ pid: 11, port: 4319 }),
      rec({ pid: 12, port: 4318, workspace: "/elsewhere" }),
      rec({ pid: 13, port: 4317 }),
    ]);
    const prove = vi.fn(async () => true);
    const found = await runningDeck({ want: WANT, fs, self: 99, alive: () => true, prove });
    // Lowest port wins — electWriters' rule, so the answer is the same every
    // time it is asked rather than whatever readdir happened to return first.
    expect(found?.pid).toBe(13);
    // One round trip on the ordinary machine, and the scoped deck on 4318 was
    // never dialled at all.
    expect(prove).toHaveBeenCalledTimes(1);
    expect(prove.mock.calls.map(c => (c as unknown as [number])[0])).toEqual([4317]);
  });

  it("moves on when a port answers wrongly, rather than opening it", async () => {
    // #695: a record left by a deck that is gone passes a signal-0 probe forever
    // once the OS recycles its pid, and the port it names may by then belong to
    // anything at all. A collector on 4317 cannot hash a token it never had.
    const { fs } = registry([rec({ pid: 11, port: 4317 }), rec({ pid: 12, port: 4318 })]);
    const prove = vi.fn(async (port: number) => port === 4318);
    const found = await runningDeck({ want: WANT, fs, self: 99, alive: () => true, prove });
    expect(found?.port).toBe(4318);
    expect(prove).toHaveBeenCalledTimes(2);
  });

  it("skips our own record, dead pids, and decks too old to be challenged", async () => {
    const tokenless = rec({ pid: 14, port: 4320 });
    tokenless.token = "";
    const { fs } = registry([
      rec({ pid: 99, port: 4317 }),      // ours
      rec({ pid: 15, port: 4318 }),      // dead
      tokenless,                          // pre-handshake: cannot prove anything
    ]);
    const prove = vi.fn(async () => true);
    const found = await runningDeck({
      want: WANT, fs, self: 99, alive: (pid: number) => pid !== 15, prove,
    });
    expect(found).toBeNull();
    expect(prove).not.toHaveBeenCalled();
  });

  it("answers `no deck` for a directory it cannot read, and never throws on the boot path", async () => {
    const prove = vi.fn(async () => true);
    const fs = { readdir: async () => { throw new Error("EACCES"); }, readFile: async () => "" };
    await expect(runningDeck({ want: WANT, fs, self: 1, alive: () => true, prove })).resolves.toBeNull();
    // One corrupt record must not take the others down with it.
    const half = {
      readdir: async () => ["1.json", "2.json"],
      readFile: async (p: string) => (String(p).endsWith("1.json") ? "{ not json" : JSON.stringify(rec({ pid: 2 }))),
    };
    const found = await runningDeck({ want: WANT, fs: half, self: 1, alive: () => true, prove });
    expect(found?.pid).toBe(2);
  });

  it("refuses to guess the handshake it was not given", async () => {
    // The whole reason this module does not import the server: importing it
    // arms its timers. A default would have to come from somewhere, and every
    // somewhere is either that import or a second spelling of the crypto.
    await expect(runningDeck({ want: WANT, fs: registry([]).fs })).rejects.toThrow(/alive.*prove/);
    expect(SRC).not.toMatch(/from "\.\/index\.mjs"/);
    // The originals stay exported, so there is exactly one spelling of each.
    expect(INDEX).toContain("export function challengeDeck(");
    expect(INDEX).toContain("export function isProcessAlive(");
  });
});

describe("what the attach does and does not disturb", () => {
  it("asks before it binds, installs, probes or paints", () => {
    // The position is the point: an attach must leave the machine exactly as it
    // found it, so it happens before the port, the hooks, the tool probes, the
    // banner and the discovery file.
    const ask = DECK.indexOf("if (!RESPAWN && !asksForOwnDeck(flags))");
    const bind = DECK.indexOf("const starting = startServer({");
    const work = DECK.indexOf("const jobs = startupWork()");
    const register = DECK.indexOf("discovery = keepDiscovery({");
    expect(ask).toBeGreaterThan(0);
    for (const [name, at] of Object.entries({ bind, work, register })) {
      expect(at, name).toBeGreaterThan(ask);
    }
  });

  it("leaves the random-port fallback exactly where it was", () => {
    // It is not the bug and it never was: 4317 is the standard OTLP collector
    // port, and Windows `winnat` reserves contiguous blocks for Hyper-V, WSL2
    // and Docker Desktop, so it can be unavailable with nothing listening on it.
    // A deck coming up on 4322 beats a deck refusing to come up.
    expect(INDEX).toContain("portRange = [4318, 4400]");
    expect(INDEX).toMatch(/portRetryable = \(err\) =>[\s\S]{0,120}EADDRINUSE[\s\S]{0,40}EACCES/);
  });

  it("never attaches on a respawn, whatever the flags say", () => {
    // A restart is this deck coming back, not somebody typing ccdeck twice. The
    // supervisor relaunches with `--port <bound>`, which would exclude it
    // anyway — this is the guard that survives the day it stops doing that.
    expect(DECK).toContain("if (!RESPAWN && !asksForOwnDeck(flags))");
  });

  it("waits for the launcher chain instead of exiting out from under it", () => {
    // Every child openUrl spawns is unref'd, so an immediate exit ends this
    // process before a missing xdg-open has been answered by gio — and then no
    // browser opens and nothing says why. The boot path never had to think
    // about this because it stays alive forever.
    expect(DECK).toMatch(/openUrl\(liveUrl\);[\s\S]{0,400}await sleep\(LAUNCH_GRACE_MS\);/);
  });

  it("says a second deck was not started, and how to start one anyway", () => {
    // Without it the command looks like it did nothing at all, which is the
    // other way to be confusing about this.
    expect(DECK).toContain("no second deck was started");
    // The backtick is escaped in the source: the line lives inside a template
    // literal, and the flag is quoted for the shell in the message itself.
    expect(DECK).toContain("--new\\` starts one");
  });
});

describe("an older deck on the port is said out loud, not routed around", () => {
  it("names both versions when they differ", () => {
    expect(versionNote("3.18.0", "3.19.0")).toMatch(/running v3\.18\.0/);
    expect(versionNote("3.18.0", "3.19.0")).toMatch(/you launched v3\.19\.0/);
    // And it says what to do about it, which is the only reason to print it.
    expect(versionNote("3.18.0", "3.19.0")).toMatch(/restart/);
  });

  it("says nothing when there is nothing useful to say", () => {
    expect(versionNote("3.19.0", "3.19.0")).toBe("");
    // A deck too old to report one: "unknown" beside a number is noise.
    expect(versionNote("", "3.19.0")).toBe("");
    expect(versionNote(undefined, "3.19.0")).toBe("");
  });

  it("still attaches, because a rival on a random port is the worse answer", () => {
    // The note is printed and the attach continues — the mismatch is not a
    // branch. That is the whole point of the module.
    expect(DECK).toMatch(/const note = versionNote\(live\.version, PKG_VERSION\);/);
    expect(DECK).not.toMatch(/if \(note\) [\s\S]{0,40}(return|continue)/);
  });
});
