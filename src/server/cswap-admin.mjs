// Everything the accounts panel does that CHANGES the claude-swap store.
//
// Reading it lives in claude-accounts.mjs. This is the other half: signing a
// new account in, sharing one to another machine, and the small edits —
// rename, reorder, remove.
//
// Two constraints from claude-swap's own source shape all of it.
//
// `cswap add` does not sign anyone in. It captures whatever is already live —
// identity from ~/.claude.json, credentials from the macOS Keychain item
// "Claude Code-credentials". So a browser login has to land in Claude Code's
// own store first, which is exactly what `claude auth login` does, and the
// panel's job is to drive that conversation rather than to invent one.
//
// And `cswap add` takes no lock while assigning the next slot as max+1. Two
// concurrent adds pick the same number and the second write silently drops the
// first account's record. Nothing upstream prevents it, so every mutation here
// goes through one mutex.
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from "node:zlib";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { looksMissing, pathLookup, run, runDetached, runInteractive } from "./exec.mjs";
import { backupRoot, invalidateClaudeAccountsCache } from "./claude-accounts.mjs";
import { claudeCliCandidates } from "./claude-dir.mjs";
import { cswapBin } from "./cswap-install.mjs";
import { PRODUCT } from "./brand.mjs";

// An OAuth code is short-lived at the source; there is no point holding a child
// open longer than a user would plausibly take to fetch one.
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const CSWAP_TIMEOUT_MS = 60_000;
// How long to wait for the CLI's verdict on a pasted code before saying so.
// Exchanging a code is one HTTPS round trip; a minute is generous.
const CODE_VERDICT_MS = 60_000;
// How long a shared account stays importable. Long enough to walk to the other
// machine, short enough that a copy left in clipboard history goes stale.
export const SHARE_TTL_MS = 10 * 60_000;
// How many accounts one bundle may carry. See shareAccounts.
const MAX_SHARE_ACCOUNTS = 50;

/**
 * The prefix a share is written with, and the one it used to be written with.
 *
 * `ccdeck1:` is base64 of the envelope JSON. `ccdeck2:` is base64 of the same
 * JSON compressed, and the difference is not cosmetic — it was reported from
 * the panel as "the text is very large", and on a real store it is:
 *
 *     1 account    2200 characters  ->  1024
 *     3 accounts   6168 characters  ->  1816
 *
 * Because what a bundle mostly contains is not credentials. An account's two
 * OAuth tokens are 216 characters between them; the envelope around them is
 * two thousand, and every one of its key names — `refreshTokenExpiresAt`,
 * `organizationRateLimitTier`, `claudeCodeTrialDurationDays` — repeats
 * verbatim for every account added. That is exactly what a compressor is for,
 * which is why the saving grows with the number of accounts rather than
 * shrinking.
 *
 * Brotli rather than gzip: 10% smaller here, in node:zlib since v11, no
 * dependency either way.
 *
 * BOTH prefixes are read, so a blob copied before this change still imports.
 * Only `ccdeck2:` is written, which does mean a deck older than this cannot
 * read a new share — it will say the text does not look like a shared account.
 * That cost is paid once and it is smallest now: the feature shipped in
 * 1.48.0 and the format has had no time to spread.
 */
const SHARE_PREFIX = "ccdeck2:";
const SHARE_PREFIX_V1 = "ccdeck1:";

/**
 * The most an imported blob may decompress to.
 *
 * A few hundred bytes of brotli can name gigabytes of output, and this input
 * arrives by paste from wherever the user found it. 50 accounts at ~1.6 KB of
 * envelope each is under 100 KB, so 2 MB is twenty times the largest bundle
 * this deck will ever produce and still nothing to allocate by accident.
 */
const SHARE_MAX_BYTES = 2 << 20;

// ── serialization ────────────────────────────────────────────────────────────

let _chain = Promise.resolve();

// Whether the code running right now is itself the mutation holding the lock.
// Async context rather than a plain boolean, which could not tell that apart
// from another request that merely arrived while the lock was held — and would
// wave that one through, which is the opposite of a mutex.
const _holder = new AsyncLocalStorage();

/**
 * One store mutation at a time.
 *
 * Not defence against another process — that would need claude-swap's own file
 * lock, which `add` does not take either. This is defence against ourselves:
 * two browser tabs, or a double-click, are enough to race a slot assignment.
 *
 * Re-entrant, because a mutation that reaches for the lock from inside one
 * would otherwise wait for itself forever: the chain cannot advance past the
 * outer link until it settles, and the outer link is blocked on this call. It
 * already has exclusive access, so it simply runs.
 */
export function withStoreLock(fn) {
  if (_holder.getStore()) return Promise.resolve().then(fn);
  const held = () => _holder.run(true, fn);
  const next = _chain.then(held, held);
  // Keep the chain alive even when a link rejects, or every later mutation
  // inherits the failure.
  _chain = next.then(() => {}, () => {});
  return next;
}

// ── shared helpers ───────────────────────────────────────────────────────────

// cswapBin comes from cswap-install.mjs, which searches the places uv and pipx
// actually install to. This module used to answer the bare name "cswap"
// instead, which is fine on a Mac where ~/.local/bin is usually on PATH and
// wrong on Windows where it is usually not: every mutation here — share,
// import, remove, rename, reorder — failed with cmd.exe's "is not recognized",
// while the read-only half of the panel worked, because it was already using
// the resolver. Reported from Windows on 2026-08-14.

/**
 * Which `claude` the account surface runs: the configured one, else the first
 * candidate this machine actually has, else the bare name.
 *
 * WHY THIS IS NOT `AGENTS_DECK_CLAUDE ?? "claude"` ANY MORE (#570). That was
 * the whole of this module's resolution, and it feeds every child the accounts
 * panel starts — `claude auth status --json` for `currentIdentity`, and the
 * `claude auth login` whose output the sign-in dialog reads a link out of. On a
 * machine whose `claude` is at `~/.local/bin/claude` but whose deck was started
 * from something that never sourced a shell rc — a LaunchAgent, a systemd user
 * unit, pm2, a desktop shortcut — the bare name is an ENOENT, so the login
 * child is dead within milliseconds, the flow reports `no_url`, and the dialog
 * shows "the claude CLI could not be run: not on PATH. Set AGENTS_DECK_CLAUDE
 * to its full path." That sentence is a real remedy and it is why this was a
 * smaller bug than #553; it is still a request to spell out a path the deck had
 * already found for itself, because `hasClaudeInstalled()` stat'ed that exact
 * file at boot to decide this was a Claude machine, and since #553 the quota
 * panel beside this one runs the same binary without being told anything.
 *
 * SO IT READS THE SAME LIST, ON THE SAME TERMS #553 SETTLED ON. The list is
 * `claudeCliCandidates` in claude-dir.mjs, whose other two readers are
 * `hasClaudeInstalled()` — the boot question this module's whole surface hangs
 * off — and `quotaClaudeBin` in quota.mjs. This is the same question at a third
 * site, so nothing here is decided again:
 *
 *   - AGENTS_DECK_CLAUDE first, and it is the one thing that skips the list
 *     entirely. It is documented in the README as "full path to the `claude`
 *     CLI", it is what the failure message above tells people to set, and
 *     someone who set it has already been through this once — second-guessing
 *     them with a stat would be answering a question they have closed. An empty
 *     value reads as unset, the way `AGENTS_DECK_CSWAP` does in cswapBin.
 *   - Then the candidate list's own order, unchanged: PATH first on POSIX, the
 *     two known install directories first on Windows. Preferring a different
 *     copy would silently change which binary signs somebody in on every
 *     machine that has two, and a `claude auth login` that suddenly runs a
 *     different binary is a credential path, not a detail.
 *   - The bare name is only answered with when PATH actually holds it, and
 *     `pathLookup` is a yes/no gate rather than the path it found, so spawn's
 *     own resolution — and, on Windows, exec.mjs's PATHEXT walk, since `claude`
 *     there is `claude.exe` or `claude.cmd` and never the bare word — stays in
 *     charge of the PATH case exactly as before.
 *   - The absolute candidates are stat'ed only once PATH has come up empty, so
 *     the common case costs one stat rather than a directory walk. Against what
 *     follows it — a whole Claude Code process, and a browser sign-in a human
 *     is walking through — that is not a cost worth naming.
 *
 * Pure, with the platform, environment, home directory and existence check all
 * parameters, so the Windows branch is checkable from the platforms this repo
 * is actually developed on. Exported for that test rather than for a caller
 * (#383): `claudeBin` below is the only one, and it hands back the real
 * machine's answer.
 */
