// What the server's transcript scans tell the reducer about a session.
//
// None of these is hook traffic. The server reads each session's transcript —
// after the hook events that name it, and between them — and sends what it
// found back down the same stream as synthetic events: the model, the context
// breakdown, the session's name and recap, the blocks the model is writing, what
// its newest reply says it is doing, the line a background session's job folder
// holds, and the running token totals. Each enriches a root that is already on the board,
// never creates a node and never goes through `resolveOwner`, so `applyEvent`
// hands them here before it attributes anything. `stampSessionFacts` lives here
// for the same reason: the facts Codex restates ride on whatever payload it
// sends, two of them on these scans.
import { rootAgentId, subagentIdFor, type GraphState } from "./graph-state";
import { usageByModelFromWire, usageFromWire } from "./usage-wire";
import type { BackgroundJob, ContextBreakdown, HookPayload } from "./types";

/** A breakdown that asserts nothing, for a root that has not been told anything
 *  about its context yet.
 *
 *  One function rather than two object literals because the two writers below —
 *  the `context_tokens` stamp and `applyContextObserved` — merge into
 *  whatever is already there, and a field that one of them forgot to seed would
 *  read `undefined` where the type promises a number and print "NaN" in the
 *  modal. Adding a field to `ContextBreakdown` should not be able to miss a
 *  starting value in one place and not the other. */
function emptyContextBreakdown(): ContextBreakdown {
  return {
    msgsUser: 0,
    msgsAssistant: 0,
    toolUses: 0,
    toolResults: 0,
    systemReminders: 0,
    currentContextTokens: 0,
    memoryFiles: [],
  };
}

/** The session facts Codex restates on whatever payload it sends, stamped on
 *  the root whichever event carried them. `applyEvent` runs this before any of
 *  the transcript scans below, all of which return early — and two of these
 *  three ride on those very scans. */
export function stampSessionFacts(state: GraphState, p: HookPayload, sessionId: string): void {
  // Codex reports the session's real context window on `task_started`, and the
  // server relays it on a ModelObserved payload — the only event that carries
  // it. This has to run *before* the enrichment branches, all of which
  // return early, otherwise the value never lands anywhere. It is a property
  // of the session, so it goes on the root; the UI prefers it over the static
  // table in context-window.ts.
  if (typeof p.model_context_window === "number" && p.model_context_window > 0) {
    const root = state.agents.get(sessionId);
    if (root) root.contextWindow = p.model_context_window;
  }

  // The session's approval policy, for the same reason and in the same place:
  // Codex restates it on every `turn_context` and the watcher spreads it onto
  // every payload, so it lands here above the branches that return early.
  //
  // Guarded on being a non-empty string rather than assigned unconditionally,
  // because the field is absent from a Claude payload and from a Codex payload
  // emitted before the first `turn_context` of the session was read — and
  // absence there means "not known yet", not "the policy was withdrawn". A
  // session that really does change policy mid-flight restates it on the next
  // turn's `turn_context`, which is the write that supersedes this one.
  //
  // It goes on the ROOT and not on `owner`: the policy governs the session, and
  // stamping it on whichever agent happened to own the event would leave the
  // answer on a subagent that gets pruned. `resolveOwner` has not run yet in any
  // case — this sits above the early-returning enrichment branches on purpose.
  if (typeof p.approval_policy === "string" && p.approval_policy) {
    const root = state.agents.get(sessionId);
    if (root) root.approvalPolicy = p.approval_policy;
  }

  // How much of that window is occupied right now, from the same Codex
  // `token_count` record that reports the window itself — and in the same place,
  // above the branches that return early, for the same reason (#399).
  //
  // It rides on `UsageObserved` rather than arriving as its own event because it
  // is measured at the same instant as the usage totals and by the same record:
  // splitting one record into two events would let the deck show a spend and an
  // occupancy that disagree about which request they describe.
  //
  // WHY THIS DOES NOT REPLACE root.context WHOLESALE. The rest of the breakdown
  // comes from somewhere else entirely — a transcript scan on the Claude side, a
  // filesystem scan for memory files on the Codex one — and arrives on its own
  // schedule. Merging is what lets the two land in either order; assigning a
  // fresh breakdown here would erase the file list every 1.5 seconds.
  //
  // Zero is a legitimate value and is written, not skipped: a session whose
  // context was just cleared really is at zero, and the donut is gated on
  // `> 0` at the card so it disappears rather than drawing an empty ring.
  if (typeof p.context_tokens === "number" && p.context_tokens >= 0) {
    const root = state.agents.get(sessionId);
    if (root) {
      root.context = { ...(root.context ?? emptyContextBreakdown()), currentContextTokens: p.context_tokens };
    }
  }
}

