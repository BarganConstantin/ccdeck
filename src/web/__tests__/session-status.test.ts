// The line under a session's figures: what it is doing, asking or got done.
//
// Two sources. A background session's job folder holds Claude Code's own line —
// its classifier's words, the ones `claude agents` prints — and every other
// session gets the agent view's free rule, read off its newest reply: the
// sentence the model wrote, or the description on its call.
//
// These pin the reply rule (src/server/session-activity.mjs), the job reader
// (src/server/claude-jobs.mjs) against a real folder, the client's rule for when
// either line is still true (session-status.ts), what the reducer does with the
// two events, and the row. session-status-server.test.ts drives the same thing
// through a real server.
import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
import {
  activityOfLine, cleanSaid, foldActivityLine, newActivityState, toolActivity,
} from "../../server/session-activity.mjs";
import { createJobWatch, jobStatusOf } from "../../server/claude-jobs.mjs";
import { applyEvent, initialState } from "../reducer";
import { jobLine, rowLines, statusShown, statusTag } from "../session-status";
import { buildRows } from "../components/SessionList";
import type { BackgroundJob, HookEnvelope, HookPayload } from "../types";

const T0 = Date.parse("2026-10-05T16:00:00.000Z");
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** One transcript line, as Claude Code writes them: one block per line, the
 *  blocks of one reply sharing `message.id`. */
const line = (id: string, at: number, ...content: unknown[]) => JSON.stringify({
  type: "assistant", isSidechain: false, timestamp: iso(at), message: { id, content },
});
const text = (t: string) => ({ type: "text", text: t });
const call = (name: string, input: Record<string, unknown>) => ({ type: "tool_use", name, input });

describe("what a reply says it is doing", () => {
  it("takes the first line of what the model wrote, as plain words", () => {
    expect(cleanSaid("**Now** I'll read `reducer.ts` to see the flow.\n\nMore detail here.")).toBe(
      "Now I'll read reducer.ts to see the flow.");
    expect(cleanSaid("\n\n## Plan\nfirst")).toBe("Plan");
    expect(cleanSaid("- checking the build")).toBe("checking the build");
    expect(cleanSaid(42)).toBe("");
  });

  it("cuts a long sentence at a word and marks it", () => {
    const out = cleanSaid("word ".repeat(80));
    expect(out.length).toBeLessThanOrEqual(160);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/ …$/);
  });

  it("names a call by the description its model wrote, and otherwise by what it touches", () => {
    expect(toolActivity("Bash", { command: "npm test", description: "Run the API tests" })).toBe("Run the API tests");
    expect(toolActivity("Agent", { description: "Research Linux dictation tools", prompt: "…" })).toBe(
      "Research Linux dictation tools");
    expect(toolActivity("Read", { file_path: "/repo/src/web/reducer.ts" })).toBe("Reading reducer.ts");
    expect(toolActivity("Edit", { file_path: "C:\\repo\\app.tsx" })).toBe("Editing app.tsx");
    expect(toolActivity("Grep", { pattern: "recapShown" })).toBe("Searching for recapShown");
    expect(toolActivity("WebFetch", { url: "https://code.claude.com/docs/en/hooks?x=1" })).toBe(
      "Fetching code.claude.com");
  });

  it("leaves a call it cannot name unnamed, rather than printing a tool id", () => {
    expect(toolActivity("mcp__github__list_pulls", { owner: "x" })).toBe("");
    expect(toolActivity("Bash", { command: "ls" })).toBe("");
    expect(toolActivity("Read", {})).toBe("");
  });

  it("reads only the main chain's model writing", () => {
    expect(activityOfLine(JSON.stringify({ type: "user", message: { content: [text("a prompt long enough")] } }))).toBeNull();
    expect(activityOfLine(JSON.stringify({
      type: "assistant", isSidechain: true, timestamp: iso(T0), message: { id: "m", content: [text("a subagent talking")] },
    }))).toBeNull();
    expect(activityOfLine("{torn")).toBeNull();
    expect(activityOfLine("")).toBeNull();
  });

  it("skips a text block too short to say anything, as the agent view does", () => {
    expect(activityOfLine(line("m", T0, text("Done.")))?.said).toBe("");
  });
});

