// GET /api/session/transcript (session-transcript-routes.mjs): a read-only view
// of one Claude session's last turns. The id is a key into what the deck
// already knows and never a path; the file is read only if it is a regular
// file in the projects folder, from its end, and at most one window of it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-transcript-route-"));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
const PROJECTS = join(DIR, "claude", "projects", "work");
const OUTSIDE = join(DIR, "outside");

// @ts-expect-error — server module, untyped by design (tsconfig.build.json)
const routes = await import("../../server/session-transcript-routes.mjs");
// @ts-expect-error — server module, untyped by design (tsconfig.build.json)
const { GUARDED_READS } = await import("../../server/request-gates.mjs");
const { handleSessionTranscript, READ_WINDOW, SESSION_TRANSCRIPT_ROUTE } = routes;

function call(query: string, io: Record<string, unknown> = {}, remoteAddress = "127.0.0.1", method = "GET") {
  const req = { method, url: `${SESSION_TRANSCRIPT_ROUTE}${query}`, headers: {}, socket: { remoteAddress } };
  let status = 0, text = "";
  const res = { headersSent: false, writeHead: (s: number) => { status = s; }, end: (s: string) => { text = s; } };
  return handleSessionTranscript(req, res, io).then(() => ({ status, body: JSON.parse(text) }));
}

/** Stand-ins that say if anything was looked up, stat'ed or opened. */
function spies(path?: string) {
  const seen = { pathOf: 0, lstat: 0, open: 0, allowed: 0 };
  return {
    seen,
    io: {
      pathOf: () => { seen.pathOf++; return path; },
      lstat: async () => { seen.lstat++; throw new Error("not expected"); },
      open: async () => { seen.open++; throw new Error("not expected"); },
      isTranscriptPath: () => { seen.allowed++; return true; },
    },
  };
}

const user = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: text } });
const said = (text: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });

beforeAll(() => {
  mkdirSync(PROJECTS, { recursive: true });
  mkdirSync(OUTSIDE, { recursive: true });
});
afterAll(() => rmTempDir(DIR));

describe("the route's place in the server", () => {
  it("is a guarded read and is wired into the router through guard()", () => {
    expect(GUARDED_READS.has(SESSION_TRANSCRIPT_ROUTE)).toBe(true);
    expect(SESSION_TRANSCRIPT_ROUTE).toBe("/api/session/transcript");
    const index = readFileSync(new URL("../../server/index.mjs", import.meta.url), "utf8");
    expect(index).toContain("if (url.pathname === SESSION_TRANSCRIPT_ROUTE) return guard(handleSessionTranscript(req, res), res);");
  });

  it("answers this computer only", async () => {
    const { seen, io } = spies("/x.jsonl");
    const { status } = await call("?session=abc", io, "192.0.2.10");
    expect(status).toBe(403);
    expect(seen).toEqual({ pathOf: 0, lstat: 0, open: 0, allowed: 0 });
  });

  it("only reads", async () => {
    const { seen, io } = spies("/x.jsonl");
    for (const method of ["POST", "PUT", "DELETE"]) expect((await call("?session=abc", io, "127.0.0.1", method)).status).toBe(405);
    expect(seen).toEqual({ pathOf: 0, lstat: 0, open: 0, allowed: 0 });
  });
});

describe("a path put in the id is refused before anything is looked up", () => {
  const long = "a".repeat(129);
  const bad: Array<[string, string]> = [
    ["parent folder", "?session=../x"],
    ["two dots", "?session=.."],
    ["absolute path", `?session=${encodeURIComponent("/etc/passwd")}`],
    ["a slash", `?session=${encodeURIComponent("a/b")}`],
    ["a Windows path", `?session=${encodeURIComponent("C:\\x")}`],
    ["a backslash", `?session=${encodeURIComponent("a\\b")}`],
    ["a NUL", "?session=a%00b"],
    ["a space", "?session=a%20b"],
    ["a dot", "?session=a.jsonl"],
    ["a leading dash", "?session=-a"],
    ["129 characters", `?session=${long}`],
    ["empty", "?session="],
    ["none", ""],
    ["two session parameters", "?session=a&session=b"],
    ["an extra parameter", "?session=a&path=/etc/passwd"],
    ["only another parameter", "?path=/etc/passwd"],
  ];
  for (const [name, query] of bad) {
    it(`${name}: 400 bad_session, nothing looked up, stat'ed or opened`, async () => {
      const { seen, io } = spies("/never.jsonl");
      const { status, body } = await call(query, io);
      expect(status).toBe(400);
      expect(body).toEqual({ ok: false, reason: "bad_session" });
      expect(seen).toEqual({ pathOf: 0, lstat: 0, open: 0, allowed: 0 });
    });
  }

  it("accepts an id of the shape a session has, and only then asks for a path", async () => {
    const { seen, io } = spies(undefined);
    const { status } = await call("?session=0d9c6f3e-1b2a-4c5d-8e7f-aabbccddeeff", io);
    expect(status).toBe(404);
    expect(seen).toEqual({ pathOf: 1, lstat: 0, open: 0, allowed: 0 });
    expect((await call(`?session=${"a".repeat(128)}`, spies(undefined).io)).status).toBe(404);
  });
});

