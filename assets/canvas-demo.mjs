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
//   node assets/canvas-demo.mjs <workspace-dir> <events-file>
//   node bin/deck.js --port 4391 --no-open --workspace <workspace-dir> --history <events-file>
//
// Then shoot it at 1600x900, deviceScaleFactor 2, after the fit-view control
// and with the accounts panel CLOSED — it lists real e-mail addresses.
//
const WS = process.argv[2];
const OUT = process.argv[3];
const T0 = Date.now() - 14 * 60_000;
let seq = 1, t = T0;
const out = [];
const push = (payload, source = "hook", dt = 900) => {
  t += dt;
  out.push(JSON.stringify({ seq: seq++, epoch: "demo-441", receivedAt: t, source, payload }));
};
const uid = (s, n) => `${s}-tool-${n}`;

function tools(sid, cwd, list, parent, provider) {
  let n = 0;
  for (const [name, input, ok = true] of list) {
    const id = uid(parent ?? sid, ++n + Math.floor(t % 97));
    const base = { session_id: sid, cwd, provider, tool_name: name, tool_use_id: id, ...(parent ? { parent_tool_use_id: parent } : {}) };
    push({ ...base, hook_event_name: "PreToolUse", tool_input: input }, "hook", 420);
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
  push({ session_id: sid, cwd, provider, hook_event_name: "UsageObserved", model, usage }, "internal", 200);
  if (finish) push({ session_id: sid, cwd, provider, hook_event_name: "Stop" }, "hook", 300);
}

const R = (p) => [["Read", { file_path: `${WS}/${p}` }]];
const E = (p) => [["Edit", { file_path: `${WS}/${p}` }]];
const B = (c) => [["Bash", { command: c }]];

session({
  sid: "11111111-1111-4111-8111-111111111111",
  cwd: `${WS}/web-api`, title: "Add rate limiting to the public API", model: "claude-opus-5",
  usage: { input_tokens: 41_200, output_tokens: 96_800, cache_read_input_tokens: 1_840_000, cache_creation_input_tokens: 118_000 },
  rootTools: [...R("web-api/README.md"), ["Grep", { pattern: "rateLimit" }], ...R("web-api/src/router.ts")],
  finish: false,
  subs: [
    { type: "reviewer", model: "claude-sonnet-5", task: "Review the middleware",
      tools: [...R("web-api/src/mw/limit.ts"), ["Grep", { pattern: "429" }], ...R("web-api/test/limit.test.ts")], done: false },
    { type: "migrator", model: "claude-sonnet-5", task: "Move the counters to Redis",
      tools: [...E("web-api/src/store.ts"), ...B("npm test -- store")] },
    { type: "docs", model: "claude-sonnet-5", task: "Document the new headers",
      tools: [...E("web-api/docs/limits.md"), ...R("web-api/docs/api.md")] },
    { type: "general-purpose", model: "claude-sonnet-5", task: "Find every unguarded route",
      tools: [["Grep", { pattern: "app.get(" }], ...R("web-api/src/routes/public.ts"), ...B("rg -n 'router\\\\.' src | wc -l")] },
  ],
});

session({
  sid: "22222222-2222-4222-8222-222222222222",
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

session({
  sid: "33333333-3333-4333-8333-333333333333",
  cwd: `${WS}/infra`, title: "Rotate the deploy keys", model: "gpt-5.5", provider: "codex",
  usage: { input_tokens: 8_900, output_tokens: 14_600, cached_input_tokens: 96_000 },
  rootTools: [...B("terraform plan"), ...E("infra/keys.tf"), ...B("terraform apply -auto-approve")],
});

writeFileSync(OUT, out.join("\n") + "\n");
console.log("events:", out.length);