describe("the fold: one reply at a time", () => {
  const fold = (...lines: string[]) => {
    const st = newActivityState();
    for (const l of lines) foldActivityLine(st, l);
    return st.shown;
  };

  it("lets the sentence outrank the call it introduces, whichever line came last", () => {
    const shown = fold(
      line("m1", T0, text("Now I'll read the reducer to see the flow.")),
      line("m1", T0 + 1000, call("Read", { file_path: "/r/reducer.ts" })),
    );
    expect(shown).toEqual({ text: "Now I'll read the reducer to see the flow.", source: "said", at: T0 });
  });

  it("starts again with the next reply", () => {
    const shown = fold(
      line("m1", T0, text("Now I'll read the reducer to see the flow.")),
      line("m2", T0 + 5000, call("Bash", { command: "npm test", description: "Run the API tests" })),
    );
    expect(shown).toEqual({ text: "Run the API tests", source: "tool", at: T0 + 5000 });
  });

  it("keeps the line through a reply that only thinks", () => {
    const shown = fold(
      line("m1", T0, call("Bash", { command: "npm test", description: "Run the API tests" })),
      line("m2", T0 + 3000, { type: "thinking", thinking: "hmm" }),
      line("m3", T0 + 4000, call("mcp__x__y", {})),
    );
    expect(shown?.text).toBe("Run the API tests");
  });

  it("is null until anything readable has been written", () => {
    expect(fold(line("m1", T0, { type: "thinking", thinking: "…" }))).toBeNull();
  });
});

describe("Claude Code's job file, read as the untrusted shape it is", () => {
  const STATE = {
    state: "blocked", detail: "Merge PR #29?", tempo: "blocked",
    needs: "Merge PR #29 so ChatGPT can connect?", suggestedReply: "merge it",
    sessionId: "s-1", resumeSessionId: "s-1", updatedAt: iso(T0), output: null,
  };

  it("keeps the words a row needs", () => {
    expect(jobStatusOf(STATE, "f2d33397")).toEqual({
      sessionId: "s-1", resumeSessionId: "s-1",
      job: {
        id: "f2d33397", state: "blocked", detail: "Merge PR #29?", updatedAt: T0,
        needs: "Merge PR #29 so ChatGPT can connect?", suggestedReply: "merge it",
      },
    });
  });

  it("keeps a question and a suggested reply only on a job that is blocked", () => {
    const done = jobStatusOf({ ...STATE, state: "done", output: { result: "Merged; CI green." } }, "j");
    expect(done?.job).toEqual({ id: "j", state: "done", detail: "Merge PR #29?", updatedAt: T0, result: "Merged; CI green." });
  });

  it("is no job at all when the shape is not one it knows", () => {
    expect(jobStatusOf({ ...STATE, state: "thinking" }, "j")).toBeNull();
    expect(jobStatusOf({ ...STATE, sessionId: "" }, "j")).toBeNull();
    expect(jobStatusOf({ ...STATE, sessionId: 7 }, "j")).toBeNull();
    expect(jobStatusOf(null, "j")).toBeNull();
    expect(jobStatusOf("text", "j")).toBeNull();
  });

  it("drops a field of the wrong type rather than trusting it", () => {
    const j = jobStatusOf({ ...STATE, detail: { x: 1 }, needs: 4, updatedAt: "never" }, "j")!.job;
    expect(j.detail).toBe("");
    expect(j.needs).toBeUndefined();
    expect(j.updatedAt).toBe(0);
  });
});

describe("the job watch, over a real folder", () => {
  const DIR = mkdtempSync(join(tmpdir(), "ccdeck-jobs-"));
  afterAll(() => rmTempDir(DIR));
  const write = (id: string, body: unknown) => {
    mkdirSync(join(DIR, id), { recursive: true });
    writeFileSync(join(DIR, id, "state.json"), typeof body === "string" ? body : JSON.stringify(body));
  };
  const watch = createJobWatch({ dir: () => DIR });
  const job = (sid: string, over: Record<string, unknown> = {}) => ({
    state: "working", detail: "tracing the sync", sessionId: sid, updatedAt: iso(T0), ...over,
  });

  it("maps each session to its job's line", async () => {
    write("aaaa1111", job("s-a"));
    write("bbbb2222", job("s-b", { state: "done", output: { result: "Shipped." } }));
    const jobs = await watch.poll();
    expect(jobs?.get("s-a")?.detail).toBe("tracing the sync");
    expect(jobs?.get("s-b")?.result).toBe("Shipped.");
  });

  it("re-reads a file that changed", async () => {
    write("aaaa1111", job("s-a", { detail: "now writing the fix", updatedAt: iso(T0 + 5000) }));
    expect((await watch.poll())?.get("s-a")?.detail).toBe("now writing the fix");
  });

  it("forgets a job whose folder is gone, and skips a file it cannot parse", async () => {
    rmSync(join(DIR, "bbbb2222"), { recursive: true });
    write("cccc3333", "{ half a file");
    const jobs = await watch.poll();
    expect(jobs?.has("s-b")).toBe(false);
    expect(jobs?.size).toBe(1);
  });

  it("shows the newer of two jobs naming one session", async () => {
    write("dddd4444", job("s-a", { detail: "the resumed job", updatedAt: iso(T0 + 60_000) }));
    expect((await watch.poll())?.get("s-a")?.detail).toBe("the resumed job");
  });

  it("answers an empty map, not a throw, when there is no jobs folder", async () => {
    const none = createJobWatch({ dir: () => join(DIR, "nope") });
    expect((await none.poll())?.size).toBe(0);
  });
});

