// One Codex rollout record in, one synthetic hook payload out: the whole of the
// Codex translation, and the one place the shape of a rollout line is read.
//
// These lived in src/server/index.mjs, inside the rollout watcher, and they are
// the part of it that neither watches nor tails — no file, no timer, no ring.
// The watcher decides which lines to read and what becomes of the payload; this
// decides what a line MEANS, with each note about a record Codex writes (#397,
// #398, #399, #417) beside the branch it explains. The tests that pin the
// mapping against the real reducer import it from here, without importing the
// server they never needed.
//
// The two per-session maps came with it, because codexObjToPayload is what
// writes them. They are exported as they are rather than wrapped: the watcher
// reads the model back after each line to announce a change, and forgetSession
// clears both when a session expires, exactly as it did beside them.

export const codexSessionModel = new Map();   // sid -> last model string
// sid -> the `approval_policy` of the newest `turn_context` seen on this
// session. See codexObjToPayload for why this is read and what it is NOT used
// for; #398 for why the deck holds it at all.
export const codexSessionApproval = new Map(); // sid -> last approval_policy string

// ─── What a rollout record states ─────────────────────────────────────────
// The record shapes more than one reader takes a fact off: the translation
// below, which reads them as events; codex-enrichment.mjs, which reads a
// rollout's head and tail for a hook-delivered session's usage, model and
// window; codex-usage.mjs, which reads every token_count for the usage windows;
// and the watcher's header read in codex-watch.mjs. Each tested the shape for
// itself, four spellings of the same `obj.type` and `payload.type` checks, and
// OpenAI has renamed a record once already (#996) — so the shape is read here,
// once, and each reader asks for the fact. A shape only the translation reads
// stays inline in codexObjToPayload, beside the note that explains it.

/** The payload of a `session_meta` record — the rollout's first line, with the
 *  session's id, its cwd and sometimes its model — or null. */
export function sessionMeta(obj) {
  return obj && obj.type === "session_meta" && obj.payload ? obj.payload : null;
}

/** The `info` of a `token_count` event: the session's cumulative spend
 *  (`total_token_usage`), the last request's (`last_token_usage`) and the
 *  window (`model_context_window`) — see codexObjToPayload for which is which —
 *  or null. */
export function tokenCountInfo(obj) {
  const pl = obj && obj.payload;
  return obj && obj.type === "event_msg" && pl && pl.type === "token_count" && pl.info ? pl.info : null;
}

/** The context window a `task_started` event states, or null. It fires once per
 *  turn, and is the other carrier of the window beside token_count. */
export function taskStartedWindow(obj) {
  const pl = obj && obj.payload;
  return obj && obj.type === "event_msg" && pl && pl.type === "task_started" && typeof pl.model_context_window === "number"
    ? pl.model_context_window
    : null;
}

/** The model a `response_item` names, or null. */
export function responseItemModel(obj) {
  const pl = obj && obj.payload;
  return obj && obj.type === "response_item" && pl && typeof pl.model === "string" ? pl.model : null;
}

/**
 * The human's prompt out of a 0.147-era `item_completed` item.
 *
 * `item.content` is an array of parts — every UserMessage observed carries a
 * single `{ type: "text", text, text_elements }` — so the parts are joined
 * rather than indexed, and a part with no string `text` contributes nothing
 * instead of printing "undefined" into the prompt the card shows.
 */
function codexItemText(item) {
  const parts = Array.isArray(item && item.content) ? item.content : [];
  return parts.map(p => (p && typeof p.text === "string" ? p.text : "")).join("");
}

