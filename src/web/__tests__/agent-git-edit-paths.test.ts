// Which files each agent edited, per session and per subagent, from the hook
// events the deck already receives — Claude's edit tools and Codex's patches.
//
// Pure modules, driven with real payload shapes: Claude PostToolUse payloads as
// the hook forwards them, and Codex rollout lines run through the real
// translation (codex-translate.mjs) so the PreToolUse / PostToolUse pair is
// exactly what pushEvent sees.
import { describe, expect, it } from "vitest";
// @ts-expect-error — .mjs server module, no types
import { patchPaths } from "../../server/agent-git-patch.mjs";
// @ts-expect-error — .mjs server module, no types
import { codexScriptCalls, digestToolCall } from "../../server/agent-git-digest.mjs";
// @ts-expect-error — .mjs server module, no types
import { createEditTracker } from "../../server/agent-git-edits.mjs";
// @ts-expect-error — .mjs server module, no types
import { codexObjToPayload } from "../../server/codex-translate.mjs";

type Payload = Record<string, unknown>;
type Envelope = { payload: Payload; receivedAt: number; source: string };

const T0 = 1_760_000_000_000;
const SID = "c1a0d000-0000-4000-8000-000000000001";
const CODEX_SID = "019ff475-79c7-7783-97e6-414efa702b67";
const SUB = "a5f3c2e1d0b9a8f7";

const env = (payload: Payload, at = T0, source = "hook"): Envelope => ({ payload, receivedAt: at, source });

/** A Claude PostToolUse as the hook forwards it. */
const claudePost = (tool_name: string, tool_input: Payload, extra: Payload = {}): Payload => ({
  session_id: SID, cwd: "/repo", hook_event_name: "PostToolUse", tool_name, tool_input,
  tool_use_id: `toolu_${tool_name}_${Math.random().toString(36).slice(2, 8)}`, tool_response: { success: true }, ...extra,
});

/** One Codex rollout line through the real translation. */
const codex = (obj: { type: string; payload: Payload }, cwd = "/srv/app"): Payload =>
  codexObjToPayload(obj, CODEX_SID, cwd) as Payload;

const patchCall = (callId: string, patch: string) => ({
  type: "response_item",
  payload: { type: "custom_tool_call", name: "apply_patch", input: patch, call_id: callId, status: "completed" },
});
const patchOutput = (callId: string, code: number) => ({
  type: "response_item",
  payload: { type: "custom_tool_call_output", call_id: callId, output: [{ type: "input_text", text: `Exit code: ${code}\nWall time: 0 seconds\n` }] },
});
const execCall = (callId: string, script: string) => ({
  type: "response_item",
  payload: { type: "custom_tool_call", name: "exec", input: script, call_id: callId, status: "completed" },
});
const execOutput = (callId: string, head: string, tail = "") => ({
  type: "response_item",
  payload: {
    type: "custom_tool_call_output", call_id: callId,
    output: [{ type: "input_text", text: `${head}\nWall time 0.2 seconds\nOutput:\n${tail}` }, { type: "input_text", text: tail }],
  },
});

describe("patchPaths", () => {
  it("reads every file header an apply_patch document carries", () => {
    const doc = [
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "+export const x = 1;",
      "*** Update File: src/old.ts",
      "@@",
      "-a",
      "+b",
      "*** Delete File: docs/gone.md",
      "*** Update File: src/a.ts",
      "*** Move to: src/b.ts",
      "@@",
      "-c",
      "+d",
      "*** End of File",
      "*** End Patch",
    ].join("\n");
    expect(patchPaths(doc)).toEqual([
      { op: "add", path: "src/new.ts" },
      { op: "update", path: "src/old.ts" },
      { op: "delete", path: "docs/gone.md" },
      { op: "update", path: "src/a.ts" },
      { op: "move", path: "src/b.ts", from: "src/a.ts" },
    ]);
  });

  it("tolerates CRLF, trailing spaces and junk, and answers [] for anything else", () => {
    expect(patchPaths("*** Begin Patch\r\n*** Update File: a b.txt  \r\n*** End Patch\r\n")).toEqual([{ op: "update", path: "a b.txt" }]);
    expect(patchPaths("")).toEqual([]);
    expect(patchPaths(null)).toEqual([]);
    expect(patchPaths({ patch: "*** Update File: x" })).toEqual([]);
    // A header with no path names nothing.
    expect(patchPaths("*** Update File:   \n")).toEqual([]);
  });

  it("does not read a header that only appears inside a hunk line", () => {
    // `+*** Update File: x` is content being added to a file, not a header.
    expect(patchPaths("*** Begin Patch\n*** Add File: notes.md\n+*** Update File: fake.ts\n*** End Patch")).toEqual([
      { op: "add", path: "notes.md" },
    ]);
  });
});