export function adminClaudeBin(platform = process.platform, env = process.env,
                               home = homedir(), exists = existsSync) {
  if (env.AGENTS_DECK_CLAUDE) return env.AGENTS_DECK_CLAUDE;
  const sep = platform === "win32" ? "\\" : "/";
  // process.env is case-insensitive on Windows; an injected plain object in a
  // test is not, and %Path% is how the variable is actually spelled there.
  const pathEnv = env.PATH ?? env.Path ?? env.path ?? "";
  for (const c of claudeCliCandidates(platform, env, home)) {
    if (c.includes(sep)) { if (exists(c)) return c; }
    else if (pathLookup(c, platform, { pathEnv, exists })) return c;
  }
  // Nothing on PATH and nothing at any known install directory. The bare name
  // is still the right last resort — POSIX `execvp` and cmd.exe's own search
  // both deserve their turn at a layout no list here knows — and the ENOENT it
  // produces is what failureText turns into the AGENTS_DECK_CLAUDE sentence.
  return "claude";
}

async function claudeBin() {
  return adminClaudeBin();
}

/** Slot → email for everything currently in the store, plus the active slot. */
export async function readStore() {
  try {
    const seq = JSON.parse(await readFile(join(backupRoot(), "sequence.json"), "utf8"));
    const accounts = seq?.accounts ?? {};
    return {
      slots: Object.keys(accounts),
      emails: Object.fromEntries(Object.entries(accounts).map(([k, v]) => [k, v?.email ?? ""])),
      // The other half of the identity claude-swap keys an account by. One
      // address under two organizations is two accounts on purpose, and a
      // bundle carrying both must not report them as one - see identityKey.
      orgs: Object.fromEntries(Object.entries(accounts).map(([k, v]) => [k, v?.organizationUuid ?? ""])),
      activeNum: seq?.activeAccountNumber ?? null,
    };
  } catch {
    return { slots: [], emails: {}, orgs: {}, activeNum: null };
  }
}

/**
 * Which slot appeared between two store reads.
 *
 * `cswap add --json` is rejected by argparse (exit 2), so its human output is
 * the only thing it offers and parsing that would break on any wording change.
 * The store is the fact. `null` means nothing new — which is not a failure: an
 * account already present is refreshed in place, on its existing slot.
 */
export function newSlot(before, after) {
  const had = new Set(before.slots);
  const fresh = after.slots.filter(s => !had.has(s));
  return fresh.length === 1 ? fresh[0] : null;
}

/**
 * Anthropic's own view of who is signed in. Null when it cannot be read.
 *
 * Exported for its test rather than for a caller (#383). Both callers are inside
 * the login flow and neither can show what was parsed: `spawnLogin` keeps only
 * `identity?.email` as the address to restore to, and `submitLoginCode` turns
 * the whole thing into a pass/fail — a null there is the difference between a
 * sign-in the deck accepts and one it reports as "signed in, but the claude CLI
 * still reports nobody logged in". The success path, where the email read here
 * is what matches the new credential to a cswap slot, is reachable only with a
 * real signed-in CLI on the machine running the suite. See
 * cswap-identity.test.ts.
 */
export async function currentIdentity() {
  const r = await run(await claudeBin(), ["auth", "status", "--json"], { timeout: 20_000 });
  if (!r.ok) return null;
  try {
    const j = JSON.parse(r.stdout);
    return j?.loggedIn ? { email: j.email ?? "", orgId: j.orgId ?? "" } : null;
  } catch {
    return null;
  }
}

// ── login ────────────────────────────────────────────────────────────────────

// `claude auth login` prints the link as an OSC-8 hyperlink: ESC ] 8 ; ; <url>
// BEL, then the visible text — which is the same url again — then an empty
// closer. Verified byte for byte against real output: two `\x1b]8;;`, both
// terminated by BEL, never the ESC-backslash form.
//
// So the url appears TWICE, back to back, and a naive /https:\/\/\S+/ captures
// them joined into one unusable string. Stripping the escape sequences takes
// the link target away with them and leaves the visible copy, once.
const OSC8 = /\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripTerminalEscapes(text) {
  return String(text ?? "").replace(OSC8, "").replace(ANSI, "");
}

