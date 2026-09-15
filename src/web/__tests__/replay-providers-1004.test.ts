// #1004: live capture is gated on the provider and the boot replay was not, so
// a `--no-codex` deck redrew every Codex session in the log on every restart.
//
// `if (codex) startCodexWatcher(workspace)` is the live half, and the Claude
// hook is installed only when `_providers.claude`. `_providers` reached exactly
// two places — the health payload and that hook install — and nothing on the
// replay path, whose whole signature had one scope parameter:
//
//     export async function replayLog(filePath, workspace = "", { maxEvents, maxChars } = {})
//
// Reproduced on Linux / Node 24, sandboxed HOME, port 4445, over a log of two
// Claude lines and two Codex lines, booted with `codex: false`:
//
//     ring stats: {"events":4,"chars":1037,"oldestSeq":1,"newestSeq":4}
//     in the ring: [ 'claude:claude-1:SessionStart', 'claude:claude-1:PreToolUse',
//                    'codex:codex-1:SessionStart',  'codex:codex-1:PreToolUse' ]
//
// WHAT THE USER SAW. Somebody has been running both CLIs, then starts the deck
// with `--no-codex` — or Codex is uninstalled and `hasCodexInstalled()` goes
// false. The banner prints
//
//     Codex sessions   skipped — no ~/.codex/, or --no-codex
//
// and the canvas then fills with Codex sessions out of events.jsonl that will
// never receive another event: frozen mid-turn, and no live path can ever close
// them, because the watcher that would have is the one that was skipped. The
// mirror case is worse — a `--no-claude` deck replays Claude sessions while
// `providers.claude` is false, so App.tsx hides the accounts panel and the sound
// controls, leaving sessions on screen the deck has deliberately removed the
// controls for.
//
// This is #696 one field over, and it is fixed the same way: the test folds into
// `replayScope`'s predicate rather than becoming a second notion of scope, so
// the replay rule stays pinned equal to the live rule. It costs one comparison
// per line, because `provider: "codex"` is already stamped on every payload the
// Codex watcher emits and the Claude side is the complement — which is what
// types.ts already says the field means.
//
// TWO THINGS A NAIVE VERSION GETS WRONG, and this file exists as much for them:
//
//   * `__clear` carries no provider, so the complement reads it as Claude and a
//     `--no-claude` deck would drop it — replaying a canvas the user had
//     explicitly cleared. It is admitted whatever the providers say, exactly as
//     it is admitted whatever the workspace says.
//   * A provider-scoped but workspace-unscoped deck must stay order-INDEPENDENT.
//     `orderDependent` is what makes replayLog read the log from its end and
//     stop at the ring's edge (#742); setting it here would put every
//     `--no-codex` boot back on a full forward parse of a file that reaches
//     50 MB before rotation, for a predicate that needs no memory at all.
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
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-replay-providers-1004-"));
const prevEnv = { ...process.env };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.XDG_CONFIG_HOME = join(DIR, "config");
for (const p of [process.env.HOME, process.env.USERPROFILE, process.env.CLAUDE_CONFIG_DIR, process.env.CODEX_HOME]) {
  if (!resolve(p!).startsWith(resolve(DIR))) throw new Error(`sandbox escaped: ${p}`);
}

type Providers = { claude?: boolean; codex?: boolean };
type Admits = ((payload: unknown) => boolean) & { orderDependent: boolean };

// @ts-expect-error — plain .mjs server module, no types
const mod = await import("../../server/index.mjs");
const replayScope = mod.replayScope as (
  workspace: string, platform?: NodeJS.Platform, providers?: Providers | null,
) => Admits;
const startServer = mod.startServer as (o: unknown) => Promise<Server>;
const eventsSince = mod.eventsSince as (seq: number) => HookEnvelope[];

