// The commands (#2183): `ccdeck accounts`, `ccdeck switch`, `ccdeck usage`,
// `ccdeck sessions` and `ccdeck open` — the deck's Accounts panel and session
// list for somebody who reached the machine over SSH and has no tab to look at.
//
// Shaped like the one-shots (bin/cli/one-shot.js): do the thing, print, exit,
// never start a server. Each one is a CLIENT of the deck already running —
// see src/server/deck-client.mjs for why it has to be, not merely may be — and
// the account commands fall back to claude-swap's store, read in this process,
// only when no deck is up to ask. That fallback is safe for the same reason the
// rule exists: with no deck there is no second writer for the switch to race —
// which is why a deck that is registered and alive but did not answer in time
// gets its roster read here and never a switch.
//
// Every command takes `--json`: one object on stdout, `schemaVersion` first,
// `ok` beside it, the human sentences left off. Exit codes are part of the
// contract — see EXIT.
import { spawn } from "node:child_process";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { COMMANDS, isPortValue } from "../../src/server/args.mjs";
import { isWsl } from "../../src/server/open-url.mjs";
import { COMMAND, PKG_ROOT, PKG_VERSION } from "./package.js";
import { G, P, UNICODE, cols } from "./screen.js";
import { oneShotVoice, reportFlagRows } from "./one-shot.js";

const load = (rel) => import(pathToFileURL(join(PKG_ROOT, rel)).href);

/** The picker, loaded only when somebody is about to be shown it. */
async function pickAccount(rows, opts) {
  const { pickAccount: pick } = await import("./picker.js");
  return pick(rows, opts);
}

/**
 * What a command's exit code means. 0 and 1 are the usual pair; 2 is the
 * command line itself (an account nothing matches, a command misspelled), so a
 * script can tell "you asked wrong" from "it went wrong"; 3 is a command that
 * needs a running deck and found none, which a script answers by starting one.
 */
export const EXIT = Object.freeze({ OK: 0, FAILED: 1, USAGE: 2, NO_DECK: 3 });

/** The version of `--json` output. Bumped only for a change a reader of the
 *  old shape would misread; new fields are added under the same number. */
export const SCHEMA_VERSION = 1;

/** Run the command `flags` names and resolve to the exit code. */
export async function runCommand(flags) {
  const out = output(flags);
  if (typeof flags.unknownCommand === "string") return out.fail(EXIT.USAGE, "unknown_command", unknownCommandText(flags.unknownCommand));
  reportFlagRows(flags, oneShotVoice());
  // A `--port` that names no port names no deck, and reading it as "any deck"
  // would answer about — or switch through — one nobody named. Failing closed,
  // as `--stop` does: `--port 431x`, `--port $UNSET`, `--port4317`.
  const askedPort = (flags.incomplete ?? []).some(x => x.flag === "--port" || x.flag === "-p")
    || (flags.unknown ?? []).some(t => /^(-p|--port)/.test(String(t)));
  if (askedPort || (flags.port != null && !isPortValue(flags.port))) {
    return out.fail(EXIT.USAGE, "bad_port", `--port${flags.port != null ? ` ${flags.port}` : ""}: not a port number ${G.dash} expected 0-65535`);
  }
  switch (flags.command) {
    case "accounts": return accountsCommand(flags, out);
    case "switch": return switchCommand(flags, out);
    case "usage": return usageCommand(flags, out);
    case "sessions": return sessionsCommand(flags, out);
    case "open": return openCommand(flags, out);
    default: return out.fail(EXIT.USAGE, "unknown_command", unknownCommandText(String(flags.command)));
  }
}

// ── how a command speaks ─────────────────────────────────────────────────────

