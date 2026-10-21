import { afterAll, expect, it } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmTempDir } from "./rm-temp-dir";

const dir = mkdtempSync(join(tmpdir(), "ccdeck-no-recovery-"));
const old = { CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CCDECK_HOME: process.env.CCDECK_HOME };
process.env.CODEX_HOME = join(dir, "codex"); process.env.CLAUDE_CONFIG_DIR = join(dir, "claude"); process.env.CCDECK_HOME = join(dir, "deck");
const day = join(process.env.CODEX_HOME, "sessions", "2026", "10", "19");
mkdirSync(day, { recursive: true }); mkdirSync(process.env.CCDECK_HOME, { recursive: true });
writeFileSync(join(process.env.CCDECK_HOME, "prefs.json"), JSON.stringify({ recoverCodexSessions: false }));
const file = join(day, "rollout-2026-10-19T10-00-00-session.jsonl");
writeFileSync(file, [{ type: "session_meta", payload: { id: "session", cwd: dir } }, { type: "event_msg", payload: { type: "task_started" } }].map(x => JSON.stringify(x) + "\n").join(""));
// @ts-expect-error server module
const { startCodexWatcher, scanCodexNow, eventsSince } = await import("../../server/index.mjs");
let timer: ReturnType<typeof setInterval>;
afterAll(() => { clearInterval(timer); for (const [k, value] of Object.entries(old)) { if (value === undefined) delete process.env[k]; else process.env[k] = value; } rmTempDir(dir); });
it("honors the saved opt-out while retaining live capture", async () => {
  timer = startCodexWatcher(""); await scanCodexNow();
  expect(eventsSince(0).filter((e: any) => e.source === "codex")).toHaveLength(0);
  appendFileSync(file, JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "new work" } }) + "\n");
  await scanCodexNow();
  expect(eventsSince(0).some((e: any) => e.payload?.hook_event_name === "UserPromptSubmit")).toBe(true);
});
