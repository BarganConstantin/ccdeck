#!/usr/bin/env node
// The deck itself: registers hooks, starts the server, opens the browser.
// Launched by the supervisor in bin/agent-dag.js, which restarts it when it
// exits with RESTART_CODE. On a respawn (AGENTS_DECK_RESPAWN=1) everything that
// was already done once this session is skipped — that is what makes a restart
// take about a second instead of the better part of ten.
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { dieOfSignal, dieWithParent } from "../src/server/supervisor.mjs";
import { isPortValue, parseArgs } from "../src/server/args.mjs";
import {
  CURSOR_HIDE, CURSOR_SHOW, colorProfile, fit, glyphs, labelColumn, link, motionOK, oneLine,
  palette, pulseDot, pulseText, spinnerFrames, statusLine, supportsHyperlinks, termColumns,
  elapsedSuffix, sinceLabel, unicodeOK, unregisteredDetail, visibleWidth, wordmark,
} from "../src/server/term.mjs";
import { PRODUCT } from "../src/server/brand.mjs";
import { invokedName, renameNotice } from "../src/server/invoked-as.mjs";
import { budget, bootDeadlineMs } from "../src/server/boot-deadline.mjs";
// A leaf — fs, path and claude-dir.mjs, nothing else — so it is imported here
// with the rest rather than fetched later. Deliberately NOT the other way
// round: it takes the handshake as a parameter precisely so that it never has
// to import the server. See the note at the top of that file.
import { asksForOwnDeck, runningDeck, versionNote } from "../src/server/running-deck.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..");
const PKG_VERSION = (() => {
  try { return JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")).version ?? "0.0.0"; }
  catch { return "0.0.0"; }
})();

// The command the user typed, handed down by the supervisor — our own argv[1]
// is this file under every one of the three names. Null when it cannot be
// proven, and null is the answer that prints nothing.
const INVOKED_AS = invokedName({ pkgRoot: PKG_ROOT });

const argv = process.argv.slice(2);
const flags = parseArgs(argv);

// Exit codes the supervisor reads as "bring me back": 75 from the files on
// disk, 76 through npx — which is the only way an npx run reaches a newer
// version, since its directory is never upgraded in place. Anything else it
// forwards.
const RESTART_CODE = 75;
const UPGRADE_CODE = 76;
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

if (flags.uninstall) {
  const { uninstallHooks, hasCodexInstalled } = await import(pathToFileURL(join(PKG_ROOT, "src/server/installer.mjs")).href);
  // Anything that could not be taken out. An uninstall that removed nothing
  // because it could not read the file has not uninstalled anything, and both
  // the wording and the exit code have to say so: a user who is told it worked
  // and still has our hooks firing on every event is worse off than one who is
  // told it failed, because they have stopped looking.
  let refused = false;
  // Files already reported as unparseable. The Claude hooks and the sound hook
  // live in the SAME settings.json, so a stray comma refuses both, and printing
  // the whole path-plus-parser-error twice buries the one line that differs —
  // which of our two installations is still in there.
  const named = new Set();
  // Its own glyphs for the same reason the bad-port line has them: this block
  // runs at module top level, well before `G` is declared (#797).
  const { dash: gDash } = glyphs(unicodeOK());
  /** Report one provider's outcome. `ok` first — see uninstallHooks. */
  const report = (res, label) => {
    if (res.ok === false) {
      refused = true;
      named.add(res.settingsPath);
      console.error(`${PRODUCT}: ${label} hooks NOT removed ${gDash} ${res.settingsPath} could not be read as JSON (${res.why}).`);
      console.error(`${PRODUCT}: the __agent-dag hook entries are still in that file and keep firing on every ${label} event.`);
      return;
    }
    console.log(res.changed
      ? `${PRODUCT}: hooks removed from ${res.settingsPath}`
      : `${PRODUCT}: no ${label} hooks to remove`);
  };
  report(await uninstallHooks({ provider: "claude" }), "Claude");
  // The old finish sound was a second entry in the same file, marked
  // __agent-dag-sound rather than __agent-dag, and uninstallHooks does not know
  // that mark — so it used to be left behind, playing on every turn after the
  // deck was supposedly gone. #704 retired the mechanism outright, but the entry
  // is still on every machine that had it, so removing it is still this
  // command's job. So is the other half: turning the sound on parked the user's
  // own afplay/PowerShell Stop hooks, and once the deck is uninstalled nothing
  // else on the machine knows where they went.
  // The login item goes too, and this is the one place the uninstall's
  // documented narrowness has to bend. "Hook entries only" is right for the
  // event log and the port registry, which are data somebody may still want —
  // but a login item left behind after an uninstall is not data, it is a
  // machine that keeps starting a deck whose hooks were just removed.
  {
    const svc = await import(pathToFileURL(join(PKG_ROOT, "src/server/login-service.mjs")).href);
    const { deckDataDir: dataDir } = await import(pathToFileURL(join(PKG_ROOT, "src/server/deck-home.mjs")).href);
    if (svc.readServiceRecord(dataDir()) !== null) {
      const gone = svc.uninstallService();
      svc.writeServiceRecord(dataDir(), { removed: new Date().toISOString(), version: PKG_VERSION });
      console.log(gone.ok
        ? `${PRODUCT}: no longer starts at login`
        : `${PRODUCT}: could NOT remove the login item — ${gone.reason} (${gone.path})`);
      if (!gone.ok) refused = true;
    }
  }

  const { retireSoundHook } = await import(pathToFileURL(join(PKG_ROOT, "src/server/retire-sound-hook.mjs")).href);
  const sound = await retireSoundHook();
  if (sound.removed) console.log(`${PRODUCT}: sound hook removed`);
  if (sound.restored) console.log(`${PRODUCT}: restored ${sound.restored} of your own sound hook(s)`);
  if (sound.ok === false) {
    refused = true;
    // Two different refusals, and saying the wrong one sends the user to the
    // wrong file. `settings_unreadable` means nothing was touched at all — and
    // when the forwarders already named that same file, the whole path and
    // parser error would only bury the one line that differs. `parked_unreadable`
    // is the other file: our entry IS out (the lines above said so), and what is
    // still owed is the user's own hooks, which stay parked until they repair it.
    if (sound.reason === "settings_unreadable") {
      console.error(named.has(sound.settingsPath)
        ? `${PRODUCT}: the sound hook is still in that file too.`
        : `${PRODUCT}: sound hook left in place — ${sound.message}`);
      named.add(sound.settingsPath);
    } else {
      console.error(`${PRODUCT}: your own sound hooks were NOT restored ${gDash} ${sound.message}`);
    }
  }
  if (hasCodexInstalled()) {
    report(await uninstallHooks({ provider: "codex" }), "Codex");
  }
  // The remedy last and once, after every symptom above it, rather than once
  // per refusal in the middle of the list.
  if (named.size > 0) {
    console.error(`${PRODUCT}: repair the JSON (or move the file aside), then run \`${PRODUCT} --uninstall\` again.`);
  }
  // Non-zero when any half of it refused, so `ccdeck --uninstall && …` and every
  // CI step that runs this stops on the failure instead of continuing past it.
  process.exit(refused ? 1 : 0);
}

// ── the two questions that are about another deck, not this one ──────────────
//
// One-shot commands in the shape `--uninstall` already established: do the
// thing, print, exit, and never start a server. They sit ABOVE the migration
// and well above the heavy imports, because a command that ends a deck has no
// business moving that deck's files on the way past, and because asking a
// server to stop should not require starting one.
//
// Their own glyphs and palette rather than `G`/`P`, for the reason the bad-port
// block below gives (#797): those are declared two hundred lines further down
// and this runs at module top level.
//
// WHICH DECK. The shape a bare `ccdeck` would have built — same `sameShape` the
// attach uses, so `ccdeck` and `ccdeck --stop` name the same deck and there is
// one model to hold. `--port <n>` names one directly; `--all` takes every deck
// on the machine. (`--all` is the legacy capture flag, a no-op since it became
// the default; beside `--stop` it can only mean this, and it is the word a
// person reaches for.)
if (flags.stop || flags.status || flags.logs || flags.installService || flags.uninstallService) {
  const { dash, ok: gOk, warn: gWarn, bullet, arrow } = glyphs(unicodeOK());
  const tone = palette(colorProfile({ isTTY: Boolean(process.stdout.isTTY) }));
  const say = (line) => process.stdout.write(`${line}\n`);

  const { deckDataDir, deckLogDir } = await import(pathToFileURL(join(PKG_ROOT, "src/server/deck-home.mjs")).href);

  // ── --install-service / --uninstall-service ───────────────────────────────
  // Answered before the registry is read: neither one is about a deck that is
  // running, and both are as meaningful on a machine with no deck up as on one
  // with three.
  if (flags.installService || flags.uninstallService) {
    const svc = await import(pathToFileURL(join(PKG_ROOT, "src/server/login-service.mjs")).href);
    const { isNpxInstall } = await import(pathToFileURL(join(PKG_ROOT, "src/server/self-update.mjs")).href);
    if (flags.uninstallService) {
      const out = svc.uninstallService();
      // Recorded either way. The record is what stops the next ordinary start
      // putting back what was just taken away, and a tool that argues with its
      // user about a login item is a tool that gets uninstalled entirely.
      svc.writeServiceRecord(deckDataDir(), { removed: new Date().toISOString(), version: PKG_VERSION });
      say(out.ok
        ? `\n  ${tone.ok}${gOk}${tone.reset}  no longer starts at login${tone.muted}  ${bullet}  ${out.path}${tone.reset}\n`
        : `\n  ${tone.err}${gWarn}  could not remove it ${dash} ${out.reason}${tone.reset}\n`);
      process.exit(out.ok ? 0 : 1);
    }
    if (isGitCheckout(PKG_ROOT)) {
      // Not refused outright — somebody running from a checkout may genuinely
      // want this — but not done silently either: the item would name a working
      // tree, and that is worth knowing before it is written.
      say(`\n  ${tone.warn}${gWarn}  this is a checkout, so the login item would name ${PKG_ROOT}${tone.reset}`);
      say(`     ${tone.muted}a renamed, moved or deleted working tree leaves a login item pointing at nothing${tone.reset}\n`);
    }
    if (isNpxInstall(PKG_ROOT)) {
      // The item would name a path inside ~/.npm/_npx/<hash>/, which npm deletes
      // whenever it feels like it — a login item pointing at nothing, forever,
      // on a machine where nothing was ever installed.
      say(`\n  ${tone.warn}${gWarn}  an npx run cannot start at login ${dash} its files live in npm's cache and are deleted without warning.${tone.reset}`);
      say(`     ${tone.muted}install it first: \`npm i -g ${INVOKED_AS ?? PRODUCT}\`${tone.reset}\n`);
      process.exit(1);
    }
    const out = svc.installService({
      script: join(PKG_ROOT, "bin", "agent-dag.js"),
      logPath: join(deckLogDir(), "deck.log"),
      product: PRODUCT,
    });
    if (!out.ok) {
      say(`\n  ${tone.err}${gWarn}  could not set it up ${dash} ${out.reason}${tone.reset}\n`);
      process.exit(1);
    }
    svc.writeServiceRecord(deckDataDir(), { installed: PKG_VERSION, at: new Date().toISOString(), path: out.path });
    say(`\n  ${tone.ok}${gOk}${tone.reset}  starts when you log in${tone.muted}  ${bullet}  ${out.path}${tone.reset}`);
    if (out.how === "file-only") {
      // The file is on disk and both launchd and systemd read their directories
      // at the next login, so this works from then on. Said rather than hidden:
      // "it will work tomorrow" is a different promise from "it works now".
      say(`  ${tone.warn}${gWarn}  not started now ${dash} ${out.reason}. It will come up at your next login.${tone.reset}`);
    }
    // The one place the three platforms genuinely differ in what this buys you.
    if (svc.lingerState() === "off") {
      say(`  ${tone.warn}${gWarn}  systemd tears your session down at logout, so the deck goes with it.${tone.reset}`);
      say(`     ${tone.muted}\`sudo loginctl enable-linger $USER\` keeps it running when you are logged out.${tone.reset}`);
    }
    say(`     ${tone.muted}\`${INVOKED_AS ?? PRODUCT} --uninstall-service\` undoes it${tone.reset}\n`);
    process.exit(0);
  }
  const { canonicalLogPath } = await import(pathToFileURL(join(PKG_ROOT, "src/server/log-writer.mjs")).href);
  const { hasCodexInstalled } = await import(pathToFileURL(join(PKG_ROOT, "src/server/installer.mjs")).href);
  const { hasClaudeInstalled } = await import(pathToFileURL(join(PKG_ROOT, "src/server/claude-dir.mjs")).href);
  const { liveDecks, sameShape } = await import(pathToFileURL(join(PKG_ROOT, "src/server/running-deck.mjs")).href);

  // The default shape, spelled the same way the boot below spells it. NOT the
  // shape of the flags on THIS command line: `--stop --no-codex` is not a
  // request to stop a Codex-less deck, it is a flag that means nothing here,
  // and reading it as a selector would make `--stop` miss the deck it was
  // pointed at and say "nothing is running".
  const mine = {
    workspace: "",
    persist: canonicalLogPath(join(deckLogDir(), "events.jsonl")),
    codex: hasCodexInstalled(),
    claude: hasClaudeInstalled(),
  };

  // ── --logs ────────────────────────────────────────────────────────────────
  // What the deck wrote where a terminal would have shown it. Printed RAW,
  // escapes and all: the launcher passes its own colour tier down to a detached
  // deck, so this file is a mirror of the terminal the deck was started from
  // and re-rendering it is the whole point. The path goes last, because that is
  // the line somebody copies into `tail -f`.
  if (flags.logs) {
    const { readFileSync: readLog, statSync: statLog } = await import("node:fs");
    const logPath = join(deckLogDir(), "deck.log");
    let text = null;
    try { text = readLog(logPath, "utf8"); } catch { /* never started, or swept */ }
    if (text === null) {
      say(`\n  ${tone.muted}${dash}  nothing logged yet ${dash} ${logPath}${tone.reset}\n`);
      process.exit(0);
    }
    // The tail, not the file. It is truncated at the first start on an idle
    // machine, so it is normally small — but an attach appends to a running
    // deck's log every time, and a long-lived deck's log is somebody's week.
    const lines = text.split("\n");
    const shown = lines.slice(Math.max(0, lines.length - 200));
    if (shown.length < lines.length) {
      say(`  ${tone.muted}${dash}  showing the last ${shown.length} of ${lines.length} lines${tone.reset}`);
    }
    process.stdout.write(shown.join("\n"));
    if (!text.endsWith("\n")) say("");
    const size = (() => { try { return statLog(logPath).size; } catch { return 0; } })();
    say(`  ${tone.muted}${dash}  ${logPath} ${bullet} ${size} bytes${tone.reset}\n`);
    process.exit(0);
  }

  const decks = await liveDecks().catch(() => []);
  const age = (d) => sinceLabel(Date.now() - Date.parse(d.startedAt ?? ""));
  const where = (d) => (d.workspace ? d.workspace : "(all)");
  const url = (d) => `http://127.0.0.1:${d.port}`;

  if (flags.status) {
    if (!decks.length) {
      say(`\n  ${tone.muted}${dash}  no deck is running ${dash} \`${INVOKED_AS ?? PRODUCT}\` starts one${tone.reset}\n`);
      process.exit(0);
    }
    // The one a bare `ccdeck` would open is marked, because with two decks up
    // that is the only question this command is really being asked.
    const opens = decks.find(d => sameShape(d, mine)) ?? null;
    say("");
    for (const d of decks) {
      // The version chunk is dropped rather than printed as "v?" for a deck too
      // old to publish one — same rule as the attach line, and for the same
      // reason: a question mark beside two real facts reads as a fault.
      const head = [d.version ? `v${d.version}` : "", `pid ${d.pid}`, `up ${age(d)}`]
        .filter(Boolean).join(`  ${bullet}  `);
      const mark = d === opens ? `${tone.ok}${gOk}${tone.reset}` : `${tone.muted}${bullet}${tone.reset}`;
      const tail = d === opens ? `${tone.muted}   ${arrow} \`${INVOKED_AS ?? PRODUCT}\` opens this one${tone.reset}` : "";
      say(`  ${mark}  ${tone.muted}${head}${tone.reset}${tail}`);
      say(`     ${tone.accent}${tone.bold}${url(d)}${tone.reset}`);
      say(`     ${tone.muted}${where(d)} ${bullet} ${d.persist ?? "no log (--no-persist)"}${tone.reset}`);
    }
    say("");
    process.exit(0);
  }

  // ── --stop ────────────────────────────────────────────────────────────────
  const { stopDeck } = await import(pathToFileURL(join(PKG_ROOT, "src/server/stop-deck.mjs")).href);
  // `flags.port`, not the `rawPort` computed below: that folds in
  // AGENT_DAG_PORT, which is how somebody RUNS a deck rather than which deck
  // they mean to stop — and a deck started on a custom port still has the
  // default SHAPE, so the matcher finds it without help. It is also declared
  // below this block, which would make reading it here a ReferenceError (#797).
  const named = flags.port != null && isPortValue(flags.port) ? Number(flags.port) : null;
  const wanted = flags.all
    ? decks
    : named !== null
      ? decks.filter(d => d.port === named)
      : decks.filter(d => sameShape(d, mine)).slice(0, 1);

  if (!wanted.length) {
    // Three different silences, and saying the wrong one sends the reader
    // looking in the wrong place. A machine with no deck at all is not a
    // machine whose deck is scoped differently.
    const why = !decks.length
      ? `no deck is running`
      : named !== null
        ? `no deck is listening on ${named} ${dash} \`${INVOKED_AS ?? PRODUCT} --status\` lists them`
        : `no deck of this shape is running ${dash} \`${INVOKED_AS ?? PRODUCT} --status\` lists the ${decks.length} that ${decks.length === 1 ? "is" : "are"}`;
    say(`\n  ${tone.muted}${dash}  ${why}${tone.reset}\n`);
    process.exit(0);
  }

  say("");
  let refused = false;
  for (const d of wanted) {
    const was = age(d);
    const out = await stopDeck(d);
    if (!out.ok) {
      refused = true;
      say(`  ${tone.err}${gWarn}  could not stop pid ${d.pid} on ${d.port} ${dash} ${out.reason}${tone.reset}`);
      continue;
    }
    // HOW it went out, not just that it did. "asked" means the deck closed its
    // listener, unlinked its registration and left the LAN cleanly; anything
    // else means none of that happened and the next boot has litter to sweep.
    const how = out.how === "asked"
      ? ""
      : out.old
        ? `  ${tone.muted}(${out.how} ${dash} that deck predates \`--stop\`)${tone.reset}`
        : `  ${tone.muted}(${out.how} ${dash} it did not answer)${tone.reset}`;
    say(`  ${tone.ok}${gOk}${tone.reset}  stopped${tone.muted}  ${bullet}  pid ${d.pid}  ${bullet}  port ${d.port}  ${bullet}  was up ${was}${tone.reset}${how}`);
  }

  // What is still up, named. A command that ends one of three decks and says
  // only "stopped" leaves the reader believing the machine is clear.
  const left = decks.filter(d => !wanted.includes(d));
  if (left.length) {
    say("");
    say(`  ${tone.muted}${dash}  ${left.length} other deck${left.length === 1 ? "" : "s"} still running:${tone.reset}`);
    for (const d of left) say(`       ${tone.muted}pid ${d.pid} ${bullet} ${d.port} ${bullet} ${where(d)}${tone.reset}`);
    say(`     ${tone.muted}\`${INVOKED_AS ?? PRODUCT} --stop --port <n>\` ends one ${bullet} \`--stop --all\` ends every deck${tone.reset}`);
  }
  say("");
  process.exit(refused ? 1 : 0);
}

// The port, and the one piece of argv the deck really does refuse to boot over.
//
// It refused before too — `--port banana` and `--port --no-open` both became
// `Number(…)` → `NaN`, which survived the whole startup (hooks installed,
// claude-swap installed, ccusage probed) and then killed the process from inside
// `listen` with Node's own wording: "options.port should be >= 0 and < 65536.
// Received type number (NaN)." That names neither the flag nor the value the
// user typed, and arrives after a page of green ticks. Same outcome, said here:
// early, in the deck's own voice, quoting the flag and the value back.
//
// An empty `AGENT_DAG_PORT` is an unset one — a variable that did not expand is
// not a request for port zero. `--port ""` never reaches this, because the
// parser records an empty value as `incomplete` and leaves the flag unset.
const envPort = process.env.AGENT_DAG_PORT?.trim();
const rawPort = flags.port ?? (envPort ? envPort : null);
if (rawPort != null && !isPortValue(rawPort)) {
  const named = flags.port != null ? "--port" : "AGENT_DAG_PORT";
  // Its own glyphs, not `G` — that is declared a hundred lines below and this
  // runs at module top level, so reaching for it here would be a temporal dead
  // zone and a ReferenceError on the one path that reports a bad port. Both
  // helpers read the environment and nothing this file has parsed yet, so
  // asking twice on a path that exits immediately costs nothing (#797).
  const { dash } = glyphs(unicodeOK());
  console.error(`${PRODUCT}: ${named} ${rawPort}: not a port number ${dash} expected 0-65535.`);
  process.exit(1);
}
const port = rawPort == null ? 4317 : Number(rawPort);
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
  await sweepTempFiles({ dirs: [legacy, data, log], fs: fsp }).catch(() => 0);
}
// CANONICALISED here rather than left as typed: the discovery file publishes
// this path so the hook can tell which decks share one log and elect a single
// writer for it, and two spellings of one file would read as two files.
// startServer takes the value from here, so the two always name the same file.
//
// `resolve` alone was not enough and #793 is what that cost — see
// canonicalLogPath, which owns the rule and explains it beside the election it
// serves.
const { canonicalLogPath } = await import(pathToFileURL(join(PKG_ROOT, "src/server/log-writer.mjs")).href);
const persist = flags.noPersist
  ? null
  // The log follows the deck rather than Claude Code now — a hundred megabytes
  // of rotating events was never configuration, and it was living in another
  // application's configuration directory. `--history` still wins, and the
  // canonical form is still what the discovery file publishes, so decks that
  // share a path still elect one writer for it.
  : canonicalLogPath(flags.history ?? join(deckLogDir(), "events.jsonl"));

