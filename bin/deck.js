#!/usr/bin/env node
// The deck itself: registers hooks, starts the server, opens the browser.
// Launched by the supervisor in bin/agent-dag.js, which restarts it when it
// exits with RESTART_CODE. On a respawn (AGENTS_DECK_RESPAWN=1) everything that
// was already done once this session is skipped — that is what makes a restart
// take about a second instead of the better part of ten.
//
// This file is the order things happen in; what each step does lives in
// bin/cli/ — the one-shot commands, the terminal, the startup report, the
// second-start rule, the restart latch and the pulse line. Its top-level
// `await`s run in source order, so where a line sits here is part of what it
// means, and most of the comments below are about exactly that.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { RESTART_CODE, UPGRADE_CODE, dieWithParent, signalExitAction } from "../src/server/supervisor.mjs";
import { parseArgs, startPort, wantsCli } from "../src/server/args.mjs";
import { unregisteredDetail } from "../src/server/pulse-line.mjs";
import { PRODUCT } from "../src/server/brand.mjs";
// A leaf — fs, path and claude-dir.mjs, nothing else — so it is imported here
// with the rest rather than fetched later. Deliberately NOT the other way
// round: it takes the handshake as a parameter precisely so that it never has
// to import the server. See the note at the top of that file.
import { deckRegistryDir } from "../src/server/running-deck.mjs";
// The same kind of leaf — fs, path, crypto and deck-probe.mjs — for the same
// reason: it is taken before anything else in the boot has run.
import { takeBootLock } from "../src/server/boot-lock.mjs";
// The package this worker belongs to — see there.
import { PKG_ROOT, PKG_VERSION } from "./cli/package.js";
import { printHelp } from "./cli/help.js";
import { uninstall } from "./cli/uninstall.js";
import { offerLoginItem } from "./cli/login-item.js";
import { oneShot } from "./cli/one-shot.js";
// The terminal the boot draws in: palette, glyphs, rows, the wordmark and the spinner.
import {
  G, P, fileLink, onHangup, printBanner, showCursor, step, takeCursor, tty, write,
} from "./cli/screen.js";
// The once-per-session work and the rows that report it.
import { reportReady, reportRestarted, reportStartup, respawnHooks, startupWork } from "./cli/startup.js";
import { restartLatch } from "./cli/restart.js";
import { startPulse } from "./cli/pulse.js";
import { settleSecondStart } from "./cli/second-start.js";

const argv = process.argv.slice(2);
const flags = parseArgs(argv);

// Exit codes the supervisor reads as "bring me back": 75 from the files on
// disk, 76 through npx — which is the only way an npx run reaches a newer
// version, since its directory is never upgraded in place. Anything else it
// forwards. Both are the supervisor's own constants, so the two ends of the
// agreement cannot drift apart.
const RESPAWN = process.env.AGENTS_DECK_RESPAWN === "1";
const SUPERVISED = typeof process.send === "function";

if (flags.help) {
  printHelp();
  process.exit(0);
}

// The version, on stdout, and then nothing — no hooks, no port, no browser.
//
// This is the first thing anyone types at a CLI they do not know and the second
// thing anyone types when filing a bug, and until now it was the one question
// the deck answered by starting a server and never exiting. The banner has
// always carried the number, but only underneath a running deck, which is not
// an answer: it cannot be piped, and the process it comes with has to be killed.
//
// Bare, unprefixed, one line: `ccdeck --version` is read by scripts as often as
// by people, and `node --version` style ornamentation is what those scripts
// then have to strip. PKG_VERSION is the same read the banner uses.
if (flags.version) {
  console.log(PKG_VERSION);
  process.exit(0);
}

// `--purge` enters here too, and on its own. It is `--uninstall` plus the deck's
// own key, and a `--purge` that started a server instead would be a flag whose
// entire effect was silence.
if (flags.uninstall || flags.purge) {
  process.exit(await uninstall(flags));
}

// ── the one-shot commands ─────────────────────────────────────────────────────
//
// `--status`, `--logs`, `--stop` and the three login-item commands, answered in
// bin/cli/one-shot.js in the shape `--uninstall` already established: do the
// thing, print, exit, and never start a server. Asked HERE, above the migration
// and well above the heavy imports, because a command that ends a deck has no
// business moving that deck's files on the way past, and because asking a
// server to stop should not require starting one.
if (flags.stop || flags.status || flags.logs || flags.install || flags.installService || flags.uninstallService) {
  process.exit(await oneShot(flags));
}

