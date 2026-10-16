// The tmux sessions the deck launches, pinned without a tmux.
//
// terminal-sessions.mjs decides what a deck session is called, what it runs,
// which folder it starts in and how it is labelled, and reads all of that back
// out of a tmux listing — the listing is the deck's only record of what it
// launched. Every one of those decisions is pure or takes its tmux as a `run`
// function, so they are driven here with fakes, on every operating system the
// suite runs on. terminal-sessions-real-tmux.test.ts shows the same calls
// against a real tmux server.
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
import {
  AGENTS, DEAD_KEEP, KINDS, SESSION_OPTIONS, TerminalSessionError, agentArgv, checkCwd, clampSize, deadDeckSessions,
  deckSessionName, findDeckSession, isDeckSessionName, killDeckSession, labelDeckSession, launchCommand, launchSession,
  listDeckSessions, parseDeckPanes, pruneDeadDeckSessions, resolveAgentBin, staleDeadSessions,
} from "../../server/terminal-sessions.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { DECK_SOCKET } from "../../server/tmux.mjs";

const ID = "5f0c2a9e-3b1d-4c7e-9a2f-8d6e1b0c4a73";
const ID2 = "0b7e4d21-6f3a-4e58-b9c0-1a2d3e4f5a6b";

const SANDBOX = mkdtempSync(join(tmpdir(), "cct-"));
const PROJECT = join(SANDBOX, "project");
mkdirSync(PROJECT);
afterAll(() => rmTempDir(SANDBOX));

type Call = { bin: unknown; socket: unknown; args: string[]; opts: { env?: Record<string, string>; scope?: string[] } };
type Reply = { ok: boolean; code?: number | string; stdout?: string; stderr?: string };

/** A tmux that answers each call with the next reply, and remembers the calls. */
function fakeTmux(...replies: Reply[]) {
  const calls: Call[] = [];
  const run = async (bin: unknown, socket: unknown, args: string[], opts: Call["opts"] = {}) => {
    calls.push({ bin, socket, args, opts });
    const r = replies.shift() ?? { ok: true, stdout: "" };
    return { code: r.ok ? 0 : 1, stdout: "", stderr: "", ...r };
  };
  return { calls, run };
}

/** The error a promise rejects with, so its code can be asserted. */
async function failure(p: Promise<unknown>): Promise<{ code?: string; message: string; detail?: string }> {
  try { await p; } catch (err) { return err as { code?: string; message: string }; }
  throw new Error("expected a rejection");
}

describe("the deck's session names", () => {
  it("are the only names the deck will ever close", () => {
    for (const ok of ["ccdeck-claude-0123abcd", "ccdeck-codex-ffffffff", "ccdeck-att-5f0c2a9e"]) {
      expect(isDeckSessionName(ok), ok).toBe(true);
    }
    for (const no of ["main", "0", "ccdeck", "ccdeck-", "ccdeck-claude-0123ABCD", "ccdeck-claude-0123abc",
      "ccdeck-claude-0123abcd-x", "ccdeck-gemini-0123abcd", "xccdeck-claude-0123abcd", 5, null, undefined]) {
      expect(isDeckSessionName(no), String(no)).toBe(false);
    }
  });

  it("are random for a launch or a resume, so a conversation can be reopened beside its dead first session", () => {
    const random = (n: number) => Buffer.alloc(n, 0xab);
    expect(deckSessionName({ agent: "claude", kind: "launch", random })).toBe("ccdeck-claude-abababab");
    expect(deckSessionName({ agent: "codex", kind: "resume", sessionId: ID, random })).toBe("ccdeck-codex-abababab");
    expect(deckSessionName({ agent: "claude" })).toMatch(/^ccdeck-claude-[0-9a-f]{8}$/);
    expect(deckSessionName({ agent: "claude" }), "two launches do not share a name").not.toBe(deckSessionName({ agent: "claude" }));
  });

  it("are derived from the id for an attach wrapper, so a second open finds the first instead of stacking another", () => {
    expect(deckSessionName({ agent: "claude", kind: "attach", sessionId: ID.toUpperCase() })).toBe("ccdeck-att-5f0c2a9e");
    expect(() => deckSessionName({ agent: "claude", kind: "attach", sessionId: "not-an-id" })).toThrow(TerminalSessionError);
  });
});