const { installHooks, keepDiscovery, removeDiscovery, hasCodexInstalled } =
  await import(pathToFileURL(join(PKG_ROOT, "src/server/installer.mjs")).href);
// CODEX_SESSIONS_DIR comes along because the banner below names the directory
// the watcher tails, and the watcher lives in that module. Recomputing the path
// here is how the banner came to print ~/.codex/sessions on machines whose
// sessions are somewhere else entirely — see the row further down.
const { startServer, hookToken, releaseRestart, markDeckReady, CODEX_SESSIONS_DIR, canonicalWorkspace } =
  await import(pathToFileURL(join(PKG_ROOT, "src/server/index.mjs")).href);

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
const wantCodex = flags.noCodex
  ? false
  : (flags.codex === true || hasCodexInstalled());

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
const wantClaude = flags.noClaude
  ? false
  : (flags.claude === true || hasClaudeInstalled());

const WEB_DIST = join(PKG_ROOT, "dist", "web", "index.html");
if (!existsSync(WEB_DIST)) {
  console.error(`${PRODUCT}: ui not built. run \`npm run build\` (or \`pnpm build\`) first.`);
  process.exit(1);
}

// ── the terminal we are printing into ─────────────────────────────────────────
// Asked once, degraded from there — see src/server/term.mjs, which is where all
// of this is decided and asserted. Below this point the deck writes no escape of
// its own: colour comes from `P`, glyphs from `G`, layout from statusLine. That
// is what makes NO_COLOR, a pipe, a CI log and a legacy Windows console one
// question rather than thirty separate ones nobody remembers to ask.
const tty = Boolean(process.stdout.isTTY);
const PROFILE = colorProfile({ isTTY: tty });
const P = palette(PROFILE);
const UNICODE = unicodeOK();
const G = glyphs(UNICODE);
const LINKS = supportsHyperlinks({ profile: PROFILE });
// The terminal's prefers-reduced-motion: nothing sleeps, spins or repaints in a
// pipe, under CI, or with NO_COLOR set.
const MOTION = motionOK({ isTTY: tty, profile: PROFILE });
const write = (s) => process.stdout.write(s);
// Read per line, never cached: a terminal can be resized while the deck runs,
// and the pulse below is still on screen hours later.
const cols = () => termColumns(process.stdout);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fileLink = (path) => link(path, pathToFileURL(path).href, LINKS);

