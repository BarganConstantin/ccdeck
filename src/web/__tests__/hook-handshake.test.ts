// Reported: a discovery file outlives the deck that wrote it — SIGKILL, a power
// cut, anything that skips the shutdown path — and the only staleness check
// anywhere is a signal-0 probe of the recorded pid. Once the OS recycles that
// pid onto a long-lived process the file passes forever, while the port it
// names may by then belong to something else entirely (4317, the deck's own
// default, is also the standard OTLP collector port). Every hook event from
// every session — prompt text, tool inputs, tool results, cwd — was then POSTed
// there before a single byte of response was read.
//
// The fix makes the listener prove it is the deck that wrote the file: the deck
// stores a per-start random token there, and the hook sends nothing until the
// port hashes that token against a nonce it has never seen. These tests pin
// both halves — that an honest deck still receives events, and that a stranger
// on the port receives nothing but the challenge.
import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { rmTempDir } from "./rm-temp-dir";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// hook.js is CommonJS inside a "type": "module" package, so it only loads as
// itself once outside that tree — which is also the only way it ever runs, the
// installer having copied it into the Claude config dir. A .cjs copy reproduces
// that without an install, and requiring it starts nothing: main() is behind
// require.main.
const HOOK = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "hook", "hook.js");
const ROOT = mkdtempSync(join(tmpdir(), "ccdeck-handshake-"));
const COPY = join(ROOT, "hook.cjs");
copyFileSync(HOOK, COPY);

const hook = createRequire(import.meta.url)(COPY) as {
  challengeProof: (token: string, nonce: string) => string;
  requiresProof: (d: { token?: unknown }) => boolean;
};
// @ts-expect-error — .mjs server module, no types
const { challengeProof, hookToken } = await import("../../server/index.mjs");

afterAll(() => rmTempDir(ROOT));

type Seen = { method: string; path: string; body: string };

/** A listener plus a log of everything the hook said to it. */
async function listener(handler: (req: IncomingMessage, res: ServerResponse, seen: Seen) => void) {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    const entry: Seen = { method: req.method ?? "", path: req.url ?? "", body: "" };
    seen.push(entry);
    // Decoded as a stream, so a character split across two TCP reads arrives
    // whole: `+=` on raw Buffers would decode each one alone and put U+FFFD in
    // the body before the hook's own decoding was ever in question.
    req.setEncoding("utf8");
    req.on("data", c => { entry.body += c; });
    // The hook hangs up on some of the listeners below; an unhandled stream
    // error would then take the whole test worker down with it.
    req.on("error", () => {});
    res.on("error", () => {});
    handler(req, res, entry);
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  const close = () => new Promise<void>(done => {
    // One of the listeners below never answers, so a socket may still be half
    // open when the hook gives up; close() alone would wait on it.
    server.closeAllConnections?.();
    server.close(() => done());
  });
  return { seen, port, close };
}

/** A listener that answers the challenge the way a real deck does. */
function honestDeck(token: string) {
  return (req: IncomingMessage, res: ServerResponse, entry: Seen) => {
    const url = new URL(entry.path, "http://127.0.0.1");
    if (url.pathname === "/api/hook-challenge") {
      const proof = challengeProof(token, url.searchParams.get("nonce"));
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ proof }));
    }
    req.on("end", () => res.writeHead(200).end());
  };
}

const PROMPT = "SECRET-PROMPT-do-not-leak";
const EVENT = { cwd: process.cwd(), hook_event_name: "UserPromptSubmit", prompt: PROMPT };

/**
 * Run the installed-shape hook against a discovery dir of our own, with the
 * config dir override pointed at a temp tree — the real ~/.claude is never read
 * or written by any of this, on any platform.
 */
