// #674. `payload.transcript_path` is a string in the body of `POST /api/event`,
// which is a deliberate OPEN_MUTATION — no token, no Origin, nothing — and the
// deck opened whatever it named by allocating the whole file: a `Buffer` of
// `stat().size` and then the string `toString` builds from it. Measured against
// a real deck on loopback with `process.memoryUsage.rss()` sampled every 5 ms,
// on Node 22.14 / macOS, every path sandboxed to a fresh mkdtemp:
//
//   700 MB file, one POST:   52MB -> 753MB RSS, answered 200 {"ok":true,"seq":1}
//   400 MB file, one POST:   51MB -> 848MB RSS  (2x — the Buffer AND the string;
//                                                700 MB is past V8's ~512 MB max
//                                                string, so that one paid 1x and
//                                                the toString threw)
//
// And it recurred. A chunk with no "\n" in it returned before the cursor was
// advanced, which is right for a transcript's half-written last line and wrong
// as a permanent state, so any file with no newline anywhere — any binary, a
// sparse file made for the purpose — was re-read from byte 0 on every later
// POST: 797MB, then 400MB, then 400MB for the same 400 MB file. Four posts
// naming four distinct such files peaked 1400MB above base; four naming ONE
// file did not stack, because `transcriptScanInFlight` is keyed by path and
// coalesced them.
//
// Three things hold it now, and this file pins each at the layer it lives at:
//
//   1. `isClaudeTranscriptPath` — an unrecognised path is not opened at all, so
//      the caller holding no credential can name nothing. Pure, so the cases
//      below are string comparisons.
//   2. `MAX_SCAN_CHUNK` — no single read allocates more than 8 MiB, whatever it
//      is pointed at. Asserted against one file of exactly that size plus a
//      tail, which costs a `ftruncate` and no data at all.
//   3. The cursor advances past a full chunk with no line boundary in it, and
//      does NOT advance past a partial last line at EOF. Those two are the same
//      early return, and telling them apart is the whole of the recurrence.
//
// The fourth thing is what must NOT have changed: a real transcript is large
// and is followed incrementally by design, so a pass that stopped at the first
// chunk would have made every first attach take one throttle window per 8 MiB.
// The last case here reads a transcript bigger than one chunk and requires the
// whole of it to be folded in a single pass.
//
// Bounded on purpose. The largest allocation any case here makes is one
// MAX_SCAN_CHUNK buffer, the largest file written with real bytes is 10 MiB,
// and the 8 MiB one is created with `ftruncate` and never written to — CI runs
// three OSes and other suites share the process.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync } from "node:fs";
import { get, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Everything below lives inside this temp directory, and all four variables are
// set BEFORE the dynamic import, because the server module resolves the Claude
// and Codex config directories from the environment. The developer's real
// ~/.claude and ~/.codex are never opened on any platform.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-read-bounds-"));
const prevEnv = { ...process.env };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");

// @ts-expect-error — .mjs server module, no types
const server_ = await import("../../server/index.mjs");
const {
  isClaudeTranscriptPath,
  readAppendedLines,
  readUsageFromTranscript,
  startServer,
  MAX_SCAN_CHUNK,
} = server_ as {
  isClaudeTranscriptPath(p: unknown, roots?: string[]): boolean;
  readAppendedLines(
    path: string,
    cursor: { offset: number; midLine?: boolean },
    size: number,
    chunkMax?: number,
  ): Promise<{ text: string; advanced: number }>;
  readUsageFromTranscript(path: string): Promise<{ input_tokens: number } | null>;
  startServer(opts: unknown): Promise<Server>;
  MAX_SCAN_CHUNK: number;
};

// Where Claude Code writes transcripts on this sandboxed machine.
const PROJECTS = join(DIR, "claude", "projects");
const SLUG = join(PROJECTS, "-tmp-bounds");

let server: Server;
let port = 0;

beforeAll(async () => {
  mkdirSync(SLUG, { recursive: true });
  server = await startServer({ port: 0, host: "127.0.0.1", persist: null, codex: false });
  port = (server.address() as AddressInfo).port;
}, 60_000);

afterAll(async () => {
  await new Promise<void>(done => {
    server.closeAllConnections?.();
    server.close(() => done());
  });
  for (const k of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  rmSync(DIR, { recursive: true, force: true });
});

/** A file of `size` bytes with nothing written into it — no newline anywhere,
 *  and on every filesystem that supports sparse files no blocks either. This is
 *  the shape the issue was reproduced with, and the reason a case can name 8 MiB
 *  without CI paying for 8 MiB. */
function hollowFile(path: string, size: number): string {
  const fd = openSync(path, "w");
  try { ftruncateSync(fd, size); } finally { closeSync(fd); }
  return path;
}

function assistantLine(inputTokens: number, filler = ""): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      model: "claude-opus-4-7",
      usage: {
        input_tokens: inputTokens, output_tokens: 0,
        cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      },
      content: filler,
    },
  }) + "\n";
}

