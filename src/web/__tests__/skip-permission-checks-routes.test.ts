// New session's Skip permission checks, at the deck's launch route: who may
// start a Claude that does not ask before it runs a tool, and the one flag
// that Claude is started with.
//
// The route (terminal-routes.mjs) runs on a server of its own, in front of
// the tests' JS backend (terminal-js-routes.mjs), whose launcher is the real
// launchSession with tmux stubbed: nothing is spawned and no agent runs —
// the command tmux would have been told to exec is read off the stubbed
// call. The same route then stands in front of an engine stand-in, for an
// engine from before the option, which refuses it as an option it does not
// know.
//
// What is pinned:
//   - the switch on: `--dangerously-skip-permissions` right after the new
//     Claude's session id, and nothing for it with the switch off, for a
//     launch after an opted-in one, or for Codex;
//   - the deck refuses it before the start is noted or anything is asked:
//     not a boolean, a Codex, a reopen, beside a permission mode (400), and
//     from anything but this computer's own page or a client holding the
//     deck's token (403) — a viewer on the LAN included;
//   - an engine that does not know the option is said plainly (409
//     `skip-permissions-unsupported`), and only for a launch that asked it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-skip-permissions-"));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.CCDECK_HOME = join(DIR, "deck");
process.env.XDG_CONFIG_HOME = join(DIR, "config");
process.env.XDG_DATA_HOME = join(DIR, "data");
process.env.XDG_STATE_HOME = join(DIR, "state");
if (!resolve(process.env.CLAUDE_CONFIG_DIR).startsWith(resolve(DIR))) throw new Error("sandbox escaped");
const PROJECT = join(DIR, "project");
mkdirSync(PROJECT);
// Stand-ins where the launcher looks for the agents. Never run: tmux is a
// stub, so nothing execs them.
const BIN = join(DIR, "bin");
mkdirSync(BIN);
const CLAUDE = join(BIN, "claude");
const CODEX = join(BIN, "codex");
for (const f of [CLAUDE, CODEX]) writeFileSync(f, "#!/bin/sh\nexit 99\n", { mode: 0o755 });

// @ts-expect-error — plain .mjs server module, no types
const routes = await import("../../server/terminal-routes.mjs");
// @ts-expect-error — plain .mjs server module, no types
const js = await import("../../server/terminal-js-routes.mjs");
// @ts-expect-error — plain .mjs server module, no types
const sessions = await import("../../server/terminal-sessions.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { createTicketStore } = await import("../../server/terminal-socket.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { HOOK_TOKEN } = await import("../../server/request-gates.mjs");

const SID = "0b9f3c1e-2d4a-4b6c-8e0f-1a2b3c4d5e6f";
const FLAG = "--dangerously-skip-permissions";
const TMUX = Object.freeze({ ok: true, path: "/fake/bin/tmux", version: [3, 6], raw: "tmux 3.6a" });

/** Every tmux call the launcher made, by its arguments. */
let ran: string[][];
/** What the stubbed tmux answers: a pane, as new-session prints it. */
const run = vi.fn(async (_bin: string, _socket: unknown, args: string[]) => {
  ran.push(args);
  return { ok: true, code: 0, stdout: "%7\n", stderr: "" };
});
/** The command the one new-session would have exec'd: everything after its `--`. */
const execd = () => {
  expect(ran, "one tmux call per launch").toHaveLength(1);
  const args = ran[0];
  const from = args.indexOf("--") + 1;
  const to = args.indexOf(";", from);
  return args.slice(from, to < 0 ? undefined : to);
};

/** The deck's routes in front of the JS backend, with the real launcher on a
 *  stubbed tmux. */
const jsDeck = () => ({
  enabled: () => true,
  jsBackend: js.jsTerminalBackend,
  tickets: createTicketStore(),
  findTmux: async () => TMUX,
  listDeckSessions: async () => [],
  pruneDeadDeckSessions: async () => [],
  launchSession: (o: Record<string, unknown>) => sessions.launchSession({
    ...o, run, scope: async () => null, env: { PATH: BIN, AGENTS_DECK_CLAUDE: CLAUDE },
  }),
});

let options: Record<string, unknown> = {};
let server: Server;
let port = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/api/terminal/adopt") void routes.handleTerminalAdopt(req, res, options);
    else void routes.handleTerminalLaunch(req, res, options);
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
});
afterAll(async () => {
  await new Promise(r => server.close(r));
  rmTempDir(DIR);
});
beforeEach(() => {
  ran = [];
  run.mockClear();
  options = jsDeck();
});

