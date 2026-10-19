// The tmux sessions the deck launches, and how it finds them again.
//
// A session the deck starts — a new Claude or Codex, or one reopened here with
// `--resume` — runs on the deck's own tmux server (DECK_SOCKET in tmux.mjs)
// under a name only the deck uses, and carries four tmux user options that say
// what it is: which agent session it holds, which agent, how it was started,
// and the project folder. Those options are the whole record. The deck keeps no
// file of its own about what it launched, so after a restart, an upgrade or a
// crash there is nothing to disagree with what tmux says is running — the
// listing below IS the state.
//
// The same server also holds the small wrappers that reach Claude's own
// background sessions: `claude attach <id>` running in a deck pane, named
// `ccdeck-att-<first 8 of the id>` so the deck reuses one rather than stacking
// a second attach onto the same session.
//
// REMAIN-ON-EXIT. When an agent exits, its pane stays, dead, holding the last
// frame it drew. That frame is evidence — the panel shows it frozen under
// "session ended" — and tmux's own "Pane is dead" banner is switched off so
// the frame is the agent's, not a line scrolled up under tmux's caption.
import { randomBytes, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, posix as posixPath } from "node:path";
import { pathLookup } from "./exec-spec.mjs";
// The one answer to "which claude" — AGENTS_DECK_CLAUDE first, then PATH, then
// the places its installers put it (#553, #570). Not decided again here.
import { adminClaudeBin } from "./claude-identity.mjs";
import {
  DECK_SOCKET, findTmux, paneArgv, runTmux, serverScope, tmuxFormatLiteral, tmuxHasNoServer, tmuxSequence,
} from "./tmux.mjs";

/** The agents the deck can launch. */
export const AGENTS = Object.freeze(["claude", "codex"]);

/** How a deck session came to be: started fresh, reopened from its id, or a
 *  wrapper attached to a Claude background session. */
export const KINDS = Object.freeze(["launch", "resume", "attach"]);

/** The tmux user options a deck session carries. */
export const SESSION_OPTIONS = Object.freeze({
  session: "@ccdeck-session",
  agent: "@ccdeck-agent",
  kind: "@ccdeck-kind",
  cwd: "@ccdeck-cwd",
});

/** The default size, and the clamp the panel's own resizes are held to. */
const COLS = Object.freeze({ min: 20, max: 500, fallback: 120 });
const ROWS = Object.freeze({ min: 5, max: 200, fallback: 40 });

const DECK_NAME = /^ccdeck-(?:claude|codex|att)-[0-9a-f]{8}$/;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Why a terminal session could not be started, listed or closed.
 *
 * `code` is for the caller to branch on; `message` is one short sentence fit to
 * show as it is, with no path, pid or tmux wording in it; `detail` is what tmux
 * said, for the log only.
 *
 * Codes: bad-agent, bad-kind, bad-cwd, bad-session-id, bad-argv, bad-name,
 * agent-missing, tmux-unavailable, exists, tmux-failed.
 */
export class TerminalSessionError extends Error {
  constructor(code, message, detail = "") {
    super(message);
    this.name = "TerminalSessionError";
    this.code = code;
    this.detail = detail;
  }
}

function checkAgent(agent) {
  if (!AGENTS.includes(agent)) throw new TerminalSessionError("bad-agent", "The deck can start Claude or Codex sessions only.");
}

function checkKind(kind) {
  if (!KINDS.includes(kind)) throw new TerminalSessionError("bad-kind", "That is not a way the deck starts a session.");
}

function checkSessionId(id) {
  // A session id is an argument to the agent's own CLI. Anything but a UUID —
  // one that began with a dash, say — would be read as a flag.
  if (!SESSION_ID.test(String(id ?? ""))) {
    throw new TerminalSessionError("bad-session-id", "That session id is not one Claude or Codex would have written.");
  }
}

/** Whether `name` is one the deck gives its own tmux sessions — the only
 *  sessions it will ever close. */
export function isDeckSessionName(name) {
  return typeof name === "string" && DECK_NAME.test(name);
}