describe("what a deck session runs", () => {
  const bins = { claudeBin: "/home/me/.local/bin/claude", codexBin: "/usr/local/bin/codex" };

  it("is the agent's own command line for each way a session starts", () => {
    expect(agentArgv({ agent: "claude", kind: "launch", sessionId: ID, ...bins })).toEqual([bins.claudeBin, "--session-id", ID]);
    expect(agentArgv({ agent: "claude", kind: "resume", sessionId: ID, ...bins })).toEqual([bins.claudeBin, "--resume", ID]);
    expect(agentArgv({ agent: "claude", kind: "attach", sessionId: ID, ...bins })).toEqual([bins.claudeBin, "attach", ID]);
    expect(agentArgv({ agent: "codex", kind: "launch", ...bins })).toEqual([bins.codexBin]);
    expect(agentArgv({ agent: "codex", kind: "resume", sessionId: ID, ...bins })).toEqual([bins.codexBin, "resume", ID]);
  });

  it("tells a new Claude its id, so the deck knows the pane's node before the first hook arrives", () => {
    expect(agentArgv({ agent: "claude", uuid: () => ID2 })).toEqual(["claude", "--session-id", ID2]);
    const [, flag, fresh] = agentArgv({ agent: "claude" });
    expect(flag).toBe("--session-id");
    expect(fresh, "a version 4 UUID").toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("refuses what the agents' CLIs do not have", () => {
    const code = (f: () => unknown) => { try { f(); } catch (err) { return (err as { code: string }).code; } return "accepted"; };
    expect(code(() => agentArgv({ agent: "codex", kind: "attach", sessionId: ID })), "Codex has no background sessions").toBe("bad-kind");
    expect(code(() => agentArgv({ agent: "codex", kind: "launch", sessionId: ID })), "a new Codex picks its own id").toBe("bad-session-id");
    expect(code(() => agentArgv({ agent: "claude", kind: "resume" }))).toBe("bad-session-id");
    expect(code(() => agentArgv({ agent: "claude", kind: "resume", sessionId: "--dangerously-skip-permissions" })),
      "an id that is a flag is never passed to the CLI").toBe("bad-session-id");
    expect(code(() => agentArgv({ agent: "gemini" }))).toBe("bad-agent");
    expect(code(() => agentArgv({ agent: "claude", kind: "fork" }))).toBe("bad-kind");
    expect(AGENTS).toEqual(["claude", "codex"]);
    expect(KINDS).toEqual(["launch", "resume", "attach"]);
  });
});

describe("the agent's binary", () => {
  const on = (...files: string[]) => (p: string) => files.includes(p);

  it("is the path the deck's one claude resolver picks, made absolute", () => {
    expect(resolveAgentBin("claude", { env: { PATH: "/a:/b" }, platform: "linux", home: "/home/me", exists: on("/b/claude") }))
      .toBe("/b/claude");
    expect(resolveAgentBin("claude", { env: { PATH: "" }, platform: "linux", home: "/home/me", exists: on("/home/me/.local/bin/claude") }))
      .toBe("/home/me/.local/bin/claude");
    expect(resolveAgentBin("claude", { env: { AGENTS_DECK_CLAUDE: "/opt/claude", PATH: "/b" }, platform: "linux", home: "/h", exists: on("/opt/claude", "/b/claude") }))
      .toBe("/opt/claude");
  });

  it("is null when the machine has none, so the panel can say so before any tmux is started", () => {
    expect(resolveAgentBin("claude", { env: { PATH: "/a" }, platform: "linux", home: "/h", exists: on() })).toBeNull();
    expect(resolveAgentBin("claude", { env: { AGENTS_DECK_CLAUDE: "/opt/gone", PATH: "" }, platform: "linux", home: "/h", exists: on() })).toBeNull();
    expect(resolveAgentBin("codex", { env: { PATH: "/a" }, platform: "linux", home: "/h", exists: on() })).toBeNull();
  });

  it("finds Codex on PATH, then where its npm and Homebrew installs land", () => {
    expect(resolveAgentBin("codex", { env: { PATH: "/a:/b" }, platform: "linux", home: "/h", exists: on("/b/codex", "/h/.local/bin/codex") }))
      .toBe("/b/codex");
    expect(resolveAgentBin("codex", { env: { PATH: "" }, platform: "linux", home: "/h", exists: on("/h/.local/bin/codex") }))
      .toBe("/h/.local/bin/codex");
    expect(resolveAgentBin("codex", { env: { PATH: "" }, platform: "darwin", home: "/h", exists: on("/opt/homebrew/bin/codex") }))
      .toBe("/opt/homebrew/bin/codex");
  });

  it("comes from claude-identity.mjs rather than a second copy of its rules", () => {
    const src = readFileSync(new URL("../../server/terminal-sessions.mjs", import.meta.url), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).toContain('import { adminClaudeBin } from "./claude-identity.mjs";');
    expect(code, "AGENTS_DECK_CLAUDE is the resolver's to read").not.toContain("AGENTS_DECK_CLAUDE");
    expect(code, "the install list is claude-dir.mjs's").not.toContain("claudeCliCandidates");
  });
});

describe("the project folder", () => {
  it("is accepted when it is a full path to a folder that exists", async () => {
    expect(await checkCwd(PROJECT)).toBe(PROJECT);
  });

  it("is refused, in a sentence with no path in it, when it is anything else", async () => {
    const file = join(SANDBOX, "a-file");
    writeFileSync(file, "x");
    for (const [cwd, why] of [
      ["project", "relative"], ["", "empty"], [undefined, "absent"], [join(SANDBOX, "nope"), "missing"],
      [file, "a file"], [join(SANDBOX, "two\nlines"), "a newline"], [`${PROJECT}\t`, "a tab"],
    ] as const) {
      const err = await failure(checkCwd(cwd));
      expect(err.code, why).toBe("bad-cwd");
      expect(err.message, why).not.toContain(SANDBOX);
    }
  });
});

describe("the size a session starts at", () => {
  it("is 120×40 unless asked, and held between 20×5 and 500×200", () => {
    expect(clampSize(undefined, undefined)).toEqual({ cols: 120, rows: 40 });
    expect(clampSize(null, "")).toEqual({ cols: 120, rows: 40 });
    expect(clampSize(Number.NaN, "x")).toEqual({ cols: 120, rows: 40 });
    expect(clampSize(5, 1)).toEqual({ cols: 20, rows: 5 });
    expect(clampSize(9999, 9999)).toEqual({ cols: 500, rows: 200 });
    expect(clampSize("90", "25")).toEqual({ cols: 90, rows: 25 });
    expect(clampSize(90.6, 24.4)).toEqual({ cols: 91, rows: 24 });
  });
});

describe("the tmux command that makes a deck session", () => {
  it("starts the agent and labels it in one sequence, reading no tmux.conf", () => {
    const args = launchCommand({
      name: "ccdeck-claude-0123abcd", cwd: "/w/a#{x} b;", cols: 100, rows: 30,
      argv: ["/bin/claude", "--session-id", ID], sessionId: ID, agent: "claude", kind: "launch",
    });
    const at = "=ccdeck-claude-0123abcd:";
    expect(args).toEqual([
      "-f", "/dev/null",
      "new-session", "-d", "-s", "ccdeck-claude-0123abcd", "-x", "100", "-y", "30",
      "-c", "/w/a##{x} b\\;", "-e", "COLORTERM=truecolor", "-P", "-F", "#{pane_id}",
      "--", "/bin/claude", "--session-id", ID,
      ";", "set-option", "-t", at, "@ccdeck-session", ID,
      ";", "set-option", "-t", at, "@ccdeck-agent", "claude",
      ";", "set-option", "-t", at, "@ccdeck-kind", "launch",
      ";", "set-option", "-t", at, "@ccdeck-cwd", "/w/a#{x} b\\;",
      ";", "set-option", "-w", "-t", at, "remain-on-exit", "on",
      ";", "set-option", "-q", "-w", "-t", at, "remain-on-exit-format", "",
    ]);
  });

  it("labels with the four options the listing reads back", () => {
    expect(SESSION_OPTIONS).toEqual({
      session: "@ccdeck-session", agent: "@ccdeck-agent", kind: "@ccdeck-kind", cwd: "@ccdeck-cwd",
    });
  });

  it("hands a one-word command to /bin/sh's exec, never to the user's shell", () => {
    const args = launchCommand({ name: "ccdeck-codex-0123abcd", cwd: "/w", cols: 80, rows: 24, argv: ["/x/codex"], sessionId: "", agent: "codex", kind: "launch" });
    const cmd = args.slice(args.indexOf("--") + 1, args.indexOf(";"));
    expect(cmd).toEqual(["/bin/sh", "-c", 'exec "$0"', "/x/codex"]);
  });
});

describe("launching a session", () => {
  const env = { PATH: "", AGENTS_DECK_CLAUDE: process.execPath };

  it("gives a new Claude an id, starts it on the deck's server, and answers with the pane", async () => {
    const tmux = fakeTmux({ ok: true, stdout: "%4\n" });
    const out = await launchSession({ tmux: "/usr/bin/tmux", run: tmux.run, env, agent: "claude", cwd: PROJECT, cols: 100, rows: 30 });
    expect(out.pane).toBe("%4");
    expect(out.name).toMatch(/^ccdeck-claude-[0-9a-f]{8}$/);
    expect(out.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(tmux.calls).toHaveLength(1);
    const { bin, socket, args, opts } = tmux.calls[0];
    expect(bin).toBe("/usr/bin/tmux");
    expect(socket, "the product's own server unless told otherwise").toBe(DECK_SOCKET);
    expect(opts.env, "the deck's environment; runTmux scrubs it").toBe(env);
    const cmd = args.slice(args.indexOf("--") + 1, args.indexOf(";"));
    expect(cmd, "the resolved binary, told the id it returned").toEqual([process.execPath, "--session-id", out.sessionId]);
    expect(args).toContain(out.name);
  });

  it("answers no id for a new Codex, which has not chosen one yet", async () => {
    const tmux = fakeTmux({ ok: true, stdout: "%1\n" });
    const out = await launchSession({ tmux: "t", run: tmux.run, agent: "codex", cwd: PROJECT, argv: ["cat"] });
    expect(out.sessionId).toBe("");
    expect(tmux.calls[0].args).toContain("@ccdeck-session");
  });

  it("says the agent is not installed, before any tmux is run", async () => {
    const tmux = fakeTmux();
    const err = await failure(launchSession({ tmux: "t", run: tmux.run, env: { PATH: "", AGENTS_DECK_CLAUDE: join(SANDBOX, "gone") }, agent: "claude", cwd: PROJECT }));
    expect(err).toMatchObject({ code: "agent-missing", message: "Claude Code is not installed on this machine." });
    expect(tmux.calls).toEqual([]);
  });

  it("checks the folder, the agent, the kind and the id before any tmux is run", async () => {
    const tmux = fakeTmux();
    const cases: [Record<string, unknown>, string][] = [
      [{ agent: "claude", cwd: join(SANDBOX, "nope"), argv: ["cat"] }, "bad-cwd"],
      [{ agent: "vim", cwd: PROJECT, argv: ["cat"] }, "bad-agent"],
      [{ agent: "claude", kind: "fork", cwd: PROJECT, argv: ["cat"] }, "bad-kind"],
      [{ agent: "codex", kind: "attach", sessionId: ID, cwd: PROJECT, argv: ["cat"] }, "bad-kind"],
      [{ agent: "claude", kind: "resume", cwd: PROJECT, argv: ["cat"] }, "bad-session-id"],
      [{ agent: "claude", cwd: PROJECT, argv: [] }, "bad-argv"],
      [{ agent: "claude", cwd: PROJECT, argv: ["cat", ""] }, "bad-argv"],
    ];
    for (const [opts, code] of cases) {
      expect((await failure(launchSession({ tmux: "t", run: tmux.run, ...opts }))).code, JSON.stringify(opts)).toBe(code);
    }
    expect(tmux.calls).toEqual([]);
  });

  it("tries a fresh name when a random one is taken", async () => {
    const tmux = fakeTmux({ ok: false, stderr: "duplicate session: ccdeck-claude-00000000\n" }, { ok: true, stdout: "%2\n" });
    const out = await launchSession({ tmux: "t", run: tmux.run, agent: "claude", cwd: PROJECT, argv: ["cat"] });
    expect(tmux.calls).toHaveLength(2);
    expect(out.pane).toBe("%2");
    expect(tmux.calls[1].args).toContain(out.name);
  });

  it("reports an attach wrapper that already exists instead of starting a second", async () => {
    const tmux = fakeTmux({ ok: false, stderr: "duplicate session: ccdeck-att-5f0c2a9e\n" });
    const err = await failure(launchSession({ tmux: "t", run: tmux.run, agent: "claude", kind: "attach", sessionId: ID, cwd: PROJECT, argv: ["cat"] }));
    expect(err.code).toBe("exists");
    expect(tmux.calls).toHaveLength(1);
  });

  it("closes a session it made but could not label, since nothing would ever find it", async () => {
    const tmux = fakeTmux({ ok: false, stdout: "%9\n", stderr: "invalid option: @ccdeck-kind\n" }, { ok: true });
    const err = await failure(launchSession({ tmux: "t", run: tmux.run, agent: "claude", cwd: PROJECT, argv: ["cat"] }));
    expect(err.code).toBe("tmux-failed");
    expect(err.detail).toBe("invalid option: @ccdeck-kind");
    const made = tmux.calls[0].args[tmux.calls[0].args.indexOf("-s") + 1];
    expect(tmux.calls[1].args).toEqual(["kill-session", "-t", `=${made}`]);
  });

  it("starts the server outside the deck's systemd service when it runs in one, and plainly when systemd refuses", async () => {
    const prefix = ["/usr/bin/systemd-run", "--user", "--scope", "--collect", "--quiet", "--"];
    const scoped = fakeTmux({ ok: true, stdout: "%4\n" });
    await launchSession({ tmux: "t", run: scoped.run, agent: "claude", cwd: PROJECT, argv: ["cat"], scope: async () => prefix });
    expect(scoped.calls).toHaveLength(1);
    expect(scoped.calls[0].opts.scope, "new-session, the call that can start the server, goes through the scope").toBe(prefix);

    // systemd's own refusal: the scope never started, so tmux never ran.
    const refused = fakeTmux({ ok: false, stderr: "Failed to connect to bus: No such file or directory\n" }, { ok: true, stdout: "%5\n" });
    const out = await launchSession({ tmux: "t", run: refused.run, agent: "claude", cwd: PROJECT, argv: ["cat"], scope: async () => prefix });
    expect(out.pane).toBe("%5");
    expect(refused.calls).toHaveLength(2);
    expect(refused.calls[1].opts.scope, "the same session, started plainly").toBeUndefined();
    expect(refused.calls[1].args).toEqual(refused.calls[0].args);

    // tmux's own answer through the scope is tmux's: a taken name is retried, still scoped.
    const taken = fakeTmux({ ok: false, stderr: "duplicate session: ccdeck-claude-00000000\n" }, { ok: true, stdout: "%6\n" });
    await launchSession({ tmux: "t", run: taken.run, agent: "claude", cwd: PROJECT, argv: ["cat"], scope: async () => prefix });
    expect(taken.calls.map(c => c.opts.scope)).toEqual([prefix, prefix]);

    // No service, or a scope that cannot be worked out: tmux as it is.
    for (const scope of [async () => null, async () => { throw new Error("no /proc"); }]) {
      const plain = fakeTmux({ ok: true, stdout: "%7\n" });
      await launchSession({ tmux: "t", run: plain.run, agent: "claude", cwd: PROJECT, argv: ["cat"], scope });
      expect(plain.calls[0].opts).toEqual({ env: process.env });
    }
  });

  it("keeps what tmux said out of the sentence and in the detail", async () => {
    const tmux = fakeTmux({ ok: false, stderr: "error connecting to /tmp/tmux-1000/ccdeck (Permission denied)\n" });
    const err = await failure(launchSession({ tmux: "t", run: tmux.run, agent: "codex", cwd: PROJECT, argv: ["cat"] }));
    expect(err).toMatchObject({ code: "tmux-failed", message: "tmux could not start the session." });
    expect(err.detail).toContain("Permission denied");
  });
});

/** One line of the listing, in PANE_FORMAT's column order. */
const line = (...cols: (string | number)[]) => cols.join("\t");

describe("reading the deck's sessions back out of tmux", () => {
  it("is one entry per deck session, with its labels, its pane and whether it is still alive", () => {
    const listing = [
      line("ccdeck-claude-0123abcd", "%0", 4242, 0, "", 1791441852, 120, 40, ID, "claude", "launch", "/home/me/proiect școală"),
      line("ccdeck-codex-89abcdef", "%3", 4300, 1, 3, 1791441900, 80, 24, "", "codex", "launch", "/w/tab\there"),
      line("ccdeck-claude-0123abcd", "%7", 5000, 0, "", 1791441852, 60, 40, ID, "claude", "launch", "/split/by/hand"),
      line("my-own-session", "%5", 1, 0, "", 1, 80, 24, "", "", "", ""),
      "garbage",
      "",
    ].join("\n");
    expect(parseDeckPanes(listing)).toEqual([
      {
        name: "ccdeck-claude-0123abcd", sessionId: ID, agent: "claude", kind: "launch", cwd: "/home/me/proiect școală",
        pane: "%0", panePid: 4242, dead: false, exitStatus: null, created: 1791441852000, cols: 120, rows: 40,
      },
      {
        name: "ccdeck-codex-89abcdef", sessionId: "", agent: "codex", kind: "launch", cwd: "/w/tab\there",
        pane: "%3", panePid: 4300, dead: true, exitStatus: 3, created: 1791441900000, cols: 80, rows: 24,
      },
    ]);
  });

  it("is an empty list, not an error, when the deck's server is not running", async () => {
    const tmux = fakeTmux({ ok: false, stderr: "no server running on /tmp/tmux-1000/ccdeck\n" });
    expect(await listDeckSessions({ tmux: "t", run: tmux.run })).toEqual([]);
    expect(tmux.calls[0].socket).toBe(DECK_SOCKET);
    expect(tmux.calls[0].args.slice(0, 3)).toEqual(["list-panes", "-a", "-F"]);
  });

  it("is an error when tmux failed for any other reason", async () => {
    const tmux = fakeTmux({ ok: false, stderr: "server version is too old for client\n" });
    expect((await failure(listDeckSessions({ tmux: "t", run: tmux.run }))).code).toBe("tmux-failed");
  });

  it("asks for exactly the columns it parses", async () => {
    const tmux = fakeTmux({ ok: true, stdout: `${line("ccdeck-att-5f0c2a9e", "%2", 77, 0, "", 10, 90, 30, ID, "claude", "attach", "/p")}\n` });
    const [s] = await listDeckSessions({ tmux: "t", run: tmux.run });
    expect(s).toMatchObject({ name: "ccdeck-att-5f0c2a9e", kind: "attach", panePid: 77, cols: 90, rows: 30, cwd: "/p" });
    expect(tmux.calls[0].args[3].split("\t")).toEqual([
      "#{session_name}", "#{pane_id}", "#{pane_pid}", "#{pane_dead}", "#{pane_dead_status}",
      "#{session_created}", "#{pane_width}", "#{pane_height}",
      "#{@ccdeck-session}", "#{@ccdeck-agent}", "#{@ccdeck-kind}", "#{@ccdeck-cwd}",
    ]);
  });
});

describe("finding a session's deck pane", () => {
  const s = (name: string, sessionId: string, kind: string, dead: boolean, created: number) =>
    ({ name, sessionId, kind, dead, created, agent: "claude", cwd: "/p", pane: "%1", panePid: 1, exitStatus: null, cols: 80, rows: 24 });
  const list = [
    s("ccdeck-claude-00000001", ID, "launch", true, 3_000),
    s("ccdeck-claude-00000002", ID, "resume", false, 1_000),
    s("ccdeck-claude-00000003", ID, "resume", false, 2_000),
    s("ccdeck-att-5f0c2a9e", ID, "attach", false, 5_000),
    s("ccdeck-codex-00000004", "", "launch", false, 9_000),
  ];

  it("prefers a live pane, then the newest", () => {
    expect(findDeckSession(list, ID, { kinds: ["launch", "resume"] })?.name).toBe("ccdeck-claude-00000003");
    expect(findDeckSession(list, ID.toUpperCase(), { kinds: ["launch", "resume"] })?.name, "ids compare without case").toBe("ccdeck-claude-00000003");
    expect(findDeckSession(list, ID)?.name, "every kind when none is named").toBe("ccdeck-att-5f0c2a9e");
    expect(findDeckSession(list, ID, { kinds: ["attach"] })?.name).toBe("ccdeck-att-5f0c2a9e");
  });

  it("falls back to a dead pane, whose last frame is still worth showing", () => {
    expect(findDeckSession([list[0]], ID)?.name).toBe("ccdeck-claude-00000001");
  });

  it("finds nothing for an unknown id, and never matches the empty id a new Codex carries", () => {
    expect(findDeckSession(list, ID2)).toBeNull();
    expect(findDeckSession(list, "")).toBeNull();
    expect(findDeckSession([], ID)).toBeNull();
  });
});

describe("the dead panes an ended session left behind", () => {
  const s = (name: string, sessionId: string, kind: string, dead: boolean, created: number) =>
    ({ name, sessionId, kind, dead, created, agent: "claude", cwd: "/p", pane: "%1", panePid: 1, exitStatus: null, cols: 80, rows: 24 });

  it("are every dead deck session for the id, of any kind, oldest first", () => {
    const list = [
      s("ccdeck-claude-00000002", ID, "resume", true, 2_000),
      s("ccdeck-att-5f0c2a9e", ID.toUpperCase(), "attach", true, 3_000),
      s("ccdeck-claude-00000001", ID, "launch", true, 1_000),
    ];
    expect(deadDeckSessions(list, ID)).toEqual(["ccdeck-claude-00000001", "ccdeck-claude-00000002", "ccdeck-att-5f0c2a9e"]);
  });

  it("never include a live one, another session's, or a name the deck would not close", () => {
    const list = [
      s("ccdeck-claude-00000003", ID, "resume", false, 1),
      s("ccdeck-claude-00000004", ID2, "launch", true, 1),
      s("made-by-hand", ID, "launch", true, 1),
      s("ccdeck-codex-00000005", "", "launch", true, 1),
    ];
    expect(deadDeckSessions(list, ID)).toEqual([]);
    expect(deadDeckSessions(list, ""), "the empty id a new Codex carries matches nothing").toEqual([]);
    expect(deadDeckSessions(undefined, ID)).toEqual([]);
  });
});

describe("labelling a session with the id the deck learned", () => {
  it("is one set-option of @ccdeck-session on the exact session, in lower case", async () => {
    const tmux = fakeTmux({ ok: true });
    expect(await labelDeckSession({ tmux: "t", run: tmux.run, name: "ccdeck-codex-0123abcd", sessionId: ID.toUpperCase() })).toBe(true);
    expect(tmux.calls).toHaveLength(1);
    expect(tmux.calls[0].socket, "the deck's own server unless told otherwise").toEqual(DECK_SOCKET);
    expect(tmux.calls[0].args).toEqual(["set-option", "-t", "=ccdeck-codex-0123abcd:", SESSION_OPTIONS.session, ID]);
  });

  it("refuses a name the deck did not give and an id that is not one, before tmux is asked anything", async () => {
    const tmux = fakeTmux();
    for (const name of ["main", "=ccdeck-codex-0123abcd", undefined]) {
      expect((await failure(labelDeckSession({ tmux: "t", run: tmux.run, name, sessionId: ID }))).code, String(name)).toBe("bad-name");
    }
    for (const sessionId of ["", "--resume", "not-a-uuid", undefined]) {
      expect((await failure(labelDeckSession({ tmux: "t", run: tmux.run, name: "ccdeck-codex-0123abcd", sessionId }))).code, String(sessionId))
        .toBe("bad-session-id");
    }
    expect(tmux.calls).toEqual([]);
  });

  it("says false when the session has gone meanwhile, and keeps tmux's own words out of the sentence otherwise", async () => {
    const tmux = fakeTmux(
      { ok: false, stderr: "can't find session: ccdeck-codex-0123abcd\n" },
      { ok: false, stderr: "no server running on /tmp/tmux-1000/ccdeck\n" },
      { ok: false, stderr: "lost server /tmp/tmux-1000/ccdeck\n" },
    );
    const opts = { tmux: "t", run: tmux.run, name: "ccdeck-codex-0123abcd", sessionId: ID };
    expect(await labelDeckSession(opts)).toBe(false);
    expect(await labelDeckSession(opts)).toBe(false);
    const err = await failure(labelDeckSession(opts));
    expect(err.code).toBe("tmux-failed");
    expect(err.message).not.toContain("/tmp");
    expect(err.detail).toContain("/tmp/tmux-1000/ccdeck");
  });
});

describe("closing a session", () => {
  it("refuses every name the deck did not give, before tmux is asked anything", async () => {
    const tmux = fakeTmux();
    for (const name of ["main", "0", "ccdeck-", "ccdeck-claude-xyz", "=ccdeck-claude-0123abcd", "", undefined]) {
      expect((await failure(killDeckSession({ tmux: "t", run: tmux.run, name }))).code, String(name)).toBe("bad-name");
    }
    expect(tmux.calls).toEqual([]);
  });

  it("closes a deck session by its exact name, and says whether it was there", async () => {
    const tmux = fakeTmux(
      { ok: true },
      { ok: false, stderr: "can't find session: ccdeck-claude-0123abcd\n" },
      { ok: false, stderr: "no server running on /tmp/tmux-1000/ccdeck\n" },
    );
    expect(await killDeckSession({ tmux: "t", run: tmux.run, name: "ccdeck-claude-0123abcd" })).toBe(true);
    expect(await killDeckSession({ tmux: "t", run: tmux.run, name: "ccdeck-claude-0123abcd" })).toBe(false);
    expect(await killDeckSession({ tmux: "t", run: tmux.run, name: "ccdeck-claude-0123abcd" })).toBe(false);
    expect(tmux.calls[0].args, "`=` so a prefix of another session's name can never match")
      .toEqual(["kill-session", "-t", "=ccdeck-claude-0123abcd"]);
  });
});

describe("terminal-sessions.mjs", () => {
  it("imports only Node built-ins and the deck's own modules", () => {
    const src = readFileSync(new URL("../../server/terminal-sessions.mjs", import.meta.url), "utf8");
    const from = [...src.matchAll(/^import [^;]*? from "([^"]+)";/gms)].map(m => m[1]);
    expect(from.length).toBeGreaterThan(0);
    for (const spec of from) expect(spec, "a runtime dependency").toMatch(/^(node:|\.\/)/);
  });
});

describe("clearing old dead sessions", () => {
  const DAY = 24 * 60 * 60_000;
  const NOW = 1_800_000_000_000;
  /** One prune listing line: name, dead, dead since, created — seconds. */
  const row = (name: string, dead: 0 | 1, deadAgoMs: number | null, createdAgoMs = 30 * DAY) =>
    [name, dead, deadAgoMs == null ? "" : String(Math.floor((NOW - deadAgoMs) / 1000)), String(Math.floor((NOW - createdAgoMs) / 1000))].join("\t");

  it("keeps a week of dead sessions and the twenty most recent, and closes the rest", () => {
    expect(DEAD_KEEP).toEqual({ maxAgeMs: 7 * DAY, count: 20 });
    const listing = [
      row("ccdeck-claude-00000001", 1, 1 * DAY),
      row("ccdeck-codex-00000002", 1, 8 * DAY),
      row("ccdeck-claude-00000003", 0, null),
      row("ccdeck-att-5f0c2a9e", 1, 10 * DAY),
    ].join("\n");
    expect(staleDeadSessions(listing, { now: NOW })).toEqual(["ccdeck-codex-00000002", "ccdeck-att-5f0c2a9e"]);
    const many = Array.from({ length: 23 }, (_, i) => row(`ccdeck-claude-${String(i).padStart(8, "0")}`, 1, i * 60_000)).join("\n");
    expect(staleDeadSessions(many, { now: NOW }), "the three oldest past the twenty newest")
      .toEqual(["ccdeck-claude-00000020", "ccdeck-claude-00000021", "ccdeck-claude-00000022"]);
  });

  it("never closes a live pane, a session with a live pane beside a dead one, or a name the deck did not give", () => {
    const listing = [
      row("ccdeck-claude-0000000a", 0, null, 90 * DAY),
      row("ccdeck-claude-0000000b", 1, 30 * DAY),
      row("ccdeck-claude-0000000b", 0, null),
      row("my-own-session", 1, 30 * DAY),
      "half a line",
    ].join("\n");
    expect(staleDeadSessions(listing, { now: NOW })).toEqual([]);
  });

  it("goes by when a session was created on a tmux that cannot say when its pane died", () => {
    expect(staleDeadSessions(row("ccdeck-codex-0000000c", 1, null, 9 * DAY), { now: NOW })).toEqual(["ccdeck-codex-0000000c"]);
    expect(staleDeadSessions(row("ccdeck-codex-0000000d", 1, null, 2 * DAY), { now: NOW })).toEqual([]);
  });

  it("lists once on the deck's server, closes each pick by its exact name, and answers what it closed", async () => {
    const tmux = fakeTmux({ ok: true, stdout: [row("ccdeck-claude-00000001", 1, 9 * DAY), row("ccdeck-claude-00000002", 1, 10 * DAY)].join("\n") },
      { ok: true }, { ok: false, stderr: "can't find session: ccdeck-claude-00000002\n" });
    const closed = await pruneDeadDeckSessions({ tmux: "t", run: tmux.run, now: NOW });
    expect(closed, "one was already gone").toEqual(["ccdeck-claude-00000001"]);
    expect(tmux.calls[0].socket).toBe(DECK_SOCKET);
    expect(tmux.calls[0].args.slice(0, 3)).toEqual(["list-panes", "-a", "-F"]);
    expect(tmux.calls.slice(1).map(c => c.args)).toEqual([
      ["kill-session", "-t", "=ccdeck-claude-00000001"], ["kill-session", "-t", "=ccdeck-claude-00000002"],
    ]);
  });

  it("answers nothing closed, and never throws, with no server or a failing tmux", async () => {
    expect(await pruneDeadDeckSessions({ tmux: "t", run: fakeTmux({ ok: false, stderr: "no server running on /tmp/tmux-1000/ccdeck\n" }).run })).toEqual([]);
    expect(await pruneDeadDeckSessions({ tmux: "t", run: async () => { throw new Error("boom"); } })).toEqual([]);
  });
});
