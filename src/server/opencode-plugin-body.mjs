// ccdeck's opencode plugin: the one function the installed plugin file is made
// of.
//
// opencode loads every `<config>/opencode/plugins/*.js` into its own process and
// runs it on Bun, so that file has to stand alone — it may import nothing but
// node: built-ins, and nothing of ccdeck is reachable from it. So the plugin is
// this function, written to name nothing outside its own body, and
// opencode-plugin.mjs writes its source text (Function.prototype.toString) into
// the file after the config and the one import it needs. The suite calls the
// same function with fakes, which is how the queue, the timeout and the mapping
// are tested without opencode.
//
// ONE FILE, TWO OPENCODES. OpenCode 1 (`opencode-ai`) and OpenCode 2
// (`@opencode/cli`) have incompatible plugin APIs and both are maintained. The
// object this returns is the shape opencode's migration guide gives for serving
// both: OpenCode 1 reads the default export's `id` and calls `server(input)`
// for its hooks, OpenCode 2 reads the same `id` and calls `setup(ctx)`. Each
// ignores the other's key. The file exports that object as its default and
// nothing else, because a module OpenCode 1 does not recognise as one plugin
// has every export called as a plugin of its own.
//
// NEVER IN OPENCODE'S WAY. OpenCode 1 awaits every hook before it goes on (the
// tool waits for `tool.execute.before`), and nothing catches what a hook throws.
// So every hook here records the event and returns at once, inside a try that
// swallows everything; the forwarding happens on a serial queue behind it. One
// forwarder runs at a time, which keeps a call's PreToolUse ahead of its
// PostToolUse; the queue is capped and a full one drops the new event; a
// forwarder still running after `killMs` is killed. Nothing is ever printed: a
// plugin's output lands in the user's terminal, and the payloads are prompts,
// tool input and tool output.
//
// THE TRANSPORT is the deck's own forwarder, hook.js, run exactly as the Claude
// hooks run it — argv only, never a shell — with one Claude-shaped event as
// JSON on stdin and `--provider opencode` on the command line. hook.js finds
// the decks, proves them and posts; nothing new is on the wire.
export function ccdeckOpencodePlugin({
  spawn,
  config,
  env = {},
  timers = { setTimeout, clearTimeout },
  limits = {},
}) {
  const QUEUE_MAX = limits.queue ?? 256;
  const SESSIONS_MAX = limits.sessions ?? 500;
  const CALLS_MAX = limits.calls ?? 1000;
  // hook.js ends itself within about two seconds; this is the backstop for the
  // run it cannot see, and the queue waits for nothing longer.
  const KILL_MS = limits.killMs ?? 10_000;
  // A session the plugin first meets mid-life is looked up once, and an answer
  // slower than this is treated as no answer.
  const LOOKUP_MS = limits.lookupMs ?? 2_000;

  const str = (v) => (typeof v === "string" && v !== "" ? v : undefined);
  const obj = (v) => (v !== null && typeof v === "object" ? v : undefined);

  /** Bounded, oldest out: a re-set moves the key to the young end. */
  function remember(map, key, value, max) {
    map.delete(key);
    map.set(key, value);
    while (map.size > max) map.delete(map.keys().next().value);
  }

  // ── The queue ──────────────────────────────────────────────────────────────

  const queue = [];
  let pumping = false;

  function enqueue(job) {
    if (queue.length >= QUEUE_MAX) return;
    queue.push(job);
    if (pumping) return;
    pumping = true;
    pump().catch(() => {});
  }

  async function pump() {
    try {
      while (queue.length > 0) {
        const job = queue.shift();
        try { await job(); } catch { /* one event lost, never the queue */ }
      }
    } finally {
      pumping = false;
    }
  }

  /** Run hook.js once with `payload` on stdin; resolves when it has exited, failed
   *  to start or been killed, and never rejects. */
  function forward(payload) {
    return new Promise((resolve) => {
      let body;
      try { body = JSON.stringify(payload); } catch { resolve(); return; }
      let settled = false;
      let current = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        try { timers.clearTimeout(timer); } catch { /* gone */ }
        resolve();
      };
      const timer = timers.setTimeout(() => {
        try { current?.kill(); } catch { /* gone */ }
        finish();
      }, KILL_MS);
      try { timer?.unref?.(); } catch { /* a fake timer */ }
      const childEnv = { ...env };
      // hook.js finds the decks in <claude config dir>/agent-dag, and opencode's
      // environment need not carry the CLAUDE_CONFIG_DIR the deck was started
      // with. The directory the installer saw is the one the deck registered in.
      if (str(config?.claudeDir)) childEnv.CLAUDE_CONFIG_DIR = config.claudeDir;
      // `fallback` is the node on PATH, for a recorded node that is gone — what
      // an nvm, fnm or Volta uninstall does to it. The Claude hook command
      // falls back the same way. A cmd.exe line (a .cmd launcher on Windows)
      // has nothing to fall back to.
      const launch = (file, fallback) => {
        let child;
        try {
          child = spawn(file, config.args, {
            shell: false,
            windowsHide: true,
            windowsVerbatimArguments: config.verbatim === true,
            stdio: ["pipe", "ignore", "ignore"],
            env: childEnv,
          });
        } catch {
          if (fallback) launch(fallback, null);
          else finish();
          return;
        }
        current = child;
        const mine = () => current === child;
        child.on("error", (err) => {
          if (!mine()) return;
          if (fallback && (err?.code === "ENOENT" || err?.code === "EACCES")) launch(fallback, null);
          else finish();
        });
        child.on("close", () => { if (mine()) finish(); });
        // Never what keeps opencode running once it is done with everything else.
        try { child.unref?.(); } catch { /* not every runtime has it */ }
        const stdin = child.stdin;
        if (stdin) {
          stdin.on?.("error", () => {});
          try { stdin.end(body); } catch { /* the child is already gone */ }
        }
      };
      if (!str(config?.file) || !Array.isArray(config?.args)) { finish(); return; }
      launch(config.file, config.verbatim === true || config.file === "node" ? null : "node");
    });
  }

  async function forwardAll(payloads) {
    for (const p of payloads) await forward(p);
  }

  // ── Sessions ───────────────────────────────────────────────────────────────
  //
  // A child session (one with a parentID) is a subagent: its events go out under
  // the ROOT session's id, naming the child as the agent, which is how Claude
  // Code reports a subagent and so how the deck draws one.

  const sessions = new Map();
  /** Tool calls whose PreToolUse went out and whose outcome has not. */
  const openCalls = new Map();
  /** Permission and question requests already announced. */
  const asked = new Map();

  function touch(id) {
    const entry = sessions.get(id);
    if (entry) remember(sessions, id, entry, SESSIONS_MAX);
    return entry;
  }

  function register(id, info, fallbackDir) {
    const parentID = str(info?.parentID);
    const parent = parentID ? sessions.get(parentID) : undefined;
    const entry = {
      id,
      parentID,
      root: parentID ? (parent ? parent.root : parentID) : id,
      directory: str(info?.directory) ?? parent?.directory ?? fallbackDir,
      agentType: str(info?.agent),
      model: str(info?.model),
      started: false,
      active: false,
      stopped: false,
    };
    remember(sessions, id, entry, SESSIONS_MAX);
    return entry;
  }

  function withTimeout(start) {
    return new Promise((resolve) => {
      let t = null;
      try {
        t = timers.setTimeout(() => resolve(null), LOOKUP_MS);
        t?.unref?.();
      } catch { /* a fake timer */ }
      const done = (v) => { try { timers.clearTimeout(t); } catch { /* gone */ } resolve(v); };
      Promise.resolve().then(start).then(done, () => done(null));
    });
  }

  /** The session's entry, looking it up when this is the first the plugin has
   *  heard of it: a session resumed from an earlier run, or a child whose
   *  `session.created` has not been delivered yet. Its parent comes with it. */
  async function resolveSession(ctx, id, depth = 0) {
    const known = touch(id);
    if (known) return known;
    const info = obj(await withTimeout(() => ctx.lookup(id)));
    const parentID = str(info?.parentID);
    if (parentID && depth < 4 && !sessions.has(parentID)) await resolveSession(ctx, parentID, depth + 1);
    return touch(id) ?? register(id, info, ctx.directory);
  }

  function payload(entry, name, extra) {
    const p = { hook_event_name: name, session_id: entry.root, cwd: entry.directory };
    if (entry.parentID) p.agent_id = entry.id;
    return Object.assign(p, extra);
  }

  /** The start events this entry still owes, its root's first. */
  function starts(entry) {
    const out = [];
    if (entry.parentID) {
      const root = sessions.get(entry.root);
      if (root && !root.parentID && !root.started) out.push(...starts(root));
      if (!entry.started) {
        entry.started = true;
        out.push(payload(entry, "SubagentStart", entry.agentType ? { agent_type: entry.agentType } : {}));
      }
    } else if (!entry.started) {
      entry.started = true;
      out.push(payload(entry, "SessionStart", entry.model ? { model: entry.model } : {}));
    }
    return out;
  }

  /** The end of a turn: Stop for a root, SubagentStop for a child — once per
   *  turn, however many of opencode's ways of saying so arrive. */
  function stopOf(entry) {
    if (!entry.active) return [];
    entry.active = false;
    if (!entry.parentID) return [payload(entry, "Stop", {})];
    entry.stopped = true;
    return [payload(entry, "SubagentStop", entry.agentType ? { agent_type: entry.agentType } : {})];
  }

  // ── Tool names and inputs ──────────────────────────────────────────────────
  //
  // opencode's built-in tools under the names Claude Code gives the same tools,
  // so the deck's icons, labels and summaries apply; and the input keys the deck
  // reads under the spelling it reads them (`file_path`, where opencode says
  // `filePath`). apply_patch keeps its name — the deck knows it from Codex — and
  // its `patchText` becomes the `patch` the deck takes the file name from. A
  // tool not listed here, an MCP one included, passes through as it came.
  // OpenCode 2 renamed two tools (`shell`, `subagent`) and says `path` for the
  // file a read, write or edit works on; Grep and Glob keep `path`, which is
  // their folder in Claude Code too.
  const TOOL_NAMES = new Map([
    ["bash", "Bash"], ["shell", "Bash"], ["read", "Read"], ["write", "Write"], ["edit", "Edit"],
    ["multiedit", "MultiEdit"], ["grep", "Grep"], ["glob", "Glob"], ["list", "LS"],
    ["webfetch", "WebFetch"], ["websearch", "WebSearch"], ["task", "Task"], ["subagent", "Task"],
    ["todowrite", "TodoWrite"], ["skill", "Skill"], ["question", "AskUserQuestion"],
    ["patch", "apply_patch"], ["apply_patch", "apply_patch"],
  ]);
  const INPUT_KEYS = new Map([
    ["filePath", "file_path"], ["oldString", "old_string"], ["newString", "new_string"],
    ["replaceAll", "replace_all"], ["patchText", "patch"],
  ]);
  const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit"]);

  function toolOf(rawName, rawInput) {
    const raw = str(rawName) ?? str(obj(rawName)?.name) ?? "unknown";
    const name = TOOL_NAMES.get(raw);
    if (!name) return { name: raw, input: rawInput };
    const o = obj(rawInput);
    if (!o || Array.isArray(o)) return { name, input: rawInput };
    const keyOf = (k) => {
      if (FILE_TOOLS.has(name) && k === "path" && !("file_path" in o) && !("filePath" in o)) return "file_path";
      if (name === "Task" && k === "agent" && !("subagent_type" in o)) return "subagent_type";
      return INPUT_KEYS.get(k) ?? k;
    };
    const input = {};
    for (const [k, v] of Object.entries(o)) input[keyOf(k)] = v;
    return { name, input };
  }

  const modelRef = (m) => {
    const o = obj(m);
    if (!o) return str(m);
    const id = str(o.modelID) ?? str(o.id);
    const provider = str(o.providerID);
    return provider && id ? `${provider}/${id}` : id;
  };

  // ── What happened, provider-neutral ────────────────────────────────────────
  //
  // Every adapter below turns one opencode event into one of these, and each of
  // these only queues a job: the session state is read and changed on the queue,
  // in arrival order, so a lookup in flight cannot reorder anything.

  const ev = {
    created(ctx, id, info) {
      if (!id) return;
      enqueue(async () => {
        const entry = touch(id) ?? register(id, info, ctx.directory);
        await forwardAll(starts(entry));
      });
    },

    prompt(ctx, id, text, model) {
      if (!id) return;
      enqueue(async () => {
        const entry = await resolveSession(ctx, id);
        if (model) entry.model = model;
        // A child's prompt is the task its parent handed it, not the user's, so
        // it is not a UserPromptSubmit — it is a subagent (re)starting.
        if (entry.parentID && entry.stopped) { entry.started = false; entry.stopped = false; }
        const out = starts(entry);
        entry.active = true;
        if (!entry.parentID) out.push(payload(entry, "UserPromptSubmit", model ? { prompt: text, model } : { prompt: text }));
        await forwardAll(out);
      });
    },

    toolBefore(ctx, id, callID, rawName, rawInput) {
      if (!id) return;
      enqueue(async () => {
        const entry = await resolveSession(ctx, id);
        const out = starts(entry);
        entry.active = true;
        const { name, input } = toolOf(rawName, rawInput);
        if (callID) remember(openCalls, callID, true, CALLS_MAX);
        out.push(payload(entry, "PreToolUse", { tool_name: name, tool_input: input, ...(callID ? { tool_use_id: callID } : {}) }));
        await forwardAll(out);
      });
    },

    /** `ok` false is a failure, `response` then being its message. `onlyOpen`
     *  is for a source that also reports calls whose PreToolUse never went out. */
    toolAfter(ctx, id, callID, rawName, rawInput, ok, response, onlyOpen = false) {
      if (!id) return;
      enqueue(async () => {
        if (onlyOpen && !(callID && openCalls.has(callID))) return;
        if (callID) openCalls.delete(callID);
        const entry = await resolveSession(ctx, id);
        const out = starts(entry);
        entry.active = true;
        const { name, input } = toolOf(rawName, rawInput);
        const common = { tool_name: name, tool_input: input, ...(callID ? { tool_use_id: callID } : {}) };
        out.push(ok
          ? payload(entry, "PostToolUse", { ...common, tool_response: response })
          : payload(entry, "PostToolUseFailure", { ...common, tool_response: response, error: response }));
        await forwardAll(out);
      });
    },

    /** Waiting for the user: a permission prompt, or a question. */
    waiting(ctx, id, kind, requestID) {
      if (!id) return;
      enqueue(async () => {
        if (requestID) {
          if (asked.has(requestID)) return;
          remember(asked, requestID, true, CALLS_MAX);
        }
        const entry = await resolveSession(ctx, id);
        const out = starts(entry);
        entry.active = true;
        out.push(payload(entry, "Notification", {
          notification_type: "permission_prompt",
          message: kind === "question" ? "opencode has a question" : "opencode needs your permission",
        }));
        await forwardAll(out);
      });
    },

    busy(_ctx, id) {
      if (!id) return;
      enqueue(async () => {
        const entry = touch(id);
        if (entry) entry.active = true;
      });
    },

    /** Idle, failed or interrupted: the turn is over. A session the plugin never
     *  saw at work has no turn to end. */
    idle(_ctx, id) {
      if (!id) return;
      enqueue(async () => {
        const entry = touch(id);
        if (entry) await forwardAll(stopOf(entry));
      });
    },

    deleted(_ctx, id) {
      if (!id) return;
      enqueue(async () => {
        const entry = sessions.get(id);
        if (!entry) return;
        sessions.delete(id);
        if (!entry.started) return;
        if (!entry.parentID) { await forward(payload(entry, "SessionEnd", {})); return; }
        if (!entry.stopped) {
          entry.active = true;
          await forwardAll(stopOf(entry));
        }
      });
    },
  };

  // ── OpenCode 1 ─────────────────────────────────────────────────────────────

  const textOf = (parts) => (Array.isArray(parts) ? parts : [])
    .filter((p) => p?.type === "text" && !p.synthetic && !p.ignored && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");

  // The task tool titles a child "<description> (@<agent> subagent)", and the
  // session itself does not always say which agent it runs.
  const agentFromTitle = (title) => str(title)?.match(/\(@([^\s()]+) subagent\)\s*$/)?.[1];

  function v1Event(ctx, event) {
    const type = str(event?.type);
    const props = obj(event?.properties) ?? {};
    const sid = str(props.sessionID);
    switch (type) {
      case "session.created": {
        const info = obj(props.info) ?? {};
        ev.created(ctx, str(info.id) ?? sid, {
          parentID: info.parentID,
          directory: info.directory,
          agent: str(info.agent) ?? agentFromTitle(info.title),
          model: modelRef(info.model),
        });
        break;
      }
      case "session.deleted": ev.deleted(ctx, str(obj(props.info)?.id) ?? sid); break;
      case "session.idle": ev.idle(ctx, sid); break;
      case "session.error": ev.idle(ctx, sid); break;
      case "session.status": {
        const status = str(obj(props.status)?.type);
        if (status === "idle") ev.idle(ctx, sid);
        else if (status === "busy" || status === "retry") ev.busy(ctx, sid);
        break;
      }
      // permission.updated is the name before 1.x; the v2 spellings are the
      // server's newer session runtime. One request is announced once.
      case "permission.asked":
      case "permission.updated":
      case "permission.v2.asked": ev.waiting(ctx, sid, "permission", str(props.id)); break;
      case "question.asked":
      case "question.v2.asked": ev.waiting(ctx, sid, "question", str(props.id)); break;
      // OpenCode 1 runs `tool.execute.after` only when a tool succeeds, so a
      // failed or aborted call is closed from its part turning to "error".
      case "message.part.updated": {
        const part = obj(props.part);
        const state = obj(part?.state);
        if (part?.type !== "tool" || state?.status !== "error") break;
        const message = str(state.error) ?? "tool failed";
        ev.toolAfter(ctx, str(part.sessionID) ?? sid, str(part.callID), part.tool, state.input, false, message, true);
        break;
      }
      default: break;
    }
  }

  function v1Hooks(input) {
    const ctx = {
      directory: str(input?.directory) ?? str(input?.worktree) ?? "",
      lookup: async (id) => {
        const res = await input.client.session.get({ path: { id } });
        const s = obj(res?.data);
        if (!s) return null;
        return { parentID: s.parentID, directory: s.directory, agent: str(s.agent) ?? agentFromTitle(s.title), model: modelRef(s.model) };
      },
    };
    return {
      event: async (arg) => {
        try { v1Event(ctx, arg?.event); } catch { /* never opencode's problem */ }
      },
      "chat.message": async (hookInput, output) => {
        try {
          const role = output?.message?.role;
          if (role && role !== "user") return;
          ev.prompt(ctx, str(hookInput?.sessionID) ?? str(output?.message?.sessionID), textOf(output?.parts),
            modelRef(hookInput?.model) ?? modelRef(output?.message?.model));
        } catch { /* never opencode's problem */ }
      },
      "tool.execute.before": async (hookInput, output) => {
        try {
          ev.toolBefore(ctx, str(hookInput?.sessionID), str(hookInput?.callID), hookInput?.tool, output?.args);
        } catch { /* never opencode's problem */ }
      },
      "tool.execute.after": async (hookInput, output) => {
        try {
          const response = typeof output?.output === "string" ? output.output : output;
          ev.toolAfter(ctx, str(hookInput?.sessionID), str(hookInput?.callID), hookInput?.tool, hookInput?.args, true, response);
        } catch { /* never opencode's problem */ }
      },
    };
  }

  // ── OpenCode 2 ─────────────────────────────────────────────────────────────

  const V2_EVENTS = [
    "session.created", "session.deleted", "session.idle", "session.status",
    "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted",
    "permission.asked", "form.created",
  ];

  const resultText = (result) => {
    const r = obj(result);
    if (!r) return result;
    if (typeof r.content === "string") return r.content;
    if (Array.isArray(r.content)) {
      const text = r.content.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n");
      if (text) return text;
    }
    return r.output ?? r.content;
  };

  function v2Event(ctx, event) {
    const type = str(event?.type);
    const data = obj(event?.data) ?? {};
    const sid = str(data.sessionID);
    switch (type) {
      case "session.created":
        ev.created(ctx, sid, {
          parentID: data.parentID,
          directory: str(obj(data.location)?.directory) ?? str(obj(event.location)?.directory),
          agent: data.agent,
          model: modelRef(data.model),
        });
        break;
      case "session.deleted": ev.deleted(ctx, sid); break;
      case "session.idle":
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted": ev.idle(ctx, sid); break;
      case "session.status": {
        const status = str(obj(data.status)?.type);
        if (status === "idle") ev.idle(ctx, sid);
        else if (status === "busy" || status === "retry") ev.busy(ctx, sid);
        break;
      }
      case "permission.asked": ev.waiting(ctx, sid, "permission", str(data.id)); break;
      // The question tool asks through a form.
      case "form.created": {
        const form = obj(data.form);
        ev.waiting(ctx, str(form?.sessionID), "question", str(form?.id));
        break;
      }
      default: break;
    }
  }

  async function v2Setup(c) {
    const ctx = {
      directory: str(obj(c?.location)?.directory) ?? "",
      lookup: async (id) => {
        const s = obj(await c.session.get({ sessionID: id }));
        if (!s) return null;
        return { parentID: s.parentID, directory: obj(s.location)?.directory, agent: s.agent, model: modelRef(s.model) };
      },
    };
    const pending = [];
    const hook = (domain, name, handler) => {
      try {
        const reg = domain?.hook?.(name, (e) => {
          try { handler(e); } catch { /* never opencode's problem */ }
        });
        if (reg && typeof reg.then === "function") pending.push(reg.catch(() => null));
      } catch { /* a domain this opencode does not have */ }
    };
    hook(c?.tool, "execute.before", (e) => ev.toolBefore(ctx, str(e?.sessionID), str(e?.id), e?.tool, e?.input));
    hook(c?.tool, "execute.after", (e) => {
      const ok = e?.status !== "error";
      const response = ok ? resultText(e?.result) : (str(obj(e?.error)?.message) ?? "tool failed");
      ev.toolAfter(ctx, str(e?.sessionID), str(e?.id), e?.tool, e?.input, ok, response);
    });
    // OpenCode 2's replacement for OpenCode 1's chat.message.
    hook(c?.session, "prompt", (e) => ev.prompt(ctx, str(e?.sessionID), str(obj(e?.prompt)?.text) ?? "", undefined));

    const controller = typeof AbortController === "function" ? new AbortController() : null;
    (async () => {
      try {
        const stream = c.event.subscribe({ types: V2_EVENTS, ...(controller ? { signal: controller.signal } : {}) });
        for await (const event of stream) {
          try { v2Event(ctx, event); } catch { /* never opencode's problem */ }
        }
      } catch { /* the stream ended or this opencode has none */ }
    })();

    // Registered before setup returns, as opencode's own examples do — but a
    // registration that never answers must not hold opencode's start.
    if (pending.length > 0) await withTimeout(() => Promise.all(pending));
    return () => {
      try { controller?.abort(); } catch { /* already over */ }
    };
  }

  return {
    id: "ccdeck-events",
    setup: async (c) => {
      try { return await v2Setup(c); } catch { return () => {}; }
    },
    server: async (input) => {
      try { return v1Hooks(input); } catch { return {}; }
    },
  };
}