describe("which line a session shows", () => {
  const JOB: BackgroundJob = { id: "j", state: "working", detail: "checking Linux setup", updatedAt: T0 };
  const root = (over: Record<string, unknown> = {}) => ({
    kind: "root" as const, state: "active" as const, closedAt: undefined as number | undefined,
    prompts: [{ at: T0 - MIN, text: "go" }],
    activity: { text: "Run the API tests", source: "tool" as const, at: T0 },
    job: undefined as BackgroundJob | undefined,
    ...over,
  });

  it("gives every job state its own word, and no line to a stopped job", () => {
    expect(jobLine({ ...JOB })).toMatchObject({ kind: "now", text: "checking Linux setup" });
    expect(jobLine({ ...JOB, state: "blocked", needs: "Merge it?", suggestedReply: "yes" })).toMatchObject({
      kind: "needs", text: "Merge it?", reply: "yes" });
    expect(jobLine({ ...JOB, state: "done", result: "Shipped." })).toMatchObject({ kind: "done", text: "Shipped." });
    expect(jobLine({ ...JOB, state: "failed", detail: "API down" })).toMatchObject({ kind: "failed", text: "API down" });
    expect(jobLine({ ...JOB, state: "stopped" })).toBeNull();
    expect(jobLine({ ...JOB, detail: "" })).toBeNull();
    expect(["now", "needs", "done", "failed"].map(k => statusTag(k as never))).toEqual(["now", "needs you", "done", "failed"]);
  });

  it("prefers the job's own line to the deck's reading of the reply", () => {
    expect(statusShown(root({ job: JOB }))).toMatchObject({ text: "checking Linux setup", source: "job" });
    // And falls back to the reply when the job has nothing to say.
    expect(statusShown(root({ job: { ...JOB, state: "stopped" } }))).toMatchObject({ text: "Run the API tests" });
  });

  it("shows the reply's line only while a turn runs and no prompt is newer", () => {
    expect(statusShown(root())).toMatchObject({ kind: "now", text: "Run the API tests", source: "activity" });
    expect(statusShown(root({ state: "done" }))).toBeNull();
    expect(statusShown(root({ prompts: [{ at: T0 + 1, text: "next" }] }))).toBeNull();
  });

  it("shows nothing on a closed session, or anywhere but the root", () => {
    expect(statusShown(root({ closedAt: T0 + MIN, job: JOB }))).toBeNull();
    expect(statusShown(root({ kind: "subagent" }))).toBeNull();
  });

  it("puts one line under a row, the newer of the job's and the recap", () => {
    const status = jobLine({ ...JOB, state: "done", result: "Shipped.", updatedAt: T0 })!;
    expect(rowLines(status, { text: "Later recap.", at: T0 + MIN })).toEqual({ status: null, recap: { text: "Later recap.", at: T0 + MIN } });
    expect(rowLines(status, { text: "Older recap.", at: T0 - MIN })).toEqual({ status, recap: null });
    expect(rowLines(null, null)).toEqual({ status: null, recap: null });
  });
});

