// The transcript gate folds case exactly where the log election does.
//
// isClaudeTranscriptPath compares a caller's `transcript_path` against the
// directories Claude Code writes transcripts in, case-insensitively where the
// filesystem is — and it used to spell "where the filesystem is" out for
// itself, as `win32 || darwin`, beside foldsCase in log-election.mjs, which
// answers the same question for the events log and the Codex workspace test.
// Two spellings of one rule are two chances for `--workspace` and the gate to
// disagree about whether /Users/a and /users/a are one directory. The gate asks
// foldsCase now, and this walks the three platforms through both.
import { afterEach, describe, it, expect } from "vitest";
import { join, resolve } from "node:path";

// @ts-expect-error — plain .mjs server module, no types
const { isClaudeTranscriptPath } = await import("../../server/transcript-gate.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { foldsCase } = await import("../../server/log-election.mjs");

const real = Object.getOwnPropertyDescriptor(process, "platform")!;
const pretend = (platform: string) =>
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
afterEach(() => { Object.defineProperty(process, "platform", real); });

// Built with this machine's own path functions. node:path is chosen when it
// loads, so the gate's `resolve` is POSIX on Linux and macOS and win32 on
// Windows — a drive letter and backslashes — whatever platform is pretended
// below. A POSIX-shaped fixture therefore never matched on a Windows runner
// (`D:\home\me\...` against `/home/me/...`), and only the fold is under test.
const ROOT = resolve("/home/me/.claude/projects");
const ROOTS = [ROOT];
const SAME_CASE = join(ROOT, "-w-demo", "abc.jsonl");
const OTHER_CASE = SAME_CASE
  .replace("home", "HOME").replace("me", "Me").replace(".claude", ".Claude").replace("projects", "Projects");

describe("isClaudeTranscriptPath on each platform", () => {
  for (const platform of ["linux", "darwin", "win32", "freebsd"]) {
    it(`${platform}: accepts another casing exactly when foldsCase says the filesystem folds it`, () => {
      pretend(platform);
      expect(OTHER_CASE, "the fixture lost its other casing").not.toBe(SAME_CASE);
      expect(isClaudeTranscriptPath(SAME_CASE, ROOTS)).toBe(true);
      expect(isClaudeTranscriptPath(OTHER_CASE, ROOTS)).toBe(foldsCase(platform));
    });
  }

  it("folds on the two platforms whose default filesystems do, and nowhere else", () => {
    // Stated outright as well, so a change to foldsCase is a change seen here
    // rather than one this file silently follows.
    expect(["linux", "darwin", "win32", "freebsd"].filter(p => foldsCase(p))).toEqual(["darwin", "win32"]);
  });
});