// Map one parsed rollout object to a synthetic hook payload (or null to skip).
// Mutates codexSessionModel and returns { payload, modelEvent } where
// modelEvent is an optional ModelObserved to emit first when the model changed.
//
// Exported for the rollout watcher in codex-watch.mjs, and for the tests: this
// is the whole of the Codex translation, and the lifecycle it produces is worth
// pinning against the real reducer without standing up a watcher, a temp home
// and a 1.5s poll to get at it.
export function codexObjToPayload(obj, sid, cwd) {
  const type = obj && obj.type;
  const pl = (obj && obj.payload) || {};
  const model = codexSessionModel.get(sid);
  // Rides on every payload this function returns, exactly as `model` does and
  // for the same reason: it is a property of the SESSION rather than of any one
  // event, the rollout restates it on every turn, and a field spread onto each
  // payload needs no event of its own and self-heals on the next line the
  // watcher reads. The reducer stamps it on the root beside `contextWindow`.
  const approval_policy = codexSessionApproval.get(sid);
  const base = { session_id: sid, cwd, provider: "codex", approval_policy };

  // Track model from turn_context / response_item before mapping events.
  if (type === "turn_context") {
    if (typeof pl.model === "string") codexSessionModel.set(sid, pl.model);
    // #398: the deck used to read `model` out of this record and drop
    // everything else, and `approval_policy` was the field that mattered most
    // among the discarded ones. It is the ONLY recorded fact anywhere in a
    // rollout that says whether this session is even capable of stopping to ask
    // a human: at "never" Codex denies an escalation outright rather than
    // prompting, so a quiet session there is genuinely working, while at
    // "on-request" / "on-failure" / "untrusted" a quiet one may be parked on a
    // prompt the deck will never see.
    //
    // It is read to SAY that, and deliberately not to infer a block from it —
    // see codex-approval.ts. Codex persists no approval record of any kind (58
    // turn_contexts and ~1,100 records across the rollouts on this machine
    // carry no approval-shaped type; the persist filter keeps every *_end and
    // drops every request/begin — patch_apply_end with no patch_apply_begin,
    // web_search_end with no begin, item_completed with no item_started), so a
    // "waiting" state derived from this plus a pending call would be a guess
    // wearing the clothes of a measurement.
    //
    // Deleted from the record when the value is missing or not a string, so this
    // server stops stamping a stale policy on the payloads it builds from here
    // on. The page does not un-say it, though. `approval_policy: undefined` does
    // not survive JSON.stringify, so the wire has no way to say "cleared", and
    // the reducer applies the field only when it is a non-empty string — a card
    // keeps the last policy it was told for as long as the session is on the
    // board. This comment used to promise the stale answer was cleared; it is
    // cleared here and nowhere else (#996).
    if (typeof pl.approval_policy === "string" && pl.approval_policy) {
      codexSessionApproval.set(sid, pl.approval_policy);
    } else {
      codexSessionApproval.delete(sid);
    }
    return null;
  }
  const itemModel = responseItemModel(obj);
  if (itemModel !== null) {
    codexSessionModel.set(sid, itemModel);
  }

  if (type === "event_msg") {
    if (pl.type === "user_message") {
      const prompt = typeof pl.message === "string" ? pl.message : "";
      return { ...base, hook_event_name: "UserPromptSubmit", prompt, model };
    }
    // Codex 0.147 stopped writing `user_message` and writes the same submission
    // as an `item_completed` carrying a `UserMessage` item instead. The two are
    // mutually exclusive per CLI version — across the rollouts sampled here the
    // 0.144 files have `user_message` and no `item_completed` at all, and the
    // 0.147 files have exactly one `UserMessage` item per turn and no
    // `user_message` — so handling both names emits one prompt per turn either
    // way rather than two on either version. The item is the human's typed text
    // only: the AGENTS.md preamble Codex prepends is written as a bare
    // `response_item` with role "user" and never gets an item of its own.
    //
    // This matters far beyond the prompt text. `UserPromptSubmit` is what puts
    // a settled root back to `active` (session-lifecycle.ts in the client), so
    // on 0.147 it is the ONLY thing that reopens a session for its second turn —
    // without it the `Stop` below would trade "live forever" for "done
    // forever", which is not better.
    if (pl.type === "item_completed" && pl.item && pl.item.type === "UserMessage") {
      return { ...base, hook_event_name: "UserPromptSubmit", prompt: codexItemText(pl.item), model };
    }
    // Codex states THREE numbers on every `token_count` and this branch used to
    // take one of them (#399). The other two are what the context donut is drawn
    // from, so the deck rendered no context readout at all for the only provider
    // that reports its window exactly.
    //
    // Measured across every rollout under this machine's CODEX_HOME — 178
    // `token_count` records, 164 on Codex 0.144.5 and 14 on 0.147.0 — all 178
    // carry `info.last_token_usage`, `info.total_token_usage` and
    // `info.model_context_window`. Nothing here is a new read: the line is
    // already parsed and the object already destructured.
    //
    //   total_token_usage    cumulative SPEND for the session. Every request's
    //                        prompt summed, so it counts the cached prefix again
    //                        on every turn and passes the context window many
    //                        times over inside one session (5,238,700 against a
    //                        258,400 window in the longest file here). Correct
    //                        for cost, meaningless as an occupancy figure.
    //
    //   last_token_usage     the MOST RECENT request: `input_tokens` is the whole
    //                        conversation Codex sent (it already contains the
    //                        cached prefix — see billedInputTokens), plus that
    //                        request's completion. `total_tokens` is exactly
    //                        input + output on 177 of the 178 records.
    //
    //   model_context_window the CLI's own ceiling, 258,400 for gpt-5.6 against
    //                        the 1,050,000 the static table guesses.
    //
    // WHY `last_token_usage.total_tokens` AND NOT `input_tokens`. The prompt-only
    // figure is the closer analogue of the Claude side, which sums the last usage
    // block's input + cache_read + cache_creation and leaves the completion out.
    // The difference is one response — 20 to 2,288 tokens in this sample, under
    // 1% of the window — and `total_tokens` wins on the case where they diverge
    // for real: on `thread_rolled_back` (the user rewinding the conversation)
    // Codex writes a `token_count` whose per-request components are all zero and
    // whose `last_token_usage.total_tokens` is the RECOMPUTED context size —
    // 47,355, down from 58,516 — while `total_token_usage` does not move at all,
    // because no request was made. Codex is using that field as "tokens in the
    // window", and reading `input_tokens` there would collapse the donut to 0%
    // at precisely the moment the number changed most.
    //
    // The window rides along too. `task_started` below is the only other carrier
    // and it fires once per turn, so a deck that attached mid-turn — the ordinary
    // case, since the watcher skips a pre-existing session's history at startup —
    // had to wait for the next turn before the donut could be scaled against
    // anything but the wrong static default.
    const info = tokenCountInfo(obj);
    if (info) {
      const last = info.last_token_usage;
      const contextTokens = last && typeof last.total_tokens === "number" ? last.total_tokens : undefined;
      const window = typeof info.model_context_window === "number" ? info.model_context_window : undefined;
      // A record that states none of the three says nothing, and emitting an
      // event for it would put an empty envelope in the ring buffer and in the
      // persisted log for every reader to skip forever.
      if (!info.total_token_usage && contextTokens === undefined && window === undefined) return null;
      return {
        ...base,
        hook_event_name: "UsageObserved",
        usage: info.total_token_usage,
        model,
        model_context_window: window,
        context_tokens: contextTokens,
      };
    }
    const startWindow = taskStartedWindow(obj);
    if (startWindow !== null) {
      return { ...base, hook_event_name: "ModelObserved", model, model_context_window: startWindow };
    }
    // The end of a turn, which is the only end Codex ever announces. Both names
    // are one outcome as far as the deck is concerned — the turn is over and
    // nothing is running — so both settle the root the way Claude's own Stop
    // hook does. They are also exhaustive: across the rollouts sampled here
    // every `task_started` is answered by exactly one of the two (54 completes
    // + 1 abort for 55 starts), so no turn is left open by this mapping and
    // none is closed twice. `turn_aborted` is the Esc key, and it is the case
    // that matters most on the deck: pressing Esc is precisely when the user is
    // watching to confirm the thing stopped.
    //
    // Per TURN, not per session, and that is correct: Codex writes no
    // session-close record at all — a rollout simply stops growing when the
    // terminal goes away — so `sweepStaleSessions` remains the only thing that
    // ends a Codex *session*, and it must. What changes is that it now only
    // ever sees the sessions it was written for: the ones that died without
    // finishing. A turn that really ended is settled here, at the moment it
    // ended, with no `reaped` flag, because it was a finish and not a guess.
    if (pl.type === "task_complete" || pl.type === "turn_aborted") {
      return { ...base, hook_event_name: "Stop", model };
    }
    return null;
  }
  if (type === "response_item") {
    if (pl.type === "function_call") {
      let input = pl.arguments;
      try { input = JSON.parse(pl.arguments); } catch {}
      return { ...base, hook_event_name: "PreToolUse", tool_name: pl.name ?? "tool", tool_input: input, tool_use_id: pl.call_id, model };
    }
    if (pl.type === "custom_tool_call") {
      return { ...base, hook_event_name: "PreToolUse", tool_name: pl.name ?? "tool", tool_input: codexCustomToolInput(pl.name, pl.input), tool_use_id: pl.call_id, model };
    }
    // #397: the outcome, not just the fact that an outcome arrived. This used
    // to hardcode "PostToolUse" for both output types, and the reducer derives
    // `ok` from the event NAME (`tc.ok = name === "PostToolUse"`) — so `ok` was
    // structurally incapable of being false on the Codex path and a command
    // that exited non-zero drew exactly like one that succeeded. Every surface
    // that reads the flag inherited the lie: the burst dot, the tool row, the
    // ToolModal styling, the detail-panel error count, and the session
    // summary's "Errors" stat, which was therefore pinned at 0 for the life of
    // a Codex session. `PostToolUseFailure` is the name the reducer already
    // understands (it sets `ok = false` and writes an `errorPreview` from the
    // response); nothing but this mapper was missing.
    if (pl.type === "function_call_output" || pl.type === "custom_tool_call_output") {
      const tool_response = pl.output != null ? parseCodexOutput(pl.output) : undefined;
      const name = codexCallFailed(pl.output) ? "PostToolUseFailure" : "PostToolUse";
      return { ...base, hook_event_name: name, tool_use_id: pl.call_id, tool_response, model };
    }
  }
  return null;
}

