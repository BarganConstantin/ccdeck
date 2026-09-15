// Reported (#1019): the hook counted a POST as delivered whatever came back.
// `post()` never read `res.statusCode`, so a 200, a 500 and a connection reset
// all ran the same callback and the caller had nothing to branch on. One deck
// per log is elected to write it and every other deck sharing that log is told
// `?persist=0` — so an elected writer that refuses the event took the log down
// with it, and nothing said so.
//
// Measured against a real deck with a real events.jsonl, one listener below it
// on the port that wins the election, answering the handshake honestly and then
// failing the POST three different ways:
//
//   elected answers 500        hook exit=0 wall=576ms    events.jsonl lines: 0
//   elected resets mid-body    hook exit=0 wall=580ms    events.jsonl lines: 0
//   elected never answers      hook exit=0 wall=1686ms   events.jsonl lines: 0
//
// and in every one of them the healthy deck drew the event on its canvas. That
// is #695's symptom exactly — every deck draws it, all of them were told not to
// keep it, and the file silently stops growing — reached through the ANSWER
// instead of through the record. The three ways in are not exotic: a deck
// restarted by its supervisor between the challenge and the POST, a deck that
// fails the ingest, and a body too large for the route (#1014 gives that one a
// real 413, which this side would not have noticed either).
//
// The fix reads the status and gives the election a second place: a writer that
// does not answer 2xx hands the log to the next deck in its group, in
// electWriters' own order. These tests assert THE LINE COUNT IN THE LOG rather
// than what the hook thinks it did — the whole defect was a process that
// believed it had delivered.
//
// #1133 took the third of those three ways out of the hand-on. A writer that
// takes the body and never answers is, from the hook's side, the same
// observation as one that takes it and answers late, right up to the moment
// the hook has to end — and the late one appends the line when it catches up,
// so handing on at the deadline wrote that event twice
// (writer-answers-late-1133.test.ts). The silent writer keeps the log now, and
// its case below pins that the line is lost cleanly rather than written twice.
// The 500 and the hang-up still hand on: in both, the writer ended the exchange
// itself and claimed nothing.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";

// The home the server thinks it has, the config dir the override points at and
// the Codex home it tails — all temporary, all set before the server module is
// imported, because it resolves every one of them at import time. $HOME and
// %USERPROFILE% together cover POSIX and Windows. Nothing here can reach the
// developer's own ~/.claude or ~/.codex.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-writer-home-"));
const FAKE_CONFIG = mkdtempSync(join(tmpdir(), "ccdeck-writer-config-"));
const FAKE_CODEX = mkdtempSync(join(tmpdir(), "ccdeck-writer-codex-"));
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
const { AGENT_DAG_DIR, discoveryPath, writeDiscovery } = installer as {
  AGENT_DAG_DIR: string;
  discoveryPath: () => string;
  writeDiscovery: (o: Record<string, unknown>) => Promise<string>;
};

// Belt and braces: the server sweeps the discovery dir it resolves, so if the
// override were ignored this file would be deleting a real deck's registration.
for (const [p, root] of [
  [claudeConfigDir(), FAKE_CONFIG],
  [AGENT_DAG_DIR, FAKE_CONFIG],
  [discoveryPath(), FAKE_CONFIG],
] as const) {
  if (!String(p).startsWith(root)) {
    throw new Error(`refusing to run: resolved ${p}, outside ${root}`);
  }
}

const LOG = join(FAKE_CONFIG, "agent-dag", "events.jsonl");
const server: Server = await startServer({ port: 0, persist: LOG, workspace: "", codex: false });
const PORT = (server.address() as AddressInfo).port;

// hook.js is CommonJS inside a "type": "module" package, so it only runs as
// itself outside that tree — which is also the only way it ever runs, the
// installer having copied it into the Claude config dir. Same .cjs copy
// ghost-deck-election.test.ts makes, for the same reason.
const HOOK_DIR = mkdtempSync(join(tmpdir(), "ccdeck-writer-hook-"));
const HOOK_COPY = join(HOOK_DIR, "hook.cjs");
copyFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "hook", "hook.js"), HOOK_COPY);

