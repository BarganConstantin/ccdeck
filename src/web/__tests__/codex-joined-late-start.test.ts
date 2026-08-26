// #684: the Codex rollout watcher minted a `SessionStart` for a session it
// joined partway through, so the one event that means "this deck watched this
// session begin" was emitted for sessions it demonstrably had not.
//
// The watcher skips a pre-existing rollout's history at startup — it parks its
// cursor at the file's current size and reads only what is appended after —
// and then `ensureCodexRoot` minted a root event for it anyway on the first
// appended line. Everything before the deck existed (the user's earlier
// prompts, the tool calls, the real start time) was gone, and the card said
// nothing about it.
//
// #683 turned that from wrong into visible. The reducer marks a root created by
// anything OTHER than a `SessionStart` as `synthetic` — "joined late, so this
// card is incomplete rather than empty" — and a minted `SessionStart` clears
// exactly that marker. Claude never had the problem: a deck started mid-session
// simply never receives a `SessionStart` hook for it, which is the case the
// marker was built for.
//
// The fix is a subtraction, and that is the point. `events.jsonl` is shared —
// several decks read it and one is elected to write it — so this file pins not
// only that the event stops being minted in the joined-late case, but that what
// reaches the log is a shape every deck already understands: no new event kind,
// no new field, a joined-late Codex session written exactly like a joined-late
// Claude one. A deck older than #683 replaying this log has no marker to light
// and draws the session as it always did; it loses nothing with the
// `SessionStart`, because `provider`, `cwd` and `approval_policy` ride on every
// payload the mapper emits (see `base` in codexObjToPayload).
//
// The whole watcher runs for real here — real files under a temporary
// CODEX_HOME, the real 1.5s poll — because the fault was in when the watcher
// decides, and a hand-fed mapper cannot tell a rollout that pre-dates the deck
// from one born under its watch.
import { afterAll, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEvent, initialState, type GraphState } from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";

// Every path this file touches lives under here, and every variable the deck
// resolves a home from is pointed inside it BEFORE the server module is ever
// imported. The developer's own ~/.claude and ~/.codex are unreachable from
// this file.
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "ccdeck-684-")));
const prev = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
};
process.env.HOME = join(ROOT, "home");
process.env.USERPROFILE = join(ROOT, "home");
process.env.CLAUDE_CONFIG_DIR = join(ROOT, "config");
process.env.XDG_CONFIG_HOME = join(ROOT, "xdg");

afterAll(() => {
  for (const [k, was] of Object.entries(prev)) {
    if (was === undefined) delete process.env[k];
    else process.env[k] = was;
  }
  rmSync(ROOT, { recursive: true, force: true });
});

type Envelope = { seq: number; source: string; receivedAt: number; payload: HookPayload };
type ServerModule = {
  startCodexWatcher: (workspace: string) => ReturnType<typeof setInterval>;
  eventsSince: (seq: number) => Envelope[];
  CODEX_SESSIONS_DIR: string;
};

const rollLine = (o: unknown) => JSON.stringify(o) + "\n";

/** The rollout header plus one turn's worth of a session in progress. */
function history(sid: string, cwd: string, prompt: string): string {
  return (
    rollLine({ type: "session_meta", payload: { id: sid, cwd } }) +
    rollLine({ type: "turn_context", payload: { model: "gpt-5-codex", approval_policy: "on-request" } }) +
    rollLine({ type: "event_msg", payload: { type: "user_message", message: prompt } }) +
    rollLine({ type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: "{}", call_id: `${sid}-early` } })
  );
}

/** One more prompt from a session that is still running. */
const turn = (prompt: string) =>
  rollLine({ type: "event_msg", payload: { type: "user_message", message: prompt } });