/**
 * The tmux session name for a new deck session.
 *
 * `ccdeck-<agent>-<8 random hex>` for a launch or a resume. Random rather than
 * derived from the session id, because a launched Codex has no id until it
 * writes its first rollout, and because one conversation can be reopened
 * after an earlier deck session for it has ended and still lies there, dead.
 *
 * `ccdeck-att-<first 8 of the id>` for an attach wrapper: derived ON PURPOSE,
 * so a second open of the same background session collides with the first
 * wrapper instead of starting another `claude attach` beside it.
 */
export function deckSessionName({ agent, kind = "launch", sessionId = "", random = randomBytes }) {
  if (kind === "attach") {
    checkSessionId(sessionId);
    return `ccdeck-att-${String(sessionId).slice(0, 8).toLowerCase()}`;
  }
  checkAgent(agent);
  return `ccdeck-${agent}-${random(4).toString("hex")}`;
}

/**
 * The argv that starts an agent session. Pure.
 *
 *   claude launch  → [claude, "--session-id", <id, or a new v4 UUID>]
 *   claude resume  → [claude, "--resume", id]
 *   claude attach  → [claude, "attach", id]
 *   codex launch   → [codex]
 *   codex resume   → [codex, "resume", id]
 *
 * A new Claude is told its id rather than left to pick one, so the deck knows
 * which board node the pane belongs to before the first hook arrives. Codex has
 * no such flag: a launched Codex is matched to its session later, by the
 * rollout it opens. So a launch of Codex refuses an id rather than dropping it
 * where a caller would assume it had been used. Codex has no background
 * sessions, so it has no attach.
 */
export function agentArgv({
  agent, kind = "launch", sessionId = "", claudeBin = "claude", codexBin = "codex", uuid = randomUUID, options = null,
} = {}) {
  checkAgent(agent);
  checkKind(kind);
  const extra = launchOptionArgs(agent, kind, options);
  if (agent === "claude") {
    if (kind === "launch") {
      if (sessionId) checkSessionId(sessionId);
      return [claudeBin, "--session-id", sessionId || uuid(), ...extra];
    }
    checkSessionId(sessionId);
    return kind === "resume" ? [claudeBin, "--resume", sessionId] : [claudeBin, "attach", sessionId];
  }
  if (kind === "attach") throw new TerminalSessionError("bad-kind", "Codex sessions cannot be attached to that way.");
  if (kind === "launch") {
    if (sessionId) throw new TerminalSessionError("bad-session-id", "A new Codex session chooses its own id.");
    return [codexBin];
  }
  checkSessionId(sessionId);
  return [codexBin, "resume", sessionId];
}

/** What New session may ask of a new Claude, each a value Claude Code's own
 *  CLI lists (2.1.301: `--model <alias>`, `--permission-mode <mode>`,
 *  `--worktree`). Never a mode that stops asking — bypassPermissions, dontAsk:
 *  a deck that never answers for the reader does not start an agent that
 *  answers for itself. Anything else is refused, so nothing a page sends
 *  becomes a flag the deck did not choose. */
export const LAUNCH_MODELS = Object.freeze(["opus", "sonnet", "haiku"]);
export const LAUNCH_PERMISSION_MODES = Object.freeze(["manual", "auto", "acceptEdits", "plan"]);

/** The flags for a launch's options, after the session id. Pure; throws
 *  `bad-options` for anything not on the lists above, or for options on
 *  anything but a new Claude. `--worktree` goes last: its value is optional,
 *  and last it can take nothing that was meant as another flag. */
export function launchOptionArgs(agent, kind, options) {
  if (options == null) return [];
  if (typeof options !== "object" || Array.isArray(options)) throw new TerminalSessionError("bad-options", "Those session options are not ones the deck knows.");
  const { model, permissionMode, worktree, ...rest } = options;
  if (Object.keys(rest).length || (worktree != null && typeof worktree !== "boolean")) {
    throw new TerminalSessionError("bad-options", "Those session options are not ones the deck knows.");
  }
  if (model == null && permissionMode == null && worktree !== true) return [];
  if (agent !== "claude" || kind !== "launch") throw new TerminalSessionError("bad-options", "Only a new Claude session takes those options.");
  const out = [];
  if (model != null) {
    if (!LAUNCH_MODELS.includes(model)) throw new TerminalSessionError("bad-options", "That is not a model the deck can start Claude with.");
    out.push("--model", model);
  }
  if (permissionMode != null) {
    if (!LAUNCH_PERMISSION_MODES.includes(permissionMode)) throw new TerminalSessionError("bad-options", "That is not a permission mode the deck can start Claude in.");
    out.push("--permission-mode", permissionMode);
  }
  if (worktree === true) out.push("--worktree");
  return out;
}

