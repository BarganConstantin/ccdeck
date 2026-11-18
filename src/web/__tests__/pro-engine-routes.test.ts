// The Command Panel's eight routes answered by the optional local engine, on a
// real deck (startServer), against the signed test double started as the
// engine (fixtures/pro-engine-peer.cjs, docs/contracts/pro-engine-host-v1.md,
// "Terminal routes").
//
// What is pinned: the deck asks each route's question as `terminal.<method>`
// with `{ body }` and nothing else, after its own switch, gates and body cap;
// sends the engine's status and body as they are; mints the ticket where the
// engine answered a handle, bound to `{ handle, origin }`, in the same store
// with the same single use, and the upgrade relays exactly that ticket to the
// engine; keeps the engine's log line off the page; and, for a status the
// engine calls fixable, fetches ccdeck's own tmux the way it did before the
// engine (tmux-download.mjs) and tells the engine to look again once it has
// landed. And where the engine did not take a
// question — would not start, no terminal, a refusal before it ran, a read it
// could not answer — the deck answers a refusal the page can draw, `{ ok:
// false, error, code }`, and nothing else answers it; a mutation that may have
// reached the engine is the deck's 500 and is never asked again.
//
// One deck for the file. Its `terminal.engine` is engineTerminals(client) for
// whichever client the case switched to, and its `terminal.ownTmux` the
// download the case set up, each through a box the deck was given at boot.
// Nothing is downloaded and nothing is run: the download's `fetchImpl` hands
// back bytes, and its `execImpl` plays tar and the build's `-V`, as
// tmux-download.test.ts does.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { rmTempDir } from "./rm-temp-dir";
import { json, openWs } from "./ws-test-client";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-engine-routes-"));
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
const { createTicketStore } = await import("../../server/terminal-socket.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { createProEngineClient } = await import("../../server/pro-engine-client.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { engineTerminals } = await import("../../server/pro-engine-terminal.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { ownTmux } = await import("../../server/terminal-routes.mjs");
// @ts-expect-error — plain .mjs server module, no types
const dl = await import("../../server/tmux-download.mjs");

const SID = "0b9f3c1e-2d4a-4b6c-8e0f-1a2b3c4d5e6f";
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── ccdeck's own tmux, from a stand-in ────────────────────────────────────────

const ARCHIVE = Buffer.from("tmux build archive; extraction is played by execImpl");
/** A build whose linux-x64 hash is the archive's, under the deck's real tag:
 *  the folder it lands in is the one the engine looks in. */
const BUILD = Object.freeze({
  tag: dl.TMUX_BUILD.tag, version: dl.TMUX_BUILD.version,
  sha256: { "linux-x64": createHash("sha256").update(ARCHIVE).digest("hex"), "linux-arm64": "", "darwin-x64": "", "darwin-arm64": "" },
});
const ASSET_URL = `https://github.com/BarganConstantin/ccdeck/releases/download/${dl.TMUX_BUILD.tag}/tmux-${dl.TMUX_BUILD.version}-linux-x64.tar.gz`;

/** A fetch answering `body` (or `status`), every ask recorded. When `held`, the
 *  headers come at once and the bytes only on `release()`, so a case can look
 *  while the download is out. */
function fetching(body: Buffer = ARCHIVE, { status = 200, held = false }: { status?: number; held?: boolean } = {}) {
  const asked: string[] = [];
  const waits: (() => void)[] = [];
  const impl = async (url: string) => {
    asked.push(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (h: string) => (h === "content-length" ? String(body.length) : null) },
      arrayBuffer: async () => {
        if (held) await new Promise<void>(r => waits.push(r));
        return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
      },
    };
  };
  return { asked, impl, release: () => { for (const w of waits.splice(0)) w(); }, waiting: () => waits.length };
}

/** tar that unpacks a tmux answering `version` to -V (or nothing when null). */
function running(version: string | null) {
  const ran: string[][] = [];
  const impl = async (file: string, args: string[]) => {
    ran.push([file, ...args]);
    if (file === "tar") { writeFileSync(join(args[3], "tmux"), "#!/fake/tmux\n"); return { code: 0, stdout: "" }; }
    return version === null ? { code: 1, stdout: "" } : { code: 0, stdout: `tmux ${version}\n` };
  };
  return { ran, impl };
}

let homes = 0;
/** The deck's own tmux for a case: Linux x64 unless said, in a data folder of its own. */
function ownTmuxFor({ env = {}, platform = "linux", arch = "x64", fetch = fetching(), exec = running("3.8") }: Record<string, any> = {}) {
  const dataDir = join(DIR, `own-tmux-${++homes}`);
  const own = ownTmux({ env: { CCDECK_HOME: dataDir, ...env }, platform, arch, build: BUILD, fetchImpl: fetch.impl, execImpl: exec.impl });
  return { own, fetch, exec, dataDir, binary: dl.managedTmuxPath(dataDir, BUILD) };
}

// ── the double as an installed, signed engine ────────────────────────────────

const roots: string[] = [], clients: any[] = [];
// A new executable is run once, untimed, before any case gives the engine a
// deadline. macOS checks an executable on its first exec: 280-450 ms for a new
// file on an Intel iMac, 5-100 ms after, which is longer than the 300 ms the
// cases below give the engine to start. With its stdin closed the double exits
// 0 at once.
function runOnce(file: string): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(file, [], { stdio: "ignore" });
    child.on("error", fail);
    child.on("exit", (code, signal) => code === 0 ? done() : fail(new Error(`the double, run once before the cases, ended with ${code ?? signal}`)));
  });
}
async function installed({ backend = "tmux", ...options }: Record<string, any> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "ccpro-routes-")); roots.push(directory); await chmod(directory, 0o700);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const source = (await readFile(new URL("./fixtures/pro-engine-peer.cjs", import.meta.url), "utf8")).replace("const TERMINAL_BACKEND = 'unavailable';", `const TERMINAL_BACKEND = '${backend}';`);
  const bytes = Buffer.from(`#!${process.execPath}\n${source}`);
  await writeFile(join(directory, "ccdeck-pro-engine"), bytes, { mode: 0o700 });
  await runOnce(join(directory, "ccdeck-pro-engine"));
  const entry = { file: "ccdeck-pro-engine", protocol: 1, target: `${process.arch === "x64" ? "x86_64" : "aarch64"}-${process.platform === "darwin" ? "apple-darwin" : "unknown-linux-gnu"}`, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, version: "0.1.0" };
  const payload = Buffer.from(JSON.stringify(entry));
  await writeFile(join(directory, "manifest.json"), JSON.stringify({ payload: payload.toString("base64"), signature: sign(null, payload, privateKey).toString("base64") }), { mode: 0o600 });
  const client = createProEngineClient({ enabled: true, directory, publicKey: publicKey.export({ type: "spki", format: "pem" }), heartbeatMs: 60_000, ...options });
  clients.push(client);
  return client;
}
const answers = (client: any, set: Record<string, object>) => client.request("terminal.answers", { answers: set });
const engineLog = async (client: any): Promise<any[]> => (await client.request("terminal.log")).log;
const routeCalls = async (client: any) => (await engineLog(client)).filter(x => x.route);

