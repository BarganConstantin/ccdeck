// Running an external command the same way on Linux, macOS and Windows.
//
// On POSIX, `spawn("cswap", …)` finds cswap on PATH. On Windows it does not:
// the thing on PATH is `cswap.exe` or a `cswap.cmd` shim, and Node only
// applies PATHEXT when it goes through a shell. So the naive call fails with
// ENOENT on Windows even though the tool is installed and on PATH — which
// looks exactly like "not installed" and is why this is worth a module.
//
// Resolving the extension ourselves keeps the argument vector intact, which
// blanket `shell: true` would not: it concatenates arguments into a command
// line, so an argument containing a quote or an ampersand stops being an
// argument.
//
// The exception is .cmd and .bat, which since Node 20.12 CANNOT be spawned
// without a shell at all — the fix for CVE-2024-27980 makes that throw EINVAL,
// synchronously, from inside execFile. Those are routed through cmd.exe the
// same way Node's own `shell: true` does it, with the arguments quoted here
// rather than pasted together. Getting this wrong is not a degraded feature:
// the throw escaped the retry path and took the whole process down on Windows
// before the server ever started.
//
// Going through cmd.exe then raises a question a direct spawn never has to ask:
// under what NAME. A `.cmd` shim finds its own payload relative to `%~dp0`, so a
// bare name — which carries no directory — makes it look under the deck's
// working directory instead of its own. Every batch candidate is therefore
// launched by its full path where one can be found; see shimPath and
// candidateSpec.
import { execFile, spawn } from "node:child_process";
// Which spelling of a command to try, whether it goes through cmd.exe, and the
// exact file, argv and options spawn is handed for it — all of it decided
// before anything is spawned, and all of it platform-parameterised so the
// Windows answer can be tested anywhere.
import { candidateSpec, candidates, isBatch, rememberSpelling } from "./exec-spec.mjs";
export {
  candidateSpec, candidates, isBatch, pathLookup, shellQuoteArg, shimPath, spawnSpec, viaCmd,
} from "./exec-spec.mjs";
// Reading cmd.exe's "is not recognized" — which decides whether the candidate
// loop moves on and whether the answer is ENOENT — is a question about text and
// has a module of its own. Re-exported, so its callers need not know that.
import { looksMissing } from "./exec-not-found.mjs";
export { looksMissing, notFoundExit } from "./exec-not-found.mjs";
// Stopping a child and everything under it, and the set of children still
// running that shutdown reaps. `run` and `runInteractive` wrap their children
// in watchChild; `runDetached` deliberately does not, for the reason the note
// on `live` gives.
import { killTree, watchChild } from "./exec-children.mjs";
export { killLiveChildren, killTree, liveChildPids } from "./exec-children.mjs";

// WINDOWS SEARCHES THE WORKING DIRECTORY FIRST, and this turns that off.
//
// libuv's PATH search calls `NeedCurrentDirectoryForExePathW("")`, which is
// true unless this variable is set — so `spawn("cswap", …)` on Windows tries
// `.\cswap.exe` before anything on PATH, and the deck's working directory is
// wherever `npx ccdeck` was run: normally the user's project, often a repo they
// just cloned. `cswapBin()` probes the bare name before any known install path
// and memoises whatever answered, so a planted binary would then receive every
// later `cswap switch` and `cswap export -` — the commands that carry account
// credentials. The same search reaches py.exe, where.exe, claude.exe and
// powershell.exe.
//
// Set on this process rather than per spawn, because the search is done by the
// PARENT: one assignment covers every child this deck ever starts, including
// the ones spawned outside this module. An explicit value in the environment is
// left alone — someone who set it meant it.
//
// POSIX never had this behaviour: execvp does not search `.` unless PATH says
// so, so this is a no-op there and is skipped rather than written.
if (process.platform === "win32" && !("NoDefaultCurrentDirectoryInExePath" in process.env)) {
  process.env.NoDefaultCurrentDirectoryInExePath = "1";
}