/**
 * What is still happening after the report ended, in three words or so.
 *
 * #742 left one job able to outlive the boot — an install of claude-swap that
 * the report stopped waiting for — and the terminal said nothing about it once
 * the rows were done. That is the wrong way round: the row that had finished
 * was the one blinking, and the thing that really was working sat still. Now
 * the pulse line carries the label while the job runs and drops it when the job
 * settles, which is also what decides whether the line moves at all. Declared
 * here rather than beside `registered` below, because reportStartup sets it and
 * runs long before that line does.
 */
let pulseBusy = null;

// ── the cursor ────────────────────────────────────────────────────────────────
// Hidden for as long as anything of ours is moving — the reveal, the spinner,
// the pulse — and put back on every way out of this process: the ordinary exit,
// all three signals, and an uncaught throw, which reaches 'exit' after Node has
// printed it. Half of this is worse than none: a deck that dies with the cursor
// hidden leaves the user's shell with no cursor and nothing to do about it but
// `reset`.
let cursorHidden = false;
const showCursor = () => {
  if (!cursorHidden) return;
  cursorHidden = false;
  try { write(CURSOR_SHOW); } catch { /* stdout is gone; nothing left to restore */ }
};
if (MOTION) { cursorHidden = true; write(CURSOR_HIDE); }
process.on("exit", showCursor);
// SIGHUP is the one signal this process does not otherwise handle, so its
// default action would end us before 'exit' could run. Handled only to put the
// cursor back and then die of it exactly as before — the supervisor reads the
// signal, not an exit code.
process.on("SIGHUP", () => { showCursor(); dieOfSignal("SIGHUP"); });