/** The headers the deck's own page sends with a POST. */
const page = () => ({ host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin" });

function post(body: unknown, { path = "/api/terminal/launch", headers = page() }: { path?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve_, reject) => {
    const payload = JSON.stringify(body);
    const req = request({
      host: "127.0.0.1", port, path, method: "POST",
      headers: { ...headers, "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) },
    }, res => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", c => { raw += c; });
      res.on("end", () => resolve_({ status: res.statusCode ?? 0, body: JSON.parse(raw) }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

/** The same POST, handed to the route from a socket whose peer is
 *  `remoteAddress`: a request that reached the handler from another machine,
 *  which the deck's own listener (127.0.0.1) never takes. */
async function postFrom(remoteAddress: string, body: unknown, headers: Record<string, string> = page()) {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { headers, socket: { remoteAddress }, method: "POST", url: "/api/terminal/launch" });
  let status = 0;
  let raw = "";
  const res = {
    headersSent: false,
    writeHead(s: number) { status = s; this.headersSent = true; },
    end(b?: string) { raw = b ?? ""; },
    setHeader() {},
  };
  await routes.handleTerminalLaunch(req, res, options);
  return { status, body: raw ? JSON.parse(raw) : null };
}

const CLAUDE_LAUNCH = { agent: "claude", cwd: PROJECT, cols: 120, rows: 40 };

describe("a launch that skips permission checks, on the JS backend", () => {
  it("starts that new Claude with the one flag, right after its session id", async () => {
    const got = await post({ ...CLAUDE_LAUNCH, options: { skipPermissions: true } });
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ ok: true, name: expect.stringMatching(/^ccdeck-claude-[0-9a-f]{8}$/) });
    const cmd = execd();
    expect(cmd[0]).toBe(CLAUDE);
    expect(cmd.slice(1, 2)).toEqual(["--session-id"]);
    expect(cmd.slice(3)).toEqual([FLAG]);
    expect(cmd.filter(a => a === FLAG), "once").toHaveLength(1);
  });

  it("keeps it beside the model and the worktree, the worktree last", async () => {
    await post({ ...CLAUDE_LAUNCH, options: { model: "sonnet", skipPermissions: true, worktree: true } });
    expect(execd().slice(3)).toEqual(["--model", "sonnet", FLAG, "--worktree"]);
  });

  it("starts the next, ordinary launch with nothing of it, and an explicit false the same", async () => {
    await post({ ...CLAUDE_LAUNCH, options: { skipPermissions: true } });
    expect(execd()).toContain(FLAG);
    ran = [];
    await post({ ...CLAUDE_LAUNCH });
    expect(execd(), "the switch reaches the launch it was on for, and no other").not.toContain(FLAG);
    expect(execd().slice(3), "nothing after the session id").toEqual([]);
    ran = [];
    await post({ ...CLAUDE_LAUNCH, options: { skipPermissions: false } });
    expect(execd()).not.toContain(FLAG);
    ran = [];
    await post({ ...CLAUDE_LAUNCH, options: { permissionMode: "plan" } });
    expect(execd().slice(3), "a permission mode as before").toEqual(["--permission-mode", "plan"]);
  });

  it("is refused for Codex, for a reopen, beside a permission mode, and as anything but a boolean, before anything starts", async () => {
    const refused: Array<[string, unknown, string?]> = [
      ["Codex", { agent: "codex", cwd: PROJECT, options: { skipPermissions: true } }],
      ["beside a permission mode", { ...CLAUDE_LAUNCH, options: { skipPermissions: true, permissionMode: "plan" } }],
      ["a string", { ...CLAUDE_LAUNCH, options: { skipPermissions: "true" } }],
      ["a number", { ...CLAUDE_LAUNCH, options: { skipPermissions: 1 } }],
      ["a reopen", { sessionId: SID, provider: "claude", cwd: PROJECT, options: { skipPermissions: true } }, "/api/terminal/adopt"],
    ];
    for (const [what, body, path] of refused) {
      const got = await post(body, path ? { path } : {});
      expect(got.status, what).toBe(400);
      expect(got.body, what).toMatchObject({ ok: false, code: "bad-options" });
      expect(typeof got.body.error, what).toBe("string");
    }
    expect(run, "tmux was never asked").not.toHaveBeenCalled();
  });

  it("is not there with the panel off", async () => {
    options = { ...jsDeck(), enabled: () => false };
    expect(await post({ ...CLAUDE_LAUNCH, options: { skipPermissions: true } })).toMatchObject({ status: 404, body: { error: "not found" } });
    expect(run).not.toHaveBeenCalled();
  });
});

describe("who may skip permission checks", () => {
  it("is this computer's own page, or a local client holding the deck's token", async () => {
    expect((await post({ ...CLAUDE_LAUNCH, options: { skipPermissions: true } })).status, "the deck's page").toBe(200);
    ran = [];
    const got = await post({ ...CLAUDE_LAUNCH, options: { skipPermissions: true } }, { headers: { host: `127.0.0.1:${port}`, "x-ccdeck-token": HOOK_TOKEN } });
    expect(got.status, "a client that read the deck's token").toBe(200);
    expect(execd()).toContain(FLAG);
  });

  it("never a viewer on the LAN, whatever headers it sends: 403, and nothing is started", async () => {
    for (const remoteAddress of ["192.168.1.20", "::ffff:192.168.1.20", "fe80::1", "100.101.102.103"]) {
      const got = await postFrom(remoteAddress, { ...CLAUDE_LAUNCH, options: { skipPermissions: true } });
      expect(got.status, remoteAddress).toBe(403);
      expect(got.body, remoteAddress).toEqual({ ok: false, error: routes.SKIP_LOCAL_ONLY, code: "skip-permissions-local-only" });
      const withToken = await postFrom(remoteAddress, { ...CLAUDE_LAUNCH, options: { skipPermissions: true } }, { host: `127.0.0.1:${port}`, "x-ccdeck-token": HOOK_TOKEN });
      expect(withToken.status, `${remoteAddress}, even with the token`).toBe(403);
    }
    expect(run, "tmux was never asked").not.toHaveBeenCalled();
  });

  it("never a request the deck's page did not send, even from this machine", async () => {
    const shapes: Array<[string, Record<string, string>]> = [
      ["no Origin, no token", { host: `127.0.0.1:${port}` }],
      ["another site's page", { host: `127.0.0.1:${port}`, origin: "http://evil.example", "sec-fetch-site": "cross-site" }],
      ["a rebound name", { host: `evil.example:${port}`, origin: `http://evil.example:${port}`, "sec-fetch-site": "same-origin" }],
      ["a wrong token", { host: `127.0.0.1:${port}`, "x-ccdeck-token": "0".repeat(64) }],
    ];
    for (const [what, headers] of shapes) {
      const got = await postFrom("127.0.0.1", { ...CLAUDE_LAUNCH, options: { skipPermissions: true } }, headers);
      expect(got.status, what).toBe(403);
      expect(got.body?.code, what).toBe("skip-permissions-local-only");
    }
    expect(run).not.toHaveBeenCalled();
  });
});

describe("an engine from before the option", () => {
  const UNKNOWN = { status: 400, body: { ok: false, error: "Those session options are not ones the deck knows.", code: "bad-options" } };
  const engineSaying = (said: unknown) => ({ enabled: true, route: vi.fn(async () => said) });
  const onEngine = (engine: ReturnType<typeof engineSaying>) => ({
    enabled: () => true, engine, provenance: null, tickets: createTicketStore(),
    checkFolder: async (cwd: string) => ({ ok: true, cwd }),
  });

  it("is asked the launch as the page sent it, and its refusal of the unknown option is said plainly: nothing was started", async () => {
    const engine = engineSaying(UNKNOWN);
    options = onEngine(engine);
    const body = { ...CLAUDE_LAUNCH, key: "launch-skip-1", options: { skipPermissions: true } };
    const got = await post(body);
    expect(engine.route).toHaveBeenCalledTimes(1);
    expect(engine.route).toHaveBeenCalledWith("launch", body);
    expect(got).toEqual({ status: 409, body: { ok: false, error: routes.SKIP_UNSUPPORTED, code: "skip-permissions-unsupported" } });
  });

  it("answers anything else as it said it, and the same refusal of a launch that did not ask it as before", async () => {
    const missing = { status: 409, body: { ok: false, error: "Claude Code is not installed on this machine.", code: "agent-missing" } };
    let engine = engineSaying(missing);
    options = onEngine(engine);
    expect(await post({ ...CLAUDE_LAUNCH, options: { skipPermissions: true } })).toEqual(missing);
    engine = engineSaying(UNKNOWN);
    options = onEngine(engine);
    expect(await post({ ...CLAUDE_LAUNCH, options: { model: "opus" } }), "no skip asked: the engine's own words").toEqual(UNKNOWN);
  });

  it("is never asked a launch the deck refused", async () => {
    const engine = engineSaying(UNKNOWN);
    options = onEngine(engine);
    expect((await post({ agent: "codex", cwd: PROJECT, options: { skipPermissions: true } })).status).toBe(400);
    expect((await postFrom("192.168.1.20", { ...CLAUDE_LAUNCH, options: { skipPermissions: true } })).status).toBe(403);
    expect(engine.route).not.toHaveBeenCalled();
  });
});
