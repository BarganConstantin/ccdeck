// The auto-switch loop's first tick was scheduled against a boot that was still
// installing the tool it drives (#1043).
//
// bin/deck.js starts the server without awaiting it and runs startupWork beside
// it, and index.mjs arms the auto-switch the moment the port binds:
// initCswapAuto, then startLoop, then an eager `tick()` so the user does not
// wait a whole interval. Meanwhile startupWork's cswap job is still inside
// ensureCswap, which may be running a `uv tool install`, or has just fired an
// upgrade it deliberately does not await and answered "upgrading". A tick is
// `cswap auto --once` — the account rotation, which moves the user's live
// Claude credentials — and it ran against a uv/pipx tree being rewritten
// underneath it.
//
// markDeckReady was the other remedy the issue offered, and it would not have
// closed this. reportStartup stops waiting for claude-swap the moment the
// install announces itself ("installing in the background — the deck is
// ready"), so the boot is marked ready with the install still running; and
// ensureCswap answers "upgrading" BEFORE the upgrade has run at all, so even
// the job settling means nothing about the tree. The launcher now hands the
// server the one promise that does mean "the tool is quiet" — the job settled
// AND any upgrade it started has too — and every tick waits for it.
//
// The technique is boot-listen-before-report.test.ts's: an install layout in a
// temp directory holding the real bin/deck.js and a src/server of export-star
// shims onto the repo, so what runs is what ships. Shadowed: ensureCswap and
// upgradeSettled, held open by a file this test creates, so "the tick waited"
// is read off an ordering rather than off a clock; versionReport, so no registry
// is asked; and keepDiscovery, so nothing is registered for a hook to find.
//
// The tick is read back where the panel reads it — `lastTick` on
// /api/cswap-auto — and AGENTS_DECK_CSWAP names a file that does not exist, so
// no claude-swap on this machine can be reached from here. A tick then fails
// to spawn, and a tick that failed to spawn is still a tick that ran.
import { describe, it, expect, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";

// @ts-expect-error — plain .mjs modules, no types
const { killTree } = await import("../../server/exec.mjs");

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-tick-after-install-"));
const PKG = join(DIR, "pkg");
const SERVER_DIR = join(PKG, "src", "server");
const REAL_BIN = fileURLToPath(new URL("../../../bin/", import.meta.url));
const REAL_SERVER = fileURLToPath(new URL("../../server/", import.meta.url));

for (const p of [PKG, SERVER_DIR]) {
  if (!resolve(p).startsWith(resolve(DIR))) throw new Error(`refusing to run: ${p} is outside ${DIR}`);
}

mkdirSync(join(PKG, "bin"), { recursive: true });
mkdirSync(SERVER_DIR, { recursive: true });
mkdirSync(join(PKG, "dist", "web"), { recursive: true });
// bin/deck.js refuses to boot without a built UI, and nothing here serves a
// page. The file only has to exist.
writeFileSync(join(PKG, "dist", "web", "index.html"), "<!doctype html>\n");
writeFileSync(join(PKG, "package.json"), JSON.stringify({
  name: "agents-deck", version: "1.36.1", type: "module",
}));
copyFileSync(join(REAL_BIN, "agent-dag.js"), join(PKG, "bin", "agent-dag.js"));
copyFileSync(join(REAL_BIN, "deck.js"), join(PKG, "bin", "deck.js"));

const real = (mod: string) => JSON.stringify(new URL(`../../server/${mod}`, import.meta.url).href);
for (const mod of readdirSync(REAL_SERVER).filter(f => f.endsWith(".mjs"))) {
  writeFileSync(join(SERVER_DIR, mod), `export * from ${real(mod)};\n`);
}

// The two shapes of "claude-swap is being set up", held open until the test
// writes STUB_CSWAP_RELEASE. `install` is a first run: ensureCswap commits to an
// install, says so through onInstalling, and does not return until it is over.
// `upgrading` is every later run that finds a newer release: the real
// ensureCswap fires the upgrade, does NOT wait for it, and answers at once —
// which is why the job settling is not enough, and upgradeSettled is the handle
// on the part that is still running.
writeFileSync(join(SERVER_DIR, "cswap-install.mjs"), [
  `export * from ${real("cswap-install.mjs")};`,
  `import { existsSync } from "node:fs";`,
  `const held = () => new Promise(done => {`,
  `  const look = () => (existsSync(process.env.STUB_CSWAP_RELEASE) ? done() : setTimeout(look, 20));`,
  `  look();`,
  `});`,
  `let upgrade = null;`,
  `export async function ensureCswap({ onInstalling = null } = {}) {`,
  `  if (process.env.STUB_CSWAP_MODE === "upgrading") {`,
  `    upgrade = held().then(() => ({ ok: true }));`,
  `    return { state: "upgrading", version: "0.24.0", latest: "0.25.0", via: "uv" };`,
  `  }`,
  `  onInstalling?.();`,
  `  await held();`,
  `  return { state: "unavailable", reason: "no_installer" };`,
  `}`,
  `export function upgradeSettled() { return upgrade; }`,
].join("\n"));

writeFileSync(join(SERVER_DIR, "self-update.mjs"), [
  `export * from ${real("self-update.mjs")};`,
  `export function versionReport() { return Promise.resolve(null); }`,
].join("\n"));

writeFileSync(join(SERVER_DIR, "installer.mjs"), [
  `export * from ${real("installer.mjs")};`,
  `export function keepDiscovery() {`,
  `  return {`,
  `    file: ${JSON.stringify(join(DIR, "never-written.json"))},`,
  `    check: () => Promise.resolve(),`,
  `    stop: () => {},`,
  `  };`,
  `}`,
].join("\n"));

const children: ChildProcess[] = [];
afterAll(() => {
  for (const c of children) killTree(c, "SIGKILL");
  rmTempDir(DIR);
});

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** A port in the band this suite's decks may use, bound once to prove it free.
 *  Tried in a random order, because other runs may be drawing from the same ten. */
async function freePort(): Promise<number> {
  const band = Array.from({ length: 10 }, (_, i) => 4540 + i).sort(() => Math.random() - 0.5);
  for (const port of band) {
    const s = createServer();
    const bound = await new Promise<boolean>(done => {
      s.once("error", () => done(false));
      s.listen(port, "127.0.0.1", () => done(true));
    });
    if (!bound) { try { s.close(); } catch { /* never listened */ } continue; }
    await new Promise<void>(done => s.close(() => done()));
    return port;
  }
  throw new Error("no free port in 4540-4549");
}

type Status = { enabled?: boolean; lastTick?: unknown } | null;

/** GET /api/cswap-auto, the route the panel reads. null for any way a port can say no. */
function status(port: number): Promise<Status> {
  return new Promise(done => {
    const req = request({ host: "127.0.0.1", port, path: "/api/cswap-auto", method: "GET", timeout: 10_000 }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", c => { body += c; });
      res.on("end", () => { try { done(JSON.parse(body)); } catch { done(null); } });
    });
    req.on("error", () => done(null));
    req.on("timeout", () => { req.destroy(); done(null); });
    req.end();
  });
}

