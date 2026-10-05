// An event too large for the deck still reaches it, without the bulk.
//
// The deck refuses an ingest body over its character cap with 413, and every
// deck has the same cap, so the hook's hand-on to the next one is refused too.
// Claude Code's PostToolUse for an Edit carries the whole file it edited in
// `tool_response.originalFile`, so editing a file of a few megabytes produced
// an event no deck would take: the outcome reached no canvas and no log, and
// at the turn's end the board settled the call as failed — a red dot and an
// error count on an edit that succeeded.
//
// Run against the server's real ingest handler, so the cap here is the one a
// deck enforces rather than a number this file restates.
import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";
import { endStdin } from "./child-stdin";
import { applyEvent, initialState } from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-hook-oversized-"));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.XDG_CONFIG_HOME = join(DIR, "config");
if (!resolve(process.env.CLAUDE_CONFIG_DIR).startsWith(resolve(DIR))) throw new Error("sandbox escaped");

// @ts-expect-error — plain .mjs server module, no types
const mod = await import("../../server/index.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { handleEventIngest } = await import("../../server/event-routes.mjs");
const eventsSince = mod.eventsSince as (seq: number) => HookEnvelope[];

// hook.js is CommonJS inside a "type": "module" package, so it only loads as
// itself from a .cjs copy outside the tree — the same copy hook-read-only makes.
const HOOK = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "hook", "hook.js");
const COPY = join(DIR, "hook.cjs");
copyFileSync(HOOK, COPY);
const { challengeProof, normPath } = createRequire(import.meta.url)(COPY) as {
  challengeProof: (token: string, nonce: string) => string;
  normPath: (p: string) => string;
};
// The cwd the hook posts is the canonical spelling it decided capture on —
// /private/var on macOS, the long name on Windows — so that is what comes back.
const CWD = normPath(DIR);

afterAll(() => rmTempDir(DIR));

/** A deck whose ingest is the server's own, behind a handshake this file
 *  answers with its own token. Returns its port and a way to close it. */
async function deck(token: string): Promise<{ port: number; statuses: number[]; close: () => Promise<void> }> {
  const statuses: number[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/hook-challenge") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ proof: challengeProof(token, url.searchParams.get("nonce") ?? "") }));
    }
    res.on("finish", () => statuses.push(res.statusCode));
    handleEventIngest(req, res, url.searchParams.get("persist") !== "0");
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    statuses,
    close: () => new Promise<void>(done => { server.closeAllConnections?.(); server.close(() => done()); }),
  };
}

async function runHook(input: string, record: Record<string, unknown>): Promise<number | null> {
  const home = mkdtempSync(join(DIR, "home-"));
  mkdirSync(join(home, "agent-dag"), { recursive: true });
  writeFileSync(join(home, "agent-dag", `${process.pid}.json`), JSON.stringify(record), "utf8");
  const child = spawn(process.execPath, [COPY, "--provider", "claude"], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: home, HOME: home, USERPROFILE: home },
    stdio: ["pipe", "ignore", "ignore"],
  });
  endStdin(child, input);
  return new Promise((done, fail) => { child.on("error", fail); child.on("exit", c => done(c)); });
}

describe("a hook event over the deck's size cap", () => {
  it("is delivered with its identity and outcome, and the bulk left out", async () => {
    const token = randomBytes(16).toString("hex");
    const d = await deck(token);
    const SID = "sess-big-edit";
    const file = join(DIR, "fixture.json");
    const original = "x".repeat(6_000_000);
    const post: HookPayload = {
      hook_event_name: "PostToolUse", session_id: SID, cwd: DIR, transcript_path: join(DIR, "nope.jsonl"),
      tool_name: "Edit", tool_use_id: "toolu_big",
      tool_input: { file_path: file, old_string: "a", new_string: "b" },
      tool_response: { filePath: file, oldString: "a", newString: "b", originalFile: original, userModified: false },
    } as HookPayload;
    try {
      const code = await runHook(JSON.stringify(post), {
        pid: process.pid, port: d.port, workspace: "", token, startedAt: new Date().toISOString(),
      });
      expect(code).toBe(0);
      expect(d.statuses, "the deck took the event rather than refusing it").toEqual([200]);

      const got = eventsSince(0).find(e => e.payload?.session_id === SID && e.payload.hook_event_name === "PostToolUse");
      expect(got, "the outcome reached the deck").toBeDefined();
      const p = got!.payload as Record<string, unknown>;
      expect(p.tool_use_id).toBe("toolu_big");
      expect(p.tool_name).toBe("Edit");
      expect(p.cwd).toBe(CWD);
      expect(p.ccdeck_truncated).toBe(true);
      expect(p.ccdeck_truncation_reason).toBe("size");
      // Only the bulk goes: what a reader of the call needs is still there.
      const response = p.tool_response as Record<string, unknown>;
      expect(response.filePath).toBe(file);
      expect(response.originalFile).toMatchObject({ ccdeck_truncated: true, chars: JSON.stringify(original).length });
      expect((p.tool_input as Record<string, unknown>).file_path).toBe(file);

      // And the board settles the call as the success it was.
      let state = initialState();
      let seq = 0;
      const env = (payload: HookPayload): HookEnvelope => ({ seq: ++seq, receivedAt: 1_000 + seq, source: "hook", payload });
      state = applyEvent(state, env({ hook_event_name: "PreToolUse", session_id: SID, cwd: DIR, tool_name: "Edit", tool_use_id: "toolu_big" }));
      state = applyEvent(state, { ...got!, seq: ++seq });
      state = applyEvent(state, env({ hook_event_name: "Stop", session_id: SID, cwd: DIR }));
      const call = state.agents.get(SID)!.tools[0];
      expect(call.ok).toBe(true);
      expect(call.errorPreview).toBeUndefined();
    } finally {
      await d.close();
    }
  }, 30_000);

  it("leaves an event under the cap exactly as it was", async () => {
    const token = randomBytes(16).toString("hex");
    const d = await deck(token);
    const SID = "sess-small-edit";
    const post = {
      hook_event_name: "PostToolUse", session_id: SID, cwd: DIR,
      tool_name: "Edit", tool_use_id: "toolu_small",
      tool_input: { file_path: "f", old_string: "a", new_string: "b" },
      tool_response: { filePath: "f", originalFile: "y".repeat(100_000) },
    };
    try {
      await runHook(JSON.stringify(post), {
        pid: process.pid, port: d.port, workspace: "", token, startedAt: new Date().toISOString(),
      });
      const got = eventsSince(0).find(e => e.payload?.session_id === SID);
      expect(got!.payload).toEqual({ ...post, cwd: CWD, provider: "claude" });
    } finally {
      await d.close();
    }
  }, 30_000);
});

describe("the hook's cap", () => {
  it("sits under the deck's", () => {
    // Two files, two numbers, one rule: the hook trims to its own cap so the
    // deck's never refuses what the hook sends.
    const hookCap = Number(/const MAX_EVENT_CHARS = ([\d_]+);/.exec(readFileSync(HOOK, "utf8"))?.[1].replace(/_/g, ""));
    const routes = readFileSync(join(dirname(HOOK), "..", "src", "server", "event-routes.mjs"), "utf8");
    const deckCap = Number(/body\.length > ([\d_]+)/.exec(routes)?.[1].replace(/_/g, ""));
    expect(hookCap).toBeGreaterThan(0);
    expect(deckCap).toBeGreaterThan(0);
    expect(hookCap).toBeLessThan(deckCap);
  });
});
