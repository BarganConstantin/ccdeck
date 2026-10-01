// #1872. The registry scan has a deadline, and when it fired it handed back
// whatever had been read by then — which on a loaded machine could be nothing
// at all. A record that is merely SLOW to read (a busy disk, an antivirus
// scanning a file a deck rewrote a moment ago, a threadpool queued behind
// someone else's build) then dropped the event for every deck on the machine,
// with nothing on screen to say so. The Windows CI runner showed it twice in one
// day: a hook that never challenged the port its record named (623ms, when two
// challenge deadlines alone are 800) and a deck beside a stranger that was never
// posted to (808ms). Neither run got as far as the step the case was about.
//
// A deadline with nothing found is not an answer, the same way prove()'s is
// not: it is worth one more window. A deadline with SOMETHING found still hands
// that over at once, so a healthy deck beside a record the filesystem never
// answers for keeps its event (hook-budget.test.ts).
//
// The slow read is INJECTED — a `-r` preload that holds each registry read's
// callback back by SLOW_MS — for the reason hook-budget.test.ts gives: a wall
// clock on CI is not evidence of anything. SLOW_MS sits past one 400ms window
// and well inside two, so the cases below fail on a hook that gives up at the
// first deadline, and on one that waits for a read that never comes.
import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { endStdin } from "./child-stdin";
import { rmTempDir } from "./rm-temp-dir";

// Same .cjs copy hook-handshake.test.ts makes, for the same reason: hook.js is
// CommonJS inside a "type": "module" package and only runs as itself outside it.
const HOOK = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "hook", "hook.js");
const ROOT = mkdtempSync(join(tmpdir(), "ccdeck-slow-registry-"));
const COPY = join(ROOT, "hook.cjs");
copyFileSync(HOOK, COPY);

// @ts-expect-error — .mjs server module, no types
const { challengeProof } = await import("../../server/index.mjs");

afterAll(() => rmTempDir(ROOT));

const SLOW_MS = 500;

/**
 * Registry reads answer SLOW_MS late; a read of a file named `stall` never
 * answers. Everything else — the hook's own cwd, the discovery directory
 * listing — goes straight through, so the only thing slow is the records.
 */
function slowRegistry(stall: string | null = null) {
  return `
const fs = require("fs");
const STALL = ${JSON.stringify(stall)};
const record = p => typeof p === "string" && p.includes("agent-dag") && p.endsWith(".json");
const readFile = fs.readFile;
fs.readFile = function (p, ...rest) {
  if (!record(p)) return readFile.call(fs, p, ...rest);
  if (STALL && p.endsWith(STALL)) return;
  const cb = rest.pop();
  readFile.call(fs, p, ...rest, (...out) => setTimeout(() => cb(...out), ${SLOW_MS}));
};
`;
}

type Seen = { method: string; path: string };

async function listener(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    seen.push({ method: req.method ?? "", path: req.url ?? "" });
    req.on("error", () => {});
    res.on("error", () => {});
    handler(req, res);
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  const close = () => new Promise<void>(done => {
    server.closeAllConnections?.();
    server.close(() => done());
  });
  return { seen, port, close, posts: () => seen.filter(s => s.method === "POST").length };
}

/** A listener that answers the challenge the way a real deck does. */
function honestDeck(token: string) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/hook-challenge") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ proof: challengeProof(token, url.searchParams.get("nonce")) }));
    }
    req.resume();
    req.on("end", () => res.writeHead(200).end());
  };
}

const PROMPT = "SECRET-PROMPT-do-not-leak";

const record = (port: number, token: string) => ({
  pid: process.pid, port, workspace: "", token, startedAt: new Date().toISOString(),
});

/**
 * Run the installed-shape hook once against a registry of `records`, behind
 * `preload`. Never reads or writes the real ~/.claude: CLAUDE_CONFIG_DIR, HOME
 * and USERPROFILE all point into the temp tree.
 */
