// Which terminal a session on the board can be reached through, and how — the
// question every click on a node asks before the terminal panel opens.
//
// The deck knows a session by its id and its working directory, because that
// is all the hooks and the Codex rollouts carry. It does not know the process,
// and without the process there is no telling a session the panel can attach
// to from one it cannot. A throwaway spike, measured against real Claude and
// Codex processes before any of this was written, found the way; this is that
// spike made into something the server can ask on every click, with every
// answer the panel has to tell apart:
//
//   A            the deck started it, in its own tmux server: attach.
//   B            it runs in the user's own tmux: join that pane, at the pane's
//                size, so the user's terminal is never resized under them.
//   D            it is one of Claude's background sessions: `claude attach`
//                inside a deck pane is its only door.
//   C            a plain process in some other terminal: nothing to attach to.
//                It can be reopened here, once it has stopped.
//   gone         nothing holds it any more: it can be reopened here.
//   unsupported  no tmux the panel can drive, or a question that was not one.
//
// WHERE THE PROCESS COMES FROM. Claude Code writes <config dir>/sessions/
// <pid>.json for every live session, interactive and background alike, with
// the sessionId, the kind and `procStart` — the process's start time as the
// kernel tells it (field 22 of /proc/<pid>/stat on Linux; `ps -o lstart=` in
// the C locale and UTC on macOS, read off the 2.1.294 bundle). A pid is
// evidence only while the process holding it is the one that wrote the record,
// and a start time is what catches a recycled pid that happens to be alive.
// The `<pid>.<hash>.key` files beside those records are secrets: they are never
// opened, and the name filter below is the whole of that guarantee, so it is
// an anchored pattern rather than an extension check.
//
// A record is not written the moment a session starts, though: a live Claude
// 2.1.301 measured in a fresh config dir had its `.key` and no `<pid>.json`
// yet, while its hooks had already put it on the board. Reading no record as
// "nothing holds it" offered to reopen a session that was running, which
// would put two writers on one conversation. So when no record names the
// session, a live Claude that no record accounts for, started in the
// session's own folder, is taken as possibly holding it (`unrecordedClaude`):
// case C or a pane, never `gone`. It can name a different session in the same
// folder; that costs a reopen that waits for it to stop, and the other way
// round costs a conversation.
//
// Codex keeps no such file. A Codex the deck launched is found by the session
// option the deck set on its pane; one whose id the deck did not know yet, by
// the rollout file its process holds open. Anything else is found the same way
// where /proc exists, and by `codex resume <id>` on its command line where it
// does not — see WHAT THIS CANNOT SEE.
//
// WHY BACKGROUND BEFORE TMUX. The spike asked for a pane first. A Claude
// background session's pty belongs to its `claude bg-pty-host`, whatever tmux
// the daemon happened to be started from, so a pane found by ancestry would be
// the user's shell, not the session. So the record's `kind` decides, and a
// `bg-pty-host` as the session's PARENT decides when the record carries no
// kind: three of the five sessions measured had been reparented to systemd
// after a daemon restart and were still attachable. The parent, not any
// ancestor — the spike looked at the whole chain, and the first run of this
// module against a real process table showed why that is wrong: every process
// started from inside a background session has a pty host somewhere above it,
// including an ordinary interactive `claude` an agent launched there, and
// `claude attach` with that session's id opens nothing.
//
// WHY A PANE HAS TO SHOW THE PROCESS. Ancestry says a process descends from a
// pane, not that the pane draws it. `claude -p` run by another session's tool
// descends from that session's pane and writes into a pipe; attaching to the
// pane would show the other session. So on Linux, where a process's terminal
// can be read off its file descriptors, a pane is only the answer when the
// process draws on that pane's tty — a process with no terminal at all is in
// no pane. macOS reports the controlling terminal instead, which such a child
// inherits, so there it is a weaker test.
//
// WHY EVERYTHING IS A PARAMETER. Every read of the filesystem, /proc, `ps` and
// tmux goes through `deps`, so the suite classifies fixtures — a recycled pid,
// a torn record, a forged TMUX_PANE, a macOS process table — without reading a
// single real process, and without a tmux on the machine that runs it.
//
// A CODEX THAT KEEPS ITS ROLLOUT IN A DAEMON. Codex 0.162 hands the rollout to
// `codex app-server`, a daemon with no terminal that one machine's Codex
// sessions may share, so the process holding the file is not the one on the
// screen, and its ancestry leads to systemd, not to a pane. For a Codex the
// deck launched, the pane is found the other way round: Codex names its
// sessions with UUIDv7, whose first 48 bits are when it began, so a session
// that began after exactly one of the deck's unlabelled Codex panes in the
// same folder opened is that pane's — unless a Codex drawing on another
// terminal in that folder could have begun it just as well. Then it is not
// guessed at.
//
// WHAT THIS CANNOT SEE, said here so nobody has to rediscover it:
//   - An idle Codex holds no rollout open (one appears after the first message)
//     and a plain `codex` carries no id on its command line, so a Codex that is
//     running outside the deck and has not been sent anything reads as `gone`.
//     macOS has no /proc to find an open rollout through at all; there, only a
//     `codex resume <id>` is found. The adopt route's "still running" check
//     asks this module and shares the blind spot.
//   - A record written in another pid namespace or on another machine (a
//     devcontainer sharing ~/.claude) names a pid that means nothing here; it is
//     ignored rather than believed.
//   - On macOS no other process's environment can be read reliably (`ps eww`
//     shows it for the same user at best), so the pane is found by `pane_pid`
//     ancestry against the user's default tmux server only, never through
//     TMUX_PANE; a session in a tmux server under another name reads as C there.
import { readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { claudeConfigDir } from "./claude-dir.mjs";
import { run } from "./exec.mjs";
import { deadDeckSessions, findDeckSession, listDeckSessions } from "./terminal-sessions.mjs";
import { DECK_SOCKET, findTmux, runTmux, tmuxHasNoServer } from "./tmux.mjs";

/** Both providers name a session with a UUID. Anything else is refused before
 *  it reaches a file name or an argument vector: an id is later handed to
 *  `claude --resume`, and one spelled `--something` would be read as a flag. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The only names in sessions/ this module will open. Anchored on both ends,
 *  because `1234.ab12cd.key` sits in the same folder and holds a secret. */
export const SESSION_FILE = /^\d+\.json$/;

/** Bounds on what one question may read. The sessions folder holds one file
 *  per live session (tens); the bound is for a folder nothing ever cleans. */
const MAX_SESSION_FILES = 512;
const MAX_ANCESTRY = 64;
const MAX_FDS = 1024;
const MAX_CODEX_PROCESSES = 64;

/** The deck sessions that are a session in their own right. An `attach`
 *  session is the wrapper around somebody else's background session (case D)
 *  and is reported as that session's wrapper, never as case A. */
const OWN_KINDS = Object.freeze(["launch", "resume"]);

/** The user's own tmux server, which is where a process with no TMUX in its
 *  environment would be if it were in tmux at all. */
const DEFAULT_SOCKET = Object.freeze({ name: "default" });

/** A terminal a pane can be: a pts on Linux, a ttys on macOS. `/dev/pts/ptmx`
 *  is the multiplexer, not a terminal, and bare `/dev/tty` names none. */
const TTY_PATH = /^\/dev\/(?:pts\/\d+|tty[A-Za-z0-9.]+)$/;

/** The `claude bg-pty-host` command line, as Claude Code 2.1.294 spells it:
 *  `claude bg-pty-host --bg-pty-host <sock> <cols> <rows> -- <claude>`. */
const PTY_HOST = /(^|\s)(--)?bg-pty-host(\s|$)/;

/**
 * The `list-panes -a -F` format the default lister asks for. The session name
 * goes last because it is the one field a user chooses, so it is the one field
 * that may contain the separator.
 */
export const PANE_FORMAT = [
  "#{pane_id}", "#{pane_pid}", "#{pane_dead}", "#{pane_tty}", "#{socket_path}", "#{session_name}",
].join("\t");

/**
 * `ps` arguments for the process table on a platform without /proc. `lstart`
 * is how Claude Code spells a process's start time there, so it is what makes
 * a record's `procStart` checkable; the C locale and UTC are what Claude Code
 * runs it under, and the string is compared as it wrote it.
 */
export const PS_TABLE_ARGS = ["-A", "-ww", "-o", "pid=,ppid=,tty=,lstart=,command="];

/**
 * Check the three things a target question is made of, before any of them
 * reaches a file name, a pattern or an argument vector.
 *
 * Exported so the routes can answer a malformed question with a 400 before
 * asking anything; resolveTarget checks again on its own, because a module
 * that hands a session id to `claude --resume` cannot rely on its caller.
 * A missing or relative `cwd` is not an error: it only means the session
 * cannot be reopened here, which the target says.
 */
export function checkTargetQuery(query) {
  // Lower case, because that is how both providers write the id into every
  // file this module compares it with: the records, the rollout names, argv.
  const sessionId = typeof query?.sessionId === "string" ? query.sessionId.trim().toLowerCase() : "";
  if (!SESSION_ID.test(sessionId)) return { ok: false, error: "That is not a session id." };
  const provider = query?.provider;
  if (provider !== "claude" && provider !== "codex") {
    return { ok: false, error: "The provider must be claude or codex." };
  }
  const cwd = typeof query?.cwd === "string" && isAbsolute(query.cwd) ? query.cwd : "";
  return { ok: true, sessionId, provider, cwd };
}

/**
 * One `/proc/<pid>/stat` line, or null: the pid, the parent, the tty and the
 * start time in clock ticks (field 22), as a string because that is how Claude
 * Code records it.
 *
 * Read from the LAST `)`, because field 2 is the command name and may hold
 * spaces and parentheses of its own; `(tmux: server)` would otherwise shift
 * every field after it. Field 3 is then the first word, so field N is at N - 3.
 */
export function parseProcStat(text) {
  const s = String(text ?? "");
  const open = s.indexOf("(");
  const close = s.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const pid = Number(s.slice(0, open).trim());
  const f = s.slice(close + 1).trim().split(/\s+/);
  if (f.length < 20) return null;
  const ppid = Number(f[1]);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid)) return null;
  return { pid, comm: s.slice(open + 1, close), ppid, ttyNr: Number(f[4]), start: f[19] };
}