/**
 * Wrap a `custom_tool_call`'s raw input under the key that describes what it
 * actually is.
 *
 * WHY THIS IS NOT JUST `{ patch: input }` ANY MORE (#417). Codex's
 * `custom_tool_call` container carries a bare string and nothing that says what
 * kind of string it is — the tool's NAME is the only discriminator. When this
 * branch was written the container had exactly one inhabitant, `apply_patch`,
 * so it hardcoded `patch` and was right. It is no longer the only inhabitant,
 * and on 0.147 it is not even the common one:
 *
 *   CLI      custom_tool_call name   count
 *   0.144.5  exec                       77
 *   0.144.5  apply_patch                 2
 *   0.147.0  exec                        6
 *
 * Eighty-three shell scripts were therefore filed on the deck as patches. The
 * client's `commandStringOf` reads `cmd` / `command` / `script` and never
 * `patch`, so no Codex call could show what it ran; `extractFilePath` mean-
 * while reads `patch` and tried to find a `*** Update File:` header in a
 * JavaScript program. Keying off the name fixes both directions at once.
 *
 * WHY `exec` GETS `script` AND NOT `command`. Because it is not a command. The
 * `exec` tool takes a small JavaScript program that calls into a `tools.*` API
 * — 83 of 83 inputs on this machine start with `const `, none parses as JSON,
 * all are multi-line — and Codex's own result wrapper calls it one, prefixing
 * the output with "Script completed" / "Script failed" rather than an exit code
 * (the line #397 reads). Filing a program under `command` would make the deck
 * draw the first token of the program as the command that ran, which is the
 * word `const` on every Codex call in the session. `script` is both true and
 * already understood by the client, which digs the real command out of the
 * program from there.
 *
 * WHY THE FALLBACK IS `input` AND NOT A GUESS. A name this function has never
 * heard of is a string whose meaning is unknown, and the one thing worse than
 * showing it under a neutral key is showing it under a confident wrong one —
 * that is the whole of this bug, repeated. `input` claims nothing; the tool's
 * own name still reaches the bubble, so an unrecognised Codex tool degrades to
 * "a tool I cannot read the arguments of" instead of "a patch".
 */
