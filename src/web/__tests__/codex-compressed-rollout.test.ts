// Codex compresses cold rollouts, and this deck reads the Codex home.
//
// openai/codex 0.153.0 added a background worker that rewrites any rollout older
// than seven days as `rollout-….jsonl.zst`. Its own source states the
// consequence plainly — "Requires every reader of the Codex home to support
// compressed shared histories" — and the deck is one of those readers.
//
// The flag is still `default_enabled: false` upstream, so nothing on disk has
// changed yet. This is here BEFORE it does, because of the shape the failure
// would have had: a collector matching only `.jsonl` would have skipped every
// day past the seventh in silence, and the 30-day Codex usage window would have
// quietly collapsed to the last seven with figures that still looked right. A
// wrong money number that never errors is the exact class of bug this file
// exists to prevent.
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zlib from "node:zlib";

/** Node 22.15 brought zstd to node:zlib. CI runs `node-version: 22`, which
 *  resolves to the newest 22.x, so the real round trip below runs on all three
 *  operating systems; a developer on an older runtime reaches the refusal
 *  instead.
 *
 *  Branching INSIDE one case rather than two `runIf`s, deliberately. A skipped
 *  case and a passing one are the same green tick, and this repo keeps a
 *  register of every conditional gate for exactly that reason (skip-gates.mjs).
 *  One case that always runs and asserts whichever half is reachable needs no
 *  entry in it and cannot quietly stop running. */
const HAS_ZSTD = typeof (zlib as { zstdCompressSync?: unknown }).zstdCompressSync === "function";

const source = readFileSync(new URL("../../server/codex-usage.mjs", import.meta.url), "utf8");
/** The same source with its prose removed. This file's own comment explains
 *  why `zstdDecompressSync` was NOT used, so a check for its absence that read
 *  the comments would fail on the sentence saying it is absent. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the collector accepts a compressed rollout", () => {
  it("matches both spellings, not just the plain one", () => {
    // The whole bug in one line: `if (!f.endsWith(".jsonl")) continue`.
    expect(source).toMatch(/!f\.endsWith\("\.jsonl"\) && !f\.endsWith\(COMPRESSED\)/);
  });

  it("knows the suffix Codex actually writes", () => {
    expect(source).toContain('const COMPRESSED = ".jsonl.zst";');
  });

  it("leaves the timestamp parsing alone, because the name still carries it", () => {
    // `rollout-2026-06-17T12-39-01-<uuid>.jsonl.zst` still starts with the
    // stamp parseRolloutTime reads, so nothing downstream has to know.
    expect(source).toMatch(/\^rollout-\(\\d\{4\}\)-\(\\d\{2\}\)-\(\\d\{2\}\)T/);
  });
});

describe("reading one", () => {
  const rollout = (tokens: number) => [
    JSON.stringify({ timestamp: "2026-06-17T12:39:01.000Z", type: "session_meta" }),
    JSON.stringify({
      timestamp: "2026-06-17T12:40:00.000Z", type: "event_msg",
      payload: { type: "token_count", info: { total_token_usage: {
        input_tokens: tokens, output_tokens: 10, cached_input_tokens: 0, total_tokens: tokens + 10 } } },
    }),
  ].join("\n") + "\n";

  it("reads a compressed rollout exactly as it reads a plain one", async () => {
    const { readTokenSeriesForTest } = await import("../../server/codex-usage.mjs") as never;
    const dir = mkdtempSync(join(tmpdir(), "codex-zst-"));
    const packed = join(dir, "rollout-2026-06-17T12-39-01-bbbb.jsonl.zst");

    if (!HAS_ZSTD) {
      // The dangerous outcome is not "cannot read" — it is "read nothing and
      // looked healthy". A deck on an older runtime prints one line to the
      // terminal it was started from and leaves those sessions out; it does not
      // report a week's usage as the month's.
      writeFileSync(packed, Buffer.from([0x28, 0xb5, 0x2f, 0xfd]));
      expect(await readTokenSeriesForTest(packed)).toBeNull();
      expect(source).toMatch(/cannot read Codex's compressed/);
      return;
    }

    const plain = join(dir, "rollout-2026-06-17T12-39-01-aaaa.jsonl");
    writeFileSync(plain, rollout(500));
    writeFileSync(packed, (zlib as never as { zstdCompressSync(b: Buffer): Buffer })
      .zstdCompressSync(Buffer.from(rollout(500), "utf8")));
    const fromPacked = await readTokenSeriesForTest(packed);
    expect(fromPacked).toEqual(await readTokenSeriesForTest(plain));
    expect(fromPacked, "the compressed file produced nothing at all").not.toBeNull();
  });

  it("streams it rather than decompressing the whole file into memory", () => {
    // The plain path reads a chunk at a time precisely so a megabyte of prompt
    // text is never buffered. Trading that for a one-line `zstdDecompressSync`
    // would swap a silent undercount for a memory spike.
    expect(code).toContain("createZstdDecompress()");
    expect(code, "the whole file is being buffered").not.toContain("zstdDecompressSync");
  });
});
