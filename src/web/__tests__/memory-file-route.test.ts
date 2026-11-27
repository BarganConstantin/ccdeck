// GET /api/session/memory-file (memory-file-route.mjs): one memory file a
// session has in scope, read-only. The path in the request is only a name to
// look up in the memory scan run again now; what is opened is the listed path.
// Everything refused after the request is well formed gets the same 404, so
// the route never says which files exist. At most 256 KiB is read.
//
// A home, a Claude config dir and a Codex home of this file's own: nothing
// here reaches the real ~/.claude or ~/.codex.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { open as fsOpen } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-memory-file-route-"));
const HOME = join(DIR, "home");
const CONFIG = join(HOME, ".claude");
const CODEX = join(DIR, "codex-home");
const PREV = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
};
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
// The config dir is the home's .claude, so `~/.claude/CLAUDE.md` names the
// user file the scan lists.
process.env.CLAUDE_CONFIG_DIR = CONFIG;
process.env.CODEX_HOME = CODEX;

const SHOP = join(DIR, "work", "shop");
const LINKED = join(DIR, "work", "linked");
const BADLINK = join(DIR, "work", "badlink");
const CODEX_REPO = join(DIR, "work", "codex-repo");

// @ts-expect-error — server module, untyped by design (tsconfig.build.json)
const route = await import("../../server/memory-file-route.mjs");
// @ts-expect-error — server module, untyped by design (tsconfig.build.json)
const { GUARDED_READS } = await import("../../server/request-gates.mjs");
// @ts-expect-error — server module, untyped by design (tsconfig.build.json)
const enrichment = await import("../../server/session-enrichment.mjs");
// @ts-expect-error — server module, untyped by design (tsconfig.build.json)
const { ccProjectSlug } = await import("../../server/claude-dir.mjs");
const { handleMemoryFile, MEMORY_FILE_MAX, MEMORY_FILE_ROUTE, wholeUtf8 } = route;

type Scope = { provider: "claude" | "codex"; cwd: string; codexHome?: string };
const SCOPES: Record<string, Scope> = {
  shop: { provider: "claude", cwd: SHOP },
  linked: { provider: "claude", cwd: LINKED },
  badlink: { provider: "claude", cwd: BADLINK },
  codex: { provider: "codex", cwd: CODEX_REPO, codexHome: CODEX },
};

interface Answer { status: number; body: any; headers: Record<string, string> }

function call(query: string, io: Record<string, unknown> = {}, remoteAddress = "127.0.0.1", method = "GET"): Promise<Answer> {
  const req = { method, url: `${MEMORY_FILE_ROUTE}${query}`, headers: {}, socket: { remoteAddress } };
  let status = 0, text = "", headers: Record<string, string> = {};
  const res = {
    headersSent: false,
    writeHead: (s: number, h: Record<string, string>) => { status = s; headers = h; },
    end: (s: string) => { text = s; },
  };
  return handleMemoryFile(req, res, { scopeOf: (sid: string) => SCOPES[sid] ?? null, ...io })
    .then(() => ({ status, body: JSON.parse(text), headers }));
}
const q = (session: string, path: string, provider?: string) =>
  `?${new URLSearchParams({ session, ...(provider ? { provider } : {}), path })}`;

const autoDir = () => join(CONFIG, "projects", ccProjectSlug(SHOP), "memory");

