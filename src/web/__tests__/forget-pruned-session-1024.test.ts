// #1024: the client's own pruners drop a session the server's change-gated
// caches will never describe again, so a resumed session loses its name.
//
// `handleClear` states the rule out loud:
//
//     anything answering "has this changed" has to appear in BOTH places that
//     mean the client no longer has it — here, and in forgetSession.
//
// There is a third place, and the server never heard about it: the page's own
// `pruneDoneSessions` and `pruneOldAgents`, which run every 250ms at cap 6 /
// grace 2 minutes. #445's own measurement says 7 of 20 evicted sessions went on
// to emit more events.
//
// Usage, context and the ROOT model all come back on their own — the first two
// are not change-gated, and `pushEvent` stamps `raw.model` on every payload.
// `sessionName`/`sessionTitle` and the per-subagent models do not:
// `nameBySession` and `modelBySession` still hold the signature, so no
// `SessionNamed` is ever emitted again.
//
// OBSERVED against a real deck over a real transcript, sandboxed HOME, Linux /
// Node 24 — one session named "reducer-audit", pruned by the client, then
// resumed and given four more prompts:
//
//     SessionNamed emitted while the session was on the board: ["reducer-audit"]
//     --- the client's pruner drops S5 from state.agents (nothing is sent) ---
//     events for S5 after the resume: UserPromptSubmit, UsageObserved,
//       UserPromptSubmit, UsageObserved, ContextObserved, UserPromptSubmit,
//       UsageObserved, UserPromptSubmit, UsageObserved, ContextObserved
//     SessionNamed among them: false
//
// A session evicted while idle and then resumed showed as unnamed in the sidebar
// and on the card for the rest of the day, with no way to recover but reloading
// the tab.
//
// THE OTHER OPTION IN THE REPORT WAS TO DROP THE CHANGE GATE, and it was not
// taken. The gate is what keeps a per-pass emit from becoming ~683 events saying
// nothing out of 685 records; the reducer absorbing repeats correctly is not a
// reason to send them. So the pruners say what they dropped instead, and
// `forgetSession` — which already exists, and which the server has been calling
// on itself since the LRU cap was added — does the rest.
//
// WHY THE PRUNERS REPORT A SESSION AND NOT AN AGENT. `pruneOldAgents` evicts
// individual subtrees, and a root that goes while a sibling subagent stays is
// not a session the page has forgotten — it still holds the name it was sent,
// and reporting it would buy a transcript re-read for no change.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { get, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

import { applyEvent, initialState, pruneDoneSessions, pruneOldAgents, STALE_SESSION_MS, type GraphState } from "../reducer";
import { sweepTick } from "../prune";
import type { HookEnvelope, HookPayload } from "../types";

// Temp home, set before the dynamic import: the server resolves its config
// directories at import time and the real ~/.claude must stay untouched.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-forget-1024-"));
const prevEnv = { ...process.env };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.XDG_CONFIG_HOME = join(DIR, "config");

// @ts-expect-error — .mjs server module, no types
const { startServer, hookToken } = await import("../../server/index.mjs");

const NAME = "reducer-audit";
const MODEL = "claude-opus-4-7";
// Where Claude Code actually writes a transcript, and since #674 the only shape
// the deck will follow a posted `transcript_path` into — a fixture in the bare
// temp dir is refused unopened and nothing here would resolve at all.
const PROJECTS = join(DIR, "claude", "projects", "-tmp-forget-1024");
const TRANSCRIPT = join(PROJECTS, "transcript.jsonl");

let server: Server;
let port = 0;

beforeAll(async () => {
  mkdirSync(PROJECTS, { recursive: true });
  writeFileSync(TRANSCRIPT, [
    JSON.stringify({ type: "agent-name", agentName: NAME }),
    JSON.stringify({ type: "assistant", message: { model: MODEL, usage: { input_tokens: 10, output_tokens: 1 } } }),
  ].join("\n") + "\n", "utf8");
  server = await startServer({ port: 0, host: "127.0.0.1", persist: null, codex: false });
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>(done => {
    server.closeAllConnections?.();
    server.close(() => done());
  });
  for (const k of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME"]) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  rmTempDir(DIR);
});

function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: "POST", headers: { "Content-Type": "application/json", ...headers } },
      res => {
        let out = "";
        res.setEncoding("utf8");
        res.on("data", c => { out += c; });
        res.on("end", () => {
          try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(out) }); } catch (e) { reject(e); }
        });
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

