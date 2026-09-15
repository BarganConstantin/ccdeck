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
// What changed is that the deck asks a different question first: not "is this
// port free" but "is one of MY decks already up", answered from the registry
// and proved with the token handshake before a single byte is trusted.
//
// And then it keeps ONE. The first version attached only to a deck of exactly
// its own shape and built a second beside anything else — which is how a
// colleague's machine came to show up twice on the Local network list, two
// fingerprints at one address. Now the deck found is kept only when it serves
// what this start asked for and is not older; anything else is stopped and
// this start takes its place.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// @ts-expect-error — .mjs server module, no types
const mod = await import("../../server/running-deck.mjs");
const { liveDecks, olderVersion, sameShape, secondStart, serves, versionNote } = mod as {
  sameShape: (record: Rec | null, want: Partial<Rec>) => boolean;
  olderVersion: (running: unknown, ours: unknown) => boolean;
  serves: (record: Rec, o: { want?: Partial<Rec>; port?: number | null; ours?: string }) => boolean;
  secondStart: (o: {
    live?: Rec[]; want?: Partial<Rec>; port?: number | null; ours?: string; fresh?: boolean; respawn?: boolean;
  }) => { act: "start" | "attach" | "replace" | "yield"; deck?: Rec; stop: Rec[] };
  versionNote: (running: unknown, ours: unknown) => string;
  liveDecks: (o: {
    dir?: string;
    fs?: { readdir: (d: string) => Promise<string[]>; readFile: (p: string) => Promise<string> };
    self?: number;
    alive?: (pid: number) => boolean;
    prove?: (port: number, token: string) => Promise<boolean>;
  }) => Promise<Rec[]>;
};

type Rec = {
  pid: number; port: number; token: string;
  workspace: string; persist: string | null; codex: boolean; claude: boolean;
  version?: string;
  /** The Codex tree the deck tails, published since #1110. Absent on older records. */
  codexHome?: string | null;
};

const WANT = { workspace: "", persist: "/log/events.jsonl", codex: true, claude: true };
const OURS = "3.19.0";