async function runHook(discovery: Record<string, unknown>, event: Record<string, unknown> = EVENT) {
  const home = mkdtempSync(join(ROOT, "home-"));
  const dir = join(home, "agent-dag");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify(discovery), "utf8");

  const child = spawn(process.execPath, [COPY, "--provider", "claude"], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: home, HOME: home, USERPROFILE: home },
    stdio: ["pipe", "ignore", "ignore"],
  });
  child.stdin.end(JSON.stringify(event));
  await new Promise<void>((done, fail) => {
    child.on("error", fail);
    child.on("exit", () => done());
  });
}

/**
 * A pid that is certainly not running. Picking a number and hoping is not
 * cross-platform — pid spaces and recycling differ per OS — so we run a process
 * that does nothing and wait for it to exit, which leaves its number free on
 * Linux, macOS and Windows alike.
 */
async function deadPid() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise<void>((done, fail) => {
    child.on("error", fail);
    child.on("exit", () => done());
  });
  return child.pid as number;
}

// A discovery file for a deck that is alive (our own pid) and machine-wide
// (empty workspace matches every cwd) — everything except identity is in order,
// so identity is the only thing under test.
const discoveryFor = (port: number, token: string) => ({
  pid: process.pid,
  port,
  workspace: "",
  token,
  startedAt: new Date().toISOString(),
});

/** A registry of several records, kept so a second run sees what the first left. */
function registryOf(records: Record<string, Record<string, unknown>>) {
  const home = mkdtempSync(join(ROOT, "home-"));
  const dir = join(home, "agent-dag");
  mkdirSync(dir, { recursive: true });
  for (const [name, record] of Object.entries(records)) {
    writeFileSync(join(dir, name), JSON.stringify(record), "utf8");
  }
  return { home, dir };
}

/**
 * Run the hook once against a registry from registryOf, optionally behind a
 * `-r` preload — the way hook-budget.test.ts injects what this machine cannot
 * produce on demand. Hands back the exit code and the wall time.
 */
async function fire(home: string, { preload }: { preload?: string } = {}) {
  const args = [COPY, "--provider", "claude"];
  if (preload) {
    const file = join(home, "preload.cjs");
    writeFileSync(file, preload, "utf8");
    args.unshift("-r", file);
  }
  const t0 = Date.now();
  const child = spawn(process.execPath, args, {
    env: { ...process.env, CLAUDE_CONFIG_DIR: home, HOME: home, USERPROFILE: home },
    stdio: ["pipe", "ignore", "ignore"],
  });
  child.stdin.end(JSON.stringify(EVENT));
  const code = await new Promise<number | null>((done, fail) => {
    child.on("error", fail);
    child.on("exit", c => done(c));
  });
  return { code, wallMs: Date.now() - t0 };
}

// A numbered name, because the hook reads nothing else, and one that is not
// the live record's name and does not contain it.
const GHOST = `${process.pid}0.json`;
const LIVE = `${process.pid}.json`;