/** How far back the activity spark looks, and the most stamps worth keeping
 *  for it. The chart is 24 buckets over 60s, so a bucket is 2.5s and 64 stamps
 *  is more than a block ever lands in that window — the measured median gap
 *  between blocks is 4.1s, which is 15 in a minute. */
const OUTPUT_WINDOW_MS = 60_000;
const MAX_OUTPUTS = 64;

/** ModelObserved is a synthetic enrichment event emitted by the server
 *  after it scans the root session's transcript file. Apply to the ROOT
 *  agent only — subagents may run under a different model (Sonnet child
 *  of an Opus parent etc.), and blanket-overwriting per session would
 *  clobber the subagent's own model with whatever the root just used.
 *  Per-subagent models arrive via `subagentModels` map when the server
 *  can attribute transcript blocks via `isSidechain`/`parentToolUseID`. */
export function applyModelObserved(state: GraphState, p: HookPayload, sessionId: string): void {
  const m = typeof p.model === "string" ? p.model : null;
  if (m) {
    const root = state.agents.get(sessionId);
    if (root) root.model = m;
  }
  const subs = p.subagentModels as Record<string, string> | undefined;
  if (subs && typeof subs === "object") {
    for (const [parentToolUseId, subModel] of Object.entries(subs)) {
      if (typeof subModel !== "string") continue;
      const subId = subagentIdFor(sessionId, parentToolUseId);
      const sub = state.agents.get(subId);
      if (sub) {
        sub.model = subModel;
        state.pendingSubagentModels.delete(subId);
      } else {
        state.pendingSubagentModels.delete(subId);
        state.pendingSubagentModels.set(subId, subModel);
        // A transcript scan may name thousands of already-pruned agents.
        // Keep the most recently observed models for Starts still in flight.
        if (state.pendingSubagentModels.size > 256) {
          const oldest = state.pendingSubagentModels.keys().next().value;
          if (oldest !== undefined) state.pendingSubagentModels.delete(oldest);
        }
      }
    }
  }
}

/** ContextObserved carries the structural breakdown of the session's context
 *  window (message counts, memory files, current window size) that the
 *  context donut and ContextModal read. Session root only.
 *
 *  FIELD-BY-FIELD, KEEPING WHAT IT DOES NOT MENTION. This used to rebuild the
 *  whole breakdown from one payload, defaulting every absent key to 0 and an
 *  empty list, which made the event destructive rather than additive. Three
 *  producers now write into this one object and none of them knows everything:
 *  the Claude transcript scan (counts + occupancy), the Claude memory scan, and
 *  the Codex memory scan, which has file paths and nothing else. The old shape
 *  was already lossy on the Claude side too — `maybeResolveContext` sends the
 *  file list with no breakdown whenever the transcript has not been folded yet,
 *  and that zeroed every count the previous pass had established.
 *
 *  An absent key therefore means "this producer has nothing to say about it",
 *  never "it is zero". A producer that means zero sends the number zero. */
export function applyContextObserved(state: GraphState, p: HookPayload, sessionId: string): void {
  const ctx = (p.context ?? null) as Record<string, unknown> | null;
  if (ctx) {
    const root = state.agents.get(sessionId);
    if (root) {
      const prev = root.context ?? emptyContextBreakdown();
      const num = (key: string, fallback: number): number =>
        typeof ctx[key] === "number" ? (ctx[key] as number) : fallback;
      // `claudeMdFiles` is the name this list shipped under before it also
      // held AGENTS.md paths, and it is still read here because the deck
      // replays its own persisted JSONL at boot: a log written by an older
      // build is exactly where the old key still appears.
      const files = Array.isArray(ctx.memoryFiles) ? ctx.memoryFiles
        : Array.isArray(ctx.claudeMdFiles) ? ctx.claudeMdFiles
        : null;
      root.context = {
        msgsUser: num("msgsUser", prev.msgsUser),
        msgsAssistant: num("msgsAssistant", prev.msgsAssistant),
        toolUses: num("toolUses", prev.toolUses),
        toolResults: num("toolResults", prev.toolResults),
        systemReminders: num("systemReminders", prev.systemReminders),
        currentContextTokens: num("currentContextTokens", prev.currentContextTokens),
        memoryFiles: (files ?? prev.memoryFiles) as Array<{ path: string; bytes: number }>,
      };
    }
  }
}