async function fire(records: Record<string, Record<string, unknown>>, preload: string) {
  const home = mkdtempSync(join(ROOT, "home-"));
  const dir = join(home, "agent-dag");
  mkdirSync(dir, { recursive: true });
  for (const [name, r] of Object.entries(records)) writeFileSync(join(dir, name), JSON.stringify(r), "utf8");
  const pre = join(home, "preload.cjs");
  writeFileSync(pre, preload, "utf8");

  const child = spawn(process.execPath, ["-r", pre, COPY, "--provider", "claude"], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: home, HOME: home, USERPROFILE: home },
    stdio: ["pipe", "ignore", "ignore"],
  });
  endStdin(child, JSON.stringify({ cwd: process.cwd(), hook_event_name: "UserPromptSubmit", prompt: PROMPT }));
  return await new Promise<number | null>((done, fail) => {
    child.on("error", fail);
    child.on("exit", code => done(code));
  });
}

// Named for a pid, because the hook reads nothing else, and not substrings of
// each other, because the preload matches on the end of the path.
const LIVE = `${process.pid}.json`;
const OTHER = `${process.pid}1.json`;

describe("a registry that is slow to read, but does answer", () => {
  it("still hands the event to the deck it describes", async () => {
    const token = randomBytes(32).toString("hex");
    const deck = await listener(honestDeck(token));
    try {
      expect(await fire({ [LIVE]: record(deck.port, token) }, slowRegistry())).toBe(0);
    } finally {
      await deck.close();
    }
    expect(deck.posts(), "a record read after the first deadline dropped the event").toBe(1);
  }, 15_000);

  it("still challenges a port that turns out not to be the deck, and tells it nothing else", async () => {
    // The first failure on the Windows runner: a stranger on the recorded port
    // that was never asked anything, because the hook never got as far as
    // asking. It passed the rule — told nothing — for the wrong reason.
    const stranger = await listener((_req, res) => { res.writeHead(404).end("not found"); });
    try {
      expect(await fire({ [LIVE]: record(stranger.port, randomBytes(32).toString("hex")) }, slowRegistry())).toBe(0);
    } finally {
      await stranger.close();
    }
    expect(stranger.seen.length, "the port the record names was never challenged").toBe(1);
    expect(stranger.seen[0].path).toMatch(/^\/api\/hook-challenge\?nonce=/);
    expect(JSON.stringify(stranger.seen)).not.toContain(PROMPT);
  }, 15_000);

  it("reads every record that answers in the second window, not only the first to land", async () => {
    // The fan-out is the documented meaning (see discoverTargets): a phase that
    // stopped at the first record found would hand the event to one deck and
    // not the one beside it.
    const tokenA = randomBytes(32).toString("hex");
    const tokenB = randomBytes(32).toString("hex");
    const a = await listener(honestDeck(tokenA));
    const b = await listener(honestDeck(tokenB));
    try {
      expect(await fire({ [LIVE]: record(a.port, tokenA), [OTHER]: record(b.port, tokenB) }, slowRegistry())).toBe(0);
    } finally {
      await a.close();
      await b.close();
    }
    expect(a.posts(), "the first deck missed the event").toBe(1);
    expect(b.posts(), "the second deck missed the event").toBe(1);
  }, 15_000);

  it("does not wait on a record that never answers, beside one that is only slow", async () => {
    // The second window ends at its own deadline with whatever answered, like
    // the first — so a stalled record costs the slow deck beside it 800ms of
    // discovery, not the event.
    const token = randomBytes(32).toString("hex");
    const deck = await listener(honestDeck(token));
    try {
      expect(await fire(
        { [LIVE]: record(deck.port, token), [OTHER]: record(1, randomBytes(32).toString("hex")) },
        slowRegistry(OTHER),
      )).toBe(0);
    } finally {
      await deck.close();
    }
    expect(deck.posts(), "a stalled record took the event from the slow deck beside it").toBe(1);
  }, 15_000);
});
