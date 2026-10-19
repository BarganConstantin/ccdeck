// What the terminal panel's five routes take and answer, with the panel on.
//
// The page names a session — an id, a provider, a folder — and never a pane.
// So every case here is about one of three things: a question that is not a
// session is refused with a sentence before anything is asked of tmux; a
// session is turned into a ticket bound to the pane the server resolved, and
// the pane, the socket and the tmux binary stay in the binding rather than in
// the answer; and a state that is not attachable comes back as a state to
// draw, not as an error.
//
// tmux, the target resolver and the session launcher are stand-ins passed
// through startServer's `terminal` option, the seam the product leaves at its
// defaults. terminal-target.test.ts and terminal-sessions.test.ts pin those
// modules; terminal-socket-tmux.test.ts runs the whole path on real tmux.
import { describe, it, expect, afterAll, beforeAll, beforeEach, vi } from "vitest";
import { mkdirSync, mkdtempSync } from "node:fs";
import { request, type Server } from "node:http";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
import { json, openWs } from "./ws-test-client";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-terminal-routes-"));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.CCDECK_HOME = join(DIR, "deck");
process.env.XDG_CONFIG_HOME = join(DIR, "config");
process.env.XDG_DATA_HOME = join(DIR, "data");
process.env.XDG_STATE_HOME = join(DIR, "state");
process.env.CLAUDE_SWAP_BACKUP = join(DIR, "claude-swap");
if (!resolve(process.env.CLAUDE_CONFIG_DIR).startsWith(resolve(DIR))) throw new Error("sandbox escaped");
const PROJECT = join(DIR, "project");
mkdirSync(PROJECT);