// ── rows ──────────────────────────────────────────────────────────────────────
// The status column is computed from the longest label. It used to be counted
// into each string as trailing spaces, so any new row, or any label a character
// longer, silently broke the alignment of every other one.
const LABELS = [
  "workspace", "Claude hooks", "Codex sessions", "claude-swap", "accounts",
  "ccusage", "update", "name", "server ready", "log", "unknown option",
  "missing value",
];
const LABEL_W = labelColumn(LABELS);

function row({ mark = " ", tone = P.ok, label = "", detail = "", detailTone = P.muted, keep = false }) {
  return statusLine({
    mark, label, detail, keep, labelWidth: LABEL_W, columns: cols(), ellipsis: G.ellipsis,
    paint: {
      mark: (s) => `${tone}${s}${P.reset}`,
      detail: (s) => `${detailTone}${s}${P.reset}`,
    },
  }) + "\n";
}

// ── the wordmark ──────────────────────────────────────────────────────────────

/**
 * Hold anything else that wants to speak until the art is finished.
 *
 * #742, found while watching a first run through a pty: the startup jobs run
 * UNDER the reveal on purpose, and one of them failing writes to console.error
 * the moment it fails — which put
 *
 *     ccdeck ccusage: install failed: npm install ccusage failed: spawn npm ENOENT
 *
 * between the second and third rows of the logo. A wordmark with a stack of
 * someone else's bad news through the middle of it is the first thing a new
 * user sees, and it reads as a crash rather than as a note.
 *
 * The window is the reveal and nothing else — about 180ms — so at worst a
 * message arrives a fifth of a second later than it would have, on the one
 * stretch of the boot where there is nowhere for it to go. Restored in a
 * `finally`, so a throw inside the reveal cannot leave the process mute.
 */
function holdConsole() {
  const held = [];
  const real = { warn: console.warn, error: console.error, log: console.log };
  for (const k of Object.keys(real)) console[k] = (...args) => { held.push([k, args]); };
  return () => {
    Object.assign(console, real);
    for (const [k, args] of held) real[k](...args);
  };
}

async function printBanner() {
  const { lines } = wordmark({ columns: cols(), version: PKG_VERSION, profile: PROFILE, unicode: UNICODE, pal: P });
  const release = holdConsole();
  try {
    for (const line of lines) {
      write(line + "\n");
      // A reveal, not a wait. The once-per-session work is already running under
      // it (see startupWork), so the art costs the boot nothing and the deck is
      // ready about when the last row lands. What used to be here — 560ms of
      // spinner at "loading…" before a single art line — was dead time in a tool
      // whose documented entry point is `npx ccdeck`.
      if (MOTION && line) await sleep(45);
    }
  } finally {
    release();
  }
}

// ── a step, with a spinner only if it is slow enough to need one ──────────────
// The interval's first frame is 80ms away, so anything already settled when we
// get here paints nothing at all and the row below is the only trace of it.

async function step(label, work) {
  if (!MOTION) return work;
  const frames = spinnerFrames(UNICODE);
  // Kept inside the terminal: a label that wraps is a label the \r below can
  // only half erase, and what is left of it stays under the row that follows.
  // Six columns for the indent and the spinner, four more so the elapsed
  // seconds have somewhere to go without pushing the label off the edge.
  const text = fit(label, cols() - 10, G.ellipsis);
  const started = Date.now();
  let i = 0;
  let widest = 0;
  const iv = setInterval(() => {
    const line = `  ${P.accent}${frames[i++ % frames.length]}${P.reset}  ${P.muted}${text}${elapsedSuffix(Date.now() - started)}${P.reset}`;
    widest = Math.max(widest, visibleWidth(line));
    write(`\r${line}`);
  }, 80);
  try {
    return await work;
  } finally {
    clearInterval(iv);
    // Cleared rather than overwritten: the row that follows is a different
    // length, and relying on it to be the longer of the two is how a spinner
    // leaves its own tail on screen. Measured rather than computed, because the
    // line grows when the elapsed seconds appear and again when they reach two
    // digits. Nothing to clear if it never painted.
    if (i) write("\r" + " ".repeat(widest) + "\r");
  }
}

/**
 * The once-per-session work, all of it started at once and none of it awaited.
 *
 * Hook install, the claude-swap probe and the registry lookup have nothing to
 * do with each other and nothing to do with the wordmark, so they run underneath
 * the reveal instead of queueing behind it — the animation then costs the boot
 * nothing and the deck is ready about when the last art row lands. Every one of
 * them is given its rejection handler here, at the moment it is created, since a
 * promise that settles before anything awaits it is otherwise an unhandled
 * rejection.
 */
function startupWork() {
  // Every job below this line serves Claude Code and only Claude Code: the
  // hooks go in Claude Code's settings.json, claude-swap switches Claude
  // accounts, and ccusage reads Claude Code's own session logs. On a machine
  // without Claude Code all three are work done for a CLI that is not there —
  // two of them installs the user did not ask for — so they are not started at
  // all rather than started and then reported as failures. `null` is how each
  // one says "not attempted", which reportStartup tells apart from "tried and
  // could not".

  // Settings the installer cannot parse are settings it cannot rewrite without
  // losing them, so it refuses — and that refusal is reported rather than
  // thrown, because it is the only thing the user can act on.
  const hooks = wantClaude
    ? installHooks({ provider: "claude" }).then(v => ({ ok: true, v }), err => ({ ok: false, err }))
    : Promise.resolve(null);

  // claude-swap backs the multi-account panel, and an empty store leaves that
  // panel useless even when the tool is there — so the account already signed
  // in is registered once. Bounded inside seedFirstAccount: empty store only,
  // once ever, never with NO_INSTALL set.
  //
  // `cswapInstalling` is the other half, and it is what keeps a first run from
  // spending the boot's whole deadline on a question that has already been
  // answered: ensureCswap resolves it the moment it commits to an install, so
  // the report can stop waiting then rather than eight seconds later. It never
  // settles on the machines where there is nothing to install, which is every
  // machine after the first run.
  let sayInstalling;
  const cswapInstalling = new Promise(r => { sayInstalling = r; });

  const cswap = (async () => {
    if (!wantClaude) return null;
    const { ensureCswap } = await import(pathToFileURL(join(PKG_ROOT, "src/server/cswap-install.mjs")).href);
    const cs = await ensureCswap({ onInstalling: () => sayInstalling() });
    const usable = cs.state === "present" || cs.state === "installed" || cs.state === "upgrading";
    if (!usable) return { cs, seed: null };
    const { seedFirstAccount } = await import(pathToFileURL(join(PKG_ROOT, "src/server/claude-accounts.mjs")).href);
    return { cs, seed: await seedFirstAccount().catch(() => ({ state: "failed" })) };
  })().catch(() => null);

  // ccusage backs the usage-history modal. Primed at boot rather than on first
  // open so a cold machine pays the install while the deck is still starting.
  // Nothing is lost by skipping the prime: runCcusage falls back to npx, so the
  // modal still answers if it is ever opened — it just pays the wait itself.
  const ccusage = (async () => {
    if (!wantClaude) return null;
    if (process.env.AGENTS_DECK_NO_INSTALL === "1") return null;
    const { primeCcusage } = await import(pathToFileURL(join(PKG_ROOT, "src/server/ccusage.mjs")).href);
    return primeCcusage();
  })().catch(() => null);

  // A newer release on npm, said once, in the place the upgrade gets typed.
  // Hard-capped so a slow registry cannot delay the server — the answer is
  // usually already cached in ~/.agents-deck/.self-update-check anyway. It has
  // to resolve BEFORE the pulse indicator starts writing over the last line.
  const update = Promise.race([
    import(pathToFileURL(join(PKG_ROOT, "src/server/self-update.mjs")).href)
      .then(m => m.versionReport({ running: PKG_VERSION, pkgRoot: PKG_ROOT }))
      .then(r => (r?.notice?.kind === "upgrade" ? r : null))
      .catch(() => null),
    new Promise(r => setTimeout(() => r(null), 1200)),
  ]);

  return { hooks, cswap, cswapInstalling, ccusage, update };
}

/** The same work, said out loud, in a fixed order — a boot whose rows arrive in
 *  whatever order the network settled is a boot nobody can scan twice. */