/** `/proc/<pid>/environ` as an object. It is the environment the process
 *  started with, which is exactly what TMUX and TMUX_PANE are wanted from. */
export function parseEnviron(text) {
  const env = {};
  for (const kv of String(text ?? "").split("\0")) {
    const i = kv.indexOf("=");
    if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return env;
}

/**
 * The server socket out of a TMUX variable, which tmux writes as
 * `<socket path>,<server pid>,<session index>`. Taken from the right, because
 * the path is the one part that may itself contain a comma. Empty when the
 * value is not that shape.
 */
export function tmuxSocketPath(value) {
  const m = /^(.*),(\d+),(-?\d+)$/.exec(String(value ?? ""));
  return m && m[1] && m[1].startsWith("/") ? m[1] : "";
}

/** `list-panes -a -F PANE_FORMAT` output, one pane per line. A line that does
 *  not start with a pane id is not a pane and is skipped. */
export function parsePaneList(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    const [id, pid, dead, tty, socketPath, ...name] = line.replace(/\r$/, "").split("\t");
    if (!/^%\d+$/.test(id ?? "")) continue;
    out.push({
      id,
      pid: Number(pid) || 0,
      dead: dead === "1",
      tty: tty ?? "",
      socketPath: socketPath ?? "",
      session: name.join("\t"),
    });
  }
  return out;
}