// Reasons to try the next candidate spelling rather than give up. EINVAL and
// UNKNOWN show up on Windows for a file that exists but cannot be executed the
// way it was asked for; both mean "not this one", not "no such tool".
export const tryNext = (err) =>
  Boolean(err) && (err.code === "ENOENT" || err.code === "EACCES" ||
                   err.code === "EINVAL" || err.code === "UNKNOWN");

// How much of a hung child's output the deadline keeps. The full buffers belong
// to execFile's callback, which a timed-out run never waits for, and the tail is
// where a tool puts the line that explains itself.
const TIMEOUT_TAIL = 8 << 10;

/**
 * Run a command and collect its output. Never rejects, and never throws —
 * failures come back as `{ ok: false }`, because every caller here is a poll or
 * a UI action where a missing tool is an expected state rather than an
 * exception. execFile can throw synchronously on Windows, so the call itself is
 * guarded as well as its callback.
 *
 * A run stopped by its deadline answers `{ ok: false, code: "ETIMEDOUT",
 * killed: true, timedOut: true }` — never ok, whatever the child said on its
 * way out.
 *
 * `env` replaces the child's environment wholesale, the way spawn's does; pass
 * `{...process.env, X: "1"}` to add to it. It exists because the quota probe
 * runs a whole Claude Code and has to mark the run as the deck's own, and that
 * marker is what stops every poll drawing itself onto the canvas.
 */
