// A boot that is ready in seconds, with a startup job that never finishes (#742).
//
// The report. Two people, on Windows and on macOS, reported the same thing:
// `npx ccdeck`, the wordmark, four rows, and then a spinner at "checking
// claude-swap…" and nothing more. No "server ready", no URL, no browser. What
// they were watching was `reportStartup` awaiting `ensureCswap`, which on a
// machine with neither claude-swap nor a Python toolchain downloads a uv binary
// under a 120-second deadline and then builds an environment with it under a
// 180-second one. The port had been open the whole time — #483 moved the listen
// in front of the report — but nothing on screen said so and no tab had been
// opened, so the only thing the user could act on was Ctrl+C.
//
// The fix is not to make the install fast. It is to stop the boot waiting for
// it: the jobs that are not fatal share one deadline, and a job still working
// when it runs out is said out loud and left running. This file is what makes
// that a fact rather than an intention, and it asserts the ceiling in wall-clock
// seconds because that is the only unit the complaint was ever in.
//
// The technique is boot-listen-before-report.test.ts's, which is
// restart-boot-window's: an install layout in a temp directory holding the real
// bin/ and a src/server/ of one-line `export *` shims onto the repo, so what
// runs is what ships. Four modules are shadowed, and only one of them is the
// subject:
//
//   cswap-install  the job that never settles — held by a file this test
//                  creates, so the hang is arithmetic rather than luck
//   open-url       records that it was called, and when, instead of opening a
//                  browser on the machine running the suite
//   self-update    so no registry is contacted
//   installer      so nothing is registered for a hook to find
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { rmTempDir } from "./rm-temp-dir";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-boot-budget-"));
const PKG = join(DIR, "pkg");
const SERVER_DIR = join(PKG, "src", "server");
const REAL_BIN = fileURLToPath(new URL("../../../bin/", import.meta.url));
const REAL_SERVER = fileURLToPath(new URL("../../server/", import.meta.url));
/** Creating this is what lets the startup job finish. Until it exists the deck
 *  is inside a job with no end, which is the whole point. One per deck: the two
 *  boots below run in the same temp tree, and a release written by the first
 *  would let the second's job settle before it had started. */
const releasePath = (which: string) => join(DIR, `release-cswap-${which}`);
/** Written by the stubbed opener, with the URL it was given. One per deck, so
 *  the two boots below cannot read each other's answer. */
const openedPath = (which: string) => join(DIR, `opened-${which}.txt`);

for (const p of [PKG, SERVER_DIR]) {
  if (!resolve(p).startsWith(resolve(DIR))) throw new Error(`refusing to run: ${p} is outside ${DIR}`);
}

// @ts-expect-error — plain .mjs modules, no types
const { killTree } = await import("../../server/exec.mjs");
// @ts-expect-error — ditto
const { BOOT_DEADLINE_MS } = await import("../../server/boot-deadline.mjs");

/**
 * What a first run may cost before the deck says where to point a browser.
 *
 * Twenty seconds, and it is a ceiling rather than a target: the deadline itself
 * is eight, and everything else in the boot — a node start, the module graph,
 * the wordmark's reveal, binding the port — is about two on this machine and
 * about four on the slowest runner in the matrix. The gap is deliberate. A
 * ceiling that sat just above the measurement would fail on a loaded runner and
 * teach everyone to re-run it, and a flaky ceiling bounds nothing.
 *
 * What it is really guarding is the shape of the boot, not its speed: with a
 * job that NEVER finishes, this number can only be met by a report that stopped
 * waiting. Any future job awaited without a deadline fails here, whatever it
 * is, which is the property #742 was missing.
 */
const READY_CEILING_MS = 20_000;

/**
 * One of the two rows, whole, whichever glyph set the terminal got.
 *
 * The separator is `G.dash`, and term.mjs spells that "—" where the terminal
 * can draw it and "-" where it cannot — which on the Windows runner is always,
 * because CP437 has no em dash. Asserting the em dash was this file passing on
 * two platforms and failing on the third over a hyphen (#742).
 *
 * Still the WHOLE sentence rather than the two halves, because that is what
 * catches the thing worth catching: the row has to survive an 80-column
 * terminal, and a detail that no longer fits comes back with its tail replaced
 * by an ellipsis.
 */
const ROW = (what: string) => new RegExp(`${what} [-\u2014] the deck is ready`);

mkdirSync(join(PKG, "bin"), { recursive: true });
mkdirSync(SERVER_DIR, { recursive: true });
mkdirSync(join(PKG, "dist", "web"), { recursive: true });

// bin/deck.js refuses to boot without a built UI, and nothing here serves a
// page. The file only has to exist.
writeFileSync(join(PKG, "dist", "web", "index.html"), "<!doctype html>\n");
writeFileSync(join(PKG, "package.json"), JSON.stringify({
  name: "agents-deck", version: "3.0.0", type: "module",
}));
copyFileSync(join(REAL_BIN, "agent-dag.js"), join(PKG, "bin", "agent-dag.js"));
copyFileSync(join(REAL_BIN, "deck.js"), join(PKG, "bin", "deck.js"));