/** The two voices, chosen once: lines for a person, one object for a script. */
function output(flags) {
  const json = flags.json === true;
  const say = (line = "") => { if (!json) process.stdout.write(`${line}\n`); };
  return {
    json,
    say,
    /** The answer. In JSON, the object; for a person, nothing — the command
     *  has already said its lines. */
    done(data, code = EXIT.OK) {
      if (json) process.stdout.write(`${JSON.stringify({ schemaVersion: SCHEMA_VERSION, ok: code === EXIT.OK, ...data })}\n`);
      return code;
    },
    /** A failure: `code` for the exit, `reason` for a script, `text` for a
     *  person (on stderr, where an error belongs, prefixed with the command). */
    fail(code, reason, text, extra = {}) {
      if (json) {
        process.stdout.write(`${JSON.stringify({ schemaVersion: SCHEMA_VERSION, ok: false, error: { code: reason, message: plain(text) }, ...extra })}\n`);
      } else {
        for (const line of [].concat(text)) process.stderr.write(`${COMMAND}: ${line}\n`);
      }
      return code;
    },
  };
}

/** A message without the backticks a terminal reader is shown, for JSON. */
const plain = (text) => [].concat(text).join(" ").replace(/`/g, "");

/** The closest command word to a misspelled one, by edit distance, when it is
 *  close enough to be what was meant. */
function suggestion(word) {
  const words = [...Object.keys(COMMANDS), "status", "stop", "logs", "help", "start"];
  let best = null;
  for (const w of words) {
    const d = distance(String(word).toLowerCase(), w);
    if (d <= 2 && (!best || d < best.d)) best = { w, d };
  }
  return best?.w ?? null;
}

function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}

function unknownCommandText(word) {
  const near = suggestion(word);
  return [
    `unknown command "${word}"${near ? ` ${G.dash} did you mean \`${COMMAND} ${near}\`?` : ""}`,
    `\`${COMMAND} --help\` lists the commands; \`${COMMAND}\` alone starts the deck.`,
  ];
}

// ── where the answers come from ──────────────────────────────────────────────

/** The running deck, or null — `--port` names one. */
async function deckFor(flags) {
  const { findDeck } = await load("src/server/deck-client.mjs");
  const port = flags.port != null && isPortValue(flags.port) ? Number(flags.port) : null;
  return { deck: await findDeck({ port }), port };
}

/** Decks whose process is alive although none answered the challenge — slow
 *  at boot, in a pause, on a loaded machine. A switch here would race theirs. */
async function silentDecks(port) {
  const { registeredDecks } = await load("src/server/running-deck.mjs");
  const decks = await registeredDecks().catch(() => []);
  return port == null ? decks : decks.filter(d => d.port === port);
}

async function ask(deck, opts) {
  const { askDeck } = await load("src/server/deck-client.mjs");
  return askDeck(deck, opts);
}

/**
 * The roster, from the deck when one is running and from claude-swap's store
 * in this process when none is. `{ roster, source, deck }`, or `{ failed }`
 * with the exit code already printed.
 */
async function readRoster(flags, out) {
  const { deck, port } = await deckFor(flags);
  if (!deck && port != null) {
    return { failed: out.fail(EXIT.NO_DECK, "no_deck", `no deck is listening on ${port} ${G.dash} \`${COMMAND} status\` lists them`) };
  }
  if (deck) {
    const r = await ask(deck, { path: "/api/claude-accounts?refresh=1" });
    if (r.ok && r.body) return { roster: r.body, source: "deck", deck };
    return { failed: out.fail(EXIT.FAILED, "deck_unreachable", deckTrouble(deck, r)) };
  }
  const silent = await silentDecks(port);
  const { fetchClaudeAccounts } = await load("src/server/claude-accounts.mjs");
  return { roster: await fetchClaudeAccounts({ force: true }), source: "local", deck: null, silent };
}

/** The footer of a roster read here rather than through a deck. */
function localNote(silent) {
  return silent?.length
    ? `the deck on ${silent.map(d => d.port).join(", ")} did not answer ${G.dash} read from claude-swap's store`
    : `no deck is running ${G.dash} read from claude-swap's store`;
}

