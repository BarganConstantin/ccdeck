// #2193 on the page: what a stopped card, its detail panel and Settings say
// about continuing a turn that stopped on an expired login or a usage limit.
//
// A background session — one Claude Code keeps a job folder for — gets a
// Continue button in its stop row, disabled until the server has read a
// working login since the stop. A session in a terminal gets none: ccdeck
// cannot type into it, so the row and the panel say to type "continue" there,
// with the word ready to copy. The card is drawn the way the board draws it,
// from the real reducer's root and the store use-stop-continue.ts keeps; the
// press goes to a stubbed fetch, never to a server.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider } from "reactflow";
import { applyEvent, initialState, type GraphState } from "../reducer";
import type { AgentNodeData, BackgroundJob, HookEnvelope, HookPayload } from "../types";
import AgentNode from "../components/AgentNode";
import { isAgentVisible } from "../visibility";
import { StopContinueSection } from "../components/StopContinue";
import SessionRecoverySettings from "../components/SessionRecoverySettings";
import { SETTINGS_INDEX } from "../settings-search";
import { stopAdvice, stopTooltip } from "../stop-failure-copy";
import {
  answerFrom, continueView, pressContinue, resetStopContinue, type ContinueAnswer,
} from "../use-stop-continue";
import { autoSentence, continueCommands, gateSentence, outcomeLabel, outcomeTooltip, refusalSentence, type ContinueOutcome } from "../stop-continue-copy";

const SID = "1f0e2c9a-6d0b-4c11-9f39-2a77c1d4e8b5";
let seq = 0;
let t = Date.now() - 10 * 60_000;

function send(state: GraphState, payload: Partial<HookPayload>, at = (t += 1_000)): void {
  applyEvent(state, { seq: ++seq, receivedAt: at, source: "hook", payload: { session_id: SID, provider: "claude", ...payload } as HookPayload } as HookEnvelope);
}

/** A session whose turn stopped on its expired login, with a job folder when
 *  `background`. */
function stopped(background: boolean): AgentNodeData {
  seq = 0;
  const state = initialState();
  send(state, { hook_event_name: "SessionStart", cwd: "/work/repo" });
  send(state, { hook_event_name: "UserPromptSubmit", prompt: "fix the build" });
  send(state, { hook_event_name: "StopFailure", cwd: "/work/repo", error: "authentication_failed", last_assistant_message: "Login expired · Please run /login" });
  const a = state.agents.get(SID)!;
  if (background) a.job = { id: "7c5dcf5d", state: "blocked", detail: "Login expired", updatedAt: t } satisfies BackgroundJob;
  return a;
}

const card = (a: AgentNodeData) => renderToStaticMarkup(createElement(ReactFlowProvider, null,
  createElement(AgentNode as never, { id: a.id, data: a, selected: false })));
const panel = (a: AgentNodeData) => renderToStaticMarkup(createElement(StopContinueSection, { agent: a }));
const buttonIn = (html: string) => /<button[^>]*class="stop-continue"[^>]*>[^<]*<\/button>/.exec(html)?.[0] ?? null;

/** The server's answer, with the evidence of a working login read `ms` after
 *  the stop (or none), and the session's own record. */
function answer(a: AgentNodeData, ms: number | null, rec: Partial<ContinueAnswer["sessions"][string]> = {}, auto = false): ContinueAnswer {
  const at = a.stopFailure?.at ?? t;
  return {
    auto, withLogin: true,
    login: ms == null ? null : { ok: true, at: at + ms, room: true },
    sessions: { [SID]: { stop: a.stopFailure ? { kind: a.stopFailure.kind, at } : null, held: false, tried: false, last: null, ...rec } },
  };
}

afterEach(() => { resetStopContinue(); vi.unstubAllGlobals(); });