async function reportStartup(jobs) {
  // What the whole report may spend waiting, shared by every job under it
  // rather than granted to each — four jobs at eight seconds each is a
  // thirty-two second boot that no individual deadline would object to.
  const left = budget(bootDeadlineMs());

  write(row({
    mark: G.ok, label: "workspace",
    detail: workspace === "" ? "(all)" : workspace,
    detailTone: workspace === "" ? P.warn : P.muted,
  }));

  const hooks = await step(`installing Claude hooks${G.ellipsis}`, jobs.hooks);
  if (hooks === null) {
    // Said in the same shape as the Codex row below, because it is the same
    // sentence: this deck is not watching that CLI, and here is why. It also
    // retires the one boot failure a Codex-only machine could hit — an
    // unparseable or unwritable settings.json used to exit(1) below, killing a
    // deck over a file belonging to a CLI the user does not run.
    write(row({ label: "Claude hooks", detail: `skipped ${G.dash} no Claude Code found, or --no-claude` }));
  } else if (!hooks.ok) {
    // The file it names is one only the user can repair, and every Claude Code
    // session on this machine is reading it too.
    write(row({ mark: G.fail, tone: P.err, label: "Claude hooks", detail: "not installed" }));
    // THE WAY OUT, printed where the wall is. The installer's message is good —
    // the path, the reason, "fix the file or move it aside" — and it is a file
    // the user may not be able to edit: root-owned, on read-only media, or
    // simply not theirs. This deck knows the remedy and used to keep it in a
    // comment: --no-claude runs everything else, which on a Codex-only machine
    // is the whole deck, over a settings.json belonging to a CLI they do not
    // use.
    console.error(`\n  ${PRODUCT}: ${hooks.err.message}`);
    console.error(`  Or start with --no-claude to run without Claude hooks.\n`);
    process.exit(1);
  } else {
    write(row({ mark: G.ok, label: "Claude hooks", detail: fileLink(hooks.v.hookPath) }));
  }

  // Codex CLI hooks never fire on Windows (sandbox refuses to spawn the hook
  // command). Instead the server tails Codex's rollout JSONL files directly, so
  // there's nothing to install and no /hooks trust step. We just confirm Codex
  // is present and let the watcher pick up sessions.
  if (wantCodex) {
    // The directory the watcher actually tails, imported from the module that
    // owns it rather than rebuilt from homedir() here. CODEX_HOME relocates the
    // whole tree, and this row is the only diagnostic the deck prints about
    // Codex — so when sessions do not show up, a path computed a second way
    // sends the user to inspect a directory the deck never opened.
    write(row({ mark: G.ok, label: "Codex sessions", detail: `watching ${fileLink(CODEX_SESSIONS_DIR)}` }));
  } else {
    write(row({ label: "Codex sessions", detail: `skipped ${G.dash} no ~/.codex/, or --no-codex` }));
  }

  // Bounded, because this is the job that made a first boot look hung: on a
  // machine with neither claude-swap nor a Python toolchain it fetches a uv
  // binary and then builds an environment with it, and the report used to wait
  // out both. See src/server/boot-deadline.mjs. Nothing is cancelled — the
  // install carries on and says how it went when it knows.
  const swapWait = await step(`checking claude-swap${G.ellipsis}`, Promise.race([
    left.within(jobs.cswap),
    // The install announcing itself. Not a timeout — a decision, arriving in
    // about a second on the boot that would otherwise have paid the full
    // deadline for news it already had.
    jobs.cswapInstalling.then(() => ({ done: false, installing: true })),
  ]));
  if (swapWait.done) writeSwapRows(swapWait.value);
  else {
    write(row({
      label: "claude-swap",
      // Both halves earn their place, and both have to survive an 80-column
      // terminal: what the job is doing, and that waiting for it is not the
      // user's problem. The row that only said the first is the row this
      // replaces — a spinner at "checking claude-swap…" says that much.
      detail: swapWait.installing
        ? `installing in the background ${G.dash} the deck is ready`
        : `still setting up ${G.dash} the deck is ready`,
    }));
    // Handed to the pulse line, which is the only thing still on screen once
    // the rows are done — and taken back the moment the job settles, whichever
    // way it settled.
    pulseBusy = swapWait.installing ? "installing claude-swap" : "setting up claude-swap";
    jobs.cswap.then(
      late => { pulseBusy = null; writeSwapRows(late, { late: true }); },
      () => { pulseBusy = null; },
    );
  }

  const cu = await left.within(jobs.ccusage);
  writeCcusageRow(cu.done ? cu.value : null);

  const upgrade = await jobs.update;
  if (upgrade) {
    write(row({
      mark: G.up, tone: P.warn, label: "update",
      detail: `v${upgrade.notice.to} available ${G.dash} ${upgrade.command}`,
    }));
  }

  // Which name this deck was started under, when that is knowable — a notice,
  // never a refusal. 95% of installs are on the two old names and the update
  // path runs through this very process, so a build that declined to boot under
  // one of them would kill the deck on the machine where the deck is what would
  // have explained why. Nothing at all is printed wherever the typed name
  // cannot be proven (a Windows global install, a git checkout): telling
  // somebody who already types `ccdeck` to type `ccdeck` is the one failure
  // that would make this row worth ignoring. See src/server/invoked-as.mjs.
  const rename = renameNotice({ invoked: INVOKED_AS, pkgRoot: PKG_ROOT, dash: G.dash });
  if (rename) {
    write(row({ mark: G.warn, tone: P.warn, label: "name", detail: rename.said }));
    // The line that carries the value: for a global install there is nothing to
    // install and nothing to download, only six different characters to type.
    write(row({ label: "", detail: rename.fix }));
  }
}

/**
 * The claude-swap rows, wherever in the boot they end up being printed.
 *
 * `late` is the one difference, and it is not cosmetic: by the time a late row
 * arrives the pulse indicator owns the last line and repaints it with `\r`, so
 * a row written without a newline first would be drawn over on the next beat.
 * Every other thing that speaks after boot — reportUnregistered,
 * reportReregistered — opens with the same newline for the same reason.
 */
function writeSwapRows(swap, { late = false } = {}) {
  const cs = swap?.cs;
  // Collected rather than written one at a time, because a late report opens
  // with a newline and there is exactly one of those however many rows follow.
  let out = "";
  if (!wantClaude) {
    // claude-swap is a Python tool that switches Claude Code accounts, and the
    // deck used to fetch a uv binary to install it on machines with no Claude
    // Code at all. Saying so is the point of the row: it is the one place a
    // user can learn that the accounts panel is missing on purpose.
    out += row({ label: "claude-swap", detail: `skipped ${G.dash} accounts are Claude-only` });
  } else if (cs?.state === "present") {
    out += row({ mark: G.ok, label: "claude-swap", detail: `v${cs.version} (accounts panel enabled)` });
  } else if (cs?.state === "installed") {
    out += row({ mark: G.ok, label: "claude-swap", detail: `installed v${cs.version} via ${cs.via}` });
  } else if (cs?.state === "upgrading") {
    out += row({ mark: G.ok, label: "claude-swap", detail: `v${cs.version}, upgrading to v${cs.latest} in background` });
  } else if (cs?.state === "skipped") {
    out += row({ mark: G.ok, label: "claude-swap", detail: "not installed (AGENTS_DECK_NO_INSTALL=1)" });
  } else {
    const how = cs?.reason === "no_installer"
      ? `not installed ${G.dash} the accounts panel needs it`
      : cs?.reason === "not_on_path"
        ? `installed via ${cs.via} but not on PATH ${G.dash} add ${
            process.platform === "win32" ? "%USERPROFILE%\\.local\\bin" : "~/.local/bin"
          }`
        : `install failed${cs?.via ? ` via ${cs.via}` : ""}`;
    out += row({ mark: G.fail, tone: P.warn, label: "claude-swap", detail: how });
    // A URL is not an answer when someone just wants the panel to work. Print
    // the command for THIS machine, picked from what is already on it.
    if (cs?.hint) out += row({ label: "", detail: cs.hint });
  }

  if (swap?.seed?.state === "added") {
    out += row({ mark: G.ok, label: "accounts", detail: "registered the signed-in account (cswap add)" });
  } else if (swap?.seed?.state === "failed" || swap?.seed?.state === "nothing-to-add") {
    out += row({ label: "accounts", detail: `panel empty ${G.dash} sign in to Claude Code, then run cswap add` });
  }

  write(late ? "\n" + out : out);
}

/**
 * The ccusage row.
 *
 * `null` covers both of the ways there is nothing to say — the job was not
 * attempted, and the job had not answered by the time the boot's deadline ran
 * out. Neither deserves a row: unlike claude-swap there is no install to wait
 * for here, because primeCcusage starts one and returns without it, so a
 * ccusage that is slow to answer is slow at resolving a path and will be
 * resolved again the first time the usage modal is opened.
 */
function writeCcusageRow(cu) {
  if (cu?.state === "present") write(row({ mark: G.ok, label: "ccusage", detail: `v${cu.version}` }));
  else if (cu?.state === "updating") write(row({ mark: G.ok, label: "ccusage", detail: `v${cu.version}, checking for update` }));
  // A ccusage the user provided, named rather than versioned — reading a
  // version out of it means running it, and a status row is not worth a spawn.
  // Naming the file is the more useful half anyway: it is the answer to "which
  // ccusage is this deck actually going to run", which is a question a machine
  // with a managed install AND a PATH copy could not answer before #433.
  else if (cu?.state === "user") write(row({ mark: G.ok, label: "ccusage", detail: `your own copy ${G.dash} ${cu.bin}` }));
  else if (cu?.state === "installing") write(row({ mark: G.ok, label: "ccusage", detail: "installing in background" }));
}