/** `ps PS_TABLE_ARGS` output as rows of { pid, ppid, tty, start, cmd }. The
 *  start time is five words with a padded day ("Thu Oct  8 09:12:33 2026"),
 *  kept with its spacing collapsed, and a record's `procStart` is collapsed
 *  the same way before the two are compared. */
export function parsePsTable(text) {
  const out = [];
  const row = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)(?:\s+(.*))?$/;
  for (const line of String(text ?? "").split("\n")) {
    const m = row.exec(line);
    if (!m) continue;
    const tty = m[3];
    out.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      tty: tty === "?" || tty === "??" || tty === "-" ? "" : `/dev/${tty}`,
      start: collapse(m[4]),
      cmd: (m[5] ?? "").trim(),
    });
  }
  return out;
}

/**
 * Every Claude Code session record in `<claudeDir>/sessions`, as far as each
 * one parses. Only `<digits>.json` is opened. A record that does not parse is
 * a write caught half way and is skipped, not an error; one whose pid differs
 * from its file name is not trusted with either.
 */
export function readClaudeSessions(claudeDir, { readdir, readFile }) {
  const dir = join(claudeDir, "sessions");
  let names;
  try { names = readdir(dir); } catch { return []; }
  if (!Array.isArray(names)) return [];
  const out = [];
  for (const name of names.map(String).filter((n) => SESSION_FILE.test(n)).slice(0, MAX_SESSION_FILES)) {
    let raw;
    try { raw = JSON.parse(String(readFile(join(dir, name)))); } catch { continue; }
    const rec = sessionRecordOf(raw, Number(name.slice(0, -".json".length)));
    if (rec) out.push(rec);
  }
  return out;
}

function sessionRecordOf(raw, filePid) {
  if (!raw || typeof raw !== "object") return null;
  const { pid, sessionId } = raw;
  if (!Number.isInteger(pid) || pid <= 1 || pid !== filePid) return null;
  if (typeof sessionId !== "string" || !sessionId) return null;
  const start = typeof raw.procStart === "string" || typeof raw.procStart === "number" ? String(raw.procStart) : "";
  return {
    pid,
    sessionId,
    kind: typeof raw.kind === "string" ? raw.kind : "",
    procStart: start || null,
    jobId: typeof raw.jobId === "string" ? raw.jobId : "",
    pidDomain: typeof raw.pidDomain === "string" ? raw.pidDomain : "",
    startedAt: Number.isFinite(raw.startedAt) ? raw.startedAt : 0,
  };
}

/**
 * What `claude attach` is handed for a background session: the record's own
 * short id, which is what `claude --bg` prints and `claude attach --help`
 * names, else the first eight characters of the session id, which is how
 * Claude Code forms that short id. Never anything that could read as a flag.
 */
export function attachIdOf(rec, sessionId) {
  const job = typeof rec?.jobId === "string" ? rec.jobId : "";
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(job) ? job : String(sessionId).slice(0, 8);
}