function post(body: unknown): Promise<{ ok?: boolean; seq: number }> {
  return new Promise((res, rej) => {
    // No x-ccdeck-token, no Origin, no Sec-Fetch-Site: exactly the credential-
    // free shape OPEN_MUTATIONS lets through, and the shape the issue used.
    const req = request(
      { host: "127.0.0.1", port, path: "/api/event", method: "POST", headers: { "Content-Type": "application/json" } },
      r => {
        let out = "";
        r.setEncoding("utf8");
        r.on("data", c => { out += c; });
        r.on("end", () => { try { res(JSON.parse(out)); } catch (e) { rej(e); } });
      },
    );
    req.on("error", rej);
    req.end(JSON.stringify(body));
  });
}

type Envelope = { seq: number; payload: { session_id?: string; hook_event_name?: string } };

function since(seq: number): Promise<Envelope[]> {
  return new Promise((res, rej) => {
    get({ host: "127.0.0.1", port, path: `/api/events?since=${seq}` }, r => {
      let out = "";
      r.setEncoding("utf8");
      r.on("data", c => { out += c; });
      r.on("end", () => { try { res(JSON.parse(out)); } catch (e) { rej(e); } });
    }).on("error", rej);
  });
}

const OBSERVED = new Set(["ModelObserved", "UsageObserved", "ContextObserved", "SessionNamed"]);

/** Every enrichment event the deck pushed for `sid` after `seq`. Empty means
 *  the transcript was never read. */
async function enrichments(sid: string, seq: number): Promise<string[]> {
  return (await since(seq))
    .filter(e => e.payload?.session_id === sid && OBSERVED.has(e.payload?.hook_event_name ?? ""))
    .map(e => e.payload.hook_event_name as string);
}

/** Post one hook event and give the fire-and-forget scans time to push. The
 *  positive case waits for an actual event, so this only has to be long enough
 *  for the NEGATIVE case to be trusted — a scan that was going to happen has
 *  finished long before this returns. */
async function pollFor(sid: string, seq: number, want: number, tries = 200): Promise<string[]> {
  let seen: string[] = [];
  for (let i = 0; i < tries; i++) {
    seen = await enrichments(sid, seq);
    if (seen.length >= want) return seen;
    await new Promise(r => setTimeout(r, 25));
  }
  return seen;
}