describe("codexScriptCalls", () => {
  it("pulls every command and its workdir out of an exec script, on both CLI spellings", () => {
    const s144 = 'const r = await tools.exec_command({cmd:"git status",workdir:"/repo",yield_time_ms:250,max_output_tokens:8000});\ntext(r.output);';
    const s147 = 'const r = await tools.exec_command({cmd:"git add -A && git commit -m \\"fix: x\\"",workdir:"/srv/app"}); text(r.output);\n';
    expect(codexScriptCalls(s144).commands).toEqual([{ command: "git status", workdir: "/repo" }]);
    expect(codexScriptCalls(s147).commands).toEqual([{ command: 'git add -A && git commit -m "fix: x"', workdir: "/srv/app" }]);
  });

  it("finds a patch the script hands to tools.apply_patch as a literal", () => {
    const script = 'const patch = "*** Begin Patch\\n*** Update File: src/app.ts\\n@@\\n-a\\n+b\\n*** End Patch\\n";\ntext(await tools.apply_patch(patch));';
    expect(codexScriptCalls(script).patches).toEqual([[{ op: "update", path: "src/app.ts" }]]);
    const tpl = "text(await tools.apply_patch(`*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch`));";
    expect(codexScriptCalls(tpl).patches).toEqual([[{ op: "add", path: "a.txt" }]]);
  });

  it("names no file for a patch it cannot see, and none when nothing is applied", () => {
    // A generated diff piped into apply_patch: the files are in the command's
    // output, not in the script — a blind spot, answered with nothing.
    const piped = 'const gen = await tools.exec_command({cmd:"git diff",workdir:"/repo"});\nconst applied = await tools.apply_patch(gen.output);';
    expect(codexScriptCalls(piped).patches).toEqual([]);
    // A patch-shaped string that is never applied is just text.
    const echoed = 'const r = await tools.exec_command({cmd:"cat > p.diff <<EOF\\n*** Update File: x\\nEOF"});';
    expect(codexScriptCalls(echoed).patches).toEqual([]);
    expect(codexScriptCalls("npm run build; Write-Host $tools.Count")).toEqual({ commands: [], patches: [] });
  });
});

describe("digestToolCall", () => {
  it("resolves Claude's four edit tools to absolute paths", () => {
    expect(digestToolCall("Edit", { file_path: "/repo/a.ts", old_string: "x", new_string: "y" }, "/repo").edits).toEqual(["/repo/a.ts"]);
    expect(digestToolCall("Write", { file_path: "/repo/b.ts", content: "" }, "/repo").edits).toEqual(["/repo/b.ts"]);
    expect(digestToolCall("MultiEdit", { file_path: "/repo/c.ts", edits: [] }, "/repo").edits).toEqual(["/repo/c.ts"]);
    expect(digestToolCall("NotebookEdit", { notebook_path: "/repo/n.ipynb", new_source: "" }, "/repo").edits).toEqual(["/repo/n.ipynb"]);
    // A relative path is resolved against the cwd the event names.
    expect(digestToolCall("Edit", { file_path: "src/../d.ts" }, "/repo").edits).toEqual(["/repo/d.ts"]);
  });

  it("resolves Windows paths with Windows rules", () => {
    expect(digestToolCall("Edit", { file_path: "src\\x.ts" }, "C:\\work\\repo").edits).toEqual(["C:\\work\\repo\\src\\x.ts"]);
    expect(digestToolCall("Write", { file_path: "D:\\other\\y.ts" }, "C:\\work\\repo").edits).toEqual(["D:\\other\\y.ts"]);
  });

  it("reads Codex patches, both moved ends included, and its shell commands", () => {
    const doc = "*** Begin Patch\n*** Update File: lib/a.ts\n*** Move to: lib/b.ts\n*** Delete File: /abs/c.ts\n*** End Patch";
    expect(digestToolCall("apply_patch", { patch: doc }, "/srv/app").edits).toEqual(["/srv/app/lib/a.ts", "/srv/app/lib/b.ts", "/abs/c.ts"]);
    expect(digestToolCall("exec_command", { cmd: "git commit -m x", workdir: "/srv/app/sub" }, "/srv/app").commands)
      .toEqual([{ command: "git commit -m x", cwd: "/srv/app/sub" }]);
    expect(digestToolCall("shell", { command: ["bash", "-lc", "git commit -m y"], workdir: "/w" }, "/srv").commands)
      .toEqual([{ command: "git commit -m y", cwd: "/w" }]);
    expect(digestToolCall("Bash", { command: "git commit -m z" }, "/repo").commands).toEqual([{ command: "git commit -m z", cwd: "/repo" }]);
  });

  it("is empty for tools that neither edit nor run a shell, and for junk", () => {
    expect(digestToolCall("Read", { file_path: "/repo/a.ts" }, "/repo")).toEqual({ edits: [], commands: [] });
    expect(digestToolCall("Edit", null, "/repo")).toEqual({ edits: [], commands: [] });
    expect(digestToolCall("Edit", { file_path: 42 }, "/repo")).toEqual({ edits: [], commands: [] });
    // No cwd to resolve a relative path against: dropped rather than guessed.
    expect(digestToolCall("Edit", { file_path: "a.ts" }, undefined)).toEqual({ edits: [], commands: [] });
  });
});