afterAll(() => {
  for (const k of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME"]) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  rmTempDir(DIR);
});

// ── 1. the predicate ────────────────────────────────────────────────────────

const claudeLine = { hook_event_name: "PreToolUse", session_id: "c1", cwd: "/srv/proj", tool_name: "Bash" };
const codexLine = { hook_event_name: "PreToolUse", session_id: "x1", cwd: "/srv/proj", provider: "codex", tool_name: "shell" };

describe("a deck watching both CLIs replays both, as it always did", () => {
  it("admits every payload and stays order-independent", () => {
    for (const providers of [undefined, null, {}, { claude: true, codex: true }]) {
      const admits = replayScope("", undefined, providers as Providers);
      expect(admits(claudeLine), JSON.stringify(providers)).toBe(true);
      expect(admits(codexLine), JSON.stringify(providers)).toBe(true);
      // The backwards read, which is what keeps a boot's cost a property of the
      // ring rather than of how long the user has been running the deck.
      expect(admits.orderDependent).toBe(false);
    }
  });
});

describe("a deck told to skip one CLI replays the other and no more", () => {
  it("drops Codex on a --no-codex deck", () => {
    const admits = replayScope("", undefined, { claude: true, codex: false });
    expect(admits(claudeLine)).toBe(true);
    expect(admits(codexLine)).toBe(false);
  });

  it("drops Claude on a --no-claude deck", () => {
    const admits = replayScope("", undefined, { claude: false, codex: true });
    expect(admits(claudeLine)).toBe(false);
    expect(admits(codexLine)).toBe(true);
  });

  it("reads a payload with no provider as Claude, which is what the field means", () => {
    // types.ts: the field is set on the first event and "defaults to claude for
    // back-compat with replay events written before multi-provider support".
    // Every line in a log older than that carries no provider at all, and every
    // one of them is a Claude line.
    const noCodex = replayScope("", undefined, { claude: true, codex: false });
    const noClaude = replayScope("", undefined, { claude: false, codex: true });
    const old = { hook_event_name: "SessionStart", session_id: "legacy", cwd: "/srv/proj" };
    expect(noCodex(old)).toBe(true);
    expect(noClaude(old)).toBe(false);
  });

  it("keeps the Codex enrichment with its session, because it carries the field too", () => {
    // ModelObserved / UsageObserved / ContextObserved for a Codex session are
    // emitted by emitCodexEvent, which stamps `provider: "codex"` on the base
    // payload. That is why this needs no per-session memory: the cwd-less
    // enrichment answers the provider question on its own.
    const admits = replayScope("", undefined, { claude: true, codex: false });
    for (const name of ["ModelObserved", "UsageObserved", "ContextObserved", "SessionNamed"]) {
      expect(admits({ hook_event_name: name, session_id: "x1", provider: "codex" }), name).toBe(false);
      expect(admits({ hook_event_name: name, session_id: "c1" }), name).toBe(true);
    }
  });

  it("keeps __clear whichever provider is off, so a boot never resurrects a cleared canvas", () => {
    // The marker `/api/clear` appends after truncating. It carries no provider,
    // so the complement reads it as Claude — and a `--no-claude` deck dropping
    // it would replay the state a user had explicitly cleared.
    for (const providers of [{ claude: false, codex: true }, { claude: true, codex: false }]) {
      expect(replayScope("", undefined, providers)({ hook_event_name: "__clear", cwd: "" })).toBe(true);
    }
  });

  it("stays order-independent, so the backwards read survives (#742)", () => {
    // A provider test needs no memory of what came before. Only `--workspace`
    // does, because its cwd-less events are decided by an earlier line.
    expect(replayScope("", undefined, { claude: true, codex: false }).orderDependent).toBe(false);
    expect(replayScope("", undefined, { claude: false, codex: true }).orderDependent).toBe(false);
    expect(replayScope("/srv/proj", "linux", { claude: true, codex: false }).orderDependent).toBe(true);
  });

  it("applies both scopes at once when a deck has both", () => {
    const admits = replayScope("/srv/proj", "linux", { claude: true, codex: false });
    expect(admits({ hook_event_name: "SessionStart", session_id: "in", cwd: "/srv/proj/a" })).toBe(true);
    expect(admits({ hook_event_name: "SessionStart", session_id: "out", cwd: "/elsewhere" })).toBe(false);
    expect(admits({ hook_event_name: "SessionStart", session_id: "cx", cwd: "/srv/proj/a", provider: "codex" })).toBe(false);
    // And the workspace half still carries a session's answer forward to the
    // events that do not say where they run.
    expect(admits({ hook_event_name: "ModelObserved", session_id: "in" })).toBe(true);
    expect(admits({ hook_event_name: "ModelObserved", session_id: "out" })).toBe(false);
  });
});

// ── 2. the canvas, after a real boot over a real log ────────────────────────

const LOG = join(DIR, "events.jsonl");

let seq = 0;
const envelope = (payload: Partial<HookPayload>) => JSON.stringify({
  seq: ++seq,
  epoch: 1,
  receivedAt: 1_700_000_000_000 + seq,
  source: "hook",
  payload,
});

/** The reporter's log: somebody who has been running both CLIs. */
function seedLog() {
  writeFileSync(LOG, [
    envelope({ hook_event_name: "SessionStart", session_id: "claude-1", cwd: DIR }),
    envelope({ hook_event_name: "PreToolUse", session_id: "claude-1", cwd: DIR, tool_name: "Bash", tool_use_id: "t1" }),
    envelope({ hook_event_name: "SessionStart", session_id: "codex-1", cwd: DIR, provider: "codex" } as Partial<HookPayload>),
    envelope({ hook_event_name: "PreToolUse", session_id: "codex-1", cwd: DIR, provider: "codex", tool_name: "shell", tool_use_id: "t2" } as Partial<HookPayload>),
  ].join("\n") + "\n");
}

function canvasOf(envelopes: HookEnvelope[]): GraphState {
  let state = initialState();
  for (const e of envelopes) state = applyEvent(state, e);
  return state;
}

let server: Server | null = null;

beforeAll(() => { seedLog(); });
afterAll(async () => {
  if (server) await new Promise<void>(r => { server!.closeAllConnections?.(); server!.close(() => r()); });
});

describe("a --no-codex deck's canvas at boot", () => {
  it("holds the Claude sessions and none of the Codex ones", async () => {
    // Port 0 so this cannot collide with a deck already up on this machine.
    server = await startServer({
      port: 0, host: "127.0.0.1", persist: LOG, workspace: "", codex: false, claude: true,
    });

    const replayed = eventsSince(0);
    const drawn = replayed.map(e => {
      const p = e.payload as HookPayload & { provider?: string };
      return `${p.provider ?? "claude"}:${p.session_id}:${p.hook_event_name}`;
    });
    // The reporter's exact complaint, in the reporter's exact spelling.
    expect(drawn).toEqual(["claude:claude-1:SessionStart", "claude:claude-1:PreToolUse"]);

    // And on the canvas, which is where the frozen cards were.
    const canvas = canvasOf(replayed);
    expect([...canvas.agents.keys()].sort()).toEqual(["claude-1"]);
  }, 25_000);
});
