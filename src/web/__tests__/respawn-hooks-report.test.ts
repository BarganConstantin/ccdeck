// What a respawned deck reports about the Claude hooks (bin/deck.js,
// activation.mjs, reports.mjs).
//
// A respawn — a restart, a crash brought back, the relaunch after an update the
// deck ran itself — used to say "ok" for the hooks before it had done anything,
// so the "update" report a self-update sends, and every later "active", said
// the hooks went in even when this process's re-install had just refused an
// unparseable settings.json. Now a respawn that re-installed says how that
// went, one that installed nothing says what the session's first boot said —
// which the supervisor hands down in AGENTS_DECK_BOOT_HOOKS — and one under a
// supervisor that handed down nothing says nothing rather than guess.
//
// The real bin/deck.js, spawned as the supervisor respawns it, in a sandbox:
// HOME, CLAUDE_CONFIG_DIR, CODEX_HOME, CCDECK_HOME and the XDG dirs all inside
// one temp directory, `--port 0`, no LAN, no browser. Reports have to be on for
// there to be anything to read, so fetch is replaced before the deck loads: the
// reports land in a file, and every other request fails as if offline.
import { describe, it, expect, afterAll, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rmTempDir } from "./rm-temp-dir";

// @ts-expect-error — plain .mjs module, no types
const { killTree } = await import("../../server/exec.mjs");

const PKG = fileURLToPath(new URL("../../../", import.meta.url));
const DECK = join(PKG, "bin", "deck.js");
const VERSION = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")).version as string;

const SANDBOX = mkdtempSync(join(tmpdir(), "ccdeck-respawn-report-"));
const CFG = join(SANDBOX, ".claude");
const SETTINGS = join(CFG, "settings.json");
const STUB = join(SANDBOX, "fetch-stub.mjs");
afterAll(() => rmTempDir(SANDBOX));

writeFileSync(STUB, [
  `import { appendFileSync } from "node:fs";`,
  `globalThis.fetch = async (url, init = {}) => {`,
  `  const u = String(url);`,
  `  if (!u.startsWith("https://api.ccdeck.dev/")) throw new Error("offline (test)");`,
  `  appendFileSync(process.env.STUB_REPORTS_LOG, JSON.stringify({ url: u, body: init.body ? JSON.parse(init.body) : null }) + "\\n");`,
  `  return new Response(null, { status: 202 });`,
  `};`,
].join("\n"));

let child: ChildProcess | null = null;

afterEach(async () => {
  const c = child;
  child = null;
  if (!c || c.exitCode !== null || c.signalCode !== null) return;
  const gone = new Promise<void>(done => c.once("exit", () => done()));
  killTree(c, "SIGTERM");
  const hard = setTimeout(() => killTree(c, "SIGKILL"), 5_000);
  await gone;
  clearTimeout(hard);
});

type Seen = { update: Record<string, unknown>; setup: Record<string, unknown>[]; out: string };

/** Respawn the worker the way the supervisor does, over an install that last
 *  reported from 0.0.1, and wait for the "update" report it sends. */
function respawn(name: string, { bootVersion, bootHooks, settings }: {
  bootVersion: string; bootHooks?: string; settings: string;
}): Promise<Seen> {
  const home = join(SANDBOX, name);
  const deckHome = join(home, "deck-data");
  const log = join(home, "reports.jsonl");
  for (const p of [home, deckHome, log]) {
    if (!resolve(p).startsWith(resolve(SANDBOX))) throw new Error(`sandbox escaped: ${p}`);
  }
  mkdirSync(deckHome, { recursive: true });
  mkdirSync(CFG, { recursive: true });
  writeFileSync(SETTINGS, settings);
  writeFileSync(log, "");
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(join(deckHome, "prefs.json"), JSON.stringify({
    report: { installId: `id-${name}`, lastVersion: "0.0.1", lastActiveDay: today, installedAt: "", activationSent: true },
  }));

  return new Promise((done, fail) => {
    let out = "";
    const setup: Record<string, unknown>[] = [];
    const c = spawn(process.execPath, ["--import", pathToFileURL(STUB).href, DECK,
      "--no-open", "--port", "0", "--no-persist", "--claude", "--no-codex"], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      cwd: SANDBOX,
      env: {
        ...process.env,
        HOME: SANDBOX,
        USERPROFILE: SANDBOX,
        CLAUDE_CONFIG_DIR: CFG,
        CODEX_HOME: join(SANDBOX, ".codex"),
        XDG_CONFIG_HOME: join(home, "xdg-config"),
        XDG_DATA_HOME: join(home, "xdg-data"),
        XDG_STATE_HOME: join(home, "xdg-state"),
        XDG_CACHE_HOME: join(home, "xdg-cache"),
        CCDECK_HOME: deckHome,
        STUB_REPORTS_LOG: log,
        AGENTS_DECK_RESPAWN: "1",
        AGENTS_DECK_BOOT_VERSION: bootVersion,
        AGENTS_DECK_BOOT_HOOKS: bootHooks,
        // Reports on: neither of the two vetoes.
        AGENTS_DECK_NO_INSTALL: undefined,
        AGENTS_DECK_NO_REPORTS: undefined,
        AGENTS_DECK_NO_LAN: "1",
        AGENTS_DECK_NO_NOTIFY: "1",
        AGENTS_DECK_NO_MUSIC: "1",
        AGENTS_DECK_NO_UPDATE_CHECK: "1",
        AGENTS_DECK_NO_DOWNLOAD: "1",
        AGENTS_DECK_NO_STATUS: "1",
        AGENTS_DECK_NO_FRESHEN: "1",
        NO_COLOR: "1",
        FORCE_COLOR: undefined,
      },
    });
    child = c;
    c.stdout!.on("data", d => { out += String(d); });
    c.stderr!.on("data", d => { out += String(d); });
    c.on("message", (m: { type?: string }) => { if (m?.type === "setup") setup.push(m as Record<string, unknown>); });
    const timer = setTimeout(() => { clearInterval(poll); fail(new Error(`no "update" report within 40s:\n${out}`)); }, 40_000);
    const poll = setInterval(() => {
      if (!existsSync(log)) return;
      const sent = readFileSync(log, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
      const update = sent.find(s => s.url.endsWith("/v1/app/events") && s.body?.kind === "update");
      if (!update) return;
      clearInterval(poll);
      clearTimeout(timer);
      done({ update: update.body, setup, out });
    }, 100);
    c.on("exit", (code, signal) => {
      clearInterval(poll);
      clearTimeout(timer);
      fail(new Error(`the deck exited (${code ?? signal}) before it reported:\n${out}`));
    });
  });
}

