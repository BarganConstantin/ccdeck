// "Can somebody else's Claude Code drive the browser on this machine?" — read
// off disk, answered without a single privileged call, and turned into the one
// command that closes it.
//
// THE EXPOSURE. The Claude in Chrome extension holds a cloud relay open to
// bridge.claudeusercontent.com, and it registers the browser under the ANTHROPIC
// ACCOUNT rather than under the device. So the set of clients able to enumerate
// and drive this browser is not "the sessions on this laptop", it is "every
// Claude Code session signed in to that account, on any machine" — and the
// pairing completes with no prompt on the machine being taken over. Upstream:
// anthropics/claude-code #25551, #33813, #42660. The browser on the other end is
// the one holding the user's logged-in sessions, so the question is worth a
// panel rather than a footnote.
//
// WHAT THIS MODULE DOES. Two reads and a string. It says whether the extension
// is installed and what it was granted (from a profile's "Secure Preferences",
// which the caller parses), and whether the hosts file already black-holes the
// relay (from the hosts file's TEXT, which the caller reads). Neither needs a
// privilege. Then it hands back the command that would change it, as text, for
// the user to paste.
//
// WHY IT NEVER ELEVATES AND NEVER WRITES. Not squeamishness — the deck's own
// threat model. `isTrustedMutation` in index.mjs deliberately lets a request
// carrying no Origin header through (`if (!hasOrigin && !site) return true;`)
// so that hook.js and curl keep working, on the reasoning that a process able
// to POST to loopback can already run anything as the user. That reasoning
// holds only while no route can do something the caller could not do for
// itself. The moment one route can raise a password dialog, any local process
// gets to make an authentication prompt appear wearing ccdeck's name, at a
// moment ccdeck chose — which is the whole of a phishing primitive, handed over
// for free. There is no elevation anywhere else in this repo, and this module
// is not where the precedent starts. It imports node:path and nothing else: no
// child_process, no fs, nothing that could run or write. relay-guard.test.ts
// pins that by reading this file's own source, because "we would notice" is not
// a control.
import { win32 as winPath } from "node:path";

/** The relay the extension keeps open. Blocking this name is the whole lever:
 *  the pairing is account-scoped, so there is no per-device setting to turn off
 *  and no token to rotate — DNS is the seam. */
export const RELAY_HOST = "bridge.claudeusercontent.com";

/** Claude in Chrome, by its Web Store extension id — the key under
 *  `extensions.settings` in a Chromium profile's "Secure Preferences". */
export const CLAUDE_EXT_ID = "fcoeoabgfenejglbffodgkkbkcdhcgfn";

/** The tag that makes a hosts line OURS rather than somebody's. Everything
 *  downstream — what `readKillswitch` will claim, what the unblock command is
 *  allowed to delete — hangs off this exact text appearing as a comment on the
 *  line. A line without it is a line we did not write and will not remove. */
const TAG = "ccdeck killswitch";

/** The line the block command appends, verbatim. Also the line the unblock
 *  command deletes, and the only one it may. */
const KILLSWITCH_LINE = `0.0.0.0 ${RELAY_HOST} # ${TAG}`;

/**
 * The host name with its dots escaped, for use inside a pattern.
 *
 * THIS IS THE ONE THAT ALREADY DID DAMAGE. The shell tool this feature descends
 * from matched the host with its dots unescaped, so `.` meant "any character"
 * and the pattern also matched `bridge-claudeusercontent-com` — and, being
 * unanchored on top of that, matched it as a SUBSTRING of unrelated lines. One
 * test run deleted five entries from a real /etc/hosts, one of them an internal
 * network mapping that nothing else on that machine knew how to reproduce.
 *
 * Escaping only `.` is sufficient here and not in general: RELAY_HOST is
 * letters and dots, which are otherwise literal in all three dialects this
 * module writes patterns for (JavaScript, POSIX BRE for sed, .NET for
 * PowerShell). A test pins that character-set assumption, so changing the
 * constant to something containing a metacharacter fails there rather than
 * silently widening every matcher at once.
 */
const HOST_RE = RELAY_HOST.replace(/\./g, "\\.");

