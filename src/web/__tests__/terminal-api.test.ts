// The terminal panel's five HTTP calls, answered by a fake fetch.
//
// What these pin is the edge between "the deck answered" and "the deck said
// yes": a 200 that says a session cannot be attached is a state the panel
// draws, a 409 is the one refusal it has words for, the 404 every route gives
// while the flag is off is a fact and not a crash, and a network failure or a
// mangled body is never mistaken for a ticket. Each case hands the call a
// fetch that records what it was asked and answers with a real Response, so
// the request (path, method, body, headers) and the reading of the answer are
// both checked against the shapes src/server/terminal-routes.mjs speaks.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  STILL_RUNNING,
  TERMINAL_ROUTES,
  adoptTerminal,
  launchTerminal,
  openTerminal,
  terminalStatus,
  terminalTarget,
  type SessionRef,
} from "../terminal-api";
import { withoutComments } from "./tsx-scan";

type Asked = { url: string; method: string; headers: Record<string, string>; body: unknown; signal?: AbortSignal };

/** A fetch that answers every request with `status` and `body`, and records
 *  each request it saw. `body` may be a string to send something that is not
 *  JSON at all. */
function answering(status: number, body: unknown) {
  const asked: Asked[] = [];
  const fetchFn = async (url: string, init?: RequestInit) => {
    asked.push({
      url,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
      signal: init?.signal ?? undefined,
    });
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { "content-type": "application/json" } });
  };
  return { fetchFn, asked };
}

const SESSION: SessionRef = {
  sessionId: "0b7c4e2a-9f1d-4c3b-8a6e-2d5f7e9a1c3b",
  provider: "claude",
  cwd: "/home/someone/My Project/ünïcode & more",
};

const ATTACHABLE = { kind: "A", label: "A deck session — attached live." };
const STARTED_ELSEWHERE = {
  kind: "C",
  label: "This session was started outside the deck, so there is no pane to attach to.",
  adoptable: true,
};

describe("the requests themselves", () => {
  it("asks only same-origin paths under /api/terminal/, the ones the deck routes", () => {
    for (const path of Object.values(TERMINAL_ROUTES)) expect(path).toMatch(/^\/api\/terminal\/[a-z]+$/);
    expect(Object.keys(TERMINAL_ROUTES).sort()).toEqual(["adopt", "launch", "open", "status", "target"]);
  });

  it("reads the status with a plain GET", async () => {
    const { fetchFn, asked } = answering(200, { ok: true, platform: "linux", tmux: { ok: true, version: [3, 6] } });
    await terminalStatus({ fetchFn });
    expect(asked).toEqual([{ url: "/api/terminal/status", method: "GET", headers: {}, body: undefined, signal: undefined }]);
  });

  it("puts the session, provider and cwd in the target's query, encoded", async () => {
    const { fetchFn, asked } = answering(200, { ok: true, target: ATTACHABLE });
    await terminalTarget(SESSION, { fetchFn });
    const url = new URL(asked[0].url, "http://127.0.0.1/");
    expect(url.pathname).toBe("/api/terminal/target");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      session: SESSION.sessionId,
      provider: "claude",
      cwd: "/home/someone/My Project/ünïcode & more",
    });
    expect(asked[0].method).toBe("GET");
  });

  it("POSTs open and adopt as JSON with exactly the session's three fields", async () => {
    for (const call of [openTerminal, adoptTerminal]) {
      const { fetchFn, asked } = answering(200, { ok: true, ticket: "tk", target: ATTACHABLE });
      await call({ ...SESSION, extra: "not sent" } as SessionRef, { fetchFn });
      expect(asked[0].method).toBe("POST");
      expect(asked[0].headers["content-type"]).toBe("application/json");
      expect(asked[0].body).toEqual({ sessionId: SESSION.sessionId, provider: "claude", cwd: SESSION.cwd });
    }
  });

  it("POSTs launch with the agent and the project", async () => {
    const { fetchFn, asked } = answering(200, { ok: true, sessionId: "", name: "ccdeck-codex-1a2b3c4d", ticket: "tk" });
    await launchTerminal({ agent: "codex", cwd: "/srv/app" }, { fetchFn });
    expect(asked[0]).toMatchObject({ url: "/api/terminal/launch", method: "POST", body: { agent: "codex", cwd: "/srv/app" } });
  });

  it("starts a launch or a reopen at the panel's size, with New session's options when there are any", async () => {
    const { fetchFn, asked } = answering(200, { ok: true, sessionId: "", name: "ccdeck-claude-1a2b3c4d", ticket: "tk" });
    await launchTerminal({ agent: "claude", cwd: "/srv/app", size: { cols: 132, rows: 41 }, launch: { model: "haiku", worktree: true } }, { fetchFn });
    expect(asked[0].body).toEqual({ agent: "claude", cwd: "/srv/app", cols: 132, rows: 41, options: { model: "haiku", worktree: true } });
    await launchTerminal({ agent: "claude", cwd: "/srv/app", launch: {} }, { fetchFn });
    expect(asked[1].body, "no options is no options key").toEqual({ agent: "claude", cwd: "/srv/app" });
    const adopt = answering(200, { ok: true, ticket: "tk", target: ATTACHABLE });
    await adoptTerminal(SESSION, { fetchFn: adopt.fetchFn }, { cols: 90, rows: 30 });
    expect(adopt.asked[0].body).toEqual({ sessionId: SESSION.sessionId, provider: "claude", cwd: SESSION.cwd, cols: 90, rows: 30 });
  });

  it("hands the panel's AbortSignal to fetch, so a switched-away panel can drop the request", async () => {
    const { fetchFn, asked } = answering(200, { ok: true, ticket: "tk", target: ATTACHABLE });
    const signal = new AbortController().signal;
    await openTerminal(SESSION, { fetchFn, signal });
    expect(asked[0].signal).toBe(signal);
  });
});

