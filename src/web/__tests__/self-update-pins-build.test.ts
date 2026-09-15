// A self-update replaced the running tree, and every module the deck had not
// loaded yet was then read out of the NEW one (#1042).
//
// startUpgrade deliberately leaves the process serving after `npm i -g` has
// finished, and says why: an evaluated module is cached by its URL for the life
// of the process, so the running deck keeps the code it booted with, and the
// drift path restarts it at an idle moment. That holds for every module already
// in memory. It never held for the dozen the server imports at request time —
// the quota readers, the accounts surface, the browser watch, self-update
// itself — because PKG_ROOT is a fixed path and npm rewrites the tree under it.
// So the first request after an install evaluated new code into an old process:
// a build nobody has ever run, and while npm was still mid-reify, a module that
// was not there at all.
//
// The fix pins the build: every module reached only through `import()` is
// loaded after the boot and before any install can start, and index.mjs keeps
// the list. This file checks the list against the sources, then does the swap
// for real, in a temp copy of the package, and asks the routes that would have
// crossed it.
//
// NOTHING HERE RUNS NPM. The copy's startUpgrade is replaced by one that does to
// the copy's files what an install does, and nothing else — which is also what
// lets these cases run on Windows, where the real one would find the real
// npm.cmd beside node.exe whatever PATH said. What is under test is the order
// index.mjs calls things in, and every line of that is the shipped code.
import { describe, it, expect, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rmTempDir } from "./rm-temp-dir";

const REAL_SERVER = fileURLToPath(new URL("../../server/", import.meta.url));
const REAL_MANIFEST = fileURLToPath(new URL("../../../package.json", import.meta.url));
const source = (name: string) => readFileSync(join(REAL_SERVER, name), "utf8");

// ── the list, against the sources ────────────────────────────────────────────

/** The names in index.mjs's PINNED_MODULES, read the way a reviewer would. */
function pinnedList(): string[] {
  const body = /const PINNED_MODULES = \[([\s\S]*?)\];/.exec(source("index.mjs"))?.[1] ?? "";
  return [...body.matchAll(/"([\w.-]+\.mjs)"/g)].map(m => m[1]);
}

/**
 * Every local module an `import()` in src/server names, with who names it.
 *
 * Both spellings the server uses: the relative `import("./x.mjs")` and the
 * `import(pathToFileURL(join(PKG_ROOT, "src/server/x.mjs")).href)` that most of
 * index.mjs's handlers use, which resolve to the same URL. Comment lines are
 * dropped first — several files argue in prose about an import they chose not
 * to make, and prose is not a load.
 */
function lazyTargets(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const file of readdirSync(REAL_SERVER).filter(n => n.endsWith(".mjs")).sort()) {
    const code = source(file).split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    const re = /import\(\s*(?:"\.\/([\w.-]+\.mjs)"|pathToFileURL\(join\(PKG_ROOT, "src\/server\/([\w.-]+\.mjs)"\)\))/g;
    for (const m of code.matchAll(re)) {
      const target = m[1] ?? m[2];
      out.set(target, [...(out.get(target) ?? []), file]);
    }
  }
  return out;
}

describe("the modules a running deck pins before its tree can change", () => {
  it("include every one that an import() in src/server reaches for", () => {
    const pinned = new Set(pinnedList());
    const targets = lazyTargets();
    // The scanner has to be seeing something, or the assertion below is about
    // an empty set and can never fail. These two are the issue's own examples.
    expect(targets.has("cswap-admin.mjs"), "the scanner found no lazy import of cswap-admin.mjs").toBe(true);
    expect(targets.has("self-update.mjs"), "the scanner found no lazy import of self-update.mjs").toBe(true);
    const missing = [...targets].filter(([t]) => !pinned.has(t)).map(([t, by]) => `${t} (imported lazily by ${[...new Set(by)].join(", ")})`);
    expect(missing, "a module is loaded on demand and would be read out of whatever npm wrote last").toEqual([]);
  });

  it("name only files that exist", () => {
    const list = pinnedList();
    expect(list.length).toBeGreaterThan(0);
    expect(list.filter(f => !existsSync(join(REAL_SERVER, f)))).toEqual([]);
  });
});

