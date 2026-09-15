// What #993 found exported, maintained or documented for nobody, pinned so it
// does not come back.
//
// Each case asserts both halves, the way export-surface-383.test.ts and
// dead-surface-798.test.ts do theirs: the change, and the thing the change must
// not have taken with it.
//
// Nine symbols were exported with no reader outside their own file. Each keeps
// its declaration and its in-file reader; only the `export` went. Dropping the
// keyword and dropping the declaration look identical in a diff read too
// quickly, and the second one silently removes a branch.
//
// And `toolOwner`, a reducer map written at every site `toolIndex` was and read
// by nothing — its one `get` was the map asking whether to delete its own
// entry. The agent a call belongs to is the call's own `agentId`, which is what
// `blockedCall` reads.
//
// Plain node: source text, module namespaces and one reducer run.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { applyEvent, initialState, toolKey, type GraphState } from "../reducer";
import type { HookPayload } from "../types";

const SERVER = fileURLToPath(new URL("../../server/", import.meta.url));
const WEB = fileURLToPath(new URL("../", import.meta.url));
const src = (root: string, file: string) => readFileSync(join(root, file), "utf8");

// file, symbol, the declaration that must survive, and the in-file read that
// still needs it.
const UNEXPORTED: [dir: string, file: string, symbol: string, declaration: RegExp, reader: RegExp][] = [
  [SERVER, "deck-home.mjs",         "HOME_ENV",            /^const HOME_ENV = "CCDECK_HOME";$/m,     /env\[HOME_ENV\]/],
  [SERVER, "static-cache.mjs",      "COMPRESSIBLE",        /^const COMPRESSIBLE = new Set\(/m,       /COMPRESSIBLE\.has\(ext\)/],
  [SERVER, "stop-deck.mjs",         "STOP_ASK_MS",         /^const STOP_ASK_MS = 2000;$/m,           /timeoutMs = STOP_ASK_MS/],
  [SERVER, "stop-deck.mjs",         "STOP_GONE_MS",        /^const STOP_GONE_MS = 3000;$/m,          /goneMs = STOP_GONE_MS/],
  [SERVER, "supervisor.mjs",        "CRASH_BACKOFF_MS",    /^const CRASH_BACKOFF_MS = 1000;$/m,      /backoffMs = CRASH_BACKOFF_MS/],
  [SERVER, "index.mjs",             "awayUpdateTick",      /^async function awayUpdateTick\(\) \{$/m, /setInterval\(\(\) => \{ awayUpdateTick\(\)/],
  [WEB,    "panel-exit.ts",         "nextPhase",           /^function nextPhase\(open: boolean, phase: PanelPhase\): PanelPhase \{$/m, /nextPhase\(open, p\)/],
  [WEB,    "spend-rate.ts",         "SPEND_MIN_SPAN_MS",   /^const SPEND_MIN_SPAN_MS = 60_000;$/m,   /spanMs < SPEND_MIN_SPAN_MS/],
  [WEB,    "usage-from-ccusage.ts", "sessionIdFromPeriod", /^function sessionIdFromPeriod\(period: string\): string \{$/m, /= sessionIdFromPeriod\(period\)/],
];

describe("the in-file-only exports #993 took off their modules' public surface", () => {
  for (const [dir, file, symbol, declaration, reader] of UNEXPORTED) {
    it(`${file} no longer exports ${symbol}, and still declares and reads it`, async () => {
      const text = src(dir, file);
      expect(text, `${symbol}'s declaration is gone from ${file}`).toMatch(declaration);
      expect(text, `${file} stopped reading ${symbol} where it did`).toMatch(reader);
      expect(text, `${file} exports ${symbol} inline`)
        .not.toMatch(new RegExp(`^export (?:const|let|var|function|async function|class) ${symbol}\\b`, "m"));
      for (const list of text.matchAll(/^export \{([^}]*)\}/gm)) {
        expect(list[1].split(",").map(s => s.trim()), `${file} exports ${symbol} in a list`).not.toContain(symbol);
      }
      // The live namespace agrees. index.mjs is left to the text above: other
      // suites already evaluate it, and a second copy here would prove nothing
      // the two patterns do not.
      if (file !== "index.mjs") {
        expect(Object.keys(await import(/* @vite-ignore */ join(dir, file)))).not.toContain(symbol);
      }
    });
  }
});

describe("toolOwner — a map the reducer wrote and nothing read", () => {
  it("is gone from the state and from the reducer", () => {
    expect(Object.keys(initialState())).not.toContain("toolOwner");
    expect(src(WEB, "reducer.ts")).not.toMatch(/\btoolOwner\b/);
  });

  it("and the attribution it claimed to carry is on the call itself", () => {
    let seq = 0;
    const send = (state: GraphState, payload: HookPayload) =>
      applyEvent(state, { seq: ++seq, receivedAt: 1_700_000_000_000 + seq, source: "hook", payload });
    let state = initialState();
    state = send(state, { hook_event_name: "SessionStart", session_id: "s", cwd: "/repo" });
    state = send(state, { hook_event_name: "SubagentStart", session_id: "s", agent_id: "k1", agent_type: "worker" });
    state = send(state, {
      hook_event_name: "PreToolUse", session_id: "s", agent_id: "k1",
      tool_name: "Read", tool_use_id: "c1", tool_input: { file_path: "/repo/x.ts" },
    });
    expect(state.toolIndex.get(toolKey("s", "c1"))?.agentId).toBe("s::k1");
  });
});

describe("HookEnvelope.replay — documented as read by the one module that never reads it", () => {
  it("is not read by the reducer, and its doc no longer says it is", () => {
    // Someone taking the old sentence at its word would add a `replay` branch
    // to applyEvent and bring back the flash-then-vanish that keying on event
    // time fixed.
    expect(src(WEB, "reducer.ts")).not.toMatch(/\.replay\b/);
    expect(src(WEB, "types.ts")).not.toContain("The reducer uses this to suppress turn-cleanup logic");
  });
});