// @ts-expect-error — plain .mjs server module, no types
const mod = await import("../../server/index.mjs");
// @ts-expect-error — plain .mjs server module, no types
const routes = await import("../../server/terminal-routes.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { createTicketStore } = await import("../../server/terminal-socket.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { TerminalSessionError } = await import("../../server/terminal-sessions.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { describeTarget } = await import("../../server/terminal-target.mjs");

const SID = "0b9f3c1e-2d4a-4b6c-8e0f-1a2b3c4d5e6f";
const DECK_SOCKET = { name: "ccdeck-test-routes" };
const TMUX_OK = Object.freeze({ ok: true, path: "/secret/bin/tmux", version: [3, 6], raw: "tmux 3.6a" });

// The stand-ins, re-armed before every case.
let tmuxAnswer: any;
let target: any;
let resolved: any[];
let launches: any[];
let launchImpl: (o: any) => Promise<any>;
let listed: any[];
let killed: any[];
let killImpl: (o: any) => Promise<boolean>;
let labelled: any[];
let labelImpl: (o: any) => Promise<boolean>;
let claudeBin: string | null;
let controls: FakeControl[];
// ccdeck's own tmux (tmux-download.mjs): never fetched here, only asked for.
let downloadBlocked: string | null;
let downloads: number;
let downloadResult: Promise<any>;
let progress: any;
let recentFailure: { reason: string; at: number } | null;
let forgot: number;
let pruned: any[];
let clock: number;
let sized: string[];
let ttyAnswer: { cols: number; rows: number } | null;
const tickets = createTicketStore();

class FakeControl extends EventEmitter {
  opts: any;
  constructor(opts: any) { super(); this.opts = opts; }
  async seed() { return { bytes: Buffer.from("SEED"), cols: 90, rows: 25, cursor: [0, 0], alternate: false }; }
  async resize() { return { ok: true, lines: [] }; }
  async input() { return { ok: true, lines: [] }; }
  async paste() { return { ok: true, lines: [] }; }
  async close() {}
}

beforeEach(() => {
  tmuxAnswer = TMUX_OK;
  target = { kind: "A", socket: DECK_SOCKET, pane: "%12", name: "ccdeck-claude-0a1b2c3d" };
  resolved = [];
  launches = [];
  launchImpl = async (o) => ({ name: o.kind === "attach" ? "ccdeck-att-0b9f3c1e" : "ccdeck-claude-feedf00d", sessionId: o.sessionId || (o.agent === "claude" ? SID : ""), pane: "%40" });
  listed = [];
  killed = [];
  killImpl = async () => true;
  labelled = [];
  labelImpl = async () => true;
  claudeBin = "/opt/claude/bin/claude";
  controls = [];
  downloadBlocked = "not_published";
  downloads = 0;
  downloadResult = Promise.resolve({ ok: true, path: "/secret/data/tools/tmux/tmux-3.8-1/tmux" });
  progress = null;
  recentFailure = null;
  forgot = 0;
  pruned = [];
  clock = 1_000_000_000;
  sized = [];
  ttyAnswer = null;
  routes.resetPruneClock();
  routes.resetWrappers();
});

let server: Server;
let port = 0;
beforeAll(async () => {
  server = await mod.startServer({
    port: 0, persist: false, claude: false, codex: false,
    terminal: {
      enabled: () => true,
      deckSocket: DECK_SOCKET,
      tickets,
      findTmux: async () => tmuxAnswer,
      resolveTarget: async (q: any, deps: any) => { resolved.push({ q, deps }); return target; },
      launchSession: (o: any) => { launches.push(o); return launchImpl(o); },
      listDeckSessions: async () => listed,
      killDeckSession: (o: any) => { killed.push(o); return killImpl(o); },
      labelDeckSession: (o: any) => { labelled.push(o); return labelImpl(o); },
      claudeBin: () => claudeBin,
      ttySize: async (tty: string) => { sized.push(tty); return ttyAnswer; },
      openControl: (o: any) => { const c = new FakeControl(o); controls.push(c); return c; },
      downloadBlocked: () => downloadBlocked,
      downloadTmux: () => { downloads += 1; return downloadResult; },
      downloadProgress: () => progress,
      recentDownloadFailure: () => recentFailure,
      forgetTmux: () => { forgot += 1; },
      pruneDeadDeckSessions: async (o: any) => { pruned.push(o); return []; },
      now: () => clock,
    },
  });
  port = (server.address() as { port: number }).port;
}, 30_000);
afterAll(async () => {
  await new Promise(r => server.close(r));
  rmTempDir(DIR);
});

const page = () => ({ host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin" });

function ask(method: string, path: string, body?: unknown, headers: Record<string, string> = page()): Promise<{ status: number; body: any; raw: string }> {
  return new Promise((resolve_, reject) => {
    const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const req = request({
      host: "127.0.0.1", port, path, method,
      headers: { ...headers, ...(payload !== undefined ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) } : {}) },
    }, res => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", c => { raw += c; });
      res.on("end", () => {
        let parsed: any = null;
        try { parsed = JSON.parse(raw); } catch { /* not JSON */ }
        resolve_({ status: res.statusCode ?? 0, body: parsed, raw });
      });
    });
    req.on("error", reject);
    req.setTimeout(10_000, () => { req.destroy(); reject(new Error(`${method} ${path} timed out`)); });
    req.end(payload);
  });
}

const session = (extra: Record<string, unknown> = {}) => ({ sessionId: SID, provider: "claude", cwd: PROJECT, ...extra });

describe("GET /api/terminal/status", () => {
  it("says whether tmux works, and its version, but never where it is", async () => {
    const got = await ask("GET", "/api/terminal/status");
    expect(got.status).toBe(200);
    expect(got.body).toEqual({ ok: true, platform: process.platform, tmux: { ok: true, version: "3.6" } });
    expect(got.raw).not.toContain("/secret");
    expect(got.raw, "nor tmux's own -V text").not.toContain("3.6a");
  });

  it("says why not, with the line that installs it", async () => {
    tmuxAnswer = { ok: false, reason: "missing", install: "sudo apt install tmux" };
    expect((await ask("GET", "/api/terminal/status")).body.tmux).toEqual({ ok: false, reason: "missing", install: "sudo apt install tmux" });
    tmuxAnswer = { ok: false, reason: "too-old", path: "/secret/old/tmux", version: [3, 1], raw: "tmux 3.1c", install: "brew install tmux" };
    const old = await ask("GET", "/api/terminal/status");
    expect(old.body.tmux).toEqual({ ok: false, version: "3.1", reason: "too-old", install: "brew install tmux" });
    expect(old.raw).not.toContain("/secret");
  });

  it("is a guarded read", async () => {
    expect((await ask("GET", "/api/terminal/status", undefined, { host: `127.0.0.1:${port}` })).status).toBe(401);
  });

  it("starts fetching ccdeck's own tmux when there is none, says so at once, and forgets the miss when it lands", async () => {
    downloadBlocked = null;
    let land!: (r: unknown) => void;
    downloadResult = new Promise(r => { land = r; });
    for (const answer of [
      { ok: false, reason: "missing", install: "sudo apt install tmux" },
      { ok: false, reason: "too-old", path: "/secret/old/tmux", version: [3, 1], raw: "tmux 3.1c", install: "brew install tmux" },
    ]) {
      tmuxAnswer = answer;
      const got = await ask("GET", "/api/terminal/status");
      expect(got.body.tmux, "answered before the download finishes").toEqual({ ok: false, reason: "installing" });
      expect(got.raw).not.toContain("/secret");
    }
    expect(downloads).toBe(2);
    expect(forgot, "nothing landed yet").toBe(0);
    land({ ok: true, path: "/secret/data/tools/tmux/tmux-3.8-1/tmux" });
    await new Promise(r => setTimeout(r, 10));
    expect(forgot, "the remembered miss goes, so the next ask finds the new tmux").toBe(2);
  });

  it("says how far the download has got, once it has said, for the stage's bar", async () => {
    downloadBlocked = null;
    downloadResult = new Promise(() => {});
    tmuxAnswer = { ok: false, reason: "missing", install: "sudo apt install tmux" };
    progress = { stage: "downloading", received: 420_000, total: 1_100_000 };
    expect((await ask("GET", "/api/terminal/status")).body.tmux)
      .toEqual({ ok: false, reason: "installing", progress: { stage: "downloading", received: 420_000, total: 1_100_000 } });
    progress = { stage: "checking" };
    expect((await ask("GET", "/api/terminal/status")).body.tmux.progress).toEqual({ stage: "checking" });
  });

  it("answers a recent failed download as the plain fact, with why, and does not try again yet", async () => {
    downloadBlocked = null;
    recentFailure = { reason: "download_failed", at: Date.now() };
    tmuxAnswer = { ok: false, reason: "missing", install: "sudo apt install tmux" };
    expect((await ask("GET", "/api/terminal/status")).body.tmux)
      .toEqual({ ok: false, reason: "missing", install: "sudo apt install tmux", download: "download_failed" });
    expect(downloads).toBe(0);
  });

  it("fetches nothing where the download is switched off, or for a tmux that works, or on Windows", async () => {
    tmuxAnswer = { ok: false, reason: "missing", install: "sudo apt install tmux" };
    downloadBlocked = "install_disabled";
    expect((await ask("GET", "/api/terminal/status")).body.tmux.reason).toBe("missing");
    downloadBlocked = null;
    tmuxAnswer = TMUX_OK;
    expect((await ask("GET", "/api/terminal/status")).body.tmux.ok).toBe(true);
    tmuxAnswer = { ok: false, reason: "unsupported-platform" };
    expect((await ask("GET", "/api/terminal/status")).body.tmux.reason).toBe("unsupported-platform");
    expect(downloads).toBe(0);
  });
});

describe("GET /api/terminal/target", () => {
  const path = (q: Record<string, string>) => `/api/terminal/target?${new URLSearchParams(q)}`;

  it("refuses a question that is not a session before asking anything", async () => {
    for (const q of [
      { provider: "claude", cwd: PROJECT },
      { session: "--dangerously-skip-permissions", provider: "claude", cwd: PROJECT },
      { session: "../../etc/passwd", provider: "claude" },
      { session: SID, provider: "gemini", cwd: PROJECT },
      { session: SID },
    ]) {
      const got = await ask("GET", path(q));
      expect(got.status, JSON.stringify(q)).toBe(400);
      expect(got.body.ok).toBe(false);
      expect(typeof got.body.error).toBe("string");
    }
    expect(resolved, "nothing was resolved for a malformed question").toEqual([]);
  });

  it("answers describeTarget's sentence for each kind, and nothing else of the target", async () => {
    for (const t of [
      { kind: "A", socket: DECK_SOCKET, pane: "%12", name: "ccdeck-claude-0a1b2c3d" },
      { kind: "B", socket: { path: "/tmp/tmux-1000/default" }, pane: "%3" },
      { kind: "C", adoptable: true, pid: 4242 },
      { kind: "gone", adoptable: false },
      { kind: "unsupported", reason: "missing", install: "sudo apt install tmux" },
    ]) {
      target = t;
      const got = await ask("GET", path({ session: SID.toUpperCase(), provider: "claude", cwd: PROJECT }));
      expect(got.status).toBe(200);
      expect(got.body).toEqual({ ok: true, target: describeTarget(t) });
      for (const secret of ["%12", "%3", "/tmp/tmux-1000", "4242", "ccdeck-claude-0a1b2c3d"]) expect(got.raw, `${t.kind}: ${secret}`).not.toContain(secret);
    }
  });

  it("is a read: it labels nothing, even for a pane whose id it has just learned", async () => {
    target = { kind: "A", socket: DECK_SOCKET, pane: "%9", name: "ccdeck-codex-5e6f7a8b", learnedId: SID };
    const got = await ask("GET", path({ session: SID, provider: "codex", cwd: PROJECT }));
    expect(got.body).toEqual({ ok: true, target: describeTarget({ kind: "A" }) });
    expect(labelled).toEqual([]);
  });

  it("asks about the session in lower case, on the deck's own socket", async () => {
    await ask("GET", path({ session: SID.toUpperCase(), provider: "codex", cwd: PROJECT }));
    const { q, deps } = resolved.at(-1);
    expect(q).toEqual({ ok: true, sessionId: SID, provider: "codex", cwd: PROJECT });
    expect(deps.deckSocket).toEqual(DECK_SOCKET);
    expect(deps.tmux).toBe(TMUX_OK);
  });
});

describe("POST /api/terminal/claim", () => {
  // A Codex picks its own id once it starts, so the launch route cannot name
  // it: the page asks this of each Codex that turns up while the stage shows
  // the launch (codex-launch.ts).
  const claim = (extra: Record<string, unknown> = {}) => ask("POST", "/api/terminal/claim", session({ provider: "codex", key: "launch-k1", ...extra }));

  it("says yes for the pane the launch started, labels it with the session's id once, and never says which pane", async () => {
    target = { kind: "A", socket: DECK_SOCKET, pane: "%9", name: "ccdeck-codex-5e6f7a8b", learnedId: SID, launchKey: "launch-k1" };
    const yes = await claim();
    expect(yes.status).toBe(200);
    expect(yes.body).toEqual({ ok: true, claimed: true, target: describeTarget({ kind: "A" }) });
    for (const secret of ["%9", "ccdeck-codex-5e6f7a8b", "launch-k1"]) expect(yes.raw, secret).not.toContain(secret);
    // The label is what lets the next launch in this folder be recognised: an
    // unlabelled pane is one more the next Codex could have begun in.
    expect(labelled).toHaveLength(1);
    expect(labelled[0]).toMatchObject({ tmux: TMUX_OK, name: "ccdeck-codex-5e6f7a8b", sessionId: SID, socket: DECK_SOCKET });
  });

  it("says yes without labelling a pane that already names its session", async () => {
    target = { kind: "A", socket: DECK_SOCKET, pane: "%9", name: "ccdeck-codex-5e6f7a8b", launchKey: "launch-k1" };
    expect((await claim()).body.claimed).toBe(true);
    expect(labelled).toEqual([]);
  });

  it("says no, and labels nothing, for any pane but the one the launch started", async () => {
    for (const t of [
      { kind: "A", socket: DECK_SOCKET, pane: "%9", name: "ccdeck-codex-5e6f7a8b", learnedId: SID, launchKey: "launch-k2" },
      { kind: "A", socket: DECK_SOCKET, pane: "%9", name: "ccdeck-codex-5e6f7a8b", learnedId: SID },
      { kind: "B", socket: { path: "/tmp/tmux-1000/default" }, pane: "%3", launchKey: "launch-k1" },
      { kind: "C", adoptable: true, pid: 4242 },
    ]) {
      target = t;
      const got = await claim();
      expect(got.body, JSON.stringify(t)).toEqual({ ok: true, claimed: false, target: describeTarget(t) });
    }
    expect(labelled).toEqual([]);
  });

  it("says yes when the label cannot be written: a missed label costs a process walk, not the session", async () => {
    target = { kind: "A", socket: DECK_SOCKET, pane: "%9", name: "ccdeck-codex-5e6f7a8b", learnedId: SID, launchKey: "launch-k1" };
    labelImpl = async () => { throw new TerminalSessionError("tmux-failed", "tmux could not label the session.", "lost server"); };
    const got = await claim();
    expect(got.status).toBe(200);
    expect(got.body.claimed).toBe(true);
  });

  it("refuses a key it could not have given, or no session at all, before asking anything", async () => {
    for (const key of ["", "a b", "x".repeat(97), "../k", 7, null]) {
      const got = await claim({ key });
      expect(got.status, JSON.stringify(key)).toBe(400);
    }
    expect((await claim({ sessionId: "not-an-id" })).status).toBe(400);
    expect(resolved).toEqual([]);
    expect(labelled).toEqual([]);
  });
});

describe("POST /api/terminal/open", () => {
  const opened = async (body: unknown = session()) => {
    const got = await ask("POST", "/api/terminal/open", body);
    return { ...got, binding: got.body?.ticket ? tickets.redeem(got.body.ticket) : null };
  };

  it("answers a deck pane with a ticket bound to it, and the page sees only the sentence", async () => {
    const got = await opened();
    expect(got.status).toBe(200);
    expect(got.body.ok).toBe(true);
    expect(got.body.target).toEqual(describeTarget(target));
    expect(got.binding).toEqual({
      kind: "A", socket: DECK_SOCKET, target: "ccdeck-claude-0a1b2c3d", pane: "%12", ignoreSize: false,
      tmux: "/secret/bin/tmux", origin: `http://127.0.0.1:${port}`,
    });
    for (const secret of ["%12", "/secret", "ccdeck-claude-0a1b2c3d", "ccdeck-test-routes"]) expect(got.raw).not.toContain(secret);
  });

  it("writes the id a deck-launched Codex was recognised by into its pane's label, once, and the page sees nothing of it", async () => {
    target = { kind: "A", socket: DECK_SOCKET, pane: "%9", name: "ccdeck-codex-5e6f7a8b", learnedId: SID };
    const got = await opened(session({ provider: "codex" }));
    expect(got.body.ok).toBe(true);
    expect(labelled).toHaveLength(1);
    expect(labelled[0]).toMatchObject({ tmux: TMUX_OK, name: "ccdeck-codex-5e6f7a8b", sessionId: SID, socket: DECK_SOCKET });
    expect(got.body.target).toEqual(describeTarget({ kind: "A" }));
    expect(got.binding).toMatchObject({ kind: "A", target: "ccdeck-codex-5e6f7a8b", pane: "%9" });
  });

  it("labels nothing for a pane that already says which session it holds", async () => {
    await opened();
    expect(labelled).toEqual([]);
  });

  it("attaches anyway when the label cannot be written", async () => {
    target = { kind: "A", socket: DECK_SOCKET, pane: "%9", name: "ccdeck-codex-5e6f7a8b", learnedId: SID };
    labelImpl = async () => { throw new TerminalSessionError("tmux-failed", "tmux could not label the session.", "lost server"); };
    const got = await opened(session({ provider: "codex" }));
    expect(got.status).toBe(200);
    expect(got.body.ok).toBe(true);
    expect(got.binding).toMatchObject({ pane: "%9" });
  });

  it("joins a pane in the user's own tmux at the pane's size", async () => {
    target = { kind: "B", socket: { path: "/tmp/tmux-1000/default" }, pane: "%3" };
    const got = await opened();
    expect(got.binding).toMatchObject({ kind: "B", socket: { path: "/tmp/tmux-1000/default" }, target: "%3", pane: "%3", ignoreSize: true });
  });

  it("answers what cannot be attached to as a state, with HTTP 200", async () => {
    for (const t of [{ kind: "C", adoptable: true, pid: 9 }, { kind: "gone", adoptable: true }, { kind: "unsupported", reason: "too-old" }]) {
      target = t;
      const got = await opened();
      expect(got.status, t.kind).toBe(200);
      expect(got.body).toEqual({ ok: false, target: describeTarget(t) });
    }
    expect(launches).toEqual([]);
  });

  it("shows an ended session's last frame from the newest dead deck pane it left, read-only and at that pane's size", async () => {
    target = { kind: "gone", adoptable: true, deadSessions: ["ccdeck-claude-00000001", "ccdeck-claude-00000002"] };
    const got = await opened();
    expect(got.status).toBe(200);
    expect(got.body.ok).toBe(true);
    expect(got.body.target).toEqual(describeTarget(target));
    expect(got.binding).toMatchObject({ kind: "A", socket: DECK_SOCKET, target: "ccdeck-claude-00000002", ignoreSize: true, readOnly: true });
    // Showing it starts nothing and clears nothing: Reopen here is the adopt route's.
    expect(launches).toEqual([]);
    expect(killed).toEqual([]);
    expect(got.raw).not.toContain("ccdeck-claude-00000002");
  });

  it("reaches a background session through its live attach wrapper, starting nothing, at the size it has", async () => {
    // Every view of a background session shares one pty, which takes the size
    // of the latest attach: a panel that sized it drew the user's own
    // `claude agents` view for the stage's width.
    target = { kind: "D", attachId: "b02a39b7", wrapper: { name: "ccdeck-att-0b9f3c1e", pane: "%21" } };
    const got = await opened();
    expect(got.binding).toMatchObject({ kind: "D", socket: DECK_SOCKET, target: "ccdeck-att-0b9f3c1e", pane: "%21", ignoreSize: true });
    expect(launches).toEqual([]);
  });

  it("starts a new wrapper at the background session's own size, read off its terminal", async () => {
    target = { kind: "D", attachId: "b02a39b7", tty: "/dev/pts/7" };
    ttyAnswer = { cols: 100, rows: 35 };
    const got = await opened();
    expect(sized).toEqual(["/dev/pts/7"]);
    expect(launches[0]).toMatchObject({ cols: 100, rows: 35 });
    expect(got.raw, "the terminal is the deck's to know").not.toContain("/dev/pts/7");
    // Unread, or with no terminal to read: tmux's default, as before.
    launches = [];
    ttyAnswer = null;
    await opened();
    expect(launches[0]).not.toHaveProperty("cols");
    launches = []; sized = [];
    target = { kind: "D", attachId: "b02a39b7" };
    await opened();
    expect(sized).toEqual([]);
    expect(launches[0]).not.toHaveProperty("cols");
  });

  it("starts `claude attach <short id>` in a deck pane when there is no wrapper yet", async () => {
    target = { kind: "D", attachId: "b02a39b7" };
    const got = await opened();
    expect(launches).toHaveLength(1);
    expect(launches[0]).toMatchObject({
      agent: "claude", kind: "attach", sessionId: SID, cwd: PROJECT, socket: DECK_SOCKET,
      argv: ["/opt/claude/bin/claude", "attach", "b02a39b7"],
    });
    expect(got.binding).toMatchObject({ kind: "D", target: "ccdeck-att-0b9f3c1e", pane: "%40" });
  });

  it("never hands claude attach something that reads as a flag", async () => {
    target = { kind: "D", attachId: "--dangerously-skip-permissions" };
    await opened();
    expect(launches[0].argv).toEqual(["/opt/claude/bin/claude", "attach", SID.slice(0, 8)]);
  });

  it("starts the wrapper in the home folder when the session's own is gone", async () => {
    target = { kind: "D", attachId: "b02a39b7" };
    await opened(session({ cwd: join(DIR, "no-such-folder") }));
    expect(launches[0].cwd).toBe(DIR);
  });

  it("reuses a wrapper that appeared under the same name, and replaces a dead one", async () => {
    target = { kind: "D", attachId: "b02a39b7" };
    let first = true;
    launchImpl = async (o) => {
      if (first) { first = false; throw new TerminalSessionError("exists", "The deck is already attached to that session."); }
      return { name: "ccdeck-att-0b9f3c1e", sessionId: o.sessionId, pane: "%41" };
    };
    listed = [{ name: "ccdeck-att-0b9f3c1e", sessionId: SID, kind: "attach", pane: "%30", dead: false, created: 1 }];
    const live = await opened();
    expect(live.binding).toMatchObject({ target: "ccdeck-att-0b9f3c1e", pane: "%30" });
    expect(killed).toEqual([]);

    first = true;
    launches = [];
    listed = [{ name: "ccdeck-att-0b9f3c1e", sessionId: SID, kind: "attach", pane: "%30", dead: true, created: 1 }];
    const dead = await opened();
    expect(killed.map(k => k.name)).toEqual(["ccdeck-att-0b9f3c1e"]);
    expect(killed[0].socket).toEqual(DECK_SOCKET);
    expect(launches, "tried, collided, and started again after the dead one went").toHaveLength(2);
    expect(dead.binding).toMatchObject({ pane: "%41" });
  });

  it("says Claude is missing rather than failing when there is no claude to attach with", async () => {
    target = { kind: "D", attachId: "b02a39b7" };
    claudeBin = null;
    const got = await opened();
    expect(got.status).toBe(409);
    expect(got.body).toEqual({ ok: false, error: "Claude Code is not installed on this machine.", code: "agent-missing" });
  });

  it("refuses a body that does not name a session", async () => {
    for (const body of ["not json", "[1,2]", "null", JSON.stringify(session({ sessionId: "nope" })), JSON.stringify(session({ provider: "x" }))]) {
      const got = await ask("POST", "/api/terminal/open", body);
      expect(got.status, body).toBe(400);
      expect(got.body.ok).toBe(false);
      expect(typeof got.body.error).toBe("string");
    }
    expect(resolved).toEqual([]);
  });

  it("refuses a body too large to be a session with 413", async () => {
    const got = await ask("POST", "/api/terminal/open", JSON.stringify({ ...session(), pad: "x".repeat(20_000) }));
    expect(got.status).toBe(413);
  });

  it("is a mutation: refused to a caller that presents nothing", async () => {
    expect((await ask("POST", "/api/terminal/open", session(), { host: `127.0.0.1:${port}` })).status).toBe(401);
  });

  it("mints a ticket the socket accepts, and the socket speaks the protocol on the pane it was bound to", async () => {
    const got = await ask("POST", "/api/terminal/open", session());
    const c = await openWs({
      port, path: `/api/terminal/attach?ticket=${got.body.ticket}`,
      headers: { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, "Sec-Fetch-Site": "same-origin" },
    });
    expect(c.status).toBe(101);
    expect(json(await c.next())).toEqual({ t: "hello", kind: "A", sizeOwner: "dock", readOnly: false });
    expect(controls.at(-1)!.opts).toMatchObject({ tmux: "/secret/bin/tmux", socket: DECK_SOCKET, target: "ccdeck-claude-0a1b2c3d", pane: "%12" });
    c.sendText(JSON.stringify({ t: "size", cols: 90, rows: 25 }));
    expect(json(await c.next())).toEqual({ t: "reset", cols: 90, rows: 25 });
    expect((await c.next()).data.toString()).toBe("SEED");
    c.sendClose();
    await c.closed;
  });
});

describe("POST /api/terminal/adopt", () => {
  it("reopens an ended session here with --resume, and hands back a ticket for it", async () => {
    target = { kind: "gone", adoptable: true };
    const got = await ask("POST", "/api/terminal/adopt", session());
    expect(got.status).toBe(200);
    expect(launches).toHaveLength(1);
    expect(launches[0]).toMatchObject({ agent: "claude", kind: "resume", sessionId: SID, cwd: PROJECT, socket: DECK_SOCKET });
    expect(launches[0].argv, "the agent's own command line, not one the page chose").toBeUndefined();
    expect(got.body.ok).toBe(true);
    expect(got.body.target).toEqual(describeTarget({ kind: "A" }));
    expect(tickets.redeem(got.body.ticket)).toMatchObject({ kind: "A", target: "ccdeck-claude-feedf00d", pane: "%40", socket: DECK_SOCKET });
  });

  it("closes the dead deck panes the session left behind before it starts the resume", async () => {
    target = { kind: "gone", adoptable: true, deadSessions: ["ccdeck-claude-00000001", "ccdeck-att-0b9f3c1e"] };
    const order: string[] = [];
    killImpl = async (o) => { order.push(`kill ${o.name}`); return true; };
    const launch = launchImpl;
    launchImpl = async (o) => { order.push("launch"); return launch(o); };
    const got = await ask("POST", "/api/terminal/adopt", session());
    expect(got.status).toBe(200);
    expect(order).toEqual(["kill ccdeck-claude-00000001", "kill ccdeck-att-0b9f3c1e", "launch"]);
    for (const k of killed) expect(k).toMatchObject({ tmux: TMUX_OK, socket: DECK_SOCKET });
    expect(got.raw, "the names stay on the server").not.toContain("ccdeck-claude-00000001");
  });

  it("reopens the session even when a dead pane will not close", async () => {
    target = { kind: "gone", adoptable: true, deadSessions: ["ccdeck-claude-00000001", "ccdeck-claude-00000002"] };
    killImpl = async (o) => {
      if (o.name === "ccdeck-claude-00000001") throw new TerminalSessionError("tmux-failed", "tmux could not close the session.", "lost server");
      return true;
    };
    const got = await ask("POST", "/api/terminal/adopt", session());
    expect(got.status).toBe(200);
    expect(killed.map(k => k.name), "and still tries the rest").toEqual(["ccdeck-claude-00000001", "ccdeck-claude-00000002"]);
    expect(launches).toHaveLength(1);
  });

  it("closes nothing when the session is not one it reopens", async () => {
    for (const t of [{ kind: "C", adoptable: true, pid: 1 }, { kind: "gone", adoptable: false, deadSessions: ["ccdeck-claude-00000001"] }]) {
      target = t;
      await ask("POST", "/api/terminal/adopt", session());
    }
    expect(killed).toEqual([]);
  });

  it("resumes Codex as Codex", async () => {
    target = { kind: "gone", adoptable: true };
    await ask("POST", "/api/terminal/adopt", session({ provider: "codex" }));
    expect(launches[0]).toMatchObject({ agent: "codex", kind: "resume", sessionId: SID });
  });

  it("refuses with still-running while any process holds the session", async () => {
    for (const t of [
      { kind: "C", adoptable: true, pid: 1 },
      { kind: "A", socket: DECK_SOCKET, pane: "%1", name: "ccdeck-claude-00000000" },
      { kind: "B", socket: { path: "/x" }, pane: "%1" },
      { kind: "D", attachId: "b02a39b7" },
    ]) {
      target = t;
      const got = await ask("POST", "/api/terminal/adopt", session());
      expect(got.status, t.kind).toBe(409);
      expect(got.body).toEqual({ ok: false, error: "still-running" });
    }
    expect(launches).toEqual([]);
    expect(routes.STILL_RUNNING).toBe("still-running");
  });

  it("says why it cannot when the folder is gone or tmux is missing", async () => {
    target = { kind: "gone", adoptable: false };
    const gone = await ask("POST", "/api/terminal/adopt", session());
    expect(gone.status).toBe(409);
    expect(gone.body.error).toBe(describeTarget(target).label);
    target = { kind: "unsupported", reason: "missing", install: "sudo apt install tmux" };
    const missing = await ask("POST", "/api/terminal/adopt", session());
    expect(missing.body).toEqual({ ok: false, error: describeTarget(target).label, install: "sudo apt install tmux" });
    expect(launches).toEqual([]);
  });

  it("needs the folder to reopen in", async () => {
    const got = await ask("POST", "/api/terminal/adopt", session({ cwd: "relative/path" }));
    expect(got.status).toBe(400);
    expect(resolved).toEqual([]);
  });

  it("starts one agent for a double click, not two", async () => {
    target = { kind: "gone", adoptable: true };
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    launchImpl = async (o) => { await gate; return { name: "ccdeck-claude-feedf00d", sessionId: o.sessionId, pane: "%40" }; };
    const first = ask("POST", "/api/terminal/adopt", session());
    await new Promise(r => setTimeout(r, 50));
    const second = await ask("POST", "/api/terminal/adopt", session());
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("This session is already being reopened.");
    release();
    expect((await first).status).toBe(200);
    expect(launches).toHaveLength(1);
    // And once the first is done, the session can be asked about again.
    target = { kind: "A", socket: DECK_SOCKET, pane: "%40", name: "ccdeck-claude-feedf00d" };
    expect((await ask("POST", "/api/terminal/adopt", session())).body.error).toBe("still-running");
  });
});

describe("POST /api/terminal/launch", () => {
  it("starts an agent in a deck-owned session and answers its id, its name and a ticket", async () => {
    const got = await ask("POST", "/api/terminal/launch", { agent: "claude", cwd: PROJECT });
    expect(got.status).toBe(200);
    expect(got.body).toEqual({ ok: true, sessionId: SID, name: "ccdeck-claude-feedf00d", ticket: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    expect(launches[0]).toMatchObject({ agent: "claude", cwd: PROJECT, socket: DECK_SOCKET, tmux: TMUX_OK });
    expect(launches[0].argv).toBeUndefined();
    expect(launches[0].kind ?? "launch").toBe("launch");
    expect(tickets.redeem(got.body.ticket)).toMatchObject({ kind: "A", target: "ccdeck-claude-feedf00d", pane: "%40", ignoreSize: false });
  });

  it("answers Codex with no id yet", async () => {
    const got = await ask("POST", "/api/terminal/launch", { agent: "codex", cwd: PROJECT });
    expect(got.body.sessionId).toBe("");
  });

  it("starts a launch asked again by its key once: the second ask reaches the agent the first started", async () => {
    // The deck restarted under a launch, so its answer never reached the
    // page, and Try again asked again: a second Codex in the same folder.
    const first = await ask("POST", "/api/terminal/launch", { agent: "codex", cwd: PROJECT, key: "launch-mgx1-1-k2v9q0" });
    expect(first.status).toBe(200);
    expect(launches[0].launchKey, "kept on the session it starts").toBe("launch-mgx1-1-k2v9q0");
    listed = [
      { name: "ccdeck-codex-0d0d0d0d", sessionId: "", kind: "launch", launchKey: "", pane: "%39", dead: false, created: 1 },
      { name: "ccdeck-claude-feedf00d", sessionId: "", kind: "launch", launchKey: "launch-mgx1-1-k2v9q0", pane: "%40", dead: false, created: 2 },
    ];
    const again = await ask("POST", "/api/terminal/launch", { agent: "codex", cwd: PROJECT, key: "launch-mgx1-1-k2v9q0" });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ ok: true, sessionId: "", name: "ccdeck-claude-feedf00d" });
    expect(launches, "nothing started the second time").toHaveLength(1);
    expect(again.body.ticket, "a ticket of its own").not.toBe(first.body.ticket);
    expect(tickets.redeem(again.body.ticket)).toMatchObject({ kind: "A", target: "ccdeck-claude-feedf00d", pane: "%40" });

    const other = await ask("POST", "/api/terminal/launch", { agent: "codex", cwd: PROJECT, key: "launch-mgx1-2-p4r7s1" });
    expect(other.status).toBe(200);
    expect(launches, "another key is another launch").toHaveLength(2);
    await ask("POST", "/api/terminal/launch", { agent: "codex", cwd: PROJECT });
    expect(launches, "and no key, every launch new").toHaveLength(3);
    expect(launches[2].launchKey).toBeUndefined();
  });

  it("starts one agent for a launch asked again while the first ask is still on its way", async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    launchImpl = async () => { await gate; return { name: "ccdeck-codex-feedf00d", sessionId: "", pane: "%41" }; };
    const body = { agent: "codex", cwd: PROJECT, key: "launch-mgx1-3-a1b2c3" };
    const first = ask("POST", "/api/terminal/launch", body);
    await new Promise(r => setTimeout(r, 50));
    const second = ask("POST", "/api/terminal/launch", body);
    await new Promise(r => setTimeout(r, 50));
    release();
    const [a, b] = await Promise.all([first, second]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(b.body.name).toBe(a.body.name);
    expect(launches).toHaveLength(1);

    // A launch that failed is not kept: asked again, it is tried again.
    launchImpl = async () => { throw new TerminalSessionError("agent-missing", "Codex is not installed on this machine."); };
    expect((await ask("POST", "/api/terminal/launch", { ...body, key: "launch-mgx1-4-d4e5f6" })).status).toBe(409);
    launchImpl = async () => ({ name: "ccdeck-codex-0a0a0a0a", sessionId: "", pane: "%42" });
    expect((await ask("POST", "/api/terminal/launch", { ...body, key: "launch-mgx1-4-d4e5f6" })).body.name).toBe("ccdeck-codex-0a0a0a0a");
  });

  it("refuses a key it could not keep on a session, before starting anything", async () => {
    for (const key of ["", "a b", "a;kill-server", "#{pane_id}", 7, null]) {
      const got = await ask("POST", "/api/terminal/launch", { agent: "codex", cwd: PROJECT, key });
      expect(got.status, String(key)).toBe(400);
      expect(got.body.error).toBe("The launch's key is not one the deck can keep.");
    }
    expect(launches).toEqual([]);
  });

  it("refuses an agent it does not start, and a folder that is not one, with a sentence and no path", async () => {
    const agent = await ask("POST", "/api/terminal/launch", { agent: "bash", cwd: PROJECT });
    expect(agent.status).toBe(400);
    expect(agent.body.error).toBe("The deck can start Claude or Codex sessions only.");
    for (const cwd of ["relative", join(DIR, "nope"), "", 7]) {
      const got = await ask("POST", "/api/terminal/launch", { agent: "claude", cwd });
      expect(got.status, String(cwd)).toBe(400);
      expect(got.body.code).toBe("bad-cwd");
      expect(got.raw, "the folder is not echoed back").not.toContain(DIR);
    }
    expect(launches).toEqual([]);
  });

  it("says tmux is missing as a fact, with the line that installs it", async () => {
    tmuxAnswer = { ok: false, reason: "missing", install: "sudo dnf install tmux" };
    const got = await ask("POST", "/api/terminal/launch", { agent: "claude", cwd: PROJECT });
    expect(got.status).toBe(409);
    expect(got.body).toEqual({ ok: false, error: "The terminal runs on tmux, which is not installed on this machine.", install: "sudo dnf install tmux" });
  });

  it("answers tmux's failure with the sentence, and keeps tmux's own words in the deck", async () => {
    launchImpl = async () => { throw new TerminalSessionError("tmux-failed", "tmux could not start the session.", "error connecting to /tmp/tmux-1000/ccdeck"); };
    const errors: unknown[] = [];
    const was = console.error;
    console.error = (...a: unknown[]) => { errors.push(a.join(" ")); };
    try {
      const got = await ask("POST", "/api/terminal/launch", { agent: "claude", cwd: PROJECT });
      expect(got.status).toBe(500);
      expect(got.body).toEqual({ ok: false, error: "tmux could not start the session.", code: "tmux-failed" });
      expect(got.raw).not.toContain("/tmp/tmux-1000");
    } finally {
      console.error = was;
    }
    expect(String(errors[0])).toContain("/tmp/tmux-1000/ccdeck");
  });
});

describe("what a launch is started with", () => {
  it("starts the agent at the panel's size, so its first screen is not drawn twice", async () => {
    await ask("POST", "/api/terminal/launch", { agent: "claude", cwd: PROJECT, cols: 132, rows: 41 });
    expect(launches[0]).toMatchObject({ cols: 132, rows: 41 });
  });

  it("hands New session's options to the launcher, which is where they are checked", async () => {
    await ask("POST", "/api/terminal/launch", { agent: "claude", cwd: PROJECT, options: { model: "haiku", permissionMode: "plan", worktree: true } });
    expect(launches[0].options).toEqual({ model: "haiku", permissionMode: "plan", worktree: true });
    launchImpl = async () => { throw new TerminalSessionError("bad-options", "That is not a model the deck can start Claude with."); };
    const bad = await ask("POST", "/api/terminal/launch", { agent: "claude", cwd: PROJECT, options: { model: "gpt" } });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("bad-options");
  });

  it("hands the panel's colours to the launcher, for a launch and a reopen alike", async () => {
    const colours = { fg: "#1f2328", bg: "#fafaf8" };
    await ask("POST", "/api/terminal/launch", { agent: "codex", cwd: PROJECT, colours });
    expect(launches[0].colours).toEqual(colours);
    target = { kind: "gone", adoptable: true };
    await ask("POST", "/api/terminal/adopt", { ...session(), colours });
    expect(launches.at(-1)).toMatchObject({ kind: "resume", colours });
  });

  it("reopens at the panel's size too", async () => {
    target = { kind: "gone", adoptable: true };
    const got = await ask("POST", "/api/terminal/adopt", { ...session(), cols: 100, rows: 30 });
    expect(got.status).toBe(200);
    expect(launches.at(-1)).toMatchObject({ kind: "resume", cols: 100, rows: 30 });
  });

  it("names the tmux failures a person can fix, without a path", async () => {
    const was = console.error;
    console.error = () => {};
    try {
      launchImpl = async () => { throw new TerminalSessionError("tmux-failed", "tmux could not start the session.", "error creating /tmp/x/very/deep/ccdeck (File name too long)"); };
      const got = await ask("POST", "/api/terminal/launch", { agent: "claude", cwd: PROJECT });
      expect(got.body.hint).toMatch(/TMUX_TMPDIR/);
      expect(got.raw).not.toContain("/tmp/x");
    } finally {
      console.error = was;
    }
    expect(routes.tmuxFailureHint("server exited unexpectedly")).toBeNull();
    expect(routes.tmuxFailureHint("protocol version mismatch (client 8, server 7)")).toMatch(/Another version of tmux/);
  });
});

describe("clearing old dead sessions off the deck's server", () => {
  const settle = () => new Promise(r => setTimeout(r, 0));

  it("starts a prune from a status or a launch, at most once an hour, on the deck's socket", async () => {
    await ask("GET", "/api/terminal/status");
    await settle();
    expect(pruned).toHaveLength(1);
    expect(pruned[0]).toMatchObject({ tmux: TMUX_OK, socket: DECK_SOCKET });
    await ask("GET", "/api/terminal/status");
    await ask("POST", "/api/terminal/launch", { agent: "claude", cwd: PROJECT });
    await settle();
    expect(pruned, "not again within the hour").toHaveLength(1);
    clock += routes.PRUNE_EVERY_MS;
    await ask("POST", "/api/terminal/launch", { agent: "claude", cwd: PROJECT });
    await settle();
    expect(pruned, "a launch an hour later prunes").toHaveLength(2);
  });

  it("never prunes without a working tmux, and a prune that fails changes no answer", async () => {
    tmuxAnswer = { ok: false, reason: "missing", install: "sudo apt install tmux" };
    downloadBlocked = "install_disabled";
    await ask("GET", "/api/terminal/status");
    await settle();
    expect(pruned).toEqual([]);
  });
});

describe("tmuxStatus", () => {
  it("drops the path and the raw text, and keeps a warning", () => {
    expect(routes.tmuxStatus({ ok: true, path: "/x/tmux", version: null, raw: "tmux master", warning: "unknown-version" }))
      .toEqual({ ok: true, warning: "unknown-version" });
    expect(routes.tmuxStatus(undefined)).toEqual({ ok: false, reason: "missing" });
    expect(routes.tmuxStatus({ ok: false, reason: "unsupported-platform" })).toEqual({ ok: false, reason: "unsupported-platform" });
  });
});

describe("a background session's attach wrapper", () => {
  // terminalUpgradeOptions' bridge, on a fake connection and control: what is
  // pinned is when the wrapper is closed, not what the bridge says.
  const BINDING = { kind: "D", socket: DECK_SOCKET, target: "ccdeck-att-0b9f3c1e", pane: "%21", ignoreSize: true, tmux: "/secret/bin/tmux" };
  const conn = () => ({ sendText() {}, sendBinary() {}, close() {}, bufferedAmount: 0 });
  const options = () => routes.terminalUpgradeOptions({
    killDeckSession: async (o: any) => { killed.push(o); return true; },
    openControl: (o: any) => new FakeControl(o),
  });
  const show = (o: ReturnType<typeof options>, binding: object = BINDING) => o.openBridge({ conn: conn(), socket: {}, binding });

  it("is closed once the last panel on it has gone, after a grace, and the session with it is left running", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const o = options();
      const a = show(o), b = show(o);
      a.closed(1000, "");
      vi.advanceTimersByTime(routes.WRAPPER_GRACE_MS * 2);
      expect(killed, "another panel still shows it").toEqual([]);
      b.closed(1000, "");
      vi.advanceTimersByTime(routes.WRAPPER_GRACE_MS - 1);
      expect(killed).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(killed.map(k => [k.name, k.socket, k.tmux])).toEqual([["ccdeck-att-0b9f3c1e", DECK_SOCKET, "/secret/bin/tmux"]]);
      b.closed(1000, "");
      vi.advanceTimersByTime(routes.WRAPPER_GRACE_MS * 2);
      expect(killed, "a socket closed twice is one panel gone").toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is kept for a panel that opens again inside the grace, as a reopen does", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const o = options();
      show(o).closed(1000, "");
      vi.advanceTimersByTime(routes.WRAPPER_GRACE_MS / 2);
      const again = show(o);
      vi.advanceTimersByTime(routes.WRAPPER_GRACE_MS * 2);
      expect(killed).toEqual([]);
      again.closed(1000, "");
      vi.advanceTimersByTime(routes.WRAPPER_GRACE_MS);
      expect(killed).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes nothing for a pane the deck started or the user's own", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const o = options();
      show(o, { ...BINDING, kind: "A", target: "ccdeck-claude-0a1b2c3d", ignoreSize: false }).closed(1000, "");
      show(o, { ...BINDING, kind: "B", target: "%3", socket: { path: "/tmp/tmux-1000/default" } }).closed(1000, "");
      vi.advanceTimersByTime(60_000);
      expect(killed).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ttySize", () => {
  it("reads nothing that is not a terminal's path", async () => {
    for (const tty of ["", "pts/3", "/dev/pts/3; rm -rf /", "/dev/../etc/passwd x", null]) {
      expect(await routes.ttySize(tty as string), String(tty)).toBeNull();
    }
  });
});