/**
 * The tagged line, as a pattern written in the dialect JavaScript and .NET
 * share — so the matcher below and the delete pattern inside the Windows
 * command are the SAME string and cannot drift apart.
 *
 * Anchored at both ends, dots escaped, and the tag required. Each of those
 * three is load-bearing:
 *
 *   ^[ \t]*   a hosts line may be indented and still be live, but a line whose
 *             first non-blank character is `#` is a comment, and this refuses
 *             it — `# 0.0.0.0 bridge…  # ccdeck killswitch` is a block somebody
 *             turned OFF, and claiming it would report protection that is not
 *             there and then delete a line that was already inert.
 *   [ \t]+    one or more, because the file on this machine separates fields
 *             with a tab and a hand-edited line may use several spaces.
 *   $         without it, `0.0.0.0 bridge… # ccdeck killswitch AND SOMETHING`
 *             counts as ours, and the unblock deletes the something with it.
 *   the tag   without it, every untagged mapping of the host is ours to delete,
 *             including the one an admin put there on purpose.
 */
const TAGGED_PATTERN = `^[ \\t]*0\\.0\\.0\\.0[ \\t]+${HOST_RE}[ \\t]+#[ \\t]*${TAG}[ \\t]*$`;

/** The same shape in POSIX BRE, for sed. `[[:space:]]` rather than `[ \t]`
 *  because BRE has no `\t` escape — a bracket expression written `[ \t]` in a
 *  BRE matches a backslash and the letter t, which is not what anyone reading
 *  it would think, and `+` is not a BRE repetition operator either, hence the
 *  `XX*` spelling. */
const TAGGED_BRE = "^[[:space:]]*0\\.0\\.0\\.0[[:space:]][[:space:]]*" + HOST_RE +
                   "[[:space:]][[:space:]]*#[[:space:]]*" + TAG + "[[:space:]]*$";

/** Case-SENSITIVE on purpose, and this is the asymmetry the module turns on:
 *  what counts as ours drives a DELETE, so it is exactly the line we write;
 *  what counts as foreign drives a WARNING, so it is generous (see below). Both
 *  shell dialects match case-sensitively too — sed by default, PowerShell only
 *  because the command asks for `-cnotmatch` rather than `-notmatch` — so a
 *  line this claims is a line those two will actually remove. */
const OURS = new RegExp(TAGGED_PATTERN);

/**
 * Addresses that make a mapping a block rather than a redirect.
 *
 * `0.0.0.0` is the one we write and the one every hosts blocklist uses: nothing
 * dials it, so the connection fails immediately instead of hanging. The
 * loopback pair is here because it is the older convention for the same intent
 * and a user who typed one meant to block; the relay speaks TLS on 443 and
 * nothing on this machine answers there, so it fails too — just a little later.
 *
 * Everything else is treated as reachable, including a private address that
 * happens to be down today. This module cannot tell a sinkhole from a proxy by
 * looking at an octet, and the honest failure direction is to under-claim
 * protection rather than to over-claim it.
 */
const BLACK_HOLE = new Set(["0.0.0.0", "127.0.0.1", "::1", "::"]);

/**
 * Where the hosts file lives.
 *
 * `platform` and `env` are injected rather than read, because the Windows leg
 * has to be testable from the macOS and Linux runners in the matrix — there is
 * no second machine to check it on, and a leg nobody can run is a leg nobody
 * has checked.
 *
 * THE THREE SPELLINGS OF SystemRoot. Windows' own environment is
 * case-insensitive, so on a real Windows box any one of these answers. A plain
 * object handed in by a test — or by a caller building an environment for a
 * child process — is a normal JavaScript object and is not, which is how the
 * variable that is always set in production reads as missing in a test.
 * exec.mjs reads two spellings for this reason; the third costs nothing.
 *
 * WHY THE FALLBACK NAMES A DRIVE. With no root at all, joining would produce
 * `\System32\drivers\etc\hosts` — a path that is rooted but drive-less, which
 * Windows resolves against the CURRENT drive. That is a different file on every
 * drive the deck might be started from, and reading the wrong file here means
 * reporting "not blocked" for a machine that is blocked. `C:\Windows` is a
 * guess, but it is a stated one and it is right on approximately every Windows
 * install; a silently drive-relative path is wrong in a way nobody can see.
 */