/** The sign-in URL out of `claude auth login`'s output, or null. */
export function extractLoginUrl(text) {
  const clean = stripTerminalEscapes(text);
  const m = clean.match(/https:\/\/[^\s'"]*\/oauth\/authorize\?[^\s'"]+/);
  return m ? m[0] : null;
}

// The prompt the CLI blocks on. Matched rather than assumed: writing a code
// into a child that is not asking for one would send it somewhere unknown.
const CODE_PROMPT = /paste code here/gi;

/**
 * How many times one line of output asks for the code.
 *
 * Per LINE, not per delivery. The prompt ends without a newline, so exec.mjs
 * re-offers the same unterminated line on every chunk as it grows — and both
 * streams share that buffer, so a progress dot, a `\r` spinner frame on stderr,
 * or simply the prompt split across two writes all arrive as the ask again,
 * a few characters longer. Counting an ask whenever the text merely CHANGED, as
 * this used to, turned any of those into a phantom second prompt, and a second
 * prompt is exactly how submitLoginCode hears "that code was rejected": a
 * login the CLI was busy completing came back as `code_rejected`, with the
 * account unregistered and the live credentials left switched.
 *
 * A real re-ask writes the prompt again — on a fresh line, or after a `\r`
 * redraw of this one — so it shows up as another match, not as a longer tail.
 */
export function countCodePrompts(line) {
  return (stripTerminalEscapes(line).match(CODE_PROMPT) ?? []).length;
}

/**
 * The whole login, as one object, because the browser talks to it twice: once
 * to start and get a URL, once to hand back the code.
 *
 * `previousActive` is captured before anything happens. `cswap add` sets
 * activeAccountNumber to whatever it just added, so without this the machine
 * silently changes account underneath every running session.
 */
let _login = null;

// A start that has not published its flow yet.
//
// `_login` is only assigned once the child exists, and everything before that
// awaits — a store read, then `claude auth status`, which shells out and takes
// hundreds of milliseconds. Two requests overlapping inside that window (two
// tabs, or a double-submitted POST) therefore both read `_login` as null, both
// walked past the guards below, and both spawned `claude auth login`. Only the
// later assignment stayed reachable, so the other child — holding an open OAuth
// flow and an open stdin — was beyond cancelLogin and beyond the dialog's
// Escape, and ran on invisibly until its five-minute timeout. Concurrent starts
// share the one spawn instead, the promise guard ccusage.mjs uses to share an
// install.
let _starting = null;

export function loginState() {
  if (!_login) return { state: "idle" };
  const { state, url, error, account, expiresAt } = _login;
  return { state, url: url ?? null, error: error ?? null, account: account ?? null, expiresAt: expiresAt ?? null };
}

/**
 * What an address may be made of before it becomes an argv element.
 *
 * NOT AN RFC 5322 PARSER, and it should not be read as one. RFC 5322 permits
 * quoted local parts, spaces inside them, comments in parentheses and bracketed
 * address literals; a regex that accepted all of that would accept precisely the
 * shapes this exists to keep out. The job here is narrower and worth stating
 * plainly: keep a FLAG-SHAPED or WHITESPACE-BEARING string out of a spawn's
 * argument vector. Anything it wrongly refuses is an address nobody has ever
 * typed into this dialog; anything it wrongly accepts is inert as an argument,
 * which is the only property being defended. Whether the address exists is
 * Anthropic's question, asked a moment later by the CLI itself.
 *
 * `--email` was the field the alias allowlist below missed. `email.includes("@")`
 * was the whole of its validation and the value came straight off the request
 * body, so the two residuals exec.mjs documents were both reachable through it
 * on Windows, where `claude` is a `.cmd` shim and the vector goes through
 * `cmd.exe /d /s /c`: an interior newline is a command separator inside that one
 * quoted line, and `%USERPROFILE%` expands inside quotes with no escape
 * available. `"a@b\ncalc.exe"` and `"%USERPROFILE%@x"` both satisfy
 * `includes("@")`, and both are payloads alias-charset.test.ts already pins as
 * refused for the other field.
 *
 * The leading-character rule is the same argv-position rule ALIAS_OK now carries.
 * `-x@y.z` starts with a dash, so a child parser reads it as an option rather
 * than as the value of `--email`, and what happens next depends entirely on
 * which options that CLI happens to define.
 */
const EMAIL_OK =
  /^[A-Za-z0-9][A-Za-z0-9._%+-]{0,63}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

// The SMTP forward-path limit. The pattern above bounds each PIECE — 64 for the
// local part, 63 per label — and a domain may carry any number of labels, so
// without this the whole is unbounded. A bound belongs here for the reason
// ALIAS_OK has one: on Windows the value ends up inside a single cmd.exe command
// line, which has a hard length limit of its own.
const EMAIL_MAX_LENGTH = 254;

/**
 * The `--email` value `claude auth login` should be given, or a refusal.
 *
 * Three answers rather than two, and the third is the one that matters: `null`
 * means NO ADDRESS WAS OFFERED, which is the only shape the deck's own dialog
 * sends (`AddAccountDialog` posts a bare `{action:"login"}`) and which must stay
 * an ordinary sign-in with no flag appended. A value that is present and
 * unusable is refused outright instead of being quietly dropped: dropping it
 * would run a DIFFERENT sign-in from the one that was asked for and call it a
 * success, and this route is reachable by anything holding the deck token.
 */
function loginEmailArg(email) {
  if (email == null) return { ok: true, email: null };
  if (typeof email !== "string") return { ok: false };
  const clean = email.trim();
  if (!clean) return { ok: true, email: null };
  if (clean.length > EMAIL_MAX_LENGTH || !EMAIL_OK.test(clean)) return { ok: false };
  return { ok: true, email: clean };
}

export async function startLogin({ email } = {}) {
  // Argv position is settled first, before any state moves. A refusal here must
  // not cancel a sign-in that is already running — the caller asked for
  // something the deck will not do, and the flow already in flight is not part
  // of that bargain.
  const wanted = loginEmailArg(email);
  if (!wanted.ok) return { ok: false, reason: "bad_email", ...loginState() };
  // Registering is the half that writes to the store; interrupting it would
  // leave an account half-recorded, so that one is refused. A flow merely
  // waiting for a code is not precious — it is most often the one abandoned by
  // the page reload that just happened — and it yields to the new request
  // rather than blocking it for the rest of its five minutes.
  if (_login?.state === "registering") {
    return { ok: false, reason: "already_running", ...loginState() };
  }
  if (_login?.state === "awaiting_url" || _login?.state === "awaiting_code") {
    await cancelLogin();
  }
  if (!_starting) {
    _starting = spawnLogin(wanted.email).finally(() => { _starting = null; });
  }
  const flow = await _starting;

  // The URL arrives on the child's first write, typically within a second — and
  // the child's death ends the wait just as conclusively, which is why the state
  // is polled beside it. A `claude` that cannot be run at all is gone in
  // milliseconds and the done handler below has already written down why, but
  // waiting only for a url meant this POST sat open for the whole fifteen
  // seconds afterwards: a spinner in front of a user whose answer was ready
  // almost immediately.
  await waitFor(() => flow.url || flow.state === "failed" || flow.state === "done", 15_000);
  // A sign-in that got somewhere without a link this could read is still a
  // sign-in, and since #708 the done handler can carry one all the way to
  // `done` on its own. Saying "no url" over that would throw a completed login
  // away at the last step, which is the whole of the bug being fixed.
  if (!flow.url && (flow.state === "registering" || flow.state === "done")) {
    return { ok: true, ...loginState() };
  }
  if (!flow.url) {
    flow.child.kill();
    // Same identity check as the done handler below, and for a sharper reason:
    // a second startLogin cancels this one's child (the yield path above), so
    // this url can never arrive and this wait always runs its full fifteen
    // seconds. Overwriting _login then would erase a live flow — the dialog
    // would flip to "failed" while the newer child is still waiting for a code
    // that can no longer be delivered, and with its handle gone not even
    // cancelLogin could reach it.
    //
    // A flow the child's own death already explained keeps that explanation:
    // failureText turns an unrunnable CLI into "not on PATH. Set
    // AGENTS_DECK_CLAUDE to its full path.", the only sentence in the whole flow
    // that names a fix, and publishing a guess about the missing link over it
    // destroyed it on the server.
    const died = flow === _login && flow.state === "failed" ? flow.error : null;
    if (flow === _login && !died) {
      _login = { state: "failed", error: "the claude CLI did not print a sign-in link" };
    }
    // Carried as `detail` because that is the only field that outranks the
    // reason in the dialog's say(): REASONS["no_url"] asks "is it installed?",
    // which is exactly the question the sentence above has already answered, and
    // it would win over `error`.
    return { ok: false, reason: "no_url", ...(died ? { detail: died } : {}), ...loginState() };
  }
  return { ok: true, ...loginState() };
}

/**
 * Start the child and publish it, as one indivisible step.
 *
 * Separate from startLogin so `_starting` can dedupe it: everything here runs
 * before `_login` exists, and a caller that reaches it a second time
 * concurrently would spawn a sign-in nothing can cancel.
 */
async function spawnLogin(email) {
  const before = await readStore();
  const identity = await currentIdentity();

  const args = ["auth", "login"];
  // Already through loginEmailArg, which is the only caller's boundary: this is
  // either an address that cannot be read as a flag or null, and null is the
  // ordinary case.
  if (email) args.push("--email", email);

  const child = runInteractive(await claudeBin(), args, { timeout: LOGIN_TIMEOUT_MS });
  // A sign-in outlives the request that started it, so it can also outlive the
  // deck. Nothing else would ever reap it: it is waiting on a stdin that no
  // longer has a writer, and it holds the user's next attempt hostage for five
  // minutes. Killed on the way out, and unregistered as soon as it settles so
  // the handler list cannot grow.
  const onExit = () => { try { child.kill(); } catch { /* already gone */ } };
  process.on("exit", onExit);
  child.done.then(() => process.off("exit", onExit), () => process.off("exit", onExit));

  _login = {
    state: "awaiting_url",
    child,
    previousActive: before.activeNum,
    previousEmail: identity?.email ?? null,
    before,
    url: null,
    error: null,
    account: null,
    expiresAt: Date.now() + LOGIN_TIMEOUT_MS,
    // How many times the CLI has asked for a code. A second ask after we
    // answered is how a rejected code announces itself — the process does not
    // exit, it just asks again, so waiting for exit would hang for the whole
    // five-minute window on a typo.
    prompts: 0,
  };
  const flow = _login;

  // How many asks the line currently being written has already contributed.
  // The prompt is an unterminated line, re-delivered as it grows, so the same
  // ask arrives over and over — and once more, whole, when something else
  // finally ends the line.
  let countedOnLine = 0;

  child.onLine((line, partial) => {
    if (!flow.url) {
      const url = extractLoginUrl(line);
      if (url) { flow.url = url; flow.state = "awaiting_code"; }
    }
    const asks = countCodePrompts(line);
    if (asks > countedOnLine) {
      flow.prompts += asks - countedOnLine;
      countedOnLine = asks;
    }
    // A newline ended that line; whatever comes next is a new one.
    if (!partial) countedOnLine = 0;
  });
  // The child ending before a code was pasted USED to be read as a failure, and
  // on this CLI that is the ordinary end of a sign-in that worked (#708).
  //
  // `claude auth login` 2.1.246 does two things at once: it prints
  // "Paste code here if prompted > " and blocks on stdin, AND it listens on a
  // loopback port for the OAuth callback. Which half finishes the exchange is
  // not decided by the CLI's version — it is decided by whether the browser
  // that opened can reach this machine's loopback. On the deck's own machine it
  // can, so the CLI takes the code itself, prints "Login successful." and exits
  // 0 while the deck is still sitting in `awaiting_code`; the page that
  // authorised says "You're all set up" and never shows a code to paste. On a
  // deck reached from another machine it cannot, the page shows the code, and
  // the paste path below is the one that runs.
  //
  // So the exit alone is not the verdict. The verdict is the identity, and
  // `claude auth status --json` is the oracle this module already trusts for
  // it — asked here against the identity recorded before the flow started.
  child.done.then(async (r) => {
    if (flow !== _login) return;
    if (flow.state !== "awaiting_url" && flow.state !== "awaiting_code") return;
    // Answered before any await, so that a `claude` which cannot be run at all
    // is still reported within milliseconds: startLogin waits on this state to
    // decide whether to keep holding its POST open, and the sentence naming
    // AGENTS_DECK_CLAUDE is the only one in the flow that names a fix. Nothing
    // was signed in either way, so there is nothing to ask about.
    if (r.timedOut || cannotRun(r)) {
      flow.state = "failed";
      flow.error = loginFailureText(r);
      return;
    }
    // Claimed before asking, for the same reason submitLoginCode claims it: a
    // code posted while the question is out would otherwise register the same
    // login a second time, with a second `cswap add` racing this one.
    flow.state = "registering";
    const identity = await currentIdentity();
    if (flow !== _login) return;
    // A clean exit with somebody logged in is a completed sign-in, including
    // the re-sign-in of an account the deck already holds — an identity that
    // did not CHANGE is not an identity that did not arrive. A dirty exit
    // counts only when the identity moved, which is a login that landed in
    // spite of whatever the CLI complained about on its way out.
    if (identity && (r.ok || identity.email !== flow.previousEmail)) {
      await registerSignedIn(flow, identity);
      return;
    }
    flow.state = "failed";
    flow.error = loginFailureText(r);
  }).catch((err) => {
    // This handler answers nobody's request — its promise is dropped — so a
    // throw anywhere in it would be an unhandled rejection AND a dialog left
    // spinning on `registering` until the poll gave up. It was three lines of
    // synchronous assignment before; it now shells out twice.
    console.error(`${PRODUCT} sign-in: the sign-in could not be finished:`, err?.message ?? err);
    if (flow !== _login) return;
    flow.state = "failed";
    flow.error = "the sign-in could not be finished — see the deck's log";
  });
  return flow;
}

/** A run that never reached the CLI at all — nothing can have been signed in. */
function cannotRun(r) {
  return r?.code === "ENOENT" || looksMissing(`${r?.stderr ?? ""}\n${r?.stdout ?? ""}`, "", r?.code);
}

/**
 * Why a sign-in failed, in words meant for the person who pressed the button.
 *
 * The child's own output is offered only when it is a diagnosis — see
 * failureText, which since #708 refuses a line that announces success or is
 * merely the prompt the CLI was still sitting on. What it printed is not thrown
 * away; it goes to the deck's log, where an operator can read it, rather than
 * onto a dialog as the reason.
 */
function loginFailureText(r) {
  // One line, the way ccusage's `note` says everything it says: an operator
  // watching the terminal is reading it beside the deck's own repainted status
  // rows, and the escapes in it are a login link's OSC-8 wrapper.
  //
  // stderr goes LAST because the line is cut from the front. What should be
  // lost to the bound is the CLI's chatter — the greeting and a sign-in link
  // that is 400 characters by itself — never its complaint.
  const tail = stripTerminalEscapes(`${r?.stdout ?? ""}\n${r?.stderr ?? ""}`).replace(/\s+/g, " ").trim();
  if (tail) console.error(`${PRODUCT} sign-in: claude auth login did not complete:`, tail.slice(-300));
  if (r?.timedOut) return "the sign-in window expired";
  return failureText(r, "claude auth login", "the sign-in did not complete — nothing new was signed in");
}

/**
 * Everything after the sign-in itself: confirm who we are now, record it with
 * claude-swap, and put the previously-active account back in front.
 *
 * Shared by the two ways a sign-in can end (#708) — a code pasted into the
 * prompt, and the CLI finishing the exchange through its own loopback callback
 * — because the steps after it are identical and have to stay identical. An
 * account the deck skipped `cswap add` for is signed in at the CLI level and
 * invisible to the panel, with the account the user was on left switched away
 * from.
 *
 * Returns the same `{ok, ...loginState()}` both callers answer their request
 * with; the done handler simply drops it.
 */
async function registerSignedIn(flow, identity) {
  return withStoreLock(async () => {
    const add = await run(await cswapBin(), ["add"], { timeout: CSWAP_TIMEOUT_MS });
    if (!add.ok) {
      flow.state = "failed";
      flow.error = addFailureText(add);
      await restoreActive(flow.previousActive);
      return { ok: false, reason: "add_failed", ...loginState() };
    }

    const after = await readStore();
    const slot = newSlot(flow.before, after);
    // No new slot means the account was already managed and cswap refreshed its
    // credentials in place. That is a success with a different sentence.
    const num = slot ?? Object.keys(after.emails).find(k => after.emails[k] === identity.email) ?? null;

    await restoreActive(flow.previousActive);
    invalidateClaudeAccountsCache();
    // Collect straight away, so the new row shows numbers instead of "never
    // collected" until the next poll — the same nudge seedFirstAccount uses.
    runDetached(await cswapBin(), ["list"]);

    flow.state = "done";
    flow.account = { num, email: identity.email, added: slot != null };
    return { ok: true, ...loginState() };
  });
}

/**
 * Hand the code back, then register whatever it signed us in as.
 *
 * Every step after the code is verification, not optimism: the CLI can exit 0
 * having changed nothing, so the identity is re-read and compared before the
 * store is touched at all.
 */
export async function submitLoginCode(code) {
  const flow = _login;
  if (!flow || flow.state !== "awaiting_code") return { ok: false, reason: "not_waiting", ...loginState() };
  if (typeof code !== "string" || !code.trim()) return { ok: false, reason: "empty_code", ...loginState() };
  if (flow.prompts === 0) return { ok: false, reason: "not_prompted", ...loginState() };

  const askedBefore = flow.prompts;
  flow.state = "registering";
  flow.child.write(code.trim() + "\n");

  // Whichever comes first: the CLI finishing, or it asking again. A wrong code
  // produces the second, and the flow stays usable so the user can retype
  // rather than starting the whole sign-in over.
  const r = await Promise.race([
    flow.child.done,
    waitFor(() => flow.prompts > askedBefore, CODE_VERDICT_MS, 200).then(again => (again ? "rejected" : "slow")),
  ]);
  if (r === "rejected") {
    flow.state = "awaiting_code";
    flow.error = "that code was not accepted — copy it again from the browser";
    return { ok: false, reason: "code_rejected", ...loginState() };
  }
  if (r === "slow") {
    flow.state = "awaiting_code";
    flow.error = "the claude CLI has not answered — try the code again";
    return { ok: false, reason: "no_verdict", ...loginState() };
  }
  if (!r.ok) {
    flow.state = "failed";
    // The `|| "the code was not accepted"` this used to end with could never
    // run: failureText always answered with something, if only an exit status.
    // The sentence is where it can be reached now — as the fallback failureText
    // reaches for when the CLI printed nothing worth repeating.
    flow.error = r.timedOut ? "the sign-in window expired" : failureText(r, "claude auth login", "the code was not accepted");
    return { ok: false, reason: "login_failed", ...loginState() };
  }

  const identity = await currentIdentity();
  if (!identity) {
    flow.state = "failed";
    flow.error = "signed in, but the claude CLI still reports nobody logged in";
    return { ok: false, reason: "no_identity", ...loginState() };
  }

  return registerSignedIn(flow, identity);
}

export async function cancelLogin() {
  const flow = _login;
  if (!flow) return { ok: true, ...loginState() };
  // Stopping the child touches no file, so it happens straight away: a cancel
  // that waited its turn first would leave `claude auth login` sitting on the
  // user's next attempt for the rest of its five minutes.
  try { flow.child?.kill(); } catch { /* already gone */ }
  // Switching back does touch the store, so it is queued like every other
  // mutation. Cancel is reachable while submitLoginCode holds the lock — the
  // dialog fires it on Escape, mid-registration — and running `cswap switch`
  // beside an in-flight `cswap add` is precisely the unlocked read-modify-write
  // of sequence.json the mutex exists to prevent: claude-swap takes no file lock
  // around `add`, so whichever write lands second drops the other's record.
  return withStoreLock(async () => {
    // The login may have completed before the cancel arrived, in which case the
    // live credentials already moved and putting them back is the point.
    await restoreActive(flow.previousActive);
    invalidateClaudeAccountsCache();
    // A newer sign-in can have started while this waited its turn; clearing the
    // slot then would drop a live flow's handle instead of this dead one's.
    if (flow === _login) _login = null;
    return { ok: true, ...loginState() };
  });
}

/** Put the account that was active before the login back in front. */
async function restoreActive(num) {
  if (num == null) return;
  const after = await readStore();
  if (String(after.activeNum) === String(num)) return;
  await run(await cswapBin(), ["switch", String(num)], { timeout: 30_000 }).catch(() => {});
}

// ── share / import ───────────────────────────────────────────────────────────

/**
 * One account, packaged for another deck.
 *
 * claude-swap's envelope carries the account's OAuth token in the clear — its
 * own module header says so ("No encryption is built in"). The wrapper adds an
 * expiry so a copy left behind in clipboard history stops working, and nothing
 * more: it is not encryption and is not presented as any.
 *
 * Say the limit of that out loud, because the UI used to imply the opposite.
 * `exp` is a plain number inside plain base64'd JSON with NO key, MAC or
 * signature over it, so anyone holding the text can decode it, write a later
 * `exp`, re-encode, and import it. unwrapShare's check is therefore a check
 * against staleness, not against an adversary — and it cannot be made into one
 * here. A MAC needs a secret both decks hold, and two decks that already shared
 * a secret would not need this function; and even a perfect signature would
 * only stop THIS import path, since the payload it wraps is the credential
 * itself and `cswap import` accepts it unwrapped. The honest fix for a share
 * that got away is to sign the account out and back in. See share-expiry-
 * forgeable.test.ts, which pins the forgery rather than leaving it implied.
 *
 * The default export shape is used deliberately, never --full, which would
 * embed the entire ~/.claude.json including every project and MCP server.
 */
export function wrapShare(payload, now = Date.now(), ttlMs = SHARE_TTL_MS) {
  const body = JSON.stringify({ v: 1, exp: now + ttlMs, payload });
  const packed = brotliCompressSync(Buffer.from(body, "utf8"), {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
  });
  return SHARE_PREFIX + packed.toString("base64");
}

/**
 * The inverse, for either prefix. Returns `{ok:true, payload}` or
 * `{ok:false, reason}`.
 *
 * `v` inside the envelope is unchanged at 1 and deliberately so: it versions
 * the SHAPE of the envelope, and that shape did not change. The prefix versions
 * the encoding. Folding the two would have made an old blob unreadable for no
 * reason, since its contents are exactly what this still expects.
 */
export function unwrapShare(blob, now = Date.now()) {
  const text = String(blob ?? "").trim();
  const v2 = text.startsWith(SHARE_PREFIX);
  if (!v2 && !text.startsWith(SHARE_PREFIX_V1)) return { ok: false, reason: "not_a_share" };
  let env;
  try {
    // Sliced by the prefix that actually matched. The two are the same length
    // today and writing it this way is what keeps that from being load-bearing.
    const bytes = Buffer.from(text.slice((v2 ? SHARE_PREFIX : SHARE_PREFIX_V1).length), "base64");
    // maxOutputLength is the whole reason a bounded decompress is safe to point
    // at pasted text; without it a short blob can name an allocation that ends
    // the process.
    const body = v2
      ? brotliDecompressSync(bytes, { maxOutputLength: SHARE_MAX_BYTES })
      : bytes;
    env = JSON.parse(body.toString("utf8"));
  } catch {
    return { ok: false, reason: "corrupt" };
  }
  if (env?.v !== 1) return { ok: false, reason: "wrong_version" };
  // Checked before the payload is looked at, let alone handed to cswap.
  if (typeof env.exp !== "number" || env.exp < now) return { ok: false, reason: "expired" };
  if (typeof env.payload !== "string" || !env.payload) return { ok: false, reason: "corrupt" };
  return { ok: true, payload: env.payload };
}

/**
 * claude-swap's own identity for an account, as one comparable string.
 *
 * `(email, organizationUuid)`, which is the composite `transfer.py` keys its
 * duplicate check and its already-here check on. Matching on the address alone
 * would fold one address's two organizations into a single row, and the whole
 * reason cswap carries the org is that they are two accounts.
 *
 * The address is lower-cased because both sides of every comparison here come
 * from the same store or the same bundle, so folding case can only join what a
 * human would call the same account, never split one.
 */
export function identityKey(email, org) {
  return `${String(email ?? "").trim().toLowerCase()} ${String(org ?? "")}`;
}

/**
 * N single-account envelopes, folded into the one bundle cswap will take back.
 *
 * `cswap export --account` names ONE account, so a chosen subset cannot come
 * out of a single call and the deck has to do the folding. It is deliberately
 * not a new format: the head envelope is spread whole and only `accounts` and
 * `activeAccountNumber` are replaced, so `version`, `exportedFrom`,
 * `swapVersion` and any field a later claude-swap adds arrive on the far side
 * exactly as that claude-swap wrote them. Nothing here hard-codes its
 * FORMAT_VERSION, because a constant copied out of another project's source is
 * a constant that drifts.
 *
 * `activeAccountNumber` is re-guarded rather than carried: cswap only records
 * it when that slot is in the payload, and a subset can drop the slot the head
 * envelope pointed at. An import that referenced a missing account would be
 * seeding an active slot that never arrived.
 *
 * A duplicate identity is DROPPED rather than passed on. `import_accounts`
 * refuses a whole envelope over one repeated `(email, org)` pair, so carrying
 * it would trade five shared accounts for a bundle that imports none.
 */
export function mergeExports(texts) {
  const envelopes = [];
  for (const text of texts) {
    let env;
    try { env = JSON.parse(text); } catch { return { ok: false, reason: "unreadable_export" }; }
    if (!env || typeof env !== "object" || !Array.isArray(env.accounts)) {
      return { ok: false, reason: "unreadable_export" };
    }
    envelopes.push(env);
  }
  if (!envelopes.length) return { ok: false, reason: "nothing_to_share" };

  const head = envelopes[0];
  // Every part came out of one binary in one pass, so a disagreement here is
  // not a version to reconcile - it is a sign the parts are not what we think.
  if (envelopes.some(e => e.version !== head.version)) return { ok: false, reason: "mixed_versions" };

  const accounts = [];
  const dropped = [];
  const seen = new Set();
  for (const env of envelopes) {
    for (const a of env.accounts) {
      const key = identityKey(a?.email, a?.organizationUuid);
      if (seen.has(key)) { dropped.push({ num: String(a?.number ?? ""), email: a?.email ?? "" }); continue; }
      seen.add(key);
      accounts.push(a);
    }
  }
  if (!accounts.length) return { ok: false, reason: "nothing_to_share" };

  const nums = new Set(accounts.map(a => String(a?.number ?? "")));
  const active = envelopes
    .map(e => e.activeAccountNumber)
    .find(n => n != null && nums.has(String(n)));
  return {
    ok: true,
    dropped,
    envelope: { ...head, activeAccountNumber: active ?? null, accounts },
  };
}

/**
 * One account, or several, packaged for another deck.
 *
 * claude-swap's envelope carries each account's OAuth token in the clear - its
 * own module header says so ("No encryption is built in"). The wrapper adds an
 * expiry so a copy left behind in clipboard history stops working, and nothing
 * more: it is not encryption and is not presented as any. A bundle makes that
 * larger, not different - five accounts is five tokens on the clipboard -
 * which is why the dialog states the count before the copy rather than after.
 *
 * Say the limit of the expiry out loud, because the UI used to imply the
 * opposite. `exp` is a plain number inside plain base64'd JSON with NO key, MAC
 * or signature over it, so anyone holding the text can decode it, write a later
 * `exp`, re-encode, and import it. unwrapShare's check is therefore a check
 * against staleness, not against an adversary - and it cannot be made into one
 * here. A MAC needs a secret both decks hold, and two decks that already shared
 * a secret would not need this function; and even a perfect signature would
 * only stop THIS import path, since the payload it wraps is the credential
 * itself and `cswap import` accepts it unwrapped. The honest fix for a share
 * that got away is to sign the account out and back in. See share-expiry-
 * forgeable.test.ts, which pins the forgery rather than leaving it implied.
 *
 * Only the accounts asked for are exported. Reading the whole store and then
 * dropping the unwanted rows would be one spawn instead of several, and it
 * would pull a refresh token this deck was never asked to move into this
 * process; it would also lose the failure, because a whole-store export skips a
 * slot with no backup credentials in silence while `--account` on that slot is
 * a hard error naming it. A count that is quietly short is the one outcome a
 * share must never have.
 *
 * The default export shape is used deliberately, never --full, which would
 * embed the entire ~/.claude.json including every project and MCP server.
 */
export async function shareAccounts(nums) {
  const asked = Array.isArray(nums) ? nums : [nums];
  // One spawn per account, so the length of this list is a length of time the
  // request holds. A store never has fifty accounts; a caller that sends nine
  // hundred numbers is not a person picking from a panel, and the ceiling
  // costs nothing to the one who is.
  if (asked.length > MAX_SHARE_ACCOUNTS) return { ok: false, reason: "too_many" };
  const wanted = [];
  for (const raw of asked) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 999) return { ok: false, reason: "bad_account" };
    if (!wanted.includes(n)) wanted.push(n);
  }
  if (!wanted.length) return { ok: false, reason: "bad_account" };

  // Names for the accounts that fail, read from the store before anything is
  // spawned - because the failure sentence must never be built from the
  // export's own output.
  const store = await readStore();
  const texts = [];
  const failed = [];
  for (const n of wanted) {
    const r = await run(await cswapBin(), ["export", "-", "--account", String(n)], { timeout: CSWAP_TIMEOUT_MS });
    if (!r.ok || !r.stdout.trim()) {
      // The failure sentence is built from stderr ALONE for this one command,
      // because its stdout is the credential. `failureText` concatenates
      // `${stderr}\n${stdout}` and `firstUseful` takes the LAST non-empty line -
      // right for every other cswap command, and here it means any stdout at all
      // outranks the real error. claude-swap writes its diagnostics to stderr
      // specifically so stdout stays pure JSON in pipe mode, and it writes the
      // envelope as its last act; a non-zero exit after a partial write would
      // therefore put the tail of `json.dumps(envelope, indent=2)` in front of the
      // user, and one of those lines is the refresh token on its own.
      //
      // Nothing is lost by dropping it: the ENOENT branch keys off `r.code`, which
      // `run` sets, and cmd.exe's "is not recognized" is stderr's.
      failed.push({
        num: String(n),
        email: store.emails?.[String(n)] || "",
        detail: failureText({ ...r, stdout: "" }, "cswap export"),
      });
      continue;
    }
    texts.push(r.stdout);
  }

  // Nothing came out at all. There is no partial bundle to hand over, so this
  // is the plain failure the single-account share has always reported.
  if (!texts.length) {
    return { ok: false, reason: "export_failed", detail: failed[0]?.detail ?? "", failed };
  }

  const merged = mergeExports(texts);
  if (!merged.ok) return { ok: false, reason: merged.reason, failed };
  for (const d of merged.dropped) {
    failed.push({ ...d, detail: "another slot already holds this address in this organization" });
  }

  const shared = merged.envelope.accounts.map(a => ({ num: String(a?.number ?? ""), email: a?.email ?? "" }));
  return {
    ok: true,
    blob: wrapShare(JSON.stringify(merged.envelope)),
    expiresAt: Date.now() + SHARE_TTL_MS,
    // What the bundle CARRIES, never what was asked for. The copy row counts
    // this list, so a bundle that came up short says so.
    shared,
    failed,
  };
}


