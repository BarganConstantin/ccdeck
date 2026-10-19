// Which terminal a session can be reached through: the classification the
// terminal panel asks for on every click (src/server/terminal-target.mjs).
//
// Every case below runs on fixtures — a session-record folder on disk, a fake
// /proc, a fake `ps` table and fake `list-panes` output — because the answer
// depends on processes no test machine has: a Claude background session whose
// daemon died, a Claude in somebody's tmux, a recycled pid. The fake /proc is a
// map of the files the real one would hold, so the module reads them through
// the same parsing it uses on a machine.
//
// The record folder is real, on purpose. Beside each `<pid>.json` Claude Code
// keeps a `<pid>.<hash>.key` that holds a secret; the reader must never open
// it, and the only way to pin "never opened" is to record every path the
// reader touched in a folder where the key is actually there to be touched.
//
// The last block runs against this machine's real process table with a child
// this file starts, so the /proc and `ps` parsing is held to real output on
// every platform the suite runs on, not only to fixtures written beside it.
import { afterAll, describe, expect, it } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
import {
  attachIdOf, checkTargetQuery, codexIdTime, describeTarget, parseEnviron, parsePaneList, parseProcStat, parsePsTable,
  readClaudeSessions, resolveTarget, SESSION_FILE, TmuxNotAnswering, tmuxSocketPath,
  // @ts-expect-error — plain .mjs server module, no types
} from "../../server/terminal-target.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { DECK_SOCKET } from "../../server/tmux.mjs";

const ID = "0b9c2f4e-6a1d-4c3b-9e8f-7a6b5c4d3e2f";
const OTHER = "11111111-2222-4333-8444-555555555555";
const CWD = "/home/u/proj";
const MACHINE = "a7fb2db1c70e41b3be7699d8af5757ce";
const NS = "pid:[4026531836]";
const DOMAIN = `linux:${MACHINE}:${NS}`;
const DECK = { name: "ccdeck" };
const TMUX_OK = { ok: true, path: "/usr/bin/tmux", version: [3, 6], raw: "tmux 3.6" };
const LSTART = "Thu Oct  8 09:12:33 2026";

const root = mkdtempSync(join(tmpdir(), "ccdeck-target-"));
afterAll(() => rmTempDir(root));

// ---------------------------------------------------------------------------
// Fixtures

type Proc = {
  pid: number; ppid: number; cmd: string[]; start?: string; lstart?: string;
  env?: Record<string, string>; tty?: string; fds?: string[]; cwd?: string;
};

/** A /proc/<pid>/stat line with all 52 fields, starttime at field 22. The
 *  command name keeps its parentheses, which is what the parser must survive. */
function statLine(p: Proc): string {
  const f = new Array(50).fill("0");
  f[0] = "S";
  f[1] = String(p.ppid);
  f[4] = "34820";
  f[19] = p.start ?? "1000";
  return `${p.pid} (${basename(p.cmd[0] ?? "x").slice(0, 15)}) ${f.join(" ")}\n`;
}

function enoent(p: string) {
  return Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), { code: "ENOENT" });
}

/** A fake /proc and /etc/machine-id over the real filesystem for everything
 *  else, recording every path anything asked for. */
function fakeMachine(procs: Proc[], { ns = NS, machine = MACHINE } = {}) {
  const files = new Map<string, string>();
  const links = new Map<string, string>();
  const fdNames = new Map<number, string[]>();
  for (const p of procs) {
    files.set(`/proc/${p.pid}/stat`, statLine(p));
    files.set(`/proc/${p.pid}/cmdline`, p.cmd.join("\0") + "\0");
    if (p.env) files.set(`/proc/${p.pid}/environ`, Object.entries(p.env).map(([k, v]) => `${k}=${v}`).join("\0") + "\0");
    const fds = [p.tty ?? "/dev/null", p.tty ?? "/dev/null", p.tty ?? "/dev/null", ...(p.fds ?? [])];
    fdNames.set(p.pid, fds.map((_, i) => String(i)));
    fds.forEach((t, i) => links.set(`/proc/${p.pid}/fd/${i}`, t));
    if (p.cwd) links.set(`/proc/${p.pid}/cwd`, p.cwd);
  }
  links.set("/proc/self/ns/pid", ns);
  files.set("/etc/machine-id", `${machine}\n`);
  const opened: string[] = [];
  const faked = (p: string) => p.startsWith("/proc/") || p === "/proc" || p === "/etc/machine-id";
  return {
    opened,
    readFile(p: string) {
      opened.push(p);
      if (!faked(p)) return readFileSync(p, "utf8");
      const v = files.get(p);
      if (v == null) throw enoent(p);
      return v;
    },
    readdir(p: string) {
      opened.push(p);
      if (!faked(p)) return readdirSync(p);
      if (p === "/proc") return [...procs.map((x) => String(x.pid)), "self", "cpuinfo", "sys"];
      const m = /^\/proc\/(\d+)\/fd$/.exec(p);
      const names = m ? fdNames.get(Number(m[1])) : undefined;
      if (!names) throw enoent(p);
      return names;
    },
    readlink(p: string) {
      opened.push(p);
      const v = links.get(p);
      if (v == null) throw enoent(p);
      return v;
    },
  };
}

/** The `ps` table the macOS path reads, built from the same process list. */
function psRows(procs: Proc[]) {
  return procs.map((p) => ({ pid: p.pid, ppid: p.ppid, tty: p.tty ?? "", start: (p.lstart ?? LSTART).replace(/\s+/g, " "), cmd: p.cmd.join(" ") }));
}

let dirs = 0;
/** A Claude config dir holding these session records, a torn one and a key. */
function claudeDirWith(records: Array<Record<string, unknown>>, raw: Record<string, string> = {}) {
  const dir = join(root, `claude-${++dirs}`);
  mkdirSync(join(dir, "sessions"), { recursive: true });
  for (const r of records) writeFileSync(join(dir, "sessions", `${r.pid}.json`), JSON.stringify(r));
  for (const [name, text] of Object.entries(raw)) writeFileSync(join(dir, "sessions", name), text);
  // The secret beside the records. Unreadable as well as unwanted, so a reader
  // that opened it would fail loudly here as well as in the recorded paths.
  const key = join(dir, "sessions", "4242.9f8e7d6c5b4a.key");
  writeFileSync(key, "SECRET-KEY-MATERIAL");
  try { chmodSync(key, 0o000); } catch { /* Windows: the recorded paths are the check */ }
  return dir;
}

function record(pid: number, extra: Record<string, unknown> = {}) {
  return { pid, sessionId: ID, cwd: CWD, startedAt: 1_000, procStart: "1000", kind: "interactive", pidDomain: DOMAIN, ...extra };
}

type DeckSession = { name: string; sessionId: string; agent: string; kind: string; cwd: string; pane: string; panePid: number; dead: boolean; created: number; launchKey?: string };
function deckSession(extra: Partial<DeckSession>): DeckSession {
  return { name: "ccdeck-claude-0a1b2c3d", sessionId: ID, agent: "claude", kind: "launch", cwd: CWD, pane: "%1", panePid: 900, dead: false, created: 1, ...extra };
}

type Pane = { id: string; pid: number; dead: boolean; tty: string; socketPath: string; session: string };
const socketKey = (s: { path?: string; name?: string }) => s.path ?? `name:${s.name}`;

function setup({
  procs = [] as Proc[],
  records = [] as Array<Record<string, unknown>>,
  raw = {} as Record<string, string>,
  deck = [] as DeckSession[],
  panes = {} as Record<string, Pane[]>,
  platform = "linux",
  cwdExists = true,
  machine = {} as { ns?: string; machine?: string },
} = {}) {
  const fs = fakeMachine(procs, machine);
  const asked: Array<{ path?: string; name?: string }> = [];
  let listedDeck = 0;
  const deps = {
    platform,
    claudeDir: claudeDirWith(records, raw),
    tmux: TMUX_OK,
    deckSocket: DECK,
    readFile: fs.readFile,
    readdir: fs.readdir,
    readlink: fs.readlink,
    isDir: (p: string) => cwdExists && p === CWD,
    processTable: async () => psRows(procs),
    listDeckSessions: async () => { listedDeck++; return deck; },
    listPanes: async (socket: { path?: string; name?: string }) => { asked.push(socket); return panes[socketKey(socket)] ?? []; },
  };
  return { deps, opened: fs.opened, asked, listedDeck: () => listedDeck };
}

