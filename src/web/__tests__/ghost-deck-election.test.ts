// Reported (#695): a deck dies without running its shutdown — SIGKILL, an OOM
// kill, a power cut, a console window closed on Windows — and its discovery
// record stays in the directory. The only staleness test anywhere is a signal-0
// probe of the recorded pid, so the moment the OS hands that number to some
// other long-lived process the record passes forever. If it also names a port
// below every real deck's, it WINS the single-writer election: every running
// deck draws the event and is told `?persist=0`, the ghost is posted to nothing
// because it cannot answer the challenge, and events.jsonl stops growing. The
// canvas looks completely normal and the log is empty, so nothing says so until
// a restart replays a history that ended days ago.
//
// Two paths had it, for the same reason and with different halves missing. The
// hook challenged every target — but only AFTER electWriters had already
// decided, and a target that failed the challenge was simply never posted to and
// never re-elected around. The Codex rollout watcher, which is the only Codex
// capture there is on Windows, ran the same election over the same records with
// no challenge at all.
//
// Both now prove first and elect second. These drive real decks and assert the
// LINE COUNT IN THE LOG — the election's own opinion of itself is exactly what
// was wrong.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { spawn } from "node:child_process";
import { rmTempDir } from "./rm-temp-dir";
import { randomBytes } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The home the server thinks it has, the config dir the override points at, and
// the Codex home it tails — all temporary, all set before the server module is
// imported, because it resolves every one of them at import time. $HOME and
// %USERPROFILE% together cover POSIX and Windows. Nothing here can reach the
// developer's own ~/.claude or ~/.codex.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-ghost-home-"));
const FAKE_CONFIG = mkdtempSync(join(tmpdir(), "ccdeck-ghost-config-"));
const FAKE_CODEX = mkdtempSync(join(tmpdir(), "ccdeck-ghost-codex-"));
const prev = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
};
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.env.CLAUDE_CONFIG_DIR = FAKE_CONFIG;
process.env.CODEX_HOME = FAKE_CODEX;
process.env.XDG_CONFIG_HOME = join(FAKE_HOME, ".config");

// @ts-expect-error — .mjs server module, no types
const { startServer, eventsSince, hookToken, challengeProof } = await import("../../server/index.mjs");
// @ts-expect-error — .mjs server module, no types
const { claudeConfigDir } = await import("../../server/claude-dir.mjs");
// @ts-expect-error — .mjs server module, no types
const installer = await import("../../server/installer.mjs");
const { AGENT_DAG_DIR, CODEX_DIR, discoveryPath, writeDiscovery } = installer as {
  AGENT_DAG_DIR: string;
  CODEX_DIR: string;
  discoveryPath: () => string;
  writeDiscovery: (o: Record<string, unknown>) => Promise<string>;
};

// Belt and braces: the server sweeps the discovery dir it resolves and the
// watcher walks the Codex home it resolves, so if either override were ignored
// this file would be deleting a real deck's registration and reading real
// sessions.
for (const [p, root] of [
  [claudeConfigDir(), FAKE_CONFIG],
  [AGENT_DAG_DIR, FAKE_CONFIG],
  [discoveryPath(), FAKE_CONFIG],
  [CODEX_DIR, FAKE_CODEX],
] as const) {
  if (!String(p).startsWith(root)) {
    throw new Error(`refusing to run: resolved ${p}, outside ${root}`);
  }
}

const LOG = join(FAKE_CONFIG, "agent-dag", "events.jsonl");
const server: Server = await startServer({ port: 0, persist: LOG, workspace: "", codex: true });
const PORT = (server.address() as AddressInfo).port;

// hook.js is CommonJS inside a "type": "module" package, so it only loads as
// itself once outside that tree — which is also the only way it ever runs, the
// installer having copied it into the Claude config dir. A .cjs copy reproduces
// that without an install.
const HOOK_DIR = mkdtempSync(join(tmpdir(), "ccdeck-ghost-hook-"));
const HOOK_COPY = join(HOOK_DIR, "hook.cjs");
copyFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "hook", "hook.js"), HOOK_COPY);

const listeners: Server[] = [];

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await Promise.all(listeners.map(s => new Promise<void>(done => {
    s.closeAllConnections?.();
    s.close(() => done());
  })));
  for (const dir of [FAKE_HOME, FAKE_CONFIG, FAKE_CODEX, HOOK_DIR]) {
    rmTempDir(dir);
  }
  for (const [key, was] of Object.entries(prev)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
});

const tick = (ms: number) => new Promise(r => setTimeout(r, ms));
const lines = () =>
  (existsSync(LOG) ? readFileSync(LOG, "utf8") : "").split("\n").filter(Boolean).length;

/**
 * Wait for the log to reach `n` lines — then a little longer, which is the
 * window a line that should NOT be there would land in. The append is
 * fire-and-forget and the rollout watcher polls on its own clock.
 */
async function settle(n: number, ms = 15000) {
  const deadline = Date.now() + ms;
  while (lines() < n && Date.now() < deadline) await tick(25);
  await tick(200);
  return lines();
}