const listeners: Server[] = [];

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await Promise.all(listeners.map(s => new Promise<void>(done => {
    s.closeAllConnections?.();
    s.close(() => done());
  })));
  for (const dir of [FAKE_HOME, FAKE_CONFIG, FAKE_CODEX, HOOK_DIR]) rmTempDir(dir);
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
 * fire-and-forget, so "it has not arrived yet" and "it is never coming" look
 * identical for a moment.
 */
async function settle(n: number, ms = 15000) {
  const deadline = Date.now() + ms;
  while (lines() < n && Date.now() < deadline) await tick(25);
  await tick(250);
  return lines();
}

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

type Answer = "500" | "reset" | "silent" | "200";

/**
 * A listener that proves it is the deck its record describes and then treats
 * the payload the way `answer` says.
 *
 * The handshake is always answered honestly: the point of every case here is a
 * deck that IS the deck — one that could not prove itself is #695 and is
 * already pinned in ghost-deck-election.test.ts.
 */
function deck(token: string, answer: Answer, seen: string[]) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/hook-challenge") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ proof: challengeProof(token, url.searchParams.get("nonce")) }));
    }
    // Recorded when the request is recognised rather than when it completes:
    // the reset case destroys the socket mid-body, so `end` never fires for it
    // and the path it asked for would otherwise go unrecorded.
    let noted = false;
    const note = () => { if (!noted) { noted = true; seen.push(url.pathname + url.search); } };
    req.on("data", () => {
      if (answer === "reset") { note(); req.destroy(); }
    });
    req.on("end", () => {
      if (answer === "reset") return;
      note();
      if (answer === "silent") return;          // body taken, nothing said back
      if (answer === "500") {
        return res.writeHead(500, { "Content-Type": "application/json" }).end('{"error":"boom"}');
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    });
  };
}