describe("the card", () => {
  it("gives a stopped background session a Continue in its stop row, and a terminal session none", () => {
    expect(buttonIn(card(stopped(false)))).toBeNull();
    const html = card(stopped(true));
    expect(buttonIn(html)).toMatch(/>Continue<\/button>$/);
    // Inside the stop row, after what the row says.
    expect(html).toMatch(/class="stop-row"[^]*class="stop-said"[^]*class="stop-continue"/);
  });

  it("keeps it disabled until a working login has been read since the stop, and says why", () => {
    const a = stopped(true);
    // No answer yet.
    expect(buttonIn(card(a))).toMatch(/disabled=""/);
    expect(buttonIn(card(a))).toMatch(/title="Checking for a working login…/);
    // The newest reading is older than the stop.
    resetStopContinue({ answer: answer(a, -1) });
    expect(buttonIn(card(a))).toMatch(/disabled=""/);
    expect(buttonIn(card(a))).toContain("Not yet: nothing shows a working login since it stopped.");
    // Read after it, with room.
    resetStopContinue({ answer: answer(a, 1_000) });
    expect(buttonIn(card(a))).not.toMatch(/disabled=""/);
    expect(buttonIn(card(a))).toContain("Run the turn that failed again, in place");
  });

  it("never disables itself while its own press is out (#518)", () => {
    const a = stopped(true);
    resetStopContinue({ answer: answer(a, 1_000), pressing: new Set([SID]) });
    const b = buttonIn(card(a))!;
    expect(b).not.toMatch(/disabled=""/);
    expect(b).toMatch(/aria-busy="true"/);
    expect(b).toMatch(/>Continuing…<\/button>$/);
  });

  it("tells a background session to press Continue, and a terminal one to type it", () => {
    const bg = stopped(true);
    expect(stopTooltip(bg.stopFailure!, true)).toMatch(/Press Continue once a working login is active\.$/);
    expect(card(bg)).toContain("Press Continue once a working login is active.");
    expect(card(stopped(false))).toContain("Type “continue” in this session once a working login is active.");
    expect(stopAdvice("usage-limit", true)).toBe("Press Continue once the limit resets or another account is active.");
    expect(stopAdvice("api-error", true)).toBe("Press Continue to run the turn again.");
    // #2191's words for everything else are unchanged.
    expect(stopAdvice("login")).toBe("Type “continue” in this session once a working login is active.");
  });

  it("says on the card that it was continued automatically, once the session is going again", () => {
    const a = stopped(true);
    a.stopFailure = undefined;
    resetStopContinue({ answer: answer(a, null, {
      last: { at: Date.now() - 2 * 60_000 - 5_000, auto: true, ok: true, outcome: "continued", reason: null, detail: "", stopped: false },
    }) });
    expect(card(a)).toMatch(/class="continued-row"[^]*class="continued-said">Continued automatically 2m ago</);
  });

  it("draws a session that stopped at once on a dead login, which a ghost filter would have hidden", () => {
    // stopped() starts, prompts and stops within three seconds, with no tool.
    const a = stopped(true);
    expect(a.tools).toHaveLength(0);
    expect(a.endedAt! - a.startedAt).toBeLessThan(3000);
    expect(isAgentVisible(a, Date.now())).toBe(true);
    // A session that simply ended that fast is still a ghost.
    expect(isAgentVisible({ ...a, stopFailure: undefined }, Date.now())).toBe(false);
  });

  it("says nothing about continuing on a subagent or a Codex session", () => {
    const a = stopped(true);
    expect(continueView({ ...a, kind: "agent" }, { answer: null, pressing: new Set(), pressed: {} })).toBeNull();
    expect(continueView({ ...a, provider: "codex" }, { answer: null, pressing: new Set(), pressed: {} })).toBeNull();
  });
});

describe("the detail panel", () => {
  it("gives a terminal session the instruction and the word to copy, and no Continue", () => {
    const html = panel(stopped(false));
    expect(html).toContain("This session runs in a terminal, and ccdeck can&#x27;t type into it. Type “continue” there once a working login is active.");
    expect(html).toContain("Copy “continue”");
    expect(html).not.toMatch(/>Continue<\/button>/);
  });

  it("gives a background session the button, the gate and the commands it runs", () => {
    const a = stopped(true);
    resetStopContinue({ answer: answer(a, 1_000, {}, true) });
    const html = panel(a);
    expect(html).toMatch(/<button[^>]*class="btn primary detail-continue-btn"[^>]*>Continue<\/button>/);
    expect(html).toContain("A working login with room is active now.");
    expect(html).toContain("Continues automatically once a working login with room is active.");
    expect(html).toContain(`claude stop 7c5dcf5d\nclaude --resume ${SID} --bg &quot;Continue from where you left off.&quot;`);
  });
});

describe("the server's answer, as the page reads it", () => {
  it("checks every field, and keeps no evidence it did not ask for", () => {
    expect(answerFrom(null, true)).toBeNull();
    expect(answerFrom({ ok: false }, true)).toBeNull();
    const got = answerFrom({
      ok: true, auto: true, login: { ok: true, at: 5, room: true },
      sessions: {
        [SID]: { stop: { kind: "login", at: 3 }, held: true, tried: "yes", last: { at: 4, auto: true, ok: true, outcome: "continued" } },
        other: { stop: { kind: "constructor", at: 3 }, last: { at: "soon" } },
      },
    }, false)!;
    expect(got.login).toBeNull();
    expect(got.auto).toBe(true);
    expect(got.sessions[SID]).toEqual({ stop: { kind: "login", at: 3 }, held: true, tried: false,
      last: { at: 4, auto: true, ok: true, outcome: "continued", reason: null, detail: "", stopped: false } });
    expect(got.sessions.other).toEqual({ stop: null, held: false, tried: false, last: null });
  });

  it("reads the server's held and tried only for the stop the card shows", () => {
    const a = stopped(true);
    const view = (rec: Partial<ContinueAnswer["sessions"][string]>) =>
      continueView(a, { answer: answer(a, 1_000, rec, true), pressing: new Set(), pressed: {} })!;
    expect(view({ held: true, tried: true })).toMatchObject({ held: true, tried: true });
    expect(view({ held: true, tried: true, stop: { kind: "login", at: a.stopFailure!.at - 1 } })).toMatchObject({ held: false, tried: false });
  });

  it("shows the newest continue, a press here or the server's", () => {
    const a = stopped(true);
    const o = (at: number, auto: boolean): ContinueOutcome => ({ at, auto, ok: true, outcome: "continued", reason: null, detail: "", stopped: false });
    const s = { answer: answer(a, 1_000, { last: o(10, true) }), pressing: new Set<string>(), pressed: { [SID]: o(20, false) } };
    expect(continueView(a, s)!.last).toEqual(o(20, false));
    expect(continueView(a, { ...s, pressed: { [SID]: o(5, false) } })!.last).toEqual(o(10, true));
  });
});

describe("a press", () => {
  it("posts the session and its stop, and keeps what the server said", async () => {
    const a = stopped(true);
    const posts: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ ok: false, reason: "not_ready", gate: "no-room" }), { status: 409 });
      }
      return new Response(JSON.stringify({ ok: true, auto: false, login: null, sessions: {} }));
    }));
    const out = await pressContinue(SID, a.stopFailure!);
    expect(posts).toEqual([{ sessionId: SID, stop: { kind: "login", at: a.stopFailure!.at } }]);
    expect(out).toMatchObject({ ok: false, reason: "not_ready", detail: gateSentence("no-room") });
    expect(refusalSentence(out!.reason, out!.detail)).toBe("Not yet: the active account has no room left in its 5-hour or 7-day window.");
  });

  it("is one at a time for a session, and says so when the server cannot be reached", async () => {
    let calls = 0;
    let release!: () => void;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== "POST") return new Response("{}");
      calls++;
      await new Promise<void>(r => { release = r; });
      throw new TypeError("Failed to fetch");
    }));
    const first = pressContinue(SID, { kind: "login", at: 1 });
    expect(await pressContinue(SID, { kind: "login", at: 1 })).toBeNull();
    release();
    expect(await first).toMatchObject({ ok: false, reason: "unreachable" });
    expect(calls).toBe(1);
    expect(refusalSentence("unreachable")).toBe("ccdeck's server could not be reached.");
  });

  it("words what went wrong, and the copy Claude Code may start instead", () => {
    const o = (over: Partial<ContinueOutcome>): ContinueOutcome => ({ at: 0, auto: false, ok: true, outcome: "continued", reason: null, detail: "", stopped: false, ...over });
    expect(outcomeLabel(o({ auto: true }), 3 * 60_000)).toBe("Continued automatically 3m ago");
    expect(outcomeLabel(o({ ok: false, reason: "resume_failed", outcome: null }), 0)).toBe("Continue failed just now");
    expect(outcomeTooltip(o({ ok: false, reason: "resume_failed", detail: "Workspace not trusted", stopped: true })))
      .toBe("ccdeck stopped it, then claude --resume --bg failed: Workspace not trusted. The conversation is kept: open it from agent view.");
    expect(outcomeTooltip(o({ outcome: "copied", detail: "started a copy" })))
      .toBe("Continued from ccdeck. It sent: “Continue from where you left off.”\nClaude Code started a copy instead of continuing it in place: “started a copy”");
    // A line that ends on its own full stop does not get a second one.
    expect(refusalSentence("stop_failed", "No session 7c5dcf5d.")).toBe("claude stop failed: No session 7c5dcf5d. Nothing was sent.");
    expect(refusalSentence("interactive")).toBe("This session runs in a terminal, so ccdeck can't continue it. Type “continue” there.");
    expect(autoSentence({ auto: true, kind: "login", held: true, tried: true })).toMatch(/^Not continued automatically: it stopped again/);
    expect(autoSentence({ auto: false, kind: "login", held: false, tried: false })).toBe("");
    expect(autoSentence({ auto: true, kind: "api-error", held: false, tried: false })).toBe("");
    expect(continueCommands("7c5dcf5d", SID)).toBe(`claude stop 7c5dcf5d\nclaude --resume ${SID} --bg "Continue from where you left off."`);
  });
});

describe("the setting", () => {
  it("is a switch under Claude sessions, drawn off until the server says otherwise, and findable", () => {
    const claude = renderToStaticMarkup(createElement(SessionRecoverySettings, { provider: "Claude" }));
    expect(claude).toMatch(/data-setting="claude-continue-stopped"/);
    expect(claude).toMatch(/<button[^>]*role="switch"[^>]*aria-label="Continue stopped background sessions automatically"[^>]*>/);
    expect(/<button[^>]*aria-label="Continue stopped background sessions automatically"[^>]*>/.exec(claude)![0]).toMatch(/aria-checked="false"/);
    expect(renderToStaticMarkup(createElement(SessionRecoverySettings, { provider: "Codex" }))).not.toContain("Continue stopped");
    expect(SETTINGS_INDEX.find(e => e.id === "claude-continue-stopped")).toMatchObject({ claudeOnly: true, group: "Claude sessions" });
  });
});