const file = (name: string, text: string | Buffer) => { const p = join(PROJECTS, name); writeFileSync(p, text); return p; };
const known = (path: string) => ({ pathOf: (sid: string) => (sid === "known" ? path : undefined) });
const refused = { status: 404, body: { ok: false, reason: "unknown_session" } };

describe("the file it reads", () => {
  it("answers a known session's turns", async () => {
    const path = file("known.jsonl", [user("hello"), said("hi there")].join("\n") + "\n");
    const { status, body } = await call("?session=known", known(path));
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, complete: true, turns: [{ kind: "user", text: "hello" }, { kind: "assistant", text: "hi there" }] });
  });

  it("answers an unknown id exactly as it answers a refused file", async () => {
    expect(await call("?session=nobody", known(join(PROJECTS, "known.jsonl")))).toEqual(refused);
  });

  it("refuses a stored path outside the projects folder", async () => {
    const path = join(OUTSIDE, "other.jsonl");
    writeFileSync(path, user("secret") + "\n");
    expect(await call("?session=known", known(path))).toEqual(refused);
  });

  it("refuses a file that is not a transcript by name", async () => {
    const path = file("notes.txt", user("x") + "\n");
    expect(await call("?session=known", known(path))).toEqual(refused);
  });

  it("refuses a folder", async () => {
    const dir = join(PROJECTS, "folder.jsonl");
    mkdirSync(dir);
    expect(await call("?session=known", known(dir))).toEqual(refused);
  });

  it("refuses a file swapped for another between the stat and the open", async () => {
    const a = file("a.jsonl", user("a") + "\n");
    const b = file("b.jsonl", user("b") + "\n");
    const { open } = await import("node:fs/promises");
    const io = { ...known(a), open: (_p: string, flags: number) => open(b, flags) };
    expect(await call("?session=known", io)).toEqual(refused);
  });

  it("reads no more than the window from the end, and says the start is missing", async () => {
    const line = said("x".repeat(1000));
    const count = Math.ceil((READ_WINDOW * 3) / (line.length + 1));
    const path = file("big.jsonl", Array.from({ length: count }, () => line).join("\n") + "\n");
    let asked = 0;
    const { open } = await import("node:fs/promises");
    const io = {
      ...known(path),
      open: async (p: string, flags: number) => {
        const handle = await open(p, flags);
        const read = handle.read.bind(handle) as (...a: unknown[]) => Promise<{ bytesRead: number }>;
        (handle as unknown as { read: unknown }).read = async (...a: unknown[]) => {
          const got = await read(...a);
          asked += got.bytesRead;
          return got;
        };
        return handle;
      },
    };
    const { status, body } = await call("?session=known", io);
    expect(status).toBe(200);
    expect(body.complete).toBe(false);
    expect(body.turns.length).toBeGreaterThan(0);
    expect(body.turns.length).toBeLessThanOrEqual(200);
    expect(asked).toBeGreaterThan(0);
    expect(asked).toBeLessThanOrEqual(READ_WINDOW);
  });

  it("gives no turn for one line longer than the window, and never grows the read", async () => {
    const path = file("one-line.jsonl", user("y".repeat(READ_WINDOW * 2)) + "\n");
    const { status, body } = await call("?session=known", known(path));
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, complete: false, turns: [] });
  });

  it("says the start is missing when the 200-turn cap dropped turns, though the whole file was read", async () => {
    const path = file("many.jsonl", Array.from({ length: 230 }, (_, i) => user(`m${i}`)).join("\n") + "\n");
    const { body } = await call("?session=known", known(path));
    expect(body.complete).toBe(false);
    expect(body.turns).toHaveLength(200);
    expect(body.turns[0].text).toBe("m30");
    const few = file("few.jsonl", Array.from({ length: 200 }, (_, i) => user(`m${i}`)).join("\n") + "\n");
    expect((await call("?session=known", known(few))).body.complete).toBe(true);
  });

  it("drops the partial first line of a cut read", async () => {
    const lines = Array.from({ length: 700 }, (_, i) => said(`turn ${i} ${"z".repeat(1000)}`));
    const path = file("cut.jsonl", lines.join("\n") + "\n");
    const { body } = await call("?session=known", known(path));
    expect(body.complete).toBe(false);
    const first = body.turns[0].text as string;
    expect(first).toMatch(/^turn \d+ z{1000}$/);
    expect(body.turns.at(-1).text).toMatch(/^turn 699 /);
  });
});