// The port, and the one piece of argv the deck really does refuse to boot over.
//
// It refused before too — `--port banana` and `--port --no-open` both became
// `Number(…)` → `NaN`, which survived the whole startup (hooks installed,
// claude-swap installed, ccusage probed) and then killed the process from inside
// `listen` with Node's own wording: "options.port should be >= 0 and < 65536.
// Received type number (NaN)." That names neither the flag nor the value the
// user typed, and arrives after a page of green ticks. Same outcome, said here:
// early, in the deck's own voice, quoting the flag and the value back. Which
// value counts, and which name it goes by, is startPort's.
const asked = startPort({ flag: flags.port, env: process.env.AGENT_DAG_PORT });
if (asked.refused) {
  const { named, raw } = asked.refused;
  // `G.dash`, not an em dash: the console may be the legacy Windows one (#797).
  // `G` is bin/cli/screen.js's, answered when that module loads, so it is there
  // on this path too, long before the boot draws anything with it.
  console.error(`${PRODUCT}: ${named} ${raw}: not a port number ${G.dash} expected 0-65535.`);
  process.exit(1);
}
const port = asked.port;
// Default = machine-wide (capture every CC session on this box). Pass
// `--workspace <path>` (or `--scope`) to restrict to a single tree. Canonicalized
// just below, once the module that owns that rule is loaded.
const rawWorkspace = flags.workspace != null
  ? flags.workspace
  : (flags.scope ? process.cwd() : "");
const openBrowser = flags.noOpen !== true;
// The events log lives beside the discovery files, so it follows the Claude
// config dir rather than assuming ~/.claude — see src/server/claude-dir.mjs.
const { claudeConfigDir, hasClaudeInstalled } =
  await import(pathToFileURL(join(PKG_ROOT, "src/server/claude-dir.mjs")).href);

// ── the deck's own files, brought to their own directory ────────────────────
//
// BEFORE ANYTHING READS THEM, which is why it is here and not in the server:
// index.mjs reads the preferences at module load, so a migration inside it
// would run after the file it is meant to find had already been looked for in
// the wrong place. deck-home.mjs owns the reasoning; the shape of it is that
// nothing is deleted and a destination that exists is never touched, so this is
// safe to run on every start and does nothing at all on all but the first.
//
// A failure here is reported and then ignored. A read-only home or a missing
// permission is not a reason for the deck not to start — the old paths are
// still there, and the worst case is a deck that keeps using them.
const { deckDataDir, deckLogDir, legacyDeckDir, migrateDeckFiles, sweepTempFiles } =
  await import(pathToFileURL(join(PKG_ROOT, "src/server/deck-home.mjs")).href);
{
  const fsp = await import("node:fs/promises");
  const legacy = legacyDeckDir();
  const data = deckDataDir();
  const log = deckLogDir();
  const { moved } = await migrateDeckFiles({
    from: legacy, data, log, fs: fsp,
    onError: (name, err) => console.error(`${PRODUCT}: could not move ${name}:`, err?.message ?? err),
  });
  if (moved.length) console.error(`${PRODUCT}: moved ${moved.join(", ")} to ${data}`);
  // The litter an atomic write leaves when its process is killed between the
  // write and the rename. Nothing has ever swept it, because the code that
  // makes it is not running any more when it is made.
  //
  // THE WATCH'S OWN DIRECTORY IS NAMED SEPARATELY because the sweep does not
  // recurse: it walks the directories it is handed and nothing under them, and
  // `browser-watch/` is a subdirectory of `legacy`. Its temp files are the
  // biggest ones the deck makes — about 2.5 MB each with a full 500-episode
  // archive, by that module's own measurement — and until now they were outside
  // the reach of the sweep that exists because ninety-seven of them were found
  // in one directory, the oldest six days old.
  const { storeDir: watchStoreDir } = await import(
    pathToFileURL(join(PKG_ROOT, "src/server/browser-watch-store.mjs")).href
  );
  await sweepTempFiles({ dirs: [legacy, data, log, watchStoreDir()], fs: fsp }).catch(() => 0);
  // AND THE COPIES OF THE BROWSER'S HISTORY a Browser Watch read left in its
  // staging folder (#1753): a deck that exits mid-read never deletes its copy,
  // and the sweep above neither recurses nor matches the names. Each is a full
  // browsing history. Only folders a minute old — a sibling deck may be reading.
  const { stagingRoot, sweepStaging } = await import(
    pathToFileURL(join(PKG_ROOT, "src/server/browser-history.mjs")).href
  );
  await sweepStaging(stagingRoot()).catch(() => 0);
}
// CANONICALISED here rather than left as typed: the discovery file publishes
// this path so the hook can tell which decks share one log and elect a single
// writer for it, and two spellings of one file would read as two files.
// startServer takes the value from here, so the two always name the same file.
//
// `resolve` alone was not enough and #793 is what that cost — see
// canonicalLogPath, which owns the rule and explains it beside the election it
// serves.
const { canonicalLogPath } = await import(pathToFileURL(join(PKG_ROOT, "src/server/log-election.mjs")).href);
const persist = flags.noPersist
  ? null
  // The log follows the deck rather than Claude Code now — a hundred megabytes
  // of rotating events was never configuration, and it was living in another
  // application's configuration directory. `--history` still wins, and the
  // canonical form is still what the discovery file publishes, so decks that
  // share a path still elect one writer for it.
  : canonicalLogPath(flags.history ?? join(deckLogDir(), "events.jsonl"));