/** What to say about a deck that did not answer as expected. */
function deckTrouble(deck, r) {
  if (r.status === 404) {
    return `the deck on ${deck.port} (v${deck.version || "?"}) predates this command ${G.dash} \`${COMMAND} --new\` restarts it on v${PKG_VERSION}`;
  }
  if (r.status === 0) return `the deck on ${deck.port} did not answer (${r.reason ?? "no reply"})`;
  return `the deck on ${deck.port} answered ${r.status}${r.body?.reason ? ` (${r.body.reason})` : ""}`;
}

/** Why a roster has nothing in it, in the words a person needs next. */
function rosterTrouble(roster) {
  switch (roster?.reason) {
    case "no_accounts":
      return `no Claude accounts yet ${G.dash} sign in with \`claude\`, then add it from the deck's Accounts panel or with \`cswap add\``;
    case "cswap_installing":
      return `the deck is installing claude-swap, which keeps the accounts ${G.dash} try again in a minute`;
    case "cswap_refused":
      return `the claude-swap on this machine (${roster.version ?? "unknown version"}) is one the deck refused to run${roster.want ? ` ${G.dash} it wants ${roster.want}` : ""}`;
    case "no_cswap":
      return [`claude-swap, which keeps the accounts, is not installed ${G.dash} \`${COMMAND}\` installs it when it starts`]
        .concat(typeof roster.hint === "string" && roster.hint ? [`or by hand: ${roster.hint}`] : []);
    default:
      return `could not read the accounts${roster?.reason ? ` (${roster.reason})` : ""}`;
  }
}

/** The roster's rows as `--json` hands them out: the fields a script needs,
 *  without the panel's internal bookkeeping. */
function accountJson(a) {
  return {
    num: a.num, email: a.email, alias: a.alias, org: a.org,
    active: a.active === true, disabled: a.disabled === true, alive: a.alive !== false,
    headroom: a.headroom ?? null,
    lanes: (a.lanes ?? []).map(l => ({ id: l.id, label: l.label, pct: l.pct, resetAt: l.resetAt ?? null })),
    fetchedAt: a.fetchedAt ?? null, stale: a.stale === true,
    error: a.error ?? null, staleCopy: a.staleCopy === true, stopped: a.stopped === true,
  };
}

function screen() {
  return { tone: P, g: G, unicode: UNICODE, columns: cols(), now: Date.now() };
}

// ── accounts ────────────────────────────────────────────────────────────────

async function accountsCommand(flags, out) {
  const got = await readRoster(flags, out);
  if (got.failed !== undefined) return got.failed;
  const { roster, source, silent } = got;
  if (!roster?.ok) return out.fail(EXIT.FAILED, roster?.reason ?? "unreadable", rosterTrouble(roster), { source });
  const { accountLines } = await load("src/server/cli-lines.mjs");
  out.say("");
  for (const line of accountLines(roster.accounts, screen())) out.say(line);
  out.say("");
  out.say(`  ${P.muted}\`${COMMAND} switch <n|email|alias>\` ${G.bullet} \`${COMMAND} switch --best\` picks the most room${P.reset}`);
  if (source === "local") out.say(`  ${P.muted}${localNote(silent)}${P.reset}`);
  out.say("");
  return out.done({ source, activeNum: roster.activeNum ?? null, accounts: roster.accounts.map(accountJson) });
}

// ── switch ──────────────────────────────────────────────────────────────────

