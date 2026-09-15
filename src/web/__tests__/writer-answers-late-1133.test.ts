// Reported (#1133): an elected writer that took the event and answered late got
// the line written twice. #1087 taught the hook to hand the log on to the next
// deck when the writer does not take the event (#1019), and it counted the
// POST's idle timeout as "did not take it". But when that timeout fires the
// writer already has the whole body. A busy deck reads it when it catches up
// and appends it, and by then the hook has asked the next deck in line to
// append the same line.
//
// Measured on main at 1887d95 with the harness below, the writer's 200 held
// back past the hook's deadline and then not at all:
//
//   writer's 200 held 1300ms   lines for the event: 2   (the hook before #1087: 1)
//   writer's 200 held 0ms      lines for the event: 1   (the hook before #1087: 1)
//
// A duplicated line does not go away. events.jsonl is what the deck replays on
// boot, so the event is drawn twice after every restart for as long as the log
// is kept, and a busy deck is exactly the load the retry in prove() exists for.
//
// Real code on both sides of the line: one real deck (startServer, a real
// events.jsonl) and, on the port below it, a proxy that wins the election. The
// proxy forwards the handshake and the POST to that same deck at once, so the
// slow writer's line is appended by the real ingest, and holds back only the
// deck's answer. The hand-on, when there is one, goes to the real deck as well.
// What is asserted is THE LINE COUNT IN THE LOG, as in
// elected-writer-answers-1019.test.ts, not what the hook believes it did.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";

// The home the server thinks it has, the config dir the override points at and
// the Codex home it tails — all temporary, all set before the server module is
// imported, because it resolves every one of them at import time. Nothing here
// can reach the developer's own ~/.claude or ~/.codex.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-1133-home-"));
const FAKE_CONFIG = mkdtempSync(join(tmpdir(), "ccdeck-1133-config-"));
const FAKE_CODEX = mkdtempSync(join(tmpdir(), "ccdeck-1133-codex-"));
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
const { startServer, eventsSince, hookToken } = await import("../../server/index.mjs");
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
for (const p of [claudeConfigDir(), AGENT_DAG_DIR, discoveryPath()]) {
  if (!String(p).startsWith(FAKE_CONFIG)) throw new Error(`refusing to run: resolved ${p}, outside ${FAKE_CONFIG}`);
}

const HOOK_SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "hook", "hook.js");

// How long the hook waits on a POST, read out of the script the way
// hook-budget.test.ts reads CAP_MS, so the hold below stays past the deadline
// if the deadline moves. 300ms past it is the 1300ms #1133 was measured with:
// far enough that a loaded runner cannot make the answer arrive in time, and
// well inside the time this file waits for the log.
const postTimeout = /^const POST_TIMEOUT_MS = (\d+);$/m.exec(readFileSync(HOOK_SRC, "utf8"));
if (!postTimeout) throw new Error("hook.js no longer states `const POST_TIMEOUT_MS = <n>;`");
const LATE_MS = Number(postTimeout[1]) + 300;

// hook.js is CommonJS inside a "type": "module" package, so it only runs as
// itself outside that tree — the same .cjs copy the other hook suites make.
const HOOK_DIR = mkdtempSync(join(tmpdir(), "ccdeck-1133-hook-"));
const HOOK_COPY = join(HOOK_DIR, "hook.cjs");
copyFileSync(HOOK_SRC, HOOK_COPY);

// Both ports come from one small band, the proxy's first and the deck's above
// it, because the election is decided by port order and the proxy has to win
// it. The band is clear of 4317, the default a developer's own deck holds, and
// of the range startServer falls back into.
const BAND_LOW = 4630;
const BAND_HIGH = 4639;

let PORT = 0;
const seen: string[] = [];
let hold = 0;
// Answers the proxy is still holding back, so a case does not end — and the
// next one does not start — while one is waiting to be let go.
let heldBack = 0;

/** Forward to the real deck at once; hold back only the answer to a POST. */
function forward(req: IncomingMessage, res: ServerResponse) {
  req.on("error", () => {});
  res.on("error", () => {});
  const chunks: Buffer[] = [];
  req.on("data", c => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const isPost = req.method === "POST";
    if (isPost) seen.push(req.url ?? "");
    const up = request({
      hostname: "127.0.0.1", port: PORT, path: req.url, method: req.method,
      headers: { "Content-Type": "application/json", "Content-Length": body.length },
    }, upRes => {
      const got: Buffer[] = [];
      upRes.on("data", c => got.push(c));
      upRes.on("end", () => {
        const answer = () => {
          // The hook has usually hung up by now; the answer has nowhere to go.
          try { res.writeHead(upRes.statusCode ?? 502, { "Content-Type": "application/json" }).end(Buffer.concat(got)); }
          catch { /* gone */ }
        };
        if (!isPost || hold === 0) return answer();
        heldBack++;
        setTimeout(() => { answer(); heldBack--; }, hold);
      });
    });
    up.on("error", () => res.destroy());
    up.end(body);
  });
}