const { installHooks, keepDiscovery, removeDiscovery, hasCodexInstalled, leftoverCodexHooks, codexHomeField, codexHomesField } =
  await import(pathToFileURL(join(PKG_ROOT, "src/server/installer.mjs")).href);
// CODEX_SESSIONS_DIR comes along because the startup report names the directory
// the watcher tails, and the watcher lives in that module. Recomputing the path
// here is how the banner came to print ~/.codex/sessions on machines whose
// sessions are somewhere else entirely — see the Codex sessions row in
// bin/cli/startup.js.
const { startServer, hookToken, releaseRestart, markDeckReady, CODEX_SESSIONS_DIR, canonicalWorkspace } =
  await import(pathToFileURL(join(PKG_ROOT, "src/server/index.mjs")).href);
// What this boot set up, for the usage reports — see activation.mjs.
const { noteSetup, respawnHooksJob } = await import(pathToFileURL(join(PKG_ROOT, "src/server/activation.mjs")).href);
// And the site page the command came from, which only a new install's first
// report carries — see install-ref.mjs.
const { noteRef } = await import(pathToFileURL(join(PKG_ROOT, "src/server/install-ref.mjs")).href);
noteRef(flags.ref);

// Resolved here rather than left as typed, for the reason the events log above
// is: the discovery file publishes this path, and the hook that reads it runs in
// a process whose cwd is the agent's — so a relative `--workspace ./sub` meant
// one directory to the Codex watcher inside this process and a different one per
// agent to the hook. One canonical spelling, computed in the one process that
// knows what the user meant, is what both capture paths compare against. See
// canonicalWorkspace.
const workspace = canonicalWorkspace(rawWorkspace);

// Whether the server starts the Codex rollout watcher. Nothing is installed
// and no directory is created either way — Codex hooks are not used any more,
// so `--codex` only means "watch even though ~/.codex/ is not there yet",
// which is the right answer for a machine where Codex arrives later.
const wantCodex = !flags.noCodex && (flags.codex || await hasCodexInstalled());

// The same question for the other CLI, and the one nobody was asking. README
// offers "Claude Code CLI or OpenAI Codex CLI (or both)"; a Codex-only machine
// nonetheless got a Python account-switcher installed for a CLI it does not
// have, an accounts panel open on first run, and a banner line telling it to
// sign into that CLI (#402). Everything the deck installs or opens on the
// Claude side now hangs off this one answer, and it is stated in the banner so
// a wrong answer is visible rather than mysterious.
//
// `--claude` is the escape hatch for a false negative, which is the failure
// that matters: hasClaudeInstalled looks for the binary and for traces of use,
// and a machine that hides Claude Code from both would otherwise lose its hooks
// with no way to ask for them back. `--no-claude` is the opt-out the Claude side
// never had — the mirror of --no-codex — and it is also what a Codex-only user
// with a settings.json the installer refuses to rewrite needs, since that
// refusal is fatal at boot on a component they do not use.
const wantClaude = wantsCli({ off: flags.noClaude, on: flags.claude, installed: hasClaudeInstalled });
// The Codex tree this deck would tail, spelled the way its discovery record will
// spell it — the one field of a start's shape that is not a flag. Resolved here,
// with the other three, because the second-start question below is asked of
// nothing but inputs already settled. A --no-codex start reads no tree: null.
const codexHome = codexHomeField(wantCodex);
const codexHomes = await codexHomesField(wantCodex);