/** SessionNamed carries the name Claude Code gave the session, off the same
 *  transcript cursor the three *Observed scans ride. Session root only — the
 *  records name a session and say nothing about any subagent inside it.
 *
 *  ADDITIVE, like ContextObserved and for the same reason: the server sends
 *  whichever of the two fields the transcript has, and a session that has an
 *  `agent-name` but no `ai-title` yet must not have its name wiped by the pass
 *  that reports the title as null. An absent field means "nothing to say".
 *
 *  The title is dropped when it merely repeats the name. CC overwrites
 *  `aiTitle` with the slug once a session is named, so on a named session the
 *  two are usually byte-identical, and a tooltip that echoes the label is worse
 *  than no tooltip: it looks like a bug. Comparison is trimmed and
 *  case-insensitive because the two records are written by different code paths
 *  and only agree exactly by convention. */
export function applySessionNamed(state: GraphState, p: HookPayload, sessionId: string): void {
  const root = state.agents.get(sessionId);
  if (root) {
    const named = typeof p.sessionName === "string" ? p.sessionName.trim() : "";
    const titled = typeof p.sessionTitle === "string" ? p.sessionTitle.trim() : "";
    if (named) root.sessionName = named;
    if (titled) root.sessionTitle = titled;
    const shown = root.sessionName ?? "";
    if (root.sessionTitle && shown
        && root.sessionTitle.toLowerCase() === shown.toLowerCase()) {
      root.sessionTitle = undefined;
    }
  }
}

/** SessionRecapped carries Claude Code's recap — the "※ recap:" line it writes
 *  into a finished turn's silence — off the same transcript cursor, and off
 *  the watch that reads that file between hook events, since no hook fires
 *  when the line lands. Session root only, and never a node of its own: a
 *  recap is about a session the deck is already drawing.
 *
 *  `recap: null` is the server saying a later turn retired it; an absent or
 *  malformed one says nothing and changes nothing. Whether a standing recap
 *  still describes the session is NOT decided here — the prompt that makes it
 *  history can arrive before the server's retirement does — so session-recap.ts
 *  asks that where the recap is drawn. */
export function applySessionRecapped(state: GraphState, p: HookPayload, sessionId: string): void {
  const root = state.agents.get(sessionId);
  if (root) {
    const r = p.recap;
    if (r === null) root.recap = undefined;
    else if (r && typeof r.text === "string" && r.text.trim() && Number.isFinite(r.at)) {
      root.recap = { text: r.text.trim(), at: r.at };
    }
  }
}

/** ActivityObserved carries what the session's newest reply says it is doing —
 *  the agent view's line, by its rule, off the server's transcript watch.
 *  Session root only, never a node of its own.
 *
 *  NEVER BACKWARDS, for the reason applyOutputObserved gives: ticks are ordered
 *  by the clock they are polled on, and a reply read late must not replace the
 *  one written after it. Whether the line still describes the session is not
 *  decided here; session-status.ts asks that where it is drawn. */
export function applyActivityObserved(state: GraphState, p: HookPayload, sessionId: string): void {
  const root = state.agents.get(sessionId);
  const a = p.activity;
  if (!root || !a || typeof a.text !== "string" || !a.text.trim() || !Number.isFinite(a.at)) return;
  if (root.activity && a.at < root.activity.at) return;
  root.activity = { text: a.text.trim(), source: a.source === "said" ? "said" : "tool", at: a.at };
}

const JOB_STATES = new Set<BackgroundJob["state"]>(["working", "blocked", "done", "failed", "stopped"]);

/** JobObserved carries a background session's line from Claude Code's own job
 *  folder. `job: null` is the server saying the job is gone; an absent or
 *  malformed one says nothing and changes nothing — the file is not a stable
 *  interface, so every field is checked again here rather than trusted because
 *  the server already checked it. */
export function applyJobObserved(state: GraphState, p: HookPayload, sessionId: string): void {
  const root = state.agents.get(sessionId);
  if (!root) return;
  const j = p.job;
  if (j === null) { root.job = undefined; return; }
  if (!j || typeof j !== "object" || !JOB_STATES.has(j.state)) return;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  root.job = {
    id: str(j.id) ?? "",
    state: j.state,
    detail: str(j.detail) ?? "",
    needs: str(j.needs),
    suggestedReply: str(j.suggestedReply),
    result: str(j.result),
    updatedAt: Number.isFinite(j.updatedAt) ? j.updatedAt : 0,
  };
}

/** WHAT THE MODEL IS PRODUCING, from the server's transcript watch. The one
 *  signal on this surface that does not come from a hook, because there is no
 *  hook for it: 16.5% of measured time is the model reading, reasoning and
 *  writing between tool calls, and all of it used to draw as an idle card. */