describe("the paths the deck will follow a posted transcript_path into", () => {
  const main = join(SLUG, "0199-abcd.jsonl");
  const subagent = join(SLUG, "0199-abcd", "subagents", "agent-1f2e.jsonl");

  it("accepts a session transcript and its subagent transcripts", () => {
    expect(isClaudeTranscriptPath(main)).toBe(true);
    expect(isClaudeTranscriptPath(subagent)).toBe(true);
  });

  it("refuses a path anywhere else on the machine, whatever it is called", () => {
    // The issue's own one-liner, and the same file renamed to look the part.
    expect(isClaudeTranscriptPath(join(DIR, "bait.bin"))).toBe(false);
    expect(isClaudeTranscriptPath(join(DIR, "bait.jsonl"))).toBe(false);
    expect(isClaudeTranscriptPath(resolve("/etc/passwd"))).toBe(false);
    // Inside the config dir but not inside projects/ — the credentials file and
    // the discovery file with HOOK_TOKEN in it both live there.
    expect(isClaudeTranscriptPath(join(DIR, "claude", "agent-dag", "deck.jsonl"))).toBe(false);
  });

  it("refuses a sibling directory that merely starts with the root's name", () => {
    // A plain `startsWith` on the root with no separator would accept this.
    expect(isClaudeTranscriptPath(join(DIR, "claude", "projects-of-mine", "x.jsonl"))).toBe(false);
  });

  it("refuses a path that climbs back out of projects/", () => {
    expect(isClaudeTranscriptPath(join(PROJECTS, "..", "..", "bait.jsonl"))).toBe(false);
    expect(isClaudeTranscriptPath(join(SLUG, "..", "..", "..", "big.jsonl"))).toBe(false);
  });

  it("refuses the projects directory itself, and anything that is not a .jsonl", () => {
    expect(isClaudeTranscriptPath(PROJECTS)).toBe(false);
    expect(isClaudeTranscriptPath(join(SLUG, "huge.bin"))).toBe(false);
    expect(isClaudeTranscriptPath(join(SLUG, "core.dump"))).toBe(false);
  });

  it("refuses anything that is not a path at all", () => {
    for (const bad of [undefined, null, "", 0, 42, {}, [], true]) {
      expect(isClaudeTranscriptPath(bad)).toBe(false);
    }
  });

  it("still accepts the default location when CLAUDE_CONFIG_DIR moved the config dir", () => {
    // The two roots exist because the deck reads the variable from its OWN
    // environment while the path is written by whatever `claude` process the
    // hook fired in, and a deck launched from a desktop shortcut is a real way
    // for those to disagree. Driven through the injected roots so the case says
    // what it means without moving the process's environment underneath the
    // running server.
    const roots = [resolve(DIR, "elsewhere", "projects"), resolve(DIR, ".claude", "projects")];
    expect(isClaudeTranscriptPath(join(DIR, ".claude", "projects", "s", "a.jsonl"), roots)).toBe(true);
    expect(isClaudeTranscriptPath(join(DIR, "elsewhere", "projects", "s", "a.jsonl"), roots)).toBe(true);
    expect(isClaudeTranscriptPath(join(DIR, "somewhere-else", "s", "a.jsonl"), roots)).toBe(false);
  });
});

describe("the ceiling on one read", () => {
  it("never advances further than MAX_SCAN_CHUNK, whatever the file's size", async () => {
    // A file one chunk and a bit long, with no newline anywhere in it — the
    // shape that used to be allocated whole and then re-read whole forever.
    // `ftruncate` only, so this names 8 MiB of file and costs no bytes.
    const path = hollowFile(join(SLUG, "hollow.jsonl"), MAX_SCAN_CHUNK + 4096);
    const size = statSync(path).size;
    const cursor = { offset: 0, midLine: false };

    const first = await readAppendedLines(path, cursor, size);
    expect(first.advanced).toBe(MAX_SCAN_CHUNK);
    expect(first.text).toBe("");
    expect(cursor.offset).toBe(MAX_SCAN_CHUNK);

    // The tail is what a partial last line looks like, so the cursor waits.
    // What matters is that it is waiting 8 MiB in and not at byte 0.
    const second = await readAppendedLines(path, cursor, size);
    expect(second.advanced).toBe(0);
    expect(cursor.offset).toBe(MAX_SCAN_CHUNK);
  }, 60_000);

  it("clamps a caller that asks for more than the ceiling, rather than obeying it", async () => {
    // The ceiling lives in the read itself, not in the arithmetic of the one
    // caller that happens to compute a window today. Asking for four chunks has
    // to come back with one — that is what stops a call site added later from
    // reintroducing `Buffer.alloc(stat().size)` by passing the file's size in.
    const path = hollowFile(join(SLUG, "hollow-clamped.jsonl"), MAX_SCAN_CHUNK * 3);
    const size = statSync(path).size;
    const cursor = { offset: 0, midLine: false };

    const step = await readAppendedLines(path, cursor, size, MAX_SCAN_CHUNK * 4);
    expect(step.advanced).toBe(MAX_SCAN_CHUNK);
    expect(cursor.offset).toBe(MAX_SCAN_CHUNK);
  }, 60_000);
});