const CODEX_CUSTOM_TOOL_INPUT_KEY = {
  // A `*** Begin Patch … *** End Patch` document (2/2 observed, both 0.144.5).
  // Unchanged, and it has to stay unchanged: the client's extractFilePath()
  // pulls the edited file's path out of `input.patch` for the sub-bubble.
  apply_patch: "patch",
  // A JavaScript program. See above.
  exec: "script",
};

function codexCustomToolInput(name, input) {
  const key = CODEX_CUSTOM_TOOL_INPUT_KEY[name] ?? "input";
  return { [key]: input };
}

/**
 * The text parts of a Codex tool result, in the order Codex wrote them.
 *
 * Codex writes the result in two different containers and the deck sees both,
 * so this is where the difference stops. Across the rollouts sampled here:
 * `custom_tool_call_output.output` is an ARRAY of `{ type: "input_text", text }`
 * parts (85/85, on 0.144 and 0.147 alike), and `function_call_output.output` is
 * a bare string (32/32). The `{ output, metadata }` envelope `parseCodexOutput`
 * unwraps was written by neither, but it is cheap to keep tolerating and the
 * unwrapping already lives there, so the string case is routed through it
 * rather than duplicating the guess.
 */
function codexOutputParts(output) {
  if (output == null) return [];
  if (Array.isArray(output)) {
    return output.map(p => (p && typeof p.text === "string" ? p.text : ""));
  }
  const unwrapped = parseCodexOutput(output);
  return typeof unwrapped === "string" ? [unwrapped] : [];
}

