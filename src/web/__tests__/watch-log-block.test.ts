// What one episode looks like in watch.log, the file a person reads three days
// later without opening the panel.
//
// The shape is the contract: a summary line at column zero and every address
// indented under it, so `grep -v '^ '` gives the summaries and `grep '^  '` the
// addresses; local time, because the question is "what was happening at four
// yesterday afternoon"; every address whole, query string and fragment
// included. browser-watch-store.test.ts reads the file appendLog writes; this
// pins the text itself, line by line, and that appendLog writes exactly it.
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
// @ts-expect-error — .mjs server module, no types
import { appendLog, logBlock, logPath } from "../../server/browser-watch-log.mjs";

/** A local wall-clock moment, so the expected text holds in every time zone. */
const at = (h: number, m: number, s: number) => new Date(2026, 8, 28, h, m, s).getTime();

const episode = (over: Record<string, unknown> = {}) => ({
  host: "gitlab.example.test",
  browser: "chrome",
  startMs: at(16, 5, 9),
  endMs: at(16, 5, 39),
  count: 2,
  urls: [
    { url: "https://gitlab.example.test/-/jobs?scope=all", timeMs: at(16, 5, 9) },
    { url: "https://gitlab.example.test/-/settings#servicii", timeMs: at(16, 5, 39) },
  ],
  ...over,
});

describe("logBlock", () => {
  it("writes the summary at column zero and every address under it", () => {
    expect(logBlock(episode()).split("\n")).toEqual([
      "2026-09-28 16:05:09  gitlab.example.test  2 pages [chrome]",
      "    16:05:09  https://gitlab.example.test/-/jobs?scope=all",
      "    16:05:39  https://gitlab.example.test/-/settings#servicii",
    ]);
  });

  it("says how long it ran only once that is a minute or more, rounded", () => {
    expect(logBlock(episode({ endMs: at(16, 6, 8) })).split("\n")[0])
      .toBe("2026-09-28 16:05:09  gitlab.example.test  2 pages [chrome]");
    expect(logBlock(episode({ endMs: at(16, 6, 9) })).split("\n")[0])
      .toBe("2026-09-28 16:05:09  gitlab.example.test  2 pages over 1m [chrome]");
    expect(logBlock(episode({ endMs: at(16, 6, 39) })).split("\n")[0])
      .toBe("2026-09-28 16:05:09  gitlab.example.test  2 pages over 2m [chrome]");
  });

  it("counts one page in the singular and leaves out a browser it does not know", () => {
    const one = episode({ count: 1, browser: null, urls: [] });
    expect(logBlock(one)).toBe("2026-09-28 16:05:09  gitlab.example.test  1 page");
  });

  it("pads every field of the stamp to two digits", () => {
    const early = new Date(2026, 0, 2, 3, 4, 5).getTime();
    const block = logBlock(episode({ startMs: early, endMs: early, urls: [{ url: "u", timeMs: early }] }));
    expect(block.split("\n")).toEqual([
      "2026-01-02 03:04:05  gitlab.example.test  2 pages [chrome]",
      "    03:04:05  u",
    ]);
  });
});

describe("appendLog", () => {
  it("writes exactly the blocks, one after another, each ending its line", async () => {
    const home = mkdtempSync(join(tmpdir(), "ccdeck-log-block-"));
    try {
      const two = [episode(), episode({ host: "news.example.test", browser: "brave", urls: [] })];
      await appendLog(two, home);
      expect(readFileSync(logPath(home), "utf8")).toBe(two.map(logBlock).join("\n") + "\n");
    } finally {
      rmTempDir(home);
    }
  });
});
