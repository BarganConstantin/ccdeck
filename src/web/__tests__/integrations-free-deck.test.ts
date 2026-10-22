// The integrations on the free deck (#2178, #2179): the deck's
// own JavaScript providers serve every kind it offers. GET /api/integrations
// lists each of them as available, a connection's reads are answered by its
// provider, which asks the connection's own address and nothing else, and
// Disconnect deletes a connection with its token. A connection of a kind no
// provider here knows is still listed, with no token; its routes answer
// `unavailable` (503), an image an empty 404, and Disconnect deletes it. None
// of it starts a process.
//
// node:child_process and fetch are counted for the run. Every tracker here is
// a stub on this machine that refuses every request: nothing leaves the
// machine.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

const counted = vi.hoisted(() => ({ processes: [] as string[], fetches: 0 }));
vi.mock("node:child_process", async importOriginal => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const wrapped: Record<string, unknown> = {};
  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const) {
    const original = real[name] as unknown as (...args: unknown[]) => unknown;
    const wrapper = (...args: unknown[]) => { counted.processes.push(name); return original(...args); };
    const custom = (original as unknown as Record<symbol, unknown>)[promisify.custom] as ((...args: unknown[]) => unknown) | undefined;
    if (custom) Object.defineProperty(wrapper, promisify.custom, { value: (...args: unknown[]) => { counted.processes.push(name); return custom(...args); } });
    wrapped[name] = wrapper;
  }
  return { ...real, ...wrapped, default: { ...real, ...wrapped } };
});

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-integrations-off-"));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.XDG_CONFIG_HOME = join(DIR, "config");
process.env.XDG_DATA_HOME = join(DIR, "data");
process.env.XDG_STATE_HOME = join(DIR, "state");
process.env.CCDECK_HOME = join(DIR, "deck");
process.env.AGENTS_DECK_NO_LAN = "1";
if (!resolve(process.env.CCDECK_HOME).startsWith(resolve(DIR))) throw new Error("sandbox escaped");

const said: string[] = [];
for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { said.push(args.map(String).join(" ")); });
}

const realFetch = globalThis.fetch;
globalThis.fetch = ((...args: Parameters<typeof fetch>) => { counted.fetches += 1; return realFetch(...args); }) as typeof fetch;

// @ts-expect-error — plain .mjs server module, no types
const mod = await import("../../server/index.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { providerList } = await import("../../server/integrations/registry.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { integrationsStore } = await import("../../server/integrations/store.mjs");

/** A fake token, built at run time so no literal here reads as a live one. */
const fakeToken = (seed: string) => ["fake", seed, "token", "0123456789abcdef"].join("-");

// The kinds this deck's own providers serve, with their labels.
const JS_KINDS = [["jira", "Jira"], ["github", "GitHub"], ["gitlab", "GitLab"]] as const;
type JsKind = typeof JS_KINDS[number][0];
// Every read the panels make, as the providers name them, with the parameters
// each needs to reach its tracker.
const READS: Record<string, string[]> = {
  jira: ["boards", "board/1", "board/1/closed-sprints", "board/1/issues?source=backlog", "issue/KEY-1", "issue/KEY-1/subtasks"],
  github: ["repos", "branches", "branch", "changes", "change-counts", "change", "change/commits", "change/pipelines",
    "change/files", "pipelines", "pipeline", "job-log", "issues", "issue", "issue/comments", "resolve"],
};
READS.gitlab = READS.github;
const FORGE_QUERY = "repo=a%2Fb&number=1&id=1&name=main&q=a%2Fb%231";
// A tracker no provider here is registered for: a connection a newer deck
// saved, or one whose provider was taken out.
const STRANDED_KIND = "youtrack";
const TOKENS: Record<string, string> = {
  jira: fakeToken("off-jira"), github: fakeToken("off-github"), gitlab: fakeToken("off-gitlab"), [STRANDED_KIND]: fakeToken("off-stranded"),
};

/** A tracker on this machine that refuses every request, and remembers each:
 *  its path and whether it carried this connection's token. */
interface Stub { url: string; requests: Array<{ method: string; path: string; signed: boolean }>; close(): Promise<void> }
async function startStub(secret: string): Promise<Stub> {
  const requests: Stub["requests"] = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method ?? "", path: req.url ?? "", signed: String(req.headers.authorization ?? "").includes(secret) });
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "401 Unauthorized" }));
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url, requests, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