async function listenInBand(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  for (let port = BAND_LOW; port < BAND_HIGH; port++) {
    const s = createServer(handler);
    const bound = await new Promise<boolean>(done => {
      s.once("error", () => done(false));
      s.listen(port, "127.0.0.1", () => done(true));
    });
    if (bound) return { port, server: s };
    s.close();
  }
  throw new Error(`no free port in ${BAND_LOW}-${BAND_HIGH - 1} for the proxy`);
}

const proxy = await listenInBand(forward);
const LOG = join(FAKE_CONFIG, "agent-dag", "events.jsonl");
const server: Server = await startServer({
  port: proxy.port + 1, portRange: [proxy.port + 1, BAND_HIGH],
  persist: LOG, workspace: "", codex: false,
});
PORT = (server.address() as AddressInfo).port;
if (PORT <= proxy.port) throw new Error(`the deck bound ${PORT}, not above the proxy's ${proxy.port}`);

afterAll(async () => {
  proxy.server.closeAllConnections?.();
  await new Promise<void>(resolve => proxy.server.close(() => resolve()));
  await new Promise<void>(resolve => server.close(() => resolve()));
  for (const dir of [FAKE_HOME, FAKE_CONFIG, FAKE_CODEX, HOOK_DIR]) rmTempDir(dir);
  for (const [key, was] of Object.entries(prev)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
});

const tick = (ms: number) => new Promise(r => setTimeout(r, ms));
const linesFor = (id: string) => (existsSync(LOG) ? readFileSync(LOG, "utf8") : "")
  .split("\n").filter(l => l.includes(JSON.stringify(id))).length;

/**
 * Wait for the event's first line and for the proxy to have let its answer go —
 * then a little longer, which is the window a second line would land in. The
 * append is fire-and-forget, so "not yet" and "never" look alike for a moment.
 */
async function settle(id: string, ms = 15000) {
  const deadline = Date.now() + ms;
  while ((linesFor(id) < 1 || heldBack > 0) && Date.now() < deadline) await tick(25);
  await tick(250);
  return linesFor(id);
}

/** How many times the real deck was handed this event, drawn or kept. */
const drawnCount = (id: string) => eventsSince(0)
  .filter((e: { source: string }) => e.source === "hook")
  .filter((e: { payload: Record<string, unknown> }) => e.payload.tool_use_id === id)
  .length;

let fired = 0;
/** Run the installed-shape hook and hand back its exit code. */
async function fireHook(session: string) {
  const id = `tool-1133-${++fired}`;
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
  return { id, code, stderr };
}

describe("an elected writer that takes the event", () => {
  beforeAll(async () => {
    // The deck's own record, and the proxy's beside it: the deck's token, so
    // the handshake the proxy forwards proves; the same log, so the two compete
    // for it; the lower port, so the proxy is elected. Its pid has to be alive
    // or the hook unlinks the record, and this process is the one pid certain
    // to be running.
    await writeDiscovery({ port: PORT, workspace: "", token: hookToken(), persist: LOG, codex: false });
    writeFileSync(join(AGENT_DAG_DIR, `${process.pid}0.json`), JSON.stringify({
      pid: process.pid, port: proxy.port, workspace: "", token: hookToken(), persist: LOG,
      startedAt: new Date().toISOString(),
    }));
  });

  it("writes one line when it answers at once", async () => {
    // The premise for the case below: through this harness, a writer that
    // answers in time keeps the log and nobody else is asked to.
    hold = 0;
    seen.length = 0;
    const { id, code, stderr } = await fireHook("sess-1133-prompt");
    expect(seen, `the proxy was the elected writer (stderr: ${stderr})`).toContain("/api/event");
    expect(code).toBe(0);
    expect(await settle(id)).toBe(1);
    // The proxy's forward, which kept it, and the hook's own `?persist=0`.
    expect(drawnCount(id)).toBe(2);
  }, 30_000);

  it("writes one line when it answers after the hook stopped waiting", async () => {
    hold = LATE_MS;
    seen.length = 0;
    const { id, code, stderr } = await fireHook("sess-1133-late");
    // The premise, stated rather than assumed: the proxy was asked to keep the
    // event, which `/api/event` with no query means, and it did — the real deck
    // behind it appended the line before the hook gave up on the answer.
    expect(seen, `the proxy was the elected writer (stderr: ${stderr})`).toContain("/api/event");
    expect(code, "the hook still ends itself cleanly").toBe(0);
    expect(await settle(id), "one event, one line in the shared log").toBe(1);
    // A third delivery would be the hand-on: the deck asked a second time, with
    // `persist=1`, to keep what it already kept.
    expect(drawnCount(id), "the log was not handed on").toBe(2);
  }, 30_000);
});