/**
 * Did this Codex tool call actually fail?
 *
 * Codex prepends its own wrapper line to the tool's output and that line — not
 * any structured field — is where the outcome lives. Verified against every
 * tool result in this machine's CODEX_HOME:
 *
 *   0.144.5  exec         "Script completed"   75    "Script failed"   2
 *   0.147.0  exec         "Script completed"    6    (no failure observed)
 *   0.144.5  apply_patch  "Exit code: 0"        2
 *   0.144.5  exec_command / run — bare string, no wrapper line at all      32
 *
 * The two CLI versions spell it IDENTICALLY, which is why one rule covers both
 * and why this needs no version sniffing: 0.147 renamed the prompt event (see
 * the `item_completed` branch above) but left the exec wrapper alone.
 *
 * Only the FIRST part's FIRST line is read, and that precision is load-bearing
 * rather than tidiness. The wrapper line is at part index 0 in 85 of 85 results
 * that have one; the later parts are the command's own stdout, and the command
 * prints whatever it likes there. On this machine two exec results contain a
 * line reading "Script error:" in part 1 — output from a script that ran fine
 * under a wrapper that says "Script completed" — so a rule that scanned every
 * part would paint two successful calls red. `\r` is stripped because the same
 * wrapper is written by Codex on Windows.
 *
 * Silence means success, deliberately. A result with no wrapper line — every
 * `function_call_output` on 0.144, and whatever container a future Codex
 * invents — keeps today's behaviour of mapping to `PostToolUse`. Reporting an
 * unknown outcome as a failure would trade one wrong colour for another, and
 * this direction is the recoverable one: a missed failure is a call that draws
 * as it always has, while a false failure puts a red dot and an "Errors" count
 * on a session that did nothing wrong.
 */
function codexCallFailed(output) {
  const first = codexOutputParts(output)[0];
  if (typeof first !== "string") return false;
  const head = first.split("\n")[0].replace(/\r$/, "");
  if (/^Script failed\b/.test(head)) return true;
  // apply_patch reports itself with an exit code instead of a word. Anything
  // non-zero is a patch that did not apply.
  const exit = /^Exit code:\s*(\d+)/.exec(head);
  if (exit) return Number(exit[1]) !== 0;
  return false;
}

function parseCodexOutput(raw) {
  if (typeof raw !== "string") return raw;
  try {
    const o = JSON.parse(raw);
    return (o && typeof o.output === "string") ? o.output : raw;
  } catch {
    return raw;
  }
}