const ask = (deps: object, extra: Record<string, unknown> = {}) =>
  resolveTarget({ sessionId: ID, provider: "claude", cwd: CWD, ...extra }, deps);

// The processes every scenario is built from. The pids are the scenario.
const SYSTEMD_USER: Proc = { pid: 1923, ppid: 1, cmd: ["/usr/lib/systemd/systemd", "--user"] };
const TERMINAL: Proc = { pid: 4990, ppid: 1923, cmd: ["/usr/libexec/gnome-terminal-server"] };
const SHELL: Proc = { pid: 5000, ppid: 4990, cmd: ["bash"], tty: "/dev/pts/4" };
const PLAIN_CLAUDE: Proc = { pid: 5001, ppid: 5000, cmd: ["claude"], start: "1000", tty: "/dev/pts/4", env: { HOME: "/home/u" } };

const TMUX_SERVER: Proc = { pid: 6000, ppid: 1923, cmd: ["tmux"] };
const PANE_SHELL: Proc = { pid: 6001, ppid: 6000, cmd: ["-bash"], tty: "/dev/pts/7" };
const TMUX_VAR = "/tmp/tmux-1000/default,6000,0";
const TMUX_CLAUDE: Proc = {
  pid: 6002, ppid: 6001, cmd: ["claude"], start: "1000", tty: "/dev/pts/7",
  env: { TMUX: TMUX_VAR, TMUX_PANE: "%3", HOME: "/home/u" },
};
const HOST_PANES: Pane[] = [
  { id: "%1", pid: 6100, dead: false, tty: "/dev/pts/5", socketPath: "/tmp/tmux-1000/default", session: "notes" },
  { id: "%3", pid: 6001, dead: false, tty: "/dev/pts/7", socketPath: "/tmp/tmux-1000/default", session: "work" },
];

const DAEMON: Proc = { pid: 7000, ppid: 1, cmd: ["/home/u/.local/bin/claude", "daemon", "run", "--json-path", "/home/u/.claude/daemon.json"] };
const PTY_HOST: Proc = {
  pid: 7001, ppid: 7000,
  cmd: ["claude", "bg-pty-host", "--bg-pty-host", "/tmp/cc-daemon-1000/x/spare/a.pty.sock", "200", "50", "--", "/home/u/.local/bin/claude"],
};
const BG_CLAUDE: Proc = { pid: 7002, ppid: 7001, cmd: ["claude", "bg-spare", "--bg-spare", "/tmp/cc-daemon-1000/x/spare/a.claim.sock"], start: "1000" };

// ---------------------------------------------------------------------------

