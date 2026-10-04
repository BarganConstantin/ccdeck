// The deck that owns a shared events.jsonl rotates it even when it writes
// nothing to it.
//
// Only the owner of a log may move it — the lowest-port deck naming the file —
// and the owner only ever looked at the file from its own push path, after
// appending a line. A scoped deck whose tree is quiet owns the default log and
// appends nothing, while the machine-wide deck beside it appends every line and,
// not being the owner, never rotates. So the 50 MB cap held for nobody and the
// file grew for as long as the two ran. The 30-second floor the rotation's own
// note describes, for "another deck appending to a log they share", never ran.
import { describe, it, expect, afterAll, vi } from "vitest";
import { existsSync, mkdtempSync, statSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-idle-rotation-"));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.XDG_CONFIG_HOME = join(DIR, "config");
if (!resolve(process.env.CLAUDE_CONFIG_DIR).startsWith(resolve(DIR))) throw new Error("sandbox escaped");

// @ts-expect-error — plain .mjs server module, no types
const { openEventLog } = await import("../../server/event-log.mjs");

afterAll(() => {
  vi.useRealTimers();
  rmTempDir(DIR);
});

const MB = 1024 * 1024;

describe("a log another deck fills", () => {
  it("is rotated by its owner on the clock, with no write of the owner's own", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const log = join(DIR, "events.jsonl");
    await openEventLog(log);
    // Another deck's appends, as far as this one can tell: the file is past the
    // cap and this process has written nothing to it.
    truncateSync(log, 51 * MB);

    vi.advanceTimersByTime(30_000);
    vi.useRealTimers();

    for (let i = 0; i < 300 && !existsSync(`${log}.1`); i++) await new Promise(r => setTimeout(r, 10));
    expect(existsSync(`${log}.1`), "the owner rolled the file over").toBe(true);
    expect(statSync(`${log}.1`).size).toBe(51 * MB);
    expect(existsSync(log) ? statSync(log).size : 0).toBe(0);
  });
});