const WEB_DIST = join(PKG_ROOT, "dist", "web", "index.html");
if (!existsSync(WEB_DIST)) {
  console.error(`${PRODUCT}: ui not built. run \`npm run build\` (or \`pnpm build\`) first.`);
  process.exit(1);
}

// ── the cursor ────────────────────────────────────────────────────────────────
// Hidden from here for as long as anything of ours is moving, and put back on
// every way out — see takeCursor in bin/cli/screen.js, which draws the rest of
// the boot's terminal too.
takeCursor();

// The restart latch, armed before the server can take a request — see
// bin/cli/restart.js. `shutdown` is a declaration further down, hoisted, so it
// is a function here already (#448).
const { requestRestart, markBooted, runHeldRestart } = restartLatch({ shutdown, releaseRestart });

// The three things `shutdown` has to tear down, named before the boot that
// fills them in rather than by it. From the line below onwards this process is
// answering HTTP, and /api/restart can therefore reach `shutdown` at any moment
// after it — including moments at which none of these exist yet. `let … = null`
// is what makes that a question shutdown can ask instead of a ReferenceError it
// dies of; the boot queue in requestRestart is what makes it a question it
// almost never has to ask. See #448.
let server = null;
let discovery = null;
let discoveryFile = null;
// The boot lock, for the same reason: taken at the gate below, given back once
// this deck is registered, and given back by the exit handler on every way out
// before that. See src/server/boot-lock.mjs.
let bootLock = null;
// HERE, not at the bottom with SIGINT and SIGTERM, and this line is the whole
// of the fix for #980.
//
// This file is an ES module with top-level `await`, so its statements run in
// source order and a handler registered at the bottom does not exist until the
// boot has got there. Three ways out sit between the gate below and that point
// — the yield when another deck came up first, the ATTACH that every `ccdeck`
// typed beside a running deck takes, both of which leave through the one
// `process.exit()` after settleSecondStart, and the exit of a boot whose server
// could not bind — and the explicit release further down is on the one path
// none of them take. So the handler that was written to cover "every
// way out" covered only the ways out it was already past.
//
// What the leftover file costs is a start that has to wait the lock out: the
// next `ccdeck` finds it, and recovers through `!alive(holder.pid)` — unless
// the OS has recycled that pid onto a live process, which Windows does
// routinely. Then the only way past is BOOT_LOCK_STALE_MS measured from when
// the lock was WRITTEN, so a start a few seconds after an attach polls for the
// remainder of thirty before it can so much as ask whether a deck is up.
//
// Synchronous, because `exit` allows nothing else, and a no-op once the lock
// has been given back at the registration below.
process.on("exit", () => { bootLock?.release(); });

// This worker does not outlive the supervisor that started it (#702).
//
// Armed HERE rather than beside the signal handlers at the bottom of the file,
// for the reason the three `let`s above are where they are: this is the first
// line from which `shutdown` can be called without dying of a temporal dead
// zone, and the window that matters is the boot — the supervisor can be killed
// while the report is still printing, and a worker orphaned in there is a
// worker that binds its port a moment later and then holds it for a day.
//
// A no-op with nothing supervising us, which is `node bin/deck.js` run by hand:
// dieWithParent arms only when there is a channel, the same question SUPERVISED
// asks above. Shutdown code 0 because there is nobody left to read it — the
// point is only that discovery is unregistered and the port let go of on the
// way out, rather than left for the next boot's stale sweep.
dieWithParent(() => shutdown(0));

// ── is one of ours already up? ────────────────────────────────────────────────
// A second start, settled before anything else in the boot — see
// settleSecondStart in bin/cli/second-start.js, which carries the argument.
//
// ASKED EXACTLY HERE, and the position is the point. Everything the answer
// depends on is resolved above — the workspace, the canonical log path, which
// of the two CLIs this deck would serve — and nothing below has run yet: no
// port bound, no hooks installed, no tool probed, no banner painted, no
// discovery file written. An attach therefore leaves the machine precisely as
// it found it, which is what makes it safe to do without asking.
//
// UNDER THE BOOT LOCK, held until this deck's own record is on disk — see the
// release beside discovery.check below, and boot-lock.mjs for why a registry
// read alone could not close the window two starts at login fell through.
bootLock = await takeBootLock({ dir: deckRegistryDir() }).catch(() => null);
{
  const ended = await settleSecondStart({ flags, workspace, persist, wantCodex, wantClaude, codexHome, codexHomes, openBrowser, RESPAWN });
  // A yield or an attach: this start ends here, having said why.
  if (ended !== null) process.exit(ended);
}