// ── The ghost ────────────────────────────────────────────────────────────────
//
// A pid that is alive and is not a deck is the whole of what pid recycling
// leaves behind, and the parent of this test process is exactly that: alive for
// as long as the run lasts, and no deck. Port 1 is the port it names — nothing
// unprivileged can bind it, so a connection there is refused instantly on every
// platform, and 1 is below any port a real deck can be listening on, which is
// what makes this record win the election it should never have been in.
const GHOST_PID = process.ppid;
const GHOST_PORT = 1;
const ghostFile = join(AGENT_DAG_DIR, `${GHOST_PID}.json`);
const writeGhost = (over: Record<string, unknown> = {}) => writeFileSync(ghostFile, JSON.stringify({
  pid: GHOST_PID, port: GHOST_PORT, workspace: "", token: "the-dead-deck-token",
  persist: LOG, codex: true, startedAt: new Date().toISOString(), ...over,
}));
const dropGhost = () => rmSync(ghostFile, { force: true });

/**
 * A listener on a port BELOW this deck's, so a record naming it wins the
 * election outright. The deck binds an ephemeral port, which every platform
 * takes from the high end of the range, so there is always room underneath —
 * the loop is only for the candidates that happen to be taken.
 */
async function listenBelow(limit: number, handler: (req: IncomingMessage, res: ServerResponse) => void) {
  for (let i = 0; i < 400; i++) {
    const port = 2000 + Math.floor(Math.random() * (Math.min(limit, 30000) - 2000));
    const s = createServer((req, res) => {
      req.on("error", () => {});
      res.on("error", () => {});
      handler(req, res);
    });
    const bound = await new Promise<boolean>(done => {
      s.once("error", () => done(false));
      s.listen(port, "127.0.0.1", () => done(true));
    });
    if (bound) { listeners.push(s); return { port, server: s }; }
    s.close();
  }
  throw new Error(`no free port below ${limit}`);
}

/** A listener that answers the challenge the way a real deck does. */
function honestDeck(token: string, seen: string[] = []) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/hook-challenge") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ proof: challengeProof(token, url.searchParams.get("nonce")) }));
    }
    seen.push(req.url ?? "");
    req.on("data", () => {});
    req.on("end", () => res.writeHead(200, { "Content-Type": "application/json" }).end("{}"));
  };
}

// ── The hook path ────────────────────────────────────────────────────────────

let fired = 0;
async function fireHook(session: string) {
  const id = `tool-${++fired}`;
  const child = spawn(process.execPath, [HOOK_COPY, "--provider", "claude"], {
    env: {
      ...process.env,
      HOME: FAKE_HOME, USERPROFILE: FAKE_HOME,
      CLAUDE_CONFIG_DIR: FAKE_CONFIG, CODEX_HOME: FAKE_CODEX,
    },
    stdio: ["pipe", "ignore", "ignore"],
  });
  child.stdin.end(JSON.stringify({
    cwd: FAKE_HOME, session_id: session, hook_event_name: "PreToolUse",
    tool_name: "Read", tool_use_id: id,
  }));
  await new Promise<void>((done, fail) => {
    child.on("error", fail);
    child.on("exit", () => done());
  });
  return id;
}

const drawnHook = () => eventsSince(0)
  .filter((e: { source: string }) => e.source === "hook")
  .map((e: { payload: Record<string, unknown> }) => e.payload.tool_use_id);

describe("a hook event with a ghost record on a lower port", () => {
  beforeAll(async () => {
    // This deck's real record, with its real token — so the hook's challenge
    // reaches a listener that can actually answer it.
    await writeDiscovery({ port: PORT, workspace: "", token: hookToken(), persist: LOG, codex: true });
    // The ghost's pid has to be a pid, and an alive one, or the hook would
    // unlink the record before the election ever saw it.
    expect(Number.isInteger(GHOST_PID) && GHOST_PID > 0).toBe(true);
  });

  it("reaches the log at all with only this deck registered", async () => {
    const id = await fireHook("sess-hook");
    expect(await settle(1)).toBe(1);
    expect(drawnHook()).toContain(id);
  }, 30_000);

  it("is still written when a record naming a live non-deck pid holds a lower port", async () => {
    // This is the report, constructed: the ghost wins on port and cannot answer
    // for itself. Before the fix the count stayed at 1 while the canvas grew.
    writeGhost();
    const id = await fireHook("sess-hook");
    expect(await settle(2)).toBe(2);
    expect(drawnHook()).toContain(id);
  }, 30_000);

  it("leaves the ghost's record on disk — a failed challenge is not proof the deck is gone", () => {
    // A dead pid is proof and is swept; a refused connection is not. A deck
    // restarting under its supervisor refuses for a moment with its record still
    // standing, and evicting it would trade lost log lines for a lost deck.
    expect(existsSync(ghostFile)).toBe(true);
  });

  it("is still written when the ghost's port answers the challenge wrongly", async () => {
    // The port outlives the deck too, and 4317 — the deck's own default — is
    // also the standard OTLP collector port. Something IS listening; it is not
    // this deck, and it must not be able to take the log away by being lower.
    dropGhost();
    const stranger = await listenBelow(PORT, (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ proof: randomBytes(32).toString("hex") }));
    });
    writeGhost({ port: stranger.port });
    const id = await fireHook("sess-hook");
    expect(await settle(3)).toBe(3);
    expect(drawnHook()).toContain(id);
  }, 30_000);

  it("still hands the log to a deck that does prove itself on a lower port", async () => {
    // The working case, and the one the fix must not buy its way out of: a real
    // deck below us takes the file, we draw the event and write nothing.
    dropGhost();
    const token = randomBytes(32).toString("hex");
    const seen: string[] = [];
    const other = await listenBelow(PORT, honestDeck(token, seen));
    writeGhost({ port: other.port, token });

    const before = lines();
    const id = await fireHook("sess-elsewhere");
    await settle(before + 1, 2000);
    expect(lines()).toBe(before);
    // Drawn here all the same — the fan-out is the point, only the second copy
    // on disk is dropped — and posted to the elected deck unflagged.
    expect(drawnHook()).toContain(id);
    expect(seen).toEqual(["/api/event"]);
    dropGhost();
  }, 30_000);
});