describe("a session the deck started (case A)", () => {
  it("attaches to the deck's own pane when the pane's session option names the session", async () => {
    const s = setup({ deck: [deckSession({ name: "ccdeck-claude-0a1b2c3d", pane: "%4" })] });
    expect(await ask(s.deps)).toEqual({ kind: "A", socket: DECK, pane: "%4", name: "ccdeck-claude-0a1b2c3d" });
    expect(s.opened, "a deck-owned session needs no process lookup at all").toEqual([]);
  });

  it("says the session has ended when its deck pane is dead and nothing else holds it", async () => {
    const s = setup({ deck: [deckSession({ dead: true })] });
    expect(await ask(s.deps)).toEqual({ kind: "gone", adoptable: true, deadSessions: ["ccdeck-claude-0a1b2c3d"] });
  });

  it("names every dead deck pane an ended session left behind, of any kind, and no live one or another session's", async () => {
    // Started in the deck, reopened there, and reached once through a
    // background attach, all of them ended: the adopt route clears these
    // before the next reopen.
    const s = setup({
      deck: [
        deckSession({ name: "ccdeck-claude-00000002", kind: "resume", dead: true, created: 2 }),
        deckSession({ name: "ccdeck-claude-00000001", kind: "launch", dead: true, created: 1 }),
        deckSession({ name: `ccdeck-att-${ID.slice(0, 8)}`, kind: "attach", dead: true, created: 3 }),
        deckSession({ name: "ccdeck-claude-0000000a", sessionId: OTHER, dead: true }),
        deckSession({ name: "ccdeck-codex-0000000b", sessionId: "", agent: "codex", dead: true }),
      ],
    });
    expect(await ask(s.deps)).toEqual({
      kind: "gone", adoptable: true,
      deadSessions: ["ccdeck-claude-00000001", "ccdeck-claude-00000002", `ccdeck-att-${ID.slice(0, 8)}`],
    });
  });

  it("names no dead pane when the session runs somewhere else now, since nothing is being reopened", async () => {
    const s = setup({
      deck: [deckSession({ dead: true })],
      procs: [SYSTEMD_USER, TERMINAL, SHELL, PLAIN_CLAUDE],
      records: [record(5001)],
    });
    expect(await ask(s.deps)).not.toHaveProperty("deadSessions");
  });

  it("looks past a dead deck pane for the session running somewhere else since", async () => {
    // Launched in the deck, ended, then resumed from the user's own terminal:
    // the dead pane is history, the plain process is the session now.
    const s = setup({
      deck: [deckSession({ dead: true })],
      procs: [SYSTEMD_USER, TERMINAL, SHELL, PLAIN_CLAUDE],
      records: [record(5001)],
    });
    expect(await ask(s.deps)).toEqual({ kind: "C", adoptable: true, pid: 5001 });
  });

  it("recognises a deck-launched Codex whose id was not set yet, by the rollout its process holds open", async () => {
    const rollout = `/home/u/.codex/sessions/2026/10/08/rollout-2026-10-08T09-12-33-${ID}.jsonl`;
    const s = setup({
      deck: [deckSession({ name: "ccdeck-codex-5e6f7a8b", agent: "codex", sessionId: "", pane: "%9", panePid: 900 })],
      procs: [
        { pid: 900, ppid: 880, cmd: ["node", "/home/u/.local/bin/codex"] },
        { pid: 901, ppid: 900, cmd: ["/home/u/.local/lib/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/codex/codex"], tty: "/dev/pts/9", fds: ["/dev/urandom", rollout] },
        // Mentions codex, holds files, and is not Codex: it must not be taken for one.
        { pid: 950, ppid: 1923, cmd: ["/home/u/Applications/codex-web-gpt-app/codex-web-gpt-launcher", "--type=zygote"], fds: [rollout] },
      ],
    });
    expect(await ask(s.deps, { provider: "codex" }), "and hands on the id it was found by, for the pane's empty label")
      .toEqual({ kind: "A", socket: DECK, pane: "%9", name: "ccdeck-codex-5e6f7a8b", learnedId: ID });
    expect(s.opened, "the launcher-lookalike's open files were read").not.toContain("/proc/950/fd");
  });

  it("carries the key of the page launch that made the pane, for the claim route to answer", async () => {
    // The route says yes or no to "is this the launch I asked for"; the key
    // never reaches the page from here (describeTarget leaves it out).
    const rollout = `/home/u/.codex/sessions/2026/10/08/rollout-2026-10-08T09-12-33-${ID}.jsonl`;
    const procs: Proc[] = [
      { pid: 900, ppid: 880, cmd: ["node", "/home/u/.local/bin/codex"] },
      { pid: 901, ppid: 900, cmd: ["codex"], tty: "/dev/pts/9", fds: [rollout] },
    ];
    const named = setup({ procs, deck: [deckSession({ name: "ccdeck-codex-5e6f7a8b", agent: "codex", sessionId: "", pane: "%9", panePid: 900, launchKey: "launch-k1" })] });
    expect(await ask(named.deps, { provider: "codex" })).toMatchObject({ kind: "A", pane: "%9", launchKey: "launch-k1" });
    const unnamed = setup({ procs, deck: [deckSession({ name: "ccdeck-codex-5e6f7a8b", agent: "codex", sessionId: "", pane: "%9", panePid: 900, launchKey: "" })] });
    expect(await ask(unnamed.deps, { provider: "codex" }), "a pane no launch named carries no key").not.toHaveProperty("launchKey");
  });

  it("never offers a new id for a deck pane that already carries one", async () => {
    // A Claude the deck launched as OTHER that has since moved on to ID (a
    // /clear): found by its process, but the label stays the one it was
    // launched under.
    const s = setup({
      deck: [deckSession({ name: "ccdeck-claude-5e6f7a8b", sessionId: OTHER, pane: "%9", panePid: 900 })],
      procs: [
        { pid: 900, ppid: 880, cmd: ["/bin/sh"] },
        { pid: 901, ppid: 900, cmd: ["claude"], start: "1000", tty: "/dev/pts/9" },
      ],
      records: [record(901)],
    });
    expect(await ask(s.deps)).toEqual({ kind: "A", socket: DECK, pane: "%9", name: "ccdeck-claude-5e6f7a8b" });
  });

  it("matches a session id whatever its case, as the providers write it in lower case", async () => {
    const s = setup({ deck: [deckSession({ pane: "%4" })] });
    expect(await ask(s.deps, { sessionId: ID.toUpperCase() })).toMatchObject({ kind: "A", pane: "%4" });
  });

  describe("a Codex whose rollout a daemon holds (Codex 0.162+)", () => {
    // Codex's ids are UUIDv7: this one began at 2026-10-12T14:28:38.097Z.
    const V7 = "01a13083-fa51-73c2-9b87-6f7923c74b56";
    const BEGAN = 1791815318097;
    const rollout = `/home/u/.codex/sessions/2026/10/12/rollout-2026-10-12T17-28-38-${V7}.jsonl`;
    // Shared, long-lived, no terminal, and a child of systemd: nothing in its
    // ancestry leads to the pane the session is drawn in.
    const DAEMON: Proc = { pid: 14926, ppid: 1923, cmd: ["/home/u/.codex/packages/app-server-daemon/releases/0.163.0/bin/codex", "app-server", "daemon"], fds: [rollout] };
    const TUI: Proc = { pid: 901, ppid: 900, cmd: ["/home/u/.local/bin/codex"], tty: "/dev/pts/9", cwd: CWD };
    const pane = (extra: Partial<DeckSession> = {}) =>
      deckSession({ name: "ccdeck-codex-5e6f7a8b", agent: "codex", sessionId: "", pane: "%9", panePid: 900, created: BEGAN - 60_000, ...extra });
    const codex = (deps: object) => resolveTarget({ sessionId: V7, provider: "codex", cwd: CWD }, deps);
    const PANE_PROC: Proc = { pid: 900, ppid: 880, cmd: ["sh"] };

    it("reads when a session began off its id, and nothing off an id of another version", () => {
      expect(codexIdTime(V7)).toBe(BEGAN);
      expect(codexIdTime(ID), "a v4 id says nothing about when").toBeNull();
      expect(codexIdTime("not-an-id")).toBeNull();
    });

    it("is the one deck pane that opened in its folder before it began, labelled with the id from then on", async () => {
      const s = setup({ procs: [SYSTEMD_USER, PANE_PROC, TUI, DAEMON], deck: [pane()] });
      expect(await codex(s.deps)).toEqual({ kind: "A", socket: DECK, pane: "%9", name: "ccdeck-codex-5e6f7a8b", learnedId: V7 });
      const named = setup({ procs: [SYSTEMD_USER, PANE_PROC, TUI, DAEMON], deck: [pane({ launchKey: "launch-k1" })] });
      expect(await codex(named.deps), "with the key of the launch that made it").toMatchObject({ kind: "A", pane: "%9", launchKey: "launch-k1" });
    });

    it("is not guessed at when a Codex on another terminal in that folder could have begun it", async () => {
      const elsewhere: Proc = { pid: 7001, ppid: 7000, cmd: ["codex"], tty: "/dev/pts/4", cwd: CWD };
      const s = setup({ procs: [SYSTEMD_USER, PANE_PROC, TUI, DAEMON, { pid: 7000, ppid: 1923, cmd: ["bash"], tty: "/dev/pts/4" }, elsewhere], deck: [pane()] });
      expect(await codex(s.deps)).toMatchObject({ kind: "C" });
      // In another folder it could not have.
      const other = setup({ procs: [SYSTEMD_USER, PANE_PROC, TUI, DAEMON, { ...elsewhere, cwd: "/home/u/other" }], deck: [pane()] });
      expect(await codex(other.deps)).toMatchObject({ kind: "A", pane: "%9" });
    });

    it("is not guessed at when a Codex with no terminal in that folder could have begun it, and the daemon is not one", async () => {
      // `codex exec`, run by a script or by another agent's shell, begins a
      // session of its own with no terminal at all.
      const exec: Proc = { pid: 7101, ppid: 7100, cmd: ["/home/u/.local/bin/codex", "exec", "fix the build"], cwd: CWD };
      const s = setup({ procs: [SYSTEMD_USER, PANE_PROC, TUI, DAEMON, { pid: 7100, ppid: 1923, cmd: ["node", "agent.js"] }, exec], deck: [pane()] });
      expect(await codex(s.deps)).toMatchObject({ kind: "C" });
      // The daemon has no terminal, runs in the folder it was started from, and
      // holds every rollout: it began none of them.
      const daemon = setup({ procs: [SYSTEMD_USER, PANE_PROC, TUI, { ...DAEMON, cwd: CWD }], deck: [pane()] });
      expect(await codex(daemon.deps)).toMatchObject({ kind: "A", pane: "%9", learnedId: V7 });
    });

    it("is not a pane that opened after it began, nor one of two that could be it", async () => {
      const late = setup({ procs: [SYSTEMD_USER, PANE_PROC, TUI, DAEMON], deck: [pane({ created: BEGAN + 5_000 })] });
      expect(await codex(late.deps)).toMatchObject({ kind: "C" });
      const two = setup({ procs: [SYSTEMD_USER, PANE_PROC, TUI, DAEMON], deck: [pane(), pane({ name: "ccdeck-codex-99aa88bb", pane: "%10", panePid: 910 })] });
      expect(await codex(two.deps)).toMatchObject({ kind: "C" });
      const labelled = setup({ procs: [SYSTEMD_USER, PANE_PROC, TUI, DAEMON], deck: [pane({ sessionId: OTHER })] });
      expect(await codex(labelled.deps), "a pane labelled with another session is that session's").toMatchObject({ kind: "C" });
    });

    it("is gone, not this pane, on Linux when nothing holds the rollout: the session is not live", async () => {
      const s = setup({ procs: [SYSTEMD_USER, PANE_PROC, TUI], deck: [pane()] });
      expect(await codex(s.deps)).toEqual({ kind: "gone", adoptable: true });
    });

    it("is that pane on macOS, where no open file can be read, and never with another Codex on a screen", async () => {
      const mac = setup({ platform: "darwin", procs: [SYSTEMD_USER, PANE_PROC, TUI, DAEMON], deck: [pane()] });
      expect(await codex(mac.deps)).toMatchObject({ kind: "A", pane: "%9", learnedId: V7 });
      const rival = setup({ platform: "darwin", procs: [SYSTEMD_USER, PANE_PROC, TUI, DAEMON, { pid: 7001, ppid: 1923, cmd: ["codex"], tty: "/dev/ttys004" }], deck: [pane()] });
      expect(await codex(rival.deps), "macOS cannot say which folder it runs in").toMatchObject({ kind: "gone" });
    });
  });

  it("finds a Codex the deck launched by the session option once it is set", async () => {
    const s = setup({ deck: [deckSession({ name: "ccdeck-codex-5e6f7a8b", agent: "codex", kind: "resume", pane: "%2" })] });
    expect(await ask(s.deps, { provider: "codex" })).toEqual({ kind: "A", socket: DECK, pane: "%2", name: "ccdeck-codex-5e6f7a8b" });
  });

  it("calls a process in a pane on the deck's own server case A, even when the deck list does not name it", async () => {
    const deckVar = "/tmp/tmux-1000/ccdeck,8800,2";
    const s = setup({
      procs: [{ ...PANE_SHELL, pid: 8801, ppid: 8800 }, { pid: 8802, ppid: 8801, cmd: ["claude"], start: "1000", tty: "/dev/pts/9", env: { TMUX: deckVar, TMUX_PANE: "%12" } }],
      records: [record(8802)],
      panes: { "/tmp/tmux-1000/ccdeck": [{ id: "%12", pid: 8801, dead: false, tty: "/dev/pts/9", socketPath: "/tmp/tmux-1000/ccdeck", session: "ccdeck-codex-11aa22bb" }] },
    });
    expect(await ask(s.deps)).toEqual({ kind: "A", socket: DECK, pane: "%12", name: "ccdeck-codex-11aa22bb" });
  });
});

