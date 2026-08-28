// The half of #704 that is an absence, held down so it cannot quietly come back.
//
// Deleting a mechanism leaves nothing behind to test, which is the whole
// difficulty: a merge that resurrects `sound-hook.mjs`, a revert that restores
// the `/api/sound-hook` routes, or a `hook/notify.mjs` reappearing in the
// package would all be GREEN everywhere else in this suite. The client half
// would keep playing its tones and the deck would keep writing a `Stop` hook
// beside them, which is two sounds per turn and the exact state this change
// exists to end.
//
// So each case names one thing that must not exist, and the reason it must not.
// They are cheap, and they are the only assertions in the suite whose subject is
// something that was removed.
//
// The last two are the ones with teeth: a real server answering a real request,
// and a real install writing a real settings.json. A grep can be satisfied by
// renaming a file; those two cannot.
//
// PLAIN NODE. Nothing renders. The server case boots the deck on port 0 against
// a temp home, and the install case writes into a temp config dir — both are
// pointed there before the server module is imported, because it resolves its
// directories at import time.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-sound-gone-"));
const FAKE_CLAUDE = join(DIR, "claude");
const prevEnv = { ...process.env };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = FAKE_CLAUDE;
process.env.CODEX_HOME = join(DIR, "codex");
// The upgrade route's handler starts a global `npm i -g`; nothing here asks for
// it, and a boot that spawned one would be measuring the installer.
process.env.AGENTS_DECK_NO_INSTALL = "1";
for (const p of [process.env.HOME, process.env.USERPROFILE, process.env.CLAUDE_CONFIG_DIR, process.env.CODEX_HOME]) {
  if (!resolve(p!).startsWith(resolve(DIR))) throw new Error(`sandbox escaped: ${p}`);
}

// @ts-expect-error — plain .mjs module, no types
const { startServer } = await import("../../server/index.mjs");
// @ts-expect-error — plain .mjs module, no types
const { installHooks, CLAUDE_DIR } = await import("../../server/installer.mjs");
// Imported HERE, and not left to installHooks to import lazily on first use.
// It resolves the parked-hooks file and the two script paths AT IMPORT TIME —
// from os.homedir() and $CLAUDE_CONFIG_DIR — and deletes them. A lazy import
// would resolve them at whatever the environment happened to be when the first
// install ran, which is how this file destroyed the author's own
// ~/.agents-deck/parked-sound-hooks.json while it was being written: the env
// restore sat in a describe-level afterAll, so it had already put the real HOME
// back before the last case called installHooks. The restore is file-level now,
// and these three paths are checked the way every other file here checks them.
// @ts-expect-error — plain .mjs module, no types
const retirement = await import("../../server/retire-sound-hook.mjs");

for (const p of [CLAUDE_DIR, retirement.SETTINGS_PATH, retirement.PARKED_PATH,
                 retirement.NOTIFY_PATH, retirement.LEGACY_NOTIFY_PATH]) {
  if (!String(p).startsWith(DIR)) {
    throw new Error(`refusing to run: a deck module resolved ${p}, outside ${DIR}`);
  }
}

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (...parts: string[]) => readFileSync(join(REPO, ...parts), "utf8");

mkdirSync(FAKE_CLAUDE, { recursive: true });

// File scope, so it runs after the LAST describe rather than after the one it
// happens to be written inside. A describe-level restore put the developer's own
// HOME back while a later describe was still installing hooks, and the retirement
// this change adds then deleted the real files it found there. Env teardown
// belongs to the file, because the sandbox does.
afterAll(() => {
  for (const k of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "AGENTS_DECK_NO_INSTALL"]) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  rmTempDir(DIR);
});

describe("the script the package used to ship", () => {
  it("is not in hook/ any more", () => {
    // `hook/` is what npm publishes as executable scripts, and everything in it
    // is installed into the user's config directory and run by Claude Code. A
    // sound player has no business being one of them now that the tab makes the
    // sound, and a file back in this directory would be a file back on disk.
    const shipped = readdirSync(join(REPO, "hook"));
    expect(shipped).not.toContain("notify.mjs");
    expect(shipped).not.toContain("notify.js");
    // hook.js is the event forwarder and is emphatically still shipped — this
    // case must fail on a deleted notify script, not on an empty directory.
    expect(shipped).toContain("hook.js");
  });

  it("has no module left that knows how to install one", () => {
    expect(existsSync(join(REPO, "src", "server", "sound-hook.mjs"))).toBe(false);
    // What replaced it only ever removes. If either of these verbs turns up in
    // the retirement module, the mechanism has grown an installer again.
    const retire = read("src", "server", "retire-sound-hook.mjs");
    expect(retire).not.toContain("installScript");
    expect(retire).not.toMatch(/export (async )?function setSoundHook/);
  });

  it("is named by nothing the deck runs", () => {
    // A stale import is a boot that dies on module resolution rather than a
    // feature that half works, so this is the case that turns a half-finished
    // revert into a red suite instead of a broken `npx ccdeck`. The two spellings
    // are the two ways this repo reaches a server module: a relative import
    // inside src/server, and a pathToFileURL off PKG_ROOT from bin/.
    for (const file of ["src/server/index.mjs", "src/server/installer.mjs", "bin/deck.js"]) {
      const text = read(...file.split("/"));
      expect(text, file).not.toContain('"./sound-hook.mjs"');
      expect(text, file).not.toContain("src/server/sound-hook.mjs");
    }
  });
});