describe("the hook and the deck derive the same proof", () => {
  // hook.js cannot import from src/ — it runs standalone once installed — so the
  // function is written twice. If the copies ever drift the deck goes silently
  // blind, which is precisely the failure this whole mechanism is meant to make
  // impossible to reach by accident.
  it("agrees on the proof for a token and nonce", () => {
    const token = randomBytes(32).toString("hex");
    const nonce = randomBytes(16).toString("hex");
    expect(hook.challengeProof(token, nonce)).toBe(challengeProof(token, nonce));
  });

  it("gives a different answer for a different nonce or token", () => {
    const token = randomBytes(32).toString("hex");
    const a = hook.challengeProof(token, "nonce-a");
    expect(a).not.toBe(hook.challengeProof(token, "nonce-b"));
    expect(a).not.toBe(hook.challengeProof(randomBytes(32).toString("hex"), "nonce-a"));
  });

  it("gives every deck process a token of its own", () => {
    expect(hookToken()).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("a deck that proves itself", () => {
  it("still receives the event", async () => {
    const token = randomBytes(32).toString("hex");
    const deck = await listener(honestDeck(token));
    try {
      await runHook(discoveryFor(deck.port, token));
    } finally {
      await deck.close();
    }

    const posts = deck.seen.filter(s => s.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0].path).toBe("/api/event");
    expect(JSON.parse(posts[0].body)).toMatchObject({
      hook_event_name: "UserPromptSubmit",
      prompt: PROMPT,
      provider: "claude",
    });
  }, 10_000);

  it("is challenged on a fresh nonce every time", async () => {
    const token = randomBytes(32).toString("hex");
    const deck = await listener(honestDeck(token));
    try {
      await runHook(discoveryFor(deck.port, token));
      await runHook(discoveryFor(deck.port, token));
    } finally {
      await deck.close();
    }

    const nonces = deck.seen
      .filter(s => s.path.startsWith("/api/hook-challenge"))
      .map(s => new URL(s.path, "http://127.0.0.1").searchParams.get("nonce"));
    expect(nonces).toHaveLength(2);
    expect(nonces[0]).toBeTruthy();
    expect(nonces[0]).not.toBe(nonces[1]);
  }, 10_000);

  it("receives a prompt that crosses stdin's chunk boundaries character for character", async () => {
    // Claude Code writes the event down a pipe, and the hook reads it in chunks
    // of 64 KB or so, wherever those happen to fall. Around 360 KB of two-,
    // three- and four-byte characters puts one across almost every boundary.
    // hook.js decodes stdin as one UTF-8 stream (`setEncoding`), which holds a
    // split sequence over to the next chunk; decoding each chunk alone — `+=` on
    // the raw Buffers — turns both halves into U+FFFD. JSON.parse takes that
    // without complaint, so nothing fails: the prompt is simply wrong on the
    // canvas and in events.jsonl, and every replay draws it wrong again. Every
    // other payload in the suite was small and ASCII.
    const prompt = "é€🙂".repeat(40_000);
    const token = randomBytes(32).toString("hex");
    const deck = await listener(honestDeck(token));
    try {
      await runHook(discoveryFor(deck.port, token), { ...EVENT, prompt });
    } finally {
      await deck.close();
    }

    const posts = deck.seen.filter(s => s.method === "POST");
    expect(posts).toHaveLength(1);
    const got = JSON.parse(posts[0].body).prompt as string;
    expect(got.includes("\uFFFD"), "a character split across two chunks was decoded in halves").toBe(false);
    // Compared as a boolean: a diff of two 120,000-character strings says less.
    expect(got === prompt, "the prompt did not arrive as it was sent").toBe(true);
  }, 10_000);
});

describe("a stranger on the recorded port", () => {
  // The reported scenario: the deck died uncleanly, the pid was recycled onto
  // some other long-lived process, and the port now belongs to an unrelated
  // local service. Whatever that service does with the challenge, it must not
  // end up holding the user's prompt.
  const strangers: Array<[string, (req: IncomingMessage, res: ServerResponse) => void]> = [
    ["one that knows nothing of the deck's API", (_req, res) => {
      res.writeHead(404).end("not found");
    }],
    ["one that answers with a proof it guessed", (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ proof: randomBytes(32).toString("hex") }));
    }],
    ["one that echoes whatever it is asked for", (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ proof: req.url }));
    }],
    ["one that answers with a flood of data", (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(`{"proof":"${"a".repeat(200_000)}"}`);
    }],
    ["one that accepts the connection and says nothing", () => { /* hangs until the hook gives up */ }],
  ];

  for (const [what, handler] of strangers) {
    it(`gets the challenge and nothing else — ${what}`, async () => {
      const stranger = await listener(handler);
      try {
        // The token in the file belongs to the deck that died; the stranger has
        // never seen it.
        await runHook(discoveryFor(stranger.port, randomBytes(32).toString("hex")));
      } finally {
        await stranger.close();
      }

      expect(stranger.seen.length).toBeGreaterThan(0);
      expect(stranger.seen.every(s => s.method === "GET")).toBe(true);
      expect(stranger.seen.every(s => s.path.startsWith("/api/hook-challenge"))).toBe(true);
      const said = JSON.stringify(stranger.seen);
      expect(said).not.toContain(PROMPT);
      expect(said).not.toContain("UserPromptSubmit");
    }, 10_000);
  }
});

