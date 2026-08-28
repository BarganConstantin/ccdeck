// The supervisor and the worker it spawns have to be the same package (#548).
//
// An npx upgrade is keyed by a package NAME four times over: the dist-tag that
// was fetched, the marker that cached the answer, the `.restart-failed-<name>-
// <pid>` note the browser reads, and the argv `npx -y <name>@latest` runs. Two
// processes compute that name. The worker asks `upgradeName`, which resolves
// the npx case as `bareSpecName(npxRestartSpec(pkgRoot, installedName(pkgRoot)))`
// — the spec npm recorded, and this build's own manifest when that spec cannot
// be read. bin/agent-dag.js asked `npxRestartSpec(PKG_ROOT)` and took the
// module's default fallback, which is the literal string "agents-deck".
//
// Both read `_npx/<hash>/package.json`, so the two agreed for as long as that
// file was readable — and #340 is what made the disagreement matter when it is
// not. The three published names are one tarball now, so the manifest inside a
// `npx ccdeck` run genuinely says `ccdeck`, where before it always said
// `agents-deck` and the supervisor's default was accidentally right. A cache
// directory written by an npm whose `_npx.packages` layout differs, or a file
// truncated by a full disk, now splits the two processes apart:
//
//   • the worker asks npm about `ccdeck` and reads `.restart-failed-ccdeck-…`;
//   • the supervisor writes `.restart-failed-agents-deck-…`, where the browser
//     never looks — the exact class of bug NOTE_PREFIX's naming exists to
//     prevent;
//   • it takes `lastKnownLatest("agents-deck")` off a marker nobody wrote, so
//     `target` is null and upgradeAttempt's per-target cap degrades from "this
//     version already failed here" to "any failure counts";
//   • and it relaunches `npx -y agents-deck@latest`, silently moving someone
//     who typed `npx ccdeck` onto a different published name.
//
// So the assertions below are about one string being one string. The rule spans
// two processes, so it is checked by running them: each case builds a real
// install layout in a temp directory and runs the SHIPPED bin/agent-dag.js
// inside it, exactly as upgrade-no-outage.test.ts does and for the same reason.
// The two npx entry points are shadowed in a sandbox copy of npx.mjs, so
// nothing is fetched and nothing is installed; the worker is a stub that asks
// to be upgraded. The worker's half of the answer is not stubbed at all — it is
// `upgradeName` itself, imported here and asked about the same directory, so
// the two halves are compared rather than both being restated.
//
// Nested one level deeper than upgrade-no-outage.test.ts's layout, which
// collapses `_npx/<hash>` and the package root into one directory. npx really
// unpacks into `_npx/<hash>/node_modules/<pkg>`, and the whole bug lives in the
// gap between those two package.json files: one carries the spec, the other
// carries the name.
import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { rmTempDir } from "./rm-temp-dir";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { upgradeCommand, upgradeName } from "../../server/self-update.mjs";