/**
 * Where a session can be reached from, or why it cannot. See the header for
 * the kinds; the shapes are:
 *
 *   { kind: "A", socket, pane, name, learnedId?, launchKey? }
 *                                          socket is the deck's own (DECK_SOCKET)
 *   { kind: "B", socket: { path }, pane }
 *   { kind: "D", attachId, wrapper? }      wrapper: a live deck pane already
 *                                          running `claude attach` for it
 *   { kind: "C", adoptable, pid }
 *   { kind: "gone", adoptable, deadSessions? }
 *   { kind: "unsupported", reason, install? }
 *     reason: "missing" | "too-old" | "unsupported-platform" (as findTmux
 *     says it) or "invalid" for a question that was not a session
 *
 * `adoptable` says the session could be reopened here: a provider that
 * resumes by id and a working directory that still exists. It does not say
 * the original has stopped — for C it has not — which is the adopt route's
 * check to make when somebody asks.
 *
 * Three fields are for the routes and never reach the page (describeTarget
 * leaves them out). `launchKey` is on an A in a deck pane a page launch
 * named, for the target route to say whether that launch became this
 * session. `learnedId` is on an A that was found by its process
 * because its pane's `@ccdeck-session` is still empty — a Codex the deck
 * launched, recognised by the rollout it holds open — and is the id that
 * process was found by, for the open route to write into the option so the
 * next lookup is the listing alone. `deadSessions` is on a gone: the names of
 * the dead deck panes this session left behind, which the adopt route clears
 * before it reopens the session (terminal-sessions' deadDeckSessions).
 *
 * This module still writes nothing; it only says what it saw.
 *
 * Never rejects for a state of the machine: a missing tmux, a tmux that does
 * not answer, a dead pane, a torn record or an unreadable /proc are all
 * answers. `deps`, every one
 * optional: platform, claudeDir, readdir/readFile/readlink (synchronous,
 * string-returning), isDir, processTable (async; the `ps` table where there
 * is no /proc), tmux (findTmux's answer), deckSocket, listDeckSessions (async)
 * and listPanes(socket) (async; panes as parsePaneList shapes them).
 */
/**
 * A tmux that did not answer: it outran runTmux's timeout, or failed for a
 * reason other than having no server to ask. Its silence says nothing about
 * where a session is. Read as "no panes", a live session in a tmux that had
 * stalled for three seconds was offered "Reopen here" as if it had ended, and
 * the card stayed after tmux came back. resolveTarget answers it as what it
 * is instead, and the panel offers to try again.
 */
export class TmuxNotAnswering extends Error {
  constructor() {
    super("tmux did not answer.");
    this.name = "TmuxNotAnswering";
  }
}

export async function resolveTarget(query, deps = {}) {
  const q = checkTargetQuery(query);
  if (!q.ok) return { kind: "unsupported", reason: "invalid" };
  const platform = deps.platform ?? process.platform;
  // Windows is refused before anything is asked of it: there is no tmux there,
  // and findTmux would only spend a probe to say so.
  if (platform === "win32") return { kind: "unsupported", reason: "unsupported-platform" };

  const tmux = deps.tmux ?? await findTmux({ platform });
  // Every door below is a tmux pane — the deck's, the user's, or the deck pane
  // that runs `claude attach` — and so is reopening a session here. Without a
  // tmux that works there is nothing to offer, whatever state the session is in.
  if (!tmux?.ok) {
    return { kind: "unsupported", reason: tmux?.reason || "missing", ...(tmux?.install ? { install: tmux.install } : {}) };
  }
  const io = ioFor(deps, tmux, platform);
  try {
    return await locateIn(q, io, platform);
  } catch (err) {
    if (err instanceof TmuxNotAnswering) return { kind: "unsupported", reason: "not-answering" };
    throw err;
  }
}

async function locateIn(q, io, platform) {
  const deck = await deckSessionsOf(io);
  const own = findDeckSession(deck, q.sessionId, { kinds: OWN_KINDS });
  if (own && !own.dead) return deckTarget(io, own, q.sessionId);
  // A dead deck pane is not the end of it: the session may have been resumed
  // somewhere else since, so it is looked for like any other.

  const proc = platform === "linux" ? procView(io) : await psView(io);
  const holder = q.provider === "claude"
    ? claudeHolder(q.sessionId, io, proc) ?? unrecordedClaude(q, io, proc)
    : codexHolder(q.sessionId, proc);
  if (!holder) {
    // Where no process's open files can be read (macOS), no holder says
    // nothing — and offering to reopen a Codex the deck is running would put
    // two writers on one rollout.
    if (q.provider === "codex" && platform !== "linux") {
      const began = launchedCodexPane(q, deck, proc, io);
      if (began) return deckTarget(io, began, q.sessionId);
    }
    const dead = deadDeckSessions(deck, q.sessionId);
    return { kind: "gone", adoptable: resumable(q, io), ...(dead.length ? { deadSessions: dead } : {}) };
  }

  if (holder.background) {
    const found = findDeckSession(deck, q.sessionId, { kinds: ["attach"] });
    const wrapper = found && !found.dead ? found : null;
    return {
      kind: "D",
      attachId: holder.attachId,
      ...(wrapper ? { wrapper: { name: wrapper.name, pane: wrapper.pane } } : {}),
    };
  }

  // A process under one of the deck's own panes is case A whatever its option
  // says: a Codex the deck launched has no id to set until its first message,
  // and this is how it is recognised before then. The deck's list carries no
  // pane tty, so the one check available here is that the process draws on a
  // terminal at all.
  holder.tty = proc.tty(holder.pid);
  const pids = new Set(holder.chain.map((c) => c.pid));
  const under = holder.tty === "" ? undefined
    : deck.find((s) => !s.dead && OWN_KINDS.includes(s.kind) && pids.has(s.panePid));
  if (under) return deckTarget(io, under, q.sessionId);
  // Held by a process with no terminal: a Codex daemon (see the header).
  if (q.provider === "codex" && holder.tty === "") {
    const began = launchedCodexPane(q, deck, proc, io);
    if (began) return deckTarget(io, began, q.sessionId);
  }

  const found = await hostPane(holder, proc, io);
  if (found && onSocket(found.socketPath, io.deckSocket)) {
    return { kind: "A", socket: io.deckSocket, pane: found.pane, name: found.session };
  }
  if (found) return { kind: "B", socket: found.socket, pane: found.pane };
  return { kind: "C", adoptable: resumable(q, io), pid: holder.pid };
}

