// The suite tests the tree. Users install the tarball. Nothing tested the
// tarball.
//
// 337 test files and not one of them ran `npm pack`. Everything else in here
// reaches into the working directory and imports a module by relative path, so
// every assertion in the repo is about a file layout no user ever has. What
// ships is `files` in package.json — bin, hook, src/server, dist/web,
// release-notes.json, LICENSE, README.md — and the gap between those two
// layouts is invisible from inside the first one.
//
// Two things fell into it in a single afternoon. `agent-dag@3.x` answered
// "notarget" to an install right after a green release, and `bin/agent-dag.js`
// turned up mode 755 in a tree that had it committed 644 with nothing in the
// repo having an opinion either way. Neither was caught by a test; both were
// caught by a person doing by hand what this file now does.
//
// What only this file can catch:
//
//   * a runtime file left out of `files` — the suite resolves it from the tree
//     and stays green while the shipped package cannot start
//   * a devDependency imported at runtime — installed here, absent there. This
//     package declares NO dependencies at all, which makes the install offline
//     and fast and makes any runtime import of a dev-only module fatal on the
//     user's machine and invisible on ours
//   * a bin that does not execute: three names, three shims, and on Windows a
//     `.cmd` per name that Node has refused to spawn without a shell since
//     CVE-2024-27980
//   * a build that shipped its index.html and not its assets, which is a blank
//     page rather than an error
//
// WHY IT PACKS RATHER THAN COPIES. boot-budget.test.ts and its siblings build
// an install layout by hand — the real bin/ beside a src/server/ of `export *`
// shims onto the repo — and that is the right technique for what they measure,
// because it lets them shadow four modules. It is the wrong one here: a layout
// this file assembled would be this file's opinion of what ships, and the
// opinion is exactly the thing under test. `npm pack` asks npm.
//
// `--ignore-scripts`, so `prepack` does not run `vite build` again: 10.8s
// against 1.2s, measured, and the point is to ship what is on disk. Which is
// why the block is gated on dist/web/index.html being there at all — the same
// gate theme-first-paint.test.ts carries, satisfied in CI by the `Build web
// bundle` step that runs before the suite, and registered in skip-gates.mjs so
// a leg that stops building goes red instead of quietly dropping this file.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
/** Spelled the way theme-first-paint.test.ts spells it, deliberately: the gate
 *  below reads `!existsSync(dist)` literally, and skip-gate-inventory.test.ts
 *  scans the source text for that string. A local alias here would register as
 *  a condition of its own and would have to be justified separately, for a gate
 *  that means exactly the same thing. */
const dist = join(REPO, "dist", "web", "index.html");

// @ts-expect-error — plain .mjs server module, no types
const { killTree } = await import("../../server/exec.mjs");

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-tarball-smoke-"));
/** Where the tarball is installed: a package of its own, so npm resolves the
 *  bin shims exactly as it does for a user's `npm i ccdeck`. */
const APP = join(DIR, "app");
/** The deck's HOME for this run. Everything it writes on a first run — the
 *  hook, settings.json, the discovery file — lands here and nowhere near the
 *  real one. Asserted, not assumed: the sandbox check below refuses to run at
 *  all if these ever resolve outside DIR. */
const HOME = join(DIR, "home");
/** Watched instead of the machine's real projects, and empty, so the deck has
 *  nothing to replay and the boot is the boot rather than a log read. */
const WORKSPACE = join(DIR, "workspace");

for (const d of [APP, HOME, WORKSPACE]) {
  if (!resolve(d).startsWith(resolve(DIR))) throw new Error(`refusing to run: ${d} is outside ${DIR}`);
}

/**
 * How to run npm from inside the suite, on all three platforms, with no shell.
 *
 * `npm_execpath` is npm's own cli.js, and npm sets it for everything it spawns
 * — so `npm test`, which is how this suite runs on a dev machine and in
 * publish.yml alike, hands us an absolute path to the very npm the developer
 * invoked. Spawning node with it sidesteps the whole Windows problem: no PATH
 * lookup, no `.cmd`, no shell, no quoting.
 *
 * The fallback is for a contributor running `vitest` from an editor, where the
 * variable is unset. It needs a shell on Windows for the reason the doc comment
 * above gives, and that is fine here because the argument vector is ours.
 */
