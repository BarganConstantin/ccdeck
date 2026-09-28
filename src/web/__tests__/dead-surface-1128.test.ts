// What #993 deferred and #1128 collected, pinned so it does not come back.
//
// Each case asserts both halves, the way dead-surface-993.test.ts does its
// own: the change, and the thing the change must not have taken with it.
//
// Five symbols were exported with no reader outside their own file, the suite
// included. Each keeps its declaration and its in-file reader; only the
// `export` went.
//
// `dismissedSummaries`, a Set of sessions whose recap had been closed once,
// kept in localStorage. Its one `has()` decided whether to delete an entry
// before opening the recap anyway, so nothing it answered changed what opened.
// The Set, its load and save helpers and its storage key are gone; the recap
// still opens from `Show recap` and still closes.
//
// And the App.tsx half of #993's `replay` finding: the SSE comment said the
// reducer skips turn cleanup for replayed events. It has never read the flag
// since that cleanup keyed on event time.
//
// Then `readStored` / `seenStore`, one of the three #1128 left for a decision:
// storage.ts's guarded read, bypassed by hand-rolled copies, a sixth copy of
// the accessor guard in release-notes.ts, and no writer at all. The accessor
// is storage.ts's `localStore()` now, `seenStore` is gone, `writeStored` and
// `removeStored` are the writer, and the copies left are the files named
// below, each for a stated reason.
//
// Plain node: source text and module namespaces.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { clientPairs } from "./client-source";

const SERVER = fileURLToPath(new URL("../../server/", import.meta.url));
const WEB = fileURLToPath(new URL("../", import.meta.url));
const src = (root: string, file: string) => readFileSync(join(root, file), "utf8");

// file, symbol, the declaration that must survive, and the in-file read that
// still needs it.
const UNEXPORTED: [dir: string, file: string, symbol: string, declaration: RegExp, reader: RegExp][] = [
  [SERVER, "deck-probe.mjs", "DECK_CHALLENGE_TIMEOUT_MS", /^const DECK_CHALLENGE_TIMEOUT_MS = 400;$/m, /timeout: DECK_CHALLENGE_TIMEOUT_MS,/],
  [SERVER, "lan-engine.mjs", "ROUND_MS",                  /^const ROUND_MS = 10_000;$/m,               /timeoutMs: ROUND_MS/],
  [SERVER, "lan-beacon.mjs", "REPLY_COOLDOWN_MS",         /^const REPLY_COOLDOWN_MS = 2_000;$/m,       /now\(\) - repliedAt > REPLY_COOLDOWN_MS/],
  [SERVER, "lan-sync.mjs",   "newKeypair",                /^function newKeypair\(\) \{$/m,             /const made = newKeypair\(\);/],
  // Moved out of LanSyncSection.tsx with deckRows, its one reader.
  [WEB, "lan-roster.ts", "presenceLabel",
    /^function presenceLabel\(p: Peer, here: boolean, now: number\): string \{$/m, /presenceLabel\(p, present, now\)/],
];

describe("the in-file-only exports #1128 took off their modules' public surface", () => {
  for (const [dir, file, symbol, declaration, reader] of UNEXPORTED) {
    it(`${file} no longer exports ${symbol}, and still declares and reads it`, async () => {
      const text = src(dir, file);
      expect(text, `${symbol}'s declaration is gone from ${file}`).toMatch(declaration);
      expect(text, `${file} stopped reading ${symbol} where it did`).toMatch(reader);
      expect(text, `${file} exports ${symbol} inline`)
        .not.toMatch(new RegExp(`^export (?:const|let|var|function|async function|class) ${symbol}\\b`, "m"));
      for (const list of text.matchAll(/^export \{([^}]*)\}/gm)) {
        expect(list[1].split(",").map(s => s.trim()), `${file} exports ${symbol} in a list`).not.toContain(symbol);
      }
      expect(Object.keys(await import(/* @vite-ignore */ join(dir, file)))).not.toContain(symbol);
    });
  }
});

describe("dismissedSummaries — a Set App.tsx wrote on every recap close and nothing read", () => {
  const app = src(WEB, "App.tsx");

  it("is gone, with its helpers and its storage key", () => {
    expect(app).not.toMatch(/\bdismissedSummaries\b|DismissedSummaries|SUMMARY_DISMISSED_KEY|agent-dag\.summariesDismissed/);
  });

  it("and the recap still opens from the detail panel and still closes", () => {
    expect(app).toContain("onShowSummary={setSummaryFor}");
    expect(app).toMatch(/<SessionSummary[\s\S]{0,200}?onClose=\{\(\) => setSummaryFor\(null\)\}/);
  });
});

describe("HookEnvelope.replay — App.tsx's half of #993's finding", () => {
  it("no longer says the reducer reads the flag, and names the two readers that do", () => {
    // The handler and the comment about it moved to use-event-stream.ts, so
    // the negative is asked of both files and the readers of the new one.
    const app = src(WEB, "App.tsx");
    const stream = src(WEB, "use-event-stream.ts");
    expect(app).not.toContain("the reducer sees the flag");
    expect(stream).not.toContain("the reducer sees the flag");
    // The two the comment now names are the handler's.
    expect(stream).toMatch(/if \(isReplay\) coalescer\.replay\(\);/);
    expect(stream).toContain("chimeFor(env, isReplay)");
  });
});

describe("readStored / seenStore — one guard for the store, not one per hook", () => {
  it("has one accessor guard, in storage.ts, and release-notes.ts no longer carries its own", async () => {
    const notes = src(WEB, "release-notes.ts");
    expect(notes, "seenStore came back").not.toMatch(/\bfunction seenStore\b/);
    expect(Object.keys(await import("../release-notes"))).not.toContain("seenStore");
    const storage = await import("../storage");
    for (const name of ["readStored", "writeStored", "removeStored", "localStore"]) {
      expect(typeof (storage as Record<string, unknown>)[name], `storage.ts no longer exports ${name}`).toBe("function");
    }
    // What the seen markers are handed is the shared accessor.
    expect(src(WEB, "use-welcome-and-notes.ts")).toContain("const store = localStore();");
  });

  // The files that still touch `localStorage` themselves, with the reason each
  // one does. Code only — comments are stripped. A new hand-rolled guard fails
  // here; moving one of these onto storage.ts's helpers takes it off the list.
  const DIRECT: Record<string, string> = {
    "storage.ts": "the helpers themselves",
    "main.tsx": "the boot prune, handed the store inside its own try before App exists",
    // Left for the change their owners are making now, not for a reason of
    // their own. Each already wraps every read and write.
    "use-appearance.ts": "the theme and character switches",
    "use-browser-watch-badge.ts": "the browser watch's seen marker",
    "use-claude-fm.ts": "the station, volume and mute",
    "use-custom-tones.ts": "the custom chimes",
    "use-sound-switch.ts": "the finish-sound switch",
    "use-tone-prefs.ts": "the chime levels and figures",
  };

  it("is touched directly only by the files that say why", () => {
    const direct = clientPairs().filter(([, text]) => /\blocalStorage\b/.test(text)).map(([file]) => file).sort();
    expect(direct).toEqual(Object.keys(DIRECT).sort());
  });
});