describe("the two events on the client", () => {
  const SESSION = "sess-status";
  let seq = 0;
  const env = (receivedAt: number, payload: HookPayload): HookEnvelope => ({ seq: ++seq, receivedAt, source: "hook", payload });
  const working = () => {
    let s = applyEvent(initialState(), env(T0 - 2 * MIN, { hook_event_name: "SessionStart", session_id: SESSION, cwd: "/repo/ccdeck" }));
    s = applyEvent(s, env(T0 - MIN, { hook_event_name: "UserPromptSubmit", session_id: SESSION, cwd: "/repo/ccdeck", prompt: "fix it" }));
    return s;
  };
  const activity = (s: ReturnType<typeof working>, a: unknown, receivedAt = T0 + 1000) =>
    applyEvent(s, env(receivedAt, { hook_event_name: "ActivityObserved", session_id: SESSION, activity: a } as HookPayload));
  const jobbed = (s: ReturnType<typeof working>, j: unknown, receivedAt = T0 + 1000) =>
    applyEvent(s, env(receivedAt, { hook_event_name: "JobObserved", session_id: SESSION, job: j } as HookPayload));

  it("puts the activity line on the root, and on the row while the turn runs", () => {
    const s = activity(working(), { text: "Run the API tests", source: "tool", at: T0 });
    expect(s.agents.get(SESSION)!.activity).toEqual({ text: "Run the API tests", source: "tool", at: T0 });
    expect(buildRows(s, T0 + 2000)[0].status).toMatchObject({ kind: "now", text: "Run the API tests" });
    const ended = applyEvent(s, env(T0 + 3000, { hook_event_name: "Stop", session_id: SESSION, cwd: "/repo/ccdeck" }));
    expect(buildRows(ended, T0 + 4000)[0].status).toBeNull();
  });

  it("never moves the activity line backwards, and ignores one it cannot use", () => {
    let s = activity(working(), { text: "Newer", source: "said", at: T0 + 5000 });
    s = activity(s, { text: "Older, read late", source: "said", at: T0 }, T0 + 6000);
    for (const bad of [null, { text: "", at: T0 + 9000 }, { text: "x", at: Number.NaN }]) s = activity(s, bad, T0 + 7000);
    expect(s.agents.get(SESSION)!.activity?.text).toBe("Newer");
  });

  it("takes a job's line, and drops it when the server says the job is gone", () => {
    let s = jobbed(working(), { id: "j", state: "blocked", detail: "Merge?", needs: "Merge PR #29?", suggestedReply: "yes", updatedAt: T0 });
    expect(buildRows(s, T0 + 2000)[0].status).toMatchObject({ kind: "needs", text: "Merge PR #29?", reply: "yes", source: "job" });
    s = jobbed(s, { id: "j", state: "weird" }, T0 + 3000);
    expect(s.agents.get(SESSION)!.job?.state, "a state it does not know changes nothing").toBe("blocked");
    s = jobbed(s, null, T0 + 4000);
    expect(s.agents.get(SESSION)!.job).toBeUndefined();
  });

  it("conjures no session out of either event", () => {
    const s = initialState();
    applyEvent(s, env(T0, { hook_event_name: "ActivityObserved", session_id: "stranger", activity: { text: "x y z w v", source: "said", at: T0 } } as HookPayload));
    applyEvent(s, env(T0, { hook_event_name: "JobObserved", session_id: "stranger", job: { id: "j", state: "working", detail: "x", updatedAt: T0 } } as HookPayload));
    expect(s.agents.size).toBe(0);
  });

  it("leaves a waiting badge standing — both describe the block, neither answers it", () => {
    let s = applyEvent(working(), env(T0, {
      hook_event_name: "Notification", session_id: SESSION, cwd: "/repo/ccdeck",
      notification_type: "permission_prompt", message: "Claude needs your permission to use Bash",
    }));
    s = activity(s, { text: "Run the API tests", source: "tool", at: T0 });
    s = jobbed(s, { id: "j", state: "blocked", detail: "Run the tests?", updatedAt: T0 });
    expect(s.agents.get(SESSION)!.waiting?.kind).toBe("permission");
  });

  it("does not bring a session the sweep settled back to life — the supervisor writes `stopped` into a dead job", () => {
    const s = working();
    const root = s.agents.get(SESSION)!;
    root.reaped = true;
    root.state = "done";
    root.closedAt = T0;
    jobbed(s, { id: "j", state: "stopped", detail: "process gone", updatedAt: T0 + 90 * MIN }, T0 + 91 * MIN);
    expect(root.reaped).toBe(true);
    expect(root.state).toBe("done");
    expect(root.closedAt).toBe(T0);
  });
});