beforeAll(() => {
  for (const dir of [join(SHOP, ".claude"), LINKED, BADLINK, CODEX_REPO, CONFIG, CODEX]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(SHOP, "CLAUDE.md"), "# Shop\n\nUse pnpm. <b>not html</b>\n");
  writeFileSync(join(SHOP, "CLAUDE.local.md"), "local notes\n");
  writeFileSync(join(SHOP, ".claude", "CLAUDE.md"), "dot claude\n");
  writeFileSync(join(SHOP, "README.md"), "not a memory file\n");
  writeFileSync(join(CONFIG, "CLAUDE.md"), "user rules\n");
  writeFileSync(join(CONFIG, "CLAUDE.local.md"), "user local\n");
  mkdirSync(autoDir(), { recursive: true });
  writeFileSync(join(autoDir(), "MEMORY.md"), "- [a note](note.md)\n");
  writeFileSync(join(CODEX_REPO, "AGENTS.md"), "codex project rules\n");
  writeFileSync(join(CODEX, "AGENTS.md"), "codex user rules\n");
});
afterAll(() => {
  for (const [k, v] of Object.entries(PREV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmTempDir(DIR);
});

describe("the route's place in the server", () => {
  it("is a guarded read and is wired into the router through guard()", () => {
    expect(MEMORY_FILE_ROUTE).toBe("/api/session/memory-file");
    expect(GUARDED_READS.has(MEMORY_FILE_ROUTE)).toBe(true);
    const index = readFileSync(new URL("../../server/index.mjs", import.meta.url), "utf8");
    expect(index).toContain("if (url.pathname === MEMORY_FILE_ROUTE) return guard(handleMemoryFile(req, res), res);");
  });

  it("answers this computer only, before it looks anything up", async () => {
    let asked = 0;
    const { status } = await call(q("shop", join(SHOP, "CLAUDE.md")), { scopeOf: () => { asked++; return SCOPES.shop; } }, "192.0.2.10");
    expect(status).toBe(403);
    expect(asked).toBe(0);
  });

  it("only reads", async () => {
    for (const method of ["POST", "PUT", "DELETE"]) {
      expect((await call(q("shop", join(SHOP, "CLAUDE.md")), {}, "127.0.0.1", method)).status).toBe(405);
    }
  });
});

describe("a request of the wrong shape is refused before anything is looked up", () => {
  const good = join(SHOP, "CLAUDE.md");
  const bad: Array<[string, string, string]> = [
    ["two sessions", `?session=shop&session=linked&path=${encodeURIComponent(good)}`, "bad_session"],
    ["two paths", `?session=shop&path=${encodeURIComponent(good)}&path=x`, "bad_session"],
    ["an unknown key", `?session=shop&path=${encodeURIComponent(good)}&since=1`, "bad_session"],
    ["no session", `?path=${encodeURIComponent(good)}`, "bad_session"],
    ["a path in the session", `?session=..%2Fx&path=${encodeURIComponent(good)}`, "bad_session"],
    ["a dot in the session", `?session=a.md&path=${encodeURIComponent(good)}`, "bad_session"],
    ["another provider", `?session=shop&provider=opencode&path=${encodeURIComponent(good)}`, "bad_session"],
    ["no path", "?session=shop", "bad_path"],
    ["an empty path", "?session=shop&path=", "bad_path"],
    ["a path over 4096 characters", `?session=shop&path=${"a".repeat(4097)}`, "bad_path"],
  ];
  for (const [name, query, reason] of bad) {
    it(`${name}: 400 ${reason}`, async () => {
      let asked = 0;
      const { status, body } = await call(query, { scopeOf: () => { asked++; return SCOPES.shop; } });
      expect(status).toBe(400);
      expect(body).toEqual({ reason });
      expect(asked).toBe(0);
    });
  }
});

describe("a listed file", () => {
  it("is answered with its path, name, scope, size and text, never cached", async () => {
    const { status, body, headers } = await call(q("shop", join(SHOP, "CLAUDE.md")));
    expect(status).toBe(200);
    const text = "# Shop\n\nUse pnpm. <b>not html</b>\n";
    expect(body).toEqual({ path: join(SHOP, "CLAUDE.md"), name: "CLAUDE.md", scope: "project", bytes: Buffer.byteLength(text), text, truncated: false });
    expect(headers["Cache-Control"]).toBe("no-store");
  });

  it("is found by `~/` and the rest under the home directory, as /context prints a user file", async () => {
    const { status, body } = await call(q("shop", "~/.claude/CLAUDE.md"));
    expect(status).toBe(200);
    expect(body).toMatchObject({ path: join(CONFIG, "CLAUDE.md"), name: "CLAUDE.md", scope: "user", text: "user rules\n" });
  });

  it("says which kind of memory file it is", async () => {
    const scopes: Array<[string, string]> = [
      [join(SHOP, "CLAUDE.md"), "project"],
      [join(SHOP, ".claude", "CLAUDE.md"), "project"],
      [join(SHOP, "CLAUDE.local.md"), "local"],
      [join(CONFIG, "CLAUDE.md"), "user"],
      [join(CONFIG, "CLAUDE.local.md"), "user"],
      [join(autoDir(), "MEMORY.md"), "auto"],
    ];
    for (const [path, scope] of scopes) {
      const { status, body } = await call(q("shop", path));
      expect(status, path).toBe(200);
      expect(body.scope, path).toBe(scope);
    }
  });

  it("is cut at 256 KiB, back to the last whole character, and says so", async () => {
    // A two-byte é straddles the cut: its first byte is the 262,144th.
    const big = `${"a".repeat(MEMORY_FILE_MAX - 1)}é${"b".repeat(100)}`;
    writeFileSync(join(LINKED, "CLAUDE.md"), big);
    const { status, body } = await call(q("linked", join(LINKED, "CLAUDE.md")));
    expect(status).toBe(200);
    expect(body.truncated).toBe(true);
    expect(body.bytes).toBe(Buffer.byteLength(big));
    expect(body.text).toBe("a".repeat(MEMORY_FILE_MAX - 1));
    // A file of exactly the limit is whole.
    writeFileSync(join(LINKED, "CLAUDE.md"), "x".repeat(MEMORY_FILE_MAX));
    const exact = await call(q("linked", join(LINKED, "CLAUDE.md")));
    expect(exact.body).toMatchObject({ truncated: false, bytes: MEMORY_FILE_MAX });
    expect(exact.body.text).toHaveLength(MEMORY_FILE_MAX);
  });

  it("keeps a character the cut did not split", () => {
    const at = (s: string) => wholeUtf8(Buffer.from(s, "utf8")).toString("utf8");
    expect(at("abc")).toBe("abc");
    expect(at("ab€")).toBe("ab€");
    expect(wholeUtf8(Buffer.from("ab€", "utf8").subarray(0, 4)).toString("utf8")).toBe("ab");
    expect(wholeUtf8(Buffer.from("a😀", "utf8").subarray(0, 4)).toString("utf8")).toBe("a");
    expect(wholeUtf8(Buffer.from("a😀", "utf8")).toString("utf8")).toBe("a😀");
  });

  it("is a Codex session's AGENTS.md, the project's and the Codex home's", async () => {
    const project = await call(q("codex", join(CODEX_REPO, "AGENTS.md"), "codex"));
    expect(project.status).toBe(200);
    expect(project.body).toMatchObject({ name: "AGENTS.md", scope: "project", text: "codex project rules\n" });
    const user = await call(q("codex", join(CODEX, "AGENTS.md"), "codex"));
    expect(user.body).toMatchObject({ path: join(CODEX, "AGENTS.md"), scope: "user", text: "codex user rules\n" });
    // Asked as the other CLI's session, it is not this session's file.
    expect((await call(q("codex", join(CODEX_REPO, "AGENTS.md")))).status).toBe(404);
    expect((await call(q("shop", join(SHOP, "CLAUDE.md"), "codex"))).status).toBe(404);
  });
});

describe("everything else gets the same 404", () => {
  const NOT_FOUND = { reason: "not_found" };
  const refused = async (query: string, io: Record<string, unknown> = {}) => {
    const { status, body } = await call(query, io);
    expect(status, query).toBe(404);
    expect(body, query).toEqual(NOT_FOUND);
  };

  it("a session the deck does not know", async () => {
    await refused(q("nobody", join(SHOP, "CLAUDE.md")));
  });

  it("a path the scan does not list, however it is written", async () => {
    await refused(q("shop", join(SHOP, "README.md")));
    await refused(q("shop", "/etc/passwd"));
    await refused(q("shop", "CLAUDE.md"));
    await refused(q("shop", `${SHOP}/./CLAUDE.md`));
    await refused(q("shop", `${SHOP}/../shop/CLAUDE.md`));
    await refused(q("shop", "~/../../etc/passwd"));
    await refused(q("shop", "~/.claude/settings.json"));
    // Another session's file is not this one's.
    await refused(q("linked", join(SHOP, "CLAUDE.md")));
  });

  it("a file with a NUL byte in it", async () => {
    writeFileSync(join(BADLINK, "CLAUDE.md"), "text\u0000more");
    await refused(q("badlink", join(BADLINK, "CLAUDE.md")));
  });

  it("a file gone, or swapped for a folder, between the scan and the open", async () => {
    await refused(q("shop", join(SHOP, "CLAUDE.md")), { open: async () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); } });
    await refused(q("shop", join(SHOP, "CLAUDE.md")), { open: (_: string, flags: number) => fsOpen(SHOP, flags) });
  });

  it("a real path that is not the file that was opened", async () => {
    await refused(q("shop", join(SHOP, "CLAUDE.md")), { realpath: async () => join(SHOP, "CLAUDE.local.md") });
  });
});