describe("a session in the user's own tmux (case B)", () => {
  it("joins the pane TMUX_PANE names, on the server TMUX names, once ancestry confirms it", async () => {
    const s = setup({
      procs: [SYSTEMD_USER, TMUX_SERVER, PANE_SHELL, TMUX_CLAUDE],
      records: [record(6002)],
      panes: { "/tmp/tmux-1000/default": HOST_PANES },
    });
    expect(await ask(s.deps)).toEqual({ kind: "B", socket: { path: "/tmp/tmux-1000/default" }, pane: "%3" });
    expect(s.asked, "only the server the process's own TMUX names is asked").toEqual([{ path: "/tmp/tmux-1000/default" }]);
  });

  it("does not believe a TMUX_PANE whose pane is not one of the process's ancestors", async () => {
    // Pane ids are a counter and an environment outlives its pane: %1 here is
    // somebody else's pane, and nothing on the server is this process's.
    const s = setup({
      procs: [SYSTEMD_USER, TERMINAL, SHELL, { ...PLAIN_CLAUDE, env: { TMUX: TMUX_VAR, TMUX_PANE: "%1" } }],
      records: [record(5001)],
      panes: { "/tmp/tmux-1000/default": HOST_PANES },
    });
    expect(await ask(s.deps)).toEqual({ kind: "C", adoptable: true, pid: 5001 });
  });

  it("prefers the pane ancestry finds over a stale TMUX_PANE", async () => {
    const s = setup({
      procs: [SYSTEMD_USER, TMUX_SERVER, PANE_SHELL, { ...TMUX_CLAUDE, env: { TMUX: TMUX_VAR, TMUX_PANE: "%1" } }],
      records: [record(6002)],
      panes: { "/tmp/tmux-1000/default": HOST_PANES },
    });
    expect(await ask(s.deps)).toEqual({ kind: "B", socket: { path: "/tmp/tmux-1000/default" }, pane: "%3" });
  });

  it("ignores a dead pane, whatever its pid", async () => {
    const s = setup({
      procs: [SYSTEMD_USER, TMUX_SERVER, PANE_SHELL, TMUX_CLAUDE],
      records: [record(6002)],
      panes: { "/tmp/tmux-1000/default": HOST_PANES.map((p) => ({ ...p, dead: true })) },
    });
    expect((await ask(s.deps)).kind).toBe("C");
  });

  it("does not take a pane for a session that descends from it but draws on no terminal", async () => {
    // `claude -p` run by the Bash tool of the session in that pane: ancestry and
    // TMUX_PANE both point at the pane, which shows the OTHER session.
    const s = setup({
      procs: [SYSTEMD_USER, TMUX_SERVER, PANE_SHELL, TMUX_CLAUDE,
        { pid: 6050, ppid: 6002, cmd: ["claude", "-p", "summarise"], start: "1000", tty: "pipe:[88812]", env: { TMUX: TMUX_VAR, TMUX_PANE: "%3" } }],
      records: [record(6050, { kind: "sdk-cli" })],
      panes: { "/tmp/tmux-1000/default": HOST_PANES },
    });
    expect(await ask(s.deps)).toEqual({ kind: "C", adoptable: true, pid: 6050 });
  });

  it("does not take a pane for a session that descends from it but draws on another terminal", async () => {
    // screen, ssh or a pty of the process's own between the pane and it.
    const s = setup({
      procs: [SYSTEMD_USER, TMUX_SERVER, PANE_SHELL, { ...TMUX_CLAUDE, tty: "/dev/pts/31" }],
      records: [record(6002)],
      panes: { "/tmp/tmux-1000/default": HOST_PANES },
    });
    expect(await ask(s.deps)).toEqual({ kind: "C", adoptable: true, pid: 6002 });
  });

  it("trusts ancestry when the process's terminal cannot be read", async () => {
    // No descriptors to read (another user's process, a locked-down /proc):
    // that is no evidence against the pane that ancestry and TMUX_PANE agree on.
    const s = setup({
      procs: [SYSTEMD_USER, TMUX_SERVER, PANE_SHELL, TMUX_CLAUDE],
      records: [record(6002)],
      panes: { "/tmp/tmux-1000/default": HOST_PANES },
    });
    const readlink = (p: string) => {
      if (p.startsWith("/proc/6002/fd/")) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      return s.deps.readlink(p);
    };
    expect(await ask({ ...s.deps, readlink })).toEqual({ kind: "B", socket: { path: "/tmp/tmux-1000/default" }, pane: "%3" });
  });

  it("finds a process moved into a pane later (reptyr) by its tty on the default server", async () => {
    const s = setup({
      procs: [SYSTEMD_USER, TERMINAL, SHELL, { ...PLAIN_CLAUDE, tty: "/dev/pts/5" }],
      records: [record(5001)],
      panes: { "name:default": HOST_PANES },
    });
    expect(await ask(s.deps)).toEqual({ kind: "B", socket: { path: "/tmp/tmux-1000/default" }, pane: "%1" });
    expect(s.asked, "with no TMUX in the environment only the default server is asked").toEqual([{ name: "default" }]);
  });

  it("finds the pane on macOS by ancestry against the default server only, never through the environment", async () => {
    const s = setup({
      platform: "darwin",
      procs: [
        { pid: 300, ppid: 1, cmd: ["tmux"] },
        { pid: 301, ppid: 300, cmd: ["-zsh"], tty: "/dev/ttys003" },
        { pid: 302, ppid: 301, cmd: ["claude"], tty: "/dev/ttys003", lstart: LSTART },
      ],
      // Claude Code writes `ps -o lstart=` verbatim, padded day and all.
      records: [record(302, { procStart: LSTART, pidDomain: "darwin:x:pid" })],
      panes: { "name:default": [{ id: "%7", pid: 301, dead: false, tty: "/dev/ttys003", socketPath: "/private/tmp/tmux-501/default", session: "main" }] },
    });
    expect(await ask(s.deps)).toEqual({ kind: "B", socket: { path: "/private/tmp/tmux-501/default" }, pane: "%7" });
    expect(s.asked).toEqual([{ name: "default" }]);
    expect(s.opened.filter((p) => p.startsWith("/proc")), "macOS has no /proc to read").toEqual([]);
  });

  it("finds a Codex in the user's tmux by the rollout it holds open", async () => {
    const rollout = `/home/u/.codex/sessions/2026/10/08/rollout-2026-10-08T09-12-33-${ID}.jsonl`;
    const s = setup({
      procs: [SYSTEMD_USER, TMUX_SERVER, PANE_SHELL,
        { pid: 6010, ppid: 6001, cmd: ["node", "/usr/lib/node_modules/@openai/codex/bin/codex.js"], tty: "/dev/pts/7", env: { TMUX: TMUX_VAR, TMUX_PANE: "%3" } },
        { pid: 6011, ppid: 6010, cmd: ["/usr/lib/node_modules/@openai/codex/vendor/codex/codex"], tty: "/dev/pts/7", env: { TMUX: TMUX_VAR, TMUX_PANE: "%3" }, fds: [rollout] }],
      panes: { "/tmp/tmux-1000/default": HOST_PANES },
    });
    expect(await ask(s.deps, { provider: "codex" })).toEqual({ kind: "B", socket: { path: "/tmp/tmux-1000/default" }, pane: "%3" });
  });
});

