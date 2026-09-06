// Two atomic writers hand-rolled temp-write-and-rename with a bare `rename`,
// which is the one call this repo wrote a retry ladder for.
//
// #786. `installer.mjs:206` declares `RENAME_RETRY_CODES = new Set(["EPERM",
// "EACCES", "EBUSY"])` with a ten-attempt linear backoff, because on Windows
// `MoveFileExW` refuses while any handle without `FILE_SHARE_DELETE` is open on
// source or target — and Defender and the search indexer open a file the
// instant it is written. Three of the five atomic writers in `src/server/`
// import `renameWithRetry`; these two, both added in the last few days, called
// `rename` straight from `node:fs/promises`.
//
// POSIX `rename(2)` has no such rule, so both shipped with green suites on
// macOS and Linux and a defect only Windows users would meet:
//
//   deck-prefs      `POST /api/prefs` 500s through `guard`, so the
//                   notifications switch silently does not stick.
//   browser-watch   none of the three writers catches the throw, so
//                   `GET /api/browser-watch` 500s and the panel goes blank —
//                   and the episode archive, the file that exists BECAUSE an
//                   intruder can clear the browser's own history, is not
//                   written.
//
// THE SHARING VIOLATION IS SYNTHESIZED, not provoked, so the Windows behaviour
// runs on every platform the suite does. The technique is
// codex-auth-rename-retry.test.ts's, which pins the same fix for the same
// reason one file over — a queue of rename faults injected through a mocked
// `node:fs/promises`, guarded so a stray path cannot touch anything real.
//
// Note the injected-`deps.rename` seam is deliberately NOT used for this: it
// REPLACES the ladder, so a flaky function passed that way would be testing the
// seam and not the retry. The first draft of this file did exactly that and
// failed, which is the whole reason for the paragraph above.
import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** `faults` is the queue of codes the next rename attempts fail with; `attempts`
 *  counts every call so a case can prove the ladder actually looped. */
const { fsCtl } = vi.hoisted(() => ({ fsCtl: { faults: [] as string[], attempts: 0 } }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    default: actual,
    rename: async (from: never, to: never) => {
      fsCtl.attempts++;
      const code = fsCtl.faults.shift();
      if (code) {
        const err = new Error(`${code}: sharing violation, rename`) as NodeJS.ErrnoException;
        err.code = code;
        throw err;
      }
      return actual.rename(from, to);
    },
  };
});

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-rename-retry-"));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
if (!resolve(process.env.CLAUDE_CONFIG_DIR).startsWith(resolve(DIR))) throw new Error("sandbox escaped");
afterAll(() => rmTempDir(DIR));

// @ts-expect-error — plain .mjs server modules, no types
const prefs = await import("../../server/deck-prefs.mjs");
// @ts-expect-error — ditto
const store = await import("../../server/browser-watch-store.mjs");

const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

beforeEach(() => { fsCtl.faults = []; fsCtl.attempts = 0; });

describe("the notifications preference", () => {
  it("still lands when Windows refuses the first three renames", async () => {
    fsCtl.faults = ["EPERM", "EBUSY", "EACCES"];
    await prefs.writePrefs({ notifications: false });
    expect(fsCtl.attempts, "the ladder did not loop").toBe(4);
    expect((await prefs.readPrefs()).notifications).toBe(false);
    expect(JSON.parse(await readFile(prefs.prefsPath(), "utf8")).notifications).toBe(false);
  });

  it("gives up on a code the ladder is not for, rather than looping on it", async () => {
    // ENOSPC will not clear itself, and spending 1.4s discovering that is worse
    // than failing at once. The route's `guard` turns the rejection into a 500,
    // which is the honest answer to a disk that is full.
    fsCtl.faults = ["ENOSPC"];
    await expect(prefs.writePrefs({ notifications: true })).rejects.toBeTruthy();
    expect(fsCtl.attempts).toBe(1);
  });
});

describe("the browser-watch archive", () => {
  it("still lands when Windows refuses the first renames", async () => {
    fsCtl.faults = ["EBUSY", "EBUSY"];
    const kept = [store.episodeKey("news.example", 1_700_000_000_000)];
    await store.writeStore({ settings: { ...store.DEFAULTS }, episodes: [], dismissed: kept });
    expect(fsCtl.attempts).toBe(3);
    expect((await store.readStore()).dismissed).toEqual(kept);
  });
});

describe("which rename each store reaches for", () => {
  it("is the retrying one, in both", () => {
    for (const rel of ["../../server/deck-prefs.mjs", "../../server/browser-watch-store.mjs"]) {
      const text = src(rel);
      expect(text, `${rel} still defaults to a bare rename`).toContain("deps.rename ?? renameWithRetry");
      expect(text, `${rel} imports rename from node:fs/promises again`)
        .not.toMatch(/import \{[^}]*\brename\b[^}]*\} from "node:fs\/promises"/);
    }
  });

  it("leaves no other server module renaming a temp file without the ladder", () => {
    // The general form, because the five call sites are not the interesting
    // number — the sixth somebody adds is. Any module that builds a `.tmp` and
    // moves it into place is doing the thing MoveFileExW refuses.
    const dir = fileURLToPath(new URL("../../server", import.meta.url));
    const names = readFileSync;
    void names;
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const offenders: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".mjs") || name === "installer.mjs") continue;
      const text = readFileSync(join(dir, name), "utf8");
      if (!/\.tmp[`"']|\.tmp\$|\}\.tmp/.test(text)) continue;
      if (!/\brename\b/.test(text)) continue;
      if (!text.includes("renameWithRetry")) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });
});