export function run(cmd, args, { timeout = 20_000, maxBuffer = 4 << 20, env } = {}) {
  const tries = candidates(cmd);
  return new Promise((resolve) => {
    const attempt = (i) => {
      if (i >= tries.length) {
        return resolve({ ok: false, code: "ENOENT", killed: false, timedOut: false, stdout: "", stderr: "" });
      }
      const raw = tries[i];
      // `launch` is what cmd.exe is handed and `raw` is what the loop is
      // reasoning about; on Windows those differ for a batch candidate whose
      // shim was found (#457) and are the same everywhere else.
      const { file, args: argv, opts, launch } = candidateSpec(raw, args);

      const tree = isBatch(raw);
      let timer = null, timedOut = false;
      // A tail of what the child managed to say. The deadline below answers
      // before execFile's callback does, and the callback owns the full
      // buffers, so without this copy a timed-out run reports nothing at all —
      // and the last line a hung tool printed is usually the only clue why it
      // hung.
      let sawOut = "", sawErr = "";

      const done = (err, stdout, stderr) => {
        clearTimeout(timer);
        // The deadline already gave this attempt its verdict, and killed the
        // child to make it stop. What the corpse reports is not news, and
        // believing it is what put "cswap export exited 0" in front of the
        // user: execFile calls a signalled exit `code: null`, which `?? 0`
        // turns into a success code, and a tool that handles SIGTERM by
        // exiting 0 — the well-behaved kind — arrives here with no error at
        // all, so the run we cut short came back `ok: true` and got its
        // spelling remembered as one that works.
        if (timedOut) return;
        // cmd.exe's "is not recognized" counts as "not this spelling" too, and
        // it arrives as a normal non-zero exit rather than a spawn error. Only
        // a batch candidate goes through a shell, so only there can the output
        // be a shell's verdict rather than the tool's own words — spawned
        // directly, a missing file is a plain ENOENT and anything printed came
        // from a tool that ran.
        // `err.code` is the exit STATUS for a child that ran and failed, which
        // is where cmd.exe's language-independent 9009 arrives; for a spawn
        // failure it is an errno string, and Number() of that is NaN. Either
        // way looksMissing is handed what the attempt actually reported.
        const missing = Boolean(err) && tree && looksMissing(`${stderr ?? ""}\n${stdout ?? ""}`, launch, err.code);
        if (err && (tryNext(err) || missing) && i + 1 < tries.length) return attempt(i + 1);
        // The CANDIDATE is what gets remembered, never the resolved path. The
        // memo is the only entry `candidates` offers afterwards, so recording an
        // absolute path would pin this process to one install location for its
        // whole life — an upgrade that moves the shim would then fail forever
        // where today it simply gets found again. Re-running the lookup per
        // attempt costs a handful of stats against a process spawn.
        if (!err) rememberSpelling(cmd, raw);
        resolve({
          ok: !err,
          // A tool cmd.exe could not find is missing, not "exited 1" — callers
          // key their message off this.
          code: missing ? "ENOENT" : (err?.code ?? 0),
          killed: Boolean(err?.killed),
          timedOut: false,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        });
      };

      try {
        // watchChild: this run's deadline lives in the timer below, in THIS
        // process, so a shutdown that does not reap it leaves the child with
        // no deadline at all. See `live` in exec-children.mjs, and #1012.
        const cp = watchChild(execFile(file, argv,
          { timeout: 0, shell: false, windowsHide: true, maxBuffer, ...(env ? { env } : {}), ...opts }, done));
        // Give the child EOF on stdin straight away, which is what this
        // function's contract has always claimed ("run closes stdin", says
        // runInteractive's header) and what execFile does not do: it leaves the
        // pipe open with nobody at the writing end, so a tool that reads stdin
        // waits for a writer that will never arrive. `claude --print /usage`
        // waits three seconds for exactly that before giving up, which is why
        // the shell command it replaced had to end in `< /dev/null`. Closing
        // the pipe is that redirection without a shell to parse it.
        try { cp.stdin?.on("error", () => {}); cp.stdin?.end(); } catch { /* no stdin to close */ }
        // Decoded as a stream rather than per chunk: a chunk boundary falls
        // wherever the pipe broke, and a multi-byte character split across two
        // of them becomes two replacement characters in the tail this keeps for
        // the timeout message.
        cp.stdout?.setEncoding?.("utf8");
        cp.stderr?.setEncoding?.("utf8");
        cp.stdout?.on("data", (d) => { sawOut = (sawOut + d).slice(-TIMEOUT_TAIL); });
        cp.stderr?.on("data", (d) => { sawErr = (sawErr + d).slice(-TIMEOUT_TAIL); });
        // The deadline states the outcome itself and only then kills, which is
        // the order startUpgrade needs for the same reason: the answer must not
        // depend on the killed child cooperating.
        //
        // execFile's own `timeout` is not used at all. It ends with one signal
        // to the process it started, which for a batch candidate is the cmd.exe
        // wrapper — the deadline was reported as enforced while the tool
        // underneath went on running — and it reports through the callback,
        // which waits for the stdio pipes. On Windows those are held by the
        // grandchild under the wrapper, so when the tree kill could not reach
        // it the callback never came and the run never settled at all: the
        // accounts panel sat on a request that had already timed out.
        timer = setTimeout(() => {
          timedOut = true;
          resolve({ ok: false, code: "ETIMEDOUT", killed: true, timedOut: true, stdout: sawOut, stderr: sawErr });
          killTree(cp);
        }, timeout);
        timer.unref?.();
      } catch (err) {
        // Synchronous throw — the EINVAL case. Same handling as a callback
        // error; letting it propagate here is what crashed the server, because
        // this runs inside the previous attempt's error handler.
        done(err, "", "");
      }
    };
    attempt(0);
  });
}

/**
 * Run a command whose stdin stays open, so the caller can answer it.
 *
 * `run` above closes stdin and waits for the end; that is right for everything
 * that only reports. It is useless for the two commands the accounts panel has
 * to drive: `claude auth login` prints a URL and then blocks reading the code
 * the user pastes back, and `cswap remove` blocks on its own `[y/N]` — there is
 * no `--yes` flag to avoid it. Both need a child that outlives one request and
 * can be written to.
 *
 * Returns immediately with a handle:
 *   write(text)  — into the child's stdin
 *   kill()       — give up; `done` settles within killGrace either way
 *   onLine(cb)   — every complete stdout/stderr line as it arrives
 *   done         — Promise<{ok, code, killed, timedOut, stdout, stderr}>
 *
 * Never rejects, for the same reason `run` never does. And never stays pending:
 * the deadline answers with `code: "ETIMEDOUT", timedOut: true` at the moment
 * it expires rather than waiting on a 'close' a surviving descendant can hold
 * back forever — see the timer below, and #614 for what that cost. Same Windows
 * candidate resolution, since `claude` and `cswap` are `.cmd` shims there.
 */