/**
 * The agent's binary as an absolute path, or null when this machine has none.
 *
 * Absolute because the pane is exec'd by the tmux SERVER, with the PATH the
 * server was started with — and that server may be older than this deck,
 * started by a previous run whose PATH was different. A bare name would be
 * looked up there; a path is not looked up at all.
 *
 * Claude comes from adminClaudeBin, the resolver the accounts surface and the
 * boot check share. Codex has no resolver of its own yet: PATH, then the
 * places its npm and Homebrew installs land, the same shape claudeCliCandidates
 * gives Claude and for the same reason — a deck started from a shortcut has a
 * PATH that never sourced the shell rc that put Codex on it.
 */
export function resolveAgentBin(agent, {
  env = process.env, platform = process.platform, home = homedir(), exists = existsSync,
} = {}) {
  checkAgent(agent);
  const pathEnv = env.PATH ?? env.Path ?? "";
  const located = (bin) => {
    if (!/[\\/]/.test(bin)) return pathLookup(bin, platform, { pathEnv, exists });
    try { return exists(bin) ? bin : null; } catch { return null; }
  };
  if (agent === "claude") return located(adminClaudeBin(platform, env, home, exists));
  for (const bin of ["codex", posixPath.join(home, ".local", "bin", "codex"), "/opt/homebrew/bin/codex", "/usr/local/bin/codex"]) {
    const at = located(bin);
    if (at) return at;
  }
  return null;
}

/**
 * The project folder a session starts in, checked: an absolute path to a
 * directory that exists, with no control characters in it.
 *
 * Control characters are refused rather than carried. The folder is stored in a
 * tmux option and read back from a tab-separated listing, and a newline or a
 * tab in it would split that listing's line; no real project path needs one.
 */
export async function checkCwd(cwd, { statFn = stat } = {}) {
  if (typeof cwd !== "string" || cwd === "" || !isAbsolute(cwd)) {
    throw new TerminalSessionError("bad-cwd", "The project folder has to be a full path.");
  }
  if (/[\u0000-\u001f\u007f]/.test(cwd)) {
    throw new TerminalSessionError("bad-cwd", "That project folder's name has control characters in it.");
  }
  let st;
  try { st = await statFn(cwd); } catch {
    throw new TerminalSessionError("bad-cwd", "That project folder does not exist.");
  }
  if (!st.isDirectory()) throw new TerminalSessionError("bad-cwd", "That project path is not a folder.");
  return cwd;
}

/** `cols` × `rows` held to what a terminal can sensibly be; a value that is not
 *  a number takes the default rather than the floor. */
export function clampSize(cols, rows) {
  const fit = (v, { min, max, fallback }) =>
    v == null || v === "" || !Number.isFinite(Number(v)) ? fallback : Math.min(max, Math.max(min, Math.round(Number(v))));
  return { cols: fit(cols, COLS), rows: fit(rows, ROWS) };
}