describe("a Claude background session (case D)", () => {
  it("is reached through claude attach with the record's short id", async () => {
    const s = setup({
      procs: [DAEMON, PTY_HOST, BG_CLAUDE],
      records: [record(7002, { kind: "bg", jobId: "0b9c2f4e" })],
    });
    expect(await ask(s.deps)).toEqual({ kind: "D", attachId: "0b9c2f4e" });
    expect(s.asked, "a background session's pty is not a tmux pane, so no server is asked").toEqual([]);
  });

  it("is still case D after the daemon died and the pty host was reparented, with no kind in the record", async () => {
    const s = setup({
      procs: [SYSTEMD_USER, { ...PTY_HOST, ppid: 1923 }, BG_CLAUDE],
      records: [record(7002, { kind: undefined, jobId: undefined })],
    });
    expect(await ask(s.deps)).toEqual({ kind: "D", attachId: "0b9c2f4e" });
  });

  it("is case D even when the daemon was started from inside a tmux pane", async () => {
    // The pane's shell is an ancestor and TMUX_PANE is inherited, yet the pane
    // shows the user's shell: the session's pty belongs to the pty host.
    const s = setup({
      procs: [SYSTEMD_USER, TMUX_SERVER, PANE_SHELL, { ...DAEMON, ppid: 6001 }, PTY_HOST,
        { ...BG_CLAUDE, env: { TMUX: TMUX_VAR, TMUX_PANE: "%3" } }],
      records: [record(7002, { kind: "bg", jobId: "0b9c2f4e" })],
      panes: { "/tmp/tmux-1000/default": HOST_PANES },
    });
    expect(await ask(s.deps)).toEqual({ kind: "D", attachId: "0b9c2f4e" });
  });

  it("does not call a session started from inside a background session that background session", async () => {
    // An agent in a background session launched an interactive `claude` of its
    // own: a pty host is two levels up, not its parent, and `claude attach`
    // with this session's id would open nothing. Found on this machine, by the
    // real-process case at the bottom of this file, which runs under one.
    const s = setup({
      procs: [DAEMON, PTY_HOST, BG_CLAUDE,
        { pid: 7010, ppid: 7002, cmd: ["/bin/bash", "-c", "claude"] },
        { pid: 7011, ppid: 7010, cmd: ["claude"], start: "1000", tty: "/dev/pts/40" }],
      records: [record(7011)],
    });
    expect(await ask(s.deps)).toEqual({ kind: "C", adoptable: true, pid: 7011 });
  });

  it("hands back a live deck wrapper already attached to it, so the routes can reuse it", async () => {
    const s = setup({
      deck: [deckSession({ name: "ccdeck-att-0b9c2f4e", kind: "attach", pane: "%5", panePid: 990 })],
      procs: [DAEMON, PTY_HOST, BG_CLAUDE],
      records: [record(7002, { kind: "bg", jobId: "0b9c2f4e" })],
    });
    expect(await ask(s.deps)).toEqual({ kind: "D", attachId: "0b9c2f4e", wrapper: { name: "ccdeck-att-0b9c2f4e", pane: "%5" } });
  });

  it("never mistakes a deck attach wrapper for the session itself", async () => {
    // The wrapper is alive while the background session behind it has ended:
    // that is not case A, it is a session to reopen.
    const s = setup({ deck: [deckSession({ name: "ccdeck-att-0b9c2f4e", kind: "attach" })] });
    expect(await ask(s.deps)).toEqual({ kind: "gone", adoptable: true });
  });

  it("prefers the background record when another live record names the same session", async () => {
    const s = setup({
      procs: [DAEMON, PTY_HOST, BG_CLAUDE, SYSTEMD_USER, TERMINAL, SHELL, PLAIN_CLAUDE],
      records: [record(5001, { startedAt: 9_000 }), record(7002, { kind: "bg", jobId: "0b9c2f4e", startedAt: 1_000 })],
    });
    expect((await ask(s.deps)).kind).toBe("D");
  });
});

describe("a plain process in some other terminal (case C)", () => {
  it("cannot be attached, and can be reopened here once it stops", async () => {
    const s = setup({ procs: [SYSTEMD_USER, TERMINAL, SHELL, PLAIN_CLAUDE], records: [record(5001)] });
    expect(await ask(s.deps)).toEqual({ kind: "C", adoptable: true, pid: 5001 });
    expect(s.asked, "with no TMUX the user's default server is the one place to look").toEqual([{ name: "default" }]);
  });

  it("is not offered for reopening when its project folder no longer exists", async () => {
    const s = setup({ procs: [SYSTEMD_USER, TERMINAL, SHELL, PLAIN_CLAUDE], records: [record(5001)], cwdExists: false });
    expect(await ask(s.deps)).toEqual({ kind: "C", adoptable: false, pid: 5001 });
  });

  it("is not offered for reopening when the deck has no absolute folder for it", async () => {
    const s = setup({ procs: [SYSTEMD_USER, TERMINAL, SHELL, PLAIN_CLAUDE], records: [record(5001)] });
    expect(await ask(s.deps, { cwd: "proj" })).toEqual({ kind: "C", adoptable: false, pid: 5001 });
  });

  it("finds a Codex outside tmux by the rollout it holds open", async () => {
    const s = setup({
      procs: [SYSTEMD_USER, TERMINAL, SHELL,
        { pid: 5101, ppid: 5000, cmd: ["codex"], fds: [`/home/u/.codex/sessions/2026/10/08/rollout-2026-10-08T09-00-00-${ID}.jsonl`] }],
    });
    expect(await ask(s.deps, { provider: "codex" })).toEqual({ kind: "C", adoptable: true, pid: 5101 });
  });

  it("finds a Codex started as codex resume <id> by its command line before it holds the rollout", async () => {
    const s = setup({
      procs: [SYSTEMD_USER, TERMINAL, SHELL,
        { pid: 5101, ppid: 5000, cmd: ["node", "/home/u/.local/bin/codex", "resume", ID] }],
    });
    expect(await ask(s.deps, { provider: "codex" })).toEqual({ kind: "C", adoptable: true, pid: 5101 });
  });
});

describe("a live Claude that has not written its record yet", () => {
  // Measured with Claude 2.1.301: the `.key` was there, `<pid>.json` was not,
  // and the board already showed the session. Reopening it then would have
  // put a second writer on the conversation.
  const FRESH: Proc = { ...PLAIN_CLAUDE, cwd: CWD };

  it("is taken as holding the session started in its folder: case C, not gone, so nothing reopens beside it", async () => {
    const s = setup({ procs: [SYSTEMD_USER, TERMINAL, SHELL, FRESH] });
    expect(await ask(s.deps)).toEqual({ kind: "C", adoptable: true, pid: 5001 });
  });

  it("is found in the user's tmux like any other holder", async () => {
    const s = setup({ procs: [SYSTEMD_USER, TMUX_SERVER, PANE_SHELL, { ...TMUX_CLAUDE, cwd: CWD }], panes: { [TMUX_VAR.split(",")[0]]: HOST_PANES } });
    expect(await ask(s.deps)).toMatchObject({ kind: "B", pane: "%3" });
  });

  it("is not believed in another folder, as a one-shot print, or when a record already accounts for it", async () => {
    for (const procs of [
      [SYSTEMD_USER, TERMINAL, SHELL, { ...FRESH, cwd: "/home/u/other" }],
      [SYSTEMD_USER, TERMINAL, SHELL, { ...FRESH, cmd: ["claude", "-p", "summarise"] }],
      [SYSTEMD_USER, TERMINAL, SHELL, { ...FRESH, cmd: ["claude", "mcp", "serve"] }],
    ]) {
      const s = setup({ procs });
      expect(await ask(s.deps), JSON.stringify(procs.at(-1)!.cmd)).toEqual({ kind: "gone", adoptable: true });
    }
    const other = setup({ procs: [SYSTEMD_USER, TERMINAL, SHELL, FRESH], records: [{ ...record(5001), sessionId: OTHER }] });
    expect(await ask(other.deps), "that Claude is another session's").toEqual({ kind: "gone", adoptable: true });
  });

  it("cannot be seen on macOS, which has no folder to read off a process: still gone there", async () => {
    const s = setup({ procs: [SYSTEMD_USER, TERMINAL, SHELL, FRESH], platform: "darwin" });
    expect(await ask(s.deps)).toEqual({ kind: "gone", adoptable: true });
  });
});