const SANDBOX = mkdtempSync(join(tmpdir(), "ccdeck-one-package-"));
const prevEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
};
process.env.HOME = SANDBOX;
process.env.USERPROFILE = SANDBOX;
process.env.CLAUDE_CONFIG_DIR = join(SANDBOX, ".claude");
process.env.CODEX_HOME = join(SANDBOX, ".codex");
afterAll(() => {
  for (const [key, was] of Object.entries(prevEnv)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  rmTempDir(SANDBOX);
});

const MARKERS = join(SANDBOX, ".agents-deck");
const FAKE_NPX = join(SANDBOX, "fake-npx.mjs");
mkdirSync(MARKERS, { recursive: true });

// What the version check last heard from npm — under `ccdeck` and under that
// name ONLY. The asymmetry is deliberate and is half of what the note proves:
// a supervisor that decided it was `agents-deck` reads a marker nobody wrote,
// answers `target: null`, and stops being able to say which version failed.
writeFileSync(join(MARKERS, ".self-update-check-ccdeck"), JSON.stringify({ at: Date.now(), version: "9.9.9" }));

// Stands in for the npx that would start the replacement deck: exits 1 without
// binding anything, so the supervisor's own give-up path runs.
writeFileSync(FAKE_NPX, `process.exit(1);\n`);

/**
 * One install of the deck, on disk, laid out the way the case under test would
 * really find it.
 *
 * `npxMeta` is the `_npx/<hash>/package.json` npm writes beside the package —
 * null for the install shapes that have no such directory at all. `manifest` is
 * the package's own package.json, which is the answer npm's publish-time rename
 * left behind and the fallback the fix reaches for.
 */
function plant(dir: string, { manifest, npxMeta }: { manifest: object; npxMeta?: string }) {
  if (!dir.startsWith(SANDBOX)) throw new Error(`refusing to plant ${dir} outside ${SANDBOX}`);
  const server = join(dir, "src", "server");
  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(server, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module", ...manifest }));
  if (npxMeta !== undefined) writeFileSync(join(dir, "..", "..", "package.json"), npxMeta);

  copyFileSync(fileURLToPath(new URL("../../../bin/agent-dag.js", import.meta.url)), join(dir, "bin", "agent-dag.js"));

  // The server modules the supervisor imports, re-exported from the repo rather
  // than copied, so what runs here is what ships…
  for (const mod of ["brand.mjs", "exec.mjs", "invoked-as.mjs", "self-update.mjs", "supervisor.mjs", "term.mjs"]) {
    const real = new URL(`../../server/${mod}`, import.meta.url).href;
    writeFileSync(join(server, mod), `export * from ${JSON.stringify(real)};\n`);
  }
  // …except the two that would reach a registry. A local export shadows the
  // same name coming from `export *`, so the rest of npx.mjs is still real.
  // Both record the SPEC they were handed, because the spec is the whole
  // question here.
  const realNpx = new URL("../../server/npx.mjs", import.meta.url).href;
  writeFileSync(join(server, "npx.mjs"), [
    `import { appendFileSync } from "node:fs";`,
    `export * from ${JSON.stringify(realNpx)};`,
    `const log = (line) => appendFileSync(process.env.STUB_LOG, line + "\\n");`,
    `export function npxPrefetch(spec) {`,
    `  log("prefetch " + spec);`,
    `  return Promise.resolve(process.env.STUB_FETCH_OK === "1"`,
    `    ? { ok: true, error: null, hint: null }`,
    `    : { ok: false, error: "notarget No matching version found.", hint: null });`,
    `}`,
    `export function npxLaunch(args) {`,
    `  log("launch " + args.join(" "));`,
    `  return { file: process.execPath, args: [${JSON.stringify(FAKE_NPX)}, ...args], opts: {}, via: "node", cli: null };`,
    `}`,
  ].join("\n"));

  // Stands in for bin/deck.js: asks to be upgraded the way a clicked "Update &
  // restart" does, then says what it was told. A relaunched worker asks for
  // nothing, otherwise a give-up would loop.
  writeFileSync(join(dir, "bin", "deck.js"), [
    `const say = (s) => process.stdout.write(s + "\\n");`,
    `if (process.env.AGENTS_DECK_RESPAWN === "1") { say("RESPAWNED"); process.exit(0); }`,
    `process.send({ type: "listening", port: Number(process.env.STUB_PORT) });`,
    `process.send({ type: "upgrade" });`,
    `process.on("message", (m) => {`,
    `  say("REPLY " + m.type + " " + (m.error ?? ""));`,
    `  if (m.type === "upgrade-ready") { process.exit(76); return; }`,
    `  setTimeout(() => { say("STILL-ALIVE"); process.exit(0); }, 100);`,
    `});`,
    // Only a floor under a run that has already gone wrong: every reply arrives
    // in milliseconds, and a supervisor that never answers must not hang the
    // suite.
    `setTimeout(() => { say("WORKER-TIMEOUT"); process.exit(3); }, 4000);`,
  ].join("\n"));
  return dir;
}

type Run = {
  out: string;
  /** Every spec the stubbed npx was asked for, in order. */
  log: string[];
  /** The name of the restart-failure note, which is the note's whole point. */
  noteFile: string | null;
  note: any;
};

/** One whole supervisor lifetime, from launch to exit, over one install. */
const runDeck = (dir: string, env: Record<string, string> = {}) =>
  new Promise<Run>((resolve) => {
    const logFile = join(SANDBOX, `log-${Math.random().toString(36).slice(2)}.txt`);
    writeFileSync(logFile, "");
    for (const f of readdirSync(MARKERS)) {
      if (f.startsWith(".restart-failed-")) rmSync(join(MARKERS, f), { force: true });
    }
    const child = spawn(process.execPath, [join(dir, "bin", "agent-dag.js"), "--no-persist"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, STUB_LOG: logFile, STUB_PORT: "47719", ...env },
    });
    let out = "";
    child.stdout.on("data", d => { out += String(d); });
    child.stderr.on("data", d => { out += String(d); });
    child.on("exit", () => {
      const notes = readdirSync(MARKERS).filter(f => f.startsWith(".restart-failed-"));
      resolve({
        out,
        log: readFileSync(logFile, "utf8").split("\n").filter(Boolean),
        noteFile: notes[0] ?? null,
        note: notes.length ? JSON.parse(readFileSync(join(MARKERS, notes[0]), "utf8")) : null,
      });
    });
  });

// ── the three shapes an install can have ─────────────────────────────────────

// An `npx ccdeck` run whose cache metadata cannot be read: the file is there
// and is not JSON, which is what a differently-shaped `_npx` entry or a
// truncated write leaves behind. Everything that still knows which package this
// is now lives in the package's own manifest.
const BLIND_NPX = plant(join(SANDBOX, "blind", "_npx", "deadbeef", "node_modules", "ccdeck"), {
  manifest: { name: "ccdeck", version: "1.33.88" },
  npxMeta: '{"_npx":{"packa',
});

// The same run with the metadata intact, and with the manifest naming a
// DIFFERENT alias — the pre-#340 shape, where `npx ccdeck` unpacked a tarball
// whose package.json said `agents-deck`. The spec npm recorded is the better
// answer and has to keep outranking the fallback.
const SPEAKING_NPX = plant(join(SANDBOX, "speaking", "_npx", "cafe1234", "node_modules", "agents-deck"), {
  manifest: { name: "agents-deck", version: "1.33.88" },
  npxMeta: JSON.stringify({ _npx: { packages: ["ccdeck@latest"] } }),
});

// `npm i -g ccdeck`, which since #340 puts the deck straight into the global
// tree with nothing above it and no _npx anywhere.
const GLOBAL = plant(join(SANDBOX, "global", "lib", "node_modules", "ccdeck"), {
  manifest: { name: "ccdeck", version: "1.33.88" },
});

// A maintainer's own tree. Nothing was installed, so nothing can be re-run.
//
// Two of them, because git leaves two different things behind and both are a
// checkout (#587). An ordinary clone gets a `.git` DIRECTORY; a linked worktree
// or a submodule gets a `.git` FILE whose whole content is one `gitdir:` line
// naming the real repository elsewhere. Only the first was ever built here — as
// it was in every other fixture in the suite — so the file shape, which is the
// shape this repo's own agents run in, had never once reached this code.
const CHECKOUT = plant(join(SANDBOX, "checkout"), {
  manifest: { name: "agents-deck", version: "1.33.88" },
});
mkdirSync(join(CHECKOUT, ".git"), { recursive: true });

const WORKTREE = plant(join(SANDBOX, "worktree"), {
  manifest: { name: "agents-deck", version: "1.33.88" },
});
// The path is built with join, so it carries the host's own separator and, on
// Windows, a drive letter. Nothing parses it — the predicate stats the entry and
// stops — which is exactly what makes the rule the same on all three platforms.
const WORKTREE_GITDIR = join(SANDBOX, "worktree-main", ".git", "worktrees", "wt");
mkdirSync(WORKTREE_GITDIR, { recursive: true });
writeFileSync(join(WORKTREE, ".git"), `gitdir: ${WORKTREE_GITDIR}\n`);

describe("an npx deck whose cache metadata cannot be read", () => {
  it("fetches the package the worker asked npm about, not the module's default", async () => {
    const run = await runDeck(BLIND_NPX);
    // `agents-deck@latest` here is the bug: a different published name, fetched
    // on behalf of somebody who typed `npx ccdeck`.
    expect(run.log).toEqual(["prefetch ccdeck@latest"]);
    expect(upgradeName(BLIND_NPX)).toBe("ccdeck");
  });

  it("writes the failure note where that same worker reads it", async () => {
    const run = await runDeck(BLIND_NPX);
    // The pid is the supervisor's own, and the name is the half under test.
    expect(run.noteFile).toMatch(/^\.restart-failed-ccdeck-\d+$/);
    expect(run.note.command).toBe("npx -y ccdeck@latest");
  });

  it("knows which version failed, because it read that package's marker", async () => {
    const run = await runDeck(BLIND_NPX);
    // Null was the old answer, and null is not merely missing information: it
    // is what turns upgradeAttempt's per-target cap into "any failure counts".
    expect(run.note.target).toBe("9.9.9");
    expect(run.note.attempts).toBe(1);
  });

  it("relaunches under that package too, so the user stays on what they typed", async () => {
    const run = await runDeck(BLIND_NPX, { STUB_FETCH_OK: "1" });
    expect(run.log[0]).toBe("prefetch ccdeck@latest");
    expect(run.log[1]).toMatch(/^launch -y ccdeck@latest .*--port 47719 --no-open$/);
  });
});

describe("an npx deck whose cache metadata is readable", () => {
  it("still takes the recorded spec over the manifest, which names another alias", async () => {
    // The fallback must not become an override. npm wrote down what the user
    // typed; the manifest only says what CI happened to publish this tarball
    // as, and here the two deliberately disagree.
    const run = await runDeck(SPEAKING_NPX);
    expect(run.log).toEqual(["prefetch ccdeck@latest"]);
    expect(run.noteFile).toMatch(/^\.restart-failed-ccdeck-\d+$/);
    expect(upgradeName(SPEAKING_NPX)).toBe("ccdeck");
  });
});

describe("a deck that npx did not start", () => {
  it("names no package at all for a global install, and runs no npx", async () => {
    const run = await runDeck(GLOBAL);
    expect(run.out).toContain("REPLY upgrade-refused this deck was not started by npx");
    expect(run.log).toEqual([]);
    // Nothing keyed to a name here either: a note under `agents-deck` on a
    // `npm i -g ccdeck` machine would be a failure reported about a package
    // this install is not.
    expect(run.noteFile).toBeNull();
    // And the worker's own answer is the package on disk, which is the one an
    // upgrade would replace.
    expect(upgradeName(GLOBAL)).toBe("ccdeck");
  });

  for (const [what, root] of [
    ["a git clone", () => CHECKOUT],
    ["a linked worktree, whose .git is a file", () => WORKTREE],
  ] as const) {
    it(`names no package for ${what}, where there is nothing to install`, async () => {
      const run = await runDeck(root());
      expect(run.out).toContain("REPLY upgrade-refused this deck was not started by npx");
      expect(run.log).toEqual([]);
      expect(run.noteFile).toBeNull();
      expect(upgradeName(root())).toBe("agents-deck");
      // The name alone does not discriminate here — a checkout and a plain
      // global install of the same manifest both answer `agents-deck`, so a row
      // that stopped at the line above would pass whatever the deck decided
      // this tree was. The command is where the two answers differ.
      expect(upgradeCommand(root())).toBe("git pull && npm run build");
    });
  }
});