/**
 * The identities a bundle carries, or `[]` when it cannot be read.
 *
 * The payload is the credential, so this takes the two fields it needs and
 * nothing else: no caller ever receives the parsed envelope, and a bundle that
 * will not parse degrades to an unnamed import rather than to an error, since
 * cswap is the one entitled to refuse it.
 */
export function bundleAccounts(payload) {
  let env;
  try { env = JSON.parse(payload); } catch { return []; }
  if (!env || typeof env !== "object" || !Array.isArray(env.accounts)) return [];
  const out = [];
  for (const a of env.accounts) {
    if (!a || typeof a !== "object") continue;
    const email = typeof a.email === "string" ? a.email.trim() : "";
    if (!email) continue;
    out.push({ email, org: typeof a.organizationUuid === "string" ? a.organizationUuid : "" });
  }
  // All of them or none. `wanted` is what the result list counts against, so a
  // bundle read as three when it holds four reports "1 of 3 imported" about a
  // paste of four - the missing one arrives and is never named, and a non-empty
  // list keeps the store-diff fallback from running to catch it. claude-swap
  // itself refuses an envelope whose entry has no address, so this is a guard
  // against a shape neither project has today rather than a live case.
  return out.length === env.accounts.length ? out : [];
}

/**
 * The same bundle, cut down to one account.
 *
 * What "update anyway" sends. `--force` overwrites every account it matches, so
 * a forced import of the whole bundle would rewrite credentials the user never
 * pointed at; narrowing first is what keeps an overwrite a named act. Written
 * as a filter over the original envelope rather than a fresh one, for the same
 * reason mergeExports spreads its head: those fields belong to claude-swap.
 */