// ── the swap, for real ───────────────────────────────────────────────────────

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-pinned-build-"));
afterAll(() => rmTempDir(DIR));

/** The routes whose handlers import their module on the first request, and
 *  which answer quickly in an empty HOME. Each one is a different module. */
const ROUTES = [
  "/api/codex-usage",                // codex-usage.mjs
  "/api/codex-quota",                // codex-quota.mjs
  "/api/browser-watch?live=0",       // browser-watch.mjs + browser-watch-store.mjs
  "/api/claude-accounts/login",      // cswap-admin.mjs
];

interface Box { pkg: string; home: string; loaded: string; swapped: string; swap: string; runner: string }

/** A copy of the package as npm would lay it out, a script that rewrites it the
 *  way an install does, and a runner that boots the copy's own server. */
function sandbox(name: string): Box {
  const root = join(DIR, name);
  const box: Box = {
    pkg: join(root, "pkg"),
    home: join(root, "home"),
    loaded: join(root, "loaded-from-the-new-tree.log"),
    swapped: join(root, "swapped"),
    swap: join(root, "swap.mjs"),
    runner: join(root, "run.mjs"),
  };
  for (const p of Object.values(box)) {
    if (!resolve(p).startsWith(resolve(DIR))) throw new Error(`refusing to run: ${p} is outside ${DIR}`);
  }
  const server = join(box.pkg, "src", "server");
  for (const d of [server, box.home]) mkdirSync(d, { recursive: true });
  // A real copy rather than export-star shims onto the repo: index.mjs computes
  // PKG_ROOT from its own location, and it is PKG_ROOT that has to be swapped.
  for (const f of readdirSync(REAL_SERVER).filter(n => n.endsWith(".mjs"))) {
    copyFileSync(join(REAL_SERVER, f), join(server, f));
  }
  copyFileSync(REAL_MANIFEST, join(box.pkg, "package.json"));

  // What npm leaves behind, as far as this process can tell: every module file
  // replaced. A module evaluated out of it says so in a log and then throws, so
  // the log is the whole answer to "did anything cross the swap".
  const trap = [
    `import { appendFileSync } from "node:fs";`,
    `appendFileSync(${JSON.stringify(box.loaded)}, import.meta.url.split("/").pop() + "\\n");`,
    `throw new Error("evaluated out of the tree the install just wrote");`,
  ].join("\n");
  writeFileSync(box.swap, [
    `import { readdirSync, writeFileSync } from "node:fs";`,
    `import { join } from "node:path";`,
    `const SERVER = ${JSON.stringify(server)};`,
    `for (const f of readdirSync(SERVER)) if (f.endsWith(".mjs")) writeFileSync(join(SERVER, f), ${JSON.stringify(trap)});`,
    `writeFileSync(${JSON.stringify(box.swapped)}, "swapped\\n");`,
  ].join("\n"));

  // The one module that is not a copy. Its startUpgrade does the swap and
  // returns what the real one returns on success, synchronously, so the tree is
  // already the new one by the time the press is answered. Everything else in it
  // is the real module: a local export shadows the same name arriving through
  // `export *`.
  writeFileSync(join(server, "self-update.mjs"), [
    `export * from ${JSON.stringify(pathToFileURL(join(REAL_SERVER, "self-update.mjs")).href)};`,
    `import { execFileSync } from "node:child_process";`,
    `export function startUpgrade() {`,
    `  execFileSync(process.execPath, [${JSON.stringify(box.swap)}]);`,
    `  return { ok: true, command: "npm install -g ccdeck@latest" };`,
    `}`,
  ].join("\n"));

  // The copy's own startServer, on a port in the band this suite's decks are
  // allowed; markDeckReady only when the case is about the boot's pin.
  writeFileSync(box.runner, [
    `const index = await import(${JSON.stringify(pathToFileURL(join(server, "index.mjs")).href)});`,
    `const s = await index.startServer({ port: 4540 + Math.floor(Math.random() * 10), portRange: [4540, 4549], persist: null, codex: true, claude: false });`,
    `if (process.env.PIN_MARK_READY === "1") await index.markDeckReady();`,
    `process.stdout.write(JSON.stringify({ port: s.address().port, token: index.hookToken() }) + "\\n");`,
  ].join("\n"));
  return box;
}

