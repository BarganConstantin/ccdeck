// What was observed, in a sandbox deck with its own $HOME and its own
// $CODEX_HOME (port 4442, AGENTS_DECK_NO_LAN=1, fixture rollouts only):
//
//   after the live session is tailed: ["SessionStart","UserPromptSubmit","PreToolUse"]
//   sessions dir made unreadable; waiting past the TTL...
//   sessions dir readable again
//   after the tree comes back:        ["SessionStart","UserPromptSubmit","PreToolUse",
//                                      "SessionStart","UserPromptSubmit","PreToolUse","PostToolUse"]
//
// `chmod 000 $CODEX_HOME/sessions` for longer than CODEX_STATE_TTL_MS, and the
// whole rollout came back a second time — every prompt, every PreToolUse and
// PostToolUse, every UsageObserved — broadcast to every open tab and re-appended
// to the shared events.jsonl by whichever deck the election had picked. And on a
// session the deck had correctly marked as joined late:
//
//   joined late, so the root opens with no SessionStart: ["PreToolUse"]
//   after the tree comes back: ["PreToolUse","SessionStart","UserPromptSubmit","PreToolUse","PostToolUse"]
//   a SessionStart this deck never watched: true
//
// — the marker retracted, because reducer.ts clears `root.synthetic` on every
// `SessionStart` it sees (#677), which makes that marker exactly as honest as
// whatever emits the event.
//
// TWO THINGS WERE WRONG AND THEY ARE INDEPENDENT.
//
//   The TTL sweep ran on ticks where the listing came back EMPTY. Its own
//   comment said it existed so that "a single unreadable directory mid-scan"
//   could not drop a live file's cursor — but it sat outside the file loop, so
//   it also ran on the ticks where `seenAt` had been refreshed for nobody at
//   all. walkRolloutDays swallows its readdir error at every level and answers
//   `[]` rather than throwing, so an unreachable $CODEX_HOME is indistinguishable
//   from an empty one, and ten minutes of it expired every cursor there was.
//
//   Re-discovery could not tell itself apart from discovery. A path with no
//   entry in codexFileState is opened at byte 0 and told it has its own
//   beginning — right for a rollout nobody has ever read, catastrophic for one
//   whose cursor was merely dropped.
//
// So these stage a rollout the deck joined late, take its listing away in the
// ways that are reachable, and ask for the one thing that must hold either way:
// the deck reads what was appended while it was blind, and does not re-read,
// re-broadcast or re-log what it already had — nor claim a beginning it did not
// watch.
//
// WHY NOTHING HERE chmods A DIRECTORY. The reproduction above needs a directory
// that cannot be listed, and `chmod 0o000` is not that on Windows — the
// read-only bit does not stop a readdir — nor for root. A case staged that way
// would have to be gated, and a gated case runs on two legs of the matrix
// instead of three, which is the trade skip-gates.mjs exists to argue against.
// It buys nothing here: walkRolloutDays catches every readdir error in one bare
// `catch`, so ENOENT and EACCES arrive at the sweep as the identical empty
// listing. Taking the tree away outright is the same input, it is the trigger
// the issue names first — a network or removable volume that went away — and it
// runs everywhere.
//
// WHY THE CLOCK IS FAKED AND THE TIMERS ARE NOT. The window is ten real minutes.
// Only `Date` is replaced, so the watcher's own `setInterval` keeps polling for
// real and the waits below are real waits: the scan simply looks at a clock that
// has moved. Faking the timers too would have meant driving the watcher's poll
// by hand, which is the part under test. #981.
import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The real clock, captured before anything can fake it. Every wait and deadline
// in this file reads it rather than the global, because a faked `Date` does not
// tick on its own — a loop spinning on `Date.now()` under one never ends.
const realNow = Date.now.bind(Date);

// Everything below lives inside this temp directory. CODEX_HOME and the config
// dir are both resolved at module import time, so they are set before the
// dynamic import a few lines down — the developer's own ~/.codex and ~/.claude
// are never read or written.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-codex-ttl-"));
const CODEX_HOME = join(DIR, "codex-home");
const SESSIONS = join(CODEX_HOME, "sessions");
const SESSIONS_ASIDE = join(CODEX_HOME, "sessions-unplugged");
const DAY = join(SESSIONS, "2026", "09", "15");
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
mkdirSync(DAY, { recursive: true });

/** The watcher's own window, which the clock jumps below have to clear. */
const CURSOR_TTL_MS = 10 * 60 * 1000;
/** Comfortably more than two of the watcher's 1500ms polls. */
const SETTLE_MS = 3500;

const INDEX_SRC = readFileSync(fileURLToPath(new URL("../../server/index.mjs", import.meta.url)), "utf8");

