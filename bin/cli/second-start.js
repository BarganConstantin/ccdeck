// A second start, settled: attach to the deck that is already up, yield to one
// that came up while this one was coming back, or stop what this start
// replaces and go on.
//
// A bare `ccdeck` typed beside a deck that is already running used to build a
// second everything on a random port, and neither half mentioned the other.
// Then it attached only to a deck of exactly its own shape and built a second
// one beside anything else — a different flag, an older version, or a login
// item whose environment decided `codex` or the log path differently from the
// shell's. src/server/running-deck.mjs carries the whole argument, the registry
// read, the handshake and the rule; this is where the answer is acted on, and
// bin/deck.js is where — and when — it is asked.
//
// A RESPAWN IS ASKED TOO, and answers differently. A restart is THIS deck
// coming back, so there is nothing to attach to — but in the gap a crash
// leaves, a `ccdeck` typed by hand finds no deck and starts one, and the
// respawn that followed used to take a random port beside it. Now it finds
// that deck and exits 0, and the supervisor, reading a clean exit, ends too.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isPortValue } from "../../src/server/args.mjs";
import { PRODUCT } from "../../src/server/brand.mjs";
import { liveDecks, olderVersion, secondStart, versionNote } from "../../src/server/running-deck.mjs";
import { link } from "../../src/server/term.mjs";
import { COMMAND, PKG_ROOT, PKG_VERSION } from "./package.js";
import { G, LINKS, P, sleep, write } from "./screen.js";
import { reportIncompleteFlags, reportUnknownFlags } from "./startup.js";

/**
 * Ask the rule, and do what it says. Resolves to the exit code when this start
 * ends here — a yield, or an attach — having said why, and to null when it is
 * to go on and boot. Nothing here exits the process: bin/deck.js does, so every
 * way out is one its exit handlers already cover (#980).
 */
export async function settleSecondStart({ flags, workspace, persist, wantCodex, wantClaude, codexHome, codexHomes, openBrowser, RESPAWN }) {
  // `--port` alone, not AGENT_DAG_PORT: the variable is how somebody RUNS a
  // deck rather than which one they mean — the line `--stop` draws in
  // bin/cli/one-shot.js.
  const askedPort = flags.port != null && isPortValue(flags.port) ? Number(flags.port) : null;
  const plan = secondStart({
    live: await liveDecks().catch(() => []),
    want: { workspace, persist, codex: wantCodex, claude: wantClaude, codexHome, codexHomes },
    port: askedPort,
    ours: PKG_VERSION,
    fresh: flags.new === true,
    respawn: RESPAWN,
    atLogin: flags.atLogin === true,
  });
  if (plan.act === "yield") {
    console.error(`${PRODUCT}: a deck started on ${plan.deck.port} while this one was coming back ${G.dash} leaving it to that one.`);
    return 0;
  }
  // THE NEWEST START WINS. What is stopped here is either the deck this start
  // replaces or, on an attach, a second deck left over from before this rule —
  // the duplicate the rule exists to end. Each one is said, with why, because a
  // deck that vanishes without a word is a mystery of its own.
  if (plan.stop.length) {
    const { stopDeck } = await import(pathToFileURL(join(PKG_ROOT, "src/server/stop-deck.mjs")).href);
    for (const d of plan.stop) {
      const why = plan.act === "replace" && flags.new === true
        ? "you asked for a fresh one"
        : olderVersion(d.version, PKG_VERSION)
          ? (d.version ? `it was v${d.version}` : "it was an older version")
          : plan.act === "attach" ? "it was a second deck" : "it was started with different settings";
      const out = await stopDeck(d).catch(() => ({ ok: false, reason: "unreachable" }));
      write(out.ok
        ? `\n  ${P.ok}${G.ok}${P.reset}  stopped the deck on ${d.port}${P.muted}  ${G.bullet}  pid ${d.pid}  ${G.bullet}  ${why}${P.reset}\n`
        : `\n  ${P.warn}${G.warn}  could not stop the deck on ${d.port} (pid ${d.pid}) ${G.dash} ${out.reason ?? out.how}${P.reset}\n`);
    }
  }
  if (plan.act === "attach") {
    const live = plan.deck;
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
    // The gate used to answer `true` for these two so the report would
    // run and print them, and that is how `ccdeck --stpo` — a misspelling of
    // the flag that STOPS a deck — came to build a second one. The warning was
    // the requirement; the extra process never was. Printed here, in the same
    // rows the report uses, so nothing is lost and nothing is started.
    reportUnknownFlags(flags.unknown);
    reportIncompleteFlags(flags.incomplete);
    // The line that says a second deck was NOT started. Without it the command
    // looks like it did nothing at all, which is the other way to be confusing
    // about this — and it names the flag for the person who wanted a fresh one.
    write(`\n  ${P.muted}${G.dash}  no second deck was started ${G.dash} \`${COMMAND} --new\` replaces it with a fresh one${P.reset}\n`);
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
    return 0;
  }
  return null;
}
