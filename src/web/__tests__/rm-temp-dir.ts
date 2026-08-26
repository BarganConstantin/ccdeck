// Deleting a test's temp directory on Windows, which is not the one-liner it is
// on POSIX.
//
// Extracted from discovery-live.test.ts, which paid for this knowledge twice.
// The original comment, kept because it is the whole reason this file exists:
//
//   A file with a handle still on it enters "delete pending" on Windows, and
//   every further open of that name — INCLUDING the lstat `rm -r` does on its
//   way through the directory — fails with EPERM until the last handle closes,
//   a few milliseconds later. That took a whole file out on the first Windows
//   run: not a test, a teardown.
//
//   `maxRetries` is the answer Node ships for it and documents by name — EBUSY,
//   EMFILE, ENFILE, ENOTEMPTY and EPERM, retried with a linear backoff — and it
//   is not sufficient on its own. Those retries wrap the unlink and the rmdir;
//   the FIRST thing rimrafSync does with a path is lstat it, and an EPERM there
//   goes to the Windows fix-up (a chmod, which fails the same way on a
//   delete-pending name) and is rethrown without ever reaching the retry loop.
//   That is how this failed a second time after maxRetries was added.
//
//   So the loop is out here as well, around the whole call. Both are kept: the
//   inner one is cheaper for the common case and the outer one covers the lstat
//   the inner one never sees.
//
// ENOTEMPTY is the spelling that brought this back a third time, in
// ingest-deep-payload.test.ts, whose server appends to events.jsonl
// fire-and-forget: the write can still be in flight when afterAll runs, so the
// directory is not empty at the moment rmdir reaches it.
import { rmSync } from "node:fs";

/** `rm -rf`, patient enough for a handle Windows has not finished closing. */
export function rmTempDir(path: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 20 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES" && code !== "ENOTEMPTY")) throw err;
      // Synchronous, because this runs from beforeEach/afterAll and from inside
      // a finally — none of which can await. A handle Windows is closing takes
      // microseconds; 20 × 25ms is half a second of patience for something that
      // has never needed more than one.
      const until = Date.now() + 25;
      while (Date.now() < until) { /* waiting out a delete Windows has not finished */ }
    }
  }
}