type Envelope = { seq: number; payload: HookPayload & { sessionName?: string } };

function since(seq: number): Promise<Envelope[]> {
  return new Promise((resolve, reject) => {
    get({ host: "127.0.0.1", port, path: `/api/events?since=${seq}`, headers: { "x-ccdeck-token": hookToken() } }, res => {
      let out = "";
      res.setEncoding("utf8");
      res.on("data", c => { out += c; });
      res.on("end", () => { try { resolve(JSON.parse(out)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** What the deck's own page sends. `/api/forget` is a mutation and mutations are
 *  refused by default — the gate is written so a route added later is protected
 *  until somebody deliberately opens it, and this one is deliberately not open.
 *  A page's own fetch carries Sec-Fetch-Site: same-origin. */
const uiHeaders = () => ({
  host: `127.0.0.1:${port}`,
  origin: `http://127.0.0.1:${port}`,
  "sec-fetch-site": "same-origin",
});

const forget = (ids: unknown) => post("/api/forget", { ids }, uiHeaders());

/** Every `SessionNamed` the deck has emitted for `sid`, in order. */
async function namesFor(sid: string): Promise<Array<string | undefined>> {
  return (await since(0))
    .filter(e => e.payload.hook_event_name === "SessionNamed" && e.payload.session_id === sid)
    .map(e => e.payload.sessionName);
}

/** Drive a prompt into the deck and wait until the transcript scan behind it has
 *  named the session, or give up. The scan is throttled per session
 *  (MODEL_READ_THROTTLE_MS, 2.5s), so a caller that wants a SECOND read has to
 *  wait the throttle out first — which is what a resumed session does anyway. */
async function promptAndWaitForName(sid: string, want: number): Promise<boolean> {
  await post("/api/event", {
    hook_event_name: "UserPromptSubmit", session_id: sid, cwd: DIR, transcript_path: TRANSCRIPT, prompt: "hi",
  });
  for (let i = 0; i < 200; i++) {
    if ((await namesFor(sid)).length >= want) return true;
    await sleep(25);
  }
  return false;
}

describe("the server, told what the page's pruners dropped", () => {
  it("names a resumed session again, where before it never did", async () => {
    const sid = "S5";
    expect(await promptAndWaitForName(sid, 1)).toBe(true);
    expect(await namesFor(sid)).toEqual([NAME]);

    // The pruner runs in the page and the session leaves the board. This is the
    // POST it now sends; before #1024 nothing was sent at all.
    const said = await forget([sid]);
    expect(said.status).toBe(200);
    expect(said.body.forgotten).toBe(1);

    // The session is resumed. Past the read throttle, because a scan inside it
    // is not a scan at all and the bug is not about throttling.
    await sleep(3000);
    expect(await promptAndWaitForName(sid, 2)).toBe(true);
    expect(await namesFor(sid)).toEqual([NAME, NAME]);
  }, 40_000);

  it("says nothing new for a session that is still on the board", async () => {
    // The gate is still a gate. A session the page never pruned keeps talking
    // and is named exactly once, which is the whole reason the gate exists:
    // 685 records carrying 2 distinct values would otherwise be ~683 events
    // saying nothing.
    const sid = "S6";
    expect(await promptAndWaitForName(sid, 1)).toBe(true);
    for (let i = 0; i < 3; i++) {
      await sleep(3000);
      await post("/api/event", {
        hook_event_name: "UserPromptSubmit", session_id: sid, cwd: DIR, transcript_path: TRANSCRIPT, prompt: "more",
      });
    }
    await sleep(500);
    expect(await namesFor(sid)).toEqual([NAME]);
  }, 40_000);

  it("refuses a body that names no ids", async () => {
    expect((await post("/api/forget", { nope: true }, uiHeaders())).status).toBe(400);
    expect((await post("/api/forget", "not an object", uiHeaders())).status).toBe(400);
  });

  it("ignores anything in the list that is not a session id", async () => {
    // The list comes from a page, and a page can send anything. Nothing here
    // should throw — `guard` would turn that into a 500 on a route whose whole
    // job is housekeeping.
    const said = await forget(["", 7, null, { fp: "x" }, "S9"]);
    expect(said.status).toBe(200);
    expect(said.body.forgotten).toBe(1);
  });

  it("is refused outright to a caller that is not the deck's own page", async () => {
    // The mutation gate refuses by default, and a route added later stays
    // refused until somebody deliberately lists it as open. This one is not
    // open: the sandboxed subprocess with loopback egress that gate was written
    // for should not be able to make the deck re-read transcripts on demand.
    expect((await post("/api/forget", { ids: ["S5"] })).status).toBe(401);
  });
});

// ── the pruners' half, against the real reducer ─────────────────────────────

let seq = 0;
const envelope = (payload: Partial<HookPayload>, receivedAt: number): HookEnvelope => ({
  seq: ++seq, epoch: 1, receivedAt, source: "hook", payload,
} as HookEnvelope);

function boardWith(events: Array<[Partial<HookPayload>, number]>): GraphState {
  let state = initialState();
  for (const [p, at] of events) state = applyEvent(state, envelope(p, at));
  return state;
}

describe("what the pruners report", () => {
  it("names a session that left the board whole", () => {
    // The reporter's own fixture: one finished root, cap 0, grace 0.
    const state = boardWith([
      [{ hook_event_name: "SessionStart", session_id: "S5", cwd: "/srv/proj" }, 1000],
      [{ hook_event_name: "Stop", session_id: "S5", cwd: "/srv/proj" }, 2000],
    ]);
    const forgotten: string[] = [];
    expect(pruneDoneSessions(state, 3_000_000, 0, 0, sid => forgotten.push(sid))).toBe(true);
    expect(state.agents.size).toBe(0);
    expect(forgotten).toEqual(["S5"]);
  });

  it("stays silent when nothing was evicted", () => {
    const state = boardWith([
      [{ hook_event_name: "SessionStart", session_id: "S5", cwd: "/srv/proj" }, 1000],
    ]);
    const forgotten: string[] = [];
    // Still running, so there is nothing finished to spend.
    expect(pruneDoneSessions(state, 3_000_000, 0, 0, sid => forgotten.push(sid))).toBe(false);
    expect(pruneOldAgents(state, 3_000_000, 0, 0, sid => forgotten.push(sid))).toBe(false);
    expect(forgotten).toEqual([]);
  });

  it("does not name a session that still has an agent on the board", () => {
    // `pruneOldAgents` evicts subtrees, not sessions. A session with anything
    // left on the canvas has not been forgotten by this page, and telling the
    // server otherwise would buy a transcript re-read for no change.
    //
    // Two roots that finished at different times, one cap: the older one goes
    // and the newer one stays, so one session is reported and one is not.
    const state = boardWith([
      [{ hook_event_name: "SessionStart", session_id: "old", cwd: "/srv/proj" }, 1000],
      [{ hook_event_name: "Stop", session_id: "old", cwd: "/srv/proj" }, 2000],
      [{ hook_event_name: "SessionStart", session_id: "new", cwd: "/srv/proj" }, 3000],
      [{ hook_event_name: "Stop", session_id: "new", cwd: "/srv/proj" }, 4000],
    ]);
    const forgotten: string[] = [];
    expect(pruneOldAgents(state, 3_000_000, 1, 0, sid => forgotten.push(sid))).toBe(true);
    expect(forgotten).toEqual(["old"]);
    expect([...state.agents.keys()]).toEqual(["new"]);
  });

  it("is optional, so every other caller of the pruners is unchanged", () => {
    const state = boardWith([
      [{ hook_event_name: "SessionStart", session_id: "S5", cwd: "/srv/proj" }, 1000],
      [{ hook_event_name: "Stop", session_id: "S5", cwd: "/srv/proj" }, 2000],
    ]);
    expect(() => pruneDoneSessions(state, 3_000_000, 0, 0)).not.toThrow();
    expect(state.agents.size).toBe(0);
  });
});

// #1175. The two halves above — the route and the pruners' callback — were each
// tested alone, and the wiring between them was not: the page's tick is what
// passes `forget` and what POSTs the result, and App.tsx is at 0%. The callback
// is optional (the case above says so), so dropping the argument compiles,
// keeps every test here green, and silently brings #1024 back.
//
// So the tick's sweeps are `sweepTick` now, with the shipped constants in it,
// and the page calls that.
describe("the sweep one tick runs", () => {
  /** Well past AGENT_GRACE_MS and DONE_SESSION_GRACE_MS, which is the tick that
   *  actually evicts anything. */
  const LATER = 5_000_000;
  const finishedSessions = (count: number, from = 1) => {
    const events: Array<[Partial<HookPayload>, number]> = [];
    for (let i = 0; i < count; i++) {
      const sid = `s${from + i}`;
      const at = 1000 + i * 1000;
      events.push([{ hook_event_name: "SessionStart", session_id: sid, cwd: `/p/${sid}` }, at]);
      events.push([{ hook_event_name: "Stop", session_id: sid, cwd: `/p/${sid}` }, at + 100]);
    }
    return events;
  };

  it("names exactly the sessions the cap spent, and says something moved", () => {
    // Eight finished sessions against a cap of six: the two that finished
    // longest ago go, and those two are what the server is told about.
    const state = boardWith(finishedSessions(8));
    const { changed, forgotten } = sweepTick(state, LATER);
    expect(changed).toBe(true);
    expect(forgotten).toEqual(["s1", "s2"]);
    expect([...state.agents.keys()].sort()).toEqual(["s3", "s4", "s5", "s6", "s7", "s8"]);
  });

  it("names nothing on a board with nothing to spend, so no request is made", () => {
    // `forgotten.length > 0` is the whole of the page's send condition, so an
    // empty list here is what keeps a quiet deck from POSTing four times a
    // second.
    const state = boardWith([
      [{ hook_event_name: "SessionStart", session_id: "live", cwd: "/p" }, 1000],
    ]);
    expect(sweepTick(state, LATER)).toEqual({ changed: false, forgotten: [] });
  });

  it("reaps an abandoned tool call, and reports that as a change with nothing forgotten", () => {
    // `changed` is about rendering and `forgotten` is about the server, and
    // they answer different questions. Both staleness sweeps are in the tick
    // and each answers a case the other does not, so they are driven apart:
    // here the session already ended and left a call in flight behind it, which
    // the session sweep has nothing left to settle and the tool sweep does.
    const state = boardWith([
      [{ hook_event_name: "SessionStart", session_id: "live", cwd: "/p" }, 1000],
      [{ hook_event_name: "SubagentStart", session_id: "live", cwd: "/p", parent_tool_use_id: "tu1", subagent_type: "worker" }, 1100],
      [{ hook_event_name: "PreToolUse", session_id: "live", cwd: "/p", tool_name: "Bash", tool_use_id: "t1", parent_tool_use_id: "tu1" }, 1200],
      [{ hook_event_name: "Stop", session_id: "live", cwd: "/p" }, 1300],
    ]);
    const sub = [...state.agents.values()].find(a => a.kind === "subagent")!;
    expect(sub.tools[0]?.ok).toBeUndefined();
    const { changed, forgotten } = sweepTick(state, 1300 + STALE_SESSION_MS + 1);
    expect(changed).toBe(true);
    expect(forgotten).toEqual([]);
    expect(sub.tools[0]?.ok).toBe(false);
  });

  it("settles a session nobody has heard from, with no tool of its own to reap", () => {
    // The other sweep alone: a terminal killed while a permission prompt was up
    // sends no final event, so its root stays `active` and its waiting block
    // stays lit on the tab title and the favicon.
    const state = boardWith([
      [{ hook_event_name: "SessionStart", session_id: "gone", cwd: "/p" }, 1000],
    ]);
    const { changed, forgotten } = sweepTick(state, 1000 + STALE_SESSION_MS + 1);
    expect(changed).toBe(true);
    expect(forgotten).toEqual([]);
    expect(state.agents.get("gone")?.state).toBe("done");
  });

  it("lets the agent cap name a session the session cap could not have reached", () => {
    // The two pruners are not interchangeable, and this is the case that says
    // so: six sessions, which is exactly the session cap, so that sweep evicts
    // nothing at all — and 206 agents, which is over AGENT_CAP, so the agent
    // sweep spends the oldest thing on the board. That oldest thing is a whole
    // session, and it is the agent cap alone that names it.
    const events: Array<[Partial<HookPayload>, number]> = [
      [{ hook_event_name: "SessionStart", session_id: "first", cwd: "/p/first" }, 1000],
      [{ hook_event_name: "Stop", session_id: "first", cwd: "/p/first" }, 1100],
    ];
    for (let s = 0; s < 5; s++) {
      const sid = `fat${s}`;
      const base = 10_000 + s * 10_000;
      events.push([{ hook_event_name: "SessionStart", session_id: sid, cwd: `/p/${sid}` }, base]);
      for (let k = 0; k < 40; k++) {
        const tu = `tu${s}-${k}`;
        events.push([{ hook_event_name: "SubagentStart", session_id: sid, cwd: `/p/${sid}`, parent_tool_use_id: tu, subagent_type: "worker" }, base + k * 2 + 1]);
        events.push([{ hook_event_name: "SubagentStop", session_id: sid, cwd: `/p/${sid}`, parent_tool_use_id: tu }, base + k * 2 + 2]);
      }
      events.push([{ hook_event_name: "Stop", session_id: sid, cwd: `/p/${sid}` }, base + 200]);
    }
    const state = boardWith(events);
    expect(state.agents.size).toBe(1 + 5 * 41);
    const { changed, forgotten } = sweepTick(state, LATER);
    expect(changed).toBe(true);
    expect(forgotten).toEqual(["first"]);
    // The five fat sessions are all still here, so nothing the session cap does
    // could have produced that id.
    expect(new Set([...state.agents.values()].map(a => a.sessionId)).size).toBe(5);
  });

  it("puts both pruners' ids in one array, the agent cap's first", () => {
    // The reason the tick collects instead of POSTing per pruner: the two run
    // back to back, and a cap coming down by two hundred sessions is one
    // request. 201 finished roots — one over AGENT_CAP, so the agent sweep
    // spends the oldest, and the session sweep then cuts the rest to six.
    const state = boardWith(finishedSessions(201));
    const { changed, forgotten } = sweepTick(state, LATER);
    expect(changed).toBe(true);
    expect(forgotten[0]).toBe("s1");
    expect(forgotten).toHaveLength(201 - 6);
    // One id per session, however many passes touched it.
    expect(new Set(forgotten).size).toBe(forgotten.length);
    expect(state.agents.size).toBe(6);
    expect([...state.agents.keys()].sort()).toEqual(["s196", "s197", "s198", "s199", "s200", "s201"]);
  });

  it("leaves a session with a subagent still running alone, and does not name it", () => {
    // Both pruners refuse it — the agent sweep evicts only what is `done`, and
    // a session counts as finished only when everything in it is. Naming it
    // would have the server drop the caches for a session that is still on
    // screen and still being described.
    const state = boardWith([
      ...finishedSessions(8),
      [{ hook_event_name: "SessionStart", session_id: "busy", cwd: "/p/busy" }, 500],
      [{ hook_event_name: "Stop", session_id: "busy", cwd: "/p/busy" }, 600],
      [{ hook_event_name: "SubagentStart", session_id: "busy", cwd: "/p/busy", parent_tool_use_id: "tu1", subagent_type: "worker" }, 700],
    ]);
    const { forgotten } = sweepTick(state, LATER);
    expect(forgotten).not.toContain("busy");
    expect([...state.agents.values()].filter(a => a.sessionId === "busy")).toHaveLength(2);
  });
});

describe("the page's tick runs that sweep and posts what it named", () => {
  const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");

  it("calls sweepTick and POSTs the ids only when there are some", () => {
    expect(app).toMatch(/const \{ changed, forgotten \} = sweepTick\(stateRef\.current, t\);/);
    expect(app).toMatch(
      /if \(forgotten\.length > 0\) \{[\s\S]{0,600}?fetch\("\/api\/forget", \{[\s\S]{0,200}?body: JSON\.stringify\(\{ ids: forgotten \}\),/);
    // And the sweeps are not also written out here, which is how the constants
    // and the collection drifted out of reach of a test in the first place.
    expect(app).not.toMatch(/pruneDoneSessions\(/);
    expect(app).not.toMatch(/pruneOldAgents\(/);
  });
});