/** A Codex home with its sessions tree, and the workspace its sessions run in. */
function codexHome(name: string): { home: string; day: string; workspace: string; cwd: string } {
  const home = join(ROOT, name);
  const day = join(home, "sessions", "2026", "08", "24");
  const workspace = join(ROOT, `${name}-workspace`);
  mkdirSync(day, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  // The watcher canonicalises the header's cwd through realpath, so this is the
  // spelling every payload will carry.
  return { home, day, workspace, cwd: realpathSync(workspace) };
}

const rolloutPath = (day: string, sid: string) => join(day, `rollout-2026-08-24T09-00-00-${sid}.jsonl`);

const sid = (tag: string) => `684${tag}-0000-4000-8000-${String(sidSeq++).padStart(12, "0")}`;
let sidSeq = 1;

/**
 * One deck's lifetime: a fresh module instance tailing `home`.
 *
 * The registry is dropped between decks because the server resolves CODEX_HOME
 * once, at module load, and because a deck restart is precisely a process that
 * kept none of the last one's state — the tail cursors, the ring buffer and the
 * "have I opened this root" flags all start empty, which is the case #684 has
 * to get right.
 */
async function boot(home: string): Promise<{ mod: ServerModule; stop: () => void }> {
  process.env.CODEX_HOME = home;
  vi.resetModules();
  const mod = (await import("../../server/index.mjs")) as unknown as ServerModule;
  // Belt and braces: if the override were ignored this would be tailing the
  // developer's real sessions.
  if (!String(mod.CODEX_SESSIONS_DIR).startsWith(ROOT)) {
    throw new Error(`refusing to run: resolved ${mod.CODEX_SESSIONS_DIR}, outside ${ROOT}`);
  }
  const timer = mod.startCodexWatcher("");
  return { mod, stop: () => clearInterval(timer) };
}

async function waitFor<T>(fn: () => T | undefined | null, what: string, ms: number): Promise<T | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() >= deadline) return null;
    await new Promise(r => setTimeout(r, 50));
  }
}

const forSession = (mod: ServerModule, id: string): HookPayload[] =>
  mod.eventsSince(0).map(e => e.payload).filter(p => p && p.session_id === id);

const names = (payloads: HookPayload[]) => payloads.map(p => p.hook_event_name);

/** Wait until this session has produced the named event, or fail saying so. */
async function until(mod: ServerModule, id: string, name: string, what: string, ms = 20_000) {
  const got = await waitFor(() => {
    const seen = forSession(mod, id);
    return seen.some(p => p.hook_event_name === name) ? seen : null;
  }, what, ms);
  if (!got) throw new Error(`timed out waiting for ${what}`);
  return got;
}

/**
 * Start a Codex session that this deck genuinely watches appear, and return the
 * events it produced.
 *
 * Retried with a fresh session id rather than written once after a fixed sleep,
 * because `startCodexWatcher` fires its startup catalogue without awaiting it:
 * a rollout written in the moments right after boot can still be swept up as
 * "already on disk" and skipped — which is the correct conservative reading,
 * and would make a one-shot version of this helper a coin toss. A session whose
 * `SessionStart` arrives is one a POLL TICK read from byte 0, and a poll tick
 * cannot run until the catalogue has finished, because codexScanOnce refuses to
 * overlap itself. So a success here is also the barrier every "and now the
 * pre-existing file appends" step below depends on.
 */
async function newbornUnderWatch(
  mod: ServerModule, day: string, workspace: string, prompt: string,
): Promise<{ id: string; events: HookPayload[] }> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const id = sid("newb");
    writeFileSync(rolloutPath(day, id), history(id, workspace, prompt), "utf8");
    const got = await waitFor(
      () => {
        const seen = forSession(mod, id);
        return seen.some(p => p.hook_event_name === "SessionStart") ? seen : null;
      },
      "", 4_000,
    );
    if (got) return { id, events: got };
  }
  throw new Error("the watcher never read a rollout written after it started");
}

/** Replay a payload stream through the real reducer, as a deck does. */
function replay(payloads: HookPayload[], startAt = 1_700_000_000_000): GraphState {
  let state = initialState();
  payloads.forEach((payload, i) => {
    const env: HookEnvelope = {
      seq: i + 1,
      receivedAt: startAt + i * 1_000,
      source: payload.provider === "codex" ? "codex" : "hook",
      payload,
    };
    state = applyEvent(state, env);
  });
  return state;
}

const rootOf = (state: GraphState, id: string) =>
  [...state.agents.values()].find(a => a.kind === "root" && a.sessionId === id)!;