export function runInteractive(cmd, args, { timeout = 300_000, maxOutput = 256 << 10, killGrace = 2_000 } = {}) {
  const tries = candidates(cmd);
  const lineSubs = [];
  let child = null;
  // Every stdout/stderr chunk goes through here to the `onLine` subscribers.
  const lines = lineFeed(lineSubs);
  let stdout = "", stderr = "";
  let timedOut = false, killed = false;
  let settle;
  const done = new Promise((resolve) => { settle = resolve; });

  let graceTimer = null;

  const finish = (code, err) => {
    if (!settle) return;
    const s = settle; settle = null;
    clearTimeout(timer);
    clearTimeout(graceTimer);
    // `!killed`, and it was missing (#787). A tool that handles SIGTERM by
    // exiting 0 — the well-behaved kind, which `run`'s own header names — came
    // back `{ ok: true, killed: true }`, and a caller reading `ok` could not
    // tell a clean run from one it had just cancelled. `claude auth login` is
    // exactly that shape: it traps SIGTERM to restore the terminal.
    //
    // What that cost: pressing Escape during a sign-in killed the child, and
    // spawnLogin's handler then saw `r.ok` true and ran `registerSignedIn` — a
    // `cswap add` for the account the user had just cancelled, racing
    // cancelLogin's own restore, with the dialog flipping to `done`.
    //
    // The memo guard eleven lines below already distrusted a kill for the same
    // reason (`if (code === 0 && !killed && !timedOut)`), so the two halves of
    // this function disagreed about what a killed exit means.
    s({ ok: code === 0 && !err && !timedOut && !killed, code: err?.code ?? code ?? -1, killed, timedOut, stdout, stderr });
  };

  // The deadline states the outcome and only then kills — the order `run` uses
  // forty lines above, for the reason its own header already spells out.
  //
  // This used to set the flag, kill, and leave `done` to the child's 'close'.
  // 'close' waits for the stdio pipes, not merely for the exit, so ONE
  // descendant that outlives the kill holding the inherited stdout keeps it
  // from ever arriving: the child is dead, the promise is pending, and it stays
  // pending for the life of the process. On Windows that is the ordinary shape
  // rather than a corner — a `.cmd` shim runs the real tool as a grandchild
  // under cmd.exe, so a taskkill that cannot run reaches only the wrapper — and
  // on macOS/Linux any cswap subprocess still alive when SIGTERM lands does it.
  //
  // What it cost: both callers await this INSIDE withStoreLock, so the pending
  // promise is the accounts mutex. Every later mutation — login, cancel,
  // import, remove, alias, reorder — queued behind a link that would never
  // settle, the HTTP request was never answered, and spawnLogin's
  // process-on-exit handler leaked with the promise. Reported as #614.
  const timer = setTimeout(() => {
    timedOut = true;
    killed = true;
    // Whatever the child managed to print rides along, the way run()'s tail
    // does: it had not finished, but it is all a caller has to go on.
    finish(-1, { code: "ETIMEDOUT" });
    killTree(child);
  }, timeout);
  timer.unref?.();

  const attempt = (i) => {
    if (i >= tries.length) return finish(-1, { code: "ENOENT" });
    const raw = tries[i];
    // Same split as in `run`: `launch` is the spelling cmd.exe receives — an
    // absolute `.cmd` once shimPath can see one — and `raw` stays the candidate
    // the loop and the memo are about.
    const { file, args: argv, opts, launch } = candidateSpec(raw, args);
    let proc;
    try {
      // Tracked for the same reason `run`'s child is, and with more at stake:
      // this one's deadline is five minutes and it is a `claude auth login`
      // blocked on a stdin pipe only this process holds. See `live` in
      // exec-children.mjs.
      proc = watchChild(spawn(file, argv, { stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true, ...opts }));
    } catch (err) {
      return tryNext(err) ? attempt(i + 1) : finish(-1, err);
    }
    child = proc;
    // EPIPE ON STDIN IS NOT A CRASH. `write` below is wrapped in a try/catch,
    // and that catch can never fire for the case that matters: a broken pipe
    // arrives asynchronously, as an 'error' event on the Writable, and an
    // unhandled 'error' on a stream is an uncaught exception with no
    // process-level net anywhere in this deck. `cswap import -` reading a
    // prefix of a bad bundle and exiting before it drains is exactly that
    // shape, so a rejected paste in the import dialog took the dashboard down
    // with it. `run` has carried this same line since it was written.
    proc.stdin?.on("error", () => {});
    // A spelling that fails to spawn emits 'error' AND THEN 'close' — with code
    // -2 after an ENOENT. Once the error handler has moved on to the next
    // candidate, that trailing 'close' is news about a child nobody is waiting
    // for any more, and answering it settled `done` with ok:false while the
    // real child was still running. On Windows that is the normal path, not a
    // corner case: `claude.exe` does not exist, `claude.cmd` does, so the very
    // first login reported "the code was not accepted" while the child it had
    // abandoned went on to complete the OAuth and switch the live account.
    // Every listener below therefore speaks only while its own child is the
    // current one.
    const stale = () => proc !== child;
    proc.on("error", (err) => {
      if (stale()) return;
      // Only retry another spelling while nothing has run yet; a mid-run error
      // is this child's failure, not evidence the name was wrong.
      if (tryNext(err) && !stdout && !stderr) { child = null; return attempt(i + 1); }
      finish(-1, err);
    });
    // Spawning proves a spelling exists — except a .cmd/.bat one, which is
    // launched THROUGH cmd.exe. cmd.exe is always there, so it spawns just as
    // happily for a batch file that is not, and only says so later by exiting
    // non-zero with "is not recognized". Caching at spawn time therefore
    // remembered a spelling that never existed, and since `candidates` then
    // offers only the remembered one, the tool stayed unrunnable — with the
    // false message "not on PATH" — even after it was installed. A batch
    // spelling is confirmed by the clean exit below instead, which is the rule
    // `run` already applies with `if (!err)`.
    if (!isBatch(raw)) proc.on("spawn", () => rememberSpelling(cmd, raw));
    // Capped so a runaway child cannot grow the heap without bound; the tail is
    // what carries the error, so the head is what gets dropped.
    const keep = (buf, text) => (buf + text).slice(-maxOutput);
    // Same reason as `run`'s tails: the login prompt this reader is waiting for
    // arrives mid-chunk, and a UTF-8 sequence cut by a pipe boundary must not
    // become two replacement characters in the line it emits.
    proc.stdout?.setEncoding?.("utf8");
    proc.stderr?.setEncoding?.("utf8");
    proc.stdout?.on("data", (d) => { if (stale()) return; const t = String(d); stdout = keep(stdout, t); lines.push(t); });
    proc.stderr?.on("data", (d) => { if (stale()) return; const t = String(d); stderr = keep(stderr, t); lines.push(t); });
    proc.on("close", (code) => {
      if (stale()) return;
      // Already answered — by the deadline above, or by kill()'s grace below.
      // A late 'close' has nothing left to report, and this is not merely
      // tidiness: the retry underneath re-runs the WHOLE command, and re-running
      // `cswap remove` on behalf of a promise nobody is waiting for any more is
      // exactly the thing that must not happen.
      if (!settle) return;
      // Same cmd.exe case as in `run`: exit 1 with "is not recognized" means
      // this spelling does not exist, not that the tool failed. Restricted to a
      // batch candidate, which is the only kind launched through a shell, and
      // to output that is cmd.exe's message alone — everything below re-runs
      // the whole command, and these commands remove accounts.
      if (code !== 0 && isBatch(raw) && looksMissing(`${stderr}\n${stdout}`, launch, code)) {
        if (i + 1 < tries.length) {
          stdout = ""; stderr = ""; lines.reset();
          child = null;
          return attempt(i + 1);
        }
        return finish(-1, { code: "ENOENT" });
      }
      // Ran to a clean exit, so this spelling is real — the only confirmation a
      // batch one ever gets.
      if (code === 0 && !killed && !timedOut) rememberSpelling(cmd, raw);
      finish(code ?? -1, null);
    });
  };
  attempt(0);

  return {
    write(text) {
      try { child?.stdin?.write(text); } catch { /* the child is gone; `done` says so */ }
    },
    /** Close stdin. A command that reads to EOF (`cswap import -`) needs this
     *  to start work at all; a prompting one must never see it. */
    end() {
      try { child?.stdin?.end(); } catch { /* already closed */ }
    },
    /** Stop the run. On Windows that means the tool under the cmd.exe wrapper
     *  too — see killTree; a cancelled sign-in used to leave it running.
     *
     *  `done` settles either way. The kill cannot promise the pipes close —
     *  that is the deadline's problem reached from the other side — so if the
     *  child's own 'close' has not arrived within killGrace, the handle answers
     *  without it. A cancelled sign-in must not be able to wedge the accounts
     *  mutex any more than an expired one. */
    kill() {
      killed = true;
      killTree(child);
      if (settle && !graceTimer) {
        graceTimer = setTimeout(() => finish(-1, null), killGrace);
        graceTimer.unref?.();
      }
    },
    onLine(cb) { lineSubs.push(cb); },
    done,
  };
}