// Asking the supervisor to bring us back. It is the only party that can, and
// only after this process is gone — which is precisely what keeps the
// replacement from racing this listener onto a random fallback port.
let restarting = false;
// Outer bound on the supervisor's answer below. It cannot be reached today —
// the fetch has a deadline of its own and every path through it replies — but
// `restarting` is a latch, and a latch with no way out is how a deck ends up
// silently refusing every restart for the rest of its life.
const UPGRADE_ANSWER_MS = 150_000;
let upgradeTimer = null;

// Whether the rest of this file has finished running.
//
// The server below starts accepting connections from inside startServer, before
// that call has returned — so /api/restart is reachable for the whole of the
// boot that follows it: the startup report, the port report to the supervisor,
// the discovery file and its first fsynced write, and on a cold start the
// browser spawn. A restart landing in that window used to reach `shutdown`
// before the binding holding it was initialised and die of a ReferenceError,
// having already set the latch above, with nothing left to clear it — after
// which every restart from every tab was answered "ok" and did nothing, for the
// life of the process (#448).
//
// So an ask that arrives too early is held rather than run: the user asked for
// something this deck can genuinely give a moment later, and refusing outright
// would put back the same silence in a politer form. BOOT_RESTART_MS is the
// outer bound, for the reason UPGRADE_ANSWER_MS above is one. It used to be a
// bound that got used — before #742 the report waited out a real `uv tool
// install`, so the window it covers was minutes wide. It is now the boot
// deadline plus the browser spawn, comfortably inside ten seconds, and this
// stays as the thing that makes that a fact rather than a belief. Ten seconds
// in, the ask is run; the respawn skips the report entirely and is up in about
// a second.
let booted = false;
let heldRestart = null;
let bootTimer = null;
const BOOT_RESTART_MS = 10_000;

const requestRestart = (mode) => {
  if (restarting) return;
  restarting = true;
  if (!booted) {
    heldRestart = { mode };
    bootTimer = setTimeout(() => { bootTimer = null; runHeldRestart(); }, BOOT_RESTART_MS);
    bootTimer.unref?.();
    // Said out loud for the same reason abandonUpgrade below is: the tab has
    // already been told its restart was accepted, and a second of nothing
    // happening on this terminal is otherwise indistinguishable from the bug
    // this replaces.
    write(`\n  ${P.warn}${G.restart}${P.reset}  ${P.muted}restart queued ${G.dash} still starting up${P.reset}\n`);
    return;
  }
  beginRestart(mode);
};

// The restart itself, once there is a booted deck to end. Split out of
// requestRestart so the held ask above can re-enter it without tripping the
// latch it is already holding.
//
// Everything here runs inside one try: the whole point of #448 is that a throw
// on this path is not merely a failed restart but a permanent one, because the
// latch it leaves behind outlives it. There is no line in here worth dying for.
function beginRestart(mode) {
  try {
    // "npx" means the newer code is not on this disk at all, so it has to be
    // fetched — and this process keeps serving while that happens. Exiting first
    // is what made every failed upgrade an outage: the SSE stream dropped, hook
    // events fired into the gap were lost outright (hook/hook.js is
    // fire-and-forget with a 1s timeout and no retry), and the canvas came back
    // with whatever was in flight stuck until the stale sweeper reaped it — all
    // of it paid before anyone knew whether npm could even resolve the version.
    // Nothing is torn down here now; the supervisor answers when it knows.
    if (mode === "npx") {
      upgradeTimer = setTimeout(() => abandonUpgrade("no answer from the supervisor"), UPGRADE_ANSWER_MS);
      upgradeTimer.unref?.();
      // Armed before the ask, not after: a send that throws is a supervisor that
      // can no longer answer, and the deck has to come back out of the latch on
      // its own rather than wait out an answer that cannot arrive.
      try { process.send({ type: "upgrade" }); }
      catch (err) { abandonUpgrade(err?.message ?? "the supervisor is no longer listening"); }
      return;
    }
    const to = restartTarget();
    write(`\n  ${P.warn}${G.restart}${P.reset}  ${P.muted}restarting${to ? ` ${G.arrow} v${to}` : ""}${G.ellipsis}${P.reset}\n`);
    shutdown(RESTART_CODE);
  } catch (err) {
    abandonRestart(err);
  }
}

// The ask that was waiting for the boot to finish, now that it has. Safe to
// call when nothing is waiting, which is every ordinary boot.
function runHeldRestart() {
  if (!heldRestart) return;
  const { mode } = heldRestart;
  heldRestart = null;
  clearTimeout(bootTimer);
  bootTimer = null;
  beginRestart(mode);
}

// A restart that could not be started, said out loud and then let go of.
//
// Both halves of the latch have to come down — this file's and the server's —
// because a latch nothing clears is precisely how one failed request turned
// into a deck that refused every restart afterwards while answering "ok" to
// each one (#448). The reason is folded onto one line by oneLine: the terminal
// under this is repainted every 800ms by the pulse, and a stack written into
// that is a stack nobody can read (#432).
//
// A declaration rather than a const, like `shutdown` below and for the same
// reason: this is the handler for a binding that was not there yet, and it must
// not be capable of becoming the next one.
function abandonRestart(err) {
  clearTimeout(bootTimer);
  bootTimer = null;
  heldRestart = null;
  restarting = false;
  releaseRestart();
  write(
    `\n  ${P.err}${G.fail}${P.reset}  ${P.muted}restart failed ${G.dash} still on ${P.reset}v${PKG_VERSION}\n` +
    `     ${P.muted}${oneLine(err?.stack ?? err, Math.max(20, cols() - 6), G.ellipsis)}${P.reset}\n`,
  );
}

// The upgrade did not happen and this deck is still the deck. Said out loud
// because the terminal has just printed that a fetch was starting, and left
// unsaid it reads as a restart that hung.
const abandonUpgrade = (why) => {
  clearTimeout(upgradeTimer);
  restarting = false;
  // The server's own latch, which no longer has an exiting process to clear it.
  releaseRestart();
  write(
    `\n  ${P.warn}${G.cancel}${P.reset}  ${P.muted}update not applied ${G.dash} still on ${P.reset}v${PKG_VERSION}\n` +
    (why ? `     ${P.muted}${why}${P.reset}\n` : ""),
  );
};

// The supervisor's verdict on the fetch it was asked for. Only it can answer:
// the fetch is its child, and it is the process that will still be here when
// this one exits.
process.on("message", (m) => {
  if (!restarting || !m || typeof m !== "object") return;
  if (m.type === "upgrade-ready") {
    clearTimeout(upgradeTimer);
    // The replacement is on the machine now, so this is the last moment the
    // port is worth holding: exiting hands it straight over.
    write(`\n  ${P.warn}${G.restart}${P.reset}  ${P.muted}updating via npx${G.ellipsis}${P.reset}\n`);
    shutdown(UPGRADE_CODE);
  } else if (m.type === "upgrade-refused") {
    abandonUpgrade(m.error);
  }
});

