// EVERY FAILED APPEND TO events.jsonl WAS DISCARDED WITH NOTHING SAID.
//
// `appendLogLine`'s chain ended in `.catch(() => {})`, and that was the only
// handler anywhere on the path. A failing `open(filePath, "a")` — EROFS on a
// read-only volume, ENOSPC on a full one, EACCES or ENOTDIR on a directory
// whose permissions or type changed under the deck, ENOENT on a removable
// drive unmounted while it ran — was indistinguishable from a successful append
// from every vantage point in the process.
//
// MEASURED, on a sandboxed deck whose `--history` named a file inside a
// directory the user cannot write:
//
//   POST /api/event acknowledged: 10 of 10
//   log file on disk?             false
//   /api/health mentions the log? false
//   /api/version canRestart:      true
//
// Ten events the deck told the hook it had recorded, zero bytes on disk, not
// one character on any console, and the Restart button still offering itself.
//
// That last line is the one that costs. `_canRestart` existed precisely BECAUSE
// a restart without a log wipes the canvas irrecoverably — and it was a test of
// CONFIGURATION, `_onRestart != null && persist != null`, not of whether a log
// was being written. The press then landed on replayLog's
// `if (!existsSync(filePath)) return 0` and took the entire session history
// with it: exactly the loss the flag was added to prevent, reached through the
// one door it does not watch.
//
// Three things to pin, each breakable without touching the other two:
//
//   1. THE COUNTER. A failure is counted where it happens, and the count is
//      readable without watching a canvas come back empty.
//   2. THE LINE. One stderr line per episode — not one per failure, which on a
//      read-only log would be thousands of lines onto the terminal the deck
//      paints its own banner over, and not one per process, which would report
//      the first outage of a long-lived deck and stay silent through every
//      later one. The episode closes on the next append that lands, and says
//      how large the hole was.
//   3. THE GATE. The button that promises the history survives a restart offers
//      itself only while the history is actually being written, and the refusal
//      names the real reason rather than borrowing "no_persist" from a user who
//      did pass `--history`.
//
// HOW THE FAILURE IS FORCED, portably. The parent of the log path is an
// ordinary FILE, so `mkdir(parent, { recursive: true })` cannot create it and
// `open(path, "a")` cannot open through it — on POSIX and on Windows alike. A
// read-only directory is the more faithful reproduction and is also the one
// that does nothing at all on Windows, where directory permission bits are not
// what decides this; the suite runs on three operating systems.
import { describe, it, expect, afterAll, vi } from "vitest";
import { mkdirSync, mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { createServer } from "node:net";
import type { AddressInfo, Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Sandbox first, module import second: the server resolves its config dir, its
// Codex home and its discovery directory at import time. HOME and USERPROFILE
// together cover POSIX and Windows; nothing in this file can reach the
// developer's own ~/.claude, ~/.codex or ~/.agents-deck.
const SANDBOX = mkdtempSync(join(tmpdir(), "ccdeck-append-fail-991-"));
const CONFIG = join(SANDBOX, "claude");
const CODEX = join(SANDBOX, "codex");
const PREV: Record<string, string | undefined> = {};
for (const k of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME"]) PREV[k] = process.env[k];
process.env.HOME = SANDBOX;
process.env.USERPROFILE = SANDBOX;
process.env.CLAUDE_CONFIG_DIR = CONFIG;
process.env.CODEX_HOME = CODEX;
process.env.XDG_CONFIG_HOME = join(SANDBOX, "xdg");
mkdirSync(join(CONFIG, "agent-dag"), { recursive: true });
mkdirSync(CODEX, { recursive: true });

// @ts-expect-error — plain .mjs server module, no types
const { appendLogLine, appendFailureStats } = await import("../../server/log-writer.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { startServer, hookToken } = await import("../../server/index.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { claudeConfigDir } = await import("../../server/claude-dir.mjs");

// Belt and braces. Every assertion below is about a log file being written or
// not written; if an override had not taken, this file would be appending to
// the developer's real event log.
if (!resolve(String(claudeConfigDir())).startsWith(resolve(CONFIG))) {
  throw new Error(`refusing to run: resolved ${claudeConfigDir()}, outside ${CONFIG}`);
}

const append = appendLogLine as (file: string, line: string) => Promise<void>;
const failures = appendFailureStats as (file?: string | null) => {
  failedLines: number; failedChars: number; failing: number;
};

/** A log path nothing can create or open: its parent is a file. */
function blockedLog(name: string): string {
  const blocker = join(SANDBOX, name);
  writeFileSync(blocker, "not a directory\n");
  return join(blocker, "events.jsonl");
}

/** One free port. The same shape clear-shared-log-698 uses. */
function freePort(): Promise<number> {
  return new Promise(done => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => done(p));
    });
  });
}

afterAll(() => {
  for (const k of Object.keys(PREV)) {
    if (PREV[k] === undefined) delete process.env[k];
    else process.env[k] = PREV[k];
  }
  rmTempDir(SANDBOX);
});