// The one fact the auto-switch has to wait for and the server cannot see for
// itself: that the claude-swap it drives is not being installed or upgraded
// underneath it (#1043). startupWork is what knows, and it has not run yet — it
// runs beside the server rather than before it (#483) — so the server is handed
// a promise here and startupWork settles it below. A respawn runs no startup
// work and installs nothing, so there it settles at once. See cswapQuiet.
let settleCswap;
const cswapQuiet = new Promise(r => { settleCswap = r; });

// The listen, begun HERE and awaited below the startup report rather than after
// it. The report is a narration; the port is the product, and it was queued
// behind three tool probes for no reason but the order these two statements
// were written in (#483).
//
// What that cost: `reportStartup` awaits `ensureCswap`, which on a machine with
// no Python tooling runs a real `uv tool install` under a 180-second timeout. So
// the deck printed its rows and then refused every connection until that install
// was over — on a first run, which is the one boot a new user judges the tool by.
// #476 stopped that job blocking the event loop; the socket was shut either way,
// because the bind had not been attempted yet.
//
// Nothing in the report has to finish before the socket opens, and the window
// this opens is narrow on purpose — the discovery file and the browser are both
// still written after the report, so the only callers who can arrive inside it
// are a tab left open by an earlier deck and the user's own curl:
//
//   • the event log is replayed and the sequence counter primed INSIDE
//     startServer, before it binds — so /events and /api/events answer from a
//     full buffer from the first connection, not a growing one.
//   • the hook install can only make hooks fire; a hook that fires early finds
//     no discovery file and posts nowhere, exactly as it does today.
//   • claude-swap: cswapBin memoizes only a lookup that WORKED, so a probe
//     landing mid-install caches nothing and the next one asks again — see
//     resetCswapBin's note. The accounts panel can report the tool missing for
//     the second it is missing, and answers properly the moment it is not.
//   • ccusage: getRunner awaits the very `_installing` promise primeCcusage
//     started, so a request in this window joins that install rather than
//     racing a second one.
//
// Settled into a tagged result rather than left bare, for the reason every job
// in startupWork carries its own handler: this promise now lives across the
// whole report, and a bind that fails in there with nothing attached to it is an
// unhandledRejection — which Node answers by killing the process over a port it
// could have named.
const starting = startServer({
  port, persist, workspace, codex: wantCodex, claude: wantClaude,
  // Withheld when nothing is supervising us: without a parent, exiting is just
  // exiting, and /api/restart answers 501 so the UI hides the control.
  onRestart: SUPERVISED ? requestRestart : null,
  // NOT withheld, unlike the restart above. A restart needs a supervisor to
  // bring the replacement up on the same port; ending is something any deck can
  // do on its own, supervised or not, and `ccdeck --stop` must work on both.
  // shutdown() is a hoisted declaration precisely so it is callable from the
  // first instruction of this module — see the long note beside it (#448).
  onStop: () => shutdown(0),
  // Every auto-switch tick waits on this until claude-swap is quiet — see above.
  cswapQuiet,
}).then(s => ({ ok: true, s }), err => ({ ok: false, err }));

// Once-per-session setup — hook install, tool probes, registry lookups, and the
// banner it runs underneath. A respawn is the same session continuing, so it
// skips the lot and prints one line instead. This is the difference between a
// restart that feels instant and one that makes you wonder whether it worked.
// The hooks are the exception, when the respawn runs a different package from
// the one the session started on — see respawnHooks.
if (!RESPAWN) {
  const jobs = startupWork({ wantClaude, installHooks, leftoverCodexHooks });
  handDownSetup(noteSetup({ claude: jobs.hooks, codex: wantCodex }));
  jobs.cswapQuiet.then(settleCswap);
  await printBanner();
  await reportStartup(jobs, { workspace, wantClaude, wantCodex, CODEX_SESSIONS_DIR });
} else {
  settleCswap();
  // What a respawn says about the hooks is what it saw: its own re-install when
  // the package changed under the session, else the first boot's answer as the
  // supervisor handed it down — never an "ok" it assumed. See respawnHooksJob.
  const reinstall = respawnHooks({ wantClaude, installHooks, bootVersion: process.env.AGENTS_DECK_BOOT_VERSION });
  handDownSetup(noteSetup({
    claude: respawnHooksJob({ wantClaude, reinstall, carried: process.env.AGENTS_DECK_BOOT_HOOKS }),
    codex: wantCodex,
  }));
  await reinstall;
}

