// The store is the only part of Browser Watch that writes anything, and the
// only part whose failure is silent: a settings file that reads back wrong
// changes what the watch does without changing what it says, and an archive
// that loses an episode loses the one record an intruder cannot reach.
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
import {
  DEFAULTS, REACTIONS, appendLog, logPath, mergeEpisodes, normalise, readStore, storePath, writeStore,
} from "../../server/browser-watch-store.mjs";

const episode = (host: string, startMs: number, over = {}) => ({
  host, startMs, endMs: startMs + 60_000, count: 1,
  urls: [{ url: `https://${host}/a`, timeMs: startMs }],
  ...over,
});

describe("settings as they will be used, whatever the file said", () => {
  it("starts off, because the archive is a record of pages somebody visited", () => {
    // The default that matters most. Everything else here is a threshold; this
    // one decides whether the deck writes a user's browsing to disk at all, and
    // a feature that does that without being asked has answered the wrong
    // question about consent.
    expect(normalise(undefined).enabled).toBe(false);
    expect(normalise({}).enabled).toBe(false);
    expect(DEFAULTS.enabled).toBe(false);
  });

  it("takes only a real true for on", () => {
    // `enabled: "false"` out of a hand-edited file is truthy, and truthiness is
    // the wrong test for the one switch that starts writing.
    expect(normalise({ enabled: "true" }).enabled).toBe(false);
    expect(normalise({ enabled: 1 }).enabled).toBe(false);
    expect(normalise({ enabled: true }).enabled).toBe(true);
  });

  it("refuses a threshold that would widen the gate to everything", () => {
    // A quiet gate of 0 makes every program navigation a finding, which is the
    // failure that turns this panel into noise nobody reads. A string "15" is
    // what a hand edit produces and would reach classify() as NaN.
    for (const bad of [0, -5, "15", null, NaN, Infinity, 10_000]) {
      expect(normalise({ quietMinutes: bad }).quietMinutes, String(bad))
        .toBe(DEFAULTS.quietMinutes);
    }
    expect(normalise({ quietMinutes: 5 }).quietMinutes).toBe(5);
  });

  it("has no window to configure, because the watch only looks forward", () => {
    // There was a `windowDays` here, and a select in the panel offering thirty
    // or ninety days of the user's browsing history. The watch reads nothing
    // from before the deck started now, so the setting is not tightened — it is
    // gone, and this case is what stops it coming back by habit.
    expect("windowDays" in normalise({ windowDays: 30 })).toBe(false);
    expect("windowDays" in DEFAULTS).toBe(false);
  });

  it("names a reaction the server knows, or none", () => {
    expect(normalise({ reaction: "quit-browser" }).reaction).toBe("quit-browser");
    expect(normalise({ reaction: "rm -rf /" }).reaction).toBe("notify");
    expect(REACTIONS).toContain("notify");
  });

  it("drops a field it has never heard of", () => {
    // The route hands `{...stored, ...body}` through here, so this is what
    // stops a POST writing arbitrary keys into the file.
    const out = normalise({ enabled: true, sudo: true, path: "/etc/passwd" }) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(
      ["enabled", "gapMinutes", "quietMinutes", "reaction", "v"]);
  });
});

describe("the archive, which is what an intruder cannot reach", () => {
  it("replaces a run that has grown rather than listing it twice", () => {
    // The card written at 17:05 said one page; by 17:44 the truth is thirteen.
    // Appending would show one run as two, and skipping would freeze the first
    // reading — so the key is the start, which does not move.
    const first = mergeEpisodes([], [episode("gitlab.example.com", 1000)]);
    const grown = mergeEpisodes(first, [
      episode("gitlab.example.com", 1000, { endMs: 9000, count: 13 }),
    ]);
    expect(grown).toHaveLength(1);
    expect(grown[0].count).toBe(13);
  });

  it("keeps the moment it first wrote one down, not the moment it last saw it", () => {
    // The archive's one claim Chrome's history cannot make: this existed at
    // this moment, whatever the browser says later. Re-stamping it on every
    // poll would throw that away.
    const first = mergeEpisodes([], [episode("a.example.com", 1000)], 111);
    const again = mergeEpisodes(first, [episode("a.example.com", 1000, { count: 4 })], 999);
    expect(again[0].archivedMs).toBe(111);
  });

  it("tells two hosts starting at the same instant apart", () => {
    const out = mergeEpisodes([], [episode("a.example.com", 1000), episode("b.example.com", 1000)]);
    expect(out).toHaveLength(2);
  });

  it("keeps which browser it happened in", () => {
    // A reaction has to tell ONE application to close a tab, and a log line
    // naming the host but not the browser leaves a two-browser machine
    // guessing. This is the one place the tag was lost between finding and
    // acting: it survived classify and toEpisodes and died in the archive.
    const out = mergeEpisodes([], [{ ...episode("a.example.com", 1000), browser: "brave" }]);
    expect(out[0].browser).toBe("brave");
    // Absent stays absent rather than becoming a guess.
    expect(mergeEpisodes([], [episode("b.example.com", 1000)])[0].browser).toBeNull();
  });

  it("holds the evidence, not just the accusation", () => {
    // An archive that kept the host and the count but dropped the URLs would
    // preserve the claim and lose the thing that lets a person judge it.
    const out = mergeEpisodes([], [episode("a.example.com", 1000)]);
    expect(out[0].urls).toEqual([{ url: "https://a.example.com/a", timeMs: 1000 }]);
  });

  it("returns newest first and stops growing without bound", () => {
    const many = Array.from({ length: 600 }, (_u, i) => episode("a.example.com", i * 1000));
    const out = mergeEpisodes([], many);
    expect(out).toHaveLength(500);
    expect(out[0].startMs).toBeGreaterThan(out[1].startMs);
    // Trimmed from the OLD end: what is dropped is what the browser is most
    // likely to still remember on its own.
    expect(out.at(-1)!.startMs).toBeGreaterThan(many[0].startMs);
  });
});

