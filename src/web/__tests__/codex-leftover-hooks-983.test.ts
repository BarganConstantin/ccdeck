// An older deck's Codex forwarders, named at boot and left where they are (#983).
//
// #253 stopped installing Codex hooks and #317 deleted the recipe, but a machine
// that ran a deck from before either still has our forwarders in
// $CODEX_HOME/hooks.json: nine marked entries pointing at a copy of hook.js that
// is still on disk. Wherever Codex honours that file each one posts to
// /api/event, which takes a post without a token, while the rollout watcher
// reads the same session off disk. One session ingested twice — both copies in
// the ring and in events.jsonl, folded on the card only when they land inside
// the reducer's two-second redelivery windows — and nothing anywhere saying
// why. `--uninstall` was the only thing that looked, and nobody runs it to cure
// a duplicate they have no reason to connect with it.
//
// So the boot looks, reads only, and says so in one row naming the file and the
// command. These pin both halves. The row appears on the machine that has them
// and on no other; and hooks.json comes out of the boot byte for byte as it went
// in, because a boot writes nothing under the Codex directory, and this is the
// test that notices if a later change decides to "just clean it up".
//
// PLAIN NODE, TEMP HOME. $HOME, %USERPROFILE%, CLAUDE_CONFIG_DIR and CODEX_HOME
// all point into one mkdtemp directory before the installer is imported, since
// it resolves both config dirs at module load, and each boot is spawned inside
// the same directory. The deck binds only inside 4530-4539: the port is chosen
// from that band and startServer's fallback range is pinned to it too, so a port
// taken between the check and the bind cannot send the deck into 4318-4400,
// beside a developer's own deck.
import { describe, it, expect, afterAll, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-codex-leftover-"));
const FAKE_CLAUDE = join(DIR, "claude");
const FAKE_CODEX = join(DIR, "codex");
const prevEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
};
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = FAKE_CLAUDE;
process.env.CODEX_HOME = FAKE_CODEX;
for (const p of [process.env.HOME, process.env.USERPROFILE, process.env.CLAUDE_CONFIG_DIR, process.env.CODEX_HOME]) {
  if (!resolve(p!).startsWith(resolve(DIR))) throw new Error(`sandbox escaped: ${p}`);
}

// @ts-expect-error — plain .mjs module, no types
const installer = await import("../../server/installer.mjs");
const { leftoverCodexHooks, CODEX_DIR } = installer as {
  leftoverCodexHooks: () => Promise<{ settingsPath: string; count: number } | null>;
  CODEX_DIR: string;
};
// @ts-expect-error — plain .mjs module, no types
const { killTree } = await import("../../server/exec.mjs");

// Every write below lands under whatever the installer resolved, so if the
// override were ignored this file would edit a real hooks.json.
if (!String(CODEX_DIR).startsWith(FAKE_CODEX)) {
  throw new Error(`refusing to run: installer resolved ${CODEX_DIR}, outside ${FAKE_CODEX}`);
}
const HOOKS = join(CODEX_DIR, "hooks.json");
mkdirSync(CODEX_DIR, { recursive: true });
mkdirSync(FAKE_CLAUDE, { recursive: true });

