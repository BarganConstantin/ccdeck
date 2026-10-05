// A deck started with --no-claude is not handed Claude sessions.
//
// `--no-claude` installs no hooks, but it does not remove the ones an earlier
// run installed, and the hook posted every Claude event to every deck whose
// workspace matched — the record's `claude: false` was never read, and the
// ingest route took whatever it was given. So a Codex-only deck drew every
// Claude session live (and could be elected to write them to the log), while
// hiding the accounts panel and sound controls that go with them, and dropped
// the same sessions at its next boot because the replay does honour the flag.
import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";
import { endStdin } from "./child-stdin";
import type { HookEnvelope } from "../types";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-no-claude-"));
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
// @ts-expect-error — plain .mjs server module, no types
const { setDeckScope } = await import("../../server/deck-scope.mjs");
const eventsSince = mod.eventsSince as (seq: number) => HookEnvelope[];

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "hook", "hook.js");
const COPY = join(DIR, "hook.cjs");
copyFileSync(HOOK, COPY);
const { challengeProof } = createRequire(import.meta.url)(COPY) as {
  challengeProof: (token: string, nonce: string) => string;
};

afterAll(() => {
  setDeckScope({ workspace: "", claude: true, codex: true });
  rmTempDir(DIR);
});

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ port: number; close: () => Promise<void> }> {
  const server: Server = createServer(handler);
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>(done => { server.closeAllConnections?.(); server.close(() => done()); }),
  };
}

function postEvent(port: number, payload: Record<string, unknown>): Promise<number> {
  return new Promise((done, fail) => {
    const body = JSON.stringify(payload);
    const req = request({ host: "127.0.0.1", port, path: "/api/event", method: "POST", headers: { "content-type": "application/json" } }, res => {
      res.resume();
      res.on("end", () => done(res.statusCode ?? 0));
    });
    req.on("error", fail);
    req.end(body);
  });
}

describe("the ingest of a deck that is not watching Claude", () => {
  it("refuses a Claude event, so a hook hands its log on, and still takes a Codex one", async () => {
    const deck = await listen((req, res) => handleEventIngest(req, res, true));
    try {
      setDeckScope({ workspace: "", claude: false, codex: true });
      // `provider: "claude"` is what the hook stamps on every Claude event.
      const claude = await postEvent(deck.port, { hook_event_name: "SessionStart", session_id: "cc-off", cwd: DIR, provider: "claude" });
      const codex = await postEvent(deck.port, { hook_event_name: "SessionStart", session_id: "cx-on", cwd: DIR, provider: "codex" });
      expect(claude).toBeGreaterThanOrEqual(400);
      expect(codex).toBe(200);
      const sessions = eventsSince(0).map(e => e.payload?.session_id);
      expect(sessions).not.toContain("cc-off");
      expect(sessions).toContain("cx-on");

      setDeckScope({ workspace: "", claude: true, codex: true });
      expect(await postEvent(deck.port, { hook_event_name: "SessionStart", session_id: "cc-on", cwd: DIR, provider: "claude" })).toBe(200);
    } finally {
      setDeckScope({ workspace: "", claude: true, codex: true });
      await deck.close();
    }
  });
});

describe("the hook, with a --no-claude deck registered", () => {
  it("posts a Claude event only to the decks that watch Claude, and elects the writer among them", async () => {
    const seen: Record<string, string[]> = {};
    const honest = (name: string, token: string) => (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/api/hook-challenge") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ proof: challengeProof(token, url.searchParams.get("nonce") ?? "") }));
      }
      (seen[name] ??= []).push(`${url.pathname}${url.search}`);
      req.resume();
      req.on("end", () => res.writeHead(200).end());
    };
    const tokenA = randomBytes(16).toString("hex");
    const tokenB = randomBytes(16).toString("hex");
    const a = await listen(honest("a", tokenA));
    const b = await listen(honest("b", tokenB));
    // The deck that is off for Claude takes the LOWER port, so it is the one
    // the old election would have handed the shared log to.
    const [off, on] = a.port < b.port ? [{ d: a, token: tokenA, name: "a" }, { d: b, token: tokenB, name: "b" }]
      : [{ d: b, token: tokenB, name: "b" }, { d: a, token: tokenA, name: "a" }];
    const log = join(DIR, "events.jsonl");
    const home = mkdtempSync(join(DIR, "home-"));
    mkdirSync(join(home, "agent-dag"), { recursive: true });
    const record = (port: number, token: string, claude: boolean) => JSON.stringify({
      pid: process.pid, port, workspace: "", token, persist: log, claude, codex: true, startedAt: new Date().toISOString(),
    });
    writeFileSync(join(home, "agent-dag", "1001.json"), record(off.d.port, off.token, false));
    writeFileSync(join(home, "agent-dag", "1002.json"), record(on.d.port, on.token, true));
    try {
      const child = spawn(process.execPath, [COPY, "--provider", "claude"], {
        env: { ...process.env, CLAUDE_CONFIG_DIR: home, HOME: home, USERPROFILE: home },
        stdio: ["pipe", "ignore", "ignore"],
      });
      endStdin(child, JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s1", cwd: DIR, tool_name: "Bash", tool_use_id: "t1" }));
      const code = await new Promise<number | null>((done, fail) => { child.on("error", fail); child.on("exit", c => done(c)); });
      expect(code).toBe(0);
      expect(seen[off.name] ?? [], "the --no-claude deck is not posted the event").toEqual([]);
      expect(seen[on.name], "the deck watching Claude gets it, as the log's writer").toEqual(["/api/event"]);
    } finally {
      await a.close();
      await b.close();
    }
  }, 30_000);
});