// What a restart would land on. Read from disk now rather than remembered from
// boot, because the whole point is that the two differ.
function restartTarget() {
  try { return JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")).version ?? null; }
  catch { return null; }
}

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
// ── is one of ours already up? ────────────────────────────────────────────────
// A bare `ccdeck` typed beside a deck that is already running used to build a
// second everything on a random port, and neither half mentioned the other.
// src/server/running-deck.mjs carries the whole argument, the registry read and
// the token handshake that makes the answer trustworthy; this is only where it
// is asked.
//
// ASKED EXACTLY HERE, and the position is the point. Everything the answer
// depends on is resolved above — the workspace, the canonical log path, which
// of the two CLIs this deck would serve — and nothing below has run yet: no
// port bound, no hooks installed, no tool probed, no banner painted, no
// discovery file written. An attach therefore leaves the machine precisely as
// it found it, which is what makes it safe to do without asking.
//
// A respawn is excluded on its own line rather than left to the flag check.
// The supervisor relaunches us with `--port <bound>`, which is a shaping flag
// and would be excluded anyway — but a restart is THIS deck coming back, and
// having that read as "somebody typed ccdeck twice" is an accident waiting for
// the day the supervisor stops passing the port.
if (!RESPAWN && !asksForOwnDeck(flags)) {
  const live = await runningDeck({
    want: { workspace, persist, codex: wantCodex, claude: wantClaude },
  }).catch(() => null);
  if (live) {
    const liveUrl = `http://127.0.0.1:${live.port}`;
    const note = versionNote(live.version, PKG_VERSION);
    // Not the startup report's rows. That report has a label column because it
    // has twelve lines to align; this has two, and borrowing the column would
    // indent a three-line message behind a gutter sized for "Codex sessions".
    //
    // The version chunk is dropped rather than printed as "v?" when the running
    // deck is too old to report one — see versionNote, which says nothing in the
    // same case for the same reason.
    const ident = [live.version ? `v${live.version}` : "", `pid ${live.pid}`]
      .filter(Boolean).join(`  ${G.bullet}  `);
    write(`\n  ${P.ok}${G.ok}${P.reset}  deck already running${P.muted}  ${G.bullet}  ${ident}${P.reset}\n`);
    // Its own line, always. The URL is the one detail an ellipsis would destroy
    // — half an address is not a shorter address — and this message has no
    // report to hand it to. Same rule as statusLine's `keep`.
    write(`     ${P.accent}${P.bold}${link(liveUrl, liveUrl, LINKS)}${P.reset}\n`);
    if (note) write(`  ${P.warn}${G.warn}  ${note}${P.reset}\n`);
    // THE TYPO'S WARNING, on the path that has no startup report to carry it.
    //
    // asksForOwnDeck used to answer `true` for these two so the report would
    // run and print them, and that is how `ccdeck --stpo` — a misspelling of
    // the flag that STOPS a deck — came to build a second one. The warning was
    // the requirement; the extra process never was. Printed here, in the same
    // rows the report uses, so nothing is lost and nothing is started.
    reportUnknownFlags(flags.unknown);
    reportIncompleteFlags(flags.incomplete);
    // The line that says a second deck was NOT started. Without it the command
    // looks like it did nothing at all, which is the other way to be confusing
    // about this — and it names the flag for the person who really did want two.
    write(`\n  ${P.muted}${G.dash}  no second deck was started ${G.dash} \`${INVOKED_AS ?? PRODUCT} --new\` starts one${P.reset}\n`);
    if (openBrowser) {
      write(`\n  ${P.ok}${P.bold}${G.play}  opening browser${G.ellipsis}${P.reset}\n\n`);
      try {
        const { openUrl, LAUNCH_GRACE_MS } = await import(pathToFileURL(join(PKG_ROOT, "src/server/open-url.mjs")).href);
        openUrl(liveUrl);
        // Held for exactly as long as openUrl needs to fall through to its next
        // launcher. Every child it spawns is unref'd, so an immediate exit ends
        // this process before a missing xdg-open has been answered by gio — and
        // then no browser opens and nothing says why. The boot path never had
        // to think about this because it stays alive forever.
        await sleep(LAUNCH_GRACE_MS);
      } catch { /* the URL is on screen; it can be clicked or pasted */ }
    } else {
      write("\n");
    }
    process.exit(0);
  }
}

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
}).then(s => ({ ok: true, s }), err => ({ ok: false, err }));