/**
 * Cut a child's output into lines for `subs`, as it arrives.
 *
 * Subscribers get `(text, partial)`. A subscriber must not throw and must
 * tolerate repeats: `partial` is the still-unterminated tail, re-offered as
 * it grows, because a prompt is written WITHOUT a newline —
 * "Paste code here if prompted > " never terminates a line, so a
 * newline-only reader would wait for it forever.
 *
 * `subs` is read at every push rather than copied, so a subscriber added
 * after the child started hears everything from then on. `reset` drops the
 * carried tail, for a retry that starts the output over under the next
 * spelling.
 *
 * Exported for its test, and for the three fakes in the suite that stand in
 * for runInteractive and cut their output with it rather than with a copy of
 * the rule — so it is pinned by running it rather than by reading it.
 */
export function lineFeed(subs) {
  let pending = "";           // partial line carried between chunks
  return {
    push(text) {
      pending += text;
      let nl;
      while ((nl = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, nl).replace(/\r$/, "");
        pending = pending.slice(nl + 1);
        for (const cb of subs) { try { cb(line, false); } catch { /* a subscriber must not kill the child */ } }
      }
      if (pending) {
        for (const cb of subs) { try { cb(pending, true); } catch { /* ignore */ } }
      }
    },
    reset() { pending = ""; },
  };
}