// ── The Codex rollout path ───────────────────────────────────────────────────
//
// No hook is involved at all: the watcher tails the rollout inside the server
// and runs the election itself. This half had no challenge whatsoever, so it
// stayed wrong even with the hook fixed — and it is the only Codex capture there
// is on Windows, where Codex hooks never fire.

describe("a Codex rollout with a ghost record on a lower port", () => {
  const SID = "9c2f1b7a-6950-4000-8000-0123456789ab";
  const CWD = join(FAKE_HOME, "workspace");
  const DAY = join(FAKE_CODEX, "sessions", "2026", "08", "26");
  const ROLLOUT = join(DAY, `rollout-2026-08-26T09-00-00-${SID}.jsonl`);
  const line = (obj: unknown) => JSON.stringify(obj) + "\n";

  const drawn = () => eventsSince(0)
    .filter((e: { source: string }) => e.source === "codex")
    .map((e: { payload: Record<string, unknown> }) => e.payload)
    .filter((p: Record<string, unknown>) => p.session_id === SID)
    .map((p: Record<string, unknown>) => p.hook_event_name);

  async function drew(n: number, ms = 15000) {
    const deadline = Date.now() + ms;
    while (drawn().length < n && Date.now() < deadline) await tick(50);
    await tick(200);
    return drawn().length;
  }

  beforeAll(() => {
    dropGhost();
    mkdirSync(DAY, { recursive: true });
  });

  it("reaches the log with only this deck registered", async () => {
    const before = lines();
    writeFileSync(ROLLOUT,
      line({ type: "session_meta", payload: { id: SID, cwd: CWD } }) +
      line({ type: "event_msg", payload: { type: "user_message", message: "hello codex" } }) +
      line({ type: "response_item", payload: { type: "function_call", name: "shell", call_id: "call_ONE", arguments: "{}" } }),
      "utf8");
    expect(await drew(3)).toBe(3);
    expect(await settle(before + 3)).toBe(before + 3);
    expect(drawn()).toEqual(["SessionStart", "UserPromptSubmit", "PreToolUse"]);
  }, 40_000);

  it("is still written when a record naming a live non-deck pid holds a lower port", async () => {
    // The report's second half. Before the fix these three lines were drawn and
    // none of them was written, on the path Windows depends on entirely.
    writeGhost();
    const before = lines();
    appendFileSync(ROLLOUT, line({ type: "response_item", payload: { type: "function_call_output", call_id: "call_ONE", output: "ok" } }), "utf8");
    expect(await drew(4)).toBe(4);
    expect(await settle(before + 1)).toBe(before + 1);
  }, 40_000);

  it("is still written when the ghost's port answers the challenge wrongly", async () => {
    dropGhost();
    const stranger = await listenBelow(PORT, (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ proof: randomBytes(32).toString("hex") }));
    });
    writeGhost({ port: stranger.port, token: randomBytes(32).toString("hex") });
    const before = lines();
    appendFileSync(ROLLOUT, line({ type: "event_msg", payload: { type: "user_message", message: "second turn" } }), "utf8");
    expect(await drew(5)).toBe(5);
    expect(await settle(before + 1)).toBe(before + 1);
  }, 40_000);

  it("still leaves the log to a deck that does prove itself on a lower port", async () => {
    // The working case for this path: one line for the rollout, written by the
    // other deck, and this one draws it and keeps no copy.
    dropGhost();
    const token = randomBytes(32).toString("hex");
    const other = await listenBelow(PORT, honestDeck(token));
    writeGhost({ port: other.port, token });
    // The verdict on the previous record for this pid is cached for a few
    // seconds and this one is a different question (new port, new token), but
    // the scan also has to notice the file at all.
    await tick(300);

    const before = lines();
    appendFileSync(ROLLOUT, line({ type: "response_item", payload: { type: "function_call", name: "shell", call_id: "call_TWO", arguments: "{}" } }), "utf8");
    expect(await drew(6)).toBe(6);
    await settle(before + 1, 3000);
    expect(lines()).toBe(before);
    dropGhost();
  }, 40_000);
});
