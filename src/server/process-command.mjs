// What of a process's command line the Machine panel may show: the arguments,
// with the executable that carries them taken off the front (commandTail), and
// then with the shapes a secret takes removed and the rest capped
// (redactCommand).
//
// Moved out of process-list.mjs unchanged. attachDetail there runs both on
// every candidate's argument vector before it leaves that module, because
// /api/system/processes answers anything that can reach the loopback port;
// process-list.mjs re-exports CMD_MAX, redactCommand and commandTail, which is
// where the suite reaches them.

/**
 * An argument vector with the parts that must not be looked at taken out, and
 * the parts nobody reads cut off.
 *
 * THIS IS A BLOCKLIST AND A BLOCKLIST LEAKS. It is written down here rather
 * than implied, because the alternative — `comm`, which is what this replaced —
 * leaked nothing and told the reader nothing either. What it removes is the
 * shapes a secret actually takes on a command line; what it cannot remove is a
 * secret that looks like an ordinary word, and no rule here pretends otherwise.
 *
 * The cap is the other half, and it is not a nicety. Measured on this machine:
 * one Chrome helper's argv is 906 characters of `--field-trial-handle`,
 * base64 `--gpu-preferences` and shared-memory handles. Forty of those is 36 KB
 * on the wire every four seconds to render a column nobody can read. What
 * identifies a process is its first few arguments — `ng serve admin-portal
 * --port 44440` — and that is what fits.
 */
export const CMD_MAX = 180;

const SECRET_FLAG =
  /(-{1,2}[\w.-]*(?:token|password|passwd|secret|api[-_]?key|apikey|auth|credential|bearer|cookie|session[-_]?id|private[-_]?key)[\w.-]*)(=|\s+)(\S+)/gi;
// The shapes that are a secret on their own, with no flag in front of them.
const BARE_SECRET =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{12,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})/g;
// user:password@host, in any URL. The password goes; the rest is a location.
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+):[^\s@/]+@/gi;

export function redactCommand(argv, home = "") {
  let s = String(argv ?? "").trim();
  if (!s) return "";
  s = s.replace(SECRET_FLAG, (_, flag, sep, value) => `${flag}${sep === "=" ? "=" : " "}\u2022\u2022\u2022`);
  s = s.replace(URL_CREDENTIALS, "$1:\u2022\u2022\u2022@");
  s = s.replace(BARE_SECRET, "\u2022\u2022\u2022");
  // `~` last, so a home path inside a redacted value is already gone. Only a
  // whole path segment, so a user called `con` cannot rewrite the middle of an
  // unrelated word.
  if (home && home.length > 1) s = s.split(home + "/").join("~/").split(home + " ").join("~ ");
  if (s.length > CMD_MAX) s = s.slice(0, CMD_MAX - 1).trimEnd() + "\u2026";
  return s;
}

/**
 * The ARGUMENTS, with the executable that carries them taken off the front.
 *
 * The name column already says `Google Chrome Helper`; repeating
 * `/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome
 * Framework.framework/Versions/152.0.7977.76/Helpers/Google Chrome
 * Helper.app/Contents/MacOS/Google Chrome Helper` beside it spends the entire
 * 180-character budget on a path the reader can already see the end of, and
 * cuts off `--type=renderer`, which is the part that says WHICH helper this is.
 *
 * argv[0] cannot be found by splitting on whitespace — on macOS the executable
 * path routinely contains spaces, and `/Applications/Google Chrome.app/…` would
 * be cut at "Google". The name from the first `ps` call is what resolves it:
 * argv begins with a path whose last segment IS that name.
 *
 * "Last segment" is the whole of the rule, and the first version of this got it
 * wrong in a way only the render showed. A plain `indexOf` cuts at the FIRST
 * occurrence, and a macOS bundle contains the name twice — `…/Helpers/Google
 * Chrome Helper.app/Contents/MacOS/Google Chrome Helper` — so every browser row
 * read `.app/Contents/MacOS/Google Chrome Helper --type=gpu-process`, having
 * spent the budget on the half of the path it was supposed to remove. A plain
 * `lastIndexOf` is wrong the other way: `node /srv/node_modules/x` would cut
 * inside `node_modules`.
 *
 * So: the first occurrence that a path segment actually ends at — preceded by a
 * separator or nothing, followed by whitespace or nothing. `node /srv/app.js
 * --port 3000` leaves `/srv/app.js --port 3000`; `/usr/local/bin/dotnet exec
 * --runtimeconfig …` leaves `exec --runtimeconfig …`, which is what identifies
 * it.
 *
 * When the name is not in argv at all — a process that rewrote argv[0], or a
 * `comm` that Linux truncated at 15 characters — the first whitespace token
 * goes only if it looks like a path, because dropping the first word of
 * something already short would take the only word there was.
 */
export function commandTail(argv, name) {
  const s = String(argv ?? "").trim();
  if (!s) return "";
  const n = String(name ?? "").trim();
  if (n) {
    for (let at = s.indexOf(n); at >= 0; at = s.indexOf(n, at + 1)) {
      const before = at === 0 ? "" : s[at - 1];
      const after = s[at + n.length] ?? "";
      if ((before === "" || before === "/" || before === "\\" || /\s/.test(before))
        && (after === "" || /\s/.test(after))) {
        return s.slice(at + n.length).trim();
      }
    }
  }
  const first = s.split(/\s+/)[0] ?? "";
  return first.includes("/") ? s.slice(first.length).trim() : s;
}