async function switchCommand(flags, out) {
  const operands = flags.operands ?? [];
  // `cswap swap 1 2` exchanges two slots. Here `swap` switches to one account,
  // and two of them is somebody who expected the other meaning — answered with
  // where that lives rather than with a guess at which of the two they meant.
  if (operands.length > 1) {
    return out.fail(EXIT.USAGE, "too_many_accounts", [
      `\`${COMMAND} ${flags.commandWord ?? "switch"}\` moves the live login to ONE account ${G.dash} name one, or use \`--best\``,
      `to exchange two slots' numbers, that is claude-swap's own: \`cswap swap ${operands[0]} ${operands[1]}\``,
    ]);
  }
  if (operands.length && flags.best) {
    return out.fail(EXIT.USAGE, "both_named", `name an account or pass \`--best\`, not both`);
  }

  const got = await readRoster(flags, out);
  if (got.failed !== undefined) return got.failed;
  const { roster, source, deck, silent } = got;
  // A deck that is alive and did not answer holds the store's lock in its own
  // process, where this one cannot see it: switching beside it is the race
  // #1039 closed. Said before anything is picked, not after.
  if (!deck && silent?.length) {
    return out.fail(EXIT.FAILED, "deck_not_answering", [
      `the deck on ${silent.map(d => d.port).join(", ")} is running but did not answer ${G.dash} not switching behind its back`,
      `try again in a moment; \`${COMMAND} status\` shows it`,
    ]);
  }
  if (!roster?.ok) return out.fail(EXIT.FAILED, roster?.reason ?? "unreadable", rosterTrouble(roster), { source });
  const { accountName, bestAccount, resolveAccount, switchable } = await load("src/server/account-pick.mjs");
  const accounts = roster.accounts;
  const before = accounts.find(a => a.active) ?? null;
  const interactive = !out.json && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);

  let target = null;
  if (flags.best) {
    const best = bestAccount(accounts);
    if (best.none) return out.fail(EXIT.FAILED, "nothing_switchable", `no account can take the login ${G.dash} every one is disabled or needs a fresh sign-in`);
    if (best.already) {
      out.say(`\n  ${P.ok}${G.ok}${P.reset}  already on the account with the most room ${G.dash} ${accountName(best.already)}\n`);
      return out.done({ switched: false, source, account: accountJson(best.already) });
    }
    target = best.account;
  } else if (operands.length) {
    const hit = resolveAccount(accounts, operands[0]);
    if (hit.account) target = hit.account;
    else if (hit.ambiguous && interactive) {
      target = await pickAccount(hit.ambiguous, { ...screen(), title: `"${operands[0]}" matches ${hit.ambiguous.length} accounts` });
      if (!target) return cancelled(out);
    } else if (hit.ambiguous) {
      return out.fail(EXIT.USAGE, "ambiguous", [
        `"${operands[0]}" matches ${hit.ambiguous.length} accounts ${G.dash} name one by its number:`,
        ...hit.ambiguous.map(a => `  ${accountName(a)}`),
      ], { matches: hit.ambiguous.map(accountJson) });
    } else {
      return out.fail(EXIT.USAGE, "no_such_account", [
        `no account matches "${operands[0]}"`,
        `\`${COMMAND} accounts\` lists them by number, email and alias`,
      ]);
    }
  } else if (interactive) {
    const initial = Math.max(0, accounts.findIndex(a => a.active));
    target = await pickAccount(accounts, { ...screen(), initial });
    if (!target) return cancelled(out);
  } else {
    return out.fail(EXIT.USAGE, "no_account_named",
      `name the account: \`${COMMAND} switch <n|email|alias>\`, or \`--best\` for the one with the most room`);
  }

  if (target.active) {
    out.say(`\n  ${P.ok}${G.ok}${P.reset}  already on ${accountName(target)}\n`);
    return out.done({ switched: false, source, account: accountJson(target) });
  }
  // The one refusal here: a login known to be dead. Switching to it signs every
  // running session out, and a person who named it from a terminal is the least
  // likely to have seen the panel's red badge first.
  if (!switchable(target) && !target.disabled) {
    return out.fail(EXIT.FAILED, "needs_sign_in", [
      `${accountName(target)} needs a fresh sign-in ${G.dash} switching to it would sign every running session out`,
      `sign it in again from the deck's Accounts panel, then switch`,
    ], { account: accountJson(target) });
  }

  const result = deck
    ? await switchThroughDeck(deck, target.num)
    : await switchHere(target.num);
  if (!result.ok && result.reason === "deck_timeout") {
    // The deck may still be waiting its turn at the store's lock, and the
    // switch lands when it gets it: "could not" would be a guess.
    return out.fail(EXIT.FAILED, "deck_timeout", [
      `the deck has not finished switching to ${accountName(target)} ${G.dash} it may still land`,
      `\`${COMMAND} accounts\` shows which account is live`,
    ]);
  }
  if (!result.ok) {
    const why = result.reason === "no_cswap" ? `claude-swap is not installed`
      : result.reason === "timeout" ? `claude-swap took too long to answer`
      : result.output ? String(result.output).trim().split("\n").pop()
      : result.reason ?? "the switch failed";
    return out.fail(EXIT.FAILED, result.reason ?? "switch_failed", `could not switch to ${accountName(target)} ${G.dash} ${why}`);
  }

  // Who follows the switch. Claude Code reads the login per request, so every
  // running Claude session moves with it from its next message — worth saying
  // out loud, since that is the whole effect and it is not visible anywhere.
  const live = deck ? await liveClaudeSessions(deck) : null;
  const usage = lanesSummary(target);
  out.say("");
  out.say(`  ${P.ok}${G.ok}${P.reset}  switched to ${P.bold}${accountName(target)}${P.reset}${usage ? `  ${P.muted}${G.bullet}  ${usage}${P.reset}` : ""}`);
  if (before) out.say(`     ${P.muted}from ${accountName(before)}${P.reset}`);
  if (live != null && live > 0) {
    out.say(`     ${P.muted}${live} running Claude session${live === 1 ? "" : "s"} ${live === 1 ? "uses" : "use"} it from the next message${P.reset}`);
  }
  if (!deck) out.say(`     ${P.muted}no deck is running ${G.dash} switched with claude-swap directly${P.reset}`);
  out.say("");
  return out.done({
    switched: true, source,
    account: accountJson({ ...target, active: true }),
    previous: before ? accountJson({ ...before, active: false }) : null,
    liveSessions: live,
  });
}

