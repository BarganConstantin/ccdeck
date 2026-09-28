// The appender's two waits give up at their deadline, and only there.
//
// drainAppends (the exit's) and flushAppends (the rotation's and the Clear's)
// share one bound: answer true once the queue has drained, false once `ms` has
// passed without that. The suite held the true half and a timing: a deadline of
// 0 answered SOME boolean in under half a second, which a wait that always
// answered true at once would also pass. What was never shown is the false
// half, because a real queue drains faster than any deadline worth waiting on.
//
// A FIFO with no reader is a queue that cannot drain until the test says so:
// opening one for writing blocks until a reader arrives, so the append queued
// on it stays in flight for exactly as long as the reader stays away. Windows
// has no mkfifo, so there the case is skipped; the rule is the same code on
// every platform.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { closeSync, constants, mkdtempSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

// @ts-expect-error — plain .mjs server module, no types
const { appendLogLine, drainAppends, flushAppends } = await import("../../server/log-writer.mjs");

describe.skipIf(process.platform === "win32")("the append queue's deadlines", () => {
  it("answer false while a line cannot land, and true once it has", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccdeck-append-deadline-"));
    const fifo = join(dir, "events.jsonl");
    execFileSync("mkfifo", [fifo]);
    let reader: number | null = null;
    try {
      appendLogLine(fifo, "{}\n");

      const t0 = Date.now();
      expect(await flushAppends(fifo, 100), "flush, with the line still waiting for a reader").toBe(false);
      expect(await drainAppends(100), "drain, likewise").toBe(false);
      expect(Date.now() - t0, "each gave up at its own deadline, not the default").toBeLessThan(2000);

      // A reader arrives. Non-blocking, so this open cannot wait on the writer;
      // it is enough for the writer's open to return and the line to go in.
      reader = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
      expect(await flushAppends(fifo, 5000), "the same flush once the line can land").toBe(true);
      expect(await drainAppends(5000)).toBe(true);
    } finally {
      if (reader !== null) closeSync(reader);
      rmTempDir(dir);
    }
  });
});