export function narrowBundle(payload, key) {
  let env;
  try { env = JSON.parse(payload); } catch { return { ok: false, reason: "corrupt" }; }
  if (!env || typeof env !== "object" || !Array.isArray(env.accounts)) return { ok: false, reason: "corrupt" };
  const accounts = env.accounts.filter(a => identityKey(a?.email, a?.organizationUuid) === key);
  if (!accounts.length) return { ok: false, reason: "not_in_bundle" };
  const nums = new Set(accounts.map(a => String(a?.number ?? "")));
  const active = env.activeAccountNumber != null && nums.has(String(env.activeAccountNumber))
    ? env.activeAccountNumber
    : null;
  return { ok: true, payload: JSON.stringify({ ...env, activeAccountNumber: active, accounts }) };
}

/**
 * What happened to each account in the bundle, decided by the store.
 *
 * The store is the fact. `cswap import` narrates itself per account on stderr,
 * and parsing that as the primary answer would make a reworded release report
 * imports that did not happen - the failure mode `newSlot` already refuses for
 * the same reason. So the slot map before and after the run decides the two
 * outcomes that matter: an identity holding a slot it did not hold arrived, and
 * one absent from both never came.
 *
 * stderr is then read for one thing only, and one no store diff can show: an
 * account already present whose credentials were REWRITTEN in place, which
 * moves no slot. `Replaced` is claude-swap's dead-token auto-heal (its #136),
 * `Overwrote` is a `--force`. If either line is ever reworded the nuance is
 * lost and the row reads "already here", which is still true - the degradation
 * is a less specific report, never a wrong one.
 *
 * And it is applied ONLY where the address names exactly one row in the bundle.
 * cswap's line carries no organization, so with one address held under two of
 * them a single `Replaced me@x.com` would mark both rows healed and one of
 * those would be false - which is the thing the paragraph above promises this
 * never does.
 */
