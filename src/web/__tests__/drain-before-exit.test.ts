// THE DECK EXITED WITH ACKNOWLEDGED EVENTS STILL QUEUED.
//
// /api/event answers {ok:true, seq} before the append lands — pushEvent calls
// appendLogLine fire-and-forget and the 200 goes out on the next statement.
// That is the right shape for the hook, which holds a 1.9s cap and must not
// wait on a filesystem. It was the wrong shape for the exit: shutdown() waited
// for the listener to drain and for nothing else.
//
// Measured on a sandboxed deck, 40 concurrent posts then SIGTERM:
//
//   before:  acknowledged 200: 40 of 40 / lines written: 12
//   after:   acknowledged 200: 40 of 40 / lines written: 40
//
// The twelve that landed were whole — the single write(2) holds — so this was
// the queue being abandoned, not a torn line. The restart path costs most: the
// replacement deck rebuilds its canvas from events.jsonl before it binds, so
// the sessions and tool calls in the dropped tail left the board permanently.
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// @ts-expect-error — plain .mjs server module, no types
const { appendLogLine, drainAppends } = await import("../../server/log-writer.mjs");

describe("draining the append queue", () => {
  it("waits for a queued line to reach the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccdeck-drain-"));
    try {
      const path = join(dir, "events.jsonl");
      // Queued and not awaited, exactly as pushEvent does it.
      for (let i = 0; i < 20; i++) appendLogLine(path, JSON.stringify({ seq: i }) + "\n");
      expect(await drainAppends()).toBe(true);
      const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
      expect(lines, "every queued line landed").toHaveLength(20);
      expect(JSON.parse(lines[19]).seq).toBe(19);
    } finally { rmTempDir(dir); }
  });

  it("returns at once when nothing is queued", async () => {
    // The ordinary case — an idle deck must not pay for this on every exit.
    const t0 = Date.now();
    expect(await drainAppends()).toBe(true);
    expect(Date.now() - t0).toBeLessThan(50);
  });

  it("gives up on its own deadline rather than holding the exit", async () => {
    // The whole point of the fire-and-forget shape is that no caller waits on
    // the disk indefinitely, and that has to stay true of the last caller. A
    // deadline reached is the old behaviour, which is no worse than before.
    const dir = mkdtempSync(join(tmpdir(), "ccdeck-drain-slow-"));
    try {
      const path = join(dir, "events.jsonl");
      appendLogLine(path, "{}\n");
      const t0 = Date.now();
      // A deadline shorter than any real write can be measured against.
      const ok = await drainAppends(0);
      const spent = Date.now() - t0;
      expect(typeof ok).toBe("boolean");
      expect(spent, "bounded, whatever the filesystem is doing").toBeLessThan(500);
    } finally { rmTempDir(dir); }
  });

  it("is what shutdown actually calls, before it closes the listener", () => {
    const deck = readFileSync(
      fileURLToPath(new URL("../../../bin/deck.js", import.meta.url)), "utf8");
    expect(deck).toContain("await drainAppends();");
    // Before the close, or the queue is abandoned exactly as it was.
    expect(deck.indexOf("await drainAppends();"))
      .toBeLessThan(deck.indexOf("server.close(() => process.exit(code));"));
  });
});