describe("a tmux that does not answer", () => {
  // A tmux server stalled for three seconds (stopped, swapped out) answered
  // nothing, which read as "no panes": a live session was offered "Reopen
  // here" as if it had ended (the hands-on run). Silence is its own answer.
  it("is said as such, never as a session that has ended, when the deck's own listing fails", async () => {
    const s = setup({ procs: [SYSTEMD_USER, TMUX_SERVER, PANE_SHELL, TMUX_CLAUDE], records: [record(6002)] });
    const deps = { ...s.deps, listDeckSessions: async () => { throw new Error("tmux could not list the deck's sessions."); } };
    expect(await ask(deps)).toEqual({ kind: "unsupported", reason: "not-answering" });
    expect(describeTarget({ kind: "unsupported", reason: "not-answering" })).toMatchObject({ reason: "not-answering", label: expect.stringMatching(/not answering.*try again/) });
  });

  it("is said as such, never as a session started outside it, when the user's own tmux is silent", async () => {
    const s = setup({ procs: [SYSTEMD_USER, TMUX_SERVER, PANE_SHELL, TMUX_CLAUDE], records: [record(6002)] });
    const deps = { ...s.deps, listPanes: async () => { throw new TmuxNotAnswering(); } };
    expect(await ask(deps)).toEqual({ kind: "unsupported", reason: "not-answering" });
  });

  it("is not a server that is simply not running, which has no panes", async () => {
    const s = setup({ procs: [SYSTEMD_USER, TMUX_SERVER, PANE_SHELL, TMUX_CLAUDE], records: [record(6002)] });
    expect(await ask(s.deps)).toEqual({ kind: "C", adoptable: true, pid: 6002 });
  });
});

describe("a session nothing holds any more (gone)", () => {
  it("is gone, and reopenable, when no record names it", async () => {
    const s = setup({ records: [{ ...record(5001), sessionId: OTHER }], procs: [PLAIN_CLAUDE] });
    expect(await ask(s.deps)).toEqual({ kind: "gone", adoptable: true });
  });

  it("is gone when its recorded pid was recycled, even by another Claude", async () => {
    // Alive, and a `claude` too — but started at another time, so it is not
    // the process that wrote the record.
    const s = setup({ procs: [SYSTEMD_USER, TERMINAL, SHELL, { ...PLAIN_CLAUDE, start: "99999" }], records: [record(5001, { procStart: "1000" })] });
    expect(await ask(s.deps)).toEqual({ kind: "gone", adoptable: true });
  });

  it("is gone when its recorded pid is not running at all", async () => {
    const s = setup({ records: [record(5001)] });
    expect(await ask(s.deps)).toEqual({ kind: "gone", adoptable: true });
  });

  it("checks the command line when a record carries no start time, so a recycled pid is not believed", async () => {
    const recycled = setup({ procs: [{ pid: 5001, ppid: 1, cmd: ["/usr/bin/python3", "server.py"] }], records: [record(5001, { procStart: undefined })] });
    expect(await ask(recycled.deps)).toEqual({ kind: "gone", adoptable: true });
    const real = setup({ procs: [{ pid: 5001, ppid: 1, cmd: ["/home/u/.local/share/claude/versions/2.1.294"] }], records: [record(5001, { procStart: undefined })] });
    expect(await ask(real.deps)).toEqual({ kind: "C", adoptable: true, pid: 5001 });
  });

  it("ignores a record written in another pid namespace or on another machine", async () => {
    const namespace = setup({ procs: [SYSTEMD_USER, TERMINAL, SHELL, PLAIN_CLAUDE], records: [record(5001, { pidDomain: `linux:${MACHINE}:pid:[4026532999]` })] });
    expect(await ask(namespace.deps)).toEqual({ kind: "gone", adoptable: true });
    const elsewhere = setup({ procs: [SYSTEMD_USER, TERMINAL, SHELL, PLAIN_CLAUDE], records: [record(5001, { pidDomain: `linux:${"0".repeat(32)}:${NS}` })] });
    expect(await ask(elsewhere.deps)).toEqual({ kind: "gone", adoptable: true });
  });

  it("uses the live record when a stale one for the same session was left behind", async () => {
    const s = setup({ procs: [SYSTEMD_USER, TERMINAL, SHELL, PLAIN_CLAUDE], records: [record(4100, { startedAt: 99_000 }), record(5001)] });
    expect(await ask(s.deps)).toEqual({ kind: "C", adoptable: true, pid: 5001 });
  });

  it("is gone for a Codex that no process holds", async () => {
    const s = setup({ procs: [SYSTEMD_USER, TERMINAL, SHELL, { pid: 5101, ppid: 5000, cmd: ["codex"], fds: ["/dev/urandom"] }] });
    expect(await ask(s.deps, { provider: "codex" })).toEqual({ kind: "gone", adoptable: true });
  });

  it("is gone without a reopen offer when its folder is gone too", async () => {
    const s = setup({ cwdExists: false });
    expect(await ask(s.deps)).toEqual({ kind: "gone", adoptable: false });
  });

  it("is gone, not an error, when Claude has no sessions folder at all", async () => {
    const s = setup();
    rmTempDir(join(s.deps.claudeDir, "sessions"));
    expect(await ask(s.deps)).toEqual({ kind: "gone", adoptable: true });
  });
});

describe("Claude's session records", () => {
  it("opens only <pid>.json files, never the .key secrets beside them", async () => {
    const s = setup({
      procs: [DAEMON, PTY_HOST, BG_CLAUDE],
      records: [record(7002, { kind: "bg", jobId: "0b9c2f4e" }), { ...record(4242), sessionId: OTHER }],
      raw: { "4243.json.key": "SECRET", "notes.json": "{}", "4244.json.bak": "{}" },
    });
    expect((await ask(s.deps)).kind).toBe("D");
    const touched = s.opened.filter((p) => p.includes(`${s.deps.claudeDir}`));
    // Either separator: the folder is joined with the platform's own.
    const isFolder = (p: string) => /[\\/]sessions$/.test(p);
    expect(touched.some(isFolder), "the folder was listed").toBe(true);
    expect(touched.filter((p) => p.endsWith(".key")), "a .key file was opened").toEqual([]);
    expect(touched.filter((p) => !isFolder(p)).map((p) => basename(p)).sort()).toEqual(["4242.json", "7002.json"]);
  });

  it("names only digits-dot-json as a session file", () => {
    for (const name of ["1.json", "3882092.json"]) expect(SESSION_FILE.test(name), name).toBe(true);
    for (const name of ["4242.9f8e7d6c5b4a.key", "4242.json.key", "x4242.json", "4242.json~", "4242.jsonl", ".json", "4242.JSON"]) {
      expect(SESSION_FILE.test(name), name).toBe(false);
    }
  });

  it("skips a torn record without throwing and reads the rest", () => {
    const dir = claudeDirWith([record(7002, { kind: "bg" })], { "5001.json": `{"pid":5001,"sessionId":"${ID}","cwd":"/ho` });
    const recs = readClaudeSessions(dir, { readdir: readdirSync, readFile: (p: string) => readFileSync(p, "utf8") });
    expect(recs.map((r: { pid: number }) => r.pid)).toEqual([7002]);
  });

  it("does not trust a record whose pid disagrees with its file name", () => {
    const dir = claudeDirWith([], { "5001.json": JSON.stringify(record(5002)) });
    expect(readClaudeSessions(dir, { readdir: readdirSync, readFile: (p: string) => readFileSync(p, "utf8") })).toEqual([]);
  });
});

