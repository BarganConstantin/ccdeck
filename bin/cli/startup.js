// The once-per-session work, and the startup report that says how it went.
//
// Lifted out of bin/deck.js, which starts the work beside the server, prints
// the wordmark over it and then calls reportStartup, exactly as before. What the
// report needs to know about this boot — the workspace, which CLIs it serves,
// where the Codex watcher looks — comes in as arguments; the modules the jobs
// load are still imported off PKG_ROOT at the moment each job starts.
//
// The two flag rows are here too: they are the end of this report, printed by
// deck.js once the server row and the log row have landed under it.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { budget, bootDeadlineMs } from "../../src/server/boot-deadline.mjs";
import { PRODUCT } from "../../src/server/brand.mjs";
import { renameNotice } from "../../src/server/invoked-as.mjs";
import { link } from "../../src/server/term.mjs";
import { wayBackNote } from "../../src/server/way-back.mjs";
import { INVOKED_AS, PKG_ROOT, PKG_VERSION } from "./package.js";
import { G, LINKS, P, cols, fileLink, row, step, write } from "./screen.js";

/**
 * What is still happening after the report ended, in three words or so.
 *
 * #742 left one job able to outlive the boot — an install of claude-swap that
 * the report stopped waiting for — and the terminal said nothing about it once
 * the rows were done. That is the wrong way round: the row that had finished
 * was the one blinking, and the thing that really was working sat still. Now
 * the pulse line carries the label while the job runs and drops it when the job
 * settles, which is also what decides whether the line moves at all. Kept
 * here, beside the report that sets it; the pulse line in bin/deck.js reads it
 * through busyLabel.
 */
let pulseBusy = null;

/** The pulse line's label for work still running after the report, or null. */
export const busyLabel = () => pulseBusy;

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
export function startupWork({ wantClaude, installHooks, leftoverCodexHooks }) {
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

  // WHEN THE TOOL IS QUIET, which is not the same as when the job above settles
  // (#1043). The auto-switch drives this same claude-swap — every tick is
  // `cswap auto --once`, which moves the user's live Claude credentials — and
  // the server arms it the moment the port binds, while this job is still in
  // ensureCswap. So the server holds every tick until this resolves, and it has
  // two halves because the job covers only the first: ensureCswap answers
  // "upgrading" as soon as it has FIRED an upgrade it deliberately does not
  // await, and that upgrade is a uv or pipx environment being rewritten for
  // tens of seconds after this job has returned. upgradeSettled() is the handle
  // on it, and null when nothing was started.
  //
  // Not markDeckReady, the other place "the boot is over" gets said:
  // reportStartup stops waiting for claude-swap the moment the install
  // announces itself, so the deck is marked ready with the install still
  // running. Never rejects — a job that failed has nothing left running.
  const cswapQuiet = cswap.then(async () => {
    if (!wantClaude) return;
    const { upgradeSettled } = await import(pathToFileURL(join(PKG_ROOT, "src/server/cswap-install.mjs")).href);
    await upgradeSettled();
  }).catch(() => {});

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

  // An older deck's Codex forwarders, looked for and never touched — see
  // leftoverCodexHooks for why a boot names them rather than removing them.
  // Asked with --no-codex too: the entries fire whether or not this deck is
  // watching the rollouts, and one file read is the whole cost.
  const codexHooks = leftoverCodexHooks().catch(() => null);

  return { hooks, cswap, cswapInstalling, cswapQuiet, ccusage, update, codexHooks };
}

/** The same work, said out loud, in a fixed order — a boot whose rows arrive in
 *  whatever order the network settled is a boot nobody can scan twice. */