function cancelled(out) {
  out.say(`  ${P.muted}${G.dash}  nothing switched${P.reset}\n`);
  return out.done({ switched: false, cancelled: true }, EXIT.OK);
}

/** "5h 12% · 7d 40%", from a row's lanes, or "". */
function lanesSummary(a) {
  return (a.lanes ?? [])
    .filter(l => l.id === "five_hour" || l.id === "seven_day")
    .map(l => `${l.label} ${Math.round(l.pct)}%`)
    .join(` ${G.bullet} `);
}

/** The switch, asked of the deck: its lock, its cache invalidation, its swap
 *  log — the same route the panel's click takes. */
async function switchThroughDeck(deck, num) {
  // Longer than the deck's own thirty seconds for `cswap switch`, so it is the
  // deck's timeout that answers rather than this one cutting it off mid-switch.
  const r = await ask(deck, { method: "POST", path: "/api/claude-accounts/switch", body: { account: num }, timeoutMs: 45_000 });
  if (r.body && typeof r.body === "object") return r.body;
  return { ok: false, reason: r.reason === "timeout" ? "deck_timeout" : r.reason ?? `http_${r.status}` };
}

/** The switch with no deck to ask: claude-accounts.mjs's own, under the same
 *  mutex, and recorded in the same swap log the deck's route writes. */
async function switchHere(num) {
  const { switchClaudeAccount } = await load("src/server/claude-accounts.mjs");
  const result = await switchClaudeAccount(num);
  if (result.ok) {
    const { recordSwap } = await load("src/server/swap-log.mjs");
    await recordSwap(num, "manual");
  }
  return result;
}

/** How many Claude sessions the deck sees running, or null when it cannot say. */
async function liveClaudeSessions(deck) {
  const r = await ask(deck, { path: "/api/sessions", timeoutMs: 3_000 });
  if (!r.ok || !Array.isArray(r.body?.sessions)) return null;
  return r.body.sessions.filter(s => s.provider !== "codex" && s.state !== "ended").length;
}