let server: Server;
let port = 0;
let token = "";
const stubs: Partial<Record<JsKind, Stub>> = {};
beforeAll(async () => {
  server = await mod.startServer({ port: 0, persist: false, open: false, claude: false, codex: false });
  port = (server.address() as { port: number }).port;
  token = mod.hookToken();
  for (const [kind] of JS_KINDS) stubs[kind] = await startStub(TOKENS[kind]);
}, 30_000);
afterAll(async () => {
  globalThis.fetch = realFetch;
  server.closeAllConnections?.();
  await new Promise(r => server.close(r));
  await Promise.all(Object.values(stubs).map(s => s?.close()));
  rmTempDir(DIR);
});

interface Answer { status: number; body: any; raw: string }
function call(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Answer> {
  return new Promise((resolve_, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request({
      host: "127.0.0.1", port, path, method, agent: false,
      headers: headers ?? { host: `127.0.0.1:${port}`, "x-ccdeck-token": token, ...(payload ? { "content-type": "application/json" } : {}) },
    }, res => {
      const chunks: Buffer[] = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsed: any = null;
        try { parsed = JSON.parse(raw); } catch { /* an image, or nothing */ }
        resolve_({ status: res.statusCode ?? 0, body: parsed, raw });
      });
    });
    req.on("error", reject);
    req.end(payload);
  });
}
const page = (path: string, method = "GET") => call(method, path, undefined, { host: `127.0.0.1:${port}`, "sec-fetch-site": "same-origin" });
const expectUnavailable = (r: Answer, what: string) => {
  expect(r.status, what).toBe(503);
  expect(r.body, what).toEqual({ ok: false, error: { kind: "unavailable", message: expect.stringMatching(/is not available on this deck\.$/) } });
};

/** What a stretch of requests started and fetched. */
async function quietly(run: () => Promise<void>) {
  const processes = counted.processes.length;
  const fetches = counted.fetches;
  await run();
  return { processes: counted.processes.slice(processes), fetches: counted.fetches - fetches };
}

/** Every request the stubs got, in all. */
const stubRequests = () => Object.values(stubs).reduce((n, s) => n + (s?.requests.length ?? 0), 0);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

describe("the providers the free deck has", () => {
  it("registers its own, and offers the page each of them as available", async () => {
    const offered = JS_KINDS.map(([kind, label]) => ({ kind, label, available: true }));
    expect(providerList()).toEqual(offered);
    const r = await page("/api/integrations");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, providers: offered, connections: [] });
  });

  it("refuses a kind it has no provider for, and a form with no token, asking nothing", async () => {
    const seen = await quietly(async () => {
      const r = await call("POST", "/api/integrations/connections", { kind: STRANDED_KIND, input: { baseUrl: "https://youtrack.example.com", token: TOKENS[STRANDED_KIND] } });
      expect([r.status, r.body?.error?.kind, r.body?.error?.field]).toEqual([400, "invalid", "kind"]);
      for (const [kind] of JS_KINDS) {
        const blank = await call("POST", "/api/integrations/connections", { kind, input: { deployment: "server", where: "self", baseUrl: stubs[kind]!.url } });
        expect([blank.status, blank.body?.error?.kind, blank.body?.error?.field], kind).toEqual([400, "invalid", "token"]);
      }
    });
    expect(seen).toEqual({ processes: [], fetches: 0 });
    expect((await page("/api/integrations")).body.connections).toEqual([]);
  });
});

