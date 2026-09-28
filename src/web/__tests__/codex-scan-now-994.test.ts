// scanCodexNow: one scan of the Codex rollouts, begun after the call and
// awaited — the door the watcher's suites wait on instead of the 1500ms poll
// (#994). What it has to be for those waits to mean anything: a scan that has
// really read what was written before the call, and one that shares the
// watcher's cursors with the poll rather than racing it.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// CODEX_HOME is resolved at module import, so it is set before the import below
// and the developer's own ~/.codex is never read.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-codex-scan-now-"));
const CODEX_HOME = join(DIR, "codex-home");
const DAY = join(CODEX_HOME, "sessions", "2026", "09", "28");
const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CODEX_HOME = CODEX_HOME;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
mkdirSync(DAY, { recursive: true });
mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });

// @ts-expect-error — .mjs server module, no types
const { startCodexWatcher, scanCodexNow, eventsSince, CODEX_SESSIONS_DIR } = await import("../../server/index.mjs");
if (!String(CODEX_SESSIONS_DIR).startsWith(DIR)) {
  throw new Error(`refusing to run: the watcher resolved ${CODEX_SESSIONS_DIR}, outside ${DIR}`);
}

const WATCHER_SRC = readFileSync(fileURLToPath(new URL("../../server/codex-watch.mjs", import.meta.url)), "utf8");
const SID = "99400000-5ca0-4000-8000-000000000001";
const ROLLOUT = join(DAY, `rollout-2026-09-28T10-00-00-${SID}.jsonl`);
const line = (obj: unknown): string => JSON.stringify(obj) + "\n";
const prompt = (text: string) => line({ type: "event_msg", payload: { type: "user_message", message: text } });

/** Every hook event the watcher has produced for the session, in order. */
const drawn = (): string[] => eventsSince(0)
  .filter((e: { source: string }) => e.source === "codex")
  .map((e: { payload: Record<string, unknown> }) => e.payload)
  .filter((p: Record<string, unknown>) => p.session_id === SID)
  .map((p: Record<string, unknown>) => String(p.hook_event_name));

let timer: ReturnType<typeof setInterval> | null = null;
beforeAll(async () => {
  timer = startCodexWatcher("");
  // The startup catalogue is still reading here — startCodexWatcher does not
  // wait for it — and this is the first thing that must hold: the call waits
  // it out, rather than answering while it is still parking cursors.
  await scanCodexNow();
});
afterAll(() => {
  if (timer) clearInterval(timer);
  for (const [key, was] of Object.entries(prev)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  rmTempDir(DIR);
});

describe("scanCodexNow", () => {
  it("has read what was written before it was called, with no poll to wait for", async () => {
    writeFileSync(ROLLOUT, line({ type: "session_meta", payload: { id: SID, cwd: DIR } }) + prompt("one"), "utf8");
    await scanCodexNow();
    expect(drawn()).toEqual(["SessionStart", "UserPromptSubmit"]);
  });

  it("shares the watcher's cursors: calls that overlap each other and the poll read a line once", async () => {
    appendFileSync(ROLLOUT, prompt("two"), "utf8");
    await Promise.all([scanCodexNow(), scanCodexNow(), scanCodexNow()]);
    expect(drawn()).toEqual(["SessionStart", "UserPromptSubmit", "UserPromptSubmit"]);
    await scanCodexNow();
    expect(drawn()).toHaveLength(3);
  });

  it("leaves the poll itself as it was: every 1500ms, joining a scan still reading", () => {
    expect(WATCHER_SRC).toMatch(/setInterval\(\(\) => \{ codexScanOnce\(false\)\.catch\(\(\) => \{\}\); \}, 1500\);/);
    expect(WATCHER_SRC).toMatch(/codexScan \?\?= scanRollouts\(firstRun\)/);
  });
});
