// The session data behind assets/canvas.png.
//
// The shot this replaced was taken against real work, and it published what
// real work is made of: client project names, source file names and a spend
// figure, readable in the nodes, on the front page of a public repo. A hero
// image is the one asset on the page a reader is invited to open full size.
//
// So the canvas is now fed a generated session log instead. Everything the
// screenshot shows is the real deck rendering real events through the real
// reducer — only the work is invented, which is the half nobody is entitled
// to see. It is also the half that was making the shot go stale: a screenshot
// of whatever happened to be running can only be retaken by waiting for
// something photogenic to happen.
//
// THE WHOLE SHOT IS ONE COMMAND NOW:
//
//   node assets/capture-hero.mjs
//
// which writes this log, starts an isolated deck on it, fakes the reads an
// empty home cannot answer (quota, usage, accounts) in the page, and shoots
// assets/canvas.png. Its header says how. By hand, the two steps it wraps are
//
//   node assets/canvas-demo.mjs <workspace-dir> <events-file>
//   node bin/deck.js --port <port> --no-open --workspace <workspace-dir> --history <events-file>
//
// and a deck started that way on your own machine shows your own accounts:
// shoot it at 1920x1080, deviceScaleFactor 2, after the fit-view control and
// with the accounts panel CLOSED unless its roster is faked — it lists real
// e-mail addresses. capture-hero.mjs refuses to save a picture that shows one.
//
// What happens in the log, every time measured back from the moment it is
// written:
//
//   web-api        Claude Code, three subagents. A reviewer is still reading
//                  when the session runs `npm test -- limit` and stops on the
//                  permission prompt for it, six minutes before the shot:
//                  the one session waiting on you.
//   data-pipeline  Claude Code: a first turn with two subagents, finished,
//                  then a second turn running a backfill now. The new prompt
//                  retires the first turn's subagents from the canvas.
//   infra          Codex, written the way the deck's rollout watcher records
//                  a Codex session (src/server/codex-translate.mjs): its own
//                  tool names, `call_…` ids, cumulative usage, no title row
//                  and no subagents.
//
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The canvas stacks sessions in id order, so these read top to bottom as
// web-api, infra, data-pipeline: the waiting session first and the Codex one
// straight under it.
export const SESSION_IDS = {
  webApi: "3f6a2c1e-8b47-4d2a-9e15-7c0b6a4d2f81",
  infra: "5a1d9e47-2c3b-4f80-8d6e-1b9a7c2e4f05",
  dataPipeline: "8c2e7b14-6d5a-4e39-b1f0-3a9d5c7e2b68",
};

/** How long the web-api session has been waiting on its permission prompt. */
export const WAITING_MINUTES = 6;

const CODEX_APPROVAL_POLICY = "on-request";
const CODEX_CONTEXT_WINDOW = 258_400;