export function importOutcomes(before, after, wanted, stderr = "") {
  const slotsBy = (store) => new Map(
    (store?.slots ?? []).map(s => [identityKey(store?.emails?.[s], store?.orgs?.[s]), s]),
  );
  const had = slotsBy(before);
  const now = slotsBy(after);

  // How many rows in this bundle share each address. An address held twice is
  // an address cswap's own narration cannot resolve.
  const byAddress = new Map();
  for (const w of wanted) {
    const a = String(w.email ?? "").trim().toLowerCase();
    byAddress.set(a, (byAddress.get(a) ?? 0) + 1);
  }
  const rewritten = new Map();
  for (const line of String(stderr ?? "").split(/\r?\n/)) {
    const m = /^\s*(Replaced|Overwrote)\s+(\S+)/.exec(line);
    if (!m) continue;
    const addr = String(m[2]).trim().toLowerCase();
    if ((byAddress.get(addr) ?? 0) !== 1) continue;
    rewritten.set(addr, m[1] === "Replaced" ? "healed" : "updated");
  }

  return wanted.map(w => {
    const key = identityKey(w.email, w.org);
    const wasHere = had.has(key);
    const slot = now.get(key) ?? null;
    if (!wasHere && slot != null) return { email: w.email, org: w.org, num: slot, state: "imported" };
    if (wasHere) {
      return {
        email: w.email,
        org: w.org,
        num: had.get(key),
        state: rewritten.get(String(w.email ?? "").trim().toLowerCase()) ?? "present",
      };
    }
    return { email: w.email, org: w.org, num: null, state: "failed" };
  });
}

/**
 * A share, or a bundle of them, taken into this deck's store.
 *
 * Non-destructive by default and deliberately so: without `--force` claude-swap
 * adds what is missing, leaves a healthy account exactly as it is, and replaces
 * only a slot its own usage row has quarantined as refresh-token-dead. That is
 * already the rule a person would ask for - leave what works, fix what does
 * not - so the default run never passes the flag.
 *
 * `force` is honoured ONLY together with `only`, which names a single account.
 * A forced import of a whole bundle would rewrite every matching credential on
 * this machine, and a fresh token replaced by a stale one is not recoverable
 * from here - the fix is a re-login. Requiring the pair is what makes the
 * clobber something a person chose while looking at the address.
 */