/**
 * The sentence the panel shows for a target, and the little it needs beside
 * it. No paths, no pids, no pane ids: the panel never needs them, and the
 * target itself stays on the server, bound to the ticket the panel is given.
 *
 * Case C's copy is the plan's, word for word (ux.md, "Not startable here"):
 * honest, not apologetic, and with the cost of reopening named inline. Its
 * `hint` is the step before that button can work — the original has to stop
 * first — so the panel can say it before the click rather than after a 409.
 */
export function describeTarget(target) {
  const kind = target?.kind;
  switch (kind) {
    case "A":
      return { kind, label: "This session runs in a terminal the deck started, so the panel attaches to it directly." };
    case "B":
      return { kind, label: "This session runs in your own tmux, so the panel joins that pane at its own size and leaves your terminal as it is." };
    case "D":
      return { kind, label: "This is a Claude background session, so the panel opens it the way claude attach does, and it keeps running when the panel closes." };
    case "C":
      return target.adoptable
        ? {
          kind,
          label: "This session was started outside the deck, so there is no pane to attach to. Reopening it here continues the conversation; the old terminal's scrollback stays behind.",
          adoptable: true,
          hint: "Quit it in the terminal it is running in first, then reopen it here.",
        }
        : { kind, label: "This session was started outside the deck, so there is no pane to attach to.", adoptable: false };
    case "gone":
      return target.adoptable
        ? { kind, label: "This session has ended; reopening it here continues the conversation in a new terminal.", adoptable: true }
        : { kind, label: "This session has ended, and its project folder is no longer there to reopen it in.", adoptable: false };
    case "unsupported": {
      const reason = typeof target.reason === "string" ? target.reason : "";
      const install = typeof target.install === "string" && target.install ? { install: target.install } : {};
      return { kind, label: UNSUPPORTED_COPY[reason] ?? UNSUPPORTED_COPY.other, reason: reason || "other", ...install };
    }
    default:
      return { kind: "unsupported", label: UNSUPPORTED_COPY.other, reason: "other" };
  }
}

/** One fact each, not an error: the ux brief's "tmux missing" row. The install
 *  line, when findTmux has one for this platform, travels beside the label. */
const UNSUPPORTED_COPY = {
  "missing": "The terminal runs on tmux, which is not installed on this machine.",
  "too-old": "The terminal needs tmux 3.2 or newer, and this machine has an older one.",
  "unsupported-platform": "The terminal is not available on this operating system yet.",
  "invalid": "The deck could not tell which session this is.",
  "not-answering": "tmux is not answering right now, so the deck cannot tell where this session is. Nothing was changed; try again in a moment.",
  "other": "The terminal is not available here.",
};

// ---------------------------------------------------------------------------

function ioFor(deps, tmux, platform) {
  return {
    platform,
    claudeDir: deps.claudeDir ?? claudeConfigDir(),
    readdir: deps.readdir ?? ((p) => readdirSync(p)),
    readFile: deps.readFile ?? ((p) => readFileSync(p, "utf8")),
    readlink: deps.readlink ?? ((p) => readlinkSync(p)),
    isDir: deps.isDir ?? isDirectory,
    processTable: deps.processTable ?? readPsTable,
    deckSocket: deps.deckSocket ?? DECK_SOCKET,
    listDeckSessions: deps.listDeckSessions ?? (() => listDeckSessions({ tmux })),
    listPanes: deps.listPanes ?? ((socket) => listPanesOn(tmux, socket)),
  };
}

/** Every pane on one tmux server. A server that is not running answers
 *  non-zero, and that is not an error: it means there is no pane on it. A
 *  server that does not answer at all is TmuxNotAnswering. */
async function listPanesOn(tmux, socket) {
  const r = await runTmux(tmux, socket, ["list-panes", "-a", "-F", PANE_FORMAT]);
  if (r?.code === 0) return parsePaneList(r.stdout);
  if (tmuxHasNoServer(r?.stderr)) return [];
  throw new TmuxNotAnswering();
}

