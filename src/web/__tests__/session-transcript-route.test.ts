// GET /api/session/transcript (session-transcript-routes.mjs): a read-only view
// of one Claude session's last turns. The id is a key into what the deck
// already knows and never a path; the file is read only if it is a regular
// file in the projects folder, from its end, and at most one window of it.
// A page holding the file's version is answered `unchanged` after one stat;
// older windows come by cursor, which is held to the file as it is now.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
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
const { handleSessionTranscript, LOOKAHEAD, READ_WINDOW, SESSION_TRANSCRIPT_ROUTE } = routes;
/** The shape of the route's version and of a cursor's file tag. */
const VERSION = /^[A-Za-z0-9_-]{22}$/;

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
    ["unknown provider", "?session=a&provider=other"],
    ["two providers", "?session=a&provider=claude&provider=codex"],
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
    expect(body).toEqual({ ok: true, complete: true, turns: [{ kind: "user", text: "hello" }, { kind: "assistant", text: "hi there" }], version: expect.stringMatching(VERSION) });
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
    // No `older` either: a cursor that cannot move back is not given.
    expect(body).toEqual({ ok: true, complete: false, turns: [], version: expect.stringMatching(VERSION) });
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

/** What the route did to the file: stats, opens and bytes read. */
async function counted(path: string) {
  const fs = await import("node:fs/promises");
  const seen = { lstat: 0, realpath: 0, open: 0, bytes: 0 };
  const io = {
    ...known(path),
    lstat: (p: string, o: unknown) => { seen.lstat++; return fs.lstat(p, o as never); },
    realpath: (p: string) => { seen.realpath++; return fs.realpath(p); },
    open: async (p: string, flags: number) => {
      seen.open++;
      const handle = await fs.open(p, flags);
      const read = handle.read.bind(handle) as (...a: unknown[]) => Promise<{ bytesRead: number }>;
      (handle as unknown as { read: unknown }).read = async (...a: unknown[]) => {
        const got = await read(...a);
        seen.bytes += got.bytesRead;
        return got;
      };
      return handle;
    },
  };
  return { seen, io };
}

describe("live: the version a page holds", () => {
  it("answers unchanged after one stat: nothing opened, read or parsed", async () => {
    const path = file("live.jsonl", [user("one"), said("two")].join("\n") + "\n");
    const first = await call("?session=known", known(path));
    expect(first.body.version).toMatch(VERSION);
    const { seen, io } = await counted(path);
    expect(await call(`?session=known&since=${first.body.version}`, io)).toEqual({ status: 200, body: { ok: true, unchanged: true } });
    expect(seen).toEqual({ lstat: 1, realpath: 0, open: 0, bytes: 0 });
  });

  it("answers the window again, with a new version, once the file grew", async () => {
    const path = file("grows.jsonl", user("one") + "\n");
    const first = await call("?session=known", known(path));
    appendFileSync(path, said("two") + "\n");
    const { body } = await call(`?session=known&since=${first.body.version}`, known(path));
    expect(body.unchanged).toBeUndefined();
    expect(body.turns).toEqual([{ kind: "user", text: "one" }, { kind: "assistant", text: "two" }]);
    expect(body.version).toMatch(VERSION);
    expect(body.version).not.toBe(first.body.version);
  });

  it("answers a version from before the file was replaced with the window, never unchanged", async () => {
    const path = file("swap.jsonl", user("one") + "\n");
    const first = await call("?session=known", known(path));
    const next = join(PROJECTS, "swap.next");
    writeFileSync(next, user("one") + "\n");
    renameSync(next, path);
    const { body } = await call(`?session=known&since=${first.body.version}`, known(path));
    expect(body.turns).toEqual([{ kind: "user", text: "one" }]);
    expect(body.version).not.toBe(first.body.version);
  });

  const v = "A".repeat(22);
  const bad: Array<[string, string]> = [
    ["of the wrong shape", "?session=a&since=abc"],
    ["empty", "?session=a&since="],
    ["too long", `?session=a&since=${v}A`],
    ["with a continuation", `?session=13aaaaaa-1111-4111-8111-111111111111&continuation=1&since=${v}`],
  ];
  for (const [name, query] of bad) {
    it(`refuses a since ${name}: 400 bad_since, nothing looked up`, async () => {
      const { seen, io } = spies("/never.jsonl");
      expect(await call(query, io)).toEqual({ status: 400, body: { ok: false, reason: "bad_since" } });
      expect(seen).toEqual({ pathOf: 0, lstat: 0, open: 0, allowed: 0 });
    });
  }

  it("refuses two since parameters as any repeated parameter is", async () => {
    const { seen, io } = spies("/never.jsonl");
    expect(await call(`?session=a&since=${v}&since=${v}`, io)).toEqual({ status: 400, body: { ok: false, reason: "bad_session" } });
    expect(seen).toEqual({ pathOf: 0, lstat: 0, open: 0, allowed: 0 });
  });
});