const real = (mod: string) => JSON.stringify(new URL(`../../server/${mod}`, import.meta.url).href);
for (const mod of readdirSync(REAL_SERVER).filter(f => f.endsWith(".mjs"))) {
  writeFileSync(join(SERVER_DIR, mod), `export * from ${real(mod)};\n`);
}

// The job with no end. A local export shadows the same name arriving through
// `export *`, so every other function in the module is still the real one.
//
// STUB_CSWAP_SAYS picks which of the two slow boots this is. "nothing" is the
// job that goes quiet — the shape of a probe that hangs, and the only thing a
// deadline can catch. "installing" is the real first run: it commits to an
// install, says so through the callback ensureCswap now takes, and then takes
// its three minutes. The deadline is not what saves that one, and the point of
// having both is that neither mechanism can be removed without a case going red.
writeFileSync(join(SERVER_DIR, "cswap-install.mjs"), [
  `export * from ${real("cswap-install.mjs")};`,
  `import { existsSync } from "node:fs";`,
  `const RELEASE = process.env.STUB_CSWAP_RELEASE;`,
  `export function ensureCswap({ onInstalling } = {}) {`,
  `  if (process.env.STUB_CSWAP_SAYS === "installing") onInstalling?.();`,
  `  return new Promise(done => {`,
  `    const tick = () => {`,
  `      if (existsSync(RELEASE)) done({ state: "present", version: "9.9.9" });`,
  `      else setTimeout(tick, 20);`,
  `    };`,
  `    tick();`,
  `  });`,
  `}`,
].join("\n"));

// Records the call instead of making it. Opening a real browser on whatever is
// running this suite is not something a test gets to do, and the question here
// is only whether the call site is reached and when — the launchers themselves
// are open-url.test.ts's subject.
writeFileSync(join(SERVER_DIR, "open-url.mjs"), [
  `export * from ${real("open-url.mjs")};`,
  `import { writeFileSync } from "node:fs";`,
  `export function openUrl(url) {`,
  `  writeFileSync(process.env.STUB_OPENED, String(url));`,
  `}`,
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

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function until<T>(ok: () => T | false | undefined, ms: number, what: string): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const got = ok();
    if (got) return got;
    if (Date.now() >= deadline) throw new Error(`timed out after ${ms}ms waiting for ${what}`);
    await sleep(20);
  }
}

/** The band this file draws its port from, and deliberately not the OS's — see
 *  the long note in boot-listen-before-report.test.ts. Below every ephemeral
 *  range on all three platforms, so only a process asking for this exact number
 *  can take it, and nowhere near the 4317-4400 a developer's own decks are on. */
const PORT_LO = 20_000;
const PORT_HI = 29_999;

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

type Boot = {
  child: ChildProcess;
  out: { text: string };
  /** Milliseconds from spawn to the "server ready" row. The measurement this
   *  whole file exists for. */
  readyMs: number;
  /** And to the browser, which is the half a user actually looks at. */
  openedMs: number;
  opened: string;
};

/**
 * Start a deck against a claude-swap job that will not finish, and time it.
 *
 * `says` is the stub's mode — see STUB_CSWAP_SAYS above. Nothing here overrides
 * AGENTS_DECK_BOOT_DEADLINE_MS: the ceiling is a claim about what a user gets,
 * so it is measured against the deadline a user gets.
 */
async function bootDeck(says: "nothing" | "installing", ceilingMs: number): Promise<Boot> {
  const port = await freePort();
  const opened = openedPath(says);
  const started = Date.now();
  const child = spawn(process.execPath, [
    join(PKG, "bin", "deck.js"),
    "--port", String(port),
    // NOT --no-open. Whether the browser is reached, and when, is half of what
    // was broken: a deck that printed "server ready" and then opened nothing
    // for two more minutes is the same complaint.
    // --claude, not the machine's answer: every job the report waits on is a
    // Claude Code job, and a runner without Claude Code installed would skip
    // the lot and leave nothing to be slow.
    "--claude", "--no-codex",
    "--history", join(DIR, `events-${says}.jsonl`),
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: DIR, USERPROFILE: DIR,
      CLAUDE_CONFIG_DIR: join(DIR, "claude"),
      CODEX_HOME: join(DIR, "codex"),
      AGENTS_DECK_NO_INSTALL: "1",
      STUB_CSWAP_RELEASE: releasePath(says),
      STUB_CSWAP_SAYS: says,
      STUB_OPENED: opened,
      NO_COLOR: "1",
    },
  });
  const out = { text: "" };
  child.stdout!.on("data", d => { out.text += String(d); });
  child.stderr!.on("data", d => { out.text += String(d); });

  await until(() => out.text.includes("server ready"), ceilingMs + 10_000, `the server-ready row (${says})`);
  const readyMs = Date.now() - started;
  await until(() => existsSync(opened), 10_000, `the browser to be opened (${says})`);
  return { child, out, readyMs, openedMs: Date.now() - started, opened };
}