// ── usage ───────────────────────────────────────────────────────────────────

async function usageCommand(flags, out) {
  const got = await readRoster(flags, out);
  if (got.failed !== undefined) return got.failed;
  const { roster, source, silent } = got;
  if (!roster?.ok) return out.fail(EXIT.FAILED, roster?.reason ?? "unreadable", rosterTrouble(roster), { source });
  const active = roster.accounts.find(a => a.active);
  if (!active) {
    return out.fail(EXIT.FAILED, "none_active", `no account is active ${G.dash} \`${COMMAND} switch\` picks one`, { source });
  }
  const { usageLines } = await load("src/server/cli-lines.mjs");
  out.say("");
  for (const line of usageLines(active, screen())) out.say(line);
  out.say("");
  if (source === "local") out.say(`  ${P.muted}${localNote(silent)}${P.reset}\n`);
  return out.done({ source, account: accountJson(active) });
}

// ── sessions ────────────────────────────────────────────────────────────────

async function sessionsCommand(flags, out) {
  const { deck, port } = await deckFor(flags);
  if (!deck) {
    return out.fail(EXIT.NO_DECK, "no_deck", port != null
      ? `no deck is listening on ${port} ${G.dash} \`${COMMAND} status\` lists them`
      : `no deck is running ${G.dash} sessions are what a running deck watches; \`${COMMAND}\` starts one`);
  }
  const r = await ask(deck, { path: "/api/sessions" });
  if (!r.ok || !Array.isArray(r.body?.sessions)) return out.fail(EXIT.FAILED, "deck_unreachable", deckTrouble(deck, r));
  const all = r.body.sessions;
  const shown = flags.all ? all : all.filter(s => s.state !== "ended");
  const { sessionLines } = await load("src/server/cli-lines.mjs");
  const waiting = shown.filter(s => s.state === "waiting").length;
  const working = shown.filter(s => s.state === "working").length;
  out.say("");
  for (const line of sessionLines(shown, { ...screen(), now: r.body.now ?? Date.now() })) out.say(line);
  out.say("");
  const ended = all.length - shown.length;
  const parts = [`${shown.length} session${shown.length === 1 ? "" : "s"}`];
  if (waiting) parts.push(`${P.warn}${waiting} waiting on you${P.reset}${P.muted}`);
  if (working) parts.push(`${working} working`);
  out.say(`  ${P.muted}${parts.join(` ${G.bullet} `)}${ended && !flags.all ? ` ${G.bullet} \`--all\` adds ${ended} ended` : ""}${P.reset}`);
  out.say("");
  return out.done({ deck: { port: deck.port, version: deck.version ?? null }, sessions: shown });
}

// ── open ────────────────────────────────────────────────────────────────────

/**
 * Is this terminal somewhere a browser cannot be opened for its reader?
 *
 * Over SSH the browser `xdg-open` would start is on the remote machine, if
 * anywhere — not in front of the person who typed the command. And a Linux box
 * with no display has nowhere to open one at all.
 */
export function remoteShell(env = process.env, platform = process.platform, wsl = () => isWsl(platform, env)) {
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return true;
  // WSL without WSLg has no DISPLAY either, and opens the Windows browser —
  // open-url.mjs knows how.
  return platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY && !wsl();
}

/** The port the reader's end of the tunnel listens on: never the deck's own,
 *  because the reader of this is a ccdeck user, whose own deck very likely
 *  has that port on their machine — and a forward that cannot bind it would
 *  leave the URL opening their deck instead of this one. */
export function tunnelPort(port) {
  return port + 10_000 <= 65_535 ? port + 10_000 : port - 10_000;
}

/**
 * The `ssh -L` line that brings a remote deck to the reader's own browser, and
 * the URL it is then at.
 *
 * The address is the server's own end of the current connection, the third
 * field of SSH_CONNECTION — the one name for this machine that is known to be
 * reachable from where they are, since they just came in through it — and the
 * fourth is the port sshd took it on, which is not always 22. The deck's host
 * check admits the forwarded page on any local port: it arrives as 127.0.0.1
 * and its Origin and Host agree, which is the deck's own-tab rule. And
 * `ExitOnForwardFailure`, so a local port that is taken ends ssh with a reason
 * instead of leaving it connected and forwarding nothing.
 */
export function tunnelCommand(port, env = process.env, user = safeUser(), host = safeHost()) {
  // Without SSH_CONNECTION — a headless box reached some other way — the
  // machine's own name is the best guess there is, and the reader can see
  // whether it is one their side resolves.
  const [, , address, sshPort] = String(env.SSH_CONNECTION ?? "").trim().split(/\s+/);
  const server = address || host || "<this-machine>";
  const at = user ? `${user}@${server}` : server;
  const local = tunnelPort(port);
  const p = sshPort && sshPort !== "22" ? ` -p ${sshPort}` : "";
  return {
    command: `ssh -N -o ExitOnForwardFailure=yes -L ${local}:127.0.0.1:${port}${p} ${at}`,
    url: `http://127.0.0.1:${local}`,
  };
}