/** Follows `older` from the live window to the file's start: every page's body, newest first. */
async function pages(path: string, io: Record<string, unknown> = known(path), limit = 20) {
  const got = [(await call("?session=known", io)).body];
  while (got.at(-1).older) {
    if (got.length > limit) throw new Error("the cursors never reached the start");
    const page = await call(`?session=known&before=${got.at(-1).older}`, io);
    expect(page.status).toBe(200);
    got.push(page.body);
  }
  return got;
}

const texts = (bodies: Array<{ turns: Array<{ text?: string }> }>) => bodies.slice().reverse().flatMap(b => b.turns.map(t => t.text));

describe("older windows, by cursor", () => {
  it("pages back over the turn cap to the start, whole lines, nothing missing or repeated", async () => {
    const path = file("cap-pages.jsonl", Array.from({ length: 230 }, (_, i) => user(`m${i}`)).join("\n") + "\n");
    const [live, older, ...rest] = await pages(path);
    expect(rest).toEqual([]);
    expect(live.complete).toBe(false);
    expect(live.turns).toHaveLength(200);
    expect(live.turns[0].text).toBe("m30");
    expect(live.older).toMatch(new RegExp(`^[1-9][0-9]*\\.${VERSION.source.slice(1, -1)}$`));
    expect(older.complete).toBe(true);
    expect(older.older).toBeUndefined();
    expect(older.turns.map((t: { text: string }) => t.text)).toEqual(Array.from({ length: 30 }, (_, i) => `m${i}`));
  });

  it("pages back through byte windows to the start, reading about one window each", async () => {
    const count = 160;
    const path = file("byte-pages.jsonl", Array.from({ length: count }, (_, i) => said(`turn ${i} ${"z".repeat(10_000)}`)).join("\n") + "\n");
    const { seen, io } = await counted(path);
    const bodies = await pages(path, io);
    expect(bodies.length).toBeGreaterThanOrEqual(4);
    expect(bodies.at(-1).complete).toBe(true);
    for (const body of bodies.slice(0, -1)) expect(body.complete).toBe(false);
    const numbers = texts(bodies).map(text => Number(/^turn (\d+) /.exec(text ?? "")?.[1]));
    expect(numbers).toEqual(Array.from({ length: count }, (_, i) => i));
    // One window each, a look past an older one's end, and a byte to check its cursor.
    expect(seen.bytes).toBeLessThanOrEqual(bodies.length * READ_WINDOW + (bodies.length - 1) * (LOOKAHEAD + 1));
  });

  it("stops a window at its after line: the stretch a live window slid past, and no cursor beyond it", async () => {
    const path = file("slid.jsonl", Array.from({ length: 230 }, (_, i) => user(`m${i}`)).join("\n") + "\n");
    const before = (await call("?session=known", known(path))).body.older;
    appendFileSync(path, Array.from({ length: 50 }, (_, i) => user(`m${230 + i}`)).join("\n") + "\n");
    const live = (await call("?session=known", known(path))).body;
    expect(live.turns[0].text).toBe("m80");
    const gap = await call(`?session=known&before=${live.older}&after=${before}`, known(path));
    expect(gap.status).toBe(200);
    expect(gap.body.complete).toBe(true);
    expect(gap.body.older).toBeUndefined();
    expect(gap.body.turns.map((t: { text: string }) => t.text)).toEqual(Array.from({ length: 50 }, (_, i) => `m${30 + i}`));
  });

  it("reads the answer to a call at a window's end from the line after it, so the call is not left running", async () => {
    const lines = [
      ...Array.from({ length: 29 }, (_, i) => user(`m${i}`)),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "boom" }] } }),
      ...Array.from({ length: 200 }, (_, i) => user(`n${i}`)),
    ];
    const path = file("answer-after.jsonl", lines.join("\n") + "\n");
    const [live, older] = await pages(path);
    expect(live.turns[0].text).toBe("n0");
    expect(older.turns.at(-1)).toEqual({ kind: "tool", name: "Bash", arg: "ls", error: "boom" });
  });

  it("draws nothing in an older window as still running", async () => {
    const call1 = (id: string, file: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Read", input: { file_path: file } }] } });
    const answer = (id: string) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
    // Two calls side by side: the window boundary falls between them, and the
    // first one's answer comes after the second call, in the live window.
    const lines = [
      ...Array.from({ length: 29 }, (_, i) => user(`m${i}`)),
      call1("a", "a.ts"), call1("b", "b.ts"), answer("a"), answer("b"),
      ...Array.from({ length: 199 }, (_, i) => user(`n${i}`)),
    ];
    const path = file("side-by-side.jsonl", lines.join("\n") + "\n");
    const [live, older] = await pages(path);
    expect(live.turns[0]).toEqual({ kind: "tool", name: "Read", arg: "b.ts" });
    expect(older.turns.at(-1)).toEqual({ kind: "tool", name: "Read", arg: "a.ts" });
  });

  it("pages a Codex rollout the same way", async () => {
    const roots = () => [join(DIR, "codex", "sessions")];
    const day = join(roots()[0], "2026", "11", "19");
    mkdirSync(day, { recursive: true });
    const path = join(day, "rollout-2026-11-19T12-00-00-known.jsonl");
    writeFileSync(path, Array.from({ length: 230 }, (_, i) => JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: `c${i}` } })).join("\n") + "\n");
    const io = { ...known(path), roots };
    const live = (await call("?session=known&provider=codex", io)).body;
    expect(live.turns[0].text).toBe("c30");
    const older = (await call(`?session=known&provider=codex&before=${live.older}`, io)).body;
    expect(older.complete).toBe(true);
    expect(older.turns.map((t: { text: string }) => t.text)).toEqual(Array.from({ length: 30 }, (_, i) => `c${i}`));
  });
});

