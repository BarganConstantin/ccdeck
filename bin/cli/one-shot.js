// The one-shot commands: `--status`, `--logs` and `--stop`, and the way in for
// the three login-item commands, which bin/cli/login-item.js answers.
//
// One-shot commands in the shape `--uninstall` already established: do the
// thing, print, exit, and never start a server. bin/deck.js asks them ABOVE the
// migration and well above the heavy imports, because a command that ends a
// deck has no business moving that deck's files on the way past, and because
// asking a server to stop should not require starting one.
//
// The glyphs and the palette are the boot's own, from bin/cli/screen.js, which
// answers them when it loads — so these lines can use them even though they run
// before the boot has drawn anything (#797).
import { readFileSync as readLog, statSync as statLog } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isPortValue } from "../../src/server/args.mjs";
import { sinceLabel } from "../../src/server/term.mjs";
import { installGlobally, loginItemCommand } from "./login-item.js";
import { COMMAND, PKG_ROOT } from "./package.js";
import { G, P } from "./screen.js";

/**
 * Answer one of the six one-shot flags and resolve to the exit code. The
 * caller exits with it; nothing here starts a server.
 */
export async function oneShot(flags) {
  const voice = oneShotVoice();
  reportFlagRows(flags, voice);
  if (flags.stop && refusesPort(flags, voice)) return 1;

  const { deckDataDir, deckLogDir } = await import(pathToFileURL(join(PKG_ROOT, "src/server/deck-home.mjs")).href);

  // --install, --install-service and --uninstall-service: the login item, in
  // bin/cli/login-item.js. Answered before the registry is read, since neither
  // is about a deck that is running.
  if (flags.install) return installGlobally({ ...voice, deckDataDir, deckLogDir });
  if (flags.installService || flags.uninstallService) return loginItemCommand(flags, { ...voice, deckDataDir, deckLogDir });
  if (flags.logs) return printLogs(deckLogDir, voice);

  const { liveDecks, restartingDecks } = await import(pathToFileURL(join(PKG_ROOT, "src/server/running-deck.mjs")).href);
  const decks = await liveDecks().catch(() => []);
  // And the deck a crash took down, whose supervisor is about to bring it back
  // (#1779). Left off, `--stop` inside that wait said nothing was running and
  // the deck came back by itself a few seconds later.
  const restarting = await restartingDecks().catch(() => []);
  if (flags.status) return printStatus([...decks, ...restarting], await defaultShape(deckLogDir), voice);
  return stopDecks(flags, [...decks, ...restarting], voice);
}

/** The screen's glyphs and palette, by the names the one-shots use, and `say`. */
function oneShotVoice() {
  const { dash, ok: gOk, warn: gWarn, bullet, arrow, ellipsis: gEllipsis } = G;
  const tone = P;
  const say = (line) => process.stdout.write(`${line}\n`);
  return { dash, gOk, gWarn, bullet, arrow, gEllipsis, tone, say };
}

const age = (d) => sinceLabel(Date.now() - Date.parse(d.startedAt ?? ""));
const where = (d) => (d.workspace ? d.workspace : "(all)");
const url = (d) => `http://127.0.0.1:${d.port}`;
// A deck between workers is its supervisor: the worker's pid is a dead one.
const pidOf = (d) => (d.restarting ? d.parent : d.pid);

// WHAT THE ONE-SHOTS USED TO SWALLOW.
//
// The boot's reportUnknownFlags and reportIncompleteFlags live in bin/deck.js,
// which is the script itself and cannot be imported, and they write the boot's
// label-column rows to stdout. So a one-shot's are written here, to stderr, in
// the one-shots' own shape.
//
// Without them `--help`'s closing promise — "Anything else on the command
// line is reported as an unknown option and then ignored" — held for a boot
// and for none of the nine one-shots: `ccdeck --status --prot 4317` printed
// the status and never mentioned the flag.
function reportFlagRows(flags, { tone, gWarn, dash }) {
  for (const token of flags.unknown ?? []) {
    process.stderr.write(`  ${tone.warn}${gWarn}  unknown option${tone.reset}  ${token} ${dash} see \`${COMMAND} --help\`\n`);
  }
  for (const { flag, expects } of flags.incomplete ?? []) {
    process.stderr.write(`  ${tone.warn}${gWarn}  missing value${tone.reset}   ${flag} ${dash} expected ${expects}\n`);
  }
}