describe("a discovery file with no token at all", () => {
  // WRITTEN BY A DECK FROM BEFORE THE HANDSHAKE, and no longer trusted.
  //
  // hook.js is one shared file installed by whichever deck booted last, and
  // several decks at once is ordinary use, so this hook used to meet tokenless
  // files constantly — which is why #173 gave them the pre-handshake rule: pid
  // liveness, then post. That fallback carried its own retirement condition in
  // as many words: drop it "once no deck older than 1.33.71 is plausibly still
  // running". This package is on 3.x, two majors past it.
  //
  // What it cost while it stood: a control an adversary switches off by leaving
  // a key out of a JSON file. The ordinary cases it also covered — a stale file
  // from a deck that is gone, a port another program has taken — are better
  // served by refusing too.
  it("gets nothing, because it cannot prove anything", async () => {
    const token = randomBytes(32).toString("hex");
    const deck = await listener(honestDeck(token));
    try {
      const { token: _dropped, ...untokened } = discoveryFor(deck.port, token);
      await runHook(untokened);
      await runHook({ ...untokened, token: "" });
    } finally {
      await deck.close();
    }
    // The challenge is attempted and the payload is not sent: this deck answers
    // it (it is the honest one), but the FILE advertised no token, so the hook
    // has nothing to check the answer against.
    expect(deck.seen.filter(s => s.method === "POST")).toHaveLength(0);
  }, 10_000);

  it("is asked for proof like every other target", () => {
    expect(hook.requiresProof({ token: randomBytes(32).toString("hex") })).toBe(true);
    expect(hook.requiresProof({})).toBe(true);
    expect(hook.requiresProof({ token: "" })).toBe(true);
  });

  it("is refused when its pid is dead, before any of that", async () => {
    const token = randomBytes(32).toString("hex");
    const deck = await listener(honestDeck(token));
    try {
      const { token: _dropped, ...untokened } = discoveryFor(deck.port, token);
      await runHook({ ...untokened, pid: await deadPid() });
    } finally {
      await deck.close();
    }
    expect(deck.seen).toHaveLength(0);
  }, 10_000);
});

/** A preload that makes signal 0 to `pid` fail with `code`, and leaves every other kill alone. */
const killAnswers = (pid: number, code: string) => `
const kill = process.kill;
process.kill = function (pid, signal) {
  if (pid === ${pid} && signal === 0) {
    throw Object.assign(new Error("kill ${code}"), { code: ${JSON.stringify(code)} });
  }
  return kill.apply(process, arguments);
};
`;

