// #696: a `--workspace` deck replayed the machine-wide log at boot, so it came
// up showing the sessions it had just promised not to capture.
//
// `--workspace` filtered the two LIVE capture paths — the hook, via
// `capturesSession`, and the Codex watcher, via `codexCwdInWorkspace` — and
// nothing else. `startServer` replayed the whole of `events.jsonl` into the ring
// before the listener opened, with no predicate of any kind, and that file is
// the machine-wide `<claude config dir>/agent-dag/events.jsonl` that every deck
// on the box shares by default.
//
// Reproduced on macOS 15 / Node 22.14, sandboxed HOME, with a log holding one
// session in each of three trees:
//
//     seeded log
//       final-tree1     <- …/696-697-sandbox/tree1
//       final-tree2     <- …/696-697-sandbox/tree2
//       final-elsewhere <- /Users/constantin/Desktop/agents-deck
//
//     $ node bin/deck.js --no-codex --no-open --port 4474 --workspace …/tree1
//       ✓  workspace       …/696-697-sandbox/tree1
//
//     GET /api/events on the SCOPED deck
//       final-tree1     <- …/696-697-sandbox/tree1
//       final-tree2     <- …/696-697-sandbox/tree2
//       final-elsewhere <- /Users/constantin/Desktop/agents-deck
//
// The promise is made in three places and was broken in all three: the `--help`
// line ("Only capture sessions whose cwd is inside <path>"), README.md
// ("`--workspace` is a filter this deck applies to itself"), and the empty-state
// sentence in src/web/scope.ts — the one piece of copy written specifically so
// the empty state would stop asserting things that are not true (#404). The
// canvas is where the user reads the answer, and on every boot it disagreed with
// all three.
//
// THE FIX APPLIES THE RULE THAT ALREADY EXISTED rather than inventing a second
// one. Per event the predicate is `codexCwdInWorkspace`, the twin of the hook's
// `capturesSession`, pinned equal to it by workspace-one-meaning.test.ts — so
// case folding, separators and the sibling-prefix trap are decided in one place,
// per platform, for every path a payload can reach the ring by.
//
// TWO THINGS THE NAIVE VERSION OF THIS FIX GETS WRONG, and this file exists as
// much for them as for the headline:
//
//   * `__clear` carries `cwd: ""`. It is the marker `/api/clear` writes after
//     truncating the log, and it is the instruction that makes the reducer
//     forget everything before it. Dropped on a scoped deck, a boot would replay
//     a canvas the user had explicitly cleared.
//   * The synthetic enrichment events — `ModelObserved`, `UsageObserved`,
//     `SessionNamed`, `ContextObserved` — carry `session_id` and NO cwd, and
//     they are persisted like anything else. Judged by the live rule alone they
//     are inside no workspace, so a scoped deck would draw an in-scope session
//     stripped of its model, its token columns and its name. They follow their
//     session instead, which is what they already do live: a deck only ever
//     emits one for a session whose hook event it accepted.
//
// The suite has no DOM. Group 1 is the predicate, pure, driven per platform so
// the Windows answers are asserted from a Mac. Group 2 boots a real server over
// a real log in a temp directory and then drives what comes back through the
// real reducer — the canvas, which is where the bug was visible.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Server } from "node:http";

import { applyEvent, initialState, type GraphState } from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";

// Sandboxed before the server module is imported: it resolves its config
// directories at import time, and the real ~/.claude must stay untouched.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-replay-scope-696-"));
const prevEnv = { ...process.env };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.XDG_CONFIG_HOME = join(DIR, "config");
for (const p of [process.env.HOME, process.env.USERPROFILE, process.env.CLAUDE_CONFIG_DIR, process.env.CODEX_HOME]) {
  if (!resolve(p!).startsWith(resolve(DIR))) throw new Error(`sandbox escaped: ${p}`);
}

// @ts-expect-error — plain .mjs server module, no types
const mod = await import("../../server/index.mjs");
const replayScope = mod.replayScope as (
  workspace: string, platform?: NodeJS.Platform,
) => (payload: unknown) => boolean;
const startServer = mod.startServer as (o: unknown) => Promise<Server>;
const eventsSince = mod.eventsSince as (seq: number) => HookEnvelope[];
const codexCwdInWorkspace = (await import("../../server/log-writer.mjs"))
  .codexCwdInWorkspace as (cwd: string, ws: string, platform?: NodeJS.Platform) => boolean;