describe("the file on disk", () => {
  it("round-trips, and reads as defaults when it is not there", async () => {
    const home = mkdtempSync(join(tmpdir(), "bw-store-"));
    try {
      const empty = await readStore(home);
      expect(empty.settings).toEqual(DEFAULTS);
      expect(empty.episodes).toEqual([]);

      await writeStore({
        settings: { ...DEFAULTS, enabled: true, quietMinutes: 30 },
        episodes: [episode("a.example.com", 1000)],
      }, home);

      const back = await readStore(home);
      expect(back.settings.enabled).toBe(true);
      expect(back.settings.quietMinutes).toBe(30);
      expect(back.episodes).toHaveLength(1);
      expect(back.episodes[0].host).toBe("a.example.com");
    } finally { rmTempDir(home); }
  });

  it("survives a corrupt file rather than taking the deck down with it", async () => {
    // This file is on disk, which is where a half-written save and a hand edit
    // both come from. A throw here would reach a route that has no other reason
    // to fail.
    const home = mkdtempSync(join(tmpdir(), "bw-store-"));
    try {
      await writeStore({ settings: DEFAULTS, episodes: [] }, home);
      const { writeFileSync } = await import("node:fs");
      writeFileSync(storePath(home), "{ this is not json");
      const back = await readStore(home);
      expect(back.settings).toEqual(DEFAULTS);
      expect(back.episodes).toEqual([]);
    } finally { rmTempDir(home); }
  });

  it("leaves no temp file behind, and writes through one", async () => {
    // A plain write truncates the target first, so a crash mid-write leaves the
    // archive as a zero-length file — the one loss this feature cannot absorb.
    const home = mkdtempSync(join(tmpdir(), "bw-store-"));
    try {
      await writeStore({ settings: DEFAULTS, episodes: [episode("a.example.com", 1)] }, home);
      const { readdirSync } = await import("node:fs");
      const left = readdirSync(join(home, "agent-dag", "browser-watch"));
      expect(left).toEqual(["state.json"]);
      expect(existsSync(storePath(home))).toBe(true);
      // Readable as JSON by a person, and newline-terminated like every other
      // file this repo hand-edits.
      const raw = readFileSync(storePath(home), "utf8");
      expect(() => JSON.parse(raw)).not.toThrow();
      expect(raw.endsWith("\n")).toBe(true);
    } finally { rmTempDir(home); }
  });

  it("sits in its own directory, out of the deck-record namespace", () => {
    // readLiveDecks() reads every `.json` in ~/.claude/agent-dag and would have
    // to keep skipping this one forever. A directory is not a name it can
    // collide with.
    expect(storePath("/h")).toBe(join("/h", "agent-dag", "browser-watch", "state.json"));
  });
});