describe("a connection the deck's own provider reads", () => {
  const ids: Record<string, string> = {};
  beforeAll(async () => {
    for (const [kind] of JS_KINDS) {
      const url = stubs[kind]!.url;
      const conn = await integrationsStore.create({
        kind, name: kind, baseUrl: url, account: { login: "jdoe" }, allowedOrigins: [url],
        ...(kind === "jira" ? { meta: { deployment: "server" } } : {}),
      }, kind === "jira" ? { auth: "bearer", token: TOKENS.jira } : TOKENS[kind]);
      ids[kind] = conn.id;
    }
  });

  it("is listed, with no token, and its kind is offered", async () => {
    const r = await page("/api/integrations");
    expect(r.body.providers.map((p: { kind: string; available: boolean }) => [p.kind, p.available])).toEqual(JS_KINDS.map(([kind]) => [kind, true]));
    expect(r.body.connections.map((c: { kind: string; tokenSaved: boolean }) => [c.kind, c.tokenSaved]).sort())
      .toEqual(JS_KINDS.map(([kind]) => [kind, true]).sort());
    for (const value of Object.values(TOKENS)) expect(r.raw.includes(value)).toBe(false);
  });

  it("answers every read the panels make from its own tracker, asking that address and nothing else", async () => {
    const before = stubRequests();
    const seen = await quietly(async () => {
      for (const [kind] of JS_KINDS) {
        for (const read of READS[kind]) {
          const sep = read.includes("?") ? "&" : "?";
          const r = await page(`/api/integrations/${kind}/${ids[kind]}/${read}${kind === "jira" ? "" : `${sep}${FORGE_QUERY}`}`);
          // The stub refuses every request: the provider says so in its own
          // words, which is never the host's `unavailable`. (GitLab reads a
          // link to resolve without asking the forge at all.)
          expect(r.status, `${kind} ${read}`).not.toBe(503);
          if (read !== "resolve") expect(r.body?.ok, `${kind} ${read}`).toBe(false);
          expect(r.body?.error?.kind, `${kind} ${read}`).not.toBe("unavailable");
          expect(r.raw.includes(TOKENS[kind]), `${kind} ${read}`).toBe(false);
        }
      }
    });
    expect(seen.processes).toEqual([]);
    expect(seen.fetches).toBeGreaterThan(0);
    expect(stubRequests() - before, "every fetch went to the connection's own tracker").toBe(seen.fetches);
    for (const [kind] of JS_KINDS) {
      const asked = stubs[kind]!.requests;
      expect(asked.length, kind).toBeGreaterThan(0);
      expect(asked.every(q => q.signed), `${kind}: every request to its own tracker carries its token`).toBe(true);
      // Read-only: GET, and for a forge a GraphQL document over POST (the
      // read-only suites check those are queries).
      expect(asked.filter(q => q.method !== "GET" && !(kind !== "jira" && q.method === "POST" && /graphql/.test(q.path))), kind).toEqual([]);
    }
  });

  it("answers an image from a host the tracker does not serve images from with an empty refusal, asking nothing", async () => {
    const seen = await quietly(async () => {
      for (const [kind] of JS_KINDS) {
        const r = await page(`/api/integrations/${kind}/${ids[kind]}/asset?url=${encodeURIComponent("https://images.example.net/avatar.png")}`);
        expect(r.status, kind).toBeGreaterThanOrEqual(400);
        expect(r.raw, kind).toBe("");
      }
    });
    expect(seen).toEqual({ processes: [], fetches: 0 });
  });

  it("refuses a write to a read, and says not found for what is not a saved connection", async () => {
    for (const [kind] of JS_KINDS) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        expect((await call(method, `/api/integrations/${kind}/${ids[kind]}/${READS[kind][0]}`, {})).status, `${kind} ${method}`).toBe(405);
      }
      const r = await page(`/api/integrations/${kind}/no-such-id/${READS[kind][0]}`);
      expect([r.status, r.body?.error?.kind], kind).toEqual([404, "not-found"]);
    }
  });

  it("is disconnected with its token, asking nothing", async () => {
    const seen = await quietly(async () => {
      for (const [kind] of JS_KINDS) {
        expect((await call("DELETE", `/api/integrations/connections/${ids[kind]}`)).status, kind).toBe(200);
        expect((await call("DELETE", `/api/integrations/connections/${ids[kind]}`)).status, `again ${kind}`).toBe(404);
      }
    });
    expect(seen).toEqual({ processes: [], fetches: 0 });
    expect((await page("/api/integrations")).body.connections).toEqual([]);
  });
});