describe("a record whose pid is gone", () => {
  // The one verdict here that DELETES something, and neither direction of it
  // was asserted. The dead-pid case above checks only that the deck is told
  // nothing, which a hook that no longer swept stale records passes too — and
  // then every event pays to read and resolve every one of them again.
  //
  // The other direction is a pid this account may not signal, which is ALIVE.
  // POSIX answers EPERM; Windows answers EACCES for a deck started elevated or
  // under another account, the spelling libuv gives ERROR_ACCESS_DENIED. When
  // EACCES read as dead, that deck's record was unlinked on every hook run and
  // written back five seconds later by keepDiscovery, and the deck missed most
  // events while its banner said it was connected. liveness-eacces.test.ts
  // looks for the spelling in the source and tests a copy of the predicate
  // written inside itself; neither errno can be produced here on demand, so a
  // `-r` preload makes signal 0 answer with it, for the one pid under test, and
  // the hook's own isAlive decides.
  async function withDeadRecord(code: string | null) {
    const token = randomBytes(32).toString("hex");
    const deck = await listener(honestDeck(token));
    // A deck that WOULD prove itself, so a record wrongly kept is visible as
    // requests on this port rather than only as a file left on disk.
    const ghostToken = randomBytes(32).toString("hex");
    const ghost = await listener(honestDeck(ghostToken));
    const pid = await deadPid();
    const dead = `${pid}.json`;
    const { home, dir } = registryOf({
      [LIVE]: discoveryFor(deck.port, token),
      [dead]: { ...discoveryFor(ghost.port, ghostToken), pid },
    });
    try {
      const { code: exit } = await fire(home, code ? { preload: killAnswers(pid, code) } : {});
      return {
        exit,
        deckPosts: deck.seen.filter(s => s.method === "POST").length,
        ghostSaw: ghost.seen.map(s => `${s.method} ${s.path.split("?")[0]}`),
        deadKept: existsSync(join(dir, dead)),
        liveKept: existsSync(join(dir, LIVE)),
      };
    } finally {
      await deck.close();
      await ghost.close();
    }
  }

  it("is deleted, and the port it names is asked nothing", async () => {
    const r = await withDeadRecord(null);
    expect(r.exit).toBe(0);
    expect(r.deadKept, "a dead pid's record is still on disk").toBe(false);
    expect(r.liveKept, "the live deck's record went with it").toBe(true);
    expect(r.ghostSaw).toEqual([]);
    expect(r.deckPosts, "the live deck beside it missed the event").toBe(1);
  }, 15_000);

  for (const [code, kept] of [["EACCES", true], ["EPERM", true], ["ESRCH", false]] as const) {
    it(`is ${kept ? "kept, and posted to," : "deleted"} when signal 0 answers ${code}`, async () => {
      const r = await withDeadRecord(code);
      expect(r.exit).toBe(0);
      expect(r.deadKept, `${code} read the wrong way round`).toBe(kept);
      expect(r.liveKept).toBe(true);
      expect(r.ghostSaw).toEqual(kept ? ["GET /api/hook-challenge", "POST /api/event"] : []);
      expect(r.deckPosts).toBe(1);
    }, 15_000);
  }
});

describe("a discovery file that does carry a token", () => {
  // The fallback above must not become a way around the handshake: a file that
  // advertises a token is still held to it, and a listener that answers wrongly
  // is told nothing.
  it("gets no payload when the port answers the challenge wrongly", async () => {
    const wrong = await listener((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ proof: challengeProof(randomBytes(32).toString("hex"), "nonce") }));
    });
    try {
      await runHook(discoveryFor(wrong.port, randomBytes(32).toString("hex")));
    } finally {
      await wrong.close();
    }

    expect(wrong.seen).toHaveLength(1);
    expect(wrong.seen[0].method).toBe("GET");
    expect(wrong.seen[0].path).toMatch(/^\/api\/hook-challenge\?nonce=/);
    expect(JSON.stringify(wrong.seen)).not.toContain(PROMPT);
  }, 10_000);
});

describe("a deck that is simply too busy to answer in time", () => {
  // A wrong proof, a refused connection and a 404 are verdicts — that port is
  // not the deck the record describes, and asking twice gets the same answer.
  // A DEADLINE is not: it is a machine too loaded to reply inside 400ms, and
  // the deck on the other side is fine. Measured on the Windows box, the repo's
  // own suite (335 files in parallel) is enough load to produce it, and the
  // event was then dropped with nothing on screen to say so.
  it("is challenged a second time, and gets the event", async () => {
    const token = randomBytes(32).toString("hex");
    let challenges = 0;
    const deck = await listener((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/api/hook-challenge") {
        challenges += 1;
        // The first attempt is answered too late for the hook's 400ms window;
        // the second is answered at once.
        const nonce = url.searchParams.get("nonce") ?? "";
        const proof = challengeProof(token, nonce);
        if (challenges === 1) {
          setTimeout(() => { try { res.end(JSON.stringify({ proof })); } catch { /* hung up */ } }, 700);
          return;
        }
        return res.end(JSON.stringify({ proof }));
      }
      res.end("{}");
    });
    try {
      await runHook(discoveryFor(deck.port, token));
    } finally {
      await deck.close();
    }
    expect(challenges, "the slow challenge was not retried").toBe(2);
    expect(deck.seen.filter(s => s.method === "POST")).toHaveLength(1);
  }, 15_000);

  it("gives up after the second deadline rather than trying forever", async () => {
    // The retry is one, not a loop: the hook runs inside Claude Code's turn and
    // has a hard cap of its own.
    const token = randomBytes(32).toString("hex");
    let challenges = 0;
    const deck = await listener((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/api/hook-challenge") { challenges += 1; return; }  // never answers
      res.end("{}");
    });
    try {
      await runHook(discoveryFor(deck.port, token));
    } finally {
      await deck.close();
    }
    expect(challenges).toBe(2);
    expect(deck.seen.filter(s => s.method === "POST")).toHaveLength(0);
  }, 15_000);
});