export function hostsPath(platform = process.platform, env = process.env) {
  if (platform !== "win32") return "/etc/hosts";
  const e = env || {};
  const root = String(e.SystemRoot || e.systemroot || e.SYSTEMROOT || "").trim();
  return winPath.join(root || "C:\\Windows", "System32", "drivers", "etc", "hosts");
}

/**
 * One line's mapping, or null if the line carries none.
 *
 * The hosts format has no quoting: everything from the first `#` is a comment,
 * the rest is an address followed by one or more names. So a line that is
 * entirely a comment loses its whole body here and answers null — which is what
 * keeps a commented-out killswitch, and a line of prose that merely mentions
 * the host, out of every list this module returns.
 */
function mapping(line) {
  const body = line.split("#")[0];
  const fields = body.trim().split(/[ \t]+/).filter(Boolean);
  if (fields.length < 2) return null;
  return { address: fields[0], names: fields.slice(1) };
}

/**
 * What a hosts file says about the relay. Takes the TEXT; the caller does the
 * reading, so this stays a pure function and the module stays incapable of
 * touching the file at all.
 *
 *   ours     lines this feature wrote — the tagged form, exactly. These are the
 *            lines the unblock command is allowed to delete.
 *   foreign  every OTHER live mapping of the host: an untagged black-hole
 *            somebody added by hand, a corporate mapping pushed by config
 *            management, the host riding along as an alias on another line.
 *            Never deleted, always surfaced.
 *   blocked  whether the name actually fails to resolve to anything reachable.
 *
 * WHY `blocked` IS NOT `ours.length > 0`. A hosts file resolves on the first
 * matching entry, so one line reading `10.4.0.9 bridge.claudeusercontent.com`
 * above our own defeats the block completely while leaving our line right
 * there in the file. Reporting "protected" in that state is the single worst
 * thing a panel like this can do, so any live mapping pointing somewhere
 * reachable takes the claim away — and `foreign` is what tells the user which
 * line to go look at. The mirror case is generous in the safe direction: an
 * untagged `0.0.0.0` block that somebody else installed is a real block, and it
 * counts, even though it is not ours to remove.
 *
 * Host comparison is case-insensitive because DNS is, and because a hosts file
 * with `Bridge.ClaudeUserContent.com` in it resolves exactly the same way. That
 * generosity applies to `foreign` only — see OURS for why the other list stays
 * byte-exact.
 *
 * A non-string answers the empty verdict rather than throwing: the caller's
 * read can fail (no such file on a stripped container, EACCES under a hardened
 * profile) and a panel that cannot see the file has nothing to report, which is
 * not the same as a crash.
 */
export function readKillswitch(text) {
  const ours = [];
  const foreign = [];
  if (typeof text !== "string") return { blocked: false, ours, foreign };
  let sinkholed = false;
  let reachable = false;
  // Every line ending, including the lone CR nothing writes any more and the
  // CRLF every Windows hosts file uses. Splitting on all three is what keeps a
  // trailing \r out of the strings handed back — a `\r` clinging to the end of
  // a line would defeat the `$` anchor and quietly make a real killswitch read
  // as foreign on the one platform where the file is always CRLF.
  for (const line of text.split(/\r\n|\r|\n/)) {
    const m = mapping(line);
    if (!m) continue;
    if (!m.names.some(n => n.toLowerCase() === RELAY_HOST)) continue;
    if (OURS.test(line)) ours.push(line);
    else foreign.push(line);
    if (BLACK_HOLE.has(m.address.toLowerCase())) sinkholed = true;
    else reachable = true;
  }
  return { blocked: sinkholed && !reachable, ours, foreign };
}

/** macOS. `dscacheutil` empties the cache and the SIGHUP restarts the resolver
 *  that holds the rest of it; neither alone is enough, and both have been the
 *  documented pair for long enough to survive an OS release. The signal needs
 *  root — mDNSResponder is not the user's process — and by this point in the
 *  paste sudo has already been answered once, so it costs no second prompt. */
const FLUSH_DARWIN = "dscacheutil -flushcache 2>/dev/null; " +
                     "sudo killall -HUP mDNSResponder 2>/dev/null || true";

