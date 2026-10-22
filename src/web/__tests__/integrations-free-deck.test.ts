// The integrations on a deck with no provider: the free deck (#2178).
// GET /api/integrations offers no kind, so the page offers no
// integration. A connection saved while a provider was there is still
// listed, with no token, and Disconnect deletes it with its token; every
// other route of its answers `unavailable` (503), an image an empty 404 —
// and none of it asks anything: no process is started, and nothing is
// fetched.
//
// node:child_process and fetch are counted for the run.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { request, type Server } from "node:http";
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
const TOKENS = { jira: fakeToken("off-jira"), github: fakeToken("off-github"), gitlab: fakeToken("off-gitlab") };

// Every read the panels make, as development's providers name them.
const READS: Record<string, string[]> = {
  jira: ["boards", "board/1", "board/1/closed-sprints", "board/1/issues", "issue/KEY-1", "issue/KEY-1/subtasks"],
  github: ["repos", "branches", "branch", "changes", "change-counts", "change", "change/commits", "change/pipelines",
    "change/files", "pipelines", "pipeline", "job-log", "issues", "issue", "issue/comments", "resolve"],
};
READS.gitlab = READS.github;

let server: Server;
let port = 0;
let token = "";
beforeAll(async () => {
  server = await mod.startServer({ port: 0, persist: false, open: false, claude: false, codex: false });
  port = (server.address() as { port: number }).port;
  token = mod.hookToken();
}, 30_000);
afterAll(async () => {
  globalThis.fetch = realFetch;
  server.closeAllConnections?.();
  await new Promise(r => server.close(r));
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

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

describe("a deck with no provider", () => {
  it("registers none, and offers the page none", async () => {
    expect(providerList()).toEqual([]);
    const r = await page("/api/integrations");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, providers: [], connections: [] });
  });

  it("connects nothing, and saves nothing", async () => {
    const seen = await quietly(async () => {
      for (const kind of ["jira", "github", "gitlab"]) {
        const r = await call("POST", "/api/integrations/connections", { kind, input: { baseUrl: `https://${kind}.example.com`, token: TOKENS.github } });
        expect([r.status, r.body?.error?.kind, r.body?.error?.field], kind).toEqual([400, "invalid", "kind"]);
      }
    });
    expect(seen).toEqual({ processes: [], fetches: 0 });
    expect((await page("/api/integrations")).body.connections).toEqual([]);
  });
});

describe("a connection saved while a provider was there", () => {
  const ids: Record<string, string> = {};
  beforeAll(async () => {
    const jira = await integrationsStore.create({
      kind: "jira", name: "Work", baseUrl: "https://jira.example.com",
      account: { login: "jdoe" }, allowedOrigins: ["https://jira.example.com"],
    }, { auth: "bearer", token: TOKENS.jira });
    const github = await integrationsStore.create({
      kind: "github", name: "GitHub", baseUrl: "https://api.github.com",
      account: { login: "jdoe" }, allowedOrigins: ["https://api.github.com"],
    }, TOKENS.github);
    const gitlab = await integrationsStore.create({
      kind: "gitlab", name: "GitLab", baseUrl: "https://gitlab.example.com",
      account: { login: "jdoe" }, allowedOrigins: ["https://gitlab.example.com"],
    }, TOKENS.gitlab);
    Object.assign(ids, { jira: jira.id, github: github.id, gitlab: gitlab.id });
  });

  it("is listed, with no token, and still no kind is offered", async () => {
    const r = await page("/api/integrations");
    expect(r.body.providers).toEqual([]);
    expect(r.body.connections.map((c: { kind: string; tokenSaved: boolean }) => [c.kind, c.tokenSaved]).sort())
      .toEqual([["github", true], ["gitlab", true], ["jira", true]]);
    for (const value of Object.values(TOKENS)) expect(r.raw.includes(value)).toBe(false);
  });

  it("answers every read the panels make unavailable, HEAD too, asking nothing", async () => {
    const seen = await quietly(async () => {
      for (const [kind, reads] of Object.entries(READS)) {
        for (const read of reads) {
          expectUnavailable(await page(`/api/integrations/${kind}/${ids[kind]}/${read}?repo=a%2Fb&number=1`), `${kind} ${read}`);
          expect((await page(`/api/integrations/${kind}/${ids[kind]}/${read}`, "HEAD")).status, `HEAD ${kind} ${read}`).toBe(503);
        }
      }
    });
    expect(seen).toEqual({ processes: [], fetches: 0 });
  });

  it("answers an image with an empty 404, asking nothing", async () => {
    const seen = await quietly(async () => {
      for (const kind of Object.keys(ids)) {
        const r = await page(`/api/integrations/${kind}/${ids[kind]}/asset?url=${encodeURIComponent(`https://${kind}.example.com/avatar.png`)}`);
        expect([r.status, r.raw], kind).toEqual([404, ""]);
      }
    });
    expect(seen).toEqual({ processes: [], fetches: 0 });
  });

  it("answers Test and Edit unavailable, and changes nothing", async () => {
    const before = (await page("/api/integrations")).body;
    const seen = await quietly(async () => {
      for (const kind of Object.keys(ids)) {
        expectUnavailable(await call("POST", `/api/integrations/connections/${ids[kind]}/test`, {}), `test ${kind}`);
        expectUnavailable(await call("PATCH", `/api/integrations/connections/${ids[kind]}`, { name: "Renamed" }), `rename ${kind}`);
        expectUnavailable(await call("PATCH", `/api/integrations/connections/${ids[kind]}`, { input: { baseUrl: `https://${kind}.example.com`, token: fakeToken("new") } }), `edit ${kind}`);
      }
    });
    expect(seen).toEqual({ processes: [], fetches: 0 });
    expect((await page("/api/integrations")).body).toEqual(before);
  });

  it("refuses a write to a read, and says not found for what is not a saved connection", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect((await call(method, `/api/integrations/jira/${ids.jira}/boards`, {})).status, method).toBe(405);
    }
    for (const path of ["/api/integrations/jira/no-such-id/boards", `/api/integrations/github/${ids.jira}/repos`, "/api/integrations/nope/abc/items"]) {
      const r = await page(path);
      expect([r.status, r.body?.error?.kind], path).toEqual([404, "not-found"]);
    }
  });

  it("is disconnected with its token, asking nothing, until none is left", async () => {
    const seen = await quietly(async () => {
      for (const kind of Object.keys(ids)) {
        expect((await call("DELETE", `/api/integrations/connections/${ids[kind]}`)).status, kind).toBe(200);
        expect((await call("DELETE", `/api/integrations/connections/${ids[kind]}`)).status, `again ${kind}`).toBe(404);
      }
    });
    expect(seen).toEqual({ processes: [], fetches: 0 });
    expect((await page("/api/integrations")).body).toEqual({ ok: true, providers: [], connections: [] });
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
