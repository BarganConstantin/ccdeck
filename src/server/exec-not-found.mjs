// Whether a batch candidate's output is cmd.exe saying "no such command".
//
// A `.cmd` or `.bat` is launched THROUGH cmd.exe (see viaCmd in exec.mjs),
// and cmd.exe is always there — so a missing tool is not a spawn error at all.
// It is a healthy shell exiting non-zero after printing a sentence, and telling
// that sentence apart from a tool that ran and failed is the whole of what this
// module does. It decides two things for exec.mjs's candidate loop: whether to
// try the next spelling, and whether to answer `code: "ENOENT"` — and the first
// of those re-runs the entire command, which for `cswap remove 3` is not a
// retry anybody wants made on a guess.
//
// A module of its own because it is pure: text and an exit status in, a verdict
// out, no process and no filesystem. exec.mjs re-exports both names, so every
// caller that imported them from there still does.
// The three lines an ENGLISH cmd.exe prints when it cannot find what it was
// asked to run, anchored to a whole line each. First the two-line pair for a
// bare name, then the one it uses when a directory in an explicit path does not
// exist.
//
// These are one signal out of three rather than the whole answer — see
// looksMissing. Windows ships cmd.exe in every language it ships in, and these
// sentences are translated with it.
const CMD_UNKNOWN = /^'(.+)' is not recognized as an internal or external command,?$/i;
const CMD_UNKNOWN_TAIL = /^operable program or batch file\.?$/i;
const CMD_NO_PATH = /^the system cannot find the (?:path|file) specified\.?$/i;

// cmd.exe's own errorlevel for a command token it could not resolve — the one
// signal here that is not a human sentence, and therefore the only one that is
// the same on a German install as on an English one. It is the number every CI
// log in the world prints beside "is not recognized".
//
// Not every path reports it: some Windows builds answer a bare `cmd /c missing`
// with a plain 1 instead, which is why this is a sufficient signal and never a
// necessary one. A number this large cannot arrive from POSIX at all — a process
// exit status there is masked to 0-255 before Node ever sees it — so nothing
// outside cmd.exe can reach it by accident.
const CMD_NOT_FOUND_EXIT = 9009;

/** True when an exit status is cmd.exe saying "no such command", in any locale. */
export const notFoundExit = (code) => Number(code) === CMD_NOT_FOUND_EXIT;

// Every run of text this line wrapped in quotes. cmd.exe quotes the command
// token it could not find in EVERY locale, and the quote character is the only
// part of the message that is not a translation: `'…'` in English and French,
// `"…"` in German, Spanish, Italian, Portuguese, Polish and Russian.
const quotedRuns = (line) =>
  [...String(line).matchAll(/'([^']+)'|"([^"]+)"/g)].map(m => m[1] ?? m[2]);

// cmd.exe echoes the command token exactly as it was given, so an exact match
// is what we expect; the comparison is only case- and quote-insensitive because
// Windows paths are.
const sameCommand = (quoted, name) => {
  const norm = (s) => String(s).trim().replace(/^"+|"+$/g, "").toLowerCase();
  return norm(quoted) === norm(name);
};

