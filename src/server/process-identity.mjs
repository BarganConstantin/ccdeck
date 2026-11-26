// Which process holds a Claude Code session, read off the machine: the
// records Claude Code writes in <config dir>/sessions, and two views of the
// process table — /proc on Linux, `ps` where there is none — that answer the
// same questions (parent, start time, command line, tty, environment, open
// files).
//
// TWO READERS. terminal-target.mjs, the JS terminal backend kept as the
// engine's reference, finds a session's process with these; stop-elsewhere.mjs,
// on the deck's own path, proves the one process it may signal with the same
// ones. They live here, apart from the backend, so the deck reaches them
// without reaching its tmux client and session launcher
// (terminal-js-offpath.test.ts). The rules each one follows are written beside
// it, and in terminal-target.mjs's header where they are about finding a pane.
//
// Every read goes through `io`, as in terminal-target.mjs, so the suites run
// them on fixtures.
import { basename, join } from "node:path";
import { run } from "./exec.mjs";

/** Bounds on what one question may read. The sessions folder holds one file
 *  per live session (tens); the bound is for a folder nothing ever cleans. */
const MAX_SESSION_FILES = 512;
const MAX_ANCESTRY = 64;
const MAX_FDS = 1024;

/** The only names in sessions/ this module will open. Anchored on both ends,
 *  because `1234.ab12cd.key` sits in the same folder and holds a secret. */
export const SESSION_FILE = /^\d+\.json$/;

/** A terminal a pane can be: a pts on Linux, a ttys on macOS. `/dev/pts/ptmx`
 *  is the multiplexer, not a terminal, and bare `/dev/tty` names none. */
const TTY_PATH = /^\/dev\/(?:pts\/\d+|tty[A-Za-z0-9.]+)$/;

/** The `claude bg-pty-host` command line, as Claude Code 2.1.294 spells it:
 *  `claude bg-pty-host --bg-pty-host <sock> <cols> <rows> -- <claude>`. */
export const PTY_HOST = /(^|\s)(--)?bg-pty-host(\s|$)/;

/**
 * `ps` arguments for the process table on a platform without /proc. `lstart`
 * is how Claude Code spells a process's start time there, so it is what makes
 * a record's `procStart` checkable; the C locale and UTC are what Claude Code
 * runs it under, and the string is compared as it wrote it.
 */
export const PS_TABLE_ARGS = ["-A", "-ww", "-o", "pid=,ppid=,tty=,lstart=,command="];

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

export async function readPsTable() {
  const r = await run("ps", PS_TABLE_ARGS, { timeout: 3_000, env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
  return r.ok ? parsePsTable(r.stdout) : [];
}

export function collapse(s) {
  return String(s).trim().replace(/\s+/g, " ");
}

// ---------------------------------------------------------------------------
// The two ways of looking at processes. Both answer the same questions —
// a process's parent, start time and command line, its tty, and on Linux its
// environment and open files — so what asks them is written once.

export function procView(io) {
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

export async function psView(io) {
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

export function ancestry(proc, pid) {
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

/** A record from another machine or pid namespace names a pid that is not
 *  this one's. Unknown on either side means no evidence either way. */
export function foreignRecord(rec, here) {
  const m = /^linux:([0-9a-f]+):(pid:\[\d+\])$/i.exec(rec.pidDomain);
  if (!m) return false;
  if (here.machine && m[1].toLowerCase() !== here.machine.toLowerCase()) return true;
  return Boolean(here.ns) && m[2] !== here.ns;
}

/** The ways Claude Code is started: the native binary by name or under its
 *  versions folder, or the npm package's script under node. terminal-target.mjs
 *  asks it only where a record carries no start time to compare;
 *  stop-elsewhere.mjs asks it as well, beside the start time, before it signals
 *  a process. */
export function looksLikeClaude(cmd) {
  const first = String(cmd).split(" ")[0] ?? "";
  return /^claude(\.exe)?$/i.test(basename(first))
    || first.includes("/claude/versions/")
    || String(cmd).includes("@anthropic-ai/claude-code/");
}

/** Words after the binary that make a Claude process something other than an
 *  interactive session: a one-shot print, a background host or client, a
 *  server, a maintenance command. */
export const NOT_A_SESSION = /^(-p|--print|attach|bg-pty-host|--bg-pty-host|bg-spare|--bg-spare|daemon|mcp|doctor|update|install|config|setup-token|migrate-installer|api-key)$/;
