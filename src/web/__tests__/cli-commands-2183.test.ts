// #2183: the deck's accounts and sessions, from a terminal — `ccdeck accounts`,
// `ccdeck switch` (alias `swap`), `ccdeck usage`, `ccdeck sessions`, `ccdeck open`.
//
// Asked for by people who reach a machine running ccdeck over SSH: no tab, no
// wish to forward one, and claude-swap by hand as the only way to move the
// login — outside the deck's store lock, racing the panel and auto-switch.
//
// What is pinned here, in the order it can go wrong:
//
//   the parser    a command word is a command wherever it stands, a misspelled
//                 one in first position is refused rather than started as a
//                 deck, and nothing that used to start a deck stops doing so;
//   the choice    which account `2`, `work`, `alice@` and `--best` name — the
//                 rules a person leans on without looking;
//   the lines     nothing wraps at any width, and the ASCII tier is ASCII;
//   the client    commands talk to the running deck with its token and nothing
//                 a browser would send, a switch goes THROUGH the deck, and with
//                 no deck the account commands still work from the store.
//
// THE DECK IS FAKE where one is needed — a registry record naming a process of
// this test and a server of this test's own, the shape
// status-marks-older-deck.test.ts uses — and claude-swap is a stub, so nothing
// here can reach a real account.
import { describe, it, expect, afterAll, afterEach, beforeAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";

// @ts-expect-error — plain .mjs module, no types
const { parseArgs, isOneShot, COMMANDS } = await import("../../server/args.mjs");
// @ts-expect-error — plain .mjs module, no types
const { shouldDetach } = await import("../../server/detach.mjs");
// @ts-expect-error — plain .mjs module, no types
const { resolveAccount, bestAccount, switchable, accountName } = await import("../../server/account-pick.mjs");
// @ts-expect-error — plain .mjs module, no types
const { accountLines, sessionLines, usageLines, meter, untilReset, shortModel, textWidth } = await import("../../server/cli-lines.mjs");
// @ts-expect-error — plain .mjs module, no types
const { glyphs, palette, visibleWidth } = await import("../../server/term.mjs");
// @ts-expect-error — plain .mjs module, no types
const { challengeProof } = await import("../../server/deck-probe.mjs");
// @ts-expect-error — plain .mjs module, no types
const { findDeck, askDeck } = await import("../../server/deck-client.mjs");

const DECK = fileURLToPath(new URL("../../../bin/deck.js", import.meta.url));

type Row = Record<string, unknown>;
const lane = (id: string, label: string, pct: number, resetAt: number | null = null) => ({ id, label, pct, resetAt });
const NOW = 1_800_000_000_000;
function row(num: number, email: string, alias: string | null, over: Row = {}): Row {
  return {
    num, email, alias, org: null, orgUuid: `org-${num}`, alive: true, active: false, disabled: false,
    lanes: [lane("five_hour", "5h", 10, NOW / 1000 + 3600), lane("seven_day", "7d", 20, NOW / 1000 + 86_400)],
    headroom: 80, fetchedAt: NOW - 60_000, stale: false, error: null, staleCopy: false, stopped: false,
    ...over,
  };
}
const ROWS: Row[] = [
  row(1, "alice@corp.example", "work", { active: true, lanes: [lane("five_hour", "5h", 82), lane("seven_day", "7d", 61)], headroom: 18 }),
  row(2, "bob@home.example", "personal", { lanes: [lane("five_hour", "5h", 12), lane("seven_day", "7d", 34)], headroom: 66 }),
  row(3, "carol@spare.example", null, { error: "invalid_grant", alive: false, headroom: 97 }),
  row(4, "dan@old.example", "old", { disabled: true, headroom: 95 }),
];

// ── the parser ──────────────────────────────────────────────────────────────

describe("a command word is a command", () => {
  it("by every spelling, with its operands after it", () => {
    const spellings: [string, string][] = [
      ["accounts", "accounts"], ["account", "accounts"], ["ls", "accounts"],
      ["switch", "switch"], ["swap", "switch"], ["use", "switch"],
      ["usage", "usage"], ["quota", "usage"], ["sessions", "sessions"], ["ps", "sessions"], ["open", "open"],
    ];
    for (const [word, command] of spellings) {
      expect(parseArgs([word, "2"]), word).toEqual({ command, commandWord: word, operands: ["2"], unknown: [], incomplete: [] });
    }
    // The table and the list above are the same list: a spelling added to one
    // and not the other fails here.
    expect(Object.keys(COMMANDS).sort()).toEqual(spellings.map(([w]) => w).sort());
  });

  it("wherever it stands among the flags", () => {
    expect(parseArgs(["--json", "accounts"])).toEqual({ json: true, command: "accounts", commandWord: "accounts", operands: [], unknown: [], incomplete: [] });
    expect(parseArgs(["switch", "--port", "4400", "work", "--best"]))
      .toEqual({ command: "switch", commandWord: "switch", operands: ["work"], port: "4400", best: true, unknown: [], incomplete: [] });
  });

  it("takes what follows `--` as operands, so an alias may begin with a dash", () => {
    expect(parseArgs(["switch", "--", "-odd"]).operands).toEqual(["-odd"]);
    // And without a command, the separator still ends the line as it did.
    expect(parseArgs(["--", "switch"])).toEqual({ unknown: [], incomplete: [] });
  });

  it("spells the existing one-shots as words, setting the very same flags", () => {
    expect(parseArgs(["status"])).toEqual({ status: true, unknown: [], incomplete: [] });
    expect(parseArgs(["stop", "--port", "4318"])).toEqual({ stop: true, port: "4318", unknown: [], incomplete: [] });
    expect(parseArgs(["logs"])).toEqual({ logs: true, unknown: [], incomplete: [] });
    expect(parseArgs(["help"])).toEqual({ help: true, unknown: [], incomplete: [] });
    expect(parseArgs(["version"])).toEqual({ version: true, unknown: [], incomplete: [] });
  });

  it("reads `start` as the bare start it means", () => {
    expect(parseArgs(["start"])).toEqual({ unknown: [], incomplete: [] });
    expect(parseArgs(["start", "--no-open"])).toEqual({ noOpen: true, unknown: [], incomplete: [] });
  });
});

describe("a command line never detaches, and a misspelled one never starts a deck", () => {
  it("answers and leaves for every command and for a word that is not one", () => {
    for (const argv of [["accounts"], ["swap", "2"], ["sessions", "--json"], ["acounts"], ["deck"]]) {
      const flags = parseArgs(argv);
      expect(isOneShot(flags), argv.join(" ")).toBe(true);
      expect(shouldDetach({ flags }), argv.join(" ")).toBe(false);
    }
    expect(parseArgs(["acounts"]).unknownCommand).toBe("acounts");
  });

  it("still starts a deck for everything that started one before", () => {
    for (const argv of [[], ["start"], ["--no-open"], ["~/proj"], ["--no-open", "deck"], ["--workspace", "C:\\Users\\John", "Smith\\proj"],
      ["--workspace", "/home/ana/Face", "Swap"], ["--no-open", "status"], ["myproj", "--port", "4400", "--no-open"], ["~/my", "swap"]]) {
      expect(isOneShot(parseArgs(argv)), argv.join(" ")).toBe(false);
    }
  });

  it("reads a start line's words the way it always did — a split path's half is not a switch", () => {
    expect(parseArgs(["--workspace", "/home/ana/Face", "Swap"])).toEqual({ workspace: "/home/ana/Face", unknown: ["Swap"], incomplete: [] });
    expect(parseArgs(["--no-open", "status"])).toEqual({ noOpen: true, unknown: ["status"], incomplete: [] });
    // Only the first bare word can be a command.
    expect(parseArgs(["~/my", "swap"])).toEqual({ unknown: ["~/my", "swap"], incomplete: [] });
  });

  it("replays an upgrade's argv as the start it was, by npx or on disk", () => {
    // npx: the user's argv with `--no-open` added, which makes it a start line.
    expect(parseArgs(["myproj", "--port", "4400", "--no-open"])).toEqual({ port: "4400", noOpen: true, unknown: ["myproj"], incomplete: [] });
    // On disk: `--port` added, and the worker reads it with commands off — an
    // older deck took `ccdeck open` as a warning and a start.
    expect(parseArgs(["myproj", "--port", "4400"], { commands: false })).toEqual({ port: "4400", unknown: ["myproj"], incomplete: [] });
    expect(parseArgs(["open", "--port", "4400"], { commands: false })).toEqual({ port: "4400", unknown: ["open"], incomplete: [] });
    expect(parseArgs(["status"], { commands: false })).toEqual({ unknown: ["status"], incomplete: [] });
    expect(parseArgs(["start", "--port", "4400"], { commands: false })).toEqual({ port: "4400", unknown: [], incomplete: [] });
    // And the worker is the one that asks: a respawn is the only reader of a
    // respawned argv, and AGENTS_DECK_RESPAWN is what says it is one.
    expect(readFileSync(DECK, "utf8")).toContain(`parseArgs(argv, { commands: process.env.AGENTS_DECK_RESPAWN !== "1" })`);
  });
});

// ── which account a command line means ──────────────────────────────────────

describe("resolveAccount", () => {
  it("reads a whole number as a slot and only as a slot", () => {
    expect(resolveAccount(ROWS, "2").account.num).toBe(2);
    // Not "the second row": the list's order is the rotation's.
    expect(resolveAccount([ROWS[1], ROWS[0]], "1").account.num).toBe(1);
    expect(resolveAccount(ROWS, "9")).toEqual({ none: true });
  });

  it("takes an exact email or alias whatever its case", () => {
    expect(resolveAccount(ROWS, "BOB@home.example").account.num).toBe(2);
    expect(resolveAccount(ROWS, "Work").account.num).toBe(1);
  });

  it("takes a fragment only when it narrows to one account", () => {
    expect(resolveAccount(ROWS, "carol").account.num).toBe(3);
    expect(resolveAccount(ROWS, "@corp").account.num).toBe(1);
    expect(resolveAccount(ROWS, "example").ambiguous.map((a: Row) => a.num)).toEqual([1, 2, 3, 4]);
    expect(resolveAccount(ROWS, "zzz")).toEqual({ none: true });
    expect(resolveAccount(ROWS, "  ")).toEqual({ none: true });
  });
});

describe("bestAccount", () => {
  it("is the switchable account with the most room against its tightest lane", () => {
    // #3 and #4 have more room on paper, and are a dead login and a slot kept
    // out of rotation on purpose.
    expect(bestAccount(ROWS).account.num).toBe(2);
    expect(switchable(ROWS[2])).toBe(false);
    expect(switchable(ROWS[3])).toBe(false);
  });

  it("stays on the active account when another has only as much room", () => {
    const tied = [row(1, "a@x", null, { headroom: 50 }), row(2, "b@x", null, { active: true, headroom: 50 })];
    expect(bestAccount(tied).already.num).toBe(2);
  });

  it("says so when the active account is already it", () => {
    const rows = ROWS.map(a => ({ ...a, active: a.num === 2 }));
    expect(bestAccount(rows).already.num).toBe(2);
  });

  it("takes a stored copy that is behind, since its login works", () => {
    const rows = [row(1, "a@x", null, { active: true, headroom: 10 }), row(2, "b@x", null, { error: null, staleCopy: true, headroom: 70 })];
    expect(bestAccount(rows).account.num).toBe(2);
  });

  it("ranks an account nobody has read below any reading, then fresh over stale, then the lower slot", () => {
    const rows = [
      row(1, "a@x", null, { active: true, headroom: 5 }),
      row(2, "b@x", null, { headroom: null }),
      row(3, "c@x", null, { headroom: 50, stale: true }),
      row(4, "d@x", null, { headroom: 50 }),
      row(5, "e@x", null, { headroom: 50 }),
    ];
    expect(bestAccount(rows).account.num).toBe(4);
  });

  it("answers none when nothing can take the login", () => {
    expect(bestAccount([ROWS[2], ROWS[3]])).toEqual({ none: true });
    expect(accountName(ROWS[0])).toBe("#1 alice@corp.example (work)");
  });
});

// ── the lines ───────────────────────────────────────────────────────────────

const plain = { tone: palette("none"), g: glyphs(true), unicode: true, now: NOW };
const ascii = { tone: palette("none"), g: glyphs(false), unicode: false, now: NOW };

describe("accountLines", () => {
  const long = [
    ...ROWS,
    row(12, "a.very.long.address.for.a.shared.team.account@enterprise-company.example", "a-long-alias-name", {
      stale: true, fetchedAt: NOW - 5 * 3600_000,
    }),
  ];

  it("never wraps, at any width the deck can be read at", () => {
    for (const columns of [40, 52, 64, 80, 103, 104, 120, 160]) {
      for (const line of accountLines(long, { ...plain, columns })) {
        expect(visibleWidth(line), `${columns}: ${line}`).toBeLessThanOrEqual(columns);
      }
    }
  });

  it("marks the active account, and words what is wrong with the others", () => {
    const lines = accountLines(ROWS, { ...plain, columns: 120 });
    expect(lines[0]).toMatch(/^ {2}● 1 {2}work/);
    expect(lines[1]).toMatch(/^ {4}2 {2}personal/);
    expect(lines[2]).toContain("sign-in needed");
    expect(lines[3]).toContain("disabled");
    // Meters only where there is room for them.
    expect(lines[0]).toContain("█");
    expect(accountLines(ROWS, { ...plain, columns: 80 })[0]).not.toContain("█");
  });

  it("says when a reading is old, and when there has been none", () => {
    const lines = accountLines([row(1, "a@x", null, { stale: true, fetchedAt: NOW - 3 * 3600_000 }), row(2, "b@x", null, { lanes: [], fetchedAt: null })], { ...plain, columns: 120 });
    expect(lines[0]).toContain("read 3h ago");
    expect(lines[1]).toContain("not read yet");
  });

  it("is ASCII on a console that cannot draw anything else", () => {
    for (const line of [
      ...accountLines(long, { ...ascii, columns: 120 }),
      ...usageLines(ROWS[0], { ...ascii, columns: 80 }),
      ...sessionLines(SESSIONS, { ...ascii, columns: 80 }),
    ]) {
      expect(line, line).toMatch(/^[\x20-\x7e]*$/);
    }
  });

  it("has no trailing blanks for a pipe to carry, coloured or not", () => {
    const tone = palette("ansi16");
    for (const line of accountLines(ROWS, { ...plain, tone, columns: 120 })) {
      expect(line.replace(/\x1b\[[0-9;]*m/g, ""), line).not.toMatch(/ $/);
    }
  });
});

describe("the small readings", () => {
  it("meter fills in proportion and clamps", () => {
    expect(meter(50)).toBe("█████░░░░░");
    expect(meter(140, { cells: 4 })).toBe("████");
    expect(meter(-3, { cells: 4, unicode: false })).toBe("....");
  });

  it("untilReset counts down to a reset in seconds, and says nothing once it has passed", () => {
    expect(untilReset(NOW / 1000 + 4300, NOW)).toBe("1h 11m");
    expect(untilReset(NOW / 1000 - 10, NOW)).toBe("");
    expect(untilReset(null, NOW)).toBe("");
  });

  it("shortModel keeps the part a person says", () => {
    expect(shortModel("claude-opus-4-1-20250805")).toBe("opus-4-1");
    expect(shortModel("claude-sonnet-4-5[1m]")).toBe("sonnet-4-5");
    expect(shortModel("gpt-5-codex")).toBe("gpt-5-codex");
    expect(shortModel(undefined)).toBe("");
  });
});

const SESSIONS = [
  { id: "s-wait", provider: "claude", cwd: "/r/ccdeck", project: "ccdeck", name: null, model: "claude-opus-4-1-20250805",
    state: "waiting", since: NOW - 240_000, lastEventAt: NOW - 1000,
    waiting: { kind: "permission", message: "Claude needs your permission to use Bash", since: NOW - 240_000, tool: "Bash" } },
  { id: "s-run", provider: "claude", cwd: "/r/vcrm-core", project: "vcrm-core", name: "fix the importer", model: null,
    state: "working", since: NOW - 12_000, lastEventAt: NOW, waiting: null },
  { id: "s-codex", provider: "codex", cwd: "/r/site", project: "site", name: null, model: "gpt-5-codex",
    state: "idle", since: NOW - 540_000, lastEventAt: NOW - 540_000, waiting: null },
];

describe("sessionLines", () => {
  it("puts the question under the session asking it, without naming the tool twice", () => {
    const lines = sessionLines(SESSIONS, { ...plain, columns: 100 });
    expect(lines[0]).toMatch(/waiting\s+4m\s+ccdeck\s+Claude · opus-4-1/);
    expect(lines[1].trim()).toBe("Claude needs your permission to use Bash");
    expect(lines[2]).toMatch(/working\s+12s\s+fix the importer/);
    expect(lines[3]).toMatch(/your turn\s+9m\s+site\s+Codex · gpt-5-codex/);
  });

  it("names the tool when Claude Code's sentence does not", () => {
    const asked = [{ ...SESSIONS[0], waiting: { ...SESSIONS[0].waiting, message: "Claude needs your permission" } }];
    expect(sessionLines(asked, { ...plain, columns: 100 })[1]).toContain("(Bash)");
  });

  it("never wraps", () => {
    for (const columns of [40, 60, 80, 120]) {
      for (const line of sessionLines(SESSIONS, { ...plain, columns })) {
        expect(visibleWidth(line), `${columns}: ${line}`).toBeLessThanOrEqual(columns);
      }
    }
  });

  it("prints what a session brings on one line, without a byte the terminal acts on, clipped by the columns it takes", () => {
    const odd = [{
      ...SESSIONS[0],
      name: "日本語のセッションのタイトルがとても長い場合 🚀🚀",
      waiting: { ...SESSIONS[0].waiting, message: "line one\nline two \x1b[2J\x1b]0;title\x07 end \u009b31m", tool: "Bash\r" },
    }];
    for (const columns of [40, 60, 80]) {
      const lines = sessionLines(odd, { ...plain, columns });
      expect(lines, String(columns)).toHaveLength(2);
      for (const line of lines) {
        expect(textWidth(line), `${columns}: ${line}`).toBeLessThanOrEqual(columns);
        expect(line, `${columns}: ${line}`).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
      }
    }
    expect(textWidth("日本🚀a")).toBe(7);
  });
});

// ── the client, end to end ──────────────────────────────────────────────────

const SANDBOX = mkdtempSync(join(tmpdir(), "ccdeck-cli-2183-"));
const CFG = join(SANDBOX, ".claude");
const REGISTRY = join(CFG, "agent-dag");
const STORE = join(SANDBOX, "claude-swap");
const STUB_LOG = join(SANDBOX, "cswap-calls.log");
const STUB = join(SANDBOX, process.platform === "win32" ? "cswap.cmd" : "cswap");

const CHILD_ENV: Record<string, string | undefined> = {
  ...process.env,
  HOME: SANDBOX,
  USERPROFILE: SANDBOX,
  CLAUDE_CONFIG_DIR: CFG,
  CODEX_HOME: join(SANDBOX, ".codex"),
  CCDECK_HOME: join(SANDBOX, "deck-data"),
  XDG_CONFIG_HOME: join(SANDBOX, "xdg-config"),
  XDG_DATA_HOME: join(SANDBOX, "xdg-data"),
  XDG_STATE_HOME: join(SANDBOX, "xdg-state"),
  XDG_CACHE_HOME: join(SANDBOX, "xdg-cache"),
  CLAUDE_SWAP_BACKUP: STORE,
  AGENTS_DECK_CSWAP: STUB,
  AGENTS_DECK_NO_INSTALL: "1",
  AGENTS_DECK_NO_LAN: "1",
  AGENTS_DECK_NO_NOTIFY: "1",
  AGENTS_DECK_NO_MUSIC: "1",
  AGENTS_DECK_NO_UPDATE_CHECK: "1",
  AGENTS_DECK_NO_DOWNLOAD: "1",
  AGENT_DAG_PORT: "",
  NO_COLOR: "1",
  FORCE_COLOR: undefined,
  COLUMNS: "120",
  // `open` tells a remote shell from a desk by these; the suite's own runner
  // may be either, and the test below states which one it means.
  SSH_CONNECTION: undefined,
  SSH_CLIENT: undefined,
  SSH_TTY: undefined,
};
for (const k of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CCDECK_HOME", "CLAUDE_SWAP_BACKUP",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) {
  if (!resolve(String(CHILD_ENV[k])).startsWith(resolve(SANDBOX))) throw new Error(`sandbox escaped: ${k}`);
}

beforeAll(() => {
  // A claude-swap that records what it was asked and changes nothing: the
  // assertion is that the switch REACHED it, with the slot as its argument.
  if (process.platform === "win32") {
    writeFileSync(STUB, ["@echo off", `>>"${STUB_LOG}" echo %*`, "echo claude-swap 0.26.0"].join("\r\n") + "\r\n");
  } else {
    writeFileSync(STUB, ["#!/bin/sh", `echo "$*" >> "${STUB_LOG}"`, "echo claude-swap 0.26.0"].join("\n") + "\n", { mode: 0o755 });
  }
});
afterAll(() => rmTempDir(SANDBOX));

function run(args: string[], env: Record<string, string | undefined> = {}): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((done, fail) => {
    let out = "";
    let err = "";
    const c = spawn(process.execPath, [DECK, ...args], { stdio: ["ignore", "pipe", "pipe"], env: { ...CHILD_ENV, ...env }, cwd: SANDBOX });
    c.stdout!.on("data", d => { out += String(d); });
    c.stderr!.on("data", d => { err += String(d); });
    const timer = setTimeout(() => { c.kill("SIGKILL"); fail(new Error(`ccdeck ${args.join(" ")} did not exit:\n${out}\n${err}`)); }, 30_000);
    c.on("error", e => { clearTimeout(timer); fail(e); });
    c.on("exit", code => { clearTimeout(timer); done({ code, out, err }); });
  });
}

describe("with a deck running", () => {
  let deckPid: ChildProcess | null = null;
  let server: Server | null = null;
  const seen: { method: string; path: string; headers: IncomingHttpHeaders; body: string }[] = [];
  const roster = () => ({ ok: true, activeNum: 1, fetchedAt: NOW, accounts: ROWS });
  const deckSessions = [
    ...SESSIONS,
    { ...SESSIONS[1], id: "s-old", state: "ended", since: NOW - 9e6, lastEventAt: NOW - 9e6 },
  ];

  beforeAll(async () => {
    rmSync(CFG, { recursive: true, force: true });
    mkdirSync(REGISTRY, { recursive: true });
    deckPid = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore" });
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      let body = "";
      req.on("data", d => { body += String(d); });
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (url.pathname === "/api/hook-challenge") {
          res.end(JSON.stringify({ proof: challengeProof("tok", url.searchParams.get("nonce") ?? "") }));
          return;
        }
        seen.push({ method: req.method ?? "", path: url.pathname, headers: req.headers, body });
        if (req.headers["x-ccdeck-token"] !== "tok") { res.statusCode = 401; res.end("{}"); return; }
        if (url.pathname === "/api/claude-accounts") { res.end(JSON.stringify(roster())); return; }
        if (url.pathname === "/api/claude-accounts/switch") { res.end(JSON.stringify({ ok: true, output: "switched" })); return; }
        if (url.pathname === "/api/sessions") { res.end(JSON.stringify({ ok: true, now: NOW, sessions: deckSessions })); return; }
        res.statusCode = 404;
        res.end("{}");
      });
    });
    await new Promise<void>(done => server!.listen(0, "127.0.0.1", done));
    const { port } = server.address() as AddressInfo;
    writeFileSync(join(REGISTRY, `${deckPid.pid}.json`), JSON.stringify({
      pid: deckPid.pid, parent: null, port, token: "tok", workspace: "", persist: null, codex: false, claude: true,
      version: "3.42.0", startedAt: new Date(Date.now() - 60_000).toISOString(),
    }));
  });

  afterAll(async () => {
    deckPid?.kill("SIGKILL");
    const s = server;
    if (s) await new Promise(done => s.close(done));
    rmSync(REGISTRY, { recursive: true, force: true });
  });

  afterEach(() => { seen.length = 0; });

  it("finds it through the registry, the way --stop does", async () => {
    const found = await findDeck({ live: async () => [{ port: 1, version: "3.40.0" }, { port: 2, version: "3.42.0" }, { port: 3, version: "3.42.0" }] });
    expect(found.port).toBe(2);
    expect(await findDeck({ live: async () => [] })).toBeNull();
    expect((await findDeck({ port: 3, live: async () => [{ port: 2 }, { port: 3 }] })).port).toBe(3);
  });

  it("reads the roster with the deck's token and nothing a browser would send", async () => {
    const { code, out, err } = await run(["accounts", "--json"]);
    expect(code, err).toBe(0);
    const answer = JSON.parse(out);
    expect(answer).toMatchObject({ schemaVersion: 1, ok: true, source: "deck", activeNum: 1 });
    expect(answer.accounts.map((a: Row) => a.num)).toEqual([1, 2, 3, 4]);
    const read = seen.find(r => r.path === "/api/claude-accounts")!;
    expect(read.headers["x-ccdeck-token"]).toBe("tok");
    expect(read.headers.origin).toBeUndefined();
    expect(read.headers["sec-fetch-site"]).toBeUndefined();
    expect(read.headers.referer).toBeUndefined();
  }, 45_000);

  it("prints the roster for a person", async () => {
    const { code, out } = await run(["ls"]);
    expect(code).toBe(0);
    expect(out).toMatch(/● 1 {2}work/);
    expect(out).toContain("sign-in needed");
    expect(out).not.toContain("no deck is running");
  }, 45_000);

  it("switches THROUGH the deck, and says how many sessions follow", async () => {
    const { code, out, err } = await run(["swap", "personal", "--json"]);
    expect(code, err).toBe(0);
    const post = seen.find(r => r.path === "/api/claude-accounts/switch")!;
    expect(post.method).toBe("POST");
    expect(JSON.parse(post.body)).toEqual({ account: 2 });
    expect(post.headers.origin).toBeUndefined();
    const answer = JSON.parse(out);
    expect(answer).toMatchObject({ ok: true, switched: true, source: "deck", account: { num: 2 }, previous: { num: 1 } });
    // Two Claude sessions not ended; the Codex one does not follow a Claude login.
    expect(answer.liveSessions).toBe(2);
    expect(existsSync(STUB_LOG) ? readFileSync(STUB_LOG, "utf8") : "").not.toContain("switch");
  }, 45_000);

  it("picks the account with the most room for --best", async () => {
    const { code, out } = await run(["switch", "--best", "--json"]);
    expect(code).toBe(0);
    expect(JSON.parse(out).account.num).toBe(2);
  }, 45_000);

  it("leaves the login alone for the account already active", async () => {
    const { code, out } = await run(["switch", "work", "--json"]);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ switched: false, account: { num: 1 } });
    expect(seen.some(r => r.path === "/api/claude-accounts/switch")).toBe(false);
  }, 45_000);

  it("refuses a login known to be dead, since every running session would follow it", async () => {
    const { code, out } = await run(["switch", "3", "--json"]);
    expect(code).toBe(1);
    expect(JSON.parse(out)).toMatchObject({ ok: false, error: { code: "needs_sign_in" } });
    expect(seen.some(r => r.path === "/api/claude-accounts/switch")).toBe(false);
  }, 45_000);

  it("answers two accounts with where the slot exchange lives, and switches nothing", async () => {
    const { code, err } = await run(["swap", "1", "2"]);
    expect(code).toBe(2);
    expect(err).toContain("cswap swap 1 2");
    expect(seen.some(r => r.path === "/api/claude-accounts/switch")).toBe(false);
  }, 45_000);

  it("names every match when a fragment names several, and asks for a number", async () => {
    const { code, out } = await run(["switch", "example", "--json"]);
    expect(code).toBe(2);
    const answer = JSON.parse(out);
    expect(answer.error.code).toBe("ambiguous");
    expect(answer.matches.map((a: Row) => a.num)).toEqual([1, 2, 3, 4]);
  }, 45_000);

  it("never prompts without a terminal: no account named is a usage error", async () => {
    const { code, err } = await run(["switch"]);
    expect(code).toBe(2);
    expect(err).toContain("name the account");
  }, 45_000);

  it("lists the sessions, the ended ones only with --all", async () => {
    const shown = JSON.parse((await run(["sessions", "--json"])).out);
    expect(shown.sessions.map((s: Row) => s.id)).toEqual(["s-wait", "s-run", "s-codex"]);
    const all = JSON.parse((await run(["ps", "--all", "--json"])).out);
    expect(all.sessions.map((s: Row) => s.id)).toContain("s-old");
    const { out } = await run(["sessions"]);
    expect(out).toContain("1 waiting on you");
    expect(out).toContain("`--all` adds 1 ended");
  }, 60_000);

  it("prints the ssh -L line over SSH instead of opening a browser on the wrong machine", async () => {
    const port = (server!.address() as AddressInfo).port;
    // Never the deck's own port on the reader's side: theirs is likely taken
    // by their own deck, and a forward that cannot bind must end ssh.
    const local = port + 10_000 <= 65_535 ? port + 10_000 : port - 10_000;
    const { code, out } = await run(["open", "--json"], { SSH_CONNECTION: "10.0.0.5 50000 10.0.0.9 22" });
    expect(code).toBe(0);
    const answer = JSON.parse(out);
    expect(answer).toMatchObject({ opened: false, url: `http://127.0.0.1:${port}`, tunnelUrl: `http://127.0.0.1:${local}` });
    expect(answer.tunnel).toMatch(new RegExp(`^ssh -N -o ExitOnForwardFailure=yes -L ${local}:127\\.0\\.0\\.1:${port} (\\S+@)?10\\.0\\.0\\.9$`));
    // An sshd on another port is named, or the line would knock on 22.
    const other = JSON.parse((await run(["open", "--json"], { SSH_CONNECTION: "10.0.0.5 50000 10.0.0.9 2222" })).out);
    expect(other.tunnel).toMatch(/ -p 2222 (\S+@)?10\.0\.0\.9$/);
  }, 45_000);

  it("refuses a --port it cannot use rather than asking any deck", async () => {
    for (const argv of [["accounts", "--port", "431x", "--json"], ["switch", "2", "--json", "--port"], ["sessions", "--port4317", "--json"]]) {
      const { code, out } = await run(argv);
      expect(code, argv.join(" ")).toBe(2);
      expect(JSON.parse(out).error.code, argv.join(" ")).toBe("bad_port");
    }
    expect(seen).toEqual([]);
  }, 60_000);

  it("refuses a misspelled command, suggests the right one, and starts no deck", async () => {
    const before = readdirSync(REGISTRY).sort();
    const { code, out, err } = await run(["acounts"]);
    expect(code).toBe(2);
    expect(err).toContain("did you mean `ccdeck accounts`");
    expect(out).toBe("");
    expect(readdirSync(REGISTRY).sort()).toEqual(before);
  }, 45_000);
});

