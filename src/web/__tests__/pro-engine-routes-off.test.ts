// With no engine — always so in the free product — the Command Panel's eight
// routes have nothing behind them, and say so: a deck handed a null
// `terminal.engine`, or one that is switched off, answers every route with the
// same status and the same bytes, `{ ok: false, error, code: "not-installed"
// }`, asks the engine nothing, asks nothing of any other terminal, and makes
// no engine client. (The deck's own engine, which a deck handed none uses, is
// command-panel-engine.test.ts's.)
//
// The client's maker and the installer's verifier are wrapped to record every
// call, so "makes nothing" is a fact about this run of a real deck rather than
// about the source; the scan below says the same of the source: one module in
// the deck makes a client, and only that one.
//
// And how the engine's failures become refusals (routeThroughEngine), against
// stand-in clients, on every leg: the signed double that answers for real is
// pro-engine-routes.test.ts's, on the two platforms an engine is installed on.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

const made = vi.hoisted(() => ({ client: 0, verified: 0 }));
vi.mock("../../server/pro-engine-client.mjs", async (importOriginal) => {
  const real: any = await importOriginal();
  return { ...real, createProEngineClient: (o: unknown) => { made.client += 1; return real.createProEngineClient(o); } };
});
vi.mock("../../server/pro-engine-install.mjs", async (importOriginal) => {
  const real: any = await importOriginal();
  return { ...real, verifyEngineInstallation: (o: unknown) => { made.verified += 1; return real.verifyEngineInstallation(o); } };
});

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-engine-routes-off-"));
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
const { engineRefusal, routeThroughEngine } = await import("../../server/pro-engine-terminal.mjs");

const SID = "0b9f3c1e-2d4a-4b6c-8e0f-1a2b3c4d5e6f";
const tickets = createTicketStore();
let asked: string[];

/** An engine's terminal as engineTerminals shapes it for a client that is
 *  switched off, recording anything asked of it. */
const off = {
  get enabled() { return false; },
  attach: (...args: unknown[]) => { asked.push(`attach ${args.length}`); return { ok: false, status: 503 }; },
  route: (method: string) => { asked.push(method); return null; },
};

// The deck's `terminal` option, edited per case: terminalDeps reads it again
// on every request. The JS backend's stand-ins are there to be ignored: with
// no backend handed in, nothing may ask them anything.
const record = (name: string) => (..._args: unknown[]) => { asked.push(name); return new Promise(() => {}); };
const options: Record<string, unknown> = {
  enabled: () => true,
  engine: null,
  tickets,
  findTmux: record("findTmux"),
  resolveTarget: record("resolveTarget"),
  launchSession: record("launchSession"),
  downloadTmux: record("downloadTmux"),
};

let server: Server;
let port = 0;
beforeAll(async () => {
  server = await mod.startServer({ port: 0, persist: false, claude: false, codex: false, terminal: options });
  port = (server.address() as { port: number }).port;
}, 30_000);
beforeEach(() => {
  asked = [];
});
afterAll(async () => {
  await new Promise(r => server.close(r));
  rmTempDir(DIR);
});

