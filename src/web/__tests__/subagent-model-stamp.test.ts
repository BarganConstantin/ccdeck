// A subagent card keeps the model its own transcript names.
//
// pushEvent stamps the session's model on any payload that arrives without one,
// so the client can label a card the moment the event lands. The model it had
// is the ROOT's, and it stamped it on the subagent's own events as well — every
// one of which names the subagent by agent_id and none of which carries a model
// of its own. The reducer then wrote it onto the subagent, over the model the
// transcript scan had sent for it, and nothing sent that again: an Explore
// subagent on Haiku under an Opus session read as Opus, and was priced as one.
import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
import { applyEvent, initialState } from "../reducer";
import type { GraphState } from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";

// Every path below lives inside this temp directory, and the server resolves
// the Claude config directory from the environment — so it points at the
// sandbox BEFORE any import of the server.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-subagent-model-stamp-"));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.XDG_CONFIG_HOME = join(DIR, "config");
if (!resolve(process.env.CLAUDE_CONFIG_DIR).startsWith(resolve(DIR))) throw new Error("sandbox escaped");

// @ts-expect-error — plain .mjs server module, no types
const mod = await import("../../server/index.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { pushEvent } = await import("../../server/event-pipeline.mjs");
const eventsSince = mod.eventsSince as (seq: number) => HookEnvelope[];

afterAll(() => rmTempDir(DIR));

const ROOT_MODEL = "claude-opus-5";
const SUB_MODEL = "claude-haiku-4-5";
const AGENT = "a0123456789abcdef";

/** One assistant turn as CC writes it, on `model`. */
function turn(model: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { model, usage: { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  }) + "\n";
}

/** A session on Opus with one subagent on Haiku, laid out as current CC writes
 *  it. Returns the main transcript's path. */
function sessionOnDisk(sid: string): string {
  const slug = join(DIR, "claude", "projects", "-w");
  const subagents = join(slug, sid, "subagents");
  mkdirSync(subagents, { recursive: true });
  const main = join(slug, `${sid}.jsonl`);
  writeFileSync(main, turn(ROOT_MODEL));
  writeFileSync(join(subagents, `agent-${AGENT}.jsonl`), turn(SUB_MODEL));
  return main;
}

async function modelObserved(sid: string): Promise<HookEnvelope | null> {
  for (let i = 0; i < 300; i++) {
    const hit = eventsSince(0).find(e => e.payload?.hook_event_name === "ModelObserved" && e.payload.session_id === sid);
    if (hit) return hit;
    await new Promise(r => setTimeout(r, 10));
  }
  return null;
}

describe("the model stamped on a subagent's own events", () => {
  it("is the subagent's, not the root's, and the card keeps it", async () => {
    const sid = "sess-stamp";
    const tp = sessionOnDisk(sid);
    const base = { session_id: sid, cwd: DIR, transcript_path: tp };
    pushEvent({ ...base, hook_event_name: "SessionStart" }, "hook");
    pushEvent({ ...base, hook_event_name: "SubagentStart", agent_id: AGENT, agent_type: "Explore" }, "hook");
    const observed = await modelObserved(sid);
    expect(observed, "no ModelObserved for the session").not.toBeNull();
    expect(observed!.payload!.subagentModels).toEqual({ [AGENT]: SUB_MODEL });

    const sub = pushEvent({ ...base, hook_event_name: "PreToolUse", agent_id: AGENT, tool_name: "Read", tool_use_id: "t1" }, "hook");
    const stop = pushEvent({ ...base, hook_event_name: "SubagentStop", agent_id: AGENT }, "hook");
    const own = pushEvent({ ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t2" }, "hook");
    expect(sub.payload.model).toBe(SUB_MODEL);
    expect(stop.payload.model).toBe(SUB_MODEL);
    expect(own.payload.model, "the root's own events still carry the root's model").toBe(ROOT_MODEL);

    let state = initialState();
    for (const e of eventsSince(0).filter(x => x.payload?.session_id === sid)) state = applyEvent(state, e);
    expect(state.agents.get(`${sid}::${AGENT}`)?.model).toBe(SUB_MODEL);
    expect(state.agents.get(sid)?.model).toBe(ROOT_MODEL);
  });

  it("is nothing for a subagent whose model is not known yet", async () => {
    const sid = "sess-unknown-sub";
    const tp = sessionOnDisk(sid);
    const base = { session_id: sid, cwd: DIR, transcript_path: tp };
    pushEvent({ ...base, hook_event_name: "SessionStart" }, "hook");
    expect(await modelObserved(sid)).not.toBeNull();
    const evt = pushEvent({ ...base, hook_event_name: "PreToolUse", agent_id: "a-not-on-disk", tool_name: "Read", tool_use_id: "t1" }, "hook");
    expect(evt.payload.model).toBeUndefined();
  });
});

describe("a payload naming nobody, attributed to a subagent by the stack", () => {
  it("does not write the root's model onto the subagent", () => {
    // A session on a CC version whose subagent calls carry no agent_id: the
    // stack hands them to the subagent, and the only model such a payload can
    // carry is the one the server stamped, which is the root's.
    let seq = 0;
    let s: GraphState = initialState();
    const send = (payload: HookPayload): void => {
      s = applyEvent(s, { seq: ++seq, receivedAt: 1_000 + seq, source: "hook", payload: { session_id: "old", ...payload } });
    };
    send({ hook_event_name: "SessionStart", cwd: "/repo" });
    send({ hook_event_name: "SubagentStart", agent_id: "a1", agent_type: "Explore" });
    send({ hook_event_name: "ModelObserved", model: ROOT_MODEL, subagentModels: { a1: SUB_MODEL } });
    send({ hook_event_name: "PreToolUse", tool_name: "Grep", tool_use_id: "g1", model: ROOT_MODEL });
    expect(s.agents.get("old::a1")!.tools.map(t => t.name)).toEqual(["Grep"]);
    expect(s.agents.get("old::a1")!.model).toBe(SUB_MODEL);
  });
});
