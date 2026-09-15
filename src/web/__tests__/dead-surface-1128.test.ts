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
// Plain node: source text and module namespaces.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const SERVER = fileURLToPath(new URL("../../server/", import.meta.url));
const WEB = fileURLToPath(new URL("../", import.meta.url));
const src = (root: string, file: string) => readFileSync(join(root, file), "utf8");

// file, symbol, the declaration that must survive, and the in-file read that
// still needs it.
const UNEXPORTED: [dir: string, file: string, symbol: string, declaration: RegExp, reader: RegExp][] = [
  [SERVER, "deck-probe.mjs", "DECK_CHALLENGE_TIMEOUT_MS", /^const DECK_CHALLENGE_TIMEOUT_MS = 400;$/m, /timeout: DECK_CHALLENGE_TIMEOUT_MS,/],
  [SERVER, "lan-engine.mjs", "ROUND_MS",                  /^const ROUND_MS = 10_000;$/m,               /timeoutMs: ROUND_MS/],
  [SERVER, "lan-socket.mjs", "REPLY_COOLDOWN_MS",         /^const REPLY_COOLDOWN_MS = 2_000;$/m,       /now\(\) - repliedAt > REPLY_COOLDOWN_MS/],
  [SERVER, "lan-sync.mjs",   "newKeypair",                /^function newKeypair\(\) \{$/m,             /const made = newKeypair\(\);/],
  [WEB, "components/LanSyncSection.tsx", "presenceLabel",
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
    const app = src(WEB, "App.tsx");
    expect(app).not.toContain("the reducer sees the flag");
    // The two the comment now names are the handler's.
    expect(app).toMatch(/if \(isReplay\) coalescer\.replay\(\);/);
    expect(app).toContain("chimeFor(env, isReplay)");
  });
});