afterAll(() => {
  for (const k of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME"]) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  rmTempDir(DIR);
});

// ── 1. the predicate ────────────────────────────────────────────────────────

describe("an unscoped deck replays everything, as it always did", () => {
  it("admits every payload, cwd or no cwd", () => {
    const admits = replayScope("");
    for (const p of [
      { session_id: "a", cwd: "/srv/proj" },
      { session_id: "b", cwd: "/anywhere/else" },
      { session_id: "c" },
      { hook_event_name: "__clear", cwd: "" },
      {},
    ]) {
      expect(admits(p), JSON.stringify(p)).toBe(true);
    }
  });

  it("treats a missing or non-string workspace as unscoped", () => {
    for (const ws of [undefined, null, 0, {}]) {
      expect(replayScope(ws as never)({ cwd: "/anywhere" })).toBe(true);
    }
  });
});

describe("a scoped deck replays its own tree and no other", () => {
  const POSIX = "linux" as NodeJS.Platform;
  const WIN = "win32" as NodeJS.Platform;

  // cwd, workspace, platform, admitted. The interesting rows are the last
  // three: the sibling-prefix trap that a `startsWith` without a separator
  // falls into, and the two platforms' opposite answers on case.
  const CASES: [cwd: string, ws: string, platform: NodeJS.Platform, admitted: boolean][] = [
    ["/srv/proj", "/srv/proj", POSIX, true],
    ["/srv/proj/sub/deep", "/srv/proj", POSIX, true],
    ["/srv/other", "/srv/proj", POSIX, false],
    ["/srv", "/srv/proj", POSIX, false],
    ["/srv/projX", "/srv/proj", POSIX, false],
    ["/srv/Proj/a", "/srv/proj", POSIX, false],
    ["C:\\Users\\u\\proj", "C:\\Users\\u\\proj", WIN, true],
    ["C:\\Users\\u\\proj\\sub", "C:\\Users\\u\\proj", WIN, true],
    ["C:\\Users\\u\\projX", "C:\\Users\\u\\proj", WIN, false],
    ["C:\\Users\\U\\PROJ\\sub", "C:\\Users\\u\\proj", WIN, true],
    ["D:\\proj", "C:\\proj", WIN, false],
  ];

  for (const [cwd, ws, platform, admitted] of CASES) {
    it(`${platform}: ${cwd} in ${ws} → ${admitted}`, () => {
      expect(replayScope(ws, platform)({ session_id: "s", cwd })).toBe(admitted);
    });

    it(`${platform}: ${cwd} in ${ws} agrees with the live rule`, () => {
      // The point of the fix: one rule, not two. If these ever disagree,
      // `--workspace` means one thing live and another at boot.
      expect(replayScope(ws, platform)({ session_id: "s", cwd }))
        .toBe(codexCwdInWorkspace(cwd, ws, platform));
    });
  }
});

describe("the events that carry no cwd", () => {
  it("keeps __clear, so a boot never replays a canvas the user cleared", () => {
    // `/api/clear` truncates the log and then appends this. It is the only
    // payload in the file that is an instruction rather than an observation.
    const admits = replayScope("/srv/proj");
    expect(admits({ hook_event_name: "__clear", cwd: "" })).toBe(true);
  });

  it("lets an enrichment event follow the session it belongs to", () => {
    // ModelObserved / UsageObserved / SessionNamed / ContextObserved carry
    // session_id and nothing else. In scope, they must arrive; out of scope,
    // they must not.
    const admits = replayScope("/srv/proj");
    expect(admits({ hook_event_name: "SessionStart", session_id: "in", cwd: "/srv/proj/a" })).toBe(true);
    expect(admits({ hook_event_name: "SessionStart", session_id: "out", cwd: "/elsewhere" })).toBe(false);
    for (const name of ["ModelObserved", "UsageObserved", "SessionNamed", "ContextObserved"]) {
      expect(admits({ hook_event_name: name, session_id: "in" }), name).toBe(true);
      expect(admits({ hook_event_name: name, session_id: "out" }), name).toBe(false);
    }
  });

  it("refuses one whose session it has never been told about", () => {
    // The live rule, stated the same way: a session that never said where it
    // runs is inside no workspace, so only an unscoped deck takes it.
    const admits = replayScope("/srv/proj");
    expect(admits({ hook_event_name: "ModelObserved", session_id: "stranger" })).toBe(false);
    expect(admits({ hook_event_name: "ModelObserved" })).toBe(false);
    expect(admits(null)).toBe(false);
    expect(admits("not an object")).toBe(false);
  });

  it("re-decides when a session's own cwd arrives later", () => {
    // A log can hold a session's enrichment before its first cwd-bearing event
    // — the deck was restarted mid-session, or the log was rotated. Once the
    // cwd is known, the answer is the cwd's.
    const admits = replayScope("/srv/proj");
    expect(admits({ hook_event_name: "ModelObserved", session_id: "s" })).toBe(false);
    expect(admits({ hook_event_name: "PostToolUse", session_id: "s", cwd: "/srv/proj/x" })).toBe(true);
    expect(admits({ hook_event_name: "UsageObserved", session_id: "s" })).toBe(true);
  });
});

// ── 2. the canvas, after a real boot over a real log ────────────────────────

const TREE1 = join(DIR, "tree1");
const TREE2 = join(DIR, "tree2");
const ELSEWHERE = join(DIR, "elsewhere");
const LOG = join(DIR, "events.jsonl");

/** One envelope, in exactly the shape the writer appends. */
let seq = 0;
const envelope = (payload: Partial<HookPayload>) => JSON.stringify({
  seq: ++seq,
  epoch: 1,
  receivedAt: 1_700_000_000_000 + seq,
  source: "hook",
  payload,
});

/**
 * The reporter's log, plus the two cases the naive fix loses.
 *
 * One session in each of three trees, each with a cwd-bearing start and a
 * cwd-less enrichment event, so a filter that drops everything without a cwd
 * fails as loudly as one that drops nothing.
 *
 * It opens with a session and a `__clear`, in that order, because that is what
 * a log looks like after somebody pressed Clear: the truncate empties the file
 * and the marker is appended to it, but another deck sharing the log can have
 * appended before the truncate landed, and a rotated log can begin anywhere. A
 * replay that drops the marker draws `pre-clear` — a session the user watched
 * disappear — back onto the canvas.
 */
function seedLog() {
  writeFileSync(LOG, [
    envelope({ hook_event_name: "SessionStart", session_id: "pre-clear", cwd: join(TREE1, "old") }),
    envelope({ hook_event_name: "__clear", cwd: "" }),
    envelope({ hook_event_name: "SessionStart", session_id: "final-tree1", cwd: TREE1 }),
    envelope({ hook_event_name: "SessionStart", session_id: "final-tree2", cwd: TREE2 }),
    envelope({ hook_event_name: "SessionStart", session_id: "final-elsewhere", cwd: ELSEWHERE }),
    envelope({ hook_event_name: "ModelObserved", session_id: "final-tree1", model: "claude-opus-5" } as Partial<HookPayload>),
    envelope({ hook_event_name: "ModelObserved", session_id: "final-tree2", model: "claude-opus-5" } as Partial<HookPayload>),
    envelope({ hook_event_name: "UsageObserved", session_id: "final-tree1", usage: { input_tokens: 1000, output_tokens: 100 } } as Partial<HookPayload>),
    envelope({ hook_event_name: "UsageObserved", session_id: "final-tree2", usage: { input_tokens: 2000, output_tokens: 200 } } as Partial<HookPayload>),
    // A nested session, to prove the scope is a tree and not an exact match.
    envelope({ hook_event_name: "SessionStart", session_id: "final-nested", cwd: join(TREE1, "packages", "web") }),
    // The sibling-prefix trap, spelled out in a real path.
    envelope({ hook_event_name: "SessionStart", session_id: "final-sibling", cwd: `${TREE1}-scratch` }),
  ].join("\n") + "\n");
}

/** The canvas the deck would draw from what it replayed. */
function canvasOf(envelopes: HookEnvelope[]): GraphState {
  let state = initialState();
  for (const e of envelopes) state = applyEvent(state, e);
  return state;
}

let server: Server | null = null;

beforeAll(() => { seedLog(); });
afterAll(async () => {
  if (server) await new Promise<void>(r => server!.close(() => r()));
});

describe("a scoped deck's canvas at boot", () => {
  it("holds the sessions under its workspace and no others", async () => {
    // Port 0 so this cannot collide with a deck already up on this machine.
    // `claude: false, codex: false` so nothing is installed and no watcher runs
    // — the replay is the only thing under test.
    server = await startServer({
      port: 0, host: "127.0.0.1", persist: LOG, workspace: TREE1, codex: false, claude: false,
    });

    const replayed = eventsSince(0);
    const cwds = replayed.map(e => (e.payload as HookPayload).cwd).filter(Boolean);
    // The reporter's exact complaint: tree2 was on the scoped deck's canvas.
    expect(cwds).not.toContain(TREE2);
    expect(cwds).not.toContain(ELSEWHERE);
    expect(cwds).not.toContain(`${TREE1}-scratch`);
    expect(cwds).toContain(TREE1);

    const canvas = canvasOf(replayed);
    // Root agent ids are session ids, so this IS the list of sessions drawn.
    // `pre-clear` is in scope and is still absent, because the `__clear` after
    // it survived the filter: a scoped replay must not resurrect a canvas the
    // user cleared.
    expect([...canvas.agents.keys()].sort()).toEqual(["final-nested", "final-tree1"]);
    expect(replayed.some(e => (e.payload as HookPayload).hook_event_name === "__clear"))
      .toBe(true);

    // And the in-scope session kept everything the cwd-less events carry. A
    // filter that judged those by cwd alone would leave this card on the canvas
    // with no model and no tokens.
    const tree1 = canvas.agents.get("final-tree1")!;
    expect(tree1.cwd).toBe(TREE1);
    expect(tree1.model).toBe("claude-opus-5");
    expect(tree1.usage.inputTokens).toBe(1000);
    expect(tree1.usage.outputTokens).toBe(100);
  }, 25_000);

  it("agrees with the sentence the empty state would have shown", async () => {
    // src/web/scope.ts promises "This deck only captures sessions running under
    // <path>". That sentence is derived from the same `workspace` the replay is
    // now filtered by, so the canvas and the copy cannot disagree — which is the
    // whole of what #696 was.
    const { emptyScope } = await import("../scope");
    const said = emptyScope(TREE1);
    expect(said.kind).toBe("scoped");
    expect(said.workspace).toBe(TREE1);
    const canvas = canvasOf(eventsSince(0));
    for (const a of canvas.agents.values()) {
      expect(replayScope(said.workspace!)({ session_id: a.sessionId, cwd: a.cwd })).toBe(true);
    }
  });
});