function npm(args: string[], cwd: string, timeout = 180_000) {
  const cli = process.env.npm_execpath;
  return cli
    ? spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8", timeout })
    : spawnSync("npm", args, { cwd, encoding: "utf8", timeout, shell: process.platform === "win32" });
}

/** The three names this one tarball is published under. bin/ carries a shim per
 *  name, and #340's rename dance means all three are the same package. */
const NAMES = ["ccdeck", "agents-deck", "agent-dag"] as const;

let tarball = "";
let packed: string[] = [];
let installed = "";

const PORT_LO = 20_000;
const PORT_HI = 29_999;

/** A port nothing else on this machine is on, and never one a developer's own
 *  deck would pick — 4317 and its neighbours are left alone deliberately. */
async function freePort(): Promise<number> {
  for (let tries = 0; tries < 50; tries++) {
    const port = PORT_LO + Math.floor(Math.random() * (PORT_HI - PORT_LO + 1));
    const s = createServer();
    const bound = await new Promise<boolean>(done => {
      s.once("error", () => done(false));
      s.listen(port, "127.0.0.1", () => done(true));
    });
    if (!bound) { try { s.close(); } catch { /* never listened */ } continue; }
    await new Promise<void>(done => { s.close(() => done()); });
    if (port >= 4300 && port <= 4410) continue;
    return port;
  }
  throw new Error(`no free port in ${PORT_LO}-${PORT_HI} after 50 tries`);
}

async function until(cond: () => boolean, ms: number, what: string) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`timed out after ${ms}ms waiting for ${what}`);
}

interface Fetched { status: number; body: string; type: string }

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<Fetched> {
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", headers }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", d => { body += d; });
      res.on("end", () => done({
        status: res.statusCode ?? 0,
        body,
        type: String(res.headers["content-type"] ?? ""),
      }));
    });
    req.on("error", fail);
    req.setTimeout(10_000, () => { req.destroy(new Error(`GET ${path} timed out`)); });
    req.end();
  });
}