describe("the edit tracker", () => {
  it("records a Claude session's own edits and a subagent's, apart", () => {
    const t = createEditTracker();
    t.observe(env(claudePost("Edit", { file_path: "/repo/src/a.ts" }), T0));
    t.observe(env(claudePost("Write", { file_path: "/repo/src/b.ts" }, { agent_id: SUB, agent_type: "Explore" }), T0 + 10));
    t.observe(env(claudePost("NotebookEdit", { notebook_path: "/repo/n.ipynb" }, { agent_id: SUB }), T0 + 20));

    expect(t.editsFor(SID)).toEqual([{ path: "/repo/src/a.ts", at: T0, cwd: "/repo", agentId: null }]);
    expect(t.editsFor(SID, { agentId: SUB })).toEqual([
      { path: "/repo/n.ipynb", at: T0 + 20, cwd: "/repo", agentId: SUB },
      { path: "/repo/src/b.ts", at: T0 + 10, cwd: "/repo", agentId: SUB },
    ]);
    // The session is the whole team: from the main node, every agent's files,
    // each marked with who did it, newest first.
    expect(t.editsFor(SID, { includeSubagents: true }).map((e: { path: string; agentId: string | null }) => [e.path, e.agentId])).toEqual([
      ["/repo/n.ipynb", SUB], ["/repo/src/b.ts", SUB], ["/repo/src/a.ts", null],
    ]);
  });

  it("keeps the last edit time per file, and the cwd of that edit", () => {
    const t = createEditTracker();
    t.observe(env(claudePost("Edit", { file_path: "/repo/a.ts" }), T0));
    t.observe(env(claudePost("Edit", { file_path: "/repo/a.ts" }, { cwd: "/repo/sub" }), T0 + 500));
    expect(t.editsFor(SID)).toEqual([{ path: "/repo/a.ts", at: T0 + 500, cwd: "/repo/sub", agentId: null }]);
  });

  it("counts only calls that succeeded", () => {
    const t = createEditTracker();
    t.observe(env({ ...claudePost("Edit", { file_path: "/repo/a.ts" }), hook_event_name: "PostToolUseFailure", error: "String not found" }));
    // A PreToolUse is an intention, not an edit.
    t.observe(env({ ...claudePost("Write", { file_path: "/repo/b.ts" }), hook_event_name: "PreToolUse" }));
    expect(t.editsFor(SID, { includeSubagents: true })).toEqual([]);
  });

  it("joins a Codex patch to its outcome and records it only when it applied", () => {
    const t = createEditTracker();
    const doc = "*** Begin Patch\n*** Update File: src/app.ts\n*** Add File: src/new.ts\n+x\n*** End Patch\n";
    t.observe(env(codex(patchCall("call_ok", doc)), T0, "codex"));
    expect(t.editsFor(CODEX_SID), "the call alone edited nothing yet").toEqual([]);
    t.observe(env(codex(patchOutput("call_ok", 0)), T0 + 50, "codex"));
    expect(t.editsFor(CODEX_SID)).toEqual([
      { path: "/srv/app/src/app.ts", at: T0 + 50, cwd: "/srv/app", agentId: null },
      { path: "/srv/app/src/new.ts", at: T0 + 50, cwd: "/srv/app", agentId: null },
    ]);

    t.observe(env(codex(patchCall("call_bad", "*** Begin Patch\n*** Update File: src/broken.ts\n*** End Patch")), T0 + 60, "codex"));
    t.observe(env(codex(patchOutput("call_bad", 1)), T0 + 70, "codex"));
    expect(t.editsFor(CODEX_SID).map((e: { path: string }) => e.path)).not.toContain("/srv/app/src/broken.ts");
  });

  it("reads a patch applied from inside a Codex exec script", () => {
    const t = createEditTracker();
    const script = 'text(await tools.apply_patch("*** Begin Patch\\n*** Delete File: old.txt\\n*** End Patch\\n"));';
    t.observe(env(codex(execCall("call_s", script)), T0, "codex"));
    t.observe(env(codex(execOutput("call_s", "Script completed")), T0 + 5, "codex"));
    expect(t.editsFor(CODEX_SID)).toEqual([{ path: "/srv/app/old.txt", at: T0 + 5, cwd: "/srv/app", agentId: null }]);
    t.observe(env(codex(execCall("call_f", script.replace("old.txt", "kept.txt"))), T0 + 6, "codex"));
    t.observe(env(codex(execOutput("call_f", "Script failed")), T0 + 7, "codex"));
    expect(t.editsFor(CODEX_SID).map((e: { path: string }) => e.path)).toEqual(["/srv/app/old.txt"]);
  });

  it("forgets everything on the deck's Clear marker, and one session on forget", () => {
    const t = createEditTracker();
    t.observe(env(claudePost("Edit", { file_path: "/repo/a.ts" })));
    t.observe(env({ ...claudePost("Edit", { file_path: "/x/b.ts" }), session_id: "other" }));
    t.forget("other");
    expect(t.editsFor("other", { includeSubagents: true })).toEqual([]);
    expect(t.editsFor(SID)).toHaveLength(1);
    // Only the server's own marker clears; a hook cannot post one.
    t.observe(env({ hook_event_name: "__clear", cwd: "" }, T0, "hook"));
    expect(t.editsFor(SID)).toHaveLength(1);
    t.observe(env({ hook_event_name: "__clear", cwd: "" }, T0, "internal"));
    expect(t.editsFor(SID)).toEqual([]);
  });

  it("names the agents a session edited with, and stays bounded", () => {
    const t = createEditTracker({ maxSessions: 2, maxEditsPerSession: 3, maxPending: 2 });
    for (let i = 0; i < 5; i++) t.observe(env(claudePost("Edit", { file_path: `/repo/f${i}.ts` }), T0 + i));
    // The oldest edits went first.
    expect(t.editsFor(SID).map((e: { path: string }) => e.path)).toEqual(["/repo/f4.ts", "/repo/f3.ts", "/repo/f2.ts"]);
    t.observe(env(claudePost("Edit", { file_path: "/repo/s.ts" }, { agent_id: SUB }), T0 + 9));
    expect(t.agentsOf(SID)).toEqual([null, SUB]);
    t.observe(env({ ...claudePost("Edit", { file_path: "/b/x.ts" }), session_id: "s2" }, T0 + 10));
    t.observe(env({ ...claudePost("Edit", { file_path: "/c/x.ts" }), session_id: "s3" }, T0 + 11));
    // Three sessions against a cap of two: the least recently edited went.
    expect(t.sessions().sort()).toEqual(["s2", "s3"]);
    // Pending Codex calls are bounded too: an outcome for an evicted call edits nothing.
    for (const id of ["p1", "p2", "p3"]) t.observe(env(codex(patchCall(id, "*** Begin Patch\n*** Add File: " + id + "\n*** End Patch")), T0, "codex"));
    t.observe(env(codex(patchOutput("p1", 0)), T0 + 1, "codex"));
    t.observe(env(codex(patchOutput("p3", 0)), T0 + 2, "codex"));
    expect(t.editsFor(CODEX_SID).map((e: { path: string }) => e.path)).toEqual(["/srv/app/p3"]);
  });

  it("ignores payloads it cannot use without throwing", () => {
    const t = createEditTracker();
    for (const junk of [null, undefined, 0, "x", {}, { payload: null }, { payload: { hook_event_name: "PostToolUse" } },
      { payload: { session_id: SID, hook_event_name: "PostToolUse", tool_name: "Edit" } },
      { payload: { session_id: SID, hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: ["x"] } } }]) {
      expect(() => t.observe(junk)).not.toThrow();
    }
    expect(t.sessions()).toEqual([]);
  });
});