export async function reportStartup(jobs, { workspace, wantClaude, wantCodex, CODEX_SESSIONS_DIR }) {
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

  // #983. A machine that ran a deck from before #253 still has that deck's
  // forwarders in Codex's hooks.json, and nothing but `--uninstall` ever looked.
  // Where Codex honours the file, each one posts the session to /api/event while
  // the watcher above reads the same session off disk, so it arrives twice. Both
  // copies go into the ring and events.jsonl; the reducer's two-second
  // redelivery windows fold some of them on the card and not others, and a
  // duplicate that shows only sometimes reads as a reducer bug, which is where
  // it would otherwise be chased. Saying nothing was the one answer the issue
  // ruled out. So: one row, in the place the deck already talks about Codex,
  // naming the file and the command. `keep`, because a remedy cut off by an
  // ellipsis is no remedy. The clause about arriving twice is said only while
  // the watcher runs, since without it the forwarders are the only copy.
  const leftover = await jobs.codexHooks;
  if (leftover) {
    const twice = wantCodex ? ", so Codex sessions can arrive twice" : "";
    write(row({
      mark: G.warn, tone: P.warn, label: "Codex hooks", keep: true,
      detail: `left by an older deck in ${fileLink(leftover.settingsPath)}${twice} ${G.dash} \`${INVOKED_AS ?? PRODUCT} --uninstall\` takes them out`,
    }));
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
  if (swapWait.done) writeSwapRows(swapWait.value, { wantClaude });
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
      late => { pulseBusy = null; writeSwapRows(late, { wantClaude, late: true }); },
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
function writeSwapRows(swap, { wantClaude, late = false }) {
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
        // The deck asked for one version and a different one answered, so it
        // declines to drive it. Naming both is the whole content of the row:
        // "install failed" would be a lie about an install that succeeded, and
        // the number that arrived is the thing a person needs to see.
        : cs?.reason === "unexpected_version"
          ? `refused v${cs.version} ${G.dash} asked for ${cs.want}, not driving it`
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
 * the port and the session. The deck already holds that position once, in the
 * `--all` flag: a flag the deck stopped needing is still accepted rather than
 * made fatal.
 *
 * So it goes where the deck puts everything else it decided on your behalf —
 * the startup report — and it goes at the END of it. reportStartup writes its
 * rows in a fixed order and three more land underneath them (the server, the
 * log, the browser), so a warning printed among those rows is a warning the
 * rows scroll over. Here it is the last line before the pulse indicator takes
 * the bottom of the screen and stops repainting anything above it.
 */
export function reportUnknownFlags(unknown) {
  for (const token of unknown) {
    write(row({
      mark: G.warn, tone: P.warn, label: "unknown option",
      detail: `${token} ${G.dash} see \`${INVOKED_AS ?? PRODUCT} --help\``,
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
export function reportIncompleteFlags(incomplete) {
  for (const { flag, expects } of incomplete ?? []) {
    write(row({
      mark: G.warn, tone: P.warn, label: "missing value",
      detail: `${flag} ${G.dash} expected ${expects}; using the default`,
    }));
  }
}

/**
 * The one line a respawn prints instead of the whole report — the same session
 * continuing — and the flag rows, which it does not skip.
 */
export function reportRestarted({ url, flags }) {
  write(`  ${P.ok}${G.restart}${P.reset}  ${P.muted}restarted ${G.arrow} ${P.reset}v${PKG_VERSION}${P.muted} ${G.bullet} ${link(url, url, LINKS)}${P.reset}\n`);
  // A respawn skips the whole startup report, but not this: the argv is the
  // same argv, the typo in it is still there, and a deck that mentioned it once
  // and then went quiet for every restart afterwards is back to hiding it from
  // anyone who was not watching the first boot.
  reportUnknownFlags(flags.unknown);
  reportIncompleteFlags(flags.incomplete);
}

/**
 * The end of the startup report, once the port is bound: the server and log
 * rows, the flag rows under them, the way back, and whether a browser opens.
 */
export function reportReady({ url, persist, openBrowser, flags }) {
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
  // AFTER the warnings and outside the rows, because it is neither. It is the
  // one thing on this screen that is about next week rather than about this
  // boot — see way-back.mjs — and putting it above a typo warning would be
  // spending the reader's last line of attention on the calmer of the two.
  write(`\n  ${P.muted}${G.dash}  ${wayBackNote({
    command: INVOKED_AS ?? PRODUCT, dash: G.dash, columns: cols(),
  })}${P.reset}\n`);
  // Only when one is actually being opened. Under --no-open — which is how an
  // npx update relaunches, with a tab already waiting — this was announcing
  // something that never happened.
  if (openBrowser) write(`\n  ${P.ok}${P.bold}${G.play}  opening browser${G.ellipsis}${P.reset}\n\n`);
  else write("\n");
}