/**
 * cmd.exe's way of saying ENOENT — and only cmd.exe's.
 *
 * A .cmd or .bat candidate is launched THROUGH cmd.exe, and cmd.exe exists — so
 * a missing tool is not a spawn error at all. It is a healthy shell exiting 1
 * after printing two lines:
 *
 *     'cswap' is not recognized as an internal or external command,
 *     operable program or batch file.
 *
 * Read as a real failure, that stops the candidate loop early AND puts the
 * second line — on its own, meaningless — in front of the user. Reported from
 * Windows on 2026-08-14: the accounts panel said only "operable program or
 * batch file." when sharing an account.
 *
 * The fussiness is about the other direction, which is worse. "The system
 * cannot find the file specified" is Windows' generic text for ENOENT, and it
 * appears INSIDE the output of tools that ran perfectly well — cswap is a
 * Python CLI, and a FileNotFoundError traceback ends in that exact sentence.
 * Believed there, it threw the real error away, told the user the tool was not
 * on PATH when PATH was fine, and — the dangerous half — sent the candidate
 * loop on to re-run the entire command, which for `cswap remove 3` means asking
 * to delete an account a second time.
 *
 * So the output has to be cmd.exe's message and nothing else: cmd.exe prints it
 * INSTEAD of running anything, so any other line, or any prefix on the line,
 * means something ran and this is its report. And when cmd.exe names the
 * command it could not find, that name must be the candidate we asked for — a
 * tool that shells out itself can forward the message about some other command.
 *
 * `name` is the spelling cmd.exe was ACTUALLY GIVEN — which since #457 is the
 * shim's absolute path whenever shimPath found one, not the bare candidate the
 * loop started from. That distinction is the coupling #456 named as its reason
 * for stopping short, and it is a one-way trap rather than a detail: cmd.exe
 * echoes the command token back exactly as it received it, so a check against
 * the bare name stops matching the instant the token becomes a path. What that
 * costs is not a cosmetic mismatch — it is the honesty of the whole answer. A
 * shim that shimPath saw and that is gone by the time cmd.exe looks for it (a
 * stale memo, an uninstall mid-session, a network drive that dropped, a roaming
 * profile still syncing) would come back as an ordinary exit 1 whose stderr is
 * cmd.exe's two-line "is not recognized / operable program or batch file."
 * instead of the `code: "ENOENT"` every panel keys its "not installed" message
 * off. The user would be told their CLI failed, and shown half a sentence about
 * batch files, when the truthful answer is that it is not there.
 *
 * Feeding it the launch spelling keeps the comparison EXACT, which is what the
 * paragraph above is protecting: matching loosely — on the basename, say —
 * would let a tool that shells out itself have its own child's "is not
 * recognized" read as the tool's absence, re-running a command that may be
 * `cswap remove 3`. So the rule is not "compare less", it is "compare against
 * what was actually asked for".
 *
 * Callers that only have the text (failureText) omit it and get the shape rules
 * alone.
 *
 * ── AND NOT ONLY IN ENGLISH (#552) ──────────────────────────────────────────
 *
 * Everything above was written against three English sentences, and cmd.exe is
 * translated. On a German install with cswap genuinely absent it prints
 *
 *     Der Befehl "cswap" ist entweder falsch geschrieben oder konnte nicht
 *     gefunden werden.
 *
 * — so this answered false, `run` resolved `{ ok: false, code: 1 }`,
 * claude-accounts.mjs picked `reason: "switch_failed"` over `"no_cswap"` and the
 * panel's install affordance never appeared. failureText then fell through to
 * firstUseful, which puts the LAST line of a localized sentence on screen by
 * itself: #457's symptom reproduced for every non-English locale. It also
 * stopped the candidate loop early, so a `.bat` installed after a missing `.cmd`
 * was never reached.
 *
 * Adding the German sentence, and then the French and the Japanese ones, is not
 * a fix — it is the same defect with a longer list. So two signals that are not
 * sentences carry the answer instead, and the English text is what remains when
 * neither is available:
 *
 *   1. THE EXIT STATUS. `exitCode` 9009 is cmd.exe's own errorlevel for a
 *      command token it could not resolve, identical in every language. See
 *      CMD_NOT_FOUND_EXIT for why it is not required, and the paragraph below
 *      for the two cases where it is not believed either. It is subject to the
 *      same "cmd.exe printed nothing else" cap as rule 2, because a status is
 *      forwarded as easily as a sentence is.
 *
 *   2. THE SHAPE. cmd.exe quotes the command it could not find, in every locale,
 *      and prints that INSTEAD of running anything — so the whole output is at
 *      most the two lines of one wrapped sentence. Text of at most two lines
 *      whose FIRST line quotes exactly the spelling we launched is cmd.exe's
 *      verdict about our command whatever the words around it say.
 *
 * Rule 2 needs `name`, and refuses without it. That is the same principle the
 * paragraphs above argue for and not a limitation bolted on: `Error: "account-9"
 * does not exist` is one line with a quoted token in it, and read as an absence
 * it would send the candidate loop back round to re-run `cswap remove 3`. What
 * makes the rule safe is that the quoted token has to be the exact spelling
 * cmd.exe was handed — `cswap.cmd`, or the absolute path shimPath found — which
 * is a string the tool underneath has no reason to print. The two-line cap is
 * the other half: a Python traceback ending in "The system cannot find the file
 * specified" is four lines and can never qualify.
 *
 * THE SAME TRAP THE ENGLISH RULE ALREADY AVOIDS, NOW FOR THE EXIT STATUS. A
 * `.cmd` shim is itself a batch file, so a shim that EXISTS and whose payload
 * interpreter does not — a scoop or npm-style `cswap.cmd` in front of a python
 * that was uninstalled — has cmd.exe print "is not recognized" about PYTHON and
 * hands the shim's caller that same 9009. Believed on its own, the deck would
 * call the tool absent and re-run the command under the next spelling. So a text
 * that positively names a command OTHER than ours vetoes every rule here,
 * including the status: the check that made #457 safe, applied one level up.
 *
 * What is deliberately still missed: a LOCALIZED "the system cannot find the
 * path specified", which carries no quoted token and no structure to key off.
 * That case only arises when shimPath found a shim that then vanished, and it
 * fails in the safe direction — an honest exit 1 rather than a wrong ENOENT.
 */
export function looksMissing(text, name = "", exitCode = null) {
  const lines = String(text ?? "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  // Whatever cmd.exe named, in whatever language it said the rest — the quoting
  // is the part that is not a translation.
  const named = lines.length ? quotedRuns(lines[0]) : [];
  const namesUs = named.some(q => sameCommand(q, name));

  // The veto, before anything is believed: a message about somebody else's
  // command is not evidence about ours, and neither is the status that came
  // with it. See the header — a `.cmd` shim in front of a missing interpreter
  // forwards both.
  if (name && named.length > 0 && !namesUs) return false;

  // cmd.exe says this INSTEAD of running anything, so anything longer than one
  // wrapped sentence came from something that DID run — and that outranks both
  // signals below. A shim can forward its child's 9009 after printing pages of
  // its own; a Python traceback is four lines and one of them quotes the very
  // shim we launched.
  const saidNothingElse = lines.length <= 2;

  // The signal that is not a sentence. It does not need to READ the text, which
  // is the whole reason it exists: on a non-English install there may be nothing
  // in the text this can read.
  if (saidNothingElse && notFoundExit(exitCode)) return true;
  if (!lines.length) return false;

  // The English shapes, whole-line anchored, exactly as before.
  let english = true;
  for (const line of lines) {
    const unknown = CMD_UNKNOWN.exec(line);
    if (unknown) {
      if (name && !sameCommand(unknown[1], name)) return false;
      continue;
    }
    if (CMD_UNKNOWN_TAIL.test(line) || CMD_NO_PATH.test(line)) continue;
    english = false;
    break;
  }
  if (english) return true;

  // Otherwise: cmd.exe in some other language, recognised by its shape and by
  // the one word in it that is ours.
  return Boolean(name) && saidNothingElse && namesUs;
}