// Links and pipes, at the top level so the skip register counts its cases. A
// file symlink needs a privilege on Windows, which the CI runner there lacks,
// and Windows has no mkfifo: the block skips there, as the suite's other
// symlink tests do. On macOS and Linux a case that cannot make its link or pipe
// fails rather than passing unchecked.
describe.skipIf(process.platform === "win32")("links and pipes", () => {
  it("refuses a file that is itself a symlink, even to a file outside", async () => {
    const target = join(OUTSIDE, "target.jsonl");
    writeFileSync(target, user("secret") + "\n");
    const link = join(PROJECTS, "link.jsonl");
    symlinkSync(target, link);
    expect(await call("?session=known", known(link))).toEqual(refused);
  });

  it("refuses a file reached through a symlinked folder inside projects", async () => {
    writeFileSync(join(OUTSIDE, "evil.jsonl"), user("secret") + "\n");
    const folder = join(PROJECTS, "linked-folder");
    symlinkSync(OUTSIDE, folder, "dir");
    expect(await call("?session=known", known(join(folder, "evil.jsonl")))).toEqual(refused);
  });

  it("refuses a `..` after a symlinked folder, which the kernel resolves through the link", async () => {
    mkdirSync(join(OUTSIDE, "deep"), { recursive: true });
    writeFileSync(join(OUTSIDE, "evil2.jsonl"), user("secret") + "\n");
    const folder = join(PROJECTS, "deep-link");
    symlinkSync(join(OUTSIDE, "deep"), folder, "dir");
    // Read as text it is <projects>/work/evil2.jsonl; the kernel goes up from the link's target.
    expect(await call("?session=known", known(`${folder}/../evil2.jsonl`))).toEqual(refused);
  });

  it("still reads a transcript when the projects folder itself is reached through a link", async () => {
    // ~/.claude is often a link: the roots are resolved too, so a real file under it is read.
    const real = join(DIR, "real-config", "projects", "w");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "ok.jsonl"), user("fine") + "\n");
    const config = join(DIR, "config-link");
    symlinkSync(join(DIR, "real-config"), config, "dir");
    // The first gate is stood in for: it is the real-path check that is under test.
    const io = { ...known(join(config, "projects", "w", "ok.jsonl")), isTranscriptPath: () => true, roots: () => [join(config, "projects")] };
    expect((await call("?session=known", io)).body.turns).toEqual([{ kind: "user", text: "fine" }]);
  });

  it("refuses a FIFO, and never blocks on opening it", async () => {
    const fifo = join(PROJECTS, "pipe.jsonl");
    execFileSync("mkfifo", [fifo]);
    const opened: string[] = [];
    const io = {
      ...known(fifo),
      open: async (...args: unknown[]) => { opened.push(String(args[0])); throw new Error("must not open"); },
    };
    expect(await call("?session=known", io)).toEqual(refused);
    expect(opened).toEqual([]);
    // And with the real open, which would block on a pipe with no writer if it were reached.
    expect(await call("?session=known", known(fifo))).toEqual(refused);
  });

  it("opens a pipe without blocking when the stat was fooled, and the handle's own stat refuses it", async () => {
    const fifo = join(PROJECTS, "swapped-pipe.jsonl");
    execFileSync("mkfifo", [fifo]);
    const fooled = async () => ({ isFile: () => true, dev: 0n, ino: 0n });
    expect(await call("?session=known", { ...known(fifo), lstat: fooled })).toEqual(refused);
  });
});