async function readPsTable() {
  const r = await run("ps", PS_TABLE_ARGS, { timeout: 3_000, env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
  return r.ok ? parsePsTable(r.stdout) : [];
}

function isDirectory(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/** The deck's own sessions. No server is an empty list (listDeckSessions
 *  says so); a listing that failed is not, and is TmuxNotAnswering. */
async function deckSessionsOf(io) {
  let list;
  try {
    list = await io.listDeckSessions();
  } catch {
    throw new TmuxNotAnswering();
  }
  return Array.isArray(list) ? list : [];
}

/** Case A on a deck session. A session whose `@ccdeck-session` is empty was
 *  found by its process, and the id it was found by is handed on as
 *  `learnedId`; a label already there is never offered a replacement, because
 *  a Claude that ran /clear holds a newer id than its pane's label and the
 *  label is the one the deck launched it under. */
function deckTarget(io, s, sessionId) {
  return {
    kind: "A", socket: io.deckSocket, pane: s.pane, name: s.name,
    ...(!s.sessionId && sessionId ? { learnedId: sessionId } : {}),
    ...(s.launchKey ? { launchKey: s.launchKey } : {}),
  };
}

function resumable(q, io) {
  return Boolean(q.cwd) && io.isDir(q.cwd);
}

function collapse(s) {
  return String(s).trim().replace(/\s+/g, " ");
}

/** Whether a socket path is the deck's own server, by name or by path. */
function onSocket(socketPath, deckSocket) {
  if (!socketPath || !deckSocket) return false;
  if (deckSocket.path) return socketPath === deckSocket.path;
  return Boolean(deckSocket.name) && basename(socketPath) === deckSocket.name;
}

// ---------------------------------------------------------------------------
// The two ways of looking at processes. Both answer the same questions —
// a process's parent, start time and command line, its tty, and on Linux its
// environment and open files — so everything above is written once.

function procView(io) {
  const commands = new Map();
  const command = (pid) => {
    if (!commands.has(pid)) {
      let cmd = "";
      try { cmd = String(io.readFile(`/proc/${pid}/cmdline`)).split("\0").filter(Boolean).join(" "); } catch { cmd = ""; }
      commands.set(pid, cmd);
    }
    return commands.get(pid);
  };
  const infos = new Map();
  return {
    info(pid) {
      if (!infos.has(pid)) {
        let st = null;
        try { st = parseProcStat(io.readFile(`/proc/${pid}/stat`)); } catch { st = null; }
        infos.set(pid, st && { pid: st.pid, ppid: st.ppid, start: st.start, cmd: command(pid) });
      }
      return infos.get(pid);
    },
    command,
    env(pid) {
      try { return parseEnviron(io.readFile(`/proc/${pid}/environ`)); } catch { return null; }
    },
    // The terminal the process draws on, "" when its standard streams are all
    // something else (pipes, files, /dev/null), and null when they could not
    // be read or only say "the controlling terminal" without naming it.
    tty(pid) {
      let seen = false, vague = false;
      for (const fd of ["0", "1", "2"]) {
        try {
          const t = String(io.readlink(`/proc/${pid}/fd/${fd}`));
          seen = true;
          if (TTY_PATH.test(t)) return t;
          if (t === "/dev/tty") vague = true;
        } catch { /* closed, or not ours to read */ }
      }
      return seen && !vague ? "" : null;
    },
    pids() {
      try { return io.readdir("/proc").map(String).filter((n) => /^\d+$/.test(n)).map(Number); } catch { return []; }
    },
    fds(pid) {
      let names;
      try { names = io.readdir(`/proc/${pid}/fd`); } catch { return []; }
      const out = [];
      for (const n of names.slice(0, MAX_FDS)) {
        try { out.push(String(io.readlink(`/proc/${pid}/fd/${n}`))); } catch { /* closed meanwhile */ }
      }
      return out;
    },
    // Which pid namespace and machine this deck sees, for records written
    // somewhere else. Claude Code spells the record's as
    // `linux:<machine-id>:pid:[<namespace inode>]`.
    domain() {
      let ns = "", machine = "";
      try { ns = String(io.readlink("/proc/self/ns/pid")); } catch { ns = ""; }
      try { machine = String(io.readFile("/etc/machine-id")).trim(); } catch { machine = ""; }
      return { ns, machine };
    },
  };
}

async function psView(io) {
  let rows = [];
  try { rows = await io.processTable(); } catch { rows = []; }
  const byPid = new Map((Array.isArray(rows) ? rows : []).map((r) => [r.pid, r]));
  return {
    info(pid) {
      const r = byPid.get(pid);
      return r ? { pid, ppid: r.ppid, start: r.start || null, cmd: r.cmd ?? "" } : null;
    },
    command: (pid) => byPid.get(pid)?.cmd ?? "",
    // No /proc: another process's environment is out of reach, and its open
    // files would need an lsof per click — more than what it finds is worth.
    env: () => null,
    tty: (pid) => (byPid.has(pid) ? byPid.get(pid).tty || "" : null),
    pids: () => [...byPid.keys()],
    fds: () => [],
    domain: () => ({ ns: "", machine: "" }),
  };
}

function ancestry(proc, pid) {
  const chain = [];
  const seen = new Set();
  for (let p = pid; p > 1 && chain.length < MAX_ANCESTRY && !seen.has(p);) {
    const info = proc.info(p);
    if (!info) break;
    seen.add(p);
    chain.push(info);
    p = info.ppid;
  }
  return chain;
}

// ---------------------------------------------------------------------------
// Finding the process that holds a session.

/** A record from another machine or pid namespace names a pid that is not
 *  this one's. Unknown on either side means no evidence either way. */
function foreignRecord(rec, here) {
  const m = /^linux:([0-9a-f]+):(pid:\[\d+\])$/i.exec(rec.pidDomain);
  if (!m) return false;
  if (here.machine && m[1].toLowerCase() !== here.machine.toLowerCase()) return true;
  return Boolean(here.ns) && m[2] !== here.ns;
}

/** The ways Claude Code is started: the native binary by name or under its
 *  versions folder, or the npm package's script under node. Used only where a
 *  record carries no start time to compare. */
function looksLikeClaude(cmd) {
  const first = String(cmd).split(" ")[0] ?? "";
  return /^claude(\.exe)?$/i.test(basename(first))
    || first.includes("/claude/versions/")
    || String(cmd).includes("@anthropic-ai/claude-code/");
}

/** The process a Claude record names, if it is still the one that wrote it. */
function liveProcess(rec, proc) {
  const p = proc.info(rec.pid);
  if (!p) return null;
  if (rec.procStart != null && p.start != null) return collapse(rec.procStart) === collapse(p.start) ? p : null;
  // No start time to compare on one side or the other: the pid has to at least
  // still be running Claude Code, or a recycled pid would pass for the session.
  return looksLikeClaude(p.cmd) ? p : null;
}

function claudeHolder(sessionId, io, proc) {
  const recs = readClaudeSessions(io.claudeDir, io).filter((r) => r.sessionId.toLowerCase() === sessionId);
  if (recs.length === 0) return null;
  const here = proc.domain();
  const live = [];
  for (const rec of recs) {
    if (foreignRecord(rec, here)) continue;
    const p = liveProcess(rec, proc);
    if (!p) continue;
    const chain = ancestry(proc, rec.pid);
    // The parent only: see WHY BACKGROUND BEFORE TMUX for the run that showed
    // what looking further up gets wrong.
    const host = chain.length > 1 && PTY_HOST.test(chain[1].cmd);
    live.push({ rec, chain, background: rec.kind === "bg" || host });
  }
  if (live.length === 0) return null;
  // Two live records for one session is a background session with something
  // else beside it, or a resume that started a copy. The background one is the
  // session itself; otherwise the newest is the one still being written to.
  const pick = live.find((l) => l.background)
    ?? live.sort((a, b) => b.rec.startedAt - a.rec.startedAt)[0];
  return {
    pid: pick.rec.pid,
    chain: pick.chain,
    background: pick.background,
    attachId: pick.background ? attachIdOf(pick.rec, sessionId) : undefined,
  };
}

/** Words after the binary that make a Claude process something other than an
 *  interactive session: a one-shot print, a background host or client, a
 *  server, a maintenance command. */
const NOT_A_SESSION = /^(-p|--print|attach|bg-pty-host|--bg-pty-host|bg-spare|--bg-spare|daemon|mcp|doctor|update|install|config|setup-token|migrate-installer|api-key)$/;

/**
 * A live Claude that no record accounts for, started in the session's folder,
 * when no record names the session at all — see the header for why a record
 * can be missing. Linux only: a process's folder is read off /proc/<pid>/cwd,
 * and macOS has no cheap equivalent, so there a session without a record
 * still reads as gone. The newest such process wins, as with records.
 */
function unrecordedClaude(q, io, proc) {
  if (!q.cwd || io.platform !== "linux") return null;
  const recorded = new Set(readClaudeSessions(io.claudeDir, io).map((r) => r.pid));
  let best = null;
  let looked = 0;
  for (const pid of proc.pids()) {
    if (recorded.has(pid)) continue;
    const cmd = proc.command(pid);
    if (!looksLikeClaude(cmd)) continue;
    if (++looked > MAX_CODEX_PROCESSES) break;
    const words = cmd.split(" ").slice(1);
    if (words.some((w) => NOT_A_SESSION.test(w))) continue;
    let cwd = "";
    try { cwd = String(io.readlink(`/proc/${pid}/cwd`)); } catch { continue; }
    if (cwd !== q.cwd) continue;
    const info = proc.info(pid);
    if (!info) continue;
    if (!best || Number(info.start ?? 0) > Number(best.start ?? 0)) best = info;
  }
  if (!best) return null;
  const chain = ancestry(proc, best.pid);
  return chain.length ? { pid: best.pid, chain, background: false } : null;
}

/** Whether a command line is Codex: the native binary, or the npm launcher's
 *  script under node. Only the first two words are looked at, so a process
 *  that merely mentions codex — a browser profile, an editor — is not one. */
function looksLikeCodex(cmd) {
  return String(cmd).split(" ").slice(0, 2).some((w) => /^codex(\.js|\.exe)?$/i.test(basename(w)));
}

function isRolloutFor(target, sessionId) {
  const name = basename(String(target));
  return name.startsWith("rollout-") && name.endsWith(".jsonl") && name.toLowerCase().includes(sessionId);
}

/**
 * The Codex process holding a session: the one with its rollout open, which
 * is the native binary once the session has had a message, else one started
 * as `codex resume <id>`. Null when neither is found — which, for an idle
 * Codex started without an id, is not proof it has stopped (see the header).
 *
 * It costs one command-line read per process on the machine, because Codex
 * writes nothing that names its pid: measured at 12.7 ms over 811 processes on
 * the machine this was written on, once per click on a Codex node. Open files
 * are read only for processes that are Codex, so a browser holding thousands
 * of descriptors costs nothing here.
 */
function codexHolder(sessionId, proc) {
  let byArgs = 0;
  let looked = 0;
  for (const pid of proc.pids()) {
    const cmd = proc.command(pid);
    if (!looksLikeCodex(cmd)) continue;
    if (++looked > MAX_CODEX_PROCESSES) break;
    if (proc.fds(pid).some((t) => isRolloutFor(t, sessionId))) return codexAt(pid, proc);
    if (!byArgs && cmd.toLowerCase().split(" ").includes(sessionId)) byArgs = pid;
  }
  return byArgs ? codexAt(byArgs, proc) : null;
}

/** When a Codex session began, read off its id: Codex names sessions with
 *  UUIDv7, whose first 48 bits are the time in milliseconds. Null for an id
 *  of any other version, which then says nothing about when. */
export function codexIdTime(sessionId) {
  const id = String(sessionId ?? "").toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) return null;
  return parseInt(id.replace(/-/g, "").slice(0, 12), 16);
}

/** How far a pane's start (whole seconds, from tmux) may sit after the
 *  session it began. */
const PANE_CLOCK_SLACK_MS = 1_000;

/**
 * The deck pane a Codex session began in, when the process holding its
 * rollout is a daemon and cannot say (see the header): the one unlabelled,
 * live deck Codex pane in the session's folder that opened before the
 * session began. Null when there is not exactly one, and when a Codex on some
 * other terminal could have begun it: in the same folder where /proc says
 * where a process runs, anywhere where it cannot.
 */
function launchedCodexPane(q, deck, proc, io) {
  const began = codexIdTime(q.sessionId);
  if (began == null || !q.cwd) return null;
  const panes = deck.filter((s) => !s.dead && s.agent === "codex" && OWN_KINDS.includes(s.kind)
    && !s.sessionId && s.cwd === q.cwd && Number.isFinite(s.created) && s.created <= began + PANE_CLOCK_SLACK_MS);
  if (panes.length !== 1) return null;
  const deckPids = new Set(deck.filter((s) => !s.dead).map((s) => s.panePid));
  let looked = 0;
  for (const pid of proc.pids()) {
    if (!looksLikeCodex(proc.command(pid))) continue;
    if (++looked > MAX_CODEX_PROCESSES) return null;
    // A daemon, or anything else with no terminal, began nothing on a screen.
    if (proc.tty(pid) === "") continue;
    if (ancestry(proc, pid).some((c) => deckPids.has(c.pid))) continue;
    if (io.platform === "linux") {
      let cwd = "";
      try { cwd = String(io.readlink(`/proc/${pid}/cwd`)); } catch { return null; }
      if (cwd !== q.cwd) continue;
    }
    return null;
  }
  return panes[0];
}

function codexAt(pid, proc) {
  const chain = ancestry(proc, pid);
  return chain.length ? { pid, chain, background: false } : null;
}

/**
 * The tmux pane a process runs in, if any.
 *
 * TMUX in the process's own environment names the server; TMUX_PANE names the
 * pane, and is believed only when that pane's process is one of this
 * process's ancestors — a pane id is a counter, and an environment outlives
 * the pane it was copied from. Ancestry alone catches a process started deeper
 * in the pane; the tty catches one moved in later (reptyr), whose ancestry
 * never passes through the pane at all.
 *
 * With no TMUX to go on — macOS, where the environment is out of reach, or a
 * Linux process started outside tmux — only the user's default server is
 * asked. A process in some other server under another name is then C, which
 * is the honest answer when nothing says where that server is.
 */
async function hostPane(holder, proc, io) {
  const env = proc.env(holder.pid);
  const fromEnv = env?.TMUX ? tmuxSocketPath(env.TMUX) : "";
  const socket = fromEnv ? { path: fromEnv } : DEFAULT_SOCKET;
  let panes;
  try {
    panes = await io.listPanes(socket);
  } catch (err) {
    if (err instanceof TmuxNotAnswering) throw err;
    panes = [];
  }
  // A pane that cannot be showing this process is not a candidate at all: a
  // dead one, or one on another terminal than the one the process draws on
  // (see WHY A PANE HAS TO SHOW THE PROCESS). An unknown tty on either side is
  // no evidence against.
  const tty = holder.tty;
  const shows = (p) => !p.dead && (tty == null || (tty !== "" && (!p.tty || p.tty === tty)));
  const live = (Array.isArray(panes) ? panes : []).filter(shows);
  if (live.length === 0) return null;
  const pids = new Set(holder.chain.map((c) => c.pid));
  const byEnv = env?.TMUX_PANE ? live.find((p) => p.id === env.TMUX_PANE && pids.has(p.pid)) : undefined;
  const byChain = live.find((p) => pids.has(p.pid));
  const pane = byEnv ?? byChain ?? (tty ? live.find((p) => p.tty === tty) : undefined);
  if (!pane) return null;
  const socketPath = pane.socketPath || fromEnv;
  return {
    pane: pane.id,
    session: pane.session,
    socketPath,
    socket: socketPath ? { path: socketPath } : socket,
  };
}