function safeUser() {
  try { return userInfo().username; } catch { return ""; }
}

function safeHost() {
  try { return hostname(); } catch { return ""; }
}

async function openCommand(flags, out) {
  const { deck, port } = await deckFor(flags);
  if (!deck) {
    return out.fail(EXIT.NO_DECK, "no_deck", port != null
      ? `no deck is listening on ${port} ${G.dash} \`${COMMAND} status\` lists them`
      : `no deck is running ${G.dash} \`${COMMAND}\` starts one`);
  }
  const url = `http://127.0.0.1:${deck.port}`;
  if (remoteShell()) {
    const tunnel = tunnelCommand(deck.port);
    out.say("");
    out.say(`  ${P.muted}the deck is running here, on${P.reset} ${P.accent}${P.bold}${url}${P.reset}`);
    out.say(`  ${P.muted}to open it on your own computer, run this there and keep it open:${P.reset}`);
    out.say("");
    out.say(`     ${tunnel.command}`);
    out.say("");
    out.say(`  ${P.muted}then open${P.reset} ${P.accent}${tunnel.url}${P.reset} ${P.muted}in your browser${P.reset}`);
    out.say("");
    return out.done({ url, opened: false, tunnel: tunnel.command, tunnelUrl: tunnel.url });
  }
  if (await openAndSettle(url)) {
    out.say(`\n  ${P.ok}${G.ok}${P.reset}  opened ${P.accent}${url}${P.reset}\n`);
    return out.done({ url, opened: true, tunnel: null });
  }
  return out.fail(EXIT.FAILED, "no_browser", `could not open a browser here ${G.dash} the deck is at ${url}`, { url, opened: false });
}

/**
 * openUrl, and the time its fallbacks need. A launcher that is missing or
 * finds no handler hands over to the next only while this process is still
 * here to see it go, so a command that exited at once never reached the
 * second. True at the first launcher that exits cleanly or outlives the grace
 * period openUrl itself judges by; false when every one of them failed.
 */
async function openAndSettle(url) {
  const { openUrl, LAUNCH_GRACE_MS } = await load("src/server/open-url.mjs");
  return new Promise(resolve => {
    let timer = null;
    let alive = 0;
    const settle = (opened) => { clearTimeout(timer); resolve(opened); };
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => settle(alive > 0), LAUNCH_GRACE_MS + 100); };
    arm();
    openUrl(url, {
      spawnFn: (file, args, opts) => {
        const child = spawn(file, args, opts);
        alive++;
        let gone = false;
        const end = () => { if (!gone) { gone = true; alive--; } };
        child.on("error", end);
        child.on("exit", code => { end(); if (code === 0) settle(true); });
        arm();
        return child;
      },
    });
  });
}