// AND `--stop` FAILS CLOSED ON A PORT IT CANNOT USE.
//
// The selector below reads "no usable port" and "no port asked for" as the
// same thing, and the second means every deck — so `ccdeck --stop --port
// 431x`, or `--port $UNSET`, ended every deck on the machine and exited 0.
// The guard that refuses a bad port is in bin/deck.js, below the line that
// brings a one-shot here, and a one-shot always exits before reaching it.
//
// A narrowing flag that fails open to "everything" is the wrong default for
// an off switch: failing closed costs a retype, failing open costs a deck
// somebody else was watching. So this answers true, having said why, when
// `--stop` was pointed at a port it cannot use.
//
// And a port-shaped token the parser could not read at all — `--port4317`,
// `--ports 4317` — which lands in `unknown` with `flags.port` undefined, the
// same "every deck" by a third road (#1780). Its row above has already named it.
function refusesPort(flags, { dash }) {
  const askedPort = (flags.incomplete ?? []).some(x => x.flag === "--port" || x.flag === "-p")
    || (flags.unknown ?? []).some(t => /^(-p|--port)/.test(String(t)));
  const badPort = flags.port != null && !isPortValue(flags.port);
  if (badPort || askedPort) {
    const shown = badPort ? ` ${flags.port}` : "";
    console.error(`${COMMAND}: --port${shown}: not a port number ${dash} expected 0-65535.`);
    console.error(`${COMMAND}: refusing to stop every deck when you asked for one.`);
    return true;
  }
  return false;
}