// Once-per-session setup — hook install, tool probes, registry lookups, and the
// banner it runs underneath. A respawn is the same session continuing, so it
// skips the lot and prints one line instead. This is the difference between a
// restart that feels instant and one that makes you wonder whether it worked.
if (!RESPAWN) {
  const jobs = startupWork();
  await printBanner();
  await reportStartup(jobs);
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

if (RESPAWN) {
  write(`  ${P.ok}${G.restart}${P.reset}  ${P.muted}restarted ${G.arrow} ${P.reset}v${PKG_VERSION}${P.muted} ${G.bullet} ${link(url, url, LINKS)}${P.reset}\n`);
  // A respawn skips the whole startup report, but not this: the argv is the
  // same argv, the typo in it is still there, and a deck that mentioned it once
  // and then went quiet for every restart afterwards is back to hiding it from
  // anyone who was not watching the first boot.
  reportUnknownFlags(flags.unknown);
  reportIncompleteFlags(flags.incomplete);
} else {
  // The URL is the one detail an ellipsis would destroy — half an address is
  // not a shorter address — so it keeps its own line when the terminal is too
  // narrow to hold it beside the label. See statusLine's `keep`.
  write(row({
    mark: G.ok, label: "server ready",
    detail: link(url, url, LINKS), detailTone: `${P.accent}${P.bold}`, keep: true,
  }));
  if (persist) write(row({ label: "log", detail: fileLink(persist) }));
  // Last of the rows, on purpose — see reportUnknownFlags.
  reportUnknownFlags(flags.unknown);
  reportIncompleteFlags(flags.incomplete);
  // Only when one is actually being opened. Under --no-open — which is how an
  // npx update relaunches, with a tab already waiting — this was announcing
  // something that never happened.
  if (openBrowser) write(`\n  ${P.ok}${P.bold}${G.play}  opening browser${G.ellipsis}${P.reset}\n\n`);
  else write("\n");
}

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
// elected to record. See writesCodexLog in src/server/log-writer.mjs.
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

// ── the deck from before this version that is still running ──────────────────
//
// UPGRADE DAY, and without this it is a mystery. A deck older than the attach
// publishes no `claude` and no `version` in its discovery record, so sameShape
// cannot match it — deliberately, because a record that cannot be compared is
// not one to attach to. The consequence is that the first `ccdeck` after an
// upgrade starts a SECOND deck beside the one already running, opens a tab on
// it, and says nothing; and `ccdeck --stop` will not find the old one either,
// because it has the same shape problem.
//
// So it is named, once, with the command that actually clears it. Only for
// decks with no version: a deck started with `--new`, or one scoped to another
// workspace, is somebody's deliberate second deck and needs no explaining.
if (!RESPAWN) {
  try {
    const { liveDecks } = await import(pathToFileURL(join(PKG_ROOT, "src/server/running-deck.mjs")).href);
    const older = (await liveDecks()).filter(d => !d.version);
    if (older.length) {
      const where = older.map(d => d.port).join(", ");
      write(`  ${P.warn}${G.warn}${P.reset}  ${P.muted}${older.length === 1 ? "a deck" : `${older.length} decks`} from an older ${PRODUCT} ${older.length === 1 ? "is" : "are"} still running on ${where}${P.reset}\n`);
      write(`     ${P.muted}too old to be recognised, so this one started beside ${older.length === 1 ? "it" : "them"} ${G.dash} \`${INVOKED_AS ?? PRODUCT} --stop --all\` clears the lot${P.reset}\n\n`);
    }
  } catch { /* a question about other decks is never a reason to fail a boot */ }
}

// ── starting at login ─────────────────────────────────────────────────────────
//
// ONCE PER MACHINE, EVER. The record in the deck's own data directory is what
// makes that true: without it, `--uninstall-service` would be undone by the next
// start, which is not an uninstall — it is a tool arguing with its user.
//
// After the boot rather than during it, and deliberately: a deck that could not
// come up has no business teaching the machine to start it at every login. By
// here the port is bound, the hooks are registered and the browser is open.
//
// npx is excluded and AGENTS_DECK_NO_INSTALL is honoured — see
// shouldOfferService, which owns both rules and says why. A failure is one line
// and nothing else: the deck is already running, and the worst case is the
// behaviour every version before this one had.
if (!RESPAWN) {
  try {
    const svc = await import(pathToFileURL(join(PKG_ROOT, "src/server/login-service.mjs")).href);
    const { isGitCheckout, isNpxInstall } = await import(pathToFileURL(join(PKG_ROOT, "src/server/self-update.mjs")).href);
    if (svc.shouldOfferService({
      record: svc.readServiceRecord(deckDataDir()),
      npx: isNpxInstall(PKG_ROOT),
      checkout: isGitCheckout(PKG_ROOT),
    })) {
      const out = svc.installService({
        script: join(PKG_ROOT, "bin", "agent-dag.js"),
        logPath: join(deckLogDir(), "deck.log"),
        product: PRODUCT,
      });
      svc.writeServiceRecord(deckDataDir(), out.ok
        ? { installed: PKG_VERSION, at: new Date().toISOString(), path: out.path }
        : { failed: out.reason ?? "unknown", at: new Date().toISOString(), version: PKG_VERSION });
      // Said once, on the one run that does it, and never again. A tool that
      // adds itself to your login items and does not mention it is a tool you
      // find later, in a settings pane, and stop trusting.
      write(out.ok
        ? `  ${P.muted}${G.dash}  ${PRODUCT} will now start when you log in ${G.dash} \`${INVOKED_AS ?? PRODUCT} --uninstall-service\` undoes it${P.reset}\n\n`
        : `  ${P.muted}${G.dash}  could not set ${PRODUCT} to start at login (${out.reason}) ${G.dash} it still starts when you type it${P.reset}\n\n`);
    }
  } catch (err) {
    // Never fatal. The deck is up; this is a convenience that did not happen.
    console.error(`${PRODUCT}: could not check the login item:`, err?.message ?? err);
  }
}

// ── Pulse indicator ───────────────────────────────────────────────────────────
// The whole line is rewritten each beat rather than just the dot: anything else
// on this deck that has something to say writes a newline first, and after that
// the line under the cursor is no longer the one we drew — a partial repaint
// would leave the message behind and pulse into empty space. Sized to the real
// terminal, because at 40 columns the old fixed 61-character line wrapped, and
// from then on \r only ever reached its second row.
//
// AND IT STOPS MOVING (#742). The dot alternated green and grey every 800ms for
// as long as the deck ran, and a blinking indicator beside a status line is the
// vocabulary of "working on it" — so a boot that finished in a second read as
// one that never finished, which is what people reported. Motion is now spent
// on the two states where something really is outstanding, and the frame is
// compared against what is already on screen so a deck at rest paints once and
// then leaves the terminal alone. See pulseMoves.
if (MOTION) {
  let pi = 0;
  let painted = null;
  // The line is on screen and is the last thing written to this terminal.
  let ours = false;
  // We are the one writing right now, so the guard below leaves us alone.
  let writing = false;

  // The pulse line's tenancy, enforced rather than agreed.
  //
  // The convention was that anything with something to say writes a newline
  // first, so the pulse's `\r` never lands on somebody else's text. bin/deck.js
  // keeps it everywhere. src/server/quota.mjs does not — it calls console.error
  // directly — and a Windows user with no Claude Code sent a screenshot of the
  // result: `listening — Ctrl+C to stop        ccdeck quota: claude CLI failed`
  // on one row, three times over, the pulse and the complaint interleaved.
  //
  // An invariant every writer has to remember is one a writer will forget, and
  // the writers here are server modules that know nothing about a terminal. So
  // it is enforced at the stream instead: while our line is the last thing on
  // screen, anything else that speaks gets a newline first, and the memo is
  // dropped so the next beat repaints the line under whatever was said.
  //
  // Both streams, because console.error goes to stderr and lands on the same
  // screen. Only when MOTION is on — with no pulse there is no line to defend,
  // and a piped deck must not have its output rewritten.
  for (const stream of [process.stdout, process.stderr]) {
    const real = stream.write.bind(stream);
    stream.write = (chunk, ...rest) => {
      if (!writing && ours) {
        ours = false;
        // Dropped, not kept: the line is no longer where we left it, so the
        // next beat has to draw it again even though the frame is unchanged.
        painted = null;
        // Unless the speaker already did it. Every late message in this file
        // opens with one, and two blank lines is its own kind of mess.
        if (!String(chunk).startsWith("\n")) real("\n");
      }
      return real(chunk, ...rest);
    };
  }

  setInterval(() => {
    // The colour follows the words. A Codex-only deck keeps saying "listening"
    // when it is unregistered — see pulseText — and painting that sentence in
    // the warning tone would restore the alarm the sentence just retired.
    const alarm = !registered && wantClaude;
    const state = { registered, claude: wantClaude, busy: pulseBusy };
    const text = pulseText({ ...state, columns: cols(), unicode: UNICODE });
    // At rest every beat is lit, which is what makes the line still: the frame
    // is then identical to the one already on screen and the write below is
    // skipped. See pulseDot.
    const dot = pulseDot(pi++, state) === "on" ? (alarm ? P.warn : P.ok) : P.muted;
    const tone = alarm ? P.warn : P.muted;
    const frame = `\r  ${dot}${G.pulse}${P.reset}  ${tone}${text}${P.reset}`;
    // Unchanged frames are not written at all. That is what makes "at rest"
    // visible: one paint, and then a still line for as long as nothing happens.
    // `painted` is dropped by the guard above whenever somebody else writes, so
    // this can only skip a beat while the line is genuinely still where we left
    // it.
    if (frame === painted) return;
    painted = frame;
    writing = true;
    try { write(frame); } finally { writing = false; }
    ours = true;
  }, 800).unref();
}

// Boot is over. Everything `shutdown` tears down exists, so a restart can be
// run rather than held — and the server is told, so /api/restart stops
// describing a deck that is still assembling itself. This line is exactly where
// the window opened at the top of this file closes; see requestRestart.
booted = true;
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
    if (tty && code !== RESTART_CODE && code !== UPGRADE_CODE) {
      write(`\n\n  ${P.warn}${G.stop}  shutting down${G.ellipsis}${P.reset}\n`);
    }
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
process.on("beforeExit", () => { discovery?.stop(); if (discoveryFile) removeDiscovery(discoveryFile); });

// ── helpers ───────────────────────────────────────────────────────────────────

// The deck is up and the discovery file could not be written. Said in full —
// the path, the reason — because the alternative is what this replaced: an
// ordinary-looking deck that simply never shows a session.
//
// What that costs depends on which CLI this deck watches, so the sentence comes
// from term.mjs, where both answers are written down and tested.
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

/**
 * Every token the parser did not recognise, named, one row each.
 *
 * Said rather than acted on: the deck goes on booting and still exits 0. It is
 * not a one-shot command that can afford the usual contract. `bin/agent-dag.js`
 * hands its own argv to every worker it spawns — including the npx relaunch,
 * which starts a NEWER version of the package on the argv the user typed
 * against an older one — and the README recommends running it from a wrapper.
 * Refusing to boot over one token would turn a typo into a dark dashboard, and
 * an argument the newer build no longer knows into a failed upgrade that costs
 * the port and the session. The file already holds that position once, in the
 * `--all` branch: a flag the deck stopped needing is still accepted rather than
 * made fatal.
 *
 * So it goes where the deck puts everything else it decided on your behalf —
 * the startup report — and it goes at the END of it. reportStartup writes its
 * rows in a fixed order and three more land underneath them (the server, the
 * log, the browser), so a warning printed among those rows is a warning the
 * rows scroll over. Here it is the last line before the pulse indicator takes
 * the bottom of the screen and stops repainting anything above it.
 */
function reportUnknownFlags(unknown) {
  for (const token of unknown) {
    write(row({
      mark: G.warn, tone: P.warn, label: "unknown option",
      detail: `${token} ${G.dash} see \`${PRODUCT} --help\``,
    }));
  }
}

/**
 * Every value-taking flag that was given no value it could use, named, one row
 * each — and printed beside the unknown ones because it is the same failure
 * wearing a different hat.
 *
 * #697: `--workspace`, `--history` and `--port` used to consume the following
 * token whatever it was, so `ccdeck --workspace $PROJ --no-persist` with `PROJ`
 * unset scoped the deck to a directory called `--no-persist`, kept persisting to
 * the shared log, and reported neither. Nothing landed in `unknown`, because the
 * token that belonged there had been eaten. The parser refuses that value now
 * and lists the flag here instead.
 *
 * Said rather than acted on, under exactly the argument reportUnknownFlags makes
 * above: the flag falls back to its documented default and the deck still boots.
 * The row is what makes the fallback a decision the user can see, and the rows
 * around it show its consequence — `workspace (all)` and the `log` line are
 * printed by the same report.
 */
function reportIncompleteFlags(incomplete) {
  for (const { flag, expects } of incomplete ?? []) {
    write(row({
      mark: G.warn, tone: P.warn, label: "missing value",
      detail: `${flag} ${G.dash} expected ${expects}; using the default`,
    }));
  }
}

function printHelp() {
  process.stdout.write(`${PRODUCT} — live deck of Claude Code + Codex agents

Usage:
  ${PRODUCT} [options]

Options:
  -p, --port <number>      Preferred port (default: 4317; falls back to random 4318–4400)
      --no-open            Don't open the browser automatically
      --foreground         Hold the terminal, the way every version before 3.20
                           did. Ctrl+C stops the deck again
      --new                Start a second deck even if one is already running.
                           Without it, a bare \`${PRODUCT}\` beside a deck that is
                           already up opens that deck's tab instead of building
                           a rival on another port
      --stop               Stop the deck a bare \`${PRODUCT}\` would open.
                           With --port <n>, stop that one; with --all, stop every
                           deck on this machine
      --status             What is running on this machine, and on which ports
      --logs               What the deck wrote where a terminal would have shown
                           it, and where that file is
      --install-service    Start the deck when you log in. Set up on first run;
                           this is only for putting it back
      --uninstall-service  Stop starting at login. \`--uninstall\` does this too
      --workspace <path>   Only capture sessions whose cwd is inside <path>
      --scope              Restrict to current working directory
      --all                Capture every session (default). Beside --stop it
                           means every deck rather than every session
      --history <path>     Override events log file (default: this platform's log directory)
      --no-persist         Don't write or replay events log (RAM-only)
      --codex              Force-enable Codex capture even if ~/.codex/ missing
      --no-codex           Skip Codex capture (Claude only)
      --claude             Force-enable Claude capture even if Claude Code wasn't found
      --no-claude          Skip Claude entirely: no hooks, no claude-swap, no accounts panel
      --uninstall          Remove ${PRODUCT}'s hooks from ~/.claude/settings.json and
                           ~/.codex/hooks.json, and restore any sound hooks of yours it parked.
                           Hook entries only: the forwarder script, ~/.claude/agent-dag/,
                           the events log, ~/.agents-deck/ and claude-swap all stay
  -h, --help               Show this help
  -v, --version            Print the version and exit

Anything else on the command line is reported as an unknown option and then
ignored: the deck still starts.

A flag that takes a value never swallows the next flag. If the value is missing,
empty, or itself looks like a flag — \`${PRODUCT} --workspace \$UNSET --no-persist\`
after the shell has dropped an unset variable — the flag is reported, left on its
default, and the token it would have eaten is parsed as the flag it is.
`);
}