/**
 * The tmux arguments that create one labelled deck session, after the socket.
 *
 * `-f /dev/null`: the deck's server reads no tmux.conf. It is the deck's, not
 * the user's, and a user's config can break it outright — measured on 3.6, a
 * ~/.tmux.conf with `destroy-unattached on` destroyed a `new-session -d`
 * session, and with it the server, before the next command could list it; and
 * every deck session is detached. The flag only matters to the call that
 * starts the server; any other client ignores it.
 *
 * `-e COLORTERM=truecolor` (new-session's -e is 3.2, the floor): the terminal
 * that draws this pane is the panel's xterm, which renders 24-bit colour, and
 * control mode hands it the pane's bytes untranslated; anyone who attaches by
 * hand gets tmux's own translation for their terminal. Without it a deck
 * started from a login item — no COLORTERM in its environment — would launch
 * agents that pick a 256-colour palette for a screen that never needed one.
 *
 * `-e CLAUDE_CODE_NONBLOCKING_STDOUT=1` for Claude: Claude Code documents it
 * (2.1.261 and later) for exactly this pane — "a terminal that stops reading,
 * such as a paused tmux control-mode pane … can't freeze Claude Code
 * mid-session" — and the bridge pauses a pane whose panel falls behind. An
 * older Claude ignores it.
 *
 * `-e CLAUDE_CODE_SCROLL_SPEED=3` for Claude: xterm.js sends one wheel report
 * per notch to a program that has the mouse, and Claude Code's fullscreen
 * scrolls a line per report, so it moved a third of what every native
 * terminal moves (three lines a notch). Claude Code documents the variable
 * for exactly such terminals.
 *
 * `default-terminal` and `history-limit`: with no config read, tmux's own
 * defaults are `screen` — eight colours and no italics for vim, less, htop
 * and git's pager, since they go by terminfo, not COLORTERM — and 2000 lines
 * of history, where native terminals keep 10,000. `tmux-256color` where this
 * machine's terminfo has it, else `screen-256color`, which every terminfo
 * has (macOS's own lacks the tmux entry).
 *
 * Everything else rides in the same sequence as new-session; see tmuxSequence
 * for why that ordering is what keeps a pane that dies at once on the board.
 */
export function launchCommand({ name, cwd, cols, rows, argv, sessionId = "", agent, kind, term = PANE_TERM_FALLBACK, colours = null }) {
  const at = `=${name}:`;
  const style = paneColours(colours);
  return ["-f", "/dev/null", ...tmuxSequence([
    // The server's own defaults, set ahead of the pane they shape — and
    // again on every launch, so a server an older deck started picks them up
    // for the panes it makes from now on. Ahead of new-session in the same
    // sequence, so the first launch starts the server with them.
    ["set-option", "-g", "default-terminal", term],
    ["set-option", "-g", "history-limit", String(PANE_HISTORY)],
    ["new-session", "-d", "-s", name, "-x", String(cols), "-y", String(rows),
      "-c", tmuxFormatLiteral(cwd), "-e", "COLORTERM=truecolor",
      ...(agent === "claude" ? ["-e", "CLAUDE_CODE_NONBLOCKING_STDOUT=1", "-e", `CLAUDE_CODE_SCROLL_SPEED=${CLAUDE_SCROLL_SPEED}`] : []),
      "-P", "-F", "#{pane_id}",
      "--", ...paneArgv(argv)],
    // The panel's colours, straight after the pane and in the same sequence,
    // so they are tmux's answer before the program can ask. A program asking
    // its terminal's colours (OSC 10/11: Codex at its first frame, Claude
    // Code's auto theme, vim) is answered by tmux, from a control client's
    // report when one has made it and from the window's style otherwise — and
    // at launch no client has attached yet, so without a style tmux answered
    // black, and a light deck got a session drawn for a dark terminal. Every
    // tmux from 3.2 answers from the style; the socket keeps it current.
    ...(style ? [["set-option", "-w", "-t", at, "window-style", style]] : []),
    ["set-option", "-t", at, SESSION_OPTIONS.session, sessionId],
    ["set-option", "-t", at, SESSION_OPTIONS.agent, agent],
    ["set-option", "-t", at, SESSION_OPTIONS.kind, kind],
    ["set-option", "-t", at, SESSION_OPTIONS.cwd, cwd],
    ["set-option", "-w", "-t", at, "remain-on-exit", "on"],
    // Last, and -q: remain-on-exit-format arrived in 3.3, above the 3.2 floor,
    // and an option a tmux does not know must not fail a sequence that has
    // already made the session. On 3.2 the dead pane keeps tmux's caption.
    ["set-option", "-q", "-w", "-t", at, "remain-on-exit-format", ""],
  ])];
}

/** A colour as the panel sends one: six lowercase hex digits after a #. */
const PANE_COLOUR = /^#[0-9a-f]{6}$/;

/** `fg=#…,bg=#…` for tmux's window-style, from the panel's `{ fg, bg }`, or
 *  null when either is missing or not a colour — never a failed launch: the
 *  colours are a courtesy, and the socket sends them again on attach. */