export function applyOutputObserved(state: GraphState, p: HookPayload, sessionId: string, now: number): void {
  const kind = p.kind === "thinking" || p.kind === "text" || p.kind === "tool_use" ? p.kind : null;
  // The block's own stamp, falling back to arrival only when the record had
  // none — a block read late must not claim to have just happened.
  const at = typeof p.at === "number" && Number.isFinite(p.at) ? p.at : now;
  if (!kind) return;
  const root = state.agents.get(rootAgentId(sessionId));
  // Lookup, not create. A watch tick for a session the graph has never heard
  // of would otherwise manifest a node out of a file on disk.
  if (!root) return;
  // NEVER BACKWARDS. Ticks are ordered by the clock they are polled on, not
  // by the stamps inside the files, so a slow read can deliver an older block
  // after a newer one — and a card that moved its "last worked" backwards
  // would report a live session as going stale.
  if (root.lastOutputAt != null && at <= root.lastOutputAt) return;
  root.lastOutputAt = at;
  // THE CHART'S OTHER INPUT, and deliberately not every block.
  //
  // A `tool_use` block IS the tool call — it is written at the moment the
  // model makes it, within a second of the PreToolUse the card already marks.
  // Measured on this session's own transcript: 378 tool calls and 378
  // `tool_use` blocks, which is the same 378 events counted twice. Feeding
  // them in would have drawn a chart at double height for the half of the
  // work that was already visible, which is the opposite of the point.
  //
  // What goes in is what the card had NO mark for: the model reading,
  // reasoning and writing. Bounded, because the chart looks at sixty seconds
  // and a session runs for hours — dropped on the way in rather than
  // accumulated and filtered on every render.
  if (kind !== "tool_use") {
    const keep = (root.outputs ?? []).filter(t => at - t < OUTPUT_WINDOW_MS);
    keep.push(at);
    root.outputs = keep.length > MAX_OUTPUTS ? keep.slice(-MAX_OUTPUTS) : keep;
  }
  // The revision is what makes the canvas re-read a mutated agent. This second
  // bump is redundant with the one `applyEvent` gives every event, which was
  // there before this branch was written (#536), and harmless: a memo only asks
  // whether the number moved.
  state.revision += 1;
}

// NOTHING ELSE IN THE REDUCER ADDS TOKENS TO AN AGENT ANY MORE, and that is the
// point of #685 rather than an accident of it. There was one
// `addUsage(owner, …)`, on a finished Task's tool result, and it ran against a
// value that both double-counted (the transcript pass reads the same turn out of
// the subagent's own file) and under-reported (the tool result carries the
// subagent's last API turn, not its bill). Token counts now have exactly one
// writer — the `UsageObserved` totals the server sums off disk, applied below —
// and that writer assigns, so the same tokens land on the same agent at the same
// value however many times the event is delivered.

/** UsageObserved carries cumulative session usage from the transcript.
 *  Overwrite (not add) the session root's usage with the totals — the
 *  server re-reads on every event, so this is always the running total.
 *
 *  WHAT "THE SESSION'S USAGE" COVERS (#685). Everything the session spent,
 *  its subagents included. CC writes a delegated turn to
 *  `<sessionId>/subagents/agent-<id>.jsonl` rather than into the session's own
 *  JSONL, and `sessionUsageTotals` on the server sums both halves before
 *  sending them here — so this one number is the session's whole bill and the
 *  deck no longer loses the delegated part of it. Subagent NODES stay at zero:
 *  the roll-ups in SessionList / SessionSummary / UsagePanel add the root and
 *  its subagents together, so a per-node share here would be the same tokens
 *  counted twice. That is also why nothing else in the reducer writes tokens. */
export function applyUsageObserved(state: GraphState, p: HookPayload, sessionId: string): void {
  const u = (p.usage ?? null) as Record<string, unknown> | null;
  if (u) {
    const root = state.agents.get(sessionId);
    if (root) {
      // Overwrite, not merge: these are cumulative totals for the whole
      // transcript, so a pass that saw no split must clear a stale one. The
      // same read as each per-model bucket below, both spellings of the cache
      // lines included — see `usageFromWire`. Assigned into the node's own
      // object rather than replacing it, and `reasoningOutputTokens` is only
      // written when the wire carries it, exactly as the field-by-field read
      // this replaced did.
      Object.assign(root.usage, usageFromWire(u));
      // The same totals, split by the model that produced them (#686). The
      // flat bucket above answers "how many tokens"; this answers "at whose
      // rate", and until this landed the second question was answered with
      // `root.model` — the LAST model seen — so a session that switched had
      // its whole history re-priced at whichever model wrote its final line.
      //
      // Assigned unconditionally, null included, for exactly the reason the
      // TTL split above is: both are cumulative descriptions of the
      // whole file, so a pass that carries no split is saying there is none,
      // not that the previous one still stands. An `undefined` map sends every
      // cost surface back to the single-model arithmetic, which is what a
      // Codex session and a pre-#686 server both need.
      root.usageByModel = usageByModelFromWire(p.usageByModel);
    }
  }
}