describe("a cursor is held to the file as it is now", () => {
  const tag = "B".repeat(22);
  const shapes: Array<[string, string]> = [
    ["not a cursor", "?session=a&before=abc"],
    ["offset zero", `?session=a&before=0.${tag}`],
    ["a negative offset", `?session=a&before=-1.${tag}`],
    ["an exponent", `?session=a&before=1e3.${tag}`],
    ["a leading zero", `?session=a&before=01.${tag}`],
    ["an offset past 2^53", `?session=a&before=9999999999999999.${tag}`],
    ["seventeen digits", `?session=a&before=12345678901234567.${tag}`],
    ["a short tag", `?session=a&before=12.${"B".repeat(21)}`],
    ["a path for a tag", `?session=a&before=12.${encodeURIComponent("../../etc/passwd")}`],
    ["after with no before", `?session=a&after=12.${tag}`],
    ["before with since", `?session=a&before=12.${tag}&since=${tag}`],
    ["before with a continuation", `?session=13aaaaaa-1111-4111-8111-111111111111&continuation=1&before=12.${tag}`],
    ["after at before", `?session=a&before=12.${tag}&after=12.${tag}`],
    ["after past before", `?session=a&before=12.${tag}&after=40.${tag}`],
    ["after of another file", `?session=a&before=40.${tag}&after=12.${"C".repeat(22)}`],
    ["after of the wrong shape", `?session=a&before=40.${tag}&after=x`],
  ];
  for (const [name, query] of shapes) {
    it(`${name}: 400 bad_cursor, nothing looked up`, async () => {
      const { seen, io } = spies("/never.jsonl");
      expect(await call(query, io)).toEqual({ status: 400, body: { ok: false, reason: "bad_cursor" } });
      expect(seen).toEqual({ pathOf: 0, lstat: 0, open: 0, allowed: 0 });
    });
  }

  it("refuses two before parameters as any repeated parameter is", async () => {
    const { seen, io } = spies("/never.jsonl");
    expect((await call(`?session=a&before=12.${tag}&before=13.${tag}`, io)).body).toEqual({ ok: false, reason: "bad_session" });
    expect(seen).toEqual({ pathOf: 0, lstat: 0, open: 0, allowed: 0 });
  });

  const stale = { status: 400, body: { ok: false, reason: "stale_cursor" } };
  const many = (name: string) => file(name, Array.from({ length: 230 }, (_, i) => user(`m${i}`)).join("\n") + "\n");

  it("refuses an offset past the file's end, and one inside a line", async () => {
    const path = many("range.jsonl");
    const older: string = (await call("?session=known", known(path))).body.older;
    const [at, fileTag] = older.split(".");
    expect(await call(`?session=known&before=${10 ** 9}.${fileTag}`, known(path))).toEqual(stale);
    expect(await call(`?session=known&before=${Number(at) + 3}.${fileTag}`, known(path))).toEqual(stale);
    expect(await call(`?session=known&before=${older}&after=${Number(at) - 3}.${fileTag}`, known(path))).toEqual(stale);
  });

  it("refuses another file's cursor", async () => {
    const mine = many("mine.jsonl");
    const theirs = many("theirs.jsonl");
    const older = (await call("?session=known", known(theirs))).body.older;
    expect(await call(`?session=known&before=${older}`, known(mine))).toEqual(stale);
  });

  it("refuses a cursor once the file was replaced, even with the same bytes", async () => {
    const path = many("replaced.jsonl");
    const older = (await call("?session=known", known(path))).body.older;
    expect((await call(`?session=known&before=${older}`, known(path))).status).toBe(200);
    const next = join(PROJECTS, "replaced.next");
    writeFileSync(next, readFileSync(path));
    renameSync(next, path);
    expect(await call(`?session=known&before=${older}`, known(path))).toEqual(stale);
  });

  it("says nothing about a file it will not read, whatever the cursor", async () => {
    const path = join(OUTSIDE, "outside-cursor.jsonl");
    writeFileSync(path, user("secret") + "\n");
    expect(await call(`?session=known&before=12.${tag}`, known(path))).toEqual(refused);
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

describe("Codex Chat", () => {
  const event = (payload: object) => JSON.stringify({ type: "event_msg", payload });
  const item = (type: string, content: unknown) => event({ type: "item_completed", item: { type, content } });
  const roots = () => [join(DIR, "codex", "sessions")];
  const day = join(roots()[0], "2026", "11", "18");
  const path = join(day, "rollout-2026-11-18T12-00-00-known.jsonl");
  const query = "?session=known&provider=codex";

  it("reads modern and legacy conversation events without exposing injected context or duplicate items", async () => {
    mkdirSync(day, { recursive: true });
    writeFileSync(path, [
      event({ type: "user_message", message: "Legacy prompt" }),
      event({ type: "agent_message", message: "Legacy answer" }),
      item("UserMessage", [{ type: "text", text: "Current prompt" }]),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Injected context" }] } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Current answer" }] } }),
      item("AgentMessage", "Current answer"),
      item("Reasoning", [{ type: "text", text: "Internal reasoning" }]),
    ].join("\n") + "\n");
    expect(await call(query, { ...known(path), roots })).toEqual({
      status: 200,
      body: { ok: true, complete: true, turns: [
        { kind: "user", text: "Legacy prompt" },
        { kind: "assistant", text: "Legacy answer" },
        { kind: "user", text: "Current prompt" },
        { kind: "assistant", text: "Current answer" },
      ], version: expect.stringMatching(VERSION) },
    });
  });

  it("refuses a different rollout ID or an unauthorized root", async () => {
    mkdirSync(day, { recursive: true });
    const other = path.replace("-known.jsonl", "-other.jsonl");
    writeFileSync(other, "");
    writeFileSync(path, "");
    expect((await call(query, { ...known(other), roots })).status).toBe(404);
    expect((await call(query, { ...known(path), roots: () => [OUTSIDE] })).status).toBe(404);
  });
});