describe("when the panel cannot work here (unsupported)", () => {
  it("says tmux is missing, with the install line, and asks nothing else", async () => {
    const s = setup({ deck: [deckSession({})] });
    const t = await ask({ ...s.deps, tmux: { ok: false, reason: "missing", install: "sudo apt install tmux" } });
    expect(t).toEqual({ kind: "unsupported", reason: "missing", install: "sudo apt install tmux" });
    expect(s.listedDeck(), "no tmux, so no deck sessions to list").toBe(0);
    expect(s.opened).toEqual([]);
  });

  it("says tmux is too old", async () => {
    const s = setup();
    expect(await ask({ ...s.deps, tmux: { ok: false, reason: "too-old", version: [3, 0] } })).toEqual({ kind: "unsupported", reason: "too-old" });
  });

  it("refuses Windows before asking anything", async () => {
    const s = setup({ platform: "win32" });
    expect(await ask({ ...s.deps, tmux: undefined })).toEqual({ kind: "unsupported", reason: "unsupported-platform" });
    expect(s.listedDeck()).toBe(0);
    expect(s.opened).toEqual([]);
  });

  it("refuses a session id that is not one, before it reaches a file name or an argument", async () => {
    const s = setup();
    for (const sessionId of ["--dangerously-skip-permissions", "", "../../etc/passwd", `${ID} --help`, ID.slice(0, 8), 42]) {
      expect(await resolveTarget({ sessionId, provider: "claude", cwd: CWD }, s.deps), String(sessionId)).toEqual({ kind: "unsupported", reason: "invalid" });
    }
    expect(await resolveTarget({ sessionId: ID, provider: "gemini", cwd: CWD }, s.deps)).toEqual({ kind: "unsupported", reason: "invalid" });
    expect(s.opened).toEqual([]);
    expect(s.listedDeck()).toBe(0);
  });
});

describe("describeTarget, the one sentence the panel shows", () => {
  it("uses the plan's sentence for a session started outside the deck, word for word", () => {
    expect(describeTarget({ kind: "C", adoptable: true, pid: 5001 })).toEqual({
      kind: "C",
      label: "This session was started outside the deck, so there is no pane to attach to. Reopening it here continues the conversation; the old terminal's scrollback stays behind.",
      adoptable: true,
      hint: "Quit it in the terminal it is running in first, then reopen it here.",
    });
  });

  it("drops the reopening half when the session cannot be reopened here", () => {
    expect(describeTarget({ kind: "C", adoptable: false, pid: 5001 })).toEqual({
      kind: "C", label: "This session was started outside the deck, so there is no pane to attach to.", adoptable: false,
    });
  });

  it("has a sentence for every kind, and none of them leaks a path, a pid or a pane", () => {
    const targets = [
      { kind: "A", socket: DECK, pane: "%4", name: "ccdeck-claude-0a1b2c3d" },
      { kind: "B", socket: { path: "/tmp/tmux-1000/default" }, pane: "%3" },
      { kind: "D", attachId: "0b9c2f4e", wrapper: { name: "ccdeck-att-0b9c2f4e", pane: "%5" } },
      { kind: "C", adoptable: true, pid: 5001 },
      { kind: "C", adoptable: false, pid: 5001 },
      { kind: "gone", adoptable: true },
      { kind: "gone", adoptable: false },
      { kind: "unsupported", reason: "missing", install: "brew install tmux" },
      { kind: "unsupported", reason: "too-old" },
      { kind: "unsupported", reason: "unsupported-platform" },
      { kind: "unsupported", reason: "invalid" },
    ];
    const labels = new Set<string>();
    for (const t of targets) {
      const d = describeTarget(t);
      expect(d.kind, JSON.stringify(t)).toBe(t.kind);
      expect(d.label, JSON.stringify(t)).toMatch(/^[A-Z].*\.$/);
      expect(JSON.stringify(d), `${t.kind} leaks a detail the panel has no use for`).not.toMatch(/\/tmp|%\d|5001|0b9c2f4e|ccdeck-/);
      expect(Object.keys(d).every((k) => ["kind", "label", "adoptable", "reason", "install", "hint"].includes(k)), JSON.stringify(d)).toBe(true);
      labels.add(d.label);
    }
    expect(labels.size, "two different states share a sentence").toBe(targets.length);
  });

  it("says case B draws at the pane's size, which is the price of not resizing the user's terminal", () => {
    expect(describeTarget({ kind: "B", socket: { path: "/x" }, pane: "%1" }).label).toMatch(/its own size/);
  });

  it("offers reopening an ended session only when it can be reopened", () => {
    expect(describeTarget({ kind: "gone", adoptable: true })).toMatchObject({ adoptable: true, label: expect.stringMatching(/reopening it here/) });
    expect(describeTarget({ kind: "gone", adoptable: false })).toMatchObject({ adoptable: false, label: expect.not.stringMatching(/reopen it here continues/) });
  });

  it("carries the install line beside the tmux-missing fact", () => {
    expect(describeTarget({ kind: "unsupported", reason: "missing", install: "sudo apt install tmux" })).toEqual({
      kind: "unsupported",
      label: "The terminal runs on tmux, which is not installed on this machine.",
      reason: "missing",
      install: "sudo apt install tmux",
    });
  });

  it("leaves out what only the routes use: the id a pane was found by, its launch's key and the dead panes' names", () => {
    expect(describeTarget({ kind: "A", socket: DECK, pane: "%9", name: "ccdeck-codex-5e6f7a8b", learnedId: ID, launchKey: "launch-k1" }))
      .toEqual(describeTarget({ kind: "A" }));
    expect(describeTarget({ kind: "gone", adoptable: true, deadSessions: ["ccdeck-claude-00000001"] }))
      .toEqual(describeTarget({ kind: "gone", adoptable: true }));
  });

  it("answers something sensible for a target it does not know", () => {
    for (const t of [undefined, null, {}, { kind: "Z" }, { kind: "unsupported", reason: "solar-flare" }]) {
      expect(describeTarget(t), JSON.stringify(t)).toMatchObject({ kind: "unsupported", label: "The terminal is not available here." });
    }
  });
});

describe("the parsers under it", () => {
  it("reads /proc/<pid>/stat from the last parenthesis, so a command name cannot shift the fields", () => {
    // Fields 10-17 are fault counts and CPU times; 18-21 priority, nice,
    // threads and itrealvalue; 22 the start time.
    const line = `4321 (we) (ird) S 77 4321 4321 34820 4321 4194560 ${new Array(8).fill("0").join(" ")} 20 0 1 0 169369678 1000 200`;
    expect(parseProcStat(line)).toEqual({ pid: 4321, comm: "we) (ird", ppid: 77, ttyNr: 34820, start: "169369678" });
    expect(parseProcStat("")).toBeNull();
    expect(parseProcStat("12 (short) S 1")).toBeNull();
  });

  it("reads a TMUX value from the right, so a comma in the socket path survives", () => {
    expect(tmuxSocketPath("/tmp/tmux-1000/default,6000,0")).toBe("/tmp/tmux-1000/default");
    expect(tmuxSocketPath("/tmp/odd,dir/default,6000,3")).toBe("/tmp/odd,dir/default");
    for (const v of ["", "default", "relative/sock,1,0", "/tmp/sock,x,0", undefined]) expect(tmuxSocketPath(v), String(v)).toBe("");
  });

  it("reads an environ blob, keeping '=' inside values", () => {
    expect(parseEnviron("A=1\0TMUX=/tmp/s,1,0\0X=a=b\0\0junk\0")).toEqual({ A: "1", TMUX: "/tmp/s,1,0", X: "a=b" });
  });

  it("reads list-panes output, keeping a tab inside a session name", () => {
    expect(parsePaneList("%1\t6001\t0\t/dev/pts/7\t/tmp/tmux-1000/default\twork\tand play\n%2\t6002\t1\t/dev/pts/8\t/tmp/tmux-1000/default\tx\nno server running\n")).toEqual([
      { id: "%1", pid: 6001, dead: false, tty: "/dev/pts/7", socketPath: "/tmp/tmux-1000/default", session: "work\tand play" },
      { id: "%2", pid: 6002, dead: true, tty: "/dev/pts/8", socketPath: "/tmp/tmux-1000/default", session: "x" },
    ]);
  });

  it("reads a ps table with a padded day and no tty", () => {
    const text = "  302   301 ttys003  Thu Oct  8 09:12:33 2026 claude --resume x\n  7001     1 ??       Mon Oct 12 23:01:02 2026 claude bg-pty-host --bg-pty-host /tmp/a.sock\n    9     1 ?        Fri Sep 18 14:39:20 2026\n";
    expect(parsePsTable(text)).toEqual([
      { pid: 302, ppid: 301, tty: "/dev/ttys003", start: "Thu Oct 8 09:12:33 2026", cmd: "claude --resume x" },
      { pid: 7001, ppid: 1, tty: "", start: "Mon Oct 12 23:01:02 2026", cmd: "claude bg-pty-host --bg-pty-host /tmp/a.sock" },
      { pid: 9, ppid: 1, tty: "", start: "Fri Sep 18 14:39:20 2026", cmd: "" },
    ]);
  });

  it("hands claude attach the record's short id, and never anything that reads as a flag", () => {
    expect(attachIdOf({ jobId: "b02a39b7" }, ID)).toBe("b02a39b7");
    expect(attachIdOf({ jobId: "--rm" }, ID)).toBe("0b9c2f4e");
    expect(attachIdOf({}, ID)).toBe("0b9c2f4e");
  });

  it("checks a question before anything reads it", () => {
    expect(checkTargetQuery({ sessionId: ` ${ID} `, provider: "codex", cwd: CWD })).toEqual({ ok: true, sessionId: ID, provider: "codex", cwd: CWD });
    expect(checkTargetQuery({ sessionId: ID, provider: "claude", cwd: "relative" })).toEqual({ ok: true, sessionId: ID, provider: "claude", cwd: "" });
    expect(checkTargetQuery({ sessionId: "nope", provider: "claude" }).ok).toBe(false);
    expect(checkTargetQuery(null).ok).toBe(false);
  });
});

