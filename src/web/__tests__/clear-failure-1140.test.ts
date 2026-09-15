// #1140: a Clear that could not empty the event log says so.
//
// The `/api/clear` reply was decided by ownership alone — `log: "cleared"` for
// any log this deck owns — while the work it describes, emptyLog's truncate,
// swallowed its own error so the append queue keeps moving. On a volume that
// refused the truncate, the page was told the history was gone and the next
// boot replayed every line of it.
//
// The truncate is made to fail by swapping the log file for a DIRECTORY of the
// same name after the deck has booted. A directory refuses a truncate for every
// user, root included, and on all three CI systems, so nothing here needs a
// platform or privilege gate. The swap has to come after the boot: a deck handed
// a directory as its log refuses it while reading it back at startup
// (`EISDIR ... read`), long before any Clear could be pressed.
//
// The same trick covers the archive. An archive path that is a non-empty
// DIRECTORY cannot be removed as a file, by anyone, on any of the three systems,
// while the live log still truncates. An archive that survives a Clear is the
// whole history again at the next boot, so that half is reported too.

import { describe, it, expect, afterAll, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Sandbox first, module import second, as log-lifecycle-1130.test.ts does and
// for its reasons: the server resolves its config and Codex homes at import.
const BASE = process.platform === "win32" ? tmpdir() : "/var/tmp";
const SANDBOX = mkdtempSync(join(BASE, "ccdeck-clear-failure-1140-"));
const CONFIG = join(SANDBOX, "claude");
const PREV: Record<string, string | undefined> = {};
for (const k of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME"]) PREV[k] = process.env[k];
process.env.HOME = SANDBOX;
process.env.USERPROFILE = SANDBOX;
process.env.CLAUDE_CONFIG_DIR = CONFIG;
process.env.CODEX_HOME = join(SANDBOX, "codex");
process.env.XDG_CONFIG_HOME = join(SANDBOX, "xdg");
mkdirSync(join(CONFIG, "agent-dag"), { recursive: true });
mkdirSync(join(SANDBOX, "codex"), { recursive: true });

// @ts-expect-error — plain .mjs server module, no types
const { emptyLog } = await import("../../server/log-writer.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { startServer, hookToken } = await import("../../server/index.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { claudeConfigDir } = await import("../../server/claude-dir.mjs");

if (!resolve(String(claudeConfigDir())).startsWith(resolve(CONFIG))) {
  throw new Error(`refusing to run: resolved ${claudeConfigDir()}, outside ${CONFIG}`);
}

type Outcome = { error?: (Error & { code?: string }) | null; archiveError?: (Error & { code?: string }) | null };
const empty = emptyLog as (file: string, archives?: string[], ms?: number, outcome?: Outcome) => Promise<boolean>;
const headers = () => ({ "content-type": "application/json", "x-ccdeck-token": (hookToken as () => string)() });

// Fixed and never reused inside this file, for the reason log-lifecycle-1130
// gives: no case binds a port another has only just released.
const PORT_REFUSED = 4660;
const PORT_EMPTIED = 4661;
const PORT_ARCHIVE = 4662;

async function boot(port: number, persist: string): Promise<Server> {
  return await (startServer as (o: Record<string, unknown>) => Promise<Server>)({
    port, host: "127.0.0.1", persist, codex: false, claude: false, portRange: [port, port],
  });
}

async function stop(deck: Server | null): Promise<void> {
  if (!deck) return;
  deck.closeAllConnections?.();
  await new Promise<void>(done => deck.close(() => done()));
}

async function clear(port: number): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${port}/api/clear`, { method: "POST", headers: headers(), body: "{}" });
  return await res.json() as Record<string, unknown>;
}

afterAll(() => {
  for (const k of Object.keys(PREV)) {
    if (PREV[k] === undefined) delete process.env[k];
    else process.env[k] = PREV[k];
  }
  rmTempDir(SANDBOX);
});

describe("emptyLog's outcome", () => {
  it("carries the truncate's failure instead of swallowing it", async () => {
    const dir = join(SANDBOX, "not-a-file");
    mkdirSync(dir, { recursive: true });
    const outcome: Outcome = {};
    expect(await empty(dir, [], 3000, outcome)).toBe(true);
    expect(outcome.error, "a truncate that failed is reported").toBeTruthy();
  });

  it("reports a file that is not there as already empty, and an emptied one as done", async () => {
    const missing: Outcome = {};
    await empty(join(SANDBOX, "never-written.jsonl"), [], 3000, missing);
    expect(missing.error).toBeNull();

    const file = join(SANDBOX, "some.jsonl");
    writeFileSync(file, "one line\n");
    const done: Outcome = {};
    await empty(file, [], 3000, done);
    expect(done.error).toBeNull();
    expect(readFileSync(file, "utf8")).toBe("");
  });

  it("carries an archive it could not remove, and counts a missing one as removed", async () => {
    const live = join(SANDBOX, "with-archive.jsonl");
    writeFileSync(live, "one line\n");
    const stuck = live + ".1";
    mkdirSync(join(stuck, "inside"), { recursive: true });   // a directory is not removed as a file
    const outcome: Outcome = {};
    await empty(live, [stuck], 3000, outcome);
    expect(outcome.error, "the live log itself emptied").toBeNull();
    expect(outcome.archiveError, "the archive that stayed is reported").toBeTruthy();

    const gone: Outcome = {};
    await empty(live, [join(SANDBOX, "no-such-archive.jsonl.1")], 3000, gone);
    expect(gone.archiveError).toBeNull();
  });
});

describe("a Clear whose log refused the truncate", () => {
  let deck: Server | null = null;
  afterAll(() => stop(deck));

  it("answers that the log was not emptied, and says so in the terminal", async () => {
    const refused = join(SANDBOX, "deck-refused", "events.jsonl");
    mkdirSync(join(SANDBOX, "deck-refused"), { recursive: true });
    writeFileSync(refused, "");
    deck = await boot(PORT_REFUSED, refused);
    // Now the file becomes a directory: nothing has been posted, so the deck holds
    // no handle on it, and the only thing left to touch the path is Clear's truncate.
    rmSync(refused);
    mkdirSync(refused);
    const said = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const reply = await clear(PORT_REFUSED);
      expect(reply.ok, "the canvas was still cleared").toBe(true);
      expect(reply.log).toBe("failed");
      expect(typeof reply.error).toBe("string");
      const lines = said.mock.calls.map(c => String(c[0])).filter(s => s.includes("Clear could not empty the event log"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(refused);
    } finally {
      said.mockRestore();
    }
  });
});

describe("a Clear whose log emptied", () => {
  let deck: Server | null = null;
  afterAll(() => stop(deck));

  it("still answers cleared, with no error and nothing said", async () => {
    const persist = join(SANDBOX, "deck-emptied", "events.jsonl");
    mkdirSync(join(SANDBOX, "deck-emptied"), { recursive: true });
    writeFileSync(persist, "");
    deck = await boot(PORT_EMPTIED, persist);
    const said = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const reply = await clear(PORT_EMPTIED);
      expect(reply.log).toBe("cleared");
      expect(reply).not.toHaveProperty("error");
      expect(said.mock.calls.filter(c => String(c[0]).includes("Clear could not"))).toEqual([]);
    } finally {
      said.mockRestore();
    }
  });
});

describe("a Clear whose log's archive could not be removed", () => {
  let deck: Server | null = null;
  afterAll(() => stop(deck));

  it("answers that the log was not cleared, and names the archive in the terminal", async () => {
    const persist = join(SANDBOX, "deck-archive", "events.jsonl");
    mkdirSync(join(SANDBOX, "deck-archive"), { recursive: true });
    writeFileSync(persist, "");
    deck = await boot(PORT_ARCHIVE, persist);
    // After the boot, for the reason the refused case gives: the archive becomes
    // a directory with something in it, which no unlink removes. The live log is
    // an ordinary file and truncates.
    mkdirSync(join(persist + ".1", "inside"), { recursive: true });
    const said = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const reply = await clear(PORT_ARCHIVE);
      expect(reply.ok, "the canvas was still cleared").toBe(true);
      expect(reply.log).toBe("failed");
      expect(typeof reply.error).toBe("string");
      const lines = said.mock.calls.map(c => String(c[0])).filter(s => s.includes("Clear could not remove the event log's archive"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(persist + ".1");
    } finally {
      said.mockRestore();
    }
  });
});