interface Run { child: ChildProcess; port: number; release: string; out: { text: string } }

async function launch(mode: "install" | "upgrading"): Promise<Run> {
  const home = mkdtempSync(join(DIR, `home-${mode}-`));
  // The loop only arms at boot for a user who had it switched on, so this user did.
  mkdirSync(join(home, ".agents-deck"), { recursive: true });
  writeFileSync(join(home, ".agents-deck", "cswap-auto.json"), JSON.stringify({ enabled: true }));
  const release = join(home, "release-cswap");
  const port = await freePort();
  const out = { text: "" };
  const child = spawn(process.execPath, [
    join(PKG, "bin", "deck.js"),
    "--port", String(port), "--no-open",
    // --claude, not the machine's answer: every job this is about is a Claude
    // Code job, and a runner without Claude Code would skip the lot.
    "--claude", "--no-codex",
    "--history", join(home, "events.jsonl"),
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: home, USERPROFILE: home,
      CLAUDE_CONFIG_DIR: join(home, "claude"),
      CODEX_HOME: join(home, "codex"),
      AGENTS_DECK_NO_INSTALL: "1",
      AGENTS_DECK_NO_LAN: "1",
      // An explicit path wins over every lookup in cswapBin, so this is the only
      // claude-swap the deck can reach — and there is nothing there.
      AGENTS_DECK_CSWAP: join(home, "no-claude-swap-here"),
      STUB_CSWAP_RELEASE: release,
      STUB_CSWAP_MODE: mode,
      NO_COLOR: "1",
    },
  });
  children.push(child);
  child.stdout!.on("data", d => { out.text += String(d); });
  child.stderr!.on("data", d => { out.text += String(d); });
  return { child, port, release, out };
}