/**
 * Start a command and don't wait for it. Same resolution, no output captured.
 * Used where the result lands somewhere else — a file the next poll reads, or
 * a sound the user hears.
 */
export function runDetached(cmd, args) {
  const tries = candidates(cmd);
  const attempt = (i) => {
    if (i >= tries.length) return;
    const raw = tries[i];
    // Nothing here reads output, so there is no looksMissing call to keep
    // honest — but the shim still has to be launched by its full path, or the
    // detached `cswap list` this exists for computes `%~dp0` from the deck's cwd
    // exactly like every other caller.
    const { file, args: argv, opts } = candidateSpec(raw, args);
    try {
      const child = spawn(file, argv, { stdio: "ignore", shell: false, windowsHide: true, ...opts });
      child.on("error", (err) => { if (tryNext(err)) attempt(i + 1); });
      // Same trap as above: a batch spelling is spawned through cmd.exe, which
      // succeeds whether or not the batch file is there, so only a clean exit
      // proves this one is worth remembering.
      if (isBatch(raw)) child.on("exit", (code) => { if (code === 0) rememberSpelling(cmd, raw); });
      else child.on("spawn", () => rememberSpelling(cmd, raw));
      child.unref?.();
    } catch {
      attempt(i + 1);
    }
  };
  attempt(0);
}
