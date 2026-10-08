#!/usr/bin/env node
// SPIKE — ccdeck-internal#10. Throwaway: nothing here ships, and `spikes/` is not
// in package.json `files`, so it cannot reach the tarball by accident.
//
// The question: given a session the deck knows only by `session_id` and `cwd`,
// can it find the OS process, and say whether a tmux pane owns it? Cases B and C
// of plans/cli-terminal cannot be told apart without this.
//
//   node spikes/terminal/session-pid.mjs <session-id or prefix> [--tmux <bin>] [-L <socket>]
//   node spikes/terminal/session-pid.mjs --all
//
// Linux only, on purpose — see FINDINGS.md for what macOS and Windows lack.
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");

// Claude Code writes ~/.claude/sessions/<pid>.json for every live session it
// runs (interactive and --bg), with sessionId, cwd and procStart. That is the
// mapping the plan expected to have to guess from cwd; it does not have to.
function claudeSessionFiles() {
  const dir = path.join(CLAUDE_DIR, "sessions");
  let names = [];
  try { names = readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue;          // the .key files beside them are secrets; never read
    try { out.push(JSON.parse(readFileSync(path.join(dir, n), "utf8"))); } catch { /* torn write */ }
  }
  return out;
}

// /proc/<pid>/stat, parsed from the last ')' because comm may contain spaces
// and parentheses.
function stat(pid) {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, "utf8");
    const comm = s.slice(s.indexOf("(") + 1, s.lastIndexOf(")"));
    const f = s.slice(s.lastIndexOf(")") + 2).split(" ");
    return { pid, comm, ppid: Number(f[1]), ttyNr: Number(f[4]), starttime: f[19] };
  } catch { return null; }
}

// A recorded pid is evidence only while the process holding it is the one that
// wrote the record. procStart is the kernel's start time in clock ticks, so a
// recycled pid fails this even when it is alive.
function liveAndSame(rec) {
  const st = stat(rec.pid);
  if (!st) return { alive: false };
  return { alive: true, same: rec.procStart == null || String(rec.procStart) === st.starttime, st };
}

function ancestry(pid) {
  const chain = [];
  for (let p = pid, i = 0; p > 1 && i < 64; i++) {
    const st = stat(p);
    if (!st) break;
    let args = "";
    try { args = readFileSync(`/proc/${p}/cmdline`, "utf8").split("\0").filter(Boolean).join(" "); } catch {}
    chain.push({ ...st, args });
    p = st.ppid;
  }
  return chain;
}

// The initial environment. TMUX_PANE is exact for a process started inside
// tmux; it is absent for one moved in later (reptyr), which is why ancestry is
// asked as well.
function environ(pid) {
  try {
    const env = {};
    for (const kv of readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")) {
      const i = kv.indexOf("=");
      if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
    }
    return env;
  } catch { return null; }
}

function ttyOf(pid) {
  for (const fd of ["0", "1", "2"]) {
    try {
      const t = readlinkSync(`/proc/${pid}/fd/${fd}`);
      if (t.startsWith("/dev/pts/") || t.startsWith("/dev/tty")) return t;
    } catch {}
  }
  return null;
}

// Every pane on one tmux server. A missing binary or no server is an answer,
// not an error: there is then nothing to attach to.
function tmuxPanes(bin, socket) {
  const sock = socket ? ["-L", socket] : [];
  try {
    const out = execFileSync(bin, [...sock, "list-panes", "-a", "-F",
      "#{pane_id}\t#{pane_pid}\t#{pane_tty}\t#{session_name}:#{window_index}.#{pane_index}\t#{socket_path}"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 });
    return out.trim().split("\n").filter(Boolean).map(l => {
      const [id, pid, tty, target, sock] = l.split("\t");
      return { id, pid: Number(pid), tty, target, socket: sock };
    });
  } catch (e) {
    return e.code === "ENOENT" ? null : [];
  }
}

function classify(rec, opts) {
  const live = liveAndSame(rec);
  if (!live.alive) return { session: rec.sessionId, verdict: "gone", why: "no process holds the recorded pid" };
  if (!live.same) return { session: rec.sessionId, verdict: "gone", why: "the pid was recycled (procStart differs)" };

  const chain = ancestry(rec.pid);
  const env = environ(rec.pid) ?? {};
  const panes = tmuxPanes(opts.tmux, opts.socket);
  const pids = new Set(chain.map(c => c.pid));
  const tty = ttyOf(rec.pid);
  const pane = panes?.find(p => p.id === env.TMUX_PANE && pids.has(p.pid))
    ?? panes?.find(p => pids.has(p.pid))
    ?? panes?.find(p => p.tty === tty);
  // Claude hosts each `claude --bg` session on a pty held by its own
  // `claude bg-pty-host` process, which outlives the daemon that started it —
  // three of five sessions measured here had been reparented to systemd after a
  // daemon restart and were still attachable. So the record's `kind` decides,
  // and the host in the chain is only the confirmation. Neither tmux nor a host
  // terminal: `claude attach <id>` is its only door.
  const host = chain.find(c => / bg-pty-host /.test(c.args));
  const daemon = rec.kind === "bg" || host ? (host ?? chain.find(c => / daemon run\b/.test(c.args)) ?? { pid: "?" }) : null;

  let verdict, why;
  if (pane && pane.target.startsWith("ccdeck-")) { verdict = "A"; why = `deck-owned tmux pane ${pane.id} (${pane.target})`; }
  else if (pane) { verdict = "B"; why = `host tmux pane ${pane.id} (${pane.target}) via ${env.TMUX_PANE === pane.id ? "TMUX_PANE" : "ancestry"}`; }
  else if (daemon) { verdict = "D"; why = `Claude's pty host pid ${daemon.pid} owns ${tty ?? "its pty"}; attach with \`claude attach ${rec.sessionId.slice(0, 8)}\``; }
  else { verdict = "C"; why = `plain process on ${tty ?? "no tty"}; nothing to attach to`; }
  if (env.TMUX && !pane) why += ` (TMUX is set but no pane on ${opts.socket ?? "the default socket"} matches — another server?)`;

  return {
    session: rec.sessionId, pid: rec.pid, kind: rec.kind, status: rec.status, cwd: rec.cwd, tty,
    verdict, why, tmux: panes === null ? "not installed" : `${panes.length} pane(s) seen`,
    chain: chain.map(c => `${c.pid}:${c.comm}`).join(" <- "),
  };
}

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const opts = { tmux: opt("--tmux") ?? "tmux", socket: opt("-L") };
const want = argv.find((a, i) => !a.startsWith("-") && !["--tmux", "-L"].includes(argv[i - 1]));
const recs = claudeSessionFiles();
const picked = argv.includes("--all") ? recs : recs.filter(r => want && r.sessionId?.startsWith(want));
if (!picked.length) {
  console.error(want ? `no live Claude session file names ${want}` : "usage: session-pid.mjs <session-id> | --all");
  process.exit(1);
}
for (const r of picked) console.log(JSON.stringify(classify(r, opts), null, 2));