describe("the cursor, on a chunk with no line boundary in it", () => {
  it("advances past a full chunk rather than reading it again forever", async () => {
    // 300 bytes, no newline, walked with a 32-byte ceiling. Under the defect
    // every one of these calls returned `advanced: 0` with the cursor at zero,
    // which is the whole of "every later POST re-reads the whole file".
    const path = hollowFile(join(SLUG, "no-newline.jsonl"), 300);
    const cursor = { offset: 0, midLine: false };
    const size = statSync(path).size;

    const seen: number[] = [];
    for (let i = 0; i < 20; i++) {
      const { advanced } = await readAppendedLines(path, cursor, size, 32);
      if (advanced === 0) break;
      seen.push(advanced);
      expect(advanced).toBeLessThanOrEqual(32);
    }
    // Nine full chunks of 32 bytes; the 12-byte remainder is at EOF and is
    // treated as a last line still being written, so it is left alone.
    expect(seen.length).toBe(9);
    expect(cursor.offset).toBe(288);
    expect(cursor.midLine).toBe(true);
  });

  it("does NOT advance past a partial last line, which is a transcript being written", async () => {
    // The same early return, and the case it is right for. A chunk that ends at
    // EOF with no newline is half a line the session has not finished writing;
    // consuming it would fold a fragment and lose the line.
    const path = join(SLUG, "partial.jsonl");
    writeFileSync(path, '{"type":"assistant"}\n{"type":"user"');
    const cursor = { offset: 0, midLine: false };

    const first = await readAppendedLines(path, cursor, statSync(path).size);
    expect(first.text).toBe('{"type":"assistant"}');
    const at = cursor.offset;

    const second = await readAppendedLines(path, cursor, statSync(path).size);
    expect(second.advanced).toBe(0);
    expect(cursor.offset).toBe(at);

    // …and once the newline lands, the whole line arrives exactly once.
    writeFileSync(path, '{"type":"assistant"}\n{"type":"user"}\n');
    const third = await readAppendedLines(path, cursor, statSync(path).size);
    expect(third.text).toBe('{"type":"user"}');
  });

  it("resyncs on the next line boundary instead of folding a fragment", async () => {
    // A line longer than the ceiling cannot be folded — there is nowhere to put
    // it — so it is walked past. What must not happen is the REST of that line
    // arriving as if it were a line of its own: a fragment of JSON carrying a
    // `"usage"` block would be counted as a message that never existed.
    const long = `{"skip":"${"x".repeat(200)}"}\n`;
    const path = join(SLUG, "overlong.jsonl");
    writeFileSync(path, long + '{"type":"user"}\n{"type":"assistant"}\n');
    const cursor = { offset: 0, midLine: false };
    const size = statSync(path).size;

    const folded: string[] = [];
    for (let i = 0; i < 40; i++) {
      const { text, advanced } = await readAppendedLines(path, cursor, size, 64);
      if (advanced === 0) break;
      for (const l of text.split("\n")) if (l) folded.push(l);
    }
    expect(folded).toEqual(['{"type":"user"}', '{"type":"assistant"}']);
    expect(cursor.offset).toBe(size);
  });

  it("counts the cursor in bytes, so a multi-byte character on a boundary cannot drift it", async () => {
    // The advance used to be `Buffer.byteLength(consumedText)`, which is exact
    // only while the text decodes cleanly. Chunking splits characters, and a
    // split character decodes to a replacement character of a different width —
    // so measuring the advance on the string would slide the cursor a byte or
    // two per chunk and every later line would be folded from the wrong offset.
    const lines = [
      '{"type":"user","text":"日本語のテキスト"}',
      '{"type":"assistant","text":"émoji 🙂 ✅ и кириллица"}',
      '{"type":"user","text":"ascii"}',
    ];
    const path = join(SLUG, "utf8.jsonl");
    writeFileSync(path, lines.join("\n") + "\n", "utf8");
    const size = statSync(path).size;
    const longest = Math.max(...lines.map(l => Buffer.byteLength(l, "utf8")));

    // Every ceiling from one byte up to comfortably past the longest line, so
    // that each multi-byte sequence in the file is split by some ceiling and
    // then decoded from the wrong side of the split.
    for (let chunkMax = 1; chunkMax <= longest + 16; chunkMax++) {
      const cursor = { offset: 0, midLine: false };
      const folded: string[] = [];
      for (let i = 0; i < 1000; i++) {
        const { text, advanced } = await readAppendedLines(path, cursor, size, chunkMax);
        if (advanced === 0) break;
        for (const l of text.split("\n")) if (l) folded.push(l);
      }
      expect(cursor.offset, `chunkMax=${chunkMax} left the cursor at ${cursor.offset} of ${size}`).toBe(size);
      // A ceiling below the longest line drops the lines it cannot hold, but
      // every line it DOES fold must be whole and must be one of the file's.
      // A drifting cursor shows up here as half a line: `type":"user",…`.
      for (const l of folded) expect(lines, `chunkMax=${chunkMax} folded a fragment: ${l}`).toContain(l);
      // And once the ceiling clears the longest line, nothing is dropped at all.
      if (chunkMax > longest) {
        expect(folded, `chunkMax=${chunkMax} did not fold every line`).toEqual(lines);
      }
    }
  }, 60_000);
});