describe.skipIf(!existsSync(dist))("the tarball a user installs", () => {
  let deck: ChildProcess | undefined;
  let out = { text: "" };
  let port = 0;

  beforeAll(async () => {
    mkdirSync(APP, { recursive: true });
    mkdirSync(HOME, { recursive: true });
    mkdirSync(WORKSPACE, { recursive: true });

    // 1. Pack. `--json` so the file list comes back structured rather than
    //    scraped out of npm's notice lines, which are prose and change.
    const pack = npm(["pack", "--ignore-scripts", "--json", "--pack-destination", DIR], REPO);
    if (pack.status !== 0) throw new Error(`npm pack failed (${pack.status}):\n${pack.stderr}\n${pack.stdout}`);
    const meta = JSON.parse(pack.stdout)[0];
    tarball = join(DIR, meta.filename);
    packed = meta.files.map((f: { path: string }) => f.path);

    // 2. Install it into an empty package. `--offline` is an assertion in
    //    itself: this package declares no dependencies, so a resolution that
    //    needs the network is a dependency that appeared without anyone
    //    noticing, and it fails here rather than on a plane.
    const init = npm(["init", "-y"], APP);
    if (init.status !== 0) throw new Error(`npm init failed:\n${init.stderr}`);
    const add = npm(["i", "--offline", "--no-audit", "--no-fund", tarball], APP);
    if (add.status !== 0) throw new Error(`installing the tarball failed (${add.status}):\n${add.stderr}\n${add.stdout}`);
    installed = join(APP, "node_modules", JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).name);

    // 3. Boot it — through the SHIM, not the JS behind it, because the shim is
    //    what `npx ccdeck` and a global install both go through and it is the
    //    piece that differs per platform.
    port = await freePort();
    const shim = join(APP, "node_modules", ".bin", process.platform === "win32" ? "ccdeck.cmd" : "ccdeck");
    deck = spawn(shim, [
      "--port", String(port),
      "--no-open",
      "--workspace", WORKSPACE,
      "--history", join(DIR, "events.jsonl"),
    ], {
      cwd: APP,
      stdio: ["ignore", "pipe", "pipe"],
      // A `.cmd` cannot be spawned without one since CVE-2024-27980, and the
      // argument vector here is ours rather than a user's, so the shell adds no
      // surface. Windows is also the platform where this shim has broken before.
      shell: process.platform === "win32",
      env: {
        ...process.env,
        HOME, USERPROFILE: HOME,
        CLAUDE_CONFIG_DIR: join(HOME, ".claude"),
        CODEX_HOME: join(HOME, ".codex"),
        XDG_CONFIG_HOME: join(HOME, ".config"),
        NO_COLOR: "1",
      },
    });
    out = { text: "" };
    deck.stdout!.on("data", d => { out.text += String(d); });
    deck.stderr!.on("data", d => { out.text += String(d); });
    await until(() => out.text.includes("server ready"), 90_000,
      `the installed deck to say it was ready — it said:\n${out.text}`);
  }, 300_000);

  afterAll(() => {
    if (deck) killTree(deck, "SIGKILL");
    rmTempDir(DIR);
  });

  it("ships every directory the deck reads at runtime, and nothing it does not", () => {
    // Read off the pack manifest rather than listed twice: `files` in
    // package.json is the claim, and this is npm's answer to it. What is
    // asserted here is the SHAPE — a top-level entry that is neither a runtime
    // directory nor one of the three files the package promises is either a
    // leak (a .env, a scratch note, a test fixture) or a rename nobody
    // announced.
    const tops = new Set(packed.map(p => p.split("/")[0]));
    for (const needed of ["bin", "hook", "src", "dist"]) {
      expect(tops, `${needed}/ is not in the tarball`).toContain(needed);
    }
    expect([...tops].sort()).toEqual(
      ["LICENSE", "README.md", "bin", "dist", "hook", "package.json", "release-notes.json", "src"],
    );
    // src/ is src/server/ and nothing else: the whole client is compiled into
    // dist/web, and shipping src/web would send every test in this suite to
    // every user.
    const src = packed.filter(p => p.startsWith("src/"));
    expect(src.length).toBeGreaterThan(0);
    expect(src.filter(p => !p.startsWith("src/server/"))).toEqual([]);
  });

  it("ships the built page and the assets it asks for, not just the page", () => {
    // A build that shipped index.html without its hashed bundle is a blank
    // page, and a blank page is the one failure mode that looks like a working
    // install until someone squints. The names are hashed, so the manifest is
    // asked what is there rather than told.
    const html = readFileSync(join(REPO, "dist", "web", "index.html"), "utf8");
    const referenced = [...html.matchAll(/(?:src|href)="\/?(assets\/[^"]+)"/g)].map(m => m[1]);
    expect(referenced.length, "the built page references no assets at all").toBeGreaterThan(0);
    for (const asset of referenced) {
      expect(packed, `${asset} is referenced by the page and missing from the tarball`)
        .toContain(`dist/web/${asset}`);
    }
  });

  it("installs a working shim for all three names", () => {
    const binDir = join(APP, "node_modules", ".bin");
    const shims = new Set(readdirSync(binDir));
    for (const name of NAMES) {
      expect(shims, `no shim for ${name}`).toContain(name);
      // On Windows the shim a shell resolves is the `.cmd`; the extensionless
      // file beside it is the Cygwin/Git-Bash one and is not what cmd.exe runs.
      if (process.platform === "win32") {
        expect(shims, `no ${name}.cmd — nothing on PATH would run`).toContain(`${name}.cmd`);
      }
    }
  });

  it("needs no dependency to be fetched, because it declares none", () => {
    // The install above ran `--offline`. This says why that is an assertion
    // rather than a speed trick: the shipped manifest must keep claiming an
    // empty runtime graph, because the moment it does not, `--offline` starts
    // failing for a reason that has nothing to do with what this file tests.
    const shipped = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
    expect(shipped.dependencies ?? {}).toEqual({});
    expect(shipped.version).toBe(JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version);
  });

  it("serves its own page, from the install, over the port it announced", async () => {
    const page = await get(port, "/");
    expect(page.status).toBe(200);
    expect(page.type).toMatch(/text\/html/);
    // The built page, not a placeholder: the same asset references the manifest
    // case checked, now answered by the running server.
    const referenced = [...page.body.matchAll(/(?:src|href)="\/?(assets\/[^"]+)"/g)].map(m => m[1]);
    expect(referenced.length).toBeGreaterThan(0);
    for (const asset of referenced) {
      const got = await get(port, `/${asset}`);
      expect(got.status, `the page asks for /${asset} and the server does not have it`).toBe(200);
    }
  });

  it("answers the routes that need no gate", async () => {
    for (const path of ["/api/health", "/api/system", "/api/version"]) {
      const res = await get(port, path);
      expect(res.status, `${path} answered ${res.status}`).toBe(200);
      expect(() => JSON.parse(res.body), `${path} did not answer JSON`).not.toThrow();
    }
  });

  it("lets the deck's own page read, and a bare client not", async () => {
    // Both halves of the read gate, end to end, against the shipped build. The
    // suite checks this in-process elsewhere; what it cannot check there is
    // that the gate survives packing — and the gate is the one piece of this
    // server that fails CLOSED, so a mistake in it locks the user out of their
    // own deck rather than opening it to someone else.
    const bare = await get(port, "/api/events");
    expect(bare.status, "a client with no browser headers was let in").toBe(401);
    const asPage = await get(port, "/api/events", {
      host: `127.0.0.1:${port}`,
      "sec-fetch-site": "same-origin",
    });
    expect(asPage.status, "the deck's own page was locked out of its data").toBe(200);
    // Safari 16.0–16.3 sends no Sec-Fetch-Site and is inside the bundle's
    // target, so Referer is the fallback the gate keeps for it.
    const asOldSafari = await get(port, "/api/events", {
      host: `127.0.0.1:${port}`,
      referer: `http://127.0.0.1:${port}/`,
    });
    expect(asOldSafari.status, "a browser too old for Sec-Fetch-Site was locked out").toBe(200);
  });

  it("does its first-run writing inside the home it was given, and nowhere else", () => {
    // The hook is the proof that hook/ shipped AND that the installer found it
    // inside the installed package rather than relative to a repo that is not
    // there.
    //
    // READ OFF THE BANNER, not asserted outright, and CI is what taught this
    // file the difference. The first version waited for the hook to appear and
    // timed out on all three legs while passing on two developer machines: a
    // runner has no Claude Code, so `jobs.hooks` resolves null, the deck prints
    // "skipped — no Claude Code found" and there is nothing to install into.
    // The machine-independent claim is not "a hook was written"; it is that
    // WHEREVER the deck says it wrote one, that path is inside the HOME it was
    // handed and the file is really there.
    const row = /Claude hooks\s+(.+)/.exec(out.text);
    expect(row, `the boot said nothing about Claude hooks:\n${out.text}`).toBeTruthy();
    const detail = row![1].trim();
    if (/skipped/.test(detail)) {
      // Nothing to check on this machine, and nothing may have escaped either.
      expect(existsSync(join(HOME, ".claude", "settings.json")),
        "the deck wrote settings.json on a machine with no Claude Code").toBe(false);
      return;
    }
    // The path is ellipsised in the banner to fit 80 columns, so the tail is
    // what can be compared — and the tail is the part that says whose home it
    // is going into.
    expect(detail, `the hook row named something else: ${detail}`)
      .toContain(join(".claude", "agent-dag", "hook.js"));
    const hook = join(HOME, ".claude", "agent-dag", "hook.js");
    expect(existsSync(hook), `the banner claimed a hook that is not at ${hook}`).toBe(true);
    expect(readFileSync(hook, "utf8").length, "the hook shipped empty").toBeGreaterThan(0);
    // And the settings file that points at it, which is the half a user
    // notices: a hook on disk that nothing calls is a deck with no events.
    const settings = join(HOME, ".claude", "settings.json");
    expect(existsSync(settings), "no settings.json was written").toBe(true);
    expect(readFileSync(settings, "utf8")).toContain("agent-dag");
  });

  it("says where to point a browser, and says it once", () => {
    // The banner is the only interface a first run has before the tab opens.
    expect(out.text).toContain("server ready");
    expect(out.text).toContain(`127.0.0.1:${port}`);
    // Nothing crashed on the way. `NO_COLOR` is set, so this is reading plain
    // text rather than hunting escape codes.
    expect(out.text, "the boot printed a stack trace").not.toMatch(/^\s+at .+\(.+\)$/m);
    expect(deck!.exitCode, "the deck exited during the run").toBe(null);
  });
});
