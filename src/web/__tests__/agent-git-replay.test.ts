// The git view's picture of who edited what is fed by pushEvent, live and from
// the boot replay alike — so a restarted deck rebuilds it from its events log
// with no store of its own.
//
// Drives the real pushEvent and the real replayLog over a log written the way
// the deck writes it, in a sandboxed home.
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-agent-git-replay-"));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.XDG_CONFIG_HOME = join(DIR, "config");
process.env.XDG_DATA_HOME = join(DIR, "data");
process.env.XDG_STATE_HOME = join(DIR, "state");
if (!resolve(process.env.CLAUDE_CONFIG_DIR).startsWith(resolve(DIR))) throw new Error("sandbox escaped");

// @ts-expect-error — .mjs server module, no types
const { pushEvent } = await import("../../server/event-pipeline.mjs");
// @ts-expect-error — .mjs server module, no types
const { replayLog } = await import("../../server/log-replay.mjs");
// @ts-expect-error — .mjs server module, no types
const { agentGit, editsFor } = await import("../../server/agent-git-tap.mjs");
// @ts-expect-error — .mjs server module, no types
const { codexObjToPayload } = await import("../../server/codex-translate.mjs");

afterAll(() => rmTempDir(DIR));

const T0 = 1_760_000_000_000;
const SID = "c1a0d000-0000-4000-8000-0000000000aa";
const CODEX_SID = "019ff475-79c7-7783-97e6-414efa7000aa";
const SUB = "a5f3c2e1d0b9a8f7";

const post = (tool_name: string, file_path: string, extra: Record<string, unknown> = {}) => ({
  session_id: SID, cwd: "/repo", hook_event_name: "PostToolUse", tool_name,
  tool_input: { file_path }, tool_response: { success: true }, tool_use_id: `toolu_${file_path}`, ...extra,
});

const PATCH = "*** Begin Patch\n*** Update File: lib/x.ts\n*** End Patch\n";
const codexPre = codexObjToPayload({ type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", input: PATCH, call_id: "call_r1" } }, CODEX_SID, "/srv/app");
const codexPost = codexObjToPayload({ type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call_r1", output: [{ type: "input_text", text: "Exit code: 0\n" }] } }, CODEX_SID, "/srv/app");

describe("the git view's edit picture", () => {
  it("is rebuilt by the boot replay of the events log", async () => {
    const log = join(DIR, "events.jsonl");
    const lines = [
      { seq: 1, receivedAt: T0, source: "hook", payload: { session_id: SID, cwd: "/repo", hook_event_name: "SessionStart" } },
      { seq: 2, receivedAt: T0 + 1, source: "hook", payload: post("Edit", "/repo/a.ts") },
      { seq: 3, receivedAt: T0 + 2, source: "hook", payload: post("Write", "/repo/b.ts", { agent_id: SUB }) },
      { seq: 4, receivedAt: T0 + 3, source: "codex", payload: codexPre },
      { seq: 5, receivedAt: T0 + 4, source: "codex", payload: codexPost },
    ];
    writeFileSync(log, lines.map(l => JSON.stringify(l)).join("\n") + "\n");
    expect(await replayLog(log)).toBe(lines.length);

    expect(editsFor(SID)).toEqual([{ path: "/repo/a.ts", at: T0 + 1, cwd: "/repo", agentId: null }]);
    expect(editsFor(SID, { agentId: SUB })).toEqual([{ path: "/repo/b.ts", at: T0 + 2, cwd: "/repo", agentId: SUB }]);
    expect(editsFor(CODEX_SID)).toEqual([{ path: "/srv/app/lib/x.ts", at: T0 + 4, cwd: "/srv/app", agentId: null }]);
  });

  it("follows live events through pushEvent, and forgets on the deck's Clear", () => {
    pushEvent(post("MultiEdit", "/repo/c.ts", { tool_use_id: "toolu_live" }), "hook", { receivedAt: T0 + 100 });
    expect(editsFor(SID).map((e: { path: string }) => e.path)).toEqual(["/repo/c.ts", "/repo/a.ts"]);
    // A hook cannot clear it…
    pushEvent({ hook_event_name: "__clear", cwd: "" }, "hook", { persist: false });
    expect(editsFor(SID)).toHaveLength(2);
    // …the server's own marker does, as it clears the canvas.
    pushEvent({ hook_event_name: "__clear", cwd: "" }, "internal", { persist: false });
    expect(agentGit.edits.sessions()).toEqual([]);
  });

  it("never lets a fault in the git view cost the deck an event", () => {
    const real = agentGit.observe;
    agentGit.observe = () => { throw new Error("boom"); };
    const errors: unknown[] = [];
    const log = console.error;
    console.error = (...a: unknown[]) => { errors.push(a); };
    try {
      const evt = pushEvent(post("Edit", "/repo/d.ts", { tool_use_id: "toolu_fault" }), "hook", { persist: false });
      expect(evt.seq).toBeGreaterThan(0);
      expect(errors).toHaveLength(1);
    } finally {
      agentGit.observe = real;
      console.error = log;
    }
  });
});
