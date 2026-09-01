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
  DEFAULTS, REACTIONS, mergeEpisodes, normalise, readStore, storePath, writeStore,
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

  it("keeps the window inside what Chrome can answer for", () => {
    // Chrome expires history at 90 days, so a wider window promises a past the
    // browser has already forgotten.
    expect(normalise({ windowDays: 365 }).windowDays).toBe(DEFAULTS.windowDays);
    expect(normalise({ windowDays: 90 }).windowDays).toBe(90);
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
      ["enabled", "gapMinutes", "quietMinutes", "reaction", "v", "windowDays"]);
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