describe("a respawn that re-installed the hooks", () => {
  it("reports how that went — failed, over a settings.json it refused to rewrite", async () => {
    const seen = await respawn("reinstall-failed", { bootVersion: "0.0.1", settings: "{ not json" });
    expect(seen.update, seen.out).toMatchObject({ kind: "update", fromVersion: "0.0.1", claudeHooks: "failed" });
    // And tells the supervisor, for the next respawn to say the same.
    expect(seen.setup, seen.out).toContainEqual({ type: "setup", claudeHooks: "failed" });
  }, 60_000);
});

describe("a respawn on the version the session started on", () => {
  it("reports what the session's first boot said, as the supervisor handed it down", async () => {
    const seen = await respawn("carried", { bootVersion: VERSION, bootHooks: "failed", settings: "{}\n" });
    expect(seen.update, seen.out).toMatchObject({ kind: "update", claudeHooks: "failed" });
  }, 60_000);

  it("says nothing about the hooks when the supervisor handed nothing down", async () => {
    const seen = await respawn("not-carried", { bootVersion: VERSION, settings: "{}\n" });
    expect(seen.update, seen.out).toMatchObject({ kind: "update", codexWatch: "off" });
    expect(seen.update, seen.out).not.toHaveProperty("claudeHooks");
  }, 60_000);
});

// The other half: the shipped bin/agent-dag.js, run in a temp install layout
// over a two-line worker that says how its hooks went and asks to be restarted,
// then prints what the supervisor handed its replacement. The server modules
// the supervisor imports are re-exported from the repo, so what runs is what
// ships; nothing is installed and nothing listens.
describe("the supervisor", () => {
  it("hands what a worker said about the hooks to the worker it starts next", async () => {
    const root = join(SANDBOX, "supervised");
    const server = join(root, "src", "server");
    if (!resolve(root).startsWith(resolve(SANDBOX))) throw new Error("sandbox escaped");
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(server, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "agents-deck", version: "1.33.88", type: "module" }));
    copyFileSync(join(PKG, "bin", "agent-dag.js"), join(root, "bin", "agent-dag.js"));
    for (const mod of ["args.mjs", "brand.mjs", "detach.mjs", "exec.mjs", "invoked-as.mjs", "npx.mjs", "self-update.mjs", "supervisor.mjs", "term.mjs"]) {
      writeFileSync(join(server, mod), `export * from ${JSON.stringify(pathToFileURL(join(PKG, "src", "server", mod)).href)};\n`);
    }
    writeFileSync(join(root, "bin", "deck.js"), [
      `const say = (s) => process.stdout.write(s + "\\n");`,
      `const handed = process.env.AGENTS_DECK_BOOT_HOOKS || "nothing";`,
      `if (process.env.AGENTS_DECK_RESPAWN === "1") { say("RESPAWN HANDED " + handed); process.exit(0); }`,
      `say("FIRST HANDED " + handed);`,
      // RESTART_CODE, once the message is on its way.
      `process.send({ type: "setup", claudeHooks: "failed" }, () => setTimeout(() => process.exit(75), 100));`,
      `setTimeout(() => process.exit(3), 10000);`,
    ].join("\n"));

    const out = await new Promise<string>((done, fail) => {
      let text = "";
      const c = spawn(process.execPath, [join(root, "bin", "agent-dag.js"), "--no-persist"], {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: SANDBOX,
        // AGENTS_DECK_DETACHED, or the supervisor puts a copy of itself in the
        // background and leaves.
        env: {
          ...process.env, HOME: SANDBOX, USERPROFILE: SANDBOX, CLAUDE_CONFIG_DIR: CFG,
          CODEX_HOME: join(SANDBOX, ".codex"), CCDECK_HOME: join(SANDBOX, "supervised-data"),
          AGENTS_DECK_DETACHED: "1", AGENTS_DECK_BOOT_HOOKS: undefined, NO_COLOR: "1", FORCE_COLOR: undefined,
        },
      });
      child = c;
      c.stdout!.on("data", d => { text += String(d); });
      c.stderr!.on("data", d => { text += String(d); });
      const timer = setTimeout(() => fail(new Error(`the supervisor did not finish within 20s:\n${text}`)), 20_000);
      c.on("exit", () => { clearTimeout(timer); done(text); });
    });

    expect(out).toContain("FIRST HANDED nothing");
    expect(out).toContain("RESPAWN HANDED failed");
  }, 30_000);
});