// ── the deck ──────────────────────────────────────────────────────────────────

let enabled: boolean;
const tickets = createTicketStore();
const box: { current: any } = { current: null };
// The deck's own tmux for the case: by default one whose every fetch is
// recorded, which the cases that never expect one hold to nothing.
const own: { current: any } = { current: null };
let quiet: ReturnType<typeof ownTmuxFor>;

beforeEach(() => {
  enabled = true;
  box.current = null;
  dl.resetTmuxDownload();
  quiet = ownTmuxFor();
  own.current = quiet.own;
});
afterEach(() => {
  expect(own.current.out, "no download of this case is still out").toBe(false);
  if (own.current === quiet.own) expect(quiet.fetch.asked, "nothing fetched").toEqual([]);
});

let server: Server;
let port = 0;
beforeAll(async () => {
  server = await mod.startServer({
    port: 0, persist: false, claude: false, codex: false,
    terminal: {
      enabled: () => enabled,
      tickets,
      engine: {
        get enabled() { return box.current?.enabled === true; },
        attach: (handle: string, socket: unknown) => box.current.attach(handle, socket),
        route: (method: string, body: unknown) => box.current.route(method, body),
        forgetTmux: () => box.current.forgetTmux(),
      },
      ownTmux: {
        blocked: () => own.current.blocked(),
        landed: () => own.current.landed(),
        recentFailure: () => own.current.recentFailure(),
        get out() { return own.current.out; },
        progress: () => own.current.progress(),
        start: (then: () => unknown) => own.current.start(then),
      },
    },
  });
  port = (server.address() as { port: number }).port;
}, 30_000);
afterEach(async () => {
  await Promise.all(clients.splice(0).map(c => c.close()));
});
afterAll(async () => {
  await new Promise(r => server.close(r));
  await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true })));
  rmTempDir(DIR);
});