/** A record of the default shape, differing only where asked. */
const rec = (over: Partial<Rec> = {}): Rec => ({
  pid: 4231, port: 4317, token: "t".repeat(64), ...WANT, version: OURS, ...over,
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

describe("a start keeps at most one deck", () => {
  it("starts when nothing is running", () => {
    expect(secondStart({ live: [], want: WANT, ours: OURS })).toEqual({ act: "start", stop: [] });
  });

  it("attaches to a deck that already serves what was asked, and stops nothing", () => {
    const d = rec();
    expect(secondStart({ live: [d], want: WANT, ours: OURS })).toEqual({ act: "attach", deck: d, stop: [] });
  });

  it("replaces a deck started differently, rather than standing a second beside it", () => {
    // Each of these used to leave two decks: a scoped deck, one with another
    // log, one whose environment found no Codex, one without the Claude side.
    for (const over of [
      { workspace: "/home/u/proj" }, { persist: "/other/events.jsonl" }, { persist: null },
      { codex: false }, { claude: false },
    ] as Partial<Rec>[]) {
      const d = rec(over);
      expect(secondStart({ live: [d], want: WANT, ours: OURS }), JSON.stringify(over))
        .toEqual({ act: "replace", stop: [d] });
    }
  });

  it("replaces an older deck, and keeps a newer one", () => {
    const old = rec({ version: "3.18.4" });
    expect(secondStart({ live: [old], want: WANT, ours: OURS }).act).toBe("replace");
    // Too old to publish a version at all is older than anything that does.
    const ancient = rec();
    delete (ancient as Partial<Rec>).version;
    expect(secondStart({ live: [ancient], want: WANT, ours: OURS }).act).toBe("replace");
    // An older copy launched beside a newer deck opens the newer one.
    expect(secondStart({ live: [rec({ version: "3.22.0" })], want: WANT, ours: OURS }).act).toBe("attach");
  });

  it("compares versions as numbers, not as text", () => {
    expect(olderVersion("3.9.0", "3.22.0")).toBe(true);
    expect(olderVersion("3.22.0", "3.9.0")).toBe(false);
    expect(olderVersion("3.22.0", "3.22.0")).toBe(false);
    expect(olderVersion("", "3.22.0")).toBe(true);
    // Nothing to compare against: no grounds to replace anything.
    expect(olderVersion("3.22.0", "")).toBe(false);
  });

  it("honours a named port, and treats `--port 0` as any", () => {
    const d = rec({ port: 4317 });
    expect(serves(d, { want: WANT, port: 4317, ours: OURS })).toBe(true);
    expect(serves(d, { want: WANT, port: 0, ours: OURS })).toBe(true);
    expect(secondStart({ live: [d], want: WANT, port: 4400, ours: OURS })).toEqual({ act: "replace", stop: [d] });
  });

  it("replaces even a deck that serves when `--new` asks for a fresh one", () => {
    const d = rec();
    expect(secondStart({ live: [d], want: WANT, ours: OURS, fresh: true })).toEqual({ act: "replace", stop: [d] });
  });

  it("keeps the first deck that serves and stops every other one", () => {
    // Leftovers from before the rule: the duplicate is ended on the next start.
    const a = rec({ pid: 1, port: 4317 });
    const b = rec({ pid: 2, port: 4322 });
    const scoped = rec({ pid: 3, port: 4330, workspace: "/x" });
    expect(secondStart({ live: [a, b, scoped], want: WANT, ours: OURS }))
      .toEqual({ act: "attach", deck: a, stop: [b, scoped] });
    expect(secondStart({ live: [scoped], want: WANT, ours: OURS }))
      .toEqual({ act: "replace", stop: [scoped] });
  });

  it("lets a respawn yield to a deck that started in its gap, and never stops one", () => {
    // A restart is THIS deck coming back. A deck found running got there while
    // it was down, was asked for more recently, and keeps its place.
    const d = rec();
    expect(secondStart({ live: [d], want: WANT, ours: OURS, respawn: true })).toEqual({ act: "yield", deck: d, stop: [] });
    expect(secondStart({ live: [], want: WANT, ours: OURS, respawn: true })).toEqual({ act: "start", stop: [] });
  });

  it("is asked of every start, respawns included, with nothing but the rule's inputs", () => {
    const call = /const plan = secondStart\(\{([\s\S]*?)\}\);/.exec(DECK)?.[1] ?? "";
    expect(call).toMatch(/live: await liveDecks\(\)/);
    expect(call).toMatch(/want: \{ workspace, persist, codex: wantCodex, claude: wantClaude, codexHome \}/);
    expect(call).toMatch(/fresh: flags\.new === true/);
    expect(call).toMatch(/respawn: RESPAWN/);
    // A typo is not an input, so a misspelling cannot decide anything — the
    // lesson of `ccdeck --stpo` building a second deck through the old guard.
    expect(call).not.toMatch(/unknown|incomplete/);
    // And no gate in front of it that a respawn or a flag could walk around.
    expect(DECK).not.toContain("asksForOwnDeck");
    expect(DECK).toMatch(/if \(plan\.act === "yield"\) \{[\s\S]{0,200}process\.exit\(0\);/);
  });

  it("stops what it replaces before it binds anything, and says why", () => {
    const stop = DECK.indexOf("const out = await stopDeck(d)");
    const bind = DECK.indexOf("const starting = startServer({");
    expect(stop).toBeGreaterThan(0);
    expect(stop).toBeLessThan(bind);
    expect(DECK).toContain("stopped the deck on ${d.port}");
    expect(DECK).toContain("you asked for a fresh one");
    expect(DECK).toContain("it was started with different settings");
  });

  it("prints a typo's warning on the attach path, which is what was actually needed", () => {
    const ask = DECK.indexOf("if (plan.act === \"attach\") {");
    const unknown = DECK.indexOf("reportUnknownFlags(flags.unknown);", ask);
    const incomplete = DECK.indexOf("reportIncompleteFlags(flags.incomplete);", ask);
    const bind = DECK.indexOf("const starting = startServer({");
    expect(unknown).toBeGreaterThan(ask);
    expect(incomplete).toBeGreaterThan(ask);
    expect(unknown).toBeLessThan(bind);
    expect(incomplete).toBeLessThan(bind);
  });

  it("is offered by the parser, and documented as the replace it now is", () => {
    const args = readFileSync(
      fileURLToPath(new URL("../../server/args.mjs", import.meta.url)), "utf8",
    );
    expect(args).toContain('a === "--new"');
    expect(DECK).toContain("--new                Replace the running deck with a fresh one.");
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

  it("does not attach a start to a deck that reads another Codex tree", () => {
    // #1110 put the tree a deck tails on its record, as `codexHome`; this is the
    // start's half of the same rule. Before it, `CODEX_HOME=/srv/codex ccdeck`
    // found the deck already reading ~/.codex, matched on the four fields above,
    // and attached — so the tree it was started for was never read, and nothing
    // said so. A different tree is a different canvas, and what a start does
    // with a deck of a different shape is replace it.
    const wantTree = (codexHome: string) => ({ ...WANT, codexHome });
    const onHome = rec({ codexHome: "/home/u/.codex" });
    expect(sameShape(onHome, wantTree("/home/u/.codex"))).toBe(true);
    expect(sameShape(onHome, wantTree("/srv/codex"))).toBe(false);
    expect(secondStart({ live: [onHome], want: wantTree("/srv/codex"), ours: OURS }).act).toBe("replace");
    // Either side silent keeps today's answer: a record written before #1110
    // cannot say, and a selector that names no tree matches any tree.
    expect(sameShape(rec(), wantTree("/srv/codex"))).toBe(true);
    expect(sameShape(onHome, WANT)).toBe(true);
  });

  it("marks in --status the deck a bare start would open, Codex tree included", () => {
    // #1134: `--status` built its "`ccdeck` opens this one" selector from the four
    // flags alone, so every tree matched it. Once the start began passing its tree
    // (the case above), the marker could name the very deck the next `ccdeck`
    // replaces. The selector now carries the tree, worked out the start's way.
    expect(DECK).toMatch(/mine\.codexHome = codexHomeField\(mine\.codex\);/);
    const selector = DECK.slice(DECK.indexOf("const mine = {"), DECK.indexOf("const opens = decks.find"));
    expect(selector).toContain("codexHomeField(");
  });

  it("is asked with the tree this start would read, spelled the way the record spells it", () => {
    // Resolved beside the other three inputs, not inside the call — the case
    // above holds the call to values already settled.
    expect(DECK).toMatch(/const codexHome = codexHomeField\(wantCodex\);/);
    // One function for both ends, so a start and a record cannot canonicalise
    // the same tree two ways and disagree about a symlinked ~/.codex.
    const installer = readFileSync(
      fileURLToPath(new URL("../../server/installer.mjs", import.meta.url)), "utf8",
    );
    expect(installer).toMatch(/export function codexHomeField\(codex\)/);
    expect(installer).toMatch(/codexHome: codexHomeField\(codex\)/);
  });

  it("never passes a deck older than the `claude` field for one, so it is replaced", () => {
    const old = rec();
    delete (old as Partial<Rec>).claude;
    expect(sameShape(old, WANT)).toBe(false);
    expect(secondStart({ live: [old], want: WANT, ours: OURS }).act).toBe("replace");
  });

  it("publishes both fields, or nothing downstream can compare them", () => {
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

describe("a port has to prove itself before anything is done to it", () => {
  it("challenges every record and returns the provers in port order", async () => {
    const { fs } = registry([
      rec({ pid: 11, port: 4319 }),
      rec({ pid: 12, port: 4318, workspace: "/elsewhere" }),
      rec({ pid: 13, port: 4317 }),
    ]);
    const prove = vi.fn(async () => true);
    const found = await liveDecks({ fs, self: 99, alive: () => true, prove });
    // Every one: a start about to STOP a deck must know it is one, whatever its
    // shape. Lowest port first — electWriters' rule, so the answer is the same
    // every time it is asked.
    expect(found.map(d => d.pid)).toEqual([13, 12, 11]);
    expect(prove).toHaveBeenCalledTimes(3);
  });

  it("leaves out a port that answers wrongly, rather than trusting it", async () => {
    // #695: a record left by a deck that is gone passes a signal-0 probe forever
    // once the OS recycles its pid, and the port it names may by then belong to
    // anything at all. A collector on 4317 cannot hash a token it never had —
    // and must never be sent a shutdown either.
    const { fs } = registry([rec({ pid: 11, port: 4317 }), rec({ pid: 12, port: 4318 })]);
    const prove = vi.fn(async (port: number) => port === 4318);
    const found = await liveDecks({ fs, self: 99, alive: () => true, prove });
    expect(found.map(d => d.port)).toEqual([4318]);
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
    const found = await liveDecks({ fs, self: 99, alive: (pid: number) => pid !== 15, prove });
    expect(found).toEqual([]);
    expect(prove).not.toHaveBeenCalled();
  });

  it("answers `no deck` for a directory it cannot read, and never throws on the boot path", async () => {
    const prove = vi.fn(async () => true);
    const fs = { readdir: async () => { throw new Error("EACCES"); }, readFile: async () => "" };
    await expect(liveDecks({ fs, self: 1, alive: () => true, prove })).resolves.toEqual([]);
    // One corrupt record must not take the others down with it.
    const half = {
      readdir: async () => ["1.json", "2.json"],
      readFile: async (p: string) => (String(p).endsWith("1.json") ? "{ not json" : JSON.stringify(rec({ pid: 2 }))),
    };
    const found = await liveDecks({ fs: half, self: 1, alive: () => true, prove });
    expect(found.map(d => d.pid)).toEqual([2]);
  });

  it("keeps the handshake in a leaf, so nothing has to import the server to ask", () => {
    // The whole reason this module does not import the server: importing it
    // arms its timers. A default would have to come from somewhere, and every
    // somewhere is either that import or a second spelling of the crypto.
    expect(SRC).not.toMatch(/from "\.\/index\.mjs"/);
    // They live in a leaf both sides can reach, and index.mjs re-exports them
    // under the names its own callers and tests have always used, so there is
    // still exactly one spelling of the handshake in the package.
    const PROBE = readFileSync(
      fileURLToPath(new URL("../../server/deck-probe.mjs", import.meta.url)), "utf8",
    );
    expect(PROBE).toContain("export function challengeDeck(");
    expect(PROBE).toContain("export function isProcessAlive(");
    expect(PROBE).toContain("export function challengeProof(");
    expect(INDEX).toContain('from "./deck-probe.mjs"');
    expect(INDEX).toContain("export { challengeDeck, challengeProof, isProcessAlive };");
    // And the leaf really is a leaf: two node builtins, nothing of ours.
    expect([...PROBE.matchAll(/^import .*from "(.+)";$/gm)].map(m => m[1]))
      .toEqual(["node:crypto", "node:http"]);
  });
});

describe("what the attach does and does not disturb", () => {
  it("asks before it binds, installs, probes or paints", () => {
    // The position is the point: an attach must leave the machine exactly as it
    // found it, so it happens before the port, the hooks, the tool probes, the
    // banner and the discovery file.
    const ask = DECK.indexOf("const plan = secondStart({");
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

  it("waits for the launcher chain instead of exiting out from under it", () => {
    // Every child openUrl spawns is unref'd, so an immediate exit ends this
    // process before a missing xdg-open has been answered by gio — and then no
    // browser opens and nothing says why. The boot path never had to think
    // about this because it stays alive forever.
    expect(DECK).toMatch(/openUrl\(liveUrl\);[\s\S]{0,400}await sleep\(LAUNCH_GRACE_MS\);/);
  });

  it("says a second deck was not started, and how to get a fresh one", () => {
    // Without it the command looks like it did nothing at all, which is the
    // other way to be confusing about this.
    expect(DECK).toContain("no second deck was started");
    // The backtick is escaped in the source: the line lives inside a template
    // literal, and the flag is quoted for the shell in the message itself.
    expect(DECK).toContain("--new\\` replaces it with a fresh one");
  });

  it("has nothing left to warn about older decks, because they are replaced", () => {
    expect(DECK).not.toContain("too old to be recognised");
  });
});

describe("the off switch ends every deck", () => {
  it("stops them all unless one is named by port", () => {
    // There is meant to be one. A second is a leftover, and an off switch that
    // ended one of two would leave the machine running.
    expect(DECK).toContain("const wanted = named !== null ? decks.filter(d => d.port === named) : decks;");
    expect(DECK).toContain("--stop               Stop the running deck.");
  });
});

describe("a newer deck kept on the port is said out loud", () => {
  it("names both versions, and which way round they are", () => {
    expect(versionNote("3.22.0", "3.19.0")).toMatch(/running v3\.22\.0, newer than the v3\.19\.0 you launched/);
    expect(versionNote("3.18.0", "3.19.0")).toMatch(/older than the v3\.19\.0/);
  });

  it("says nothing when there is nothing useful to say", () => {
    expect(versionNote("3.19.0", "3.19.0")).toBe("");
    // A deck too old to report one: "unknown" beside a number is noise.
    expect(versionNote("", "3.19.0")).toBe("");
    expect(versionNote(undefined, "3.19.0")).toBe("");
  });

  it("prints it on the attach and carries on", () => {
    expect(DECK).toMatch(/const note = versionNote\(live\.version, PKG_VERSION\);/);
    expect(DECK).not.toMatch(/if \(note\) [\s\S]{0,40}(return|continue)/);
  });
});

describe("what a launcher that only asks never does", () => {
  const index = readFileSync(fileURLToPath(new URL("../../server/index.mjs", import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

  it("does not start LAN sync from the import, only from a listen that succeeded", () => {
    // Reported from a terminal, the day 3.21.0 shipped: `npx ccdeck` beside a
    // running deck printed `lan sync (listen): listen EADDRINUSE` and, under
    // it, `deck already running`. bin/deck.js imports the server module to
    // ask the registry, and the module bound the beacon and the sync listener
    // on the way in — a port grabbed by a process about to exit, and a line
    // about it in front of the one answer the person wanted.
    expect(index).not.toMatch(/readPrefs\(\)\.then\([^)]*applyLanPrefs/);
    expect(index).toMatch(/const _prefsRead = readPrefs\(\)\.then\(p => \{ _prefs = p; \}\)/);
    // In the listen loop, after the bind that took, beside the other things a
    // serving process starts and an asking one must not.
    const loop = /for \(const candidate of candidates\) \{([\s\S]*?)\n  \}\n  throw listenFailure/.exec(index)?.[1] ?? "";
    expect(loop).toMatch(/await tryListen\(server, candidate, host\);[\s\S]*startSystemMetrics\(\);[\s\S]*_prefsRead\.then\(\(\) => applyLanPrefs\(\)\)/);
    // And once: a second call site would be a second boot.
    expect([...index.matchAll(/_prefsRead\.then/g)]).toHaveLength(1);
  });
});