describe("reading the answers", () => {
  it("returns the status, tmux missing included, as a fact rather than a failure", async () => {
    const tmux = { ok: false, reason: "missing", install: "sudo apt install tmux" };
    const { fetchFn } = answering(200, { ok: true, platform: "linux", tmux });
    expect(await terminalStatus({ fetchFn })).toEqual({ ok: true, platform: "linux", tmux });
  });

  it("returns a ticket and its target when the session can be attached", async () => {
    const { fetchFn } = answering(200, { ok: true, ticket: "Zm9vYmFy", target: ATTACHABLE });
    expect(await openTerminal(SESSION, { fetchFn })).toEqual({ ok: true, ticket: "Zm9vYmFy", target: ATTACHABLE });
  });

  it("passes a 200 'not attachable' through with its target, distinct from any failure", async () => {
    const { fetchFn } = answering(200, { ok: false, target: STARTED_ELSEWHERE });
    const answer = await openTerminal(SESSION, { fetchFn });
    expect(answer).toEqual({ ok: false, target: STARTED_ELSEWHERE });
    expect("status" in answer, "a state to draw must not look like an HTTP failure").toBe(false);
  });

  it("reads adopt's 409 as the still-running refusal the panel has a sentence for", async () => {
    const { fetchFn } = answering(409, { ok: false, error: "still-running" });
    expect(await adoptTerminal(SESSION, { fetchFn })).toEqual({ ok: false, status: 409, error: STILL_RUNNING });
  });

  it("returns a launch's session id, which is empty for Codex until it has written a rollout", async () => {
    const claude = answering(200, { ok: true, sessionId: SESSION.sessionId, name: "ccdeck-claude-0b7c4e2a", ticket: "tk" });
    expect(await launchTerminal({ agent: "claude", cwd: "/srv" }, { fetchFn: claude.fetchFn }))
      .toEqual({ ok: true, sessionId: SESSION.sessionId, name: "ccdeck-claude-0b7c4e2a", ticket: "tk" });
    const codex = answering(200, { ok: true, name: "ccdeck-codex-1a2b3c4d", ticket: "tk" });
    expect(await launchTerminal({ agent: "codex", cwd: "/srv" }, { fetchFn: codex.fetchFn }))
      .toEqual({ ok: true, sessionId: "", name: "ccdeck-codex-1a2b3c4d", ticket: "tk" });
  });
});