/** Linux. `resolvectl` only exists where systemd-resolved does, and plenty of
 *  distributions run something else or nothing at all — so it is probed for
 *  rather than attempted, and the `|| true` means the whole paste still exits
 *  0 on a machine that has no such tool. A missing flush is a cache that
 *  expires on its own in a few minutes; a failed paste is a user who thinks
 *  the block did not happen and does it again. */
const FLUSH_LINUX = "command -v resolvectl >/dev/null 2>&1 && " +
                    "sudo resolvectl flush-caches 2>/dev/null || true";

/** Windows. Needs no elevation of its own, and runs last so its exit status is
 *  the only one the user sees. */
const FLUSH_WINDOWS = "ipconfig /flushdns";

/**
 * The command that flips the killswitch. `on: true` blocks the relay, `on:
 * false` lifts the block.
 *
 * IT IS A STRING. The deck prints it, the user reads it, the user pastes it.
 * Nothing here runs it — see the file header for why that boundary is the whole
 * design and not a limitation waiting to be lifted.
 *
 * THE LEADING NEWLINE. The block command tests the last byte of the file before
 * appending, and appends a newline first if the file does not end in one.
 * Without that test, a hosts file whose last line has no terminator — which is
 * a perfectly ordinary file, and what several config-management tools leave
 * behind — gets our text welded onto the end of that last line, producing one
 * corrupt entry out of two valid ones. `$(…)` strips trailing newlines, so the
 * substitution is empty exactly when the file already ends in one; nothing else
 * is being tested there.
 *
 * ONE `sudo`, NOT THREE. The append is two writes and a read of the same file,
 * wrapped in a single `sh -c` so the user is asked for a password once and can
 * read the whole of what is about to run as root in one place. The flush is
 * separated by `;` rather than `&&` for the same reason a missing flush tool is
 * probed for: a cache that would not clear must not take the block down with
 * it.
 *
 * WHY THE UNBLOCK USES sed AND WHY THE FLAG DIFFERS PER PLATFORM. `sed -i` is
 * the readable form, and a command a person is about to run as root earns
 * readability. BSD sed requires an explicit backup suffix and GNU sed forbids
 * one, so the two spellings are not interchangeable — which is exactly what the
 * `platform` parameter is for. The `else` leg here is GNU-shaped, so a BSD that
 * is neither Darwin nor Linux would need its own; ccdeck states support for
 * Linux, macOS and Windows, and this is the edge of that statement rather than
 * an oversight.
 *
 * NOT IDEMPOTENT, ON PURPOSE. Pasting the block twice writes the line twice.
 * That resolves identically, and the unblock deletes every matching line, so
 * the state heals itself — cheaper than a `grep -q` guard that would double the
 * length of a command whose readability is the point.
 */
export function killswitchCommand(platform = process.platform, { on }) {
  if (typeof on !== "boolean") {
    // Not a defensive nicety. The two commands are opposites, and a caller that
    // forgot the field would otherwise get whichever one the default happened
    // to name — silently lifting a block the user asked to install.
    throw new TypeError("killswitchCommand needs { on: true } or { on: false }");
  }
  if (platform === "win32") return windowsCommand(on);
  const file = hostsPath(platform);
  const flush = platform === "darwin" ? FLUSH_DARWIN : FLUSH_LINUX;
  // BSD sed wants the backup suffix as its own argument and reads an empty one
  // as "no backup"; GNU sed reads a following argument as the script.
  const inPlace = platform === "darwin" ? "sed -i ''" : "sed -i";
  const command = on
    ? `sudo sh -c '[ -n "$(tail -c1 ${file} 2>/dev/null)" ] && printf "\\n" >> ${file}; ` +
      `printf "%s\\n" "${KILLSWITCH_LINE}" >> ${file}'; ${flush}`
    : `sudo ${inPlace} '/${TAGGED_BRE}/d' ${file}; ${flush}`;
  return { command, needsAdmin: true, note: note(platform, on) };
}