let fired = 0;
/** Run the installed-shape hook and hand back its exit code and wall time. */
async function fireHook(session: string) {
  const id = `tool-${++fired}`;
  const t0 = Date.now();
  const child = spawn(process.execPath, [HOOK_COPY, "--provider", "claude"], {
    env: {
      ...process.env,
      HOME: FAKE_HOME, USERPROFILE: FAKE_HOME,
      CLAUDE_CONFIG_DIR: FAKE_CONFIG, CODEX_HOME: FAKE_CODEX,
    },
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", c => { stderr += c; });
  child.stdin.end(JSON.stringify({
    cwd: FAKE_HOME, session_id: session, hook_event_name: "PreToolUse",
    tool_name: "Read", tool_use_id: id,
  }));
  const code = await new Promise<number | null>((done, fail) => {
    child.on("error", fail);
    child.on("exit", c => done(c));
  });
  return { id, code, stderr, wallMs: Date.now() - t0 };
}

/** How many times this deck was handed a given event, drawn or not. */
const drawnCount = (id: string) => eventsSince(0)
  .filter((e: { source: string }) => e.source === "hook")
  .filter((e: { payload: Record<string, unknown> }) => e.payload.tool_use_id === id)
  .length;

const ghostFile = join(AGENT_DAG_DIR, `${process.pid}0.json`);
/** A second record, for the listener that wins the election. Its pid has to be
 *  alive or the hook unlinks the file before the election ever sees it; this
 *  process is the one pid certain to be running. */
const registerWriter = (port: number, token: string) => writeFileSync(ghostFile, JSON.stringify({
  pid: process.pid, port, workspace: "", token, persist: LOG,
  startedAt: new Date().toISOString(),
}));
const dropWriter = () => rmSync(ghostFile, { force: true });

describe("an elected writer that does not take the event", () => {
  beforeAll(async () => {
    // This deck's real record, with its real token — so the hook's challenge
    // reaches a listener that can actually answer it.
    await writeDiscovery({ port: PORT, workspace: "", token: hookToken(), persist: LOG, codex: false });
  });

  it("reaches the log at all with only this deck registered", async () => {
    // The premise for everything below: without it, a log that stays empty
    // proves nothing about the election.
    dropWriter();
    const { id, code } = await fireHook("sess-baseline");
    expect(code).toBe(0);
    expect(await settle(1)).toBe(1);
    expect(drawnCount(id)).toBe(1);
  }, 30_000);

  for (const [answer, what] of [
    ["500", "answers 500"],
    ["reset", "hangs up mid-body"],
  ] as Array<[Answer, string]>) {
    it(`hands the log on when the writer ${what}`, async () => {
      const token = randomBytes(32).toString("hex");
      const seen: string[] = [];
      const writer = await listenBelow(PORT, deck(token, answer, seen));
      registerWriter(writer.port, token);

      const before = lines();
      const { id, code, stderr } = await fireHook("sess-refused");

      // The premise, stated rather than assumed: this listener has to have been
      // the elected writer, or the case under test never happened. `/api/event`
      // with no query is the unflagged path — `?persist=0` is what the losers
      // are told.
      expect(seen, `the writer was asked to keep the event (stderr: ${stderr})`)
        .toContain("/api/event");

      expect(code, "the hook still ends itself cleanly").toBe(0);
      expect(await settle(before + 1), "the event reached a log").toBe(before + 1);
      // Handed on to the deck that can take it, which is why it was posted the
      // event twice — once to draw it, once to keep it. The reducer folds a
      // re-delivered tool_use_id into the call it already has.
      expect(drawnCount(id), "the log was handed to the second deck in line").toBe(2);
      dropWriter();
    }, 30_000);
  }

  it("keeps the log with a writer that takes the body and never answers", async () => {
    // #1133, and the price of it said out loud. This writer took the whole
    // body and let the hook's deadline pass; a real deck in that state is
    // usually a busy one that appends the line when it catches up, so a second
    // deck must not be asked to append it too. This listener never catches up,
    // so here the line is lost — as it was before #1087 — and the hook still
    // ends itself cleanly at the deadline rather than at the cap.
    const token = randomBytes(32).toString("hex");
    const seen: string[] = [];
    const writer = await listenBelow(PORT, deck(token, "silent", seen));
    registerWriter(writer.port, token);

    const before = lines();
    const { id, code, stderr } = await fireHook("sess-silent");
    expect(seen, `the writer was asked to keep the event (stderr: ${stderr})`)
      .toContain("/api/event");
    expect(code, "the hook still ends itself cleanly").toBe(0);
    await settle(before + 1, 2000);
    expect(lines(), "no second deck was asked to write it").toBe(before);
    expect(drawnCount(id), "drawn once, with ?persist=0, and never handed the log").toBe(1);
    dropWriter();
  }, 30_000);

  it("asks the second deck once when the writer does take it", async () => {
    // The working case, and the one the hand-on must not buy its way out of: a
    // real writer below us keeps the log, we draw the event and write nothing,
    // and nobody is asked twice.
    const token = randomBytes(32).toString("hex");
    const seen: string[] = [];
    const writer = await listenBelow(PORT, deck(token, "200", seen));
    registerWriter(writer.port, token);

    const before = lines();
    const { id, code } = await fireHook("sess-healthy");
    expect(code).toBe(0);
    expect(seen).toEqual(["/api/event"]);
    await settle(before + 1, 2000);
    expect(lines(), "the elected writer owns the log and we keep no copy").toBe(before);
    expect(drawnCount(id), "drawn once — a 2xx ends the hand-on before it starts").toBe(1);
    dropWriter();
  }, 30_000);

  it("ends cleanly when the only deck that could write refuses", async () => {
    // The limit of the fix, said out loud: a hand-on needs somewhere to hand
    // to. With one deck on the log and that deck refusing, the event is lost —
    // and the hook must still exit 0 and say nothing, because a non-zero exit
    // puts `<hook> hook error` in front of the user on every tool call.
    const token = randomBytes(32).toString("hex");
    const seen: string[] = [];
    const solo = await listenBelow(PORT, deck(token, "500", seen));
    // This deck's own record names the same log, so it has to go for the
    // refusing listener to be alone in its group.
    rmSync(discoveryPath(), { force: true });
    registerWriter(solo.port, token);

    const before = lines();
    const { code, stderr } = await fireHook("sess-alone");
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(seen).toContain("/api/event");
    await settle(before + 1, 2000);
    expect(lines()).toBe(before);
    dropWriter();
    await writeDiscovery({ port: PORT, workspace: "", token: hookToken(), persist: LOG, codex: false });
  }, 30_000);
});
