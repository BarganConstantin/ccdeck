// The restart latch: one restart at a time, held until the boot can take it,
// and let go of on every way it can fail.
//
// Lifted out of bin/deck.js. The latch is the only state here, and the two
// things it acts through are handed in rather than reached for: `shutdown`,
// deck.js's own way out, which a restart ends in, and `releaseRestart`, the
// server's half of the same latch. What comes back is requestRestart, for
// startServer's onRestart, and the two calls deck.js makes when its boot ends.
import { oneLine } from "../../src/server/term.mjs";
import { RESTART_CODE, UPGRADE_CODE } from "../../src/server/supervisor.mjs";
import { PKG_VERSION, versionOnDisk } from "./package.js";
import { G, P, cols, write } from "./screen.js";

/**
 * Arm the latch, and the supervisor's answer to an upgrade with it. Called once,
 * before the server can take a request.
 */
export function restartLatch({ shutdown, releaseRestart }) {
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

  // Whether the boot has finished: markBooted, called by deck.js at its end.
  //
  // The server starts accepting connections from inside startServer, before
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
      // What a restart would land on. Read from disk now rather than remembered
      // from boot, because the whole point is that the two differ.
      const to = versionOnDisk();
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
  // Both halves of the latch have to come down — this one's and the server's —
  // because a latch nothing clears is precisely how one failed request turned
  // into a deck that refused every restart afterwards while answering "ok" to
  // each one (#448). The reason is folded onto one line by oneLine: the terminal
  // under this is repainted every 800ms by the pulse, and a stack written into
  // that is a stack nobody can read (#432).
  //
  // A declaration rather than a const, like deck.js's `shutdown` and for the same
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

  /** The boot is over, so an ask that arrives from now on is run, not held. */
  const markBooted = () => { booted = true; };
  return { requestRestart, markBooted, runHeldRestart };
}