describe("an append that cannot land", () => {
  it("counts every one of them, and says so once", async () => {
    const path = blockedLog("blocked-counted");
    const before = failures(path);
    // Collected as they are made, not read off the spy afterwards: mockRestore
    // discards the recorded calls with the mock.
    const lines: string[] = [];
    const said = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { lines.push(String(a[0])); });
    try {
      for (let i = 0; i < 6; i++) await append(path, JSON.stringify({ seq: i }) + "\n");
    } finally { said.mockRestore(); }

    expect(existsSync(path), "nothing was written, which is the premise").toBe(false);
    const after = failures(path);
    expect(after.failedLines - before.failedLines, "all six counted").toBe(6);
    expect(after.failedChars).toBeGreaterThan(before.failedChars);
    expect(after.failing, "this log is inside a failure episode").toBe(1);

    // One line for six failures. Per failure this would be one terminal line
    // per event the deck draws.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("cannot write the event log");
    expect(lines[0]).toContain("a restart will not bring them back");
  });

  it("closes the episode when the log works again, and names the size of the hole", async () => {
    // The interesting failures are transient: a volume that fills and is
    // emptied, a drive that is unplugged and returns. A path complained about
    // once and never again would report the first outage of a long-lived deck
    // and stay silent through every later one — so the episode ends on the
    // next append that LANDS, which is the only evidence available that the
    // condition is over.
    const dir = join(SANDBOX, "comes-back");
    const path = join(dir, "events.jsonl");
    const lines: string[] = [];
    const said = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { lines.push(String(a[0])); });
    try {
      await append(path, JSON.stringify({ seq: 1 }) + "\n");   // ENOENT: no dir
      await append(path, JSON.stringify({ seq: 2 }) + "\n");
      expect(failures(path).failing).toBe(1);
      mkdirSync(dir, { recursive: true });                      // the drive returns
      await append(path, JSON.stringify({ seq: 3 }) + "\n");
    } finally { said.mockRestore(); }

    expect(failures(path).failing, "the episode is over").toBe(0);
    expect(lines, "one line opening the episode, one closing it").toHaveLength(2);
    expect(lines[1]).toContain("works again");
    expect(lines[1], "the hole is two events, and the line says so").toContain("2 event(s)");
  });
});

describe("the Restart button on a log that is not being written", () => {
  let port = 0;
  let server: { close: (cb?: () => void) => void } | null = null;
  const token = () => (hookToken as () => string)();
  const url = (p: string) => `http://127.0.0.1:${port}${p}`;
  const get = (p: string) => fetch(url(p), { headers: { "x-ccdeck-token": token() } }).then(r => r.json());

  afterAll(() => { server?.close(); });

  /**
   * One deck, on a port of its own.
   *
   * The previous listener is awaited down and a FRESH port taken rather than
   * the same one reused, because `close()` releases its handle to libuv
   * asynchronously and Windows binds a listener with SO_EXCLUSIVEADDRUSE — so
   * rebinding the port on the next statement is an EADDRINUSE race, and one on
   * the leg this suite keeps a matrix for.
   */
  const boot = async (persist: string) => {
    const old = server;
    server = null;
    if (old) await new Promise<void>(done => old.close(() => done()));
    port = await freePort();
    server = await (startServer as (o: Record<string, unknown>) => Promise<Server>)({
      port, persist, codex: false, claude: false, portRange: [port, port], onRestart: () => {},
    }) as unknown as { close: (cb?: () => void) => void };
  };

  it("refuses the restart, reports the log, and says which of the two it is", async () => {
    const persist = blockedLog("blocked-deck");
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try { await boot(persist); } finally { quiet.mockRestore(); }

    // The premise, restated through the deck rather than the writer: events go
    // in and are acknowledged, and nothing reaches disk.
    for (let i = 0; i < 4; i++) {
      const ack = await fetch(url("/api/event"), {
        method: "POST",
        headers: { "content-type": "application/json", "x-ccdeck-token": token() },
        body: JSON.stringify({ hook_event_name: "PreToolUse", cwd: "/x", session_id: "s1", tool_name: "Bash", n: i }),
      }).then(r => r.json());
      expect(ack.ok, "the hook is told the event was taken").toBe(true);
    }
    await new Promise(r => setTimeout(r, 150));
    expect(existsSync(persist), "and none of it is on disk").toBe(false);

    const health = await get("/api/health");
    expect(health.log, "/api/health answers for the log at all").toBeTruthy();
    expect(health.log.writable, "the boot probe already knew").toBe(false);
    expect(health.log.failing, "and the appender knows it now").toBe(1);
    expect(health.log.failedLines).toBeGreaterThan(0);

    const version = await get("/api/version");
    expect(version.canRestart, "the button does not offer itself").toBe(false);

    // Enforced at the route as well as in the UI, because a destructive act
    // must not be prevented by a hidden button alone.
    const refused = await fetch(url("/api/restart"), {
      method: "POST", headers: { "content-type": "application/json", "x-ccdeck-token": token() }, body: "{}",
    });
    expect(refused.status).toBe(409);
    // Not "no_persist": this user DID pass --history, and telling them they
    // did not is the sort of answer that sends someone looking in the wrong
    // place for an hour.
    expect((await refused.json()).reason).toBe("log_unwritable");
  });

  it("still offers it when the log is genuinely being written", async () => {
    // The other half, and the one that says the gate is a gate rather than an
    // off switch: a healthy deck is unchanged.
    const persist = join(SANDBOX, "good", "events.jsonl");
    await boot(persist);
    const ack = await fetch(url("/api/event"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-ccdeck-token": token() },
      body: JSON.stringify({ hook_event_name: "PreToolUse", cwd: "/x", session_id: "ok", tool_name: "Bash" }),
    }).then(r => r.json());
    expect(ack.ok).toBe(true);
    await new Promise(r => setTimeout(r, 150));

    expect(existsSync(persist)).toBe(true);
    const health = await get("/api/health");
    expect(health.log.writable).toBe(true);
    expect(health.log.failing, "a path that failed earlier in this process does not veto this one").toBe(0);
    expect((await get("/api/version")).canRestart).toBe(true);
  });
});