/** The hooks' answer, told to the supervisor, which hands it to the next
 *  respawn in AGENTS_DECK_BOOT_HOOKS: a respawn on the same version installs
 *  nothing, and this is how it can still say what the session's hooks are.
 *  Guarded, and given a callback, like every send down a channel the other end
 *  may have closed. */
function handDownSetup(said) {
  said.then(({ claudeHooks }) => {
    if (!claudeHooks || !process.connected) return;
    try { process.send({ type: "setup", claudeHooks }, () => {}); } catch { /* nobody supervising */ }
  }).catch(() => {});
}

// Usually settled long ago by the time we get here, which is the point: `step`
// paints nothing for a promise that has already resolved, so the spinner this
// used to show is simply gone from the boots that were slow enough to need one.
const bound = await (RESPAWN ? starting : step(`starting server${G.ellipsis}`, starting));
if (!bound.ok) {
  // stderr, not a row: a deck that could not bind is not a status line, and
  // whatever launched it reads this stream.
  console.error(`${PRODUCT}: server failed: ${bound.err.message}`);
  process.exit(1);
}
server = bound.s;
const addr = server.address();
const realPort = typeof addr === "object" && addr ? addr.port : port;
const url = `http://127.0.0.1:${realPort}`;

// The supervisor re-launches with this on --port. It has to be the port we
// actually got, not the one we asked for: those differ whenever the first
// launch found 4317 taken, and re-launching on the requested port would move
// the deck out from under every open tab.
try { process.send?.({ type: "listening", port: realPort }); } catch { /* not supervised */ }

if (RESPAWN) reportRestarted({ url, flags });
else reportReady({ url, persist, openBrowser, flags });

// The discovery file is the whole of how a hook finds this deck: hook.js
// enumerates that directory and nothing else. Writing it once at boot meant
// anything that later took it away left a deck that listened, served, and
// received not one event — with nothing on screen to say so. So it is checked
// on a timer, put back when it goes missing, and its absence is stated out loud
// rather than left to look like an idle afternoon.
//
// The token goes in with the port: it is what lets a hook tell this deck from
// whatever else may later be listening on the same number. See hookToken().
//
// The log path goes in with them, so a hook can see which decks share one events
// log and elect a single writer for it. See electWriters in hook/hook.js. The
// Codex setting goes in for the half of that election no hook is part of: the
// rollout files this deck tails itself, which a --no-codex deck must never be
// elected to record. See writesCodexLog in src/server/log-election.mjs.
let registered = null;
discovery = keepDiscovery({
  port: realPort,
  workspace,
  token: hookToken(),
  persist,
  codex: wantCodex,
  // Both read by the next `ccdeck` on this machine, not by us: `claude` is half
  // of the shape it compares before it will attach to us, and `version` is what
  // it prints when the deck it found is not the one the user just launched. See
  // src/server/running-deck.mjs.
  claude: wantClaude,
  version: PKG_VERSION,
  // The supervisor above us, for `ccdeck --stop`'s fallback ladder: a worker
  // killed under a live supervisor is a worker the supervisor puts back, so the
  // parent has to go first and cannot be found without being told. Null when
  // nothing is supervising, which is the same question `onRestart` asks.
  parent: SUPERVISED ? process.ppid : null,
  onState: (state) => {
    const first = registered === null;
    registered = state.ok;
    if (!state.ok) reportUnregistered(state);
    else if (!first) reportReregistered(state);
  },
});
discoveryFile = discovery.file;
// Now, not in five seconds: nothing should reach the pulse line below without
// the deck knowing whether the hooks can see it.
await discovery.check();
// Registered, so the next start can find this deck for itself and the boot
// lock has done its job. Given back here rather than at exit, or a second
// `ccdeck` would wait out this deck's whole life before attaching to it.
bootLock?.release();

// Never on a respawn: the tab that asked for the restart is still open and
// reconnecting on its own. A second one would be the deck talking over itself.
if (openBrowser && !RESPAWN) {
  // Not awaited, and not a dependency any more. `open@10` was this package's
  // only runtime dependency and brought nine more with it, all of them fetched
  // on a cold `npx ccdeck` before the deck's own tarball is unpacked — and the
  // await under it held the boot behind a launcher that has nothing to report.
  // See src/server/open-url.mjs.
  try {
    const { openUrl } = await import(pathToFileURL(join(PKG_ROOT, "src/server/open-url.mjs")).href);
    openUrl(url);
  } catch {}
}