/**
 * The Windows pair, as PowerShell.
 *
 * `$env:SystemRoot` rather than the path this process resolved: the command
 * runs in somebody else's elevated shell, and that shell knows where Windows is
 * installed without being told by us. It also keeps this process's environment
 * out of a string that is about to run as Administrator.
 *
 * Read-modify-write through `[IO.File]` rather than `Add-Content`, because
 * Add-Content appends a terminator AFTER its value and never one before it —
 * which is precisely the missing-trailing-newline corruption, just spelled in
 * PowerShell. Writing the whole text back keeps the file's own ACL: the handle
 * truncates a file that already exists rather than creating a new one, so the
 * inherited permissions on a file in System32 are not quietly replaced by
 * whatever the elevated shell would have created.
 *
 * `-cnotmatch`, not `-notmatch`. PowerShell's comparison operators are
 * case-INSENSITIVE by default, which would let the delete take a line the
 * `ours` matcher above refuses to claim — a command that removes more than the
 * module says it will is the exact failure this feature exists to not repeat.
 * `@(…)` forces an array so that a hosts file reduced to a single line does not
 * arrive at WriteAllLines as a bare string.
 */
function windowsCommand(on) {
  const file = "$h = $env:SystemRoot + \"\\System32\\drivers\\etc\\hosts\"";
  const command = on
    ? [
        file,
        "$t = [IO.File]::ReadAllText($h)",
        "if ($t.Length -gt 0 -and -not $t.EndsWith(\"`n\")) { $t += \"`r`n\" }",
        `$t += "${KILLSWITCH_LINE}\`r\`n"`,
        "[IO.File]::WriteAllText($h, $t)",
        FLUSH_WINDOWS,
      ].join("; ")
    : [
        file,
        `$p = '${TAGGED_PATTERN}'`,
        "[IO.File]::WriteAllLines($h, @(Get-Content -LiteralPath $h | " +
          "Where-Object { $_ -cnotmatch $p }))",
        FLUSH_WINDOWS,
      ].join("; ");
  return { command, needsAdmin: true, note: note("win32", on) };
}

/**
 * What the command does not do, said in the panel rather than discovered later.
 *
 * The sentence about existing connections is the one that matters and it is
 * deliberately not written any stronger than what was actually observed: a
 * hosts entry is consulted when a name is resolved, and a socket that is
 * already open was resolved before the entry existed. It stays up. What ends it
 * is the browser restarting — not this command, and not waiting.
 */
function note(platform, on) {
  const paste = platform === "win32"
    ? "Run it in a PowerShell started as Administrator."
    : "Paste it in a terminal yourself.";
  // Named for what the platform actually shows, because the promise is about a
  // dialog the user might otherwise see with ccdeck's name on it.
  const never = platform === "win32"
    ? "ccdeck never runs it and never raises a UAC prompt."
    : "ccdeck never runs it and never asks for your password.";
  const survives = "Blocking the name stops new connections to the relay; " +
    "it does not close one the extension already holds, and that one lasts " +
    "until the browser restarts.";
  const surgical = `Removes only the line tagged "${TAG}" — any other mapping ` +
    `of ${RELAY_HOST} in the file is left exactly where it is.`;
  const flush = platform === "linux"
    ? " The DNS cache flush runs only where systemd-resolved is installed and " +
      "is skipped, not failed, everywhere else."
    : "";
  return `${paste} ${never} ${on ? survives : surgical}${flush}`;
}

/**
 * The API surface worth reporting, in the order it earns alarm.
 *
 * Every one of these was granted at the BROWSER level, and that is the fact to
 * hold on to: `debugger` is the Chrome DevTools Protocol over every tab, which
 * is read-anything and click-anything; `nativeMessaging` reaches a program
 * outside the sandbox; `downloads` writes files to disk; `tabs` and `scripting`
 * are the enumerate-and-inject pair.
 */
const SENSITIVE_APIS = ["debugger", "nativeMessaging", "downloads", "tabs", "scripting"];

// Host patterns that mean every site there is. `<all_urls>` is what the real
// profile on this machine carries; the any-scheme wildcard below it is the
// other spelling Chrome accepts for the same reach, and missing it would
// under-report the one thing this field exists to report. A scheme-specific
// wildcard — every https site, say — is deliberately NOT counted: it is broad,
// but it is not every site, and this flag should mean what it says.
//
// Written as line comments rather than a block, because the pattern itself
// contains the sequence that closes one.
const EVERY_SITE = new Set(["<all_urls>", "*://*/*"]);