describe("wired to the tmux modules by default", () => {
  // A stand-in tmux: a shell script that logs how it was called and answers
  // `list-panes` for the deck's server (in terminal-sessions' format) and for
  // one host server (in this module's). No real tmux is involved, so this runs
  // on every POSIX machine; Windows is refused before tmux is reached.
  it("asks the deck's own server for its sessions and the process's own server for its pane", async () => {
    if (process.platform === "win32") {
      expect(await resolveTarget({ sessionId: ID, provider: "claude", cwd: CWD }, { platform: "win32" })).toEqual({ kind: "unsupported", reason: "unsupported-platform" });
      return;
    }
    const log = join(root, "tmux-calls.log");
    const stub = join(root, "tmux-stub.sh");
    writeFileSync(stub, [
      "#!/bin/sh",
      `echo "$*" >> '${log}'`,
      'case "$2" in',
      `  -L) [ "$3" = ccdeck ] && printf 'ccdeck-claude-0a1b2c3d\\t%%4\\t900\\t0\\t\\t1791440000\\t120\\t40\\t${ID}\\tclaude\\tlaunch\\t\\t${CWD}\\n'; exit 0 ;;`,
      "  -S) printf '%%3\\t6001\\t0\\t/dev/pts/7\\t/tmp/tmux-1000/default\\twork\\n'; exit 0 ;;",
      "esac",
      "exit 1",
      "",
    ].join("\n"));
    chmodSync(stub, 0o755);
    const tmux = { ok: true, path: stub, version: [3, 6], raw: "tmux 3.6" };
    const s = setup({ procs: [SYSTEMD_USER, TMUX_SERVER, PANE_SHELL, TMUX_CLAUDE], records: [{ ...record(6002), sessionId: OTHER }] });
    const { deckSocket: _d, listDeckSessions: _l, listPanes: _p, ...rest } = s.deps;
    const deps = { ...rest, tmux };

    expect(DECK_SOCKET, "the deck's server is the one the contract names").toEqual({ name: "ccdeck" });
    expect(await resolveTarget({ sessionId: ID, provider: "claude", cwd: CWD }, deps))
      .toEqual({ kind: "A", socket: DECK_SOCKET, pane: "%4", name: "ccdeck-claude-0a1b2c3d" });
    expect(await resolveTarget({ sessionId: OTHER, provider: "claude", cwd: CWD }, deps))
      .toEqual({ kind: "B", socket: { path: "/tmp/tmux-1000/default" }, pane: "%3" });
    const calls = readFileSync(log, "utf8").trim().split("\n");
    expect(calls.every((c) => c.startsWith("-u ") && c.includes(" list-panes -a -F ")), calls.join("\n")).toBe(true);
    expect(calls.map((c) => c.split(" ").slice(1, 3).join(" "))).toEqual(["-L ccdeck", "-L ccdeck", "-S /tmp/tmux-1000/default"]);
  });
});

describe("on this machine's real process table", () => {
  const sockPath = join(root, "tmux-fake", "default");
  let child: ChildProcess | null = null;
  afterAll(() => { child?.kill(); });

  /** A stand-in session process: a sleeping node, named `claude` in its argv,
   *  with a TMUX environment that points at a pane whose process is this test
   *  worker — its real parent. Its standard streams go nowhere, as any test
   *  runner's children do, so it draws on no terminal; giving it one would take
   *  a pty, which Node cannot open without a native module. */
  async function standIn() {
    child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      argv0: "claude",
      env: { ...process.env, TMUX: `${sockPath},1,0`, TMUX_PANE: "%42" },
      stdio: "ignore",
    });
    await new Promise((r) => setTimeout(r, 150));
    return child.pid as number;
  }

  it("reads a live process's record, start time, environment, ancestry and terminal off the real machine", async () => {
    if (process.platform === "win32") {
      expect(await resolveTarget({ sessionId: ID, provider: "claude", cwd: CWD }, { tmux: TMUX_OK })).toEqual({ kind: "unsupported", reason: "unsupported-platform" });
      return;
    }
    const pid = await standIn();
    // The start time exactly as Claude Code would have recorded it, read here
    // independently of the module's own parsers.
    const procStart = process.platform === "linux"
      ? readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").pop()!.split(" ")[19]
      : execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, encoding: "utf8" }).trim();
    const claudeDir = claudeDirWith([{ pid, sessionId: ID, cwd: root, procStart, kind: "interactive", startedAt: Date.now() }]);
    const asked: unknown[] = [];
    const pane = { id: "%42", pid: process.pid, dead: false, tty: "", socketPath: sockPath, session: "work" };
    const target = await resolveTarget({ sessionId: ID, provider: "claude", cwd: root }, {
      tmux: TMUX_OK,
      deckSocket: DECK,
      claudeDir,
      listDeckSessions: async () => [],
      listPanes: async (socket: { path?: string; name?: string }) => {
        asked.push(socket);
        return socket.path === sockPath || socket.name === "default" ? [pane] : [];
      },
    });
    // Alive and the same process (its start time matched the record), not a
    // background session (no pty host for a parent, though this very suite may
    // run under one), under the pane by ancestry — and drawing on no terminal,
    // so the pane does not show it and it is a plain process.
    expect(target, `pid ${pid} on ${process.platform}`).toEqual({ kind: "C", adoptable: true, pid });
    // Linux read the server out of the process's own TMUX; macOS cannot, and
    // asks the default server.
    expect(asked).toEqual(process.platform === "linux" ? [{ path: sockPath }] : [{ name: "default" }]);
    // The same process with its record's start time off by one tick is a
    // recycled pid, and the session has ended.
    const recycled = claudeDirWith([{ pid, sessionId: ID, cwd: root, procStart: `${procStart}1`, kind: "interactive" }]);
    expect(await resolveTarget({ sessionId: ID, provider: "claude", cwd: root }, {
      tmux: TMUX_OK, deckSocket: DECK, claudeDir: recycled, listDeckSessions: async () => [], listPanes: async () => [],
    })).toEqual({ kind: "gone", adoptable: true });
  });

  it("reads the real ps table the way the macOS path does, and matches Claude's lstart spelling", async () => {
    if (process.platform === "win32") return; // no ps; the case above pins the refusal
    const pid = child?.pid ?? await standIn();
    const procStart = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, encoding: "utf8" }).trim();
    const claudeDir = claudeDirWith([{ pid, sessionId: ID, cwd: root, procStart, kind: "interactive", startedAt: Date.now() }]);
    const target = await resolveTarget({ sessionId: ID, provider: "claude", cwd: root }, {
      platform: "darwin",
      tmux: TMUX_OK,
      deckSocket: DECK,
      claudeDir,
      listDeckSessions: async () => [],
      listPanes: async () => [],
    });
    expect(target).toEqual({ kind: "C", adoptable: true, pid });
  });
});