describe("what the legitimate path still gets", () => {
  it("folds a transcript larger than one chunk in a single pass", async () => {
    // The bound must not have become a rate limit. A real transcript reaches
    // tens of megabytes and the first pass has all of it to fold; stopping at
    // MAX_SCAN_CHUNK would mean one 2500 ms throttle window per 8 MiB before
    // the deck could show a model, a name or a cost — the O(n)-per-pass stall
    // #611 removed, reintroduced from the other end.
    const path = join(SLUG, "big-real.jsonl");
    const line = assistantLine(1, "y".repeat(900));
    const perBlock = 1024;
    const block = line.repeat(perBlock);
    const blocks = Math.ceil((MAX_SCAN_CHUNK + MAX_SCAN_CHUNK / 4) / block.length);
    writeFileSync(path, block.repeat(blocks), "utf8");
    expect(statSync(path).size).toBeGreaterThan(MAX_SCAN_CHUNK);

    const usage = await readUsageFromTranscript(path);
    expect(usage?.input_tokens).toBe(blocks * perBlock);

    // And the cursor is where it should be: a second pass adds nothing.
    expect((await readUsageFromTranscript(path))?.input_tokens).toBe(blocks * perBlock);
  }, 120_000);
});

describe("a credential-free POST naming a file outside the transcript directory", () => {
  it("is answered, and the file is never read", async () => {
    // The same bytes in two places. Inside projects/ the deck folds them and
    // pushes what it learned; outside, with no token and no Origin, it must
    // push nothing — which is the only observable that says the file was not
    // opened, and the one that does not need a memory measurement to see.
    const body = assistantLine(7) + JSON.stringify({ type: "agent-name", agentName: "n" }) + "\n";

    const inside = join(SLUG, "reachable.jsonl");
    writeFileSync(inside, body, "utf8");
    const outside = join(DIR, "unreachable.jsonl");
    writeFileSync(outside, body, "utf8");

    const a = await post({ hook_event_name: "PreToolUse", session_id: "sid-inside", cwd: DIR, transcript_path: inside });
    expect(a.ok).toBe(true);
    expect(await pollFor("sid-inside", a.seq - 1, 1)).not.toHaveLength(0);

    const b = await post({ hook_event_name: "PreToolUse", session_id: "sid-outside", cwd: DIR, transcript_path: outside });
    // The event itself is still accepted — the session still draws on the
    // canvas, which is exactly what OPEN_MUTATIONS says the worst case is.
    expect(b.ok).toBe(true);
    expect(await pollFor("sid-outside", b.seq - 1, 1, 40)).toEqual([]);
  }, 60_000);
});
