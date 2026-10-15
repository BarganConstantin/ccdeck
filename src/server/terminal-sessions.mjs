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
  DECK_SOCKET, findTmux, paneArgv, runTmux, tmuxFormatLiteral, tmuxHasNoServer, tmuxSequence,
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
  agent, kind = "launch", sessionId = "", claudeBin = "claude", codexBin = "codex", uuid = randomUUID,
} = {}) {
  checkAgent(agent);
  checkKind(kind);
  if (agent === "claude") {
    if (kind === "launch") {
      if (sessionId) checkSessionId(sessionId);
      return [claudeBin, "--session-id", sessionId || uuid()];
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
 * Everything else rides in the same sequence as new-session; see tmuxSequence
 * for why that ordering is what keeps a pane that dies at once on the board.
 */
export function launchCommand({ name, cwd, cols, rows, argv, sessionId = "", agent, kind }) {
  const at = `=${name}:`;
  return ["-f", "/dev/null", ...tmuxSequence([
    ["new-session", "-d", "-s", name, "-x", String(cols), "-y", String(rows),
      "-c", tmuxFormatLiteral(cwd), "-e", "COLORTERM=truecolor", "-P", "-F", "#{pane_id}",
      "--", ...paneArgv(argv)],
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
 */
export async function launchSession({
  tmux, agent, cwd, cols = COLS.fallback, rows = ROWS.fallback, argv, sessionId = "", kind = "launch",
  socket = DECK_SOCKET, env = process.env, platform = process.platform, run = runTmux,
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
    command = agentArgv({ agent, kind, sessionId: id, claudeBin: bin, codexBin: bin });
  }
  const bin = tmux ?? await requireTmux(env);

  for (let attempt = 0; ; attempt++) {
    const name = deckSessionName({ agent, kind, sessionId: id });
    const r = await run(bin, socket, launchCommand({ name, cwd: dir, ...size, argv: command, sessionId: id, agent, kind }), { env });
    const pane = /^%\d+$/m.exec(r.stdout)?.[0] ?? "";
    if (r.ok && pane) return { name, sessionId: id, pane };
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