describe("the log file, which is what gets inspected later", () => {
  const withHome = async (fn: (home: string) => Promise<void>) => {
    const home = mkdtempSync(join(tmpdir(), "bw-log-"));
    try { await fn(home); } finally { rmTempDir(home); }
  };

  const run = {
    host: "gitlab.example.com", browser: "brave", count: 3,
    startMs: Date.UTC(2026, 7, 24, 17, 3, 0),
    endMs: Date.UTC(2026, 7, 24, 17, 44, 0),
    urls: [
      { url: "https://gitlab.example.com/x/-/jobs?scope=all&page=2", timeMs: Date.UTC(2026, 7, 24, 17, 3, 0) },
      { url: "https://gitlab.example.com/-/settings/ci_cd#runners", timeMs: Date.UTC(2026, 7, 24, 17, 44, 0) },
    ],
  };

  it("writes every address, in full", async () => {
    // THE REASON THE FILE EXISTS. A summary line says something happened and
    // leaves the reader unable to act: the question three days later is not
    // "did a program touch gitlab" but WHICH pages, because a jobs list and a
    // settings page mean different things.
    await withHome(async home => {
      await appendLog([run], home);
      const text = readFileSync(logPath(home), "utf8");
      for (const u of run.urls) expect(text).toContain(u.url);
    });
  });

  it("keeps the query string and the fragment", async () => {
    // Frequently the whole content of the visit. A log that tidied them away
    // would be neater and useless for its one job.
    await withHome(async home => {
      await appendLog([run], home);
      const text = readFileSync(logPath(home), "utf8");
      expect(text).toContain("?scope=all&page=2");
      expect(text).toContain("#runners");
    });
  });

  it("indents the addresses, so grep can separate them from the summary", async () => {
    await withHome(async home => {
      await appendLog([run], home);
      const lines = readFileSync(logPath(home), "utf8").split("\n").filter(Boolean);
      const summaries = lines.filter(l => !l.startsWith(" "));
      const urls = lines.filter(l => l.startsWith("    "));
      expect(summaries).toHaveLength(1);
      expect(urls).toHaveLength(2);
      expect(summaries[0]).toContain("gitlab.example.com");
      expect(summaries[0]).toContain("[brave]");
    });
  });

  it("stamps in local time, because the reader's afternoon is not UTC's", async () => {
    // The ISO stamp this replaced was off by the offset for everyone outside
    // London, and "what was happening at four yesterday" is the question.
    //
    // IN A TIMEZONE THAT IS NOT UTC, and computed from a fixed instant rather
    // than re-derived with the same expression the code uses. Two ways this
    // case used to prove nothing: it echoed `getHours()/getMinutes()` back at
    // itself, and nothing sets TZ anywhere in the config or the workflows — so
    // CI runs UTC, where the retired `toISOString()` spelling produces the same
    // HH:MM and the regression is undetectable on every leg that matters.
    const prevTz = process.env.TZ;
    process.env.TZ = "Asia/Tokyo";           // UTC+9, no DST
    try {
      // 2026-06-17T12:34:56Z is 21:34 in Tokyo and 12:34 in UTC.
      const at = Date.parse("2026-06-17T12:34:56.000Z");
      await withHome(async home => {
        await appendLog([{ ...run, startMs: at }], home);
        const head = readFileSync(logPath(home), "utf8").split("\n")[0];
        expect(head, "the stamp is not local time").toContain("21:34");
        expect(head, "the stamp is still UTC").not.toContain("12:34");
      });
    } finally {
      if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz;
    }
  });

  it("appends rather than rewrites — a log a program edits is not a log", async () => {
    await withHome(async home => {
      await appendLog([run], home);
      await appendLog([{ ...run, host: "second.example.com", urls: [] }], home);
      const text = readFileSync(logPath(home), "utf8");
      expect(text).toContain("gitlab.example.com");
      expect(text).toContain("second.example.com");
    });
  });

  it("writes nothing at all for nothing found", async () => {
    await withHome(async home => {
      await appendLog([], home);
      expect(existsSync(logPath(home))).toBe(false);
    });
  });
});

describe("a store written under rules that no longer apply", () => {
  const v1 = {
    v: 1,
    settings: { enabled: true, reaction: "quit-browser", quietMinutes: 30, gapMinutes: 20 },
    episodes: [{ host: "old.example.com", startMs: 1, endMs: 2, count: 1, urls: [], archivedMs: 1 }],
  };

  it("keeps the settings and drops the findings", async () => {
    // They are not the same kind of thing. Settings are what the user chose and
    // stay chosen; a FINDING produced by a rule the deck no longer applies is
    // not one it can stand behind. Version 1 archived whatever a thirty-day
    // sweep of the browser's history turned up — the user's own past browsing,
    // read before the watch existed.
    const home = mkdtempSync(join(tmpdir(), "bw-mig-"));
    try {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(join(home, "agent-dag", "browser-watch"), { recursive: true });
      writeFileSync(storePath(home), JSON.stringify(v1));

      const out = await readStore(home);
      expect(out.episodes).toEqual([]);
      expect(out.settings.enabled).toBe(true);
      expect(out.settings.quietMinutes).toBe(30);
      expect(out.settings.reaction).toBe("quit-browser");
      // And it says so, because hiding the rows is not the same as erasing them
      // and the caller is the one that can write.
      expect(out.migrated).toBe(true);
    } finally { rmTempDir(home); }
  });

  it("says nothing to migrate for a current store", async () => {
    const home = mkdtempSync(join(tmpdir(), "bw-mig-"));
    try {
      await writeStore({ settings: DEFAULTS, episodes: [] }, home);
      expect((await readStore(home)).migrated).toBe(false);
    } finally { rmTempDir(home); }
  });

  it("writes back at the current version, so it migrates once", async () => {
    const home = mkdtempSync(join(tmpdir(), "bw-mig-"));
    try {
      await writeStore({ settings: DEFAULTS, episodes: [] }, home);
      const raw = JSON.parse(readFileSync(storePath(home), "utf8"));
      expect(raw.v).toBeGreaterThan(1);
    } finally { rmTempDir(home); }
  });
});