function ask(method: string, path: string, body?: string): Promise<{ status: number; raw: string; headers: string }> {
  return new Promise((resolve_, reject) => {
    const req = request({
      host: "127.0.0.1", port, path, method,
      headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin", ...(body !== undefined ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } : {}) },
    }, res => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", c => { raw += c; });
      res.on("end", () => resolve_({ status: res.statusCode ?? 0, raw, headers: JSON.stringify([res.headers["content-type"], res.headers["cache-control"]]) }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

const session = JSON.stringify({ sessionId: SID, provider: "claude", cwd: PROJECT });
const ROUTES: Array<[string, string, string?]> = [
  ["GET", "/api/terminal/status"],
  ["GET", `/api/terminal/target?session=${SID}&provider=claude`],
  ["GET", "/api/terminal/target?session=nope"],
  ["POST", "/api/terminal/claim", JSON.stringify({ key: "k-1", sessionId: SID, provider: "claude", cwd: PROJECT })],
  ["POST", "/api/terminal/open", session],
  ["POST", "/api/terminal/open", "{not json"],
  ["POST", "/api/terminal/adopt", session],
  ["POST", "/api/terminal/launch", JSON.stringify({ agent: "claude", cwd: PROJECT, key: "k-1" })],
  ["POST", "/api/terminal/launch", JSON.stringify({ agent: "gemini", cwd: PROJECT })],
  // The older session hosts' two (Windows): refused the same way.
  ["GET", "/api/terminal/hosts"],
  ["POST", "/api/terminal/hosts/end", JSON.stringify({ generation: 1, sessions: ["0".repeat(32)] })],
  ["POST", "/api/terminal/launch", JSON.stringify({ agent: "claude", cwd: PROJECT, pad: "x".repeat(9 * 1024) })],
];

/** Every route's answer. */
async function answers() {
  const out: string[] = [];
  for (const [method, path, body] of ROUTES) {
    const got = await ask(method, path, body);
    out.push(`${method} ${path.slice(0, 40)} → ${got.status} ${got.headers} ${got.raw}`);
  }
  return out;
}

describe("the Command Panel's routes with no engine", () => {
  it("answer not-installed, byte for byte the same with a null engine or one switched off, and ask nothing of anyone", async () => {
    options.engine = null;
    const none = await answers();
    options.engine = off;
    const disabled = await answers();
    options.engine = null;
    expect(disabled).toEqual(none);
    expect(asked, "nothing was asked of the engine, nor of any other terminal").toEqual([]);
    // What those answers are, so the comparison is not of three empty lists.
    const notInstalled = JSON.stringify(engineRefusal("not-installed").body);
    expect(JSON.parse(notInstalled)).toMatchObject({ ok: false, code: "not-installed" });
    expect(none).toHaveLength(ROUTES.length);
    for (const line of none.slice(0, -1)) expect(line).toContain(`→ 409 ["application/json; charset=utf-8","no-store"] ${notInstalled}`);
    // The body's cap is the deck's, in front of any engine.
    expect(none.at(-1)).toContain("→ 413");
    expect(none.join("\n"), "no ticket of any kind").not.toContain('"ticket"');
  });

  it("make no engine client and verify no installation, on a deck that answered every route", async () => {
    await answers();
    expect(made).toEqual({ client: 0, verified: 0 });
  });

  it("make a client in one place in the deck, the Command Panel's, and import none on demand", () => {
    const server = new URL("../../server/", import.meta.url);
    const makers = readdirSync(server, { recursive: true }).map(String).filter(f => f.endsWith(".mjs") && /\b(?:createProEngineClient|ProEngineClient)\b/.test(readFileSync(new URL(f, server), "utf8")));
    expect(makers.sort()).toEqual(["command-panel-engine.mjs", "pro-engine-client.mjs"]);
    for (const file of ["terminal-routes.mjs", "terminal-socket.mjs", "index.mjs"]) {
      const source = readFileSync(new URL(file, server), "utf8");
      const imports = source.split("\n").filter(line => /^import\b/.test(line));
      expect(imports.length, `the scan sees ${file}'s imports`).toBeGreaterThan(0);
      expect(imports.filter(line => /pro-engine-(client|install)/.test(line)), file).toEqual([]);
      expect(source.match(/import\([^)]*pro-engine/g), file).toBeNull();
    }
  });
});

describe("routeThroughEngine's refusals", () => {
  const fail = (code?: string) => Object.assign(new Error("fixture"), code === undefined ? {} : { code });
  /** A client that starts (or not) and answers every request with `error`. */
  const client = ({ start, error, backend = "tmux" }: { start?: string | null; error?: string; backend?: string }) => {
    const requests: string[] = [];
    return {
      requests,
      start: async () => { if (start !== undefined) throw fail(start ?? undefined); },
      capabilities: { terminal: { backend } },
      request: async (method: string) => { requests.push(method); if (error !== undefined) throw fail(error); return { status: 200, body: { ok: true } }; },
    };
  };
  const code = async (c: object, method = "status") => {
    const said = await routeThroughEngine(c, method, null);
    return [said.status, said.body.code];
  };

  it("says why an engine would not start, and asks it nothing", async () => {
    expect(await code(client({ start: "backoff" }))).toEqual([503, "restarting"]);
    expect(await code(client({ start: "closed" }))).toEqual([503, "restarting"]);
    expect(await code(client({ start: "timeout" }))).toEqual([503, "no-answer"]);
    expect(await code(client({ start: null })), "a verification failure carries no code").toEqual([409, "not-verified"]);
    for (const c of ["disabled", "startup", "exited", "incompatible", "protocol"]) expect(await code(client({ start: c }), "launch"), c).toEqual([409, "failed"]);
    const none = client({ backend: "unavailable" });
    expect(await code(none, "launch")).toEqual([409, "no-terminal"]);
    expect(none.requests).toEqual([]);
  });

  it("refuses what the engine never ran, for every route", async () => {
    const table: Array<[string, number, string]> = [
      ["unavailable", 409, "no-terminal"], ["busy", 503, "busy"], ["invalid_request", 400, "bad-request"],
      ["bad_params", 400, "bad-request"], ["backoff", 503, "restarting"], ["disabled", 409, "failed"],
    ];
    for (const [error, status, refusal] of table) {
      for (const method of ["status", "target", "hosts", "claim", "open", "adopt", "launch", "endHosts"]) {
        expect(await code(client({ error }), method), `${method} ${error}`).toEqual([status, refusal]);
      }
    }
  });

  it("refuses a read that went unanswered, and never a mutation that may have run: that throws, once", async () => {
    for (const method of ["status", "target", "hosts"]) {
      expect(await code(client({ error: "timeout" }), method)).toEqual([503, "no-answer"]);
      for (const error of ["exited", "closed", "transport", "heartbeat", "protocol", "startup"]) expect(await code(client({ error }), method), error).toEqual([503, "restarting"]);
      await expect(routeThroughEngine(client({ error: "internal" }), method, null)).rejects.toMatchObject({ code: "internal" });
    }
    for (const method of ["claim", "open", "adopt", "launch", "endHosts"]) {
      for (const error of ["timeout", "exited", "closed", "transport", "heartbeat", "internal", "cancelled"]) {
        const c = client({ error });
        await expect(routeThroughEngine(c, method, null), `${method} ${error}`).rejects.toMatchObject({ code: error });
        expect(c.requests, "asked once, and not again").toEqual([`terminal.${method}`]);
      }
    }
  });

  it("answers an unknown refusal code as failed, and every refusal in one shape", () => {
    expect(engineRefusal("no-such-code")).toEqual(engineRefusal("failed"));
    for (const c of ["unsupported", "not-installed", "not-verified", "no-terminal", "failed", "restarting", "busy", "no-answer", "bad-request"]) {
      const { status, body } = engineRefusal(c);
      expect(Object.keys(body).sort(), c).toEqual(["code", "error", "ok"]);
      expect([body.ok, body.code, typeof body.error], c).toEqual([false, c, "string"]);
      expect(body.error, "one short sentence, no path").toMatch(/^[A-Z][^/\n]{10,90}\.$/);
      expect([400, 409, 503], c).toContain(status);
    }
  });
});
