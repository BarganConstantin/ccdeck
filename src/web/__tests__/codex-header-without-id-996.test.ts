// #996: a Codex rollout whose session_meta does not state its id is still read,
// under the id its file name carries — and one whose id is nowhere, or whose
// first line is not a session_meta at all, is said out loud once rather than
// retried in silence on every tick.
//
// What this used to do: `readCodexHeader` returned `{ sid: obj.payload.id }`
// with no type guard, and the scan `continue`s on a header with no sid. So a
// renamed or dropped `payload.id` meant no Codex session was ever drawn, every
// rollout's first 64KB was re-read every 1.5s, and the terminal said nothing.
//
// FIXTURES ONLY. CODEX_HOME, HOME and the Claude config dir are a temp
// directory set before the server module is imported, and the file refuses to
// run if the watcher resolved a tree outside it.

import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-codex-996-"));
const CODEX_HOME = join(DIR, "codex-home");
const DAY = join(CODEX_HOME, "sessions", "2026", "09", "15");
const CWD = join(DIR, "workspace");
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
mkdirSync(CWD, { recursive: true });

/** Comfortably more than two of the watcher's 1500ms polls. */
const SETTLE_MS = 3500;
const line = (obj: unknown): string => JSON.stringify(obj) + "\n";
const prompt = (text: string) => line({ type: "event_msg", payload: { type: "user_message", message: text } });
const rollout = (at: string, tail: string) => join(DAY, `rollout-2026-09-15T${at}-${tail}.jsonl`);

// The control: a header exactly as Codex writes one today. If this one is not
// drawn, the harness is broken and none of the cases below mean anything.
const SID_OK = "0a1b2c3d-0000-4000-8000-000000000000";
// The id under a name the reader does not know — what a rename looks like.
const SID_RENAMED = "0a1b2c3d-1111-4000-8000-000000000001";
// An id that is there but is not a string.
const SID_NUMBER = "0a1b2c3d-2222-4000-8000-000000000002";
// A first line that is a different record altogether.
const SID_NO_HEADER = "0a1b2c3d-3333-4000-8000-000000000003";

// @ts-expect-error — .mjs server module, no types
const { startCodexWatcher, eventsSince, CODEX_SESSIONS_DIR, sidFromRolloutName } = await import("../../server/index.mjs");

if (!String(CODEX_SESSIONS_DIR).startsWith(DIR)) {
  throw new Error(`refusing to run: the watcher resolved ${CODEX_SESSIONS_DIR}, outside ${DIR}`);
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
const warned = (needle: string): number => warn.mock.calls.filter(c => String(c[0]).includes(needle)).length;

/** Every hook event the watcher has produced for `sid`, in order. */
const drawn = (sid: string): string[] => eventsSince(0)
  .filter((e: { source: string }) => e.source === "codex")
  .map((e: { payload: Record<string, unknown> }) => e.payload)
  .filter((p: Record<string, unknown>) => p.session_id === sid)
  .map((p: Record<string, unknown>) => String(p.hook_event_name));

async function until(done: () => boolean, ms = 15000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await wait(50);
}

let timer: ReturnType<typeof setInterval> | null = null;
beforeAll(async () => {
  timer = startCodexWatcher("");
  // Let the initial catalog run first. It parks the cursor of every rollout
  // already on disk at its end, so the files below are written AFTER it — new
  // rollouts, read from their first byte, which is what a live session is.
  await wait(SETTLE_MS);
  writeFileSync(rollout("10-00-00", SID_OK),
    line({ type: "session_meta", payload: { id: SID_OK, cwd: CWD } }) + prompt("the control"), "utf8");
  writeFileSync(rollout("10-01-00", SID_RENAMED),
    line({ type: "session_meta", payload: { thread_id: SID_RENAMED, cwd: CWD } }) + prompt("an id under another name"), "utf8");
  writeFileSync(rollout("10-02-00", SID_NUMBER),
    line({ type: "session_meta", payload: { id: 12345, cwd: CWD } }) + prompt("an id that is a number"), "utf8");
  writeFileSync(rollout("10-03-00", "not-a-uuid"),
    line({ type: "session_meta", payload: { cwd: CWD } }) + prompt("an id nowhere at all"), "utf8");
  writeFileSync(rollout("10-04-00", SID_NO_HEADER),
    line({ type: "thread_meta", payload: { id: SID_NO_HEADER, cwd: CWD } }) + prompt("a header under another type"), "utf8");
  await until(() => drawn(SID_OK).includes("UserPromptSubmit"));
  // Several more ticks, so a warning printed per tick rather than once would
  // have had the chance to print again.
  await wait(SETTLE_MS * 2);
}, 40_000);

afterAll(() => {
  if (timer) clearInterval(timer);
  warn.mockRestore();
  for (const [key, was] of Object.entries(prev)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  rmTempDir(DIR);
});

describe("a Codex rollout's header", () => {
  it("is read as Codex writes it today (the control)", () => {
    expect(drawn(SID_OK)).toContain("UserPromptSubmit");
  });

  it("falls back to the id in the file name when session_meta does not state one", () => {
    expect(drawn(SID_RENAMED)).toContain("UserPromptSubmit");
  });

  it("falls back to the file name when the id it states is not a string", () => {
    expect(drawn(SID_NUMBER)).toContain("UserPromptSubmit");
    // And nothing is drawn under the number itself.
    expect(drawn("12345")).toEqual([]);
  });

  it("says once — not once a tick — when a rollout's id is nowhere", () => {
    expect(warned("its session_meta has no id, and its file name carries none")).toBe(1);
  });

  it("says once when a rollout's first line is not a session_meta, and guesses nothing from it", () => {
    expect(warned("its first line is a \"thread_meta\", not a session_meta")).toBe(1);
    expect(drawn(SID_NO_HEADER)).toEqual([]);
  });

  it("does not report the control, which is fine", () => {
    expect(warn.mock.calls.filter(c => String(c[0]).includes(SID_OK))).toEqual([]);
  });
});

describe("sidFromRolloutName", () => {
  it("reads the uuid Codex puts at the end of a rollout's name", () => {
    expect(sidFromRolloutName(rollout("09-00-00", SID_OK))).toBe(SID_OK);
    expect(sidFromRolloutName(`rollout-2026-06-17T12-39-01-019ed4f2-c821-7a31-9f00-0123456789ab.jsonl`))
      .toBe("019ed4f2-c821-7a31-9f00-0123456789ab");
  });

  it("answers null for a name with no uuid, and for a compressed rollout this reader never opens", () => {
    expect(sidFromRolloutName("rollout-2026-09-15T10-03-00-not-a-uuid.jsonl")).toBeNull();
    expect(sidFromRolloutName(`rollout-2026-09-15T10-00-00-${SID_OK}.jsonl.zst`)).toBeNull();
    expect(sidFromRolloutName(undefined)).toBeNull();
  });
});