describe("a stranger that answers at a pace of its own, beside a deck that proves itself", () => {
  // Every challenge is settled before anything is posted (#695), so a target
  // whose challenge never settles takes the event from every deck on the
  // machine. The silent port is covered below; these are the shapes that got
  // past the two limits prove() has.
  //
  // The DEADLINE was http.request's `timeout`, which is an idle timeout. A port
  // that sends a byte every 150ms is never idle, and a port that sends a status
  // line and then goes quiet does go idle — but once a response has begun,
  // destroying the request raises no error on it, so no verdict came either
  // way. Measured with an honest deck beside such a port: the hook ran to its
  // cap at 1938ms, the deck saw its challenge and no event, and that was every
  // tool call for as long as the record stood. The deadline now bounds the
  // whole answer and gives the verdict itself.
  //
  // The CAP is the 4096 bytes a deck's ~100-byte answer never reaches. The 200
  // KB flood in "a stranger on the recorded port" ends its response, so it
  // settled on its own and passed with the cap deleted; a flood that never ends
  // is the one only the cap can stop.
  //
  // An event posted at all is an event posted before the cap: main()'s timer
  // ends the process there, with nothing sent after it.

  /** A 200 that writes `chunk` every `everyMs` and never ends. */
  const streaming = (chunk: string, everyMs: number) => (_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    const timer = setInterval(() => res.write(chunk), everyMs);
    res.on("close", () => clearInterval(timer));
  };

  async function beside(handler: (req: IncomingMessage, res: ServerResponse) => void) {
    const token = randomBytes(32).toString("hex");
    const deck = await listener(honestDeck(token));
    const stranger = await listener(handler);
    const { home } = registryOf({
      [LIVE]: discoveryFor(deck.port, token),
      [GHOST]: discoveryFor(stranger.port, randomBytes(32).toString("hex")),
    });
    try {
      const { code } = await fire(home);
      return {
        code,
        deckPosts: deck.seen.filter(s => s.method === "POST").length,
        challenges: stranger.seen.length,
      };
    } finally {
      await deck.close();
      await stranger.close();
    }
  }

  it("cuts a flood off at the cap, which is a verdict and is asked once", async () => {
    // 64 KB every 5ms. Cut off at the cap, the port has answered — it is not a
    // deck — and is asked once. Without the cap it runs into the deadline, which
    // is not an answer, and is asked again: two challenges, and the event waits
    // 800ms behind a port that was never going to be a deck.
    const r = await beside(streaming("a".repeat(64 * 1024), 5));
    expect(r.code).toBe(0);
    expect(r.challenges, "the flood was not cut off at 4096 bytes").toBe(1);
    expect(r.deckPosts, "the deck that proved itself missed the event").toBe(1);
  }, 15_000);

  it("gives up on an answer that trickles in, and the deck beside it still gets the event", async () => {
    const r = await beside(streaming("a", 150));
    expect(r.code).toBe(0);
    expect(r.deckPosts, "the trickle held the event past the cap").toBe(1);
    // A deadline, like a silent port's: retried once, then given up on.
    expect(r.challenges).toBe(2);
  }, 15_000);

  it("gives up on an answer that starts and then stops", async () => {
    const r = await beside((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"proof":"');
    });
    expect(r.code).toBe(0);
    expect(r.deckPosts, "a half-sent answer held the event past the cap").toBe(1);
    expect(r.challenges).toBe(2);
  }, 15_000);
});