describe("the endpoint the switch used to call", () => {
  let server: Server;
  let port = 0;

  beforeAll(async () => {
    server = await startServer({ port: 0, host: "127.0.0.1", persist: null, codex: false });
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>(done => {
      server.closeAllConnections?.();
      server.close(() => done());
    });
  });

  /** One request from the deck's own page, so the answer is the router's and not
   *  the CSRF gate's — a 403 would satisfy "did not answer" while the handler
   *  was still there, which is the failure this has to be able to tell apart. */
  function call(method: string, path: string): Promise<{ status: number; type: string }> {
    return new Promise((done, fail) => {
      const headers: Record<string, string> = {
        Host: `127.0.0.1:${port}`,
        Origin: `http://127.0.0.1:${port}`,
        "Sec-Fetch-Site": "same-origin",
      };
      const req = request({ host: "127.0.0.1", port, path, method, headers }, res => {
        res.resume();
        done({ status: res.statusCode ?? 0, type: String(res.headers["content-type"] ?? "") });
      });
      req.on("error", fail);
      req.end(method === "POST" ? "{}" : undefined);
    });
  }

  it("answers a GET the way it answers any path it has no route for", async () => {
    // Which is the SPA's index.html, not a 404 — an unrouted GET falls through
    // to the static handler so a deep link into the deck's own UI loads. The
    // claim is therefore "same as a path that never existed" rather than a
    // status typed out here, and the reply being HTML is what says no handler
    // ran: the removed one answered `application/json` with the hook's state.
    const gone = await call("GET", "/api/sound-hook");
    expect(gone).toEqual(await call("GET", "/api/never-was-a-route"));
    expect(gone.type).toContain("text/html");
  });

  it("answers a POST the same way, which is 405 and no handler", async () => {
    // The write half, and the one that matters: a router that still reached a
    // handler here would answer 400 (bad_request) or 200, and either one means
    // the deck can still be made to write a hook into somebody's settings.json.
    const gone = await call("POST", "/api/sound-hook");
    expect(gone.status).toBe(405);
    expect(gone).toEqual(await call("POST", "/api/never-was-a-route"));
  });

  it("still answers the routes beside it, so this is the route and not the server", async () => {
    const health = await call("GET", "/api/health");
    expect(health.status).toBe(200);
    expect(health.type).toContain("application/json");
  });
});

describe("the two modules that write settings.json", () => {
  it("agree on which settings.json that is", () => {
    // installHooks writes `cfg.settingsPath`; retirement deletes a script and a
    // parked file it resolved for itself, at its own import. In the product both
    // come from claudeConfigDir() and are the same file. When they are NOT — a
    // test that sandboxes one module's environment and not the other's, which
    // is exactly the accident this file caused once — the install is writing a
    // settings.json that retirement knows nothing about, and retirement must not
    // delete anything on the strength of it. installHooks compares the two and
    // declines; this is the invariant that comparison is written against.
    expect(retirement.SETTINGS_PATH).toBe(join(CLAUDE_DIR, "settings.json"));
    expect(read("src", "server", "installer.mjs"))
      .toContain("retirement.SETTINGS_PATH === cfg.settingsPath");
  });
});

describe("a fresh install on a machine that never had the sound", () => {
  it("writes no sound entry and installs no sound script", async () => {
    // The strongest form of "nothing writes it any more": the real installer,
    // on the real path, against a settings.json it creates from nothing. Every
    // other case in this file can be satisfied by moving code around.
    const settingsPath = join(FAKE_CLAUDE, "settings.json");
    rmSync(settingsPath, { force: true });
    rmTempDir(join(FAKE_CLAUDE, "agent-dag"));

    const res = await installHooks({ provider: "claude" });

    const written = readFileSync(settingsPath, "utf8");
    expect(written).not.toContain("__agent-dag-sound");
    expect(written).not.toContain("notify");
    // The forwarder is there, which is what makes the two assertions above a
    // claim about the sound rather than about an install that did nothing.
    expect(written).toContain("__agent-dag");
    expect(res.changed).toBe(true);

    const installed = readdirSync(dirname(String(res.hookPath)));
    expect(installed).toContain("hook.js");
    expect(installed).not.toContain("notify.mjs");
    expect(installed).not.toContain("notify.js");
  });
});