interface Deck { port: number; token: string; child: ChildProcess }

async function boot(box: Box, { markReady }: { markReady: boolean }): Promise<Deck> {
  const child = spawn(process.execPath, [box.runner], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: box.home, USERPROFILE: box.home,
      CLAUDE_CONFIG_DIR: join(box.home, ".claude"),
      CODEX_HOME: join(box.home, ".codex"),
      AGENTS_DECK_NO_LAN: "1",
      NO_COLOR: "1",
      PIN_MARK_READY: markReady ? "1" : "0",
    },
  });
  let out = "";
  let err = "";
  child.stderr!.on("data", d => { err += String(d); });
  return await new Promise<Deck>((done, fail) => {
    const give = setTimeout(() => { child.kill("SIGKILL"); fail(new Error(`the deck never came up:\n${err}`)); }, 30_000);
    child.stdout!.on("data", d => {
      out += String(d);
      const line = out.split("\n").find(l => l.startsWith("{"));
      if (!line) return;
      clearTimeout(give);
      const { port, token } = JSON.parse(line);
      done({ port, token, child });
    });
    child.on("exit", code => { clearTimeout(give); fail(new Error(`the deck exited ${code} before listening:\n${err}`)); });
  });
}

function call(deck: Deck, method: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const req = request({
      host: "127.0.0.1", port: deck.port, path, method, timeout: 15_000,
      headers: { "x-ccdeck-token": deck.token, ...(method === "POST" ? { "content-type": "application/json" } : {}) },
    }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", c => { body += c; });
      res.on("end", () => done({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", fail);
    req.on("timeout", () => req.destroy(new Error(`${path} did not answer`)));
    req.end(method === "POST" ? "{}" : undefined);
  });
}

const crossed = (box: Box) => (existsSync(box.loaded) ? readFileSync(box.loaded, "utf8").split("\n").filter(Boolean) : []);
const askEveryRoute = async (deck: Deck) => {
  const out: Array<[string, number]> = [];
  for (const path of ROUTES) out.push([path, (await call(deck, "GET", path)).status]);
  return out;
};

describe("a deck whose package is replaced while it is serving", () => {
  it("answers every on-demand route from the build it started with after its own Upgrade", async () => {
    // No markDeckReady: the pin this case relies on is the one handleUpgrade
    // takes before it starts the install, which is the only one a press
    // arriving in the first moments of a boot would get.
    const box = sandbox("press");
    const deck = await boot(box, { markReady: false });
    try {
      const up = await call(deck, "POST", "/api/upgrade");
      expect(up.status, `the upgrade was refused, so nothing below means anything: ${up.body}`).toBe(200);
      expect(existsSync(box.swapped), "the press never reached the install").toBe(true);

      // One assertion, so a failure shows which modules crossed the swap AND
      // what each route answered because of it.
      const answers = await askEveryRoute(deck);
      expect({ crossed: crossed(box), answers }, "modules evaluated out of the tree the install had just written")
        .toEqual({ crossed: [], answers: ROUTES.map(r => [r, 200]) });
    } finally {
      deck.child.kill("SIGKILL");
    }
  }, 60_000);

  it("does the same when the tree was replaced by an install it did not run", async () => {
    // `npm i -g ccdeck` typed in a terminal is the same swap, and the drift
    // path leaves the deck serving afterwards just the same — so the pin is
    // taken when the boot is over, not only when the deck installs.
    const box = sandbox("terminal");
    const deck = await boot(box, { markReady: true });
    try {
      await new Promise<void>((done, fail) => {
        const npm = spawn(process.execPath, [box.swap], { stdio: "ignore" });
        npm.on("error", fail);
        npm.on("exit", code => (code === 0 ? done() : fail(new Error(`swap exited ${code}`))));
      });
      const answers = await askEveryRoute(deck);
      expect({ crossed: crossed(box), answers }, "modules evaluated out of the tree the terminal's install wrote")
        .toEqual({ crossed: [], answers: ROUTES.map(r => [r, 200]) });
    } finally {
      deck.child.kill("SIGKILL");
    }
  }, 60_000);
});
