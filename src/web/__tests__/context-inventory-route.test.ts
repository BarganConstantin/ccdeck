// GET /api/session/skills and /api/session/mcp-servers
// (context-inventory-route.mjs): the skills a Claude Code session's project has
// installed and the MCP servers configured for it, read-only. The request names
// a session and nothing else; where to look comes from the scope the enrichment
// passes noted for it. Every refusal once the request is well formed is one
// 404. Each SKILL.md is read only as far as 64 KiB, and only its frontmatter's
// name and description come back; of a server, only its name, scope and
// transport, never what its configuration holds besides.
//
// A home and a Claude config dir of this file's own: nothing here reaches the
// real ~/.claude or ~/.claude.json.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { open as fsOpen } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-context-inventory-route-"));
const HOME = join(DIR, "home");
const CONFIG = join(DIR, "claude-config");
const PREV = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
};
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.CLAUDE_CONFIG_DIR = CONFIG;

const SHOP = join(DIR, "work", "shop");
const EMPTY = join(DIR, "work", "empty");
const USER_SKILLS = join(CONFIG, "skills");
const SHOP_SKILLS = join(SHOP, ".claude", "skills");

// @ts-expect-error — server module, untyped by design (tsconfig.build.json)
const route = await import("../../server/context-inventory-route.mjs");
// @ts-expect-error — server module, untyped by design (tsconfig.build.json)
const { GUARDED_READS } = await import("../../server/request-gates.mjs");
// @ts-expect-error — server module, untyped by design (tsconfig.build.json)
const enrichment = await import("../../server/session-enrichment.mjs");
const {
  CLAUDE_JSON_MAX, DESCRIPTION_MAX, MCP_JSON_MAX, MCP_SERVERS_ROUTE, SKILL_FILE_MAX, SKILLS_MAX, SKILLS_ROUTE,
  handleSessionMcpServers, handleSessionSkills, mcpTransport, skillFrontmatter,
} = route;

type Scope = { provider: "claude" | "codex"; cwd: string; codexHome?: string };
const SCOPES: Record<string, Scope> = {
  shop: { provider: "claude", cwd: SHOP },
  empty: { provider: "claude", cwd: EMPTY },
  codex: { provider: "codex", cwd: SHOP },
};

interface Answer { status: number; body: any; text: string; headers: Record<string, string> }

type Handler = (req: unknown, res: unknown, io?: Record<string, unknown>) => Promise<void>;
function callOn(handler: Handler, path: string, query: string, io: Record<string, unknown> = {}, remoteAddress = "127.0.0.1", method = "GET"): Promise<Answer> {
  const req = { method, url: `${path}${query}`, headers: {}, socket: { remoteAddress } };
  let status = 0, text = "", headers: Record<string, string> = {};
  const res = {
    headersSent: false,
    writeHead: (s: number, h: Record<string, string>) => { status = s; headers = h; },
    end: (s: string) => { text = s; },
  };
  return handler(req, res, { scopeOf: (sid: string) => SCOPES[sid] ?? null, ...io })
    .then(() => ({ status, body: JSON.parse(text), text, headers }));
}
const skills = (query: string, io: Record<string, unknown> = {}, remote?: string, method?: string) =>
  callOn(handleSessionSkills, SKILLS_ROUTE, query, io, remote, method);
const servers = (query: string, io: Record<string, unknown> = {}, remote?: string, method?: string) =>
  callOn(handleSessionMcpServers, MCP_SERVERS_ROUTE, query, io, remote, method);
const q = (session: string) => `?${new URLSearchParams({ session })}`;
/** The project's own skills in an answer: the user's are in every one. */
const own = (body: { skills: Array<{ scope: string }> }) => body.skills.filter(s => s.scope === "project");

/** A skill folder with this SKILL.md text. */
function skill(root: string, name: string, text: string) {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, "SKILL.md"), text);
}