export function paneColours(colours) {
  if (!colours || typeof colours !== "object") return null;
  const { fg, bg } = colours;
  if (!PANE_COLOUR.test(String(fg)) || !PANE_COLOUR.test(String(bg))) return null;
  return `fg=${fg},bg=${bg}`;
}

/** Lines of history a deck pane keeps: what native terminals keep. */
export const PANE_HISTORY = 10_000;
/** Lines one wheel notch scrolls Claude Code's fullscreen by (see launchCommand). */
export const CLAUDE_SCROLL_SPEED = 3;
/** The terminal type every terminfo database has entries for. */
export const PANE_TERM_FALLBACK = "screen-256color";

/** Where terminfo databases live: ncurses' own list, Homebrew's, the user's. */
const TERMINFO_DIRS = [
  "/usr/share/terminfo", "/lib/terminfo", "/etc/terminfo", "/usr/lib/terminfo",
  "/opt/homebrew/share/terminfo", "/usr/local/share/terminfo",
];

/**
 * The TERM a deck pane is given: `tmux-256color` when this machine's terminfo
 * has an entry for it — under its first letter, or its hex code as macOS and
 * some BSDs file them — else `screen-256color`. TERMINFO and TERMINFO_DIRS
 * are honoured first, as ncurses honours them.
 */
export function paneTerm({ env = process.env, home = homedir(), exists = existsSync } = {}) {
  // POSIX paths whatever runs this: terminfo is a Unix database, and the
  // panel never runs where paths are spelled otherwise.
  const at = posixPath.join;
  const dirs = [
    env.TERMINFO, ...String(env.TERMINFO_DIRS ?? "").split(":"), at(home, ".terminfo"), ...TERMINFO_DIRS,
  ].filter(Boolean);
  const found = dirs.some((d) => exists(at(d, "t", "tmux-256color")) || exists(at(d, "74", "tmux-256color")));
  return found ? "tmux-256color" : PANE_TERM_FALLBACK;
}

/** systemd-run's own failures, as opposed to tmux's: the scope was never
 *  started, so tmux never ran and the plain call is safe to make instead. */
const SYSTEMD_REFUSED = /^Failed to (?:connect|start|create|allocate|set up|find)\b/m;

async function requireTmux(env) {
  const found = await findTmux({ env });
  if (!found.ok) throw new TerminalSessionError("tmux-unavailable", "tmux is not available on this machine.");
  return found;
}

/**
 * Start an agent in a new deck-owned tmux session: `{ name, sessionId, pane }`.
 *
 * `argv` overrides the agent's own command line (the suite runs `cat` there);
 * without it the agent's binary is resolved and agentArgv decides. A Claude
 * launch with no `sessionId` is given a new one, which is returned; a Codex
 * launch returns "" because Codex has not chosen its id yet. `tmux` is a path
 * or findTmux's answer, and is looked up when omitted. `socket` and `env`
 * exist so the suite can run all of this on a server of its own; the product
 * passes neither.
 *
 * Throws TerminalSessionError. A random name that collides is retried; an
 * attach wrapper's name colliding means one already exists ("exists"), and
 * reusing it is the caller's call. A session created but not fully labelled is
 * killed before the error is thrown: unlabelled, nothing would ever find it.
 *
 * new-session is the one call that can start the deck's tmux server, so it is
 * the one run through `scope` (tmux.mjs's serverScope): under the login item's
 * systemd service, a server started plainly would die with the service on
 * `ccdeck --stop`, taking every agent in it along. If systemd itself refuses
 * the scope, the session is started plainly rather than not at all.
 */