// ── starting at login ─────────────────────────────────────────────────────────
//
// After the boot rather than during it, and deliberately: a deck that could not
// come up has no business teaching the machine to start it at every login. By
// here the port is bound, the hooks are registered and the browser is open.
// Never on a respawn, which is the same session continuing. See offerLoginItem.
if (!RESPAWN) await offerLoginItem({ deckDataDir, deckLogDir });

// ── Pulse indicator ───────────────────────────────────────────────────────────
// The last line on screen, still only while something is outstanding, and the
// guard that keeps every other writer off it — see startPulse in
// bin/cli/pulse.js. It asks for `registered` on each beat.
startPulse({ registered: () => registered, wantClaude });

// Boot is over. Everything `shutdown` tears down exists, so a restart can be
// run rather than held — and the server is told, so /api/restart stops
// describing a deck that is still assembling itself. This line is exactly where
// the window opened at the top of this file closes; see requestRestart.
markBooted();
markDeckReady();
// And said out loud, one link up. A launcher that put this deck in the
// background has been tailing its log into the user's terminal since the spawn
// and is waiting for exactly this to stop and hand the prompt back — NOT for
// `listening`, which is sent before the server-ready row, the log row and the
// browser line are written, and would cut the last three lines off every boot.
// Inert when nothing is supervising us.
try { process.send?.({ type: "booted" }); } catch { /* no channel; nothing waiting */ }
runHeldRestart();

/**
 * A declaration, not the `const` arrow this was for eight months.
 *
 * The difference is the whole of #448: a const is in its temporal dead zone
 * until the line declaring it runs, and every line above — the startup report,
 * the port report, the discovery file, the browser spawn — executes with the
 * server already accepting connections. A restart arriving in that window
 * called this and got `ReferenceError: Cannot access 'shutdown' before
 * initialization`, and the latch it had already set is what made that
 * permanent. A declaration is hoisted, so from the first instruction of this
 * module there is a function here to call.
 *
 * Hoisting alone would only have moved the fault one line down, onto `server`,
 * `discovery` and `discoveryFile` — which is why those are `let … = null` above
 * and asked about rather than assumed here. Between them, this is callable at
 * any instant of this process's life and cannot end in a throw for the caller
 * to lose.
 */