// ── one deck, two rollouts: one it watched appear, one that pre-dated it ─────
//
// Both halves in one deck lifetime on purpose. It is the contrast that is the
// bug: the two were indistinguishable in the shared log, and are not any more.
describe("a rollout the deck watched appear, beside one that was already running", () => {
  it("mints the start for the newborn, and withholds it from the one it joined late", async () => {
    const { home, day, workspace, cwd } = codexHome("contrast");
    const OLD = sid("oldx");
    // An AGENTS.md the joined-late session has in scope — see the memory
    // assertion at the end.
    writeFileSync(join(workspace, "AGENTS.md"), "# house rules\n", "utf8");

    // A Codex session that has been running for a while: a prompt the user
    // typed and a tool call it made, all before any deck existed.
    writeFileSync(rolloutPath(day, OLD), history(OLD, workspace, "the prompt the deck will never see"), "utf8");

    const { mod, stop } = await boot(home);
    try {
      // ── the session the deck DID watch begin ──────────────────────────────
      const newborn = await newbornUnderWatch(mod, day, workspace, "typed under the deck's watch");
      // The deck holds this one from its first byte, so it may say so — and the
      // root event comes first, before the prompt it introduces.
      expect(newborn.events[0]).toMatchObject({
        hook_event_name: "SessionStart", session_id: newborn.id, cwd, provider: "codex",
      });
      expect(rootOf(replay(newborn.events), newborn.id).synthetic).toBe(false);

      // ── the session it joined late ────────────────────────────────────────
      // It is still running, and does one more thing.
      appendFileSync(rolloutPath(day, OLD), turn("a prompt the deck does see"), "utf8");
      const joinedLate = await until(mod, OLD, "UserPromptSubmit", "the pre-existing rollout to append");

      // No start is asserted for a beginning nobody watched.
      expect(names(joinedLate)).not.toContain("SessionStart");
      // And the history really was skipped — this is not a deck that read the
      // whole file and merely forgot to announce it.
      expect(joinedLate.map(p => p.prompt).filter(Boolean)).toEqual(["a prompt the deck does see"]);

      // Which is what lets #683's marker do its job: the root is conjured by
      // the first event that reaches the reducer, and it is flagged.
      const late = rootOf(replay(joinedLate), OLD);
      expect(late.synthetic).toBe(true);
      // Nothing the withheld event carried is missing: the payload that creates
      // the root names the provider and the directory itself.
      expect(late.provider).toBe("codex");
      expect(late.cwd).toBe(cwd);

      // A consumer of the root's EXISTENCE rather than of the event. The
      // per-batch AGENTS.md resolution is gated on `rootOpened`, which still
      // flips for a joined-late session — only the announcement is withheld —
      // so a Codex card the deck joined late keeps its context modal.
      const context = await until(mod, OLD, "ContextObserved", "the AGENTS.md scan for the joined-late session");
      const observed = context.find(p => p.hook_event_name === "ContextObserved")!;
      expect(observed.context!.memoryFiles!.map(f => f.path)).toContain(join(cwd, "AGENTS.md"));
    } finally {
      stop();
    }
  }, 60_000);
});

// ── the deck restarts over a session that is still running ──────────────────
describe("a deck restarting over a Codex session that never stopped", () => {
  it("does not re-mint a start the new process did not witness", async () => {
    const { home, day, workspace, cwd } = codexHome("restart");

    // Deck one is up first, and watches the session appear.
    const first = await boot(home);
    let born: { id: string; events: HookPayload[] };
    try {
      born = await newbornUnderWatch(first.mod, day, workspace, "the first prompt, witnessed");
      expect(names(born.events)).toContain("SessionStart");
    } finally {
      first.stop();
    }
    const path = rolloutPath(day, born.id);
    expect(cwd).toBe(born.events[0].cwd);

    // The deck goes away — an upgrade, a crash, a closed terminal. The session
    // keeps working the whole time.
    appendFileSync(path, turn("typed while no deck was up"), "utf8");

    // Deck two comes up. The rollout now pre-dates it exactly as any other
    // in-progress session would, and it holds none of deck one's state.
    const second = await boot(home);
    try {
      // Same barrier: a rollout born under deck two's watch proves its startup
      // catalogue has finished before the append below.
      await newbornUnderWatch(second.mod, day, workspace, "an unrelated new session");

      appendFileSync(path, turn("typed after the restart"), "utf8");
      const afterRestart = await until(second.mod, born.id, "UserPromptSubmit", "deck two to read the append");

      expect(names(afterRestart)).not.toContain("SessionStart");
      expect(afterRestart.map(p => p.prompt).filter(Boolean)).toEqual(["typed after the restart"]);

      // ── what a deck replaying the shared log sees ──────────────────────────
      //
      // The restarted deck replays events.jsonl at boot, and that log already
      // holds the `SessionStart` deck one minted honestly. Its own live events
      // arrive after. The root is rebuilt from the recorded start and stays
      // unmarked, with the ORIGINAL start time — the restart neither invents a
      // second beginning nor retracts the one on record.
      const T0 = 1_700_000_000_000;
      const root = rootOf(replay([...born.events, ...afterRestart], T0), born.id);
      expect(root.synthetic).toBe(false);
      expect(root.startedAt).toBe(T0);
      // Both turns are on the card: the one deck one saw and the one deck two
      // saw, with only the gap between them missing.
      expect(root.prompts.map(p => p.text)).toEqual([
        "the first prompt, witnessed",
        "typed after the restart",
      ]);
    } finally {
      second.stop();
    }
  }, 90_000);
});

