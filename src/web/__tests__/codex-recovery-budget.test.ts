import { afterAll, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmTempDir } from "./rm-temp-dir";

const dir = mkdtempSync(join(tmpdir(), "ccdeck-recovery-budget-"));
const old = { CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CCDECK_HOME: process.env.CCDECK_HOME };
process.env.CODEX_HOME = join(dir, "codex"); process.env.CLAUDE_CONFIG_DIR = join(dir, "claude"); process.env.CCDECK_HOME = join(dir, "deck");
const day = join(process.env.CODEX_HOME, "sessions", "2026", "10", "19"); mkdirSync(day, { recursive: true });
for (let n = 0; n < 129; n++) {
  const timestamp = `2026-10-19T10-${String(Math.floor(n / 60)).padStart(2, "0")}-${String(n % 60).padStart(2, "0")}`;
  const rows = [{ type: "session_meta", payload: { id: "resumed", cwd: dir } }, { type: "event_msg", timestamp: timestamp.replace(/(T\d\d)-(\d\d)-(\d\d)$/, "$1:$2:$3") + "Z", payload: { type: n === 128 ? "task_complete" : "task_started", turn_id: "turn" } }];
  writeFileSync(join(day, `rollout-${timestamp}-resumed.jsonl`), rows.map(r => JSON.stringify(r) + "\n").join(""));
}
// @ts-expect-error server module
const { startCodexWatcher, scanCodexNow, eventsSince } = await import("../../server/index.mjs");
let timer: ReturnType<typeof setInterval>;
afterAll(() => { clearInterval(timer); for (const [k, value] of Object.entries(old)) { if (value === undefined) delete process.env[k]; else process.env[k] = value; } rmTempDir(dir); });
it("does not restore an unfinished rollout when its resumed thread exceeds the snapshot budget", async () => {
  timer = startCodexWatcher(""); await scanCodexNow();
  expect(eventsSince(0).filter((e: any) => e.payload.hook_event_name === "CodexSessionRecovered")).toHaveLength(0);
});