async function shutdown(code = 0) {
  // Also set as exitCode, not only passed to exit(): if the event loop empties
  // on its own before either timer runs, Node would otherwise exit 0 and the
  // supervisor would take that as "done" instead of "bring me back".
  process.exitCode = code;
  // Nothing inside a shutdown is worth staying alive for, and this one is
  // called from three places that cannot handle a rejection — a signal handler,
  // an IPC message handler, and a restart. An unhandled one there ends the
  // process on Node's terms rather than ours, which is to say with the wrong
  // exit code and therefore, half the time, without the supervisor bringing the
  // deck back.
  try {
    // Before anything that can take time: a Ctrl+C the user has to watch for a
    // second and a half is a second and a half without a cursor.
    showCursor();
    // Nothing for a terminal that hung up (onHangup, below): it is not there.
    const hungUp = code === hangupCode();
    if (tty && code !== RESTART_CODE && code !== UPGRADE_CODE && !hungUp) {
      write(`\n\n  ${P.warn}${G.stop}  shutting down${G.ellipsis}${P.reset}\n`);
    }
    // WHAT THIS DECK STARTED, ENDED WITH IT. Every deadline in exec.mjs lives
    // in a timer in THIS process — `run` states the outcome and only then kills
    // — so an exit that reaps nothing leaves the hung tool a deadline exists
    // for with nothing left anywhere that will ever stop it. Measured on a
    // sandboxed deck (#1012): SIGINT at 05:26:22.706, deck gone within 200ms,
    // and its `claude --print /usage` child — spawned at 05:26:18.078 under a
    // 15-second deadline — still running at 05:26:35.204, reparented to init.
    // A whole Claude Code process, orphaned by a Ctrl+C.
    //
    // FIRST, so it is ahead of both exits below, and cheap enough to be: a
    // POSIX signal lands synchronously, and on Windows killTree's taskkill is
    // already a running process by the time spawn() returns and outlives this
    // one. No corpse is waited for, and the only await is a module already in
    // the cache — anything that spawned a child loaded exec.mjs to do it — so
    // the ~200ms exit that is the rest of shutdown's good behaviour stays that.
    try {
      const { killLiveChildren } = await import(pathToFileURL(join(PKG_ROOT, "src/server/exec.mjs")).href);
      killLiveChildren();
    } catch { /* exec.mjs never loaded, so nothing was ever spawned */ }
    // Stopped first, always: a tick landing after the unlink would re-register a
    // deck that is on its way out, and leave the file behind for the hooks to
    // find once nothing is listening.
    //
    // AWAITED, because clearing the interval only stops the NEXT tick. A tick
    // that started a moment ago is inside the atomic write, and it re-creates
    // the file after the unlink — the same stale registration, reached by the
    // one route "stop first" does not cover. stop() answers with that check, so
    // this waits for it and then removes what it wrote. Bounded: one check,
    // which never rejects.
    //
    // Guarded on its own, because a discovery file this process cannot remove is
    // a nuisance the next boot's stale sweep clears up — worth carrying on to
    // the orderly close below rather than skipping to the abrupt one.
    try {
      await discovery?.stop();
      if (discoveryFile) await removeDiscovery(discoveryFile);
    } catch { /* the sweep at the next boot gets it */ }
    // THE LINES WE ALREADY SAID WE HAD. /api/event answers {ok:true, seq}
    // before the append lands — right for the hook, which holds a 1.9s cap and
    // must not wait on a filesystem — so an exit that waits only for the
    // listener abandons whatever is still queued. Measured: 40 posts
    // acknowledged, 12 written. The restart path is the one that costs most,
    // since the replacement deck rebuilds its canvas from the log before it
    // binds. Bounded inside drainAppends, so a wedged filesystem cannot hold
    // the exit; a deadline reached is the old behaviour.
    try {
      const { drainAppends } = await import(pathToFileURL(join(PKG_ROOT, "src/server/log-writer.mjs")).href);
      await drainAppends();
    } catch { /* nothing queued, or the module never loaded */ }
    // No server yet means nothing to drain and nothing to hand the port over to,
    // so the exit is the whole of the shutdown.
    if (!server) return process.exit(code);
    server.close(() => process.exit(code));
    // SSE connections never end by themselves, so close() alone would sit out the
    // full 1500ms fallback on every restart. Hanging them up is safe — the stream
    // sets retry: 1500 and replays from Last-Event-ID, so each tab reconnects and
    // catches up without being told anything.
    try { server.closeAllConnections?.(); } catch { /* Node < 18.2 */ }
    setTimeout(() => process.exit(code), 1500).unref();
  } catch {
    process.exit(code);
  }
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
// A terminal closed under a `--foreground` deck, or a console window closed on
// Windows, which Node reports as SIGHUP. Dying of it on the spot dropped every
// append already acknowledged, left the discovery record for the hooks and
// gave the LAN no goodbye, so it takes the way out the other two take. With
// the hangup's own exit code, so the supervisor reads what it read before; and
// with nothing written to the terminal that is gone — a write there fails, and
// an unhandled 'error' on stdout would end the shutdown halfway.
onHangup(() => {
  for (const out of [process.stdout, process.stderr]) out.on("error", () => {});
  shutdown(hangupCode());
});
process.on("beforeExit", () => { discovery?.stop(); if (discoveryFile) removeDiscovery(discoveryFile); });
// The boot lock's `exit` handler is NOT here with its siblings. It is armed up
// beside `let bootLock = null;`, above the start gate, because the three ways
// out this file takes before reaching this line are the ones it exists for —
// see the note there (#980).

// ── helpers ───────────────────────────────────────────────────────────────────

/** The code a death by SIGHUP is reported as, 129: what a hangup that runs
 *  shutdown instead of dying of it exits with. A function, like shutdown, so
 *  it is there at any instant of the boot. */
function hangupCode() {
  return signalExitAction("SIGHUP").code;
}

// The deck is up and the discovery file could not be written. Said in full —
// the path, the reason — because the alternative is what this replaced: an
// ordinary-looking deck that simply never shows a session.
//
// What that costs depends on which CLI this deck watches, so the sentence comes
// from pulse-line.mjs, where both answers are written down and tested.
function reportUnregistered({ file, error }) {
  const why = error?.message ? ` ${G.dash} ${error.message}` : "";
  write(
    `\n  ${P.warn}${G.warn}${P.reset}  ${P.bold}not registered${P.reset}${P.muted}${why}${P.reset}\n` +
    `     ${P.muted}${unregisteredDetail({ file, claude: wantClaude, dash: G.dash })}${P.reset}\n`,
  );
}

function reportReregistered({ file }) {
  write(`\n  ${P.ok}${G.ok}${P.reset}  ${P.muted}registered again ${G.arrow} ${fileLink(file)}${P.reset}\n`);
}