const SID = "7d3c9a10-1111-4000-8000-aabbccddeeff";
const CWD = join(DIR, "workspace");
const ROLLOUT = join(DAY, `rollout-2026-09-15T09-00-00-${SID}.jsonl`);
const line = (obj: unknown): string => JSON.stringify(obj) + "\n";

// The lines this session had written before the deck was ever started — which is
// what makes it a session the deck JOINED LATE, and so one that must never
// receive a `SessionStart` from this process.
const BEFORE_THE_DECK =
  line({ type: "session_meta", payload: { id: SID, cwd: CWD } }) +
  line({ type: "event_msg", payload: { type: "user_message", message: "a prompt from before the deck was up" } }) +
  line({ type: "response_item", payload: { type: "function_call", name: "shell", call_id: "call_BEFORE", arguments: "{}" } });
writeFileSync(ROLLOUT, BEFORE_THE_DECK, "utf8");

// @ts-expect-error — .mjs server module, no types
const { startCodexWatcher, eventsSince, CODEX_SESSIONS_DIR } = await import("../../server/index.mjs");

// Belt and braces: the watcher walks the tree it resolved at import, so if the
// override were ignored this file would be reading the developer's own sessions.
if (!String(CODEX_SESSIONS_DIR).startsWith(DIR)) {
  throw new Error(`refusing to run: the watcher resolved ${CODEX_SESSIONS_DIR}, outside ${DIR}`);
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

let timer: ReturnType<typeof setInterval> | null = null;
beforeAll(async () => {
  timer = startCodexWatcher("");
  // The initial catalog is async, and it is what parks the cursor at the end of
  // the file already on disk. Appending before it has run would put the append
  // on the wrong side of that park, and the first case would be measuring a race
  // rather than a rule.
  await wait(SETTLE_MS);
});
afterAll(() => {
  if (timer) clearInterval(timer);
  // Before rmTempDir, which waits out a Windows delete on the wall clock.
  vi.useRealTimers();
  for (const [key, was] of Object.entries(prev)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  rmTempDir(DIR);
});

/** Move the wall clock past the cursor TTL rather than sitting through it. */
let faking = false;
function jumpPastTheTtl(): void {
  if (!faking) { vi.useFakeTimers({ toFake: ["Date"] }); faking = true; }
  vi.setSystemTime(Date.now() + CURSOR_TTL_MS + 60_000);
}

/** Every payload this watcher has produced for the session under test, in order. */
const drawn = (): string[] => eventsSince(0)
  .filter((e: { source: string }) => e.source === "codex")
  .map((e: { payload: Record<string, unknown> }) => e.payload)
  .filter((p: Record<string, unknown>) => p.session_id === SID)
  .map((p: Record<string, unknown>) => String(p.hook_event_name));

/** Poll until the watcher has produced `n` events for this session, or give up. */
async function until(n: number, ms = 15000): Promise<string[]> {
  const deadline = realNow() + ms;
  while (drawn().length < n && realNow() < deadline) await wait(50);
  // Then a little longer, which is the window a replay would land in: the scan
  // is a timer and the emit is fire-and-forget, so "and nothing more arrived"
  // has to be given the chance to be wrong.
  await wait(SETTLE_MS);
  return drawn();
}

/**
 * Move a directory out of the way, patient enough for a listing Windows has not
 * finished. `readdir` holds a handle for the length of an enumeration and
 * MoveFile refuses a directory that has one open — a collision the watcher's
 * 1500ms poll makes rare rather than impossible, and rare is exactly the flake
 * nobody can reproduce.
 */
function unplug(from: string, to: string): void {
  for (let attempt = 1; ; attempt++) {
    try { return renameSync(from, to); }
    catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 40 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw err;
      const deadline = realNow() + 25;
      while (realNow() < deadline) { /* waiting out an enumeration */ }
    }
  }
}

describe("a rollout this deck joined late", () => {
  it("jumps the very window the watcher keeps", () => {
    // The clock jumps below are a test of the sweep only if they clear the
    // sweep's own threshold. The constant is not exported, and exporting it
    // would be a change to the module under test made for a test's benefit —
    // so it is read out of the source, the way boot-lock.test.ts reads
    // bin/deck.js.
    expect(INDEX_SRC).toMatch(/const CODEX_STATE_TTL_MS = 10 \* 60 \* 1000;/);
    expect(CURSOR_TTL_MS).toBe(10 * 60 * 1000);
  });

  it("opens its root without a SessionStart, which is the premise of everything below", async () => {
    // #684's rule, restated here because the rest of this file is about not
    // taking it back: the watcher parked at the end of a file that already
    // existed, so it holds none of this session's history and must not emit the
    // event that says it watched the session begin.
    appendFileSync(ROLLOUT, line({
      type: "response_item",
      payload: { type: "function_call_output", call_id: "call_BEFORE", output: "ok" },
    }), "utf8");

    expect(await until(1)).toEqual(["PostToolUse"]);
  }, 25000);
});

describe("a listing that came back empty", () => {
  it("is not evidence that a live rollout went away", async () => {
    // The listing is empty here because the one rollout in it is momentarily
    // gone. What the deck sees is exactly what an unreadable or unmounted
    // $CODEX_HOME produces — walkRolloutDays answers `[]` for all of them — and
    // the sweep used to take that silence as proof, expiring every cursor it
    // held on ticks that had refreshed none of them.
    rmSync(ROLLOUT, { force: true });
    jumpPastTheTtl();
    await wait(SETTLE_MS);
    expect(existsSync(ROLLOUT)).toBe(false);

    // Back, with everything it had and one line more — the shape a volume that
    // reappears has, since the session kept writing while the deck was blind.
    writeFileSync(ROLLOUT, BEFORE_THE_DECK +
      line({ type: "response_item", payload: { type: "function_call_output", call_id: "call_BEFORE", output: "ok" } }) +
      line({ type: "response_item", payload: { type: "function_call", name: "shell", call_id: "call_AFTER", arguments: "{}" } }),
      "utf8");

    // One new event, and only one. A cursor expired into nothing would have
    // re-opened this file at byte 0 and handed the whole of it back.
    expect(await until(2)).toEqual(["PostToolUse", "PreToolUse"]);
  }, 30000);
});

describe("a tree that goes away and comes back", () => {
  it("costs the deck the lines it could not see, and nothing it already had", async () => {
    // The trigger the issue names first: a network or removable volume, an
    // encrypted home not yet unlocked. The tree is unreachable for longer than
    // the whole window — which is the case the "not seen for a while" clock was
    // sized to survive, and the one it could not.
    unplug(SESSIONS, SESSIONS_ASIDE);
    jumpPastTheTtl();
    await wait(SETTLE_MS);
    unplug(SESSIONS_ASIDE, SESSIONS);

    appendFileSync(ROLLOUT, line({
      type: "response_item",
      payload: { type: "function_call_output", call_id: "call_AFTER", output: "ok" },
    }), "utf8");

    expect(await until(3)).toEqual(["PostToolUse", "PreToolUse", "PostToolUse"]);
  }, 30000);
});

describe("a cursor the sweep really did expire", () => {
  it("is re-opened at the end of the file, claiming no beginning it did not watch", async () => {
    // The second reachable trigger, and the one the empty-listing rule above
    // does not cover: a user deleting the newest day directory lets an older one
    // back into the two-day window, so the listing is NOT empty while a file
    // that is still being written is absent from it. The sweep runs, correctly,
    // and takes that file's cursor with it.
    //
    // A second rollout holds the listing open, so this is the sweep doing its
    // job rather than the rule above doing it for us.
    const other = join(DAY, "rollout-2026-09-15T11-00-00-11112222-3333-4000-8000-444455556666.jsonl");
    writeFileSync(other, line({ type: "session_meta", payload: { id: "11112222-3333-4000-8000-444455556666", cwd: CWD } }), "utf8");
    await wait(SETTLE_MS);

    const had = drawn();
    rmSync(ROLLOUT, { force: true });
    jumpPastTheTtl();
    await wait(SETTLE_MS);

    writeFileSync(ROLLOUT, BEFORE_THE_DECK +
      line({ type: "response_item", payload: { type: "function_call_output", call_id: "call_BEFORE", output: "ok" } }) +
      line({ type: "response_item", payload: { type: "function_call", name: "shell", call_id: "call_AFTER", arguments: "{}" } }) +
      line({ type: "response_item", payload: { type: "function_call_output", call_id: "call_AFTER", output: "ok" } }),
      "utf8");
    await wait(SETTLE_MS);
    appendFileSync(ROLLOUT, line({
      type: "response_item",
      payload: { type: "function_call", name: "shell", call_id: "call_LAST", arguments: "{}" },
    }), "utf8");

    const now = await until(had.length + 1);
    expect(now).toEqual([...had, "PreToolUse"]);
    // Said on its own because it is the half the reducer cannot defend: a
    // `SessionStart` here would reach every tab and the shared log, and
    // reducer.ts clears `root.synthetic` on every one it sees — so a session the
    // deck joined late would stop being marked as one, which is a claim about
    // what this deck witnessed and it would be false.
    expect(now.filter(n => n === "SessionStart")).toEqual([]);
  }, 40000);
});