export async function importAccount(blob, { force = false, only = null } = {}) {
  const un = unwrapShare(blob);
  if (!un.ok) return { ok: false, reason: un.reason };

  let payload = un.payload;
  const narrowing = only != null;
  if (narrowing) {
    const cut = narrowBundle(payload, identityKey(only?.email, only?.org));
    if (!cut.ok) return { ok: false, reason: cut.reason };
    payload = cut.payload;
  }
  const overwrite = force === true && narrowing;
  const wanted = bundleAccounts(payload);

  return withStoreLock(async () => {
    const before = await readStore();
    const args = overwrite ? ["import", "-", "--force"] : ["import", "-"];
    const child = runInteractive(await cswapBin(), args, { timeout: CSWAP_TIMEOUT_MS });
    child.write(payload);
    // cswap reads stdin to EOF, so the pipe has to close for it to proceed.
    //
    // This used to write a raw EOT byte and then call `endStdin(child)` - a
    // helper that was never written. EOT only means end-of-file on a TTY, so
    // the byte did nothing to a pipe, and the call threw ReferenceError before
    // cswap ever saw the payload: the route answered 500 and the dialog fell
    // back to "the import failed", which is exactly what a genuinely refused
    // import says. Reported 2026-08-14.
    child.end();

    const r = await child.done;
    if (!r.ok) return { ok: false, reason: "import_failed", detail: failureText(r, "cswap import") };

    const after = await readStore();
    invalidateClaudeAccountsCache();

    // An unreadable envelope was still imported, or still refused, by cswap -
    // only the naming is lost. Fall back to the store's own new slots so the
    // dialog can say what arrived even then.
    const results = wanted.length
      ? importOutcomes(before, after, wanted, r.stderr)
      : (() => {
          const had = new Set(before.slots ?? []);
          return (after.slots ?? []).filter(s => !had.has(s))
            .map(s => ({ email: after.emails?.[s] || "", org: after.orgs?.[s] || "", num: s, state: "imported" }));
        })();

    const arrived = results.filter(x => x.state === "imported");
    if (arrived.length) runDetached(await cswapBin(), ["list"]);
    return {
      ok: true,
      results,
      // Nothing new is not an error: without --force, cswap skips an account it
      // already holds. Saying which happened is the difference between "it
      // worked" and "why is nothing different".
      added: arrived.length > 0,
      num: arrived.length === 1 ? arrived[0].num : null,
      email: arrived.length === 1 ? arrived[0].email : null,
      output: firstUseful(r.stdout),
    };
  });
}

// ── the small edits ──────────────────────────────────────────────────────────

// The exact question `cswap remove` asks. There is no --yes flag: assume_yes is
// a Python parameter its TUI passes in-process, so the only way through from a
// CLI is to answer. Matched, never assumed — an unrecognised prompt gets the
// child killed instead of a blind "y".
const REMOVE_PROMPT = /are you sure you want to permanently remove account-(\d+)/i;

export function removePromptMatches(line, num) {
  const m = REMOVE_PROMPT.exec(stripTerminalEscapes(line));
  return Boolean(m) && m[1] === String(num);
}

/**
 * Re-capture the active slot's credentials, which is what unfreezes a row whose
 * stored copy died.
 *
 * WHY THIS EXISTS AND WHY IT IS NOT A LOGIN. claude-swap keeps its own copy of
 * each account's credentials, taken when the slot was added. When that copy's
 * refresh token dies it quarantines the row: no further collection is
 * attempted, so the numbers freeze and every Refresh re-reads a store that
 * cannot change. #721 fixed the sentence the panel said about that state; this
 * is the button that ends it.
 *
 * `cswap add` on an account already in the store is an idempotent credential
 * refresh — registerSignedIn above says so in its own words: "No new slot means
 * the account was already managed and cswap refreshed its credentials in
 * place." It captures whatever is signed in RIGHT NOW, which for the active
 * slot is the account the row belongs to, with the working credentials the user
 * already has. Nobody is signed in or out, no browser opens, and the active
 * account does not change.
 *
 * It only ever repairs the ACTIVE slot, because "what is signed in right now"
 * is the only thing `cswap add` can see. The panel offers it nowhere else.
 */
export async function recaptureActive() {
  return withStoreLock(async () => {
    // Who is actually signed in, asked before and after, because `cswap add`
    // captures the live credentials and this is the one check that the thing it
    // captured is the thing the user meant.
    const before = await currentIdentity();
    if (!before?.email) return { ok: false, reason: "not_signed_in" };

    const add = await run(await cswapBin(), ["add"], { timeout: CSWAP_TIMEOUT_MS });
    if (!add.ok) return { ok: false, reason: "add_failed", error: addFailureText(add) };

    invalidateClaudeAccountsCache();
    // AWAITED, NOT DETACHED, AND THAT IS THE WHOLE DIFFERENCE THE PRESS MAKES.
    // `cswap add` clears the strike instantly, so a detached collection left a
    // window where the badge was gone but the numbers were still twenty hours
    // old and the row still said "due" in amber — a press that looked like it
    // had done nothing, which is the complaint this button exists to answer.
    // Waiting costs a few seconds and returns a row that has actually moved.
    //
    // Its failure is not the press's failure: the credentials are captured
    // either way, and claude-swap's own schedule will collect within minutes.
    // So a timeout here still reports success, with `collected: false` for a
    // caller that wants to say so.
    const collect = await run(await cswapBin(), ["list"], { timeout: CSWAP_TIMEOUT_MS })
      .catch(() => null);
    invalidateClaudeAccountsCache();
    return { ok: true, email: before.email, collected: collect?.ok === true };
  });
}

export async function removeAccount(num) {
  const n = Number(num);
  if (!Number.isInteger(n) || n < 1 || n > 999) return { ok: false, reason: "bad_account" };

  return withStoreLock(async () => {
    const child = runInteractive(await cswapBin(), ["remove", String(n)], { timeout: CSWAP_TIMEOUT_MS });
    let answered = false;
    child.onLine((line) => {
      if (answered) return;
      if (removePromptMatches(line, n)) { answered = true; child.write("y\n"); }
    });
    const r = await child.done;
    invalidateClaudeAccountsCache();
    if (!r.ok) return { ok: false, reason: "remove_failed", detail: failureText(r, "cswap remove") };
    // Exit 0 without the prompt means cswap declined for its own reason — a
    // live session on that account, most often — and printed why.
    if (!answered) return { ok: false, reason: "not_confirmed", detail: firstUseful(r.stdout || r.stderr) };
    return { ok: true, output: firstUseful(r.stdout) };
  });
}

/**
 * What an alias may be made of.
 *
 * Every other argument this module sends to cswap is an integer bounded to
 * 1..999; the alias was the one free-text field, and `.trim()` was the whole of
 * its validation. That is fine on POSIX, where `run` spawns the argument vector
 * untouched, and not fine on Windows: cswap is a `.cmd` shim there, so the
 * vector goes through `cmd.exe /d /s /c` (see viaCmd). Quote-doubling handles
 * `"` and every other metacharacter, which leaves exactly the residual exec.mjs
 * documents — `%VAR%` expands inside quotes and a command line has no escape for
 * it — so `%USERPROFILE%` in an alias stored the user's home path, and an alias
 * carrying an unbalanced quote plus an `&` could end the quoted region early.
 * An interior newline survived `.trim()` untouched as well.
 *
 * The same allowlist discipline cswap-auto.mjs already applies to its model
 * list, and it closes the unbounded-length half too: an alias is a short name
 * shown instead of an email, so 64 characters is not a constraint anyone meets
 * by accident.
 *
 * The leading `(?!-)` is the half that allowlist missed, and it is not about
 * quoting at all — it is about ARGV POSITION, which no amount of quoting fixes
 * because the value arrives intact and is then read as syntax by the CHILD.
 * `-` is in the character class, so `--unset` matched, and
 * `setAlias(3, "--unset")` built ["alias", "3", "--unset"] — character for
 * character claude-swap's own command for CLEARING an alias. Its `_alias_command`
 * hands that vector to argparse, which sets `unset=True` and leaves `alias_name`
 * as None; the store dropped the name, cswap printed "Removed alias for
 * Account 3", exited 0, and the deck reported the rename as a success. Any other
 * `-x` spelling is consumed the same way — `-h` prints help and exits 0, which
 * also arrives here as a rename that worked.
 *
 * argparse does honour `--` as an end-of-options separator, so
 * ["alias", "3", "--", "--unset"] would reach `set_alias` as data. It is
 * deliberately not used: the separator only helps for the one child whose parser
 * we can read, `claude auth login` is the other spawn on this route and its
 * parser is not ours to verify, and a value the deck refuses outright cannot be
 * mangled by a CLI that changes its mind later. The validator is the guard.
 *
 * Refusing a leading dash rather than requiring a leading alphanumeric is the
 * narrower rule, and it is the one the hazard actually describes: `.env` and
 * `_work` are ordinary positional arguments to every parser involved, while
 * `acme-corp` — the one dash-bearing name in alias-charset.test.ts's list of
 * names people use — keeps working because only the FIRST character is
 * constrained.
 */