async function useEngine(options: Record<string, any> = {}) {
  const client = await installed(options);
  box.current = engineTerminals(client);
  return client;
}

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
const TICKET = /^[A-Za-z0-9_-]{43}$/;
const launched = { status: 200, body: { ok: true, sessionId: SID, name: "ccdeck-claude-feedf00d", ticket: null }, handle: "mint" };
/** A refusal as the page reads it: the status, and the body's code with one sentence beside it. */
const refusal = (got: { status: number; body: any }) => [got.status, got.body?.ok, got.body?.code, typeof got.body?.error, Object.keys(got.body ?? {}).sort().join()];
const refused = (status: number, code: string) => [status, false, code, "string", "code,error,ok"];

describe.skipIf(!['darwin', 'linux'].includes(process.platform))("the Command Panel's routes with the optional local engine", () => {
  it("asks each route's question as terminal.<method> with { body } only, and sends the engine's status and body as they are", async () => {
    const client = await useEngine();
    const status = { ok: true, platform: "engine-says", tmux: { ok: true, version: "3.8" } };
    await answers(client, {
      "terminal.status": { data: { status: 200, body: status } },
      "terminal.target": { data: { status: 200, body: { ok: true, target: { kind: "A", label: "from the engine" } } } },
      "terminal.claim": { data: { status: 200, body: { ok: true, claimed: false, target: { kind: "gone" } } } },
      "terminal.open": { data: { status: 400, body: { ok: false, error: "The request did not name a session." } } },
      "terminal.adopt": { data: { status: 409, body: { ok: false, error: "still-running" } } },
    });
    const got = await ask("GET", "/api/terminal/status");
    expect([got.status, got.body]).toEqual([200, status]);
    expect((await ask("GET", `/api/terminal/target?session=${SID}&provider=claude`)).body.target.label).toBe("from the engine");
    expect((await ask("POST", "/api/terminal/claim", { key: "k1", ...session() })).body.claimed).toBe(false);
    const open = await ask("POST", "/api/terminal/open", "{not json");
    expect([open.status, open.body]).toEqual([400, { ok: false, error: "The request did not name a session." }]);
    const adopt = await ask("POST", "/api/terminal/adopt", [session()]);
    expect([adopt.status, adopt.body]).toEqual([409, { ok: false, error: "still-running" }]);
    expect((await routeCalls(client)).map(c => [c.route, c.params])).toEqual([
      ["terminal.status", { body: null }],
      // The query's three values, each "" when absent, as the route reads them.
      ["terminal.target", { body: { sessionId: SID, provider: "claude", cwd: "" } }],
      ["terminal.claim", { body: { key: "k1", ...session() } }],
      // Not a JSON object: the engine is asked with null and answers the 400.
      ["terminal.open", { body: null }],
      ["terminal.adopt", { body: null }],
    ]);
  });

  it("mints the ticket over the engine's handle, bound to the page's origin, and the upgrade relays it to the engine once", async () => {
    const client = await useEngine();
    await answers(client, { "terminal.launch": { data: launched } });
    const held = tickets.size;
    const got = await ask("POST", "/api/terminal/launch", { agent: "claude", cwd: PROJECT, key: "k-1" });
    expect(got.status).toBe(200);
    expect(Object.keys(got.body), "the ticket where the engine's null was").toEqual(["ok", "sessionId", "name", "ticket"]);
    expect(got.body.ticket).toMatch(TICKET);
    const minted = (await engineLog(client)).find(x => x.minted)!.minted;
    expect(got.raw, "the handle stays between the deck and the engine").not.toContain(minted);
    expect(tickets.size).toBe(held + 1);

    const path = `/api/terminal/attach?ticket=${encodeURIComponent(got.body.ticket)}`;
    const c = await openWs({ port, path, headers: { Origin: `http://127.0.0.1:${port}` } });
    expect(c.status).toBe(101);
    expect(json(await c.next())).toEqual({ t: "hello", kind: "A", sizeOwner: "dock", readOnly: false });
    expect((await engineLog(client)).filter(x => x.attach !== undefined).map(x => x.handle)).toEqual([minted]);
    c.sendClose();
    await c.closed;

    const replay = await openWs({ port, path, headers: { Origin: `http://127.0.0.1:${port}` } });
    expect(replay.status, "single use").toBe(401);
    // A ticket the page at one origin asked for, opened by a page at another
    // that names its own host: refused before the engine hears of it.
    const other = await ask("POST", "/api/terminal/launch", { agent: "claude", cwd: PROJECT, key: "k-1" });
    const elsewhere = await openWs({ port, path: `/api/terminal/attach?ticket=${encodeURIComponent(other.body.ticket)}`, headers: { Host: `localhost:${port}`, Origin: `http://localhost:${port}` } });
    expect(elsewhere.status).toBe(403);
    expect((await engineLog(client)).filter(x => x.attach !== undefined), "one attach in all").toHaveLength(1);
  });

  it("writes the engine's log line to the deck's log and never to the page", async () => {
    const client = await useEngine();
    const said = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await answers(client, { "terminal.launch": { data: { status: 500, body: { ok: false, error: "tmux could not start the session.", code: "tmux-failed" }, log: "tmux could not start the session. (no server at /secret/tmp/sock)" } } });
      const got = await ask("POST", "/api/terminal/launch", { agent: "claude", cwd: PROJECT });
      expect([got.status, got.body]).toEqual([500, { ok: false, error: "tmux could not start the session.", code: "tmux-failed" }]);
      expect(got.raw).not.toContain("/secret");
      expect(said.mock.calls.map(c => String(c[0])).filter(l => l.includes("terminal:"))).toEqual(["ccdeck: terminal: tmux could not start the session. (no server at /secret/tmp/sock)"]);
    } finally {
      said.mockRestore();
    }
  });

  describe("ccdeck's own tmux, for a status the engine calls fixable", () => {
    const missing = { ok: false, reason: "missing", install: "sudo apt install tmux" };
    const tooOld = { ok: false, reason: "too-old", version: "3.1", install: "brew install tmux" };
    const status = (tmux: object, fixable = true) => ({ data: { status: 200, body: { ok: true, platform: "linux", tmux }, ...(fixable ? { fixable: true } : {}) } });
    const forgets = async (client: any) => (await routeCalls(client)).filter(c => c.route === "terminal.forgetTmux");
    const tmuxNow = async () => (await ask("GET", "/api/terminal/status")).body.tmux;

    it("fetches it when there is none, says how far it has got, and tells the engine to look again once it has landed", async () => {
      const client = await useEngine();
      const t = ownTmuxFor({ fetch: fetching(ARCHIVE, { held: true }) });
      own.current = t.own;
      await answers(client, { "terminal.status": status(missing), "terminal.forgetTmux": { data: { forgot: true } } });
      const first = await ask("GET", "/api/terminal/status");
      expect([first.status, first.body], "answered at once, before the download has said anything").toEqual([200, { ok: true, platform: "linux", tmux: { ok: false, reason: "installing" } }]);
      await vi.waitFor(() => expect(t.fetch.waiting()).toBe(1));
      expect(await tmuxNow(), "the bytes are on their way").toEqual({ ok: false, reason: "installing", progress: { stage: "downloading", received: 0, total: ARCHIVE.length } });
      expect(await forgets(client), "nothing has landed yet").toEqual([]);
      // The engine finds the build once it has forgotten its miss.
      await answers(client, { "terminal.status": status({ ok: true, version: "3.8" }, false) });
      t.fetch.release();
      await vi.waitFor(async () => expect((await forgets(client)).map(c => c.params)).toEqual([{ body: null }]));
      await vi.waitFor(() => expect(t.own.out).toBe(false));
      expect(await tmuxNow()).toEqual({ ok: true, version: "3.8" });
      expect(t.fetch.asked, "once, this machine's build, from the deck's own release").toEqual([ASSET_URL]);
      expect(existsSync(t.binary), "in the folder the engine looks in").toBe(true);
      expect(statSync(t.binary).mode & 0o777).toBe(0o755);
      expect((await routeCalls(client)).map(c => c.route)).toEqual(["terminal.status", "terminal.status", "terminal.forgetTmux", "terminal.status"]);
    });

    it("fetches it for a tmux older than 3.2 too, and keeps the engine's platform", async () => {
      const client = await useEngine();
      const t = ownTmuxFor();
      own.current = t.own;
      await answers(client, { "terminal.status": status(tooOld), "terminal.forgetTmux": { data: { forgot: true } } });
      expect((await ask("GET", "/api/terminal/status")).body).toEqual({ ok: true, platform: "linux", tmux: { ok: false, reason: "installing" } });
      await vi.waitFor(async () => expect(await forgets(client)).toHaveLength(1));
      await vi.waitFor(() => expect(t.own.out).toBe(false));
      expect(t.fetch.asked).toEqual([ASSET_URL]);
    });

    it("starts one download for two panes asking at once, and tells the engine once", async () => {
      const client = await useEngine();
      const t = ownTmuxFor({ fetch: fetching(ARCHIVE, { held: true }) });
      own.current = t.own;
      await answers(client, { "terminal.status": status(missing), "terminal.forgetTmux": { data: { forgot: true } } });
      const both = await Promise.all([ask("GET", "/api/terminal/status"), ask("GET", "/api/terminal/status")]);
      expect(both.map(g => g.body.tmux.reason)).toEqual(["installing", "installing"]);
      await vi.waitFor(() => expect(t.fetch.waiting()).toBe(1));
      expect((await tmuxNow()).reason, "a third ask while it is out").toBe("installing");
      expect(t.fetch.asked).toHaveLength(1);
      t.fetch.release();
      await vi.waitFor(() => expect(t.own.out).toBe(false));
      expect(t.fetch.asked, "one download in all").toHaveLength(1);
      expect(await forgets(client), "one forget in all").toHaveLength(1);
    });

    it("answers a download that failed, came back other than pinned or would not run as the plain fact with why, and does not try again yet", async () => {
      const client = await useEngine();
      await answers(client, { "terminal.status": status(missing), "terminal.forgetTmux": { data: { forgot: true } } });
      for (const [fetch, exec, reason] of [
        [fetching(ARCHIVE, { status: 404 }), running("3.8"), "download_failed"],
        [fetching(Buffer.from("swapped after publication")), running("3.8"), "checksum_mismatch"],
        [fetching(), running(null), "does_not_run"],
        [fetching(), running("3.6"), "does_not_run"],
      ] as const) {
        dl.resetTmuxDownload();
        const t = ownTmuxFor({ fetch, exec });
        own.current = t.own;
        expect((await tmuxNow()).reason, reason).toBe("installing");
        await vi.waitFor(() => expect(t.own.out).toBe(false));
        for (let i = 0; i < 2; i++) {
          const got = await ask("GET", "/api/terminal/status");
          expect([got.status, got.body], reason).toEqual([200, { ok: true, platform: "linux", tmux: { ...missing, download: reason } }]);
        }
        expect(t.fetch.asked, `${reason}: asked once, not again while the failure is believed`).toEqual([ASSET_URL]);
        expect(existsSync(t.binary), `${reason}: nothing put in place`).toBe(false);
        if (reason === "checksum_mismatch") expect(t.exec.ran, "an archive that is not the pinned one is never unpacked or run").toEqual([]);
      }
      expect(await forgets(client), "nothing landed, nothing to forget").toEqual([]);
    });

    it("fetches nothing with AGENTS_DECK_NO_INSTALL or AGENTS_DECK_NO_DOWNLOAD, on Windows, or where there is no build: the engine's answer, install line and all", async () => {
      const client = await useEngine();
      await answers(client, { "terminal.status": status(missing), "terminal.forgetTmux": { data: { forgot: true } } });
      for (const options of [
        { env: { AGENTS_DECK_NO_INSTALL: "1" } },
        { env: { AGENTS_DECK_NO_DOWNLOAD: "1" } },
        { platform: "win32" },
        { arch: "ia32" },
        { arch: "arm64" }, // no hash for it in this build
      ]) {
        const t = ownTmuxFor(options);
        own.current = t.own;
        const got = await ask("GET", "/api/terminal/status");
        expect([got.status, got.body], JSON.stringify(options)).toEqual([200, { ok: true, platform: "linux", tmux: missing }]);
        await delay(20);
        expect(t.fetch.asked, JSON.stringify(options)).toEqual([]);
      }
      expect(await forgets(client)).toEqual([]);
    });

    it("fetches nothing for a tmux that works, or one the engine did not call fixable", async () => {
      const client = await useEngine();
      await answers(client, { "terminal.status": { data: { status: 200, body: { ok: true, platform: "linux", tmux: { ok: true, version: "3.4" } }, fixable: true } } });
      expect((await tmuxNow()), "fixable beside a tmux that works").toEqual({ ok: true, version: "3.4" });
      await answers(client, { "terminal.status": status(missing, false) });
      expect(await tmuxNow(), "only the engine's fixable starts a download").toEqual(missing);
      await answers(client, { "terminal.status": status({ ok: false, reason: "unsupported-platform" }) });
      expect(await tmuxNow()).toEqual({ ok: false, reason: "unsupported-platform" });
      await delay(20);
      // `quiet` (afterEach): nothing fetched.
    });

    it("fetches nothing for a build already in place: the engine is told to forget and asked once more, and what it then says is the answer", async () => {
      const client = await useEngine();
      const t = ownTmuxFor();
      own.current = t.own;
      mkdirSync(join(t.binary, ".."), { recursive: true });
      writeFileSync(t.binary, "#!/fake/tmux\n");
      await answers(client, { "terminal.status": status(missing), "terminal.forgetTmux": { data: { forgot: true } } });
      const got = await ask("GET", "/api/terminal/status");
      expect([got.status, got.body], "still none: not fetched again, said as the plain fact").toEqual([200, { ok: true, platform: "linux", tmux: { ...missing, download: "not_used" } }]);
      expect((await routeCalls(client)).map(c => c.route)).toEqual(["terminal.status", "terminal.forgetTmux", "terminal.status"]);
      expect(t.fetch.asked).toEqual([]);
      // An engine that finds it once it has forgotten (a stand-in: the double answers one status).
      const asked: string[] = [];
      let forgot = false;
      box.current = {
        enabled: true,
        attach: async () => ({ ok: false, status: 503 }),
        forgetTmux: async () => { asked.push("forget"); forgot = true; },
        route: async (method: string) => {
          asked.push(method);
          return forgot ? { status: 200, body: { ok: true, platform: "linux", tmux: { ok: true, version: "3.8" } } } : { status: 200, body: { ok: true, platform: "linux", tmux: missing }, fixable: true };
        },
      };
      expect(await tmuxNow()).toEqual({ ok: true, version: "3.8" });
      expect(asked).toEqual(["status", "forget", "status"]);
      expect(t.fetch.asked).toEqual([]);
    });

    it("tells only a running engine to forget, and asks nothing of one that is not", async () => {
      const client = await useEngine();
      await engineTerminals(client).forgetTmux();
      expect(client.running, "not started for a forget").toBe(false);
      await answers(client, { "terminal.forgetTmux": { data: { forgot: true } } });
      await engineTerminals(client).forgetTmux();
      expect((await forgets(client)).map(c => c.params)).toEqual([{ body: null }]);
      // An engine that does not know the method: the forget still settles, and says nothing.
      await answers(client, { "terminal.forgetTmux": { error: "unavailable" } });
      await expect(engineTerminals(client).forgetTmux()).resolves.toBeUndefined();
    });
  });

  it("answers what the engine turned away before running it, and a read it did not answer, as a refusal: nothing else answers it", async () => {
    const client = await useEngine({ timeoutMs: 300 });
    await answers(client, {
      "terminal.launch": { error: "unavailable" },
      "terminal.status": { error: "busy" },
      "terminal.target": { data: { status: 200, body: {} }, delayMs: 2_000 },
      "terminal.open": { error: "bad_params" },
      "terminal.claim": { error: "invalid_request" },
    });
    const got = await ask("POST", "/api/terminal/launch", { agent: "claude", cwd: PROJECT });
    expect(refusal(got), "not serving terminals").toEqual(refused(409, "no-terminal"));
    expect(got.body.ticket, "no ticket of any kind").toBeUndefined();
    expect(refusal(await ask("GET", "/api/terminal/status")), "the page waits it out").toEqual(refused(503, "busy"));
    expect(refusal(await ask("GET", `/api/terminal/target?session=${SID}&provider=claude&cwd=${encodeURIComponent(PROJECT)}`)), "no answer in time").toEqual(refused(503, "no-answer"));
    expect(refusal(await ask("POST", "/api/terminal/open", session()))).toEqual(refused(400, "bad-request"));
    expect(refusal(await ask("POST", "/api/terminal/claim", { key: "k1", ...session() }))).toEqual(refused(400, "bad-request"));
    expect((await routeCalls(client)).map(c => c.route), "each asked once").toEqual(["terminal.launch", "terminal.status", "terminal.target", "terminal.open", "terminal.claim"]);
  });

  it("never asks a mutation again once it may have reached the engine: the deck's own 500", async () => {
    let client = await useEngine({ timeoutMs: 300 });
    await answers(client, { "terminal.launch": { data: launched, delayMs: 2_000 }, "terminal.open": { error: "internal" }, "terminal.target": { error: "internal" } });
    expect((await ask("POST", "/api/terminal/launch", { agent: "claude", cwd: PROJECT })).status, "no answer in time").toBe(500);
    expect((await ask("POST", "/api/terminal/open", session())).status, "internal").toBe(500);
    expect((await ask("GET", `/api/terminal/target?session=${SID}&provider=claude`)).status, "internal, for a read too").toBe(500);
    expect((await routeCalls(client)).map(c => c.route), "each asked once").toEqual(["terminal.launch", "terminal.open", "terminal.target"]);
    client = await useEngine();
    await answers(client, { "terminal.adopt": { crash: true } });
    expect((await ask("POST", "/api/terminal/adopt", session())).status, "the engine went away under it").toBe(500);
    // A read meanwhile: the engine is in its restart backoff, which the page waits out.
    expect(refusal(await ask("GET", "/api/terminal/status"))).toEqual(refused(503, "restarting"));
  });

  it("refuses an answer that is not a route answer with the deck's own 500", async () => {
    const client = await useEngine();
    const bad = [
      { status: 200, body: {}, extra: true },
      { status: 99, body: {} },
      { status: 200 },
      { status: 200, body: { ok: true, ticket: null }, handle: "not-hex" },
      { status: 200, body: { ok: true, ticket: "already" }, handle: "mint" },
      { status: 200, body: { ok: true }, fixable: true },
      { status: 200, body: {}, log: 7 },
    ];
    for (const data of bad) {
      await answers(client, { "terminal.status": { data } });
      const got = await ask("GET", "/api/terminal/status");
      expect(got.status, JSON.stringify(data)).toBe(500);
      expect(got.raw).not.toContain("already");
    }
  });

  it("asks the older session hosts' two routes as terminal.hosts and terminal.endHosts, sends a refusal as it is, and never asks an end twice", async () => {
    const client = await useEngine({ timeoutMs: 300 });
    const listed = {
      ok: true,
      hosts: [{ generation: 1, state: "stranded", sessions: [{ id: "a".repeat(32), name: "paycore", agent: "claude", cwd: PROJECT, conversation: "", started: 1 }] }],
      launchesRefused: null,
    };
    const outdated = { ok: false, error: "The sessions on that session host changed. Review them again.", code: "consent-outdated" };
    const gone = { ok: false, error: "That session host is no longer running.", code: "host-gone" };
    const order = { generation: 1, sessions: ["a".repeat(32)] };
    await answers(client, {
      "terminal.hosts": { data: { status: 200, body: listed } },
      "terminal.endHosts": { data: { status: 409, body: outdated } },
    });
    const got = await ask("GET", "/api/terminal/hosts");
    expect([got.status, got.body]).toEqual([200, listed]);
    const end = await ask("POST", "/api/terminal/hosts/end", order);
    expect([end.status, end.body]).toEqual([409, outdated]);
    await answers(client, { "terminal.endHosts": { data: { status: 409, body: gone } } });
    expect((await ask("POST", "/api/terminal/hosts/end", order)).body).toEqual(gone);
    await answers(client, { "terminal.endHosts": { data: { status: 200, body: { ok: true, ended: 1 } } } });
    const ended = await ask("POST", "/api/terminal/hosts/end", order);
    expect([ended.status, ended.body]).toEqual([200, { ok: true, ended: 1 }]);
    await answers(client, { "terminal.endHosts": { data: { status: 200, body: { ok: true, ended: 1 } }, delayMs: 2_000 } });
    expect((await ask("POST", "/api/terminal/hosts/end", order)).status, "no answer in time: the deck's 500").toBe(500);
    expect((await routeCalls(client)).map(c => [c.route, c.params]), "each asked once, with the body as the page sent it").toEqual([
      ["terminal.hosts", { body: null }],
      ["terminal.endHosts", { body: order }],
      ["terminal.endHosts", { body: order }],
      ["terminal.endHosts", { body: order }],
      ["terminal.endHosts", { body: order }],
    ]);
  });

  it("refuses the older hosts' routes for an engine with no session host, as on Linux and macOS, and asks it nothing", async () => {
    const none = await useEngine({ backend: "unavailable" });
    expect(refusal(await ask("GET", "/api/terminal/hosts"))).toEqual(refused(409, "no-terminal"));
    expect(refusal(await ask("POST", "/api/terminal/hosts/end", { generation: 1, sessions: ["a".repeat(32)] }))).toEqual(refused(409, "no-terminal"));
    expect(await routeCalls(none)).toEqual([]);
  });

  it("refuses for an engine that would not start or has no terminal, and asks nothing with the panel off, a body over the cap or a cross-site page", async () => {
    const none = await useEngine({ backend: "unavailable" });
    await answers(none, { "terminal.status": { data: { status: 200, body: {} } } });
    expect(refusal(await ask("GET", "/api/terminal/status"))).toEqual(refused(409, "no-terminal"));
    expect(refusal(await ask("POST", "/api/terminal/launch", { agent: "claude", cwd: PROJECT }))).toEqual(refused(409, "no-terminal"));
    expect(await routeCalls(none)).toEqual([]);

    // Signed with a key the deck does not trust: never started.
    await useEngine({ publicKey: generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }) });
    expect(refusal(await ask("GET", "/api/terminal/status"))).toEqual(refused(409, "not-verified"));
    // A client the deck was given switched off is no engine, and is asked nothing.
    const off = await useEngine({ enabled: false });
    expect(refusal(await ask("POST", "/api/terminal/open", session()))).toEqual(refused(409, "not-installed"));
    expect(off.running).toBe(false);
    // One that has been closed, as a deck stopping it does: the page waits.
    const closed = await useEngine();
    await closed.close();
    expect(refusal(await ask("GET", "/api/terminal/status"))).toEqual(refused(503, "restarting"));

    const client = await useEngine();
    await answers(client, { "terminal.launch": { data: launched }, "terminal.status": { data: { status: 200, body: {} } } });
    enabled = false;
    for (const [method, path] of [["GET", "/api/terminal/status"], ["POST", "/api/terminal/launch"]]) {
      const got = await ask(method, path, method === "POST" ? { agent: "claude", cwd: PROJECT } : undefined);
      expect([got.status, got.body]).toEqual([404, { error: "not found" }]);
    }
    enabled = true;
    const big = await ask("POST", "/api/terminal/launch", { agent: "claude", cwd: PROJECT, pad: "x".repeat(9 * 1024) });
    expect(big.status).toBe(413);
    // The gates are in front of the engine too: a cross-site page is refused.
    expect((await ask("POST", "/api/terminal/launch", { agent: "claude", cwd: PROJECT }, { host: `127.0.0.1:${port}`, origin: "http://evil.example" })).status).toBe(403);
    await delay(50);
    expect(await routeCalls(client)).toEqual([]);
  });
});