// ── --logs ────────────────────────────────────────────────────────────────
// What the deck wrote where a terminal would have shown it. Printed RAW,
// escapes and all: the launcher passes its own colour tier down to a detached
// deck, so this file is a mirror of the terminal the deck was started from
// and re-rendering it is the whole point. The path goes last, because that is
// the line somebody copies into `tail -f`.
function printLogs(deckLogDir, { say, tone, dash, bullet }) {
  const logPath = join(deckLogDir(), "deck.log");
  let text = null;
  try { text = readLog(logPath, "utf8"); } catch { /* never started, or swept */ }
  if (text === null) {
    say(`\n  ${tone.muted}${dash}  nothing logged yet ${dash} ${logPath}${tone.reset}\n`);
    return 0;
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
  return 0;
}

/**
 * The shape a bare start would have, for the deck `--status` marks as the one
 * it opens.
 */
async function defaultShape(deckLogDir) {
  const { canonicalLogPath } = await import(pathToFileURL(join(PKG_ROOT, "src/server/log-election.mjs")).href);
  const { hasCodexInstalled, codexHomeField } = await import(pathToFileURL(join(PKG_ROOT, "src/server/installer.mjs")).href);
  const { hasClaudeInstalled } = await import(pathToFileURL(join(PKG_ROOT, "src/server/claude-dir.mjs")).href);

  // The default shape, spelled the same way deck.js's boot spells it. NOT the
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
  // And the Codex tree, the one field of a start's shape that is not a flag. A
  // bare start has passed it since #1123 and replaces a deck on another tree, so
  // without it here every tree matched, and `--status` could mark as "opens this
  // one" exactly the deck the next `ccdeck` stops (#1134). Worked out by the
  // function the start and the discovery record use, so all three agree.
  mine.codexHome = codexHomeField(mine.codex);
  return mine;
}

/** `--status`: every deck on this machine, and which one a bare start would open. */
async function printStatus(decks, mine, { say, tone, dash, gOk, bullet, arrow }) {
  const { sameShape } = await import(pathToFileURL(join(PKG_ROOT, "src/server/running-deck.mjs")).href);
  if (!decks.length) {
    say(`\n  ${tone.muted}${dash}  no deck is running ${dash} \`${COMMAND}\` starts one${tone.reset}\n`);
    return 0;
  }
  // The one a bare `ccdeck` would open is marked, because with two decks up
  // that is the only question this command is really being asked. Never a
  // deck between workers: a start typed now finds nothing to open there.
  const opens = decks.find(d => !d.restarting && sameShape(d, mine)) ?? null;
  say("");
  for (const d of decks) {
    // The version chunk is dropped rather than printed as "v?" for a deck too
    // old to publish one — same rule as the attach line, and for the same
    // reason: a question mark beside two real facts reads as a fault.
    //
    // A deck between workers is named by its supervisor, the one process of
    // it still running, and says what it is doing instead of how long it has
    // been up.
    const head = [d.version ? `v${d.version}` : "", `pid ${pidOf(d)}`, d.restarting ? "restarting after a crash" : `up ${age(d)}`]
      .filter(Boolean).join(`  ${bullet}  `);
    const mark = d === opens ? `${tone.ok}${gOk}${tone.reset}` : `${tone.muted}${bullet}${tone.reset}`;
    const tail = d === opens ? `${tone.muted}   ${arrow} \`${COMMAND}\` opens this one${tone.reset}` : "";
    say(`  ${mark}  ${tone.muted}${head}${tone.reset}${tail}`);
    say(`     ${tone.accent}${tone.bold}${url(d)}${tone.reset}`);
    say(`     ${tone.muted}${where(d)} ${bullet} ${d.persist ?? "no log (--no-persist)"}${tone.reset}`);
  }
  say("");
  return 0;
}

// ── --stop ────────────────────────────────────────────────────────────────
//
// WHICH DECK. Every one, unless `--port <n>` names one. A start keeps at most
// one deck now, so a second is a leftover from before that rule, and an off
// switch that ended one of two would leave the machine running. (`--all` is the
// legacy capture flag, a no-op since it became the default; beside `--stop` it
// always meant "every deck", and that is what the bare command means now.)
async function stopDecks(flags, decks, { say, tone, dash, gOk, gWarn, bullet }) {
  const { stopDeck } = await import(pathToFileURL(join(PKG_ROOT, "src/server/stop-deck.mjs")).href);
  // `flags.port`, not the `rawPort` deck.js computes: that folds in
  // AGENT_DAG_PORT, which is how somebody RUNS a deck rather than which deck
  // they mean to stop — and a deck started on a custom port still has the
  // default SHAPE, so the matcher finds it without help. It is also a binding
  // deck.js declares after it asks this, so it is not there to read (#797).
  const named = flags.port != null && isPortValue(flags.port) ? Number(flags.port) : null;
  // EVERY DECK, unless one is named. There is meant to be one — a start keeps
  // at most one now — so a second here is a leftover from before that rule, and
  // an off switch that ended one of two would leave the machine running. `--all`
  // is still accepted, and now means what the bare command means.
  const wanted = named !== null ? decks.filter(d => d.port === named) : decks;

  if (!wanted.length) {
    // Two different silences, and saying the wrong one sends the reader looking
    // in the wrong place.
    const why = named !== null && decks.length
      ? `no deck is listening on ${named} ${dash} \`${COMMAND} --status\` lists them`
      : `no deck is running`;
    say(`\n  ${tone.muted}${dash}  ${why}${tone.reset}\n`);
    return 0;
  }

  say("");
  let refused = false;
  for (const d of wanted) {
    const was = age(d);
    const out = await stopDeck(d);
    if (!out.ok) {
      refused = true;
      say(`  ${tone.err}${gWarn}  could not stop pid ${pidOf(d)} on ${d.port} ${dash} ${out.reason}${tone.reset}`);
      continue;
    }
    // HOW it went out, not just that it did. "asked" means the deck closed its
    // listener, unlinked its registration and left the LAN cleanly; anything
    // else means none of that happened and the next boot has litter to sweep.
    // A deck between workers had nothing to ask, and is said to be that.
    const how = out.how === "asked"
      ? ""
      : d.restarting
        ? `  ${tone.muted}(${out.how} ${dash} it was restarting after a crash)${tone.reset}`
        : out.old
          ? `  ${tone.muted}(${out.how} ${dash} that deck predates \`--stop\`)${tone.reset}`
          : `  ${tone.muted}(${out.how} ${dash} it did not answer)${tone.reset}`;
    say(`  ${tone.ok}${gOk}${tone.reset}  stopped${tone.muted}  ${bullet}  pid ${pidOf(d)}  ${bullet}  port ${d.port}  ${bullet}  was up ${was}${tone.reset}${how}`);
  }

  // What is still up, named. A command that ends one of three decks and says
  // only "stopped" leaves the reader believing the machine is clear.
  const left = decks.filter(d => !wanted.includes(d));
  if (left.length) {
    say("");
    say(`  ${tone.muted}${dash}  ${left.length} other deck${left.length === 1 ? "" : "s"} still running:${tone.reset}`);
    for (const d of left) say(`       ${tone.muted}pid ${pidOf(d)} ${bullet} ${d.port} ${bullet} ${where(d)}${tone.reset}`);
    // `--stop --all` used to be named here as the way to reach every deck. It
    // is not: `--all` is a parsed no-op, and a bare `--stop` already ends every
    // deck — which is why this line is only reachable after `--stop --port <n>`
    // narrowed one. Naming the narrowing form is the half that is true.
    say(`     ${tone.muted}\`${COMMAND} --stop\` ends every deck ${bullet} \`--stop --port <n>\` ends one${tone.reset}`);
  }
  say("");
  return refused ? 1 : 0;
}
