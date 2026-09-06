// Two spellings of one events log made two decks both its owner.
//
// #793. `bin/deck.js` computed the published log path with `resolve` alone,
// which settles relative-vs-absolute and nothing else — while the comment
// directly over it said the goal word for word: "two spellings of one file
// would read as two files."
//
// The election then only case-folds:
//
//     `log:${foldsCase(platform) ? log.toLowerCase() : log}`
//
// so two decks reaching one file through different spellings landed in
// different groups and BOTH were elected. Every hook event appended twice — the
// duplicate-tools-after-restart symptom the election exists to end. And
// `logSharing()` compares the same raw string, so both answered `mine: true`
// and `POST /api/clear` ran `truncate(path, 0)` on a file this deck does not
// own: the #698 history loss the ownership gate was added to prevent.
//
// It needs no odd user action. `claudeConfigDir()` derives from `homedir()`, so
// on Windows a shell with an 8.3-shortened `USERPROFILE` yields a different
// default string than one with the long form; `subst`, mapped drives and
// junctions do it too, and on macOS `/tmp` against `/private/tmp` does.
//
// The workspace two lines away already had this treatment —
// `canonicalWorkspace` is `realpathSync.native` with three comments naming 8.3
// expansion as the reason. This is that rule reaching the value beside it.
import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = realpathSync.native(mkdtempSync(join(tmpdir(), "ccdeck-canon-log-")));
afterAll(() => rmTempDir(DIR));

// @ts-expect-error — plain .mjs server module, no types
const { canonicalLogPath, electWriters } = await import("../../server/log-writer.mjs");

const deckJs = () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  return readFileSync(fileURLToPath(new URL("../../../bin/deck.js", import.meta.url)), "utf8");
};

describe("one spelling per file", () => {
  it("answers the same path for a file reached through a symlinked directory", () => {
    // The portable stand-in for 8.3 names, `subst` and junctions: one file, two
    // spellings, neither of them wrong. On macOS `/tmp` → `/private/tmp` is the
    // same shape and needs no setup at all.
    const real = join(DIR, "real");
    const link = join(DIR, "link");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "events.jsonl"), "");
    symlinkSync(real, link, "dir");

    const a = canonicalLogPath(join(real, "events.jsonl"));
    const b = canonicalLogPath(join(link, "events.jsonl"));
    expect(b, "the two spellings still read as two files").toBe(a);
  });

  it("canonicalises the directory when the file is not there yet", () => {
    // The half a plain realpath misses, and the one that matters most: on a
    // first run the log does not exist, `realpath` throws ENOENT, and falling
    // back to the resolved string would leave the two spellings different for
    // exactly the run that creates the file.
    const real = join(DIR, "fresh");
    const link = join(DIR, "fresh-link");
    mkdirSync(real, { recursive: true });
    symlinkSync(real, link, "dir");

    const a = canonicalLogPath(join(real, "events.jsonl"));
    const b = canonicalLogPath(join(link, "events.jsonl"));
    expect(b).toBe(a);
    expect(a.endsWith("events.jsonl"), "the basename was lost").toBe(true);
  });

  it("still settles a relative path, which is what it did before", () => {
    const rel = canonicalLogPath("./events.jsonl");
    expect(rel).toBe(canonicalLogPath(resolve("./events.jsonl")));
    expect(rel.startsWith(".")).toBe(false);
  });

  it("falls back to the resolved path when neither the file nor its parent exists", () => {
    // Nothing to canonicalise against, and nothing to be gained by throwing:
    // the deck is about to create the tree, and the caller two lines later
    // makes the directory.
    const nowhere = join(DIR, "no", "such", "dir", "events.jsonl");
    expect(canonicalLogPath(nowhere)).toBe(resolve(nowhere));
  });

  it("keeps an empty answer empty, for the --no-persist deck", () => {
    expect(canonicalLogPath("")).toBe("");
    expect(canonicalLogPath("   ")).toBe("");
    expect(canonicalLogPath(undefined as never)).toBe("");
  });
});

describe("what that means for the election", () => {
  it("elects one writer for two decks that spell the log differently", () => {
    // The defect, end to end, through the real `electWriters`. Before the fix
    // these two land in different groups and BOTH come back elected.
    const real = join(DIR, "shared");
    const link = join(DIR, "shared-link");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "events.jsonl"), "");
    symlinkSync(real, link, "dir");

    const decks = [
      { pid: 100, port: 4317, persist: canonicalLogPath(join(real, "events.jsonl")) },
      { pid: 200, port: 4318, persist: canonicalLogPath(join(link, "events.jsonl")) },
    ];
    // `electWriters` answers a Set of the deck records that write.
    const elected = electWriters(decks, "darwin");
    expect(elected.size, "both decks were elected to write one file").toBe(1);
    // And it is the lower port, which is the rule the module states — so this
    // is the election working, not a Set collapsing two identical objects.
    expect([...elected][0].port).toBe(4317);
  });

  it("still elects both when the two logs are genuinely different files", () => {
    // The other direction: canonicalising must not collapse two real files.
    // /srv/a/events.jsonl and /srv/b/events.jsonl each need a writer.
    const a = join(DIR, "a");
    const b = join(DIR, "b");
    for (const d of [a, b]) { mkdirSync(d, { recursive: true }); writeFileSync(join(d, "events.jsonl"), ""); }
    const decks = [
      { pid: 100, port: 4317, persist: canonicalLogPath(join(a, "events.jsonl")) },
      { pid: 200, port: 4318, persist: canonicalLogPath(join(b, "events.jsonl")) },
    ];
    const elected = electWriters(decks, "darwin");
    expect(elected.size).toBe(2);
    expect([...elected].map((d: { port: number }) => d.port).sort()).toEqual([4317, 4318]);
  });
});

describe("the value the discovery file publishes", () => {
  it("comes from canonicalLogPath, not from resolve", () => {
    // The whole fix is which function computes the published string: the hook
    // and every other deck group by exactly this value.
    const src = deckJs();
    expect(src).toContain("canonicalLogPath(flags.history ??");
    expect(src, "the bare resolve is back on the log path")
      .not.toMatch(/:\s*resolve\(flags\.history/);
  });
});
