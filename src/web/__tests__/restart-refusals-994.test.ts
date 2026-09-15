// WHAT /api/restart REFUSES, AND IN WHICH WORDS (#994).
//
// Two of the route's refusals had never been asked for by any test. Searched
// for before this file: `upgrade: true` appeared once in this directory, as the
// source text of the button that sends it (press-rule-620), and "no_persist"
// only in two comments of append-failure-991's, explaining why ITS refusal
// uses a different word. So:
//
//   no_persist  A deck started with --no-persist has no log for replayLog to
//               read back, and a restart there takes the whole canvas with it.
//               The route refuses it as well as the UI hiding the button,
//               because a destructive act must not be prevented by a hidden
//               button alone — and nothing checked that the route did.
//
//   not_npx     `{ upgrade: true }` asks to come back through
//               `npx -y <spec>@latest` instead of re-running the files on disk.
//               It is granted only where that is how this copy updates, decided
//               from the install and never from the request. A copy that is not
//               running out of an npx cache — this checkout, which is what the
//               suite runs from — must be refused, or the launcher replaces a
//               working tree with whatever the registry serves.
//
// Each case also watches the launcher's side of it. `onRestart` is the call
// that actually tears the deck down, and a refusal whose status was right while
// the hand-off still happened would be the worst of both answers.
//
// PORTS 4560-4569, and a `portRange` of exactly the one chosen. startServer's
// own fallback walks 4318-4400, beside the 4317 a real deck listens on, and a
// deck this file starts has no business near either.
import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Sandbox first, module import second: the server resolves its config dir, its
// Codex home and its discovery directory at import time. HOME and USERPROFILE
// together cover POSIX and Windows; nothing here can reach the developer's own
// ~/.claude, ~/.codex or ~/.agents-deck.
const SANDBOX = mkdtempSync(join(tmpdir(), "ccdeck-restart-refusals-"));
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
const { startServer, hookToken, markDeckReady } = await import("../../server/index.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { claudeConfigDir } = await import("../../server/claude-dir.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { isNpxInstall } = await import("../../server/self-update.mjs");

// Belt and braces: every deck below writes a discovery record and, in the
// second case, an event log. If an override had not taken, those would land in
// the developer's real config directory.
if (!resolve(String(claudeConfigDir())).startsWith(resolve(CONFIG))) {
  throw new Error(`refusing to run: resolved ${claudeConfigDir()}, outside ${CONFIG}`);
}

/** The package root the route asks about: this checkout. */
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The first free port in 4560-4569, or a failure that says so. */
async function portInBand(): Promise<number> {
  for (let p = 4560; p <= 4569; p++) {
    const free = await new Promise<boolean>(done => {
      const s = createServer();
      s.once("error", () => done(false));
      s.listen(p, "127.0.0.1", () => s.close(() => done(true)));
    });
    if (free) return p;
  }
  throw new Error("no free port in 4560-4569 for a test deck");
}

afterAll(() => {
  for (const k of Object.keys(PREV)) {
    if (PREV[k] === undefined) delete process.env[k];
    else process.env[k] = PREV[k];
  }
  rmTempDir(SANDBOX);
});

describe("what /api/restart refuses, and in which words", () => {
  let port = 0;
  let server: Server | null = null;
  /** Every mode the launcher was handed, in order. */
  const handed: unknown[] = [];
  const url = (p: string) => `http://127.0.0.1:${port}${p}`;
  const headers = () => ({ "content-type": "application/json", "x-ccdeck-token": (hookToken as () => string)() });
  const restart = (body: string) => fetch(url("/api/restart"), { method: "POST", headers: headers(), body });
  const version = () => fetch(url("/api/version"), { headers: headers() }).then(r => r.json());
  /** Long enough for handOffRestart's 120 ms hand-off to have run, had it been scheduled. */
  const settle = () => new Promise(r => setTimeout(r, 400));

  /** One deck, on a port of its own, reporting itself booted so every answer is
   *  the plain one rather than restart-boot-window's "still starting up". */
  const boot = async (persist: string | null) => {
    const old = server;
    server = null;
    if (old) await new Promise<void>(done => old.close(() => done()));
    port = await portInBand();
    server = await (startServer as (o: Record<string, unknown>) => Promise<Server>)({
      port, persist, codex: false, claude: false, portRange: [port, port],
      onRestart: (mode: unknown) => { handed.push(mode); },
    });
    (markDeckReady as () => void)();
  };

  afterAll(async () => {
    const s = server;
    server = null;
    if (s) await new Promise<void>(done => s.close(() => done()));
  });

  it("refuses under --no-persist, because there is no log to come back from", async () => {
    await boot(null);
    expect((await version()).canRestart, "the button offers itself").toBe(false);

    const res = await restart("{}");
    expect(res.status).toBe(409);
    // "no_persist", not "log_unwritable". The second is the #991 gate, and it
    // would refuse this deck too — but it tells a user who never asked for a
    // log that theirs cannot be written, which sends them looking for a file
    // that was never meant to exist.
    expect((await res.json()).reason).toBe("no_persist");
    await settle();
    expect(handed, "the launcher was handed the restart anyway").toEqual([]);
  });

  it("refuses an npx upgrade on a copy that is not running out of npx", async () => {
    // The premise, asked of the same rule the route asks: this checkout is not
    // an npx cache, so the upgrade it is about to be asked for cannot be one.
    expect(isNpxInstall(PKG_ROOT), `the suite is running out of an npx cache: ${PKG_ROOT}`).toBe(false);
    await boot(join(SANDBOX, "log", "events.jsonl"));
    expect((await version()).canRestart, "a deck with a log offers the restart").toBe(true);

    const res = await restart(JSON.stringify({ upgrade: true }));
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("not_npx");
    await settle();
    expect(handed, "the launcher was handed an npx relaunch of a checkout").toEqual([]);

    // Asked plainly, the same deck restarts — so what refused above was the
    // upgrade, not a door that was shut to everything.
    const plain = await restart("{}");
    expect(plain.status).toBe(200);
    expect(await plain.json()).toMatchObject({ ok: true, mode: null });
    await settle();
    expect(handed, "a plain restart reaches the launcher as a plain one").toEqual([null]);
  });
});