describe("a boot whose claude-swap job goes quiet", () => {
  let boot: Boot;

  beforeAll(async () => {
    boot = await bootDeck("nothing", READY_CEILING_MS);
    // Let go, so the late-row case has something to read.
    writeFileSync(releasePath("nothing"), "go\n");
    await until(() => boot.out.text.includes("v9.9.9"), 15_000, "the claude-swap row to arrive late");
  }, 90_000);

  afterAll(() => { if (boot?.child) killTree(boot.child, "SIGKILL"); });

  it("says where to point a browser well inside the ceiling", () => {
    expect(boot.readyMs, `the deck took ${boot.readyMs}ms to be ready with a startup job still running; `
      + `the ceiling is ${READY_CEILING_MS}ms and the boot deadline is ${BOOT_DEADLINE_MS}ms`)
      .toBeLessThan(READY_CEILING_MS);
  });

  it("opens the browser inside it too, not two minutes later", () => {
    expect(boot.openedMs).toBeLessThan(READY_CEILING_MS);
    // The URL it was handed, not merely that it was called: a browser opened on
    // the wrong port is a blank tab, which is what the user sees either way.
    expect(readFileSync(boot.opened, "utf8")).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("waits for the job at least as long as the deadline allows", () => {
    // The other direction, and it matters as much: a deadline that fires
    // instantly would put every honest boot on the background path and move the
    // rows out from where a reader looks for them. This job can never settle
    // and never says why, so the report must have spent the whole deadline on
    // it — there was nothing else to go on.
    expect(boot.readyMs).toBeGreaterThanOrEqual(BOOT_DEADLINE_MS);
  });

  it("says the job is still going rather than leaving a blank where a row was", () => {
    const said = boot.out.text.slice(0, boot.out.text.indexOf("server ready"));
    expect(said).toContain("claude-swap");
    expect(said).toContain("still setting up");
    // And says the deck does not depend on it, because "still setting up" on
    // its own is what a spinner already said for two minutes. Asserted whole,
    // which is also how the row is kept inside an 80-column terminal: a detail
    // that no longer fits comes back ellipsised and this fails.
    expect(said).toMatch(ROW("still setting up"));
  });

  it("prints the real row when the job finally answers, after the deck is up", () => {
    const ready = boot.out.text.indexOf("server ready");
    const late = boot.out.text.indexOf("v9.9.9");
    expect(ready).toBeGreaterThan(-1);
    expect(late).toBeGreaterThan(ready);
    // On its own line. By now the pulse indicator owns the last line and
    // repaints it with \r, so a row written without a newline first is drawn
    // over on the next beat and the user never learns how the install went.
    expect(boot.out.text.slice(late - 60, late)).toContain("\n");
  });

  it("still reports the rows that did answer, in their own order", () => {
    const at = (s: string) => boot.out.text.indexOf(s);
    expect(at("workspace")).toBeGreaterThan(-1);
    expect(at("claude-swap")).toBeGreaterThan(at("workspace"));
    // The deadline changes which row claude-swap gets, never where it sits.
    expect(at("server ready")).toBeGreaterThan(at("claude-swap"));
  });
});

/**
 * The real first run, and the reason the deadline is not the whole fix.
 *
 * A deadline can only ever be paid in full, and eight seconds of a spinner on
 * the first boot of a tool is still eight seconds nobody asked for. What ends
 * that wait is news rather than time: ensureCswap now says the moment it
 * commits to an install, and the report stops waiting there — about a second
 * in, which is what the probes before it actually cost.
 */
describe("a boot whose claude-swap job says it is installing", () => {
  let boot: Boot;

  beforeAll(async () => {
    boot = await bootDeck("installing", READY_CEILING_MS);
  }, 90_000);

  afterAll(() => { if (boot?.child) killTree(boot.child, "SIGKILL"); });

  it("does not wait out the deadline for news it already has", () => {
    expect(boot.readyMs, `the deck took ${boot.readyMs}ms with an install it had already been told about; `
      + `waiting the deadline (${BOOT_DEADLINE_MS}ms) out is the thing this case exists to catch`)
      .toBeLessThan(BOOT_DEADLINE_MS);
  });

  it("opens the browser then too, rather than at the deadline", () => {
    expect(boot.openedMs).toBeLessThan(BOOT_DEADLINE_MS);
  });

  it("says installing, which is a different sentence from still setting up", () => {
    // The distinction is the user's, not the code's: one of these is a wait
    // with an end the deck can describe, and the other is a machine that has
    // gone quiet. Reporting both the same way would throw that away.
    const said = boot.out.text.slice(0, boot.out.text.indexOf("server ready"));
    expect(said).toMatch(ROW("installing in the background"));
    expect(said).not.toContain("still setting up");
  });
});
