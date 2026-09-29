// A transcript path that is not there must not cost a real session its cursor.
//
// The cursor cache is capped at 256 sessions and evicts the one scanned least
// recently. A path was given its slot before the scan looked at the file, so a
// path that does not exist took a slot as surely as one that does, and could
// evict a real session's cursor — whose next pass then read its transcript
// again from byte 0. The totals stayed right; the cost is the full re-read,
// which #611 measured at seconds of CPU for one heavy session.
//
// So the file is looked at first, and only a path that is there gets a slot.
import { describe, it, expect, afterAll, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-scan-missing-"));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.XDG_CONFIG_HOME = join(DIR, "config");
if (!resolve(process.env.CLAUDE_CONFIG_DIR).startsWith(resolve(DIR))) throw new Error("sandbox escaped");

const SERVER = fileURLToPath(new URL("../../server/index.mjs", import.meta.url));

afterAll(() => rmTempDir(DIR));

type Scanner = { readUsageFromTranscript(path: string): Promise<{ input_tokens: number } | null> };

/** A cursor cache nothing else has filled — the cursors are module state. */
async function freshScanner(): Promise<Scanner> {
  vi.resetModules();
  // @ts-expect-error — .mjs server module, no types
  return await import(SERVER);
}

function assistant(inputTokens: number): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      model: "claude-opus-5",
      usage: { input_tokens: inputTokens, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }) + "\n";
}

// Matches MAX_TRANSCRIPT_SCAN_SESSIONS in src/server/transcript-scan.mjs;
// transcript-scan-session-cap.test.ts fails if the two drift.
const SESSION_CAP = 256;

describe("a transcript path that is not there", () => {
  it("takes no cursor slot, so a real session keeps its cursor", async () => {
    const scan = await freshScanner();
    const projects = join(DIR, "claude", "projects");
    mkdirSync(join(projects, "-w"), { recursive: true });
    const real = join(projects, "-w", "real.jsonl");
    const first = assistant(100);
    writeFileSync(real, first);
    expect((await scan.readUsageFromTranscript(real))!.input_tokens).toBe(100);

    for (let i = 0; i < SESSION_CAP; i++) {
      expect(await scan.readUsageFromTranscript(join(projects, "x", `not-there-${i}.jsonl`))).toBeNull();
    }

    // Same byte length as the folded line, so a cursor parked at its end cannot
    // tell the prefix changed: a kept cursor folds only the appended line (101),
    // a lost one starts at byte 0 and folds the rewrite too (901).
    const rewritten = first.replace('"input_tokens":100', '"input_tokens":900');
    expect(rewritten.length).toBe(first.length);
    writeFileSync(real, rewritten);
    appendFileSync(real, assistant(1));
    expect((await scan.readUsageFromTranscript(real))!.input_tokens).toBe(101);
  });

  it("still reads a file that appears after it was first named", async () => {
    // The slot is refused, not the path: once the file is there it is read.
    const scan = await freshScanner();
    const later = join(DIR, "claude", "projects", "-w", "later.jsonl");
    expect(await scan.readUsageFromTranscript(later)).toBeNull();
    writeFileSync(later, assistant(5));
    expect((await scan.readUsageFromTranscript(later))!.input_tokens).toBe(5);
  });
});