describe("a connection of a kind no provider here knows", () => {
  let id = "";
  beforeAll(async () => {
    const conn = await integrationsStore.create({
      kind: STRANDED_KIND, name: "Old", baseUrl: "https://youtrack.example.com",
      account: { login: "jdoe" }, allowedOrigins: ["https://youtrack.example.com"],
    }, TOKENS[STRANDED_KIND]);
    id = conn.id;
  });

  it("is listed, with no token, and its kind is not offered", async () => {
    const r = await page("/api/integrations");
    expect(r.body.providers.map((p: { kind: string }) => p.kind)).not.toContain(STRANDED_KIND);
    expect(r.body.connections.map((c: { kind: string; tokenSaved: boolean }) => [c.kind, c.tokenSaved])).toEqual([[STRANDED_KIND, true]]);
    expect(r.raw.includes(TOKENS[STRANDED_KIND])).toBe(false);
  });

  it("answers its reads, Test and Edit unavailable, and an image with an empty 404, asking nothing", async () => {
    const before = (await page("/api/integrations")).body;
    const seen = await quietly(async () => {
      for (const read of ["boards", "items", "repos"]) {
        expectUnavailable(await page(`/api/integrations/${STRANDED_KIND}/${id}/${read}`), read);
        expect((await page(`/api/integrations/${STRANDED_KIND}/${id}/${read}`, "HEAD")).status, `HEAD ${read}`).toBe(503);
      }
      const image = await page(`/api/integrations/${STRANDED_KIND}/${id}/asset?url=${encodeURIComponent("https://youtrack.example.com/avatar.png")}`);
      expect([image.status, image.raw]).toEqual([404, ""]);
      expectUnavailable(await call("POST", `/api/integrations/connections/${id}/test`, {}), "test");
      expectUnavailable(await call("PATCH", `/api/integrations/connections/${id}`, { name: "Renamed" }), "rename");
    });
    expect(seen).toEqual({ processes: [], fetches: 0 });
    expect((await page("/api/integrations")).body).toEqual(before);
  });

  it("is disconnected with its token, asking nothing, and no token is left on disk", async () => {
    const seen = await quietly(async () => {
      expect((await call("DELETE", `/api/integrations/connections/${id}`)).status).toBe(200);
      expect((await call("DELETE", `/api/integrations/connections/${id}`)).status).toBe(404);
    });
    expect(seen).toEqual({ processes: [], fetches: 0 });
    expect((await page("/api/integrations")).body.connections).toEqual([]);
    const store = join(DIR, "deck", "integrations");
    expect(JSON.parse(readFileSync(join(store, "integrations-secrets.json"), "utf8")).secrets).toEqual({});
    const files = walk(DIR);
    expect(files.length, "the scan sees the deck's files").toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(file, "latin1");
      for (const value of Object.values(TOKENS)) expect(text.includes(value), file).toBe(false);
    }
  });
});

describe("what the free deck runs for the integrations", () => {
  it("counts what it is meant to count: a process a server module starts, and a fetch", async () => {
    // @ts-expect-error — plain .mjs server module, no types
    const { run } = await import("../../server/exec.mjs");
    const seen = await quietly(async () => {
      await run(process.execPath, ["-e", ""]);
      await (await fetch(`http://127.0.0.1:${port}/api/integrations`)).text();
    });
    expect(seen.processes.length).toBeGreaterThan(0);
    expect(seen.fetches).toBe(1);
  });

  it("imports nothing that starts a process or opens a socket", () => {
    const dir = new URL("../../server/integrations/", import.meta.url);
    const files = readdirSync(dir).filter(name => name.endsWith(".mjs"));
    expect(files).toEqual(expect.arrayContaining(["errors.mjs", "providers.mjs", "proxy.mjs", "registry.mjs", "routes.mjs", "store.mjs"]));
    for (const file of files) {
      const source = readFileSync(new URL(file, dir), "utf8");
      const imports = source.split("\n").filter(line => /^import\b/.test(line));
      expect(source.match(/import\([^)]*\)/g), `${file} imports nothing on demand`).toBeNull();
      expect(imports.filter(line => /child_process|node:(net|tls|dgram|http|https|http2|worker_threads|cluster)"/.test(line)), file).toEqual([]);
    }
    // The one place the deck wires them in.
    const index = readFileSync(new URL("../../server/index.mjs", import.meta.url), "utf8");
    const imports = index.split("\n").filter(line => /^import\b/.test(line));
    expect(imports.filter(line => line.includes("./integrations/"))).toEqual(['import { handleIntegrations } from "./integrations/routes.mjs";']);
  });

  it("never once named a token", () => {
    for (const line of said) for (const value of Object.values(TOKENS)) expect(line.includes(value), line.slice(0, 120)).toBe(false);
  });
});