export async function launchSession({
  tmux, agent, cwd, cols = COLS.fallback, rows = ROWS.fallback, argv, sessionId = "", kind = "launch",
  socket = DECK_SOCKET, env = process.env, platform = process.platform, run = runTmux, scope = serverScope,
  options = null, colours = null,
} = {}) {
  checkAgent(agent);
  checkKind(kind);
  if (kind === "attach" && agent !== "claude") {
    throw new TerminalSessionError("bad-kind", "Codex sessions cannot be attached to that way.");
  }
  const dir = await checkCwd(cwd);
  const size = clampSize(cols, rows);
  let id = String(sessionId ?? "");
  let command;
  if (argv !== undefined) {
    if (!Array.isArray(argv) || argv.length === 0 || argv.some(a => typeof a !== "string" || a === "")) {
      throw new TerminalSessionError("bad-argv", "The session's command line is empty.");
    }
    if (id || kind !== "launch") checkSessionId(id);
    command = argv;
  } else {
    if (agent === "claude" && kind === "launch" && !id) id = randomUUID();
    const bin = resolveAgentBin(agent, { env, platform });
    if (!bin) {
      throw new TerminalSessionError("agent-missing", agent === "claude"
        ? "Claude Code is not installed on this machine."
        : "Codex is not installed on this machine.");
    }
    command = agentArgv({ agent, kind, sessionId: id, claudeBin: bin, codexBin: bin, options });
  }
  const bin = tmux ?? await requireTmux(env);
  let outside = null;
  try { outside = await scope({ env, platform }); } catch { outside = null; }

  for (let attempt = 0; ; attempt++) {
    const name = deckSessionName({ agent, kind, sessionId: id });
    const args = launchCommand({ name, cwd: dir, ...size, argv: command, sessionId: id, agent, kind, term: paneTerm({ env }), colours });
    let r = await run(bin, socket, args, outside ? { env, scope: outside } : { env });
    if (outside && !r.ok && SYSTEMD_REFUSED.test(r.stderr)) {
      outside = null;
      r = await run(bin, socket, args, { env });
    }
    const pane = /^%\d+$/m.exec(r.stdout)?.[0] ?? "";
    // A client that timed out after the pane was printed (tmuxTimedOut) still
    // made it: tmux runs the whole sequence in the server, and the stall was
    // after. Closing it would ask the same stalled server, and a kill that
    // timed out too would leave the agent running behind a failure that
    // invites a second launch.
    if ((r.ok || r.code === "ETIMEDOUT") && pane) return { name, sessionId: id, pane };
    if (pane) {
      await run(bin, socket, ["kill-session", "-t", `=${name}`], { env });
      throw new TerminalSessionError("tmux-failed", "tmux started the session but could not label it.", r.stderr.trim());
    }
    if (/duplicate session/i.test(r.stderr)) {
      if (kind === "attach") throw new TerminalSessionError("exists", "The deck is already attached to that session.", r.stderr.trim());
      if (attempt < 2) continue;
    }
    throw new TerminalSessionError("tmux-failed", "tmux could not start the session.", r.stderr.trim());
  }
}

/** The listing's columns, tab-separated, the free-text folder last. */
const PANE_FORMAT = [
  "#{session_name}", "#{pane_id}", "#{pane_pid}", "#{pane_dead}", "#{pane_dead_status}",
  "#{session_created}", "#{pane_width}", "#{pane_height}",
  `#{${SESSION_OPTIONS.session}}`, `#{${SESSION_OPTIONS.agent}}`, `#{${SESSION_OPTIONS.kind}}`,
  `#{${SESSION_OPTIONS.cwd}}`,
].join("\t");

/**
 * One deck session per line of a `list-panes -a -F PANE_FORMAT` listing. Pure.
 *
 * Sessions whose name is not a deck name are left out: somebody may have made
 * one by hand on the deck's server, and the deck does not claim it. A session
 * with more than one pane — split by hand, same story — is its first pane,
 * which is the one the deck started.
 */
export function parseDeckPanes(stdout) {
  const out = [];
  const seen = new Set();
  const int = (s) => (s === "" || !Number.isFinite(Number(s)) ? null : Number(s));
  for (const line of String(stdout ?? "").split("\n")) {
    const f = line.split("\t");
    if (f.length < 12) continue;
    const [name, pane, panePid, dead, deadStatus, created, cols, rows, sessionId, agent, kind] = f;
    if (!isDeckSessionName(name) || seen.has(name)) continue;
    seen.add(name);
    const isDead = dead === "1";
    out.push({
      name, sessionId, agent, kind, cwd: f.slice(11).join("\t"), pane,
      panePid: int(panePid), dead: isDead, exitStatus: isDead ? int(deadStatus) : null,
      created: int(created) == null ? null : int(created) * 1000, cols: int(cols), rows: int(rows),
    });
  }
  return out;
}