/** Poll until `ok` answers, failing with the deck's own transcript. */
async function until(run: Run, ok: () => Promise<boolean>, ms: number, what: string) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await ok()) return;
    // A deck that lost the port it was given falls back into 4318-4400. Nothing
    // here may sit there, so that is the end of the case rather than a retry.
    const bound = Number(/http:\/\/127\.0\.0\.1:(\d+)/.exec(run.out.text)?.[1] ?? 0);
    if (bound && bound !== run.port) {
      killTree(run.child, "SIGKILL");
      throw new Error(`the deck bound ${bound} instead of ${run.port}; the port was taken between the check and the bind`);
    }
    await sleep(200);
  }
  throw new Error(`timed out after ${ms}ms waiting for ${what}\n${run.out.text}`);
}

/**
 * Boot a deck in `mode`, and read `lastTick` twice: once while claude-swap is
 * still being set up, and once after it has settled.
 *
 * The first read is a window, not a sample. It starts when the panel reports the
 * persisted switch back on — initCswapAuto has run by then, and an unheld eager
 * tick is a failed spawn and a `ps` away — and it lasts three seconds, which on
 * this machine is several unheld ticks over. Any tick inside it ends the window
 * with that tick in hand.
 */
async function ticksAround(mode: "install" | "upgrading") {
  const run = await launch(mode);
  try {
    await until(run, async () => (await status(run.port))?.enabled === true, 30_000, "the persisted auto-switch to come back on");

    let early: unknown = null;
    const window = Date.now() + 3_000;
    while (Date.now() < window && early == null) {
      early = (await status(run.port))?.lastTick ?? null;
      if (early == null) await sleep(200);
    }

    writeFileSync(run.release, "go\n");
    let late: unknown = null;
    await until(run, async () => {
      late = (await status(run.port))?.lastTick ?? null;
      return late != null;
    }, 30_000, "the first tick after claude-swap settled");
    return { early, late };
  } finally {
    killTree(run.child, "SIGKILL");
  }
}

describe("the auto-switch on a boot that is still setting up claude-swap", () => {
  it("does not tick while ensureCswap is still installing it", async () => {
    const { early, late } = await ticksAround("install");
    expect(early, "a tick ran against a claude-swap that was still being installed").toBe(null);
    // And the hold is a hold, not a loop that never starts: the tick the boot
    // queued runs the moment the install settles.
    expect(late).not.toBe(null);
  }, 90_000);

  it("does not tick while the upgrade ensureCswap started in the background is running", async () => {
    // ensureCswap has already RETURNED here, so the startup job settles at once.
    // Waiting on the job alone would still have let this tick through.
    const { early, late } = await ticksAround("upgrading");
    expect(early, "a tick ran against a claude-swap that was still being upgraded").toBe(null);
    expect(late).not.toBe(null);
  }, 90_000);
});
