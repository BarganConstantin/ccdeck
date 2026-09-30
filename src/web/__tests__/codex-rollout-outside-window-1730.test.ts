// #1730. The watcher listed rollouts from the newest two day directories only,
// on the theory that a file anywhere older "will never be appended to again".
// Two ordinary things break that theory:
//
//   `codex resume` appends to the rollout the session STARTED in, which sits in
//   the day folder of that day — however many newer folders there are since.
//   codex-enrichment.mjs says as much; the watcher never heard it.
//
//   One session keeps running while others start on two later calendar days,
//   and its own folder drops out of the newest two while it is still writing.
//   Its cursor stopped being read the moment it left the listing, and was swept
//   ten minutes later.
//
// Either way the session went dark on the canvas — no prompts, no tool calls,
// no usage — and nothing said why. The deck no longer installs Codex hooks, so
// the rollout watcher is the only thing that would have seen it.
//
// What must hold instead: new lines in ANY rollout a live session writes are
// drawn, and a rollout this deck did not read from byte 0 opens joined late —
// no SessionStart, and none of the lines it had before the deck looked.
//
// WHY THE CLOCK IS FAKED AND THE TIMERS ARE NOT, and WHAT THE CASES WAIT ON:
// as in codex-cursor-ttl-981.test.ts. Only `Date` is replaced, to move past the
// cursor TTL without sitting through it, and each case waits on scans rather
// than on the poll's clock.
import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Everything below lives inside this temp directory. CODEX_HOME and the config
// dir are both resolved at module import time, so they are set before the
// dynamic import — the developer's own ~/.codex and ~/.claude are never read.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-codex-outside-"));
const CODEX_HOME = join(DIR, "codex-home");
const SESSIONS = join(CODEX_HOME, "sessions");
const prev = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
};
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = CODEX_HOME;
mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });

/** The watcher's cursor window, which the clock jump below has to clear. */
const CURSOR_TTL_MS = 10 * 60 * 1000;

const CWD = join(DIR, "workspace");
const line = (obj: unknown): string => JSON.stringify(obj) + "\n";
const meta = (id: string) => line({ type: "session_meta", payload: { id, cwd: CWD } });
const prompt = (text: string) => line({ type: "event_msg", payload: { type: "user_message", message: text } });
const call = (id: string) => line({ type: "response_item", payload: { type: "function_call", name: "shell", call_id: id, arguments: "{}" } });

/** A rollout in sessions/<day>, holding `body`. */
function rollout(day: string, stamp: string, sid: string, body: string): string {
  const dir = join(SESSIONS, ...day.split("/"));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-${stamp}-${sid}.jsonl`);
  writeFileSync(path, body, "utf8");
  return path;
}

// Three day folders before the deck starts. The oldest holds the session that
// will be resumed; the two newer ones are what push it out of the listing.
const RESUMED = "0190d3a1-1111-7000-8000-000000000001";
const OLDEST = rollout("2026/09/13", "2026-09-13T09-00-00", RESUMED,
  meta(RESUMED) + prompt("the first turn, before the deck was up") + call("call_FIRST"));
rollout("2026/09/14", "2026-09-14T09-00-00", "0190d3a1-2222-7000-8000-000000000002", meta("0190d3a1-2222-7000-8000-000000000002"));
rollout("2026/09/15", "2026-09-15T09-00-00", "0190d3a1-3333-7000-8000-000000000003", meta("0190d3a1-3333-7000-8000-000000000003"));

// @ts-expect-error — .mjs server module, no types
const { startCodexWatcher, scanCodexNow, eventsSince, CODEX_SESSIONS_DIR } = await import("../../server/index.mjs");

if (!String(CODEX_SESSIONS_DIR).startsWith(DIR)) {
  throw new Error(`refusing to run: the watcher resolved ${CODEX_SESSIONS_DIR}, outside ${DIR}`);
}

async function settle(): Promise<void> {
  await scanCodexNow();
  await scanCodexNow();
}

/** Every event the watcher has produced for `sid`, in order. */
const drawn = (sid: string): string[] => eventsSince(0)
  .filter((e: { source: string }) => e.source === "codex")
  .map((e: { payload: Record<string, unknown> }) => e.payload)
  .filter((p: Record<string, unknown>) => p.session_id === sid)
  .map((p: Record<string, unknown>) => String(p.hook_event_name));

let timer: ReturnType<typeof setInterval> | null = null;
beforeAll(async () => {
  timer = startCodexWatcher("");
  // The initial catalog is async and is what parks every cursor at the end of
  // the files already on disk; appending before it has run would measure a race.
  await settle();
});
afterAll(() => {
  if (timer) clearInterval(timer);
  vi.useRealTimers();
  for (const [key, was] of Object.entries(prev)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  rmTempDir(DIR);
});

describe("a session resumed from a rollout older than the two newest day folders", () => {
  it("is drawn from its first new line, joined late", async () => {
    appendFileSync(OLDEST, prompt("resumed") + call("call_RESUMED"), "utf8");
    await settle();
    // No SessionStart: the deck did not watch this session begin. And nothing
    // from the first turn: those lines were on disk before the deck looked.
    expect(drawn(RESUMED)).toEqual(["UserPromptSubmit", "PreToolUse"]);
  }, 25000);
});

describe("a session still running when its day folder leaves the newest two", () => {
  const LONG = "0190d3a1-4444-7000-8000-000000000004";

  it("keeps being tailed", async () => {
    const path = rollout("2026/09/16", "2026-09-16T23-30-00", LONG, meta(LONG) + prompt("started late at night"));
    await settle();
    expect(drawn(LONG)).toEqual(["SessionStart", "UserPromptSubmit"]);

    // Two later calendar days begin, each with a session of its own.
    rollout("2026/09/17", "2026-09-17T09-00-00", "0190d3a1-5555-7000-8000-000000000005", meta("0190d3a1-5555-7000-8000-000000000005"));
    rollout("2026/09/18", "2026-09-18T09-00-00", "0190d3a1-6666-7000-8000-000000000006", meta("0190d3a1-6666-7000-8000-000000000006"));
    await settle();

    appendFileSync(path, call("call_DAY_THREE"), "utf8");
    expect((await settle(), drawn(LONG))).toEqual(["SessionStart", "UserPromptSubmit", "PreToolUse"]);
  }, 25000);

  it("is picked up again after sitting idle past the cursor window", async () => {
    const path = join(SESSIONS, "2026", "09", "16", `rollout-2026-09-16T23-30-00-${LONG}.jsonl`);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + CURSOR_TTL_MS + 60_000);
    await settle();

    appendFileSync(path, prompt("back after a long pause"), "utf8");
    await settle();
    // One new event, and no second SessionStart: the root this session already
    // has is the one it keeps.
    expect(drawn(LONG)).toEqual(["SessionStart", "UserPromptSubmit", "PreToolUse", "UserPromptSubmit"]);
  }, 25000);
});