afterAll(() => {
  for (const [key, was] of Object.entries(prevEnv)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  rmTempDir(DIR);
});

/** The events a deck from before #253 installed a Codex forwarder on —
 *  `git show ca9c058^:src/server/installer.mjs`. */
const CODEX_EVENTS = [
  "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse",
  "SubagentStart", "SubagentStop", "Stop", "PreCompact", "PostCompact",
];

const theirs = { hooks: [{ type: "command", command: "echo mine" }] };

/** hooks.json as a deck from before #253 left it: one marked forwarder per
 *  event, in the double-quoted form hookCommand used then, and one hook of the
 *  user's own beside them. */
function upgradedMachine(): string {
  const forwarder = `"${process.execPath}" "${join(CODEX_DIR, "agent-dag", "hook.js")}" --provider codex`;
  const hooks: Record<string, unknown[]> = {};
  for (const evt of CODEX_EVENTS) {
    hooks[evt] = [{ "__agent-dag": true, hooks: [{ type: "command", command: forwarder, timeout: 3 }] }];
  }
  hooks.UserPromptSubmit.unshift(theirs);
  return JSON.stringify({ hooks }, null, 2) + "\n";
}

/** The same file on a machine that never ran one: the user's own hook alone. */
function cleanMachine(): string {
  return JSON.stringify({ hooks: { UserPromptSubmit: [theirs] } }, null, 2) + "\n";
}

describe("finding an older deck's Codex forwarders", () => {
  afterEach(() => { rmSync(HOOKS, { force: true }); });

  it("counts every one of them and names the file", async () => {
    writeFileSync(HOOKS, upgradedMachine());
    expect(await leftoverCodexHooks()).toEqual({ settingsPath: HOOKS, count: CODEX_EVENTS.length });
  });

  it("leaves the file byte for byte as it found it", async () => {
    const before = upgradedMachine();
    writeFileSync(HOOKS, before);
    await leftoverCodexHooks();
    expect(readFileSync(HOOKS, "utf8")).toBe(before);
  });

  it("knows the ones older names left too, by their mark or by the path they run", async () => {
    // The same test uninstallHooks applies, so the row never names a file that
    // `--uninstall` would then report it had nothing to take out of.
    writeFileSync(HOOKS, JSON.stringify({ hooks: {
      Stop: [
        { "__agent-flow": true, hooks: [{ type: "command", command: "node x.js" }] },
        { hooks: [{ type: "command", command: "node /home/someone/.codex/ccgraph/hook.js --provider codex" }] },
        theirs,
      ],
    } }));
    expect((await leftoverCodexHooks())?.count).toBe(2);
  });

  it("says nothing about a file with none of ours in it", async () => {
    writeFileSync(HOOKS, cleanMachine());
    expect(await leftoverCodexHooks()).toBeNull();
  });

  it("says nothing when there is no hooks.json at all", async () => {
    expect(await leftoverCodexHooks()).toBeNull();
  });

  it("says nothing, and throws nothing, about a file nobody could parse", async () => {
    // A boot must not die over a Codex file, and naming hooks in a file nobody
    // could read would be a guess. `--uninstall` reports this case out loud.
    writeFileSync(HOOKS, "{ not json");
    expect(await leftoverCodexHooks()).toBeNull();
    expect(readFileSync(HOOKS, "utf8")).toBe("{ not json");
  });
});

// ── the boot ────────────────────────────────────────────────────────────────
//
// A copy of the real bin/deck.js in a package whose server modules re-export
// the real ones, the way boot-listen-before-report.test.ts builds it: the file
// under test is the deck's own, and nothing needs a built UI. Two modules are
// shadowed. The registry lookup answers null, because a boot test has no
// business on the network; and startServer's fallback range is pinned to the
// band this file may bind.

const PORT_LO = 4530;
const PORT_HI = 4539;

const PKG = join(DIR, "pkg");
const SERVER_DIR = join(PKG, "src", "server");
const REAL_BIN = fileURLToPath(new URL("../../../bin/", import.meta.url));
const REAL_SERVER = fileURLToPath(new URL("../../server/", import.meta.url));

mkdirSync(join(PKG, "bin"), { recursive: true });
mkdirSync(SERVER_DIR, { recursive: true });
mkdirSync(join(PKG, "dist", "web"), { recursive: true });
// bin/deck.js refuses to boot without a built UI; nothing here asks for a page.
writeFileSync(join(PKG, "dist", "web", "index.html"), "<!doctype html>\n");
writeFileSync(join(PKG, "package.json"), JSON.stringify({ name: "ccdeck", version: "0.0.0-test", type: "module" }));
copyFileSync(join(REAL_BIN, "agent-dag.js"), join(PKG, "bin", "agent-dag.js"));
copyFileSync(join(REAL_BIN, "deck.js"), join(PKG, "bin", "deck.js"));
const real = (mod: string) => JSON.stringify(new URL(`../../server/${mod}`, import.meta.url).href);
for (const mod of readdirSync(REAL_SERVER).filter(f => f.endsWith(".mjs"))) {
  writeFileSync(join(SERVER_DIR, mod), `export * from ${real(mod)};\n`);
}
writeFileSync(join(SERVER_DIR, "self-update.mjs"), [
  `export * from ${real("self-update.mjs")};`,
  `export function versionReport() { return Promise.resolve(null); }`,
].join("\n"));
// A local export shadows the same name arriving through `export *`.
writeFileSync(join(SERVER_DIR, "index.mjs"), [
  `export * from ${real("index.mjs")};`,
  `import { startServer as realStartServer } from ${real("index.mjs")};`,
  `export function startServer(opts) {`,
  `  return realStartServer({ ...opts, portRange: [${PORT_LO}, ${PORT_HI}] });`,
  `}`,
].join("\n"));

/** A port in the band, held until the moment of the spawn rather than dropped
 *  at the moment it was found free. */
async function holdPort(): Promise<{ port: number; release: () => Promise<void> }> {
  const band = Array.from({ length: PORT_HI - PORT_LO + 1 }, (_, i) => PORT_LO + i)
    .sort(() => Math.random() - 0.5);
  for (const port of band) {
    const s = createServer();
    const bound = await new Promise<boolean>(done => {
      s.once("error", () => done(false));
      s.listen(port, "127.0.0.1", () => done(true));
    });
    if (!bound) { try { s.close(); } catch { /* never listened */ } continue; }
    return { port, release: () => new Promise<void>(done => { s.close(() => done()); }) };
  }
  throw new Error(`no free port in ${PORT_LO}-${PORT_HI}`);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Boot the deck once, in a home of its own under DIR, and wait for the last
 *  row of its report. Its Codex directory is the one this file writes. */
async function bootOnce(): Promise<{ child: ChildProcess; text: () => string }> {
  const home = mkdtempSync(join(DIR, "home-"));
  const held = await holdPort();
  await held.release();
  let out = "";
  const child = spawn(process.execPath, [
    join(PKG, "bin", "deck.js"),
    "--port", String(held.port), "--no-open", "--no-claude",
    "--history", join(home, "events.jsonl"),
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: home, USERPROFILE: home,
      CLAUDE_CONFIG_DIR: join(home, "claude"),
      CODEX_HOME: CODEX_DIR,
      AGENTS_DECK_NO_LAN: "1",
      AGENTS_DECK_NO_INSTALL: "1",
      NO_COLOR: "1",
    },
  });
  child.stdout!.on("data", d => { out += String(d); });
  child.stderr!.on("data", d => { out += String(d); });
  const deadline = Date.now() + 30_000;
  while (!/server ready/.test(out)) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`the deck exited before it was ready:\n${out}`);
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for "server ready":\n${out}`);
    await sleep(50);
  }
  return { child, text: () => out };
}

/** Stop a deck this file started, by its own handle, and wait until it is gone. */
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const gone = new Promise<void>(done => child.once("exit", () => done()));
  killTree(child, "SIGTERM");
  const hard = setTimeout(() => killTree(child, "SIGKILL"), 5_000);
  await gone;
  clearTimeout(hard);
}

describe("the boot, on a machine an older deck left its Codex hooks on", () => {
  let child: ChildProcess | null = null;

  afterEach(async () => {
    if (child) await stop(child);
    child = null;
    rmSync(HOOKS, { force: true });
  });

  it("names the file and the command that takes them out", async () => {
    writeFileSync(HOOKS, upgradedMachine());
    const deck = await bootOnce();
    child = deck.child;
    const text = deck.text();
    expect(text, text).toContain("Codex hooks");
    expect(text, text).toContain(HOOKS);
    expect(text, text).toContain("--uninstall` takes them out");
    // The watcher is running on this deck, so the symptom is named with it.
    expect(text, text).toContain("Codex sessions can arrive twice");
  }, 45_000);

  it("writes nothing to that file on the way", async () => {
    const before = upgradedMachine();
    writeFileSync(HOOKS, before);
    const deck = await bootOnce();
    child = deck.child;
    expect(readFileSync(HOOKS, "utf8")).toBe(before);
  }, 45_000);

  it("says nothing of the kind on a machine that has none", async () => {
    writeFileSync(HOOKS, cleanMachine());
    const deck = await bootOnce();
    child = deck.child;
    const text = deck.text();
    expect(text).not.toContain("Codex hooks");
    expect(text).not.toContain("--uninstall");
  }, 45_000);
});