describe("a record no running deck is keeping, on a port that answers nothing", () => {
  // #1069. A record whose pid the OS recycled onto a live process passes the
  // only staleness test there was, for good — and when its port has something
  // behind it that accepts and never answers, every event paid both challenge
  // deadlines for it, and every honest deck's POST waited behind the barrier:
  // 833ms on every tool call, measured, permanently. A running deck stamps its
  // record every five seconds (ensureDiscovery), so a record that is silent AND
  // has gone a minute unstamped is one nobody is keeping.

  const age = (file: string, ms: number) => {
    const then = new Date(Date.now() - ms);
    utimesSync(file, then, then);
  };

  it("is forgotten after the event it costs, so the next event does not pay for it again", async () => {
    const token = randomBytes(32).toString("hex");
    const deck = await listener(honestDeck(token));
    const silent = await listener(() => { /* accepts, never answers */ });
    const { home, dir } = registryOf({
      [LIVE]: discoveryFor(deck.port, token),
      [GHOST]: discoveryFor(silent.port, randomBytes(32).toString("hex")),
    });
    age(join(dir, GHOST), 10 * 60_000);
    try {
      await fire(home);
      expect(silent.seen, "the silent port was not given its two deadlines").toHaveLength(2);
      expect(existsSync(join(dir, GHOST)), "a silent record nobody has stamped for ten minutes is still on disk").toBe(false);

      await fire(home);
      expect(silent.seen, "the second event paid for the same ghost again").toHaveLength(2);
      expect(deck.seen.filter(s => s.method === "POST"), "the deck that answered missed an event").toHaveLength(2);
      expect(existsSync(join(dir, LIVE)), "the live deck's own record went with it").toBe(true);
    } finally {
      await deck.close();
      await silent.close();
    }
  }, 20_000);

  it("is kept while something is still stamping it, however late its answers", async () => {
    // The case the deadline retry exists for: a deck too loaded to answer inside
    // 400ms twice is still running its five-second check, so its record is fresh
    // and it gets asked again on the next event.
    const token = randomBytes(32).toString("hex");
    const deck = await listener(honestDeck(token));
    const busy = await listener(() => { /* too busy to answer in time */ });
    const { home, dir } = registryOf({
      [LIVE]: discoveryFor(deck.port, token),
      [GHOST]: discoveryFor(busy.port, randomBytes(32).toString("hex")),
    });
    try {
      await fire(home);
      expect(busy.seen).toHaveLength(2);
      expect(existsSync(join(dir, GHOST)), "a record stamped a moment ago was treated as abandoned").toBe(true);
    } finally {
      await deck.close();
      await busy.close();
    }
  }, 20_000);

  it("is kept when its port refuses, however long ago it was stamped", async () => {
    // A refusal is a verdict that costs nothing, and it is also what a deck
    // restarting under its supervisor gives for a moment. Only the silent port
    // was ever expensive, so only the silent port is grounds for forgetting.
    const token = randomBytes(32).toString("hex");
    const deck = await listener(honestDeck(token));
    const gone = await listener(() => {});
    const refused = gone.port;
    await gone.close();
    const { home, dir } = registryOf({
      [LIVE]: discoveryFor(deck.port, token),
      [GHOST]: discoveryFor(refused, randomBytes(32).toString("hex")),
    });
    age(join(dir, GHOST), 10 * 60_000);
    try {
      await fire(home);
      expect(deck.seen.filter(s => s.method === "POST")).toHaveLength(1);
      expect(existsSync(join(dir, GHOST)), "a refused port was taken as proof the deck is gone").toBe(true);
    } finally {
      await deck.close();
    }
  }, 20_000);
});