describe("with no deck running", () => {
  beforeAll(() => {
    rmSync(REGISTRY, { recursive: true, force: true });
    mkdirSync(join(STORE, "cache"), { recursive: true });
    const now = Math.floor(Date.now() / 1000);
    writeFileSync(join(STORE, "sequence.json"), JSON.stringify({
      activeAccountNumber: 1, sequence: [1, 2],
      accounts: {
        1: { email: "alice@corp.example", organizationUuid: "org-1", alias: "work" },
        2: { email: "bob@home.example", organizationUuid: "org-2", alias: "personal" },
      },
    }));
    writeFileSync(join(STORE, "cache", "usage.json"), JSON.stringify({
      schemaVersion: 2,
      accounts: {
        1: { email: "alice@corp.example", organizationUuid: "org-1", fetchedAt: now - 60, lastGood: { five_hour: { pct: 70 }, seven_day: { pct: 20 } } },
        2: { email: "bob@home.example", organizationUuid: "org-2", fetchedAt: now - 60, lastGood: { five_hour: { pct: 5 }, seven_day: { pct: 10 } } },
      },
    }));
  });

  it("reads the accounts from claude-swap's store in this process", async () => {
    const { code, out, err } = await run(["accounts", "--json"]);
    expect(code, err).toBe(0);
    const answer = JSON.parse(out);
    expect(answer).toMatchObject({ ok: true, source: "local", activeNum: 1 });
    expect(answer.accounts.map((a: Row) => a.email)).toEqual(["alice@corp.example", "bob@home.example"]);
  }, 45_000);

  it("switches with claude-swap directly, and records the switch where the deck would", async () => {
    const { code, out, err } = await run(["switch", "--best", "--json"]);
    expect(code, err).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ switched: true, source: "local", account: { num: 2 } });
    expect(readFileSync(STUB_LOG, "utf8")).toMatch(/^switch 2\s*$/m);
    const log = readFileSync(join(SANDBOX, ".agents-deck", "log", "account-active.jsonl"), "utf8");
    expect(log).toContain("\"slot\":2");
  }, 45_000);

  it("says a running deck is needed for sessions and open, with its own exit code", async () => {
    for (const cmd of ["sessions", "open"]) {
      const { code, out } = await run([cmd, "--json"]);
      expect(code, cmd).toBe(3);
      expect(JSON.parse(out).error.code, cmd).toBe("no_deck");
    }
  }, 45_000);

  it("never switches beside a deck that is running and did not answer", async () => {
    // A deck whose process is alive and whose port answers nothing: slow at
    // boot, paused, on a loaded box. Its store lock is in its own process.
    const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore" });
    const probe = createServer();
    await new Promise<void>(done => probe.listen(0, "127.0.0.1", done));
    const { port } = probe.address() as AddressInfo;
    await new Promise(done => probe.close(done));
    mkdirSync(REGISTRY, { recursive: true });
    writeFileSync(join(REGISTRY, `${sleeper.pid}.json`), JSON.stringify({
      pid: sleeper.pid, parent: null, port, token: "tok", workspace: "", persist: null, codex: false, claude: true,
      version: "3.42.0", startedAt: new Date(Date.now() - 60_000).toISOString(),
    }));
    const calls = existsSync(STUB_LOG) ? readFileSync(STUB_LOG, "utf8") : "";
    try {
      const switched = await run(["switch", "2", "--json"]);
      expect(switched.code).toBe(1);
      expect(JSON.parse(switched.out).error.code).toBe("deck_not_answering");
      expect(existsSync(STUB_LOG) ? readFileSync(STUB_LOG, "utf8") : "").toBe(calls);
      // A read is safe beside it, and says whose silence it read around.
      const read = await run(["accounts"]);
      expect(read.code).toBe(0);
      expect(read.out).toContain(`the deck on ${port} did not answer`);
    } finally {
      sleeper.kill("SIGKILL");
      rmSync(REGISTRY, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("askDeck", () => {
  it("settles when a reply is cut off half way, rather than leaving the command hanging", async () => {
    const srv = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-length": "100" });
      res.write("{\"ok\":");
      setTimeout(() => res.socket?.destroy(), 20);
    });
    await new Promise<void>(done => srv.listen(0, "127.0.0.1", done));
    try {
      const { port } = srv.address() as AddressInfo;
      expect(await askDeck({ port, token: "t" }, { path: "/api/sessions", timeoutMs: 5000 }))
        .toMatchObject({ ok: false, body: null, reason: "cut_off" });
    } finally {
      await new Promise(done => srv.close(done));
    }
  });
});