/** The demo log, one JSON object per line, as `--history` reads it. */
export function demoLog({ workspace: WS, now = Date.now() }) {
  let seq = 1;
  let t = now - 14 * 60_000;
  const out = [];
  const at = (minutesAgo) => { t = now - minutesAgo * 60_000; };
  const push = (payload, source = "hook", dt = 900) => {
    t += dt;
    out.push(JSON.stringify({ seq: seq++, epoch: "demo-441", receivedAt: t, source, payload }));
  };

  function tools(sid, cwd, list, parent, provider) {
    let n = 0;
    for (const [name, input, ok = true] of list) {
      const id = `${parent ?? sid}-tool-${++n + Math.floor(t % 97)}`;
      const base = { session_id: sid, cwd, provider, tool_name: name, tool_use_id: id, ...(parent ? { parent_tool_use_id: parent } : {}) };
      push({ ...base, hook_event_name: "PreToolUse", tool_input: input }, "hook", 420);
      if (ok === "running") continue;
      push({ ...base, hook_event_name: ok ? "PostToolUse" : "PostToolUseFailure", tool_response: ok ? "ok" : "exit 1" }, "hook", 380);
    }
  }

  function session({ sid, cwd, title, model, provider = "claude", subs = [], rootTools = [], usage, finish = true }) {
    push({ session_id: sid, cwd, provider, hook_event_name: "SessionStart" }, "hook", 200);
    push({ hook_event_name: "SessionNamed", session_id: sid, sessionName: null, sessionTitle: title }, "internal", 60);
    push({ session_id: sid, cwd, provider, hook_event_name: "ModelObserved", model }, "internal", 60);
    push({ session_id: sid, cwd, provider, hook_event_name: "UserPromptSubmit", prompt: title }, "hook", 200);
    tools(sid, cwd, rootTools, null, provider);
    for (const s of subs) {
      const tid = `${sid}-agent-${s.type}`;
      push({ session_id: sid, cwd, provider, hook_event_name: "PreToolUse", tool_name: "Agent",
             tool_use_id: tid, tool_input: { description: s.task, subagent_type: s.type } }, "hook", 300);
      push({ session_id: sid, cwd, provider, hook_event_name: "SubagentStart",
             parent_tool_use_id: tid, agent_type: s.type }, "hook", 120);
      push({ session_id: sid, cwd, provider, hook_event_name: "ModelObserved",
             model, subagentModels: { [tid]: s.model } }, "internal", 60);
      tools(sid, cwd, s.tools, tid, provider);
      if (s.done !== false) {
        push({ session_id: sid, cwd, provider, hook_event_name: "SubagentStop", parent_tool_use_id: tid }, "hook", 200);
        push({ session_id: sid, cwd, provider, hook_event_name: "PostToolUse", tool_name: "Agent",
               tool_use_id: tid, tool_response: "done" }, "hook", 100);
      }
    }
    if (usage) push({ session_id: sid, cwd, provider, hook_event_name: "UsageObserved", model, usage }, "internal", 200);
    if (finish) push({ session_id: sid, cwd, provider, hook_event_name: "Stop" }, "hook", 300);
  }

  function codexSession({ sid, cwd, prompt, model, rootTools, usage, contextTokens }) {
    const base = { session_id: sid, cwd, provider: "codex", approval_policy: CODEX_APPROVAL_POLICY };
    const codex = (payload, dt) => push(payload, "codex", dt);
    codex({ session_id: sid, cwd, provider: "codex", hook_event_name: "SessionStart" }, 200);
    codex({ session_id: sid, cwd, provider: "codex", hook_event_name: "ModelObserved", model }, 60);
    codex({ ...base, hook_event_name: "ModelObserved", model, model_context_window: CODEX_CONTEXT_WINDOW }, 60);
    codex({ ...base, hook_event_name: "UserPromptSubmit", prompt, model }, 200);
    let n = 0;
    for (const [name, input, output] of rootTools) {
      const id = `call_demo${sid.slice(0, 4)}${String(++n).padStart(3, "0")}`;
      codex({ ...base, hook_event_name: "PreToolUse", tool_name: name, tool_input: input, tool_use_id: id, model }, 420);
      const response = name === "apply_patch" ? [{ type: "input_text", text: output }] : output;
      codex({ ...base, hook_event_name: "PostToolUse", tool_use_id: id, tool_response: response, model }, 380);
    }
    codex({ ...base, hook_event_name: "UsageObserved", usage, model, model_context_window: CODEX_CONTEXT_WINDOW, context_tokens: contextTokens }, 200);
    codex({ ...base, hook_event_name: "Stop", model }, 300);
  }

  const R = (p) => [["Read", { file_path: `${WS}/${p}` }]];
  const E = (p) => [["Edit", { file_path: `${WS}/${p}` }]];
  const B = (c) => [["Bash", { command: c }]];

  session({
    sid: SESSION_IDS.webApi,
    cwd: `${WS}/web-api`, title: "Add rate limiting to the public API", model: "claude-opus-5",
    usage: { input_tokens: 41_200, output_tokens: 96_800, cache_read_input_tokens: 1_840_000, cache_creation_input_tokens: 118_000 },
    rootTools: [...R("web-api/README.md"), ["Grep", { pattern: "rateLimit" }], ...R("web-api/src/router.ts")],
    finish: false,
    subs: [
      { type: "reviewer", model: "claude-sonnet-5", task: "Review the middleware",
        tools: [...R("web-api/src/mw/limit.ts"), ["Grep", { pattern: "429" }]], done: false },
      { type: "migrator", model: "claude-sonnet-5", task: "Move the counters to Redis",
        tools: [...E("web-api/src/store.ts"), ...B("npm test -- store")] },
      { type: "docs", model: "claude-sonnet-5", task: "Document the new headers",
        tools: [...E("web-api/docs/limits.md"), ...R("web-api/docs/api.md")] },
    ],
  });

  session({
    sid: SESSION_IDS.dataPipeline,
    cwd: `${WS}/data-pipeline`, title: "Backfill the events table", model: "claude-sonnet-5",
    usage: { input_tokens: 12_400, output_tokens: 28_100, cache_read_input_tokens: 402_000, cache_creation_input_tokens: 31_000 },
    rootTools: [...R("data-pipeline/jobs/backfill.py"), ...B("python -m jobs.backfill --dry-run")],
    subs: [
      { type: "reviewer", model: "claude-sonnet-5", task: "Check the batch size",
        tools: [...R("data-pipeline/jobs/batch.py"), ...E("data-pipeline/jobs/batch.py")] },
      { type: "general-purpose", model: "claude-haiku-4-5-20251001", task: "Count affected rows",
        tools: [...B("psql -c 'select count(*) from events'")] },
    ],
  });

  // The same work as the first version of this log — plan, change the key
  // file, apply — in Codex's words: exec_command (drawn as Shell) and
  // apply_patch (Edit).
  codexSession({
    sid: SESSION_IDS.infra,
    cwd: `${WS}/infra`, prompt: "Rotate the deploy keys", model: "gpt-5.5",
    usage: { input_tokens: 104_900, cached_input_tokens: 96_000, output_tokens: 14_600, reasoning_output_tokens: 9_800, total_tokens: 119_500 },
    contextTokens: 38_600,
    rootTools: [
      ["exec_command", { cmd: "terraform plan" }, "Plan: 0 to add, 2 to change, 0 to destroy."],
      ["apply_patch", { patch: "*** Begin Patch\n*** Update File: keys.tf\n@@\n-  rotation_days = 90\n+  rotation_days = 30\n*** End Patch\n" }, "Exit code: 0\nOutput:\nSuccess. Updated the following files:\nM keys.tf\n"],
      ["exec_command", { cmd: "terraform apply -auto-approve" }, "Apply complete! Resources: 0 added, 2 changed, 0 destroyed."],
    ],
  });

  // web-api runs a test command, and Claude Code asks before it does. The
  // deck names the tool on the prompt only when that call started within 30 s
  // of it, so the two are back to back.
  const web = { session_id: SESSION_IDS.webApi, cwd: `${WS}/web-api`, provider: "claude" };
  at(WAITING_MINUTES);
  push({ ...web, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "demo-wait-bash", tool_input: { command: "npm test -- limit" } });
  push({ ...web, hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" });

  // data-pipeline: a second turn. A new prompt retires the finished
  // subagents of the turn before it (session-lifecycle.ts), so the canvas
  // shows the session as it is now — one card, a backfill running — while the
  // session list keeps every tool it ran and what they cost.
  const pipe = { session_id: SESSION_IDS.dataPipeline, cwd: `${WS}/data-pipeline`, provider: "claude" };
  at(3);
  push({ ...pipe, hook_event_name: "UserPromptSubmit", prompt: "Run it for September" }, "hook", 0);
  push({ ...pipe, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "demo-pipe-bash", tool_input: { command: "python -m jobs.backfill --month 2026-09" } }, "hook", 2_000);


  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [WS, OUT] = process.argv.slice(2);
  if (!WS || !OUT) {
    console.error("usage: node assets/canvas-demo.mjs <workspace-dir> <events-file>");
    process.exit(2);
  }
  const out = demoLog({ workspace: WS });
  writeFileSync(OUT, out.join("\n") + "\n");
  console.log("events:", out.length);
}