/** Defensive array read. A "Secure Preferences" file is Chrome's to write and
 *  ours only to read; a field that is a string where an array was expected is a
 *  Chrome release note we have not seen yet, not a reason to throw inside a
 *  panel. */
const list = v => (Array.isArray(v) ? v.filter(x => typeof x === "string") : []);

/**
 * What one browser profile granted the extension. Takes the already-parsed
 * "Secure Preferences" object, so the file reading — and its JSON.parse, which
 * throws on a profile Chrome is mid-write on — stays with the caller.
 *
 *   present        the extension has an entry in this profile.
 *   enabled        and it is not switched off.
 *   allUrls        it may act on every site.
 *   sensitiveApis  which of the APIs above it holds, in SENSITIVE_APIS order
 *                  rather than the file's, so the panel renders the same list
 *                  twice in a row and a test can assert on it.
 *
 * WHY `disable_reasons` AND NOT `state`. Checked against a real profile on this
 * machine: the entry carries `disable_reasons: []` and no `state` key at all.
 * A non-empty array is Chrome saying why it turned the extension off, so an
 * empty one is "no reason to be off" — enabled. The direction is worth stating
 * because it is the good news in this whole module, and a report that shows a
 * disabled extension as a live threat is a report the user stops reading.
 *
 * WHY REMOVING SITE PERMISSIONS IN chrome://extensions DOES NOT HELP. These
 * permissions are held at the browser level — the same profile shows
 * `withholding_permissions: false` and `<all_urls>` in both `explicit_host` and
 * `scriptable_host` — and the per-site allowlist a user configures is enforced
 * INSIDE the extension, by the extension. Tightening it narrows what the
 * extension chooses to do, not what it is able to do, and an operator driving
 * it through the relay is not bound by the extension's own UI. So this field
 * reports the browser-level grant, which is the one that would still be true
 * after a user "fixed" it in the settings page.
 *
 * `scriptable_host` is read alongside `explicit_host` for the same
 * under-reporting reason as the any-scheme wildcard in EVERY_SITE:
 * content-script reach into every page is the same exposure arriving through a
 * different key.
 */
export function extensionReport(securePreferences, extId = CLAUDE_EXT_ID) {
  const settings = securePreferences?.extensions?.settings;
  const has = settings && typeof settings === "object" &&
    typeof extId === "string" && Object.hasOwn(settings, extId);
  // Object.hasOwn rather than a plain lookup: `settings["constructor"]` is a
  // function on every object alive and `settings["__proto__"]` is a prototype,
  // and either one would sail past a truthiness check and be reported as an
  // installed extension. The id is a caller-supplied string; see
  // prototype-keys-474.test.ts for the same footgun caught elsewhere here.
  const entry = has ? settings[extId] : null;
  if (!entry || typeof entry !== "object") {
    return { present: false, enabled: false, allUrls: false, sensitiveApis: [] };
  }
  const granted = entry.granted_permissions;
  const hosts = [...list(granted?.explicit_host), ...list(granted?.scriptable_host)];
  const api = new Set(list(granted?.api));
  return {
    present: true,
    enabled: !(Array.isArray(entry.disable_reasons) && entry.disable_reasons.length > 0),
    allUrls: hosts.some(h => EVERY_SITE.has(h)),
    sensitiveApis: SENSITIVE_APIS.filter(name => api.has(name)),
  };
}

/**
 * The headline, from the two facts that decide it.
 *
 * `anyExtension` is the caller's aggregate across every profile of every
 * browser it found — one enabled copy anywhere is enough, because the relay is
 * per-account and not per-profile. With no extension installed there is nothing
 * to block and nothing to warn about, so a machine with no browser extension
 * and no hosts entry is "nothing-exposed" rather than "exposed": the killswitch
 * is not a thing this user has to do.
 *
 * Deliberately three states and not two. "protected" and "nothing-exposed" both
 * mean "no action needed" today, and collapsing them would make the panel say
 * the block is working on a machine where it was never needed — which is the
 * kind of reassurance that stops meaning anything.
 */
export function verdict({ anyExtension, blocked } = {}) {
  if (!anyExtension) return "nothing-exposed";
  return blocked ? "protected" : "exposed";
}