beforeAll(() => {
  for (const dir of [USER_SKILLS, SHOP_SKILLS, EMPTY, HOME]) mkdirSync(dir, { recursive: true });
  skill(USER_SKILLS, "deploy", "---\nname: deploy\ndescription: Ship the build to the staging box.\n---\n\n# Deploy\n\nSECRET-BODY-TEXT\n");
  skill(USER_SKILLS, "quoted", "---\nname: \"quoted-name\"\ndescription: 'It''s quoted: with a colon'\n---\nbody\n");
  skill(USER_SKILLS, "folded", "---\nname: folded\ndescription: >\n  Use when the user asks\n  for a folded block.\n\n  Second paragraph.\nallowed-tools: Bash\n---\n");
  skill(USER_SKILLS, "literal", "---\nname: literal\ndescription: |\n  line one\n  line two\n---\n");
  skill(USER_SKILLS, "plain-run-on", "---\nname: plain-run-on\ndescription: A plain value\n  that runs on # a comment\nmetadata:\n  name: not-this\n---\n");
  skill(USER_SKILLS, "no-front", "# Just a heading\n\nNo frontmatter here.\n");
  skill(USER_SKILLS, "unclosed", "---\nname: never-closed\ndescription: lost\n");
  skill(USER_SKILLS, "crlf", "﻿---\r\nname: crlf-skill\r\ndescription: Windows line ends\r\n---\r\n");
  skill(SHOP_SKILLS, "review", "---\nname: review\ndescription: Review the shop's pull requests.\n---\n");
  // Not skills: a folder with no SKILL.md, a stray file, a hidden folder.
  mkdirSync(join(USER_SKILLS, "empty-folder"), { recursive: true });
  writeFileSync(join(USER_SKILLS, "README.md"), "not a skill\n");
  skill(USER_SKILLS, ".hidden", "---\nname: hidden\n---\n");
});
afterAll(() => {
  for (const [k, v] of Object.entries(PREV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmTempDir(DIR);
});

describe("the skills route's place in the server", () => {
  it("is a guarded read and is wired into the router through guard()", () => {
    expect(SKILLS_ROUTE).toBe("/api/session/skills");
    expect(GUARDED_READS.has(SKILLS_ROUTE)).toBe(true);
    const index = readFileSync(new URL("../../server/index.mjs", import.meta.url), "utf8");
    expect(index).toContain("if (url.pathname === SKILLS_ROUTE) return guard(handleSessionSkills(req, res), res);");
  });

  it("answers this computer only, before it looks anything up", async () => {
    let asked = 0;
    const { status, body } = await skills(q("shop"), { scopeOf: () => { asked++; return SCOPES.shop; } }, "192.0.2.10");
    expect(status).toBe(403);
    expect(body).toEqual({ reason: "not_local" });
    expect(asked).toBe(0);
  });

  it("only reads", async () => {
    for (const method of ["POST", "PUT", "DELETE"]) expect((await skills(q("shop"), {}, "127.0.0.1", method)).status).toBe(405);
  });
});

describe("a request of the wrong shape is refused before anything is looked up", () => {
  const bad: Array<[string, string]> = [
    ["no session", ""],
    ["an empty session", "?session="],
    ["two sessions", "?session=shop&session=empty"],
    ["an unknown key", "?session=shop&path=%2Fetc%2Fpasswd"],
    ["a path in the session", "?session=..%2Fx"],
    ["a dot in the session", "?session=a.md"],
    ["a session over 128 characters", `?session=${"a".repeat(129)}`],
  ];
  for (const [name, query] of bad) {
    it(`${name}: 400 bad_session`, async () => {
      let asked = 0;
      const { status, body } = await skills(query, { scopeOf: () => { asked++; return SCOPES.shop; } });
      expect(status).toBe(400);
      expect(body).toEqual({ reason: "bad_session" });
      expect(asked).toBe(0);
    });
  }
});

describe("the skills", () => {
  it("are the user's and the project's, by name, with their description and path, never cached", async () => {
    const { status, body, text, headers } = await skills(q("shop"));
    expect(status).toBe(200);
    expect(headers["Cache-Control"]).toBe("no-store");
    expect(body.truncated).toBe(false);
    const byName = Object.fromEntries(body.skills.map((s: { name: string }) => [s.name, s]));
    expect(byName.deploy).toEqual({ name: "deploy", scope: "user", description: "Ship the build to the staging box.", path: join(USER_SKILLS, "deploy", "SKILL.md") });
    expect(byName.review).toEqual({ name: "review", scope: "project", description: "Review the shop's pull requests.", path: join(SHOP_SKILLS, "review", "SKILL.md") });
    // Four fields a skill, and nothing of the body.
    for (const s of body.skills) expect(Object.keys(s).sort()).toEqual(["description", "name", "path", "scope"]);
    expect(text).not.toContain("SECRET-BODY-TEXT");
    expect(text).not.toContain("# Deploy");
  });

  it("reads quoted values, folded and literal blocks, and values that run on", async () => {
    const { body } = await skills(q("shop"));
    const desc = (name: string) => body.skills.find((s: { name: string }) => s.name === name)?.description;
    expect(desc("quoted-name")).toBe("It's quoted: with a colon");
    expect(desc("folded")).toBe("Use when the user asks for a folded block.\nSecond paragraph.");
    expect(desc("literal")).toBe("line one\nline two");
    expect(desc("plain-run-on")).toBe("A plain value that runs on");
    expect(desc("crlf-skill")).toBe("Windows line ends");
    // A nested `name:` is not the skill's.
    expect(body.skills.some((s: { name: string }) => s.name === "not-this")).toBe(false);
  });

  it("names a skill whose frontmatter is missing or not closed by its folder, with no description", async () => {
    const { body } = await skills(q("shop"));
    const byPath = (dir: string) => body.skills.find((s: { path: string }) => s.path === join(USER_SKILLS, dir, "SKILL.md"));
    expect(byPath("no-front")).toMatchObject({ name: "no-front", description: "" });
    expect(byPath("unclosed")).toMatchObject({ name: "unclosed", description: "" });
  });

  it("leaves out what is not a skill: a folder with no SKILL.md, a file, a hidden folder", async () => {
    const { body } = await skills(q("shop"));
    const paths = body.skills.map((s: { path: string }) => s.path);
    expect(paths).not.toContain(join(USER_SKILLS, "empty-folder", "SKILL.md"));
    expect(paths.some((p: string) => p.includes("README.md") || p.includes(".hidden"))).toBe(false);
    expect(body.skills).toHaveLength(9);
  });

  it("is an empty list for a project with no skills folder of its own", async () => {
    const { status, body } = await skills(q("empty"));
    expect(status).toBe(200);
    expect(body.skills.every((s: { scope: string }) => s.scope === "user")).toBe(true);
  });

  it("follows CLAUDE_CONFIG_DIR, not the home's .claude", async () => {
    skill(join(HOME, ".claude", "skills"), "home-only", "---\nname: home-only\n---\n");
    const { body } = await skills(q("shop"));
    expect(body.skills.some((s: { name: string }) => s.name === "home-only")).toBe(false);
  });

  it("reads at most 64 KiB of a SKILL.md and caps the description at 1024 characters", async () => {
    const root = join(DIR, "work", "big", ".claude", "skills");
    // The description is long; a frontmatter pushed past 64 KiB is never closed.
    skill(root, "long", `---\nname: long\ndescription: ${"é".repeat(DESCRIPTION_MAX + 50)}\n---\n`);
    skill(root, "far", `---\nname: far\nnote: ${"x".repeat(SKILL_FILE_MAX)}\ndescription: past the cut\n---\n`);
    const read: number[] = [];
    const open = async (path: string, flags: number) => {
      const handle = await fsOpen(path, flags);
      const original = handle.read.bind(handle);
      (handle as { read: unknown }).read = (async (...args: Parameters<typeof original>) => {
        const result = await original(...args);
        read.push(result.bytesRead);
        return result;
      });
      return handle;
    };
    const { body } = await skills(q("big"), { scopeOf: () => ({ provider: "claude", cwd: join(DIR, "work", "big") }), open });
    const long = body.skills.find((s: { name: string }) => s.name === "long");
    expect(Array.from(long.description)).toHaveLength(DESCRIPTION_MAX);
    const far = body.skills.find((s: { path: string }) => s.path === join(root, "far", "SKILL.md"));
    expect(far).toMatchObject({ name: "far", description: "" });
    expect(Math.max(...read)).toBeLessThanOrEqual(SKILL_FILE_MAX);
  });

  it(`lists at most ${SKILLS_MAX} skills and says when it stopped`, async () => {
    const cwd = join(DIR, "work", "many");
    const root = join(cwd, ".claude", "skills");
    for (let i = 0; i < SKILLS_MAX + 5; i++) skill(root, `s-${String(i).padStart(4, "0")}`, "---\ndescription: one of many\n---\n");
    const { body } = await skills(q("many"), { scopeOf: () => ({ provider: "claude", cwd }) });
    expect(body.skills).toHaveLength(SKILLS_MAX);
    expect(body.truncated).toBe(true);
  });

  it("skips an entry that cannot be read, and keeps the rest", async () => {
    const open = async (path: string, flags: number) => {
      if (path.includes(`${join("deploy", "SKILL.md")}`)) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return fsOpen(path, flags);
    };
    const { status, body } = await skills(q("shop"), { open });
    expect(status).toBe(200);
    expect(body.skills.some((s: { name: string }) => s.name === "deploy")).toBe(false);
    expect(body.skills.some((s: { name: string }) => s.name === "review")).toBe(true);
  });

  it("skips a SKILL.md that is a folder, has a NUL in it, or whose real path is another file", async () => {
    const cwd = join(DIR, "work", "odd");
    const root = join(cwd, ".claude", "skills");
    mkdirSync(join(root, "a-folder", "SKILL.md"), { recursive: true });
    skill(root, "nul", "---\nname: nul\u0000\n---\n");
    skill(root, "fine", "---\nname: fine\n---\n");
    const scopeOf = () => ({ provider: "claude", cwd });
    const plain = await skills(q("odd"), { scopeOf });
    expect(own(plain.body).map(s => (s as { name: string }).name)).toEqual(["fine"]);
    // Swapped between the open and the check: the real path names another file.
    const swapped = await skills(q("odd"), { scopeOf, realpath: async () => join(root, "fine", "README.md") });
    expect(swapped.body.skills).toEqual([]);
  });
});

describe("everything else gets the same 404", () => {
  it("a session the deck does not know, and a Codex session", async () => {
    for (const session of ["nobody", "codex"]) {
      const { status, body } = await skills(q(session));
      expect(status, session).toBe(404);
      expect(body, session).toEqual({ reason: "not_found" });
    }
  });
});

describe("the frontmatter", () => {
  it("gives only name and description, and nothing for a file that does not open with ---", () => {
    expect(skillFrontmatter("---\nname: a\ndescription: b\nother: c\n---\n")).toEqual({ name: "a", description: "b" });
    expect(skillFrontmatter("name: a\n")).toEqual({});
    expect(skillFrontmatter("---\nname: a\n")).toEqual({});
    expect(skillFrontmatter("---\nname:\n---\n")).toEqual({ name: "" });
    expect(skillFrontmatter('---\ndescription: "tab\\there"\n---\n')).toEqual({ description: "tab\there" });
    expect(skillFrontmatter("---\ndescription: >-\n  folded\n  strip\n...\n")).toEqual({ description: "folded strip" });
  });
});

// Links and pipes, at the top level so the skip register counts its cases.
// Windows cannot make a file symlink without a privilege and has no mkfifo;
// the route's other refusals run on all three legs.
describe.skipIf(process.platform === "win32")("links and pipes", () => {
  it("reads a skill folder that is a link, and refuses a SKILL.md linked to a file of another name", async () => {
    const cwd = join(DIR, "work", "linked");
    const root = join(cwd, ".claude", "skills");
    mkdirSync(root, { recursive: true });
    skill(join(DIR, "elsewhere"), "shared", "---\nname: shared\ndescription: linked in\n---\n");
    symlinkSync(join(DIR, "elsewhere", "shared"), join(root, "shared"));
    mkdirSync(join(root, "sneaky"), { recursive: true });
    writeFileSync(join(DIR, "id_rsa"), "-----BEGIN KEY-----\nname: key\n");
    symlinkSync(join(DIR, "id_rsa"), join(root, "sneaky", "SKILL.md"));
    const { body, text } = await skills(q("linked"), { scopeOf: () => ({ provider: "claude", cwd }) });
    expect(own(body)).toEqual([{ name: "shared", scope: "project", description: "linked in", path: join(root, "shared", "SKILL.md") }]);
    expect(text).not.toContain("BEGIN KEY");
  });

  it("skips a SKILL.md that is a FIFO without blocking on it", async () => {
    const cwd = join(DIR, "work", "piped");
    const root = join(cwd, ".claude", "skills");
    mkdirSync(join(root, "pipe"), { recursive: true });
    execFileSync("mkfifo", [join(root, "pipe", "SKILL.md")]);
    skill(root, "real", "---\nname: real\n---\n");
    const { status, body } = await skills(q("piped"), { scopeOf: () => ({ provider: "claude", cwd }) });
    expect(status).toBe(200);
    expect(own(body).map(s => (s as { name: string }).name)).toEqual(["real"]);
  });
});

describe("the scope the enrichment passes note", () => {
  it("is what the route reads, and goes when the session is forgotten", async () => {
    const { maybeResolveContext, forgetEnrichment } = enrichment;
    maybeResolveContext({ session_id: "inv-wired", transcript_path: join(DIR, "none.jsonl"), cwd: SHOP });
    const wired = await skills(q("inv-wired"), { scopeOf: undefined });
    expect(wired.status).toBe(200);
    expect(wired.body.skills.some((s: { name: string }) => s.name === "review")).toBe(true);
    forgetEnrichment("inv-wired");
    expect((await skills(q("inv-wired"), { scopeOf: undefined })).status).toBe(404);
  });
});

// ─── The MCP servers ────────────────────────────────────────────────────────

/** Everything a server's configuration may hold that must never leave the deck. */
const SECRETS = ["SECRET-CMD", "SECRET-ARG", "SECRET-ENV", "SECRET-URL", "SECRET-HEADER", "SECRET-OAUTH", "SECRET-EMAIL", "SECRET-OTHER-PROJECT"];
const secretServer = (n: string) => ({
  command: `/opt/SECRET-CMD-${n}`,
  args: ["--token", `SECRET-ARG-${n}`],
  env: { API_KEY: `SECRET-ENV-${n}` },
});
const STATE = {
  numStartups: 12,
  oauthAccount: { emailAddress: "SECRET-EMAIL@example.com", accountUuid: "SECRET-EMAIL-uuid" },
  mcpServers: {
    figma: { type: "http", url: "https://SECRET-URL.example/mcp", headers: { Authorization: "Bearer SECRET-HEADER" } },
    github: { ...secretServer("gh") },
    shadowed: { type: "sse", url: "https://SECRET-URL.example/sse" },
    "not-a-server": "SECRET-OTHER-PROJECT",
  },
  projects: {
    [SHOP]: {
      allowedTools: [],
      mcpServers: {
        "vcrm-local": { type: "http", url: "https://SECRET-URL.example/local", oauth: { clientId: "x", clientSecret: "SECRET-OAUTH" } },
        shadowed: { ...secretServer("local") },
      },
    },
    [join(DIR, "work", "elsewhere")]: { mcpServers: { "other-project": { command: "SECRET-OTHER-PROJECT" } } },
  },
};
const PROJECT_MCP = {
  mcpServers: {
    playwright: { type: "stdio", command: "npx", args: ["SECRET-ARG-pw"], env: { TOKEN: "SECRET-ENV-pw" } },
    sockets: { type: "ws", url: "wss://SECRET-URL.example/ws" },
    shadowed: { type: "http", url: "https://SECRET-URL.example/project" },
    odd: { type: "sdk" },
  },
};

describe("the MCP servers route's place in the server", () => {
  beforeAll(() => {
    writeFileSync(join(CONFIG, ".claude.json"), JSON.stringify(STATE));
    writeFileSync(join(SHOP, ".mcp.json"), JSON.stringify(PROJECT_MCP));
  });

  it("is a guarded read and is wired into the router through guard()", () => {
    expect(MCP_SERVERS_ROUTE).toBe("/api/session/mcp-servers");
    expect(GUARDED_READS.has(MCP_SERVERS_ROUTE)).toBe(true);
    const index = readFileSync(new URL("../../server/index.mjs", import.meta.url), "utf8");
    expect(index).toContain("if (url.pathname === MCP_SERVERS_ROUTE) return guard(handleSessionMcpServers(req, res), res);");
  });

  it("answers this computer only, reads only, and refuses a request of the wrong shape before anything is looked up", async () => {
    let asked = 0;
    const scopeOf = () => { asked++; return SCOPES.shop; };
    expect(await servers(q("shop"), { scopeOf }, "192.0.2.10").then(a => [a.status, a.body])).toEqual([403, { reason: "not_local" }]);
    for (const method of ["POST", "PUT", "DELETE"]) expect((await servers(q("shop"), { scopeOf }, "127.0.0.1", method)).status).toBe(405);
    for (const query of ["", "?session=shop&session=empty", "?session=shop&cwd=%2Fetc", "?session=..%2Fx"]) {
      expect(await servers(query, { scopeOf }).then(a => [a.status, a.body])).toEqual([400, { reason: "bad_session" }]);
    }
    expect(asked).toBe(0);
  });

  it("answers a session the deck does not know, and a Codex session, with the same 404", async () => {
    for (const session of ["nobody", "codex"]) {
      expect(await servers(q(session)).then(a => [a.status, a.body])).toEqual([404, { reason: "not_found" }]);
    }
  });
});

describe("the MCP servers", () => {
  beforeAll(() => {
    writeFileSync(join(CONFIG, ".claude.json"), JSON.stringify(STATE));
    writeFileSync(join(SHOP, ".mcp.json"), JSON.stringify(PROJECT_MCP));
  });

  it("are the user's, the project's local ones and its .mcp.json's, as name, scope and transport, never cached", async () => {
    const { status, body, headers } = await servers(q("shop"));
    expect(status).toBe(200);
    expect(headers["Cache-Control"]).toBe("no-store");
    expect(body).toEqual({
      servers: [
        { name: "figma", scope: "user", transport: "http" },
        { name: "github", scope: "user", transport: "stdio" },
        { name: "odd", scope: "project", transport: null },
        { name: "playwright", scope: "project", transport: "stdio" },
        // Set in all three places: the local one is the one Claude Code uses.
        { name: "shadowed", scope: "local", transport: "stdio" },
        { name: "sockets", scope: "project", transport: "ws" },
        { name: "vcrm-local", scope: "local", transport: "http" },
      ],
    });
  });

  it("never answers with a command, an argument, an environment, a URL, a header or a sign-in", async () => {
    const { text } = await servers(q("shop"));
    for (const secret of SECRETS) expect(text, secret).not.toContain(secret);
    expect(text).not.toMatch(/command|args|env|url|headers|oauth|https?:|wss?:/i);
  });

  it("reads another project's local servers as not this one's", async () => {
    const { body } = await servers(q("shop"));
    expect(body.servers.some((s: { name: string }) => s.name === "other-project")).toBe(false);
  });

  it("names the transport by type, stdio for a command with none", () => {
    expect(mcpTransport({ type: "http", url: "x" })).toBe("http");
    expect(mcpTransport({ type: "SSE" })).toBe("sse");
    expect(mcpTransport({ type: "sse-ide" })).toBe("sse");
    expect(mcpTransport({ type: "ws-ide" })).toBe("ws");
    expect(mcpTransport({ type: "stdio", command: "x" })).toBe("stdio");
    expect(mcpTransport({ command: "x" })).toBe("stdio");
    expect(mcpTransport({ url: "x" })).toBeNull();
    expect(mcpTransport({ type: "sdk" })).toBeNull();
  });

  it("is only the state file's servers for a project with no .mcp.json, and none at all with neither file", async () => {
    const { body } = await servers(q("empty"));
    expect(body.servers.map((s: { scope: string }) => s.scope)).toEqual(["user", "user", "user"]);
    const bare = await servers(q("empty"), { statePath: async () => join(DIR, "no-such", ".claude.json") });
    expect(bare.status).toBe(200);
    expect(bare.body).toEqual({ servers: [] });
  });

  it("follows CLAUDE_CONFIG_DIR to its .claude.json, and the home's when it is not set", async () => {
    writeFileSync(join(HOME, ".claude.json"), JSON.stringify({ mcpServers: { "home-only": { command: "x" } } }));
    const moved = await servers(q("empty"));
    expect(moved.body.servers.map((s: { name: string }) => s.name)).toEqual(["figma", "github", "shadowed"]);
    const kept = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
    try {
      const home = await servers(q("empty"));
      expect(home.body.servers).toEqual([{ name: "home-only", scope: "user", transport: "stdio" }]);
    } finally {
      process.env.CLAUDE_CONFIG_DIR = kept;
    }
  });

  it("treats a file over its cap, one that is not JSON, and one that is a folder as no servers", async () => {
    const cwd = join(DIR, "work", "capped");
    mkdirSync(cwd, { recursive: true });
    const scopeOf = () => ({ provider: "claude", cwd });
    const big = join(DIR, "big-state.json");
    // Valid JSON one byte past the cap.
    const pad = CLAUDE_JSON_MAX + 1 - JSON.stringify({ mcpServers: { big: { command: "x" } }, pad: "" }).length;
    writeFileSync(big, JSON.stringify({ mcpServers: { big: { command: "x" } }, pad: "x".repeat(pad) }));
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { huge: { command: "x" } }, pad: "x".repeat(MCP_JSON_MAX) }));
    expect((await servers(q("capped"), { scopeOf, statePath: async () => big })).body).toEqual({ servers: [] });
    writeFileSync(join(DIR, "broken.json"), "{ \"mcpServers\": { \"half\": ");
    writeFileSync(join(cwd, ".mcp.json"), "not json at all");
    expect((await servers(q("capped"), { scopeOf, statePath: async () => join(DIR, "broken.json") })).body).toEqual({ servers: [] });
    const folder = join(DIR, "work", "folder-mcp");
    mkdirSync(join(folder, ".mcp.json"), { recursive: true });
    const asFolder = await servers(q("folder"), { scopeOf: () => ({ provider: "claude", cwd: folder }), statePath: async () => join(DIR, "no-such.json") });
    expect(asFolder.status).toBe(200);
    expect(asFolder.body).toEqual({ servers: [] });
  });

  it("reads a file at its cap whole", async () => {
    const cwd = join(DIR, "work", "at-cap");
    mkdirSync(cwd, { recursive: true });
    const body = JSON.stringify({ mcpServers: { edge: { type: "http" } }, pad: "" });
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { edge: { type: "http" } }, pad: "x".repeat(MCP_JSON_MAX - body.length) }));
    const { body: answer } = await servers(q("at-cap"), { scopeOf: () => ({ provider: "claude", cwd }), statePath: async () => join(DIR, "no-such.json") });
    expect(answer).toEqual({ servers: [{ name: "edge", scope: "project", transport: "http" }] });
  });
});