/**
 * Every session on the deck's tmux server:
 * `[{ name, sessionId, agent, kind, cwd, pane, panePid, dead, exitStatus,
 *    created, cols, rows }]`, `created` in epoch milliseconds.
 *
 * No server is an empty list, not an error — it is what a deck that has never
 * launched anything, or whose last session was closed, looks like.
 */
export async function listDeckSessions({ tmux, socket = DECK_SOCKET, env = process.env, run = runTmux } = {}) {
  const bin = tmux ?? await requireTmux(env);
  const r = await run(bin, socket, ["list-panes", "-a", "-F", PANE_FORMAT], { env });
  if (r.ok) return parseDeckPanes(r.stdout);
  if (tmuxHasNoServer(r.stderr)) return [];
  throw new TerminalSessionError("tmux-failed", "tmux could not list the deck's sessions.", r.stderr.trim());
}

/**
 * The deck session holding `sessionId`, or null. Pure.
 *
 * One conversation can have more than one: reopened after its first deck
 * session ended, the old one is still there, dead, beside the new. A live one
 * wins, then the newest. `kinds` narrows the search — case A wants a launch or
 * resume, case D an attach wrapper.
 */
export function findDeckSession(list, sessionId, { kinds = null } = {}) {
  const want = String(sessionId ?? "").toLowerCase();
  if (!want) return null;
  const hits = (list ?? []).filter(s =>
    String(s.sessionId ?? "").toLowerCase() === want && (!kinds || kinds.includes(s.kind)));
  hits.sort((a, b) => Number(a.dead) - Number(b.dead) || (b.created ?? 0) - (a.created ?? 0));
  return hits[0] ?? null;
}

/**
 * The names of every DEAD deck session that held `sessionId`, of any kind,
 * oldest first. Pure.
 *
 * remain-on-exit keeps each one for its last frame, and that frame is worth
 * keeping only while it is the latest word on the conversation. Once the
 * conversation is reopened, nothing can show a dead pane for it again —
 * terminal-target answers a live pane or none — so every reopen would leave
 * one more corpse on the deck's server for good. The adopt route clears these
 * before it starts the resume. A live session is never in this list, whatever
 * its id.
 */
export function deadDeckSessions(list, sessionId) {
  const want = String(sessionId ?? "").toLowerCase();
  if (!want) return [];
  return (list ?? [])
    .filter(s => s?.dead === true && isDeckSessionName(s.name) && String(s.sessionId ?? "").toLowerCase() === want)
    .sort((a, b) => (a.created ?? 0) - (b.created ?? 0))
    .map(s => s.name);
}

/** How long a dead deck session is kept for its last frame, and how many of
 *  them at most. A week covers coming back after a weekend to see how
 *  something ended; past that, or past the twenty most recent, the frame is
 *  history the board no longer shows and the server only carries. */
export const DEAD_KEEP = Object.freeze({ maxAgeMs: 7 * 24 * 60 * 60_000, count: 20 });

/** The prune's columns: which session, whether its pane is dead and since
 *  when. pane_dead_time is 3.3; on 3.2 it is empty and the session's creation
 *  stands in, which only ever makes a session look older than it is dead. */
const DEAD_FORMAT = ["#{session_name}", "#{pane_dead}", "#{pane_dead_time}", "#{session_created}"].join("\t");

/**
 * The deck sessions a prune closes, from a `list-panes -a -F DEAD_FORMAT`
 * listing, oldest death last in the order they were found. Pure.
 *
 * Only deck names, and only a session whose every pane is dead — one split by
 * hand with a live pane beside the dead agent is somebody's work. Of those,
 * every one dead longer than `maxAgeMs`, and every one past the `count` most
 * recently dead. A launched Codex that never learned its id is dead like any
 * other: it carries no id, and needs none to be found here.
 */