describe("failures are values, never throws", () => {
  const ALL = [
    () => terminalStatus,
    () => (o: object) => terminalTarget(SESSION, o),
    () => (o: object) => openTerminal(SESSION, o),
    () => (o: object) => adoptTerminal(SESSION, o),
    () => (o: object) => launchTerminal({ agent: "claude", cwd: "/srv" }, o),
  ];

  it("reads the flag-off 404 on every route as 'not switched on', not as the router's 'not found'", async () => {
    // With the flag off every terminal route answers exactly as an /api path
    // with no route does — src/server/index.mjs sends `{ error: "not found" }`
    // — and that word is the router's, not a sentence for the panel.
    for (const make of ALL) {
      for (const body of [{ error: "not found" }, "Not Found", {}]) {
        const { fetchFn } = answering(404, body);
        expect(await make()({ fetchFn }), JSON.stringify(body))
          .toEqual({ ok: false, status: 404, error: "The terminal is not switched on for this deck." });
      }
    }
    const server = readFileSync(fileURLToPath(new URL("../../server/index.mjs", import.meta.url)), "utf8");
    expect(server, "the deck's unmatched-/api answer changed; terminal-api.ts reads it by its words")
      .toContain('send(res, 404, { error: "not found" })');
  });

  it("still passes along a 404 that comes with a sentence of the deck's own", async () => {
    const { fetchFn } = answering(404, { ok: false, error: "That session is not on this deck." });
    expect(await openTerminal(SESSION, { fetchFn })).toEqual({ ok: false, status: 404, error: "That session is not on this deck." });
  });

  it("reads a request-gate refusal as the deck refusing this page, not in the gate's own words", async () => {
    // The bodies src/server/index.mjs's gates send: diagnostics, not sentences.
    for (const [status, body] of [[401, { error: "unauthenticated" }], [403, { error: "cross-site request blocked" }], [403, {}]] as const) {
      const { fetchFn } = answering(status, body);
      expect(await openTerminal(SESSION, { fetchFn }), JSON.stringify(body))
        .toEqual({ ok: false, status, error: "The deck refused the request from this page." });
    }
  });

  it("carries the deck's own short reason when it gave one", async () => {
    const { fetchFn } = answering(400, { ok: false, error: "That folder does not exist." });
    expect(await launchTerminal({ agent: "claude", cwd: "/nope" }, { fetchFn }))
      .toEqual({ ok: false, status: 400, error: "That folder does not exist." });
  });

  it("adds what to do about a tmux failure when the deck names it", async () => {
    const { fetchFn } = answering(500, { ok: false, error: "tmux could not start the session.", code: "tmux-failed", hint: "The path to tmux's socket is too long here." });
    expect(await launchTerminal({ agent: "claude", cwd: "/srv" }, { fetchFn }))
      .toEqual({ ok: false, status: 500, error: "tmux could not start the session. The path to tmux's socket is too long here." });
  });

  it("says the deck did not answer when the fetch itself fails, on every route", async () => {
    for (const make of ALL) {
      const fetchFn = async () => { throw new TypeError("Failed to fetch"); };
      expect(await make()({ fetchFn })).toEqual({ ok: false, status: null, error: "The deck did not answer." });
    }
  });

  it("says the request was cancelled, not that the deck is down, when the panel aborted it", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchFn = async () => { throw new DOMException("The operation was aborted.", "AbortError"); };
    expect(await openTerminal(SESSION, { fetchFn, signal: controller.signal }))
      .toEqual({ ok: false, status: null, error: "The request was cancelled." });
  });

  it("never mistakes a 200 it cannot read for a ticket", async () => {
    const bodies: unknown[] = [
      "<!doctype html>",                                   // the SPA shell, if a route ever fell through to it
      { ok: true, target: ATTACHABLE },                    // no ticket
      { ok: true, ticket: "", target: ATTACHABLE },        // an empty one
      { ok: true, ticket: 42, target: ATTACHABLE },        // not a string
      { ok: true, ticket: "tk" },                          // no target
      { ok: true, ticket: "tk", target: { kind: "A" } },   // a target with no sentence
      { ok: "yes", ticket: "tk", target: ATTACHABLE },     // ok that is not a boolean
    ];
    for (const body of bodies) {
      const { fetchFn } = answering(200, body);
      const answer = await openTerminal(SESSION, { fetchFn });
      expect(answer.ok, JSON.stringify(body)).toBe(false);
      expect(answer, JSON.stringify(body)).toEqual({ ok: false, status: 200, error: "The deck answered in a form this page cannot read." });
    }
  });

  it("does not hand over a launch with no ticket or no session name", async () => {
    for (const body of [{ ok: true, name: "ccdeck-claude-x" }, { ok: true, ticket: "tk" }, { ok: true, ticket: "tk", name: "" }]) {
      const { fetchFn } = answering(200, body);
      expect((await launchTerminal({ agent: "claude", cwd: "/srv" }, { fetchFn })).ok, JSON.stringify(body)).toBe(false);
    }
  });

  it("does not take a status without a tmux verdict", async () => {
    const { fetchFn } = answering(200, { ok: true, platform: "linux" });
    expect((await terminalStatus({ fetchFn })).ok).toBe(false);
  });
});

describe("the module's footprint", () => {
  it("imports nothing, and in particular nothing from xterm", () => {
    const src = withoutComments(readFileSync(fileURLToPath(new URL("../terminal-api.ts", import.meta.url)), "utf8"));
    expect(src).not.toMatch(/^\s*import\b/m);
    expect(src).not.toMatch(/\bimport\(/);
  });
});