describe("Claude foreground-to-background continuation", () => {
  const original = "13aaaaaa-1111-4111-8111-111111111111";
  const moved = "23bbbbbb-2222-4222-8222-222222222222";
  const query = `?session=${original}&continuation=1`;
  const event = (sessionId: string, continuedInSessionId: string) =>
    JSON.stringify({ type: "continued-in", sessionId, continuedInSessionId });

  it("returns the link before the background worker writes a transcript", async () => {
    const source = file(`${original}.jsonl`, event(original, moved));
    const destination = file(`${moved}.jsonl`, said("The turn continued."));
    expect(await call(query, { pathOf: (id: string) => id === original ? source : undefined }))
      .toEqual({ status: 200, body: { ok: true, sessionId: moved } });
    expect(await call(query, { pathOf: (id: string) => id === original ? source : destination }))
      .toEqual({ status: 200, body: { ok: true, sessionId: moved } });
  });

  it("ignores another session's event and rejects a link outside the project", async () => {
    const source = file(`${original}.jsonl`, event(moved, moved));
    const destination = file(`${moved}.jsonl`, said("Another turn."));
    expect((await call(query, { pathOf: (id: string) => id === original ? source : destination })).body.sessionId).toBeNull();
    writeFileSync(source, event(original, moved));
    const otherProject = join(PROJECTS, "..", "other");
    mkdirSync(otherProject, { recursive: true });
    const other = join(otherProject, `${moved}.jsonl`);
    writeFileSync(other, said("An unrelated project."));
    expect((await call(query, { pathOf: (id: string) => id === original ? source : other })).body.sessionId).toBeNull();
  });
});