export function staleDeadSessions(stdout, { now = Date.now(), maxAgeMs = DEAD_KEEP.maxAgeMs, count = DEAD_KEEP.count } = {}) {
  const sessions = new Map();
  for (const line of String(stdout ?? "").split("\n")) {
    const [name, dead, deadTime, created] = line.split("\t");
    if (created === undefined || !isDeckSessionName(name)) continue;
    const s = sessions.get(name) ?? { dead: true, at: 0 };
    if (dead !== "1") s.dead = false;
    s.at = Math.max(s.at, (Number(deadTime) || Number(created) || 0) * 1000);
    sessions.set(name, s);
  }
  return [...sessions]
    .filter(([, s]) => s.dead)
    .sort((a, b) => b[1].at - a[1].at)
    .filter(([, s], i) => i >= count || now - s.at > maxAgeMs)
    .map(([name]) => name);
}

/**
 * Close the dead deck sessions staleDeadSessions picks: the names it closed.
 *
 * remain-on-exit keeps every agent that exits, for its last frame, and
 * nothing else ever closes one unless that conversation is reopened — so
 * without this, every session a person quits stays on the deck's server for
 * good, and every listing walks all of them. Never a live pane, and only on
 * the deck's own server: killDeckSession refuses any other name, and the
 * user's own tmux is a different server this never lists. Never rejects.
 */
export async function pruneDeadDeckSessions({
  tmux, socket = DECK_SOCKET, env = process.env, run = runTmux, now = Date.now(), maxAgeMs, count,
} = {}) {
  try {
    const bin = tmux ?? await requireTmux(env);
    const r = await run(bin, socket, ["list-panes", "-a", "-F", DEAD_FORMAT], { env });
    if (!r.ok) return [];
    const closed = [];
    for (const name of staleDeadSessions(r.stdout, { now, ...(maxAgeMs ? { maxAgeMs } : {}), ...(count ? { count } : {}) })) {
      try {
        if (await killDeckSession({ tmux: bin, name, socket, env, run })) closed.push(name);
      } catch { /* the next prune tries again */ }
    }
    return closed;
  } catch {
    return [];
  }
}

/**
 * Write a session id the deck has just learned into a deck session's
 * `@ccdeck-session`: one set-option, true when it landed, false when the
 * session has gone meanwhile.
 *
 * A launched Codex starts with that option empty, because Codex chooses its
 * id only once it writes its first rollout. Until the option says it, every
 * lookup of that session walks every process on the machine for the rollout
 * it holds open (terminal-target.mjs, codexHolder); written once, the next
 * lookup is the listing alone. The id comes from that walk, never from a page,
 * and both values are checked here anyway: the id is later handed to
 * `codex resume`, and the name decides which session is touched.
 */
export async function labelDeckSession({
  tmux, name, sessionId, socket = DECK_SOCKET, env = process.env, run = runTmux,
} = {}) {
  if (!isDeckSessionName(name)) {
    throw new TerminalSessionError("bad-name", "The deck only labels sessions it started.");
  }
  checkSessionId(sessionId);
  const bin = tmux ?? await requireTmux(env);
  const r = await run(bin, socket, ["set-option", "-t", `=${name}:`, SESSION_OPTIONS.session, String(sessionId).toLowerCase()], { env });
  if (r.ok) return true;
  if (tmuxHasNoServer(r.stderr) || /can't find session|no such session/i.test(r.stderr)) return false;
  throw new TerminalSessionError("tmux-failed", "tmux could not label the session.", r.stderr.trim());
}

/**
 * Close one deck session, agent and all. True when it was there to close,
 * false when it was already gone.
 *
 * Refuses any name the deck does not give its own sessions, before tmux is
 * asked anything: this is the one call here that ends somebody's work, and the
 * deck ends only work it started.
 */
export async function killDeckSession({ tmux, name, socket = DECK_SOCKET, env = process.env, run = runTmux } = {}) {
  if (!isDeckSessionName(name)) {
    throw new TerminalSessionError("bad-name", "The deck only closes sessions it started.");
  }
  const bin = tmux ?? await requireTmux(env);
  const r = await run(bin, socket, ["kill-session", "-t", `=${name}`], { env });
  if (r.ok) return true;
  if (tmuxHasNoServer(r.stderr) || /can't find session|no such session/i.test(r.stderr)) return false;
  throw new TerminalSessionError("tmux-failed", "tmux could not close the session.", r.stderr.trim());
}