// ── the shared log, and the deck that is older than this change ─────────────
describe("what another deck replaying the same events.jsonl sees", () => {
  const SID = "684shr00-0000-4000-8000-0000000000cc";
  const CWD = "/srv/proj";
  // The joined-late Codex stream this change produces, spelled out: no
  // `SessionStart`, and nothing else about it new.
  const codexJoinedLate: HookPayload[] = [
    { session_id: SID, cwd: CWD, provider: "codex", approval_policy: "on-request", hook_event_name: "UserPromptSubmit", prompt: "mid-session", model: "gpt-5-codex" },
    { session_id: SID, cwd: CWD, provider: "codex", approval_policy: "on-request", hook_event_name: "PreToolUse", tool_name: "exec_command", tool_use_id: "c1", model: "gpt-5-codex" },
    { session_id: SID, cwd: CWD, provider: "codex", approval_policy: "on-request", hook_event_name: "PostToolUse", tool_use_id: "c1", tool_response: "ok", model: "gpt-5-codex" },
  ];
  // The Claude equivalent, which has always looked like this and which every
  // deck ever shipped has replayed: a session whose hooks started arriving
  // after it had begun.
  const claudeJoinedLate: HookPayload[] = [
    { session_id: "claude-late", cwd: CWD, hook_event_name: "UserPromptSubmit", prompt: "mid-session" },
    { session_id: "claude-late", cwd: CWD, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1" },
    { session_id: "claude-late", cwd: CWD, hook_event_name: "PostToolUse", tool_use_id: "t1", tool_response: "ok" },
  ];

  it("writes no event kind and no field a deck did not already handle", () => {
    // The fix is a subtraction. Everything still written is drawn from the set
    // the reducer has understood since Codex support landed, so a deck running
    // an older build of this code replays the log unchanged — it simply has no
    // `SessionStart` line to read, which is the same thing it has always been
    // handed for a Claude session it joined late.
    const known = new Set(["UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "ModelObserved", "UsageObserved", "ContextObserved"]);
    for (const p of codexJoinedLate) {
      expect(known.has(p.hook_event_name!)).toBe(true);
      // The three session-wide facts the withheld root event also carried are
      // on every one of these, so nothing an older deck read off it is lost.
      expect(p.provider).toBe("codex");
      expect(p.cwd).toBe(CWD);
      expect(p.approval_policy).toBe("on-request");
    }
  });

  it("draws a joined-late Codex session exactly like a joined-late Claude one", () => {
    const codex = rootOf(replay(codexJoinedLate), SID);
    const claude = rootOf(replay(claudeJoinedLate), "claude-late");
    expect(codex.synthetic).toBe(true);
    expect(claude.synthetic).toBe(true);
    // Same shape of card, differing only in the provider chip and the model.
    expect(codex.provider).toBe("codex");
    expect(claude.provider).toBe("claude");
    expect(codex.toolCount).toBe(claude.toolCount);
    expect(codex.prompts.length).toBe(claude.prompts.length);
  });

  it("still retracts the marker if a start for that session turns up later", () => {
    // Order independence is the reducer's contract, and it is what makes the
    // shared log safe: if some other deck WAS watching when this session began
    // and its `SessionStart` is in the log, replaying that line clears the
    // marker whether it lands before or after the events that created the root.
    const late: HookPayload = { session_id: SID, cwd: CWD, provider: "codex", hook_event_name: "SessionStart" };
    expect(rootOf(replay([...codexJoinedLate, late]), SID).synthetic).toBe(false);
    expect(rootOf(replay([late, ...codexJoinedLate]), SID).synthetic).toBe(false);
  });
});