describe.skipIf(process.platform === "win32")("links", () => {
  it("reads a CLAUDE.md that is a link to AGENTS.md", async () => {
    const dir = join(DIR, "work", "agents-link");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "AGENTS.md"), "shared rules\n");
    symlinkSync(join(dir, "AGENTS.md"), join(dir, "CLAUDE.md"));
    const { status, body } = await call(q("link", join(dir, "CLAUDE.md")), { scopeOf: () => ({ provider: "claude", cwd: dir }) });
    expect(status).toBe(200);
    expect(body).toMatchObject({ path: join(dir, "CLAUDE.md"), name: "CLAUDE.md", scope: "project", text: "shared rules\n" });
  });

  it("refuses a CLAUDE.md that is a link to a file that is not markdown", async () => {
    const dir = join(DIR, "work", "secret-link");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "id_rsa"), "-----BEGIN KEY-----\n");
    symlinkSync(join(dir, "id_rsa"), join(dir, "CLAUDE.md"));
    const { status, body } = await call(q("link", join(dir, "CLAUDE.md")), { scopeOf: () => ({ provider: "claude", cwd: dir }) });
    expect(status).toBe(404);
    expect(body).toEqual({ reason: "not_found" });
  });
});

describe("the scope the enrichment passes note", () => {
  it("is what the route reads, and goes when the session is forgotten", async () => {
    const { maybeResolveCodexMemory, maybeResolveContext, forgetEnrichment, memoryScope } = enrichment;
    expect(memoryScope("wired-claude")).toBeNull();
    maybeResolveContext({ session_id: "wired-claude", transcript_path: join(DIR, "none.jsonl"), cwd: SHOP });
    maybeResolveCodexMemory("wired-codex", CODEX_REPO, false, CODEX);
    expect(memoryScope("wired-claude")).toEqual({ provider: "claude", cwd: SHOP });
    expect(memoryScope("wired-codex")).toEqual({ provider: "codex", cwd: CODEX_REPO, codexHome: CODEX });
    // The route's own lookup, not this file's stand-in.
    const claude = await call(q("wired-claude", join(SHOP, "CLAUDE.md")), { scopeOf: undefined });
    expect(claude.status).toBe(200);
    const codex = await call(q("wired-codex", join(CODEX_REPO, "AGENTS.md"), "codex"), { scopeOf: undefined });
    expect(codex.status).toBe(200);
    forgetEnrichment("wired-claude");
    forgetEnrichment("wired-codex");
    expect(memoryScope("wired-claude")).toBeNull();
    expect((await call(q("wired-claude", join(SHOP, "CLAUDE.md")), { scopeOf: undefined })).status).toBe(404);
  });
});