const ALIAS_OK = /^(?!-)[A-Za-z0-9 ._-]{1,64}$/;

export async function setAlias(num, alias) {
  const n = Number(num);
  if (!Number.isInteger(n) || n < 1 || n > 999) return { ok: false, reason: "bad_account" };
  const clean = typeof alias === "string" ? alias.trim() : "";
  if (clean && !ALIAS_OK.test(clean)) return { ok: false, reason: "bad_value" };
  const args = clean ? ["alias", String(n), clean] : ["alias", String(n), "--unset"];
  return withStoreLock(async () => {
    const r = await run(await cswapBin(), args, { timeout: CSWAP_TIMEOUT_MS });
    invalidateClaudeAccountsCache();
    return r.ok
      ? { ok: true, output: firstUseful(r.stdout) }
      : { ok: false, reason: "alias_failed", detail: failureText(r, "cswap alias") };
  });
}

/**
 * What a `cswap move` actually did, read out of the store rather than its words.
 *
 * The panel needs two facts to keep its manage block pointed at the account
 * the user opened it on: which slot that account ended up in, and whether a
 * second account was displaced to make room. `cswap move` does carry both, but
 * not in a line this code can take: a swap prints "Swapped Account 2 and
 * Account 3:" and then one indented roster line per account, and `firstUseful`
 * takes the LAST line of a command's output — right for every other cswap
 * command, and here it hands back "3: someone@example.com" instead of the
 * verdict. The store is the fact, for the same reason `newSlot` reads it after
 * an add rather than parsing what add printed.
 *
 * Claude-swap has three cases — the account is already there, the target slot
 * is free and it relocates, the target is occupied and the two trade places —
 * and all three are legible in what settled: the mover holds the target, and
 * on a swap the occupant holds the slot the mover left. `to` is null when the
 * account is not where it was sent, which is not a case that should happen and
 * is exactly why it is reported rather than assumed.
 */
export function moveOutcome(before, after, num, slot) {
  const from = String(num), to = String(slot);
  const mover = before.emails[from] || "";
  const occupant = before.slots.includes(to) ? (before.emails[to] || "") : null;
  // Identity by email wherever the store has one, occupancy alone where it
  // does not: a blank email cannot tell two accounts apart, and refusing to
  // answer on that account would be worse than answering from the slot.
  const landed = after.slots.includes(to) && (!mover || after.emails[to] === mover);
  const swapped = landed && from !== to && occupant !== null
    && after.slots.includes(from) && (!occupant || after.emails[from] === occupant);
  return { from: Number(num), to: landed ? Number(slot) : null, swapped };
}

export async function moveAccount(num, slot) {
  const n = Number(num), s = Number(slot);
  if (!Number.isInteger(n) || n < 1 || n > 999) return { ok: false, reason: "bad_account" };
  if (!Number.isInteger(s) || s < 1 || s > 999) return { ok: false, reason: "bad_slot" };
  return withStoreLock(async () => {
    // Read first: which slots were taken before the move is the only way to
    // know afterwards whether anyone was standing in the destination.
    const before = await readStore();
    const r = await run(await cswapBin(), ["move", String(n), String(s)], { timeout: CSWAP_TIMEOUT_MS });
    invalidateClaudeAccountsCache();
    if (!r.ok) return { ok: false, reason: "move_failed", detail: failureText(r, "cswap move") };
    return { ok: true, output: firstUseful(r.stdout), ...moveOutcome(before, await readStore(), n, s) };
  });
}

// ── text ─────────────────────────────────────────────────────────────────────

/**
 * What went wrong, in a sentence the user can act on.
 *
 * The missing-tool case is singled out because its own output is useless: on
 * Windows it is cmd.exe's two-line "is not recognized …/operable program or
 * batch file.", and `firstUseful` — which takes the LAST line, correctly for
 * every other CLI — leaves the second half on screen by itself.
 *
 * The exit status goes to looksMissing beside the text (#552). This is the one
 * caller with no candidate spelling to compare against, so the shape rules alone
 * are all the TEXT can offer it — and on a non-English Windows the text says
 * nothing this recognises. The status does: 9009 is cmd.exe's "no such command"
 * in every language. Without it, a German user pressing "share…" got the last
 * line of a translated sentence instead of the sentence about PATH.
 */
export function failureText(r, what = "cswap", fallback = "") {
  const out = `${r?.stderr ?? ""}\n${r?.stdout ?? ""}`;
  const tool = String(what).split(" ")[0];
  if (r?.code === "ENOENT" || looksMissing(out, "", r?.code)) {
    return tool === "claude"
      ? "the claude CLI could not be run: not on PATH. Set AGENTS_DECK_CLAUDE to its full path."
      : "cswap could not be run: not on PATH, and not in the places uv and pipx install to. Set AGENTS_DECK_CSWAP to its full path.";
  }
  // A run its deadline stopped has no exit status worth quoting and no last
  // line worth quoting either — whatever it had printed, it had not finished.
  // Asked for one anyway, this said "cswap export exited 0", a success code for
  // a command that never completed.
  if (r?.timedOut || r?.code === "ETIMEDOUT") return `${what} took too long and was stopped`;
  return diagnosis(r?.stderr) || diagnosis(r?.stdout) || fallback || `${what} exited ${r?.code}`;
}

/**
 * A line that is NOT a diagnosis, however it reached us.
 *
 * Two shapes were being shown to users as the reason something failed (#708),
 * both out of `claude auth login`: the CLI's own "Login successful." — a
 * failure reason containing the word "successful" is not a diagnosis, it is a
 * dump — and "Paste code here if prompted >", the unterminated prompt it was
 * still sitting on, which says that something was ASKED and nothing about
 * anything going wrong.
 */
const NOT_A_DIAGNOSIS = /\bsuccess(?:ful|fully)?\b|[>?]\s*$/i;

/**
 * One stream's last useful line, if it is worth showing a person.
 *
 * Split per stream because the two are not equal: a CLI's diagnosis goes to
 * stderr and its ordinary progress chatter goes to stdout. Reading the LAST
 * line of the two concatenated — which is what this module did — handed stdout
 * the answer whenever it had written anything at all, so `claude auth login`
 * explained itself with the prompt it had printed rather than with the "Login
 * failed: …" it had put on stderr.
 */
function diagnosis(text) {
  const line = firstUseful(text);
  return line && !NOT_A_DIAGNOSIS.test(line) ? line : "";
}

/** The line worth showing a user out of a CLI's output. */
export function firstUseful(text) {
  const lines = stripTerminalEscapes(text)
    .split(/\r?\n/)
    .map(l => l.replace(/^Error:\s*/i, "").trim())
    .filter(l => l && !/^-+$/.test(l));
  return lines.length ? lines[lines.length - 1].slice(0, 300) : "";
}

/**
 * `cswap add`'s failure, in the words most likely to be actionable.
 *
 * The Keychain case is singled out because it is the one a server hits and a
 * terminal does not: a process without a GUI session cannot read the login
 * keychain, so the credential read times out and the message alone
 * ("unreadable right now") does not say what to do.
 */
export function addFailureText(r) {
  const text = firstUseful(r.stderr || r.stdout);
  if (/keychain/i.test(text)) {
    return `${text} — start ${PRODUCT} from a Terminal window rather than a background service.`;
  }
  return failureText(r, "cswap add");
}

async function waitFor(get, timeoutMs, stepMs = 100) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() >= until) return null;
    await new Promise(r => setTimeout(r, stepMs));
  }
}
