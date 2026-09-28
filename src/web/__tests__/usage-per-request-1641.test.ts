// #1641: one API request is billed once, however many content blocks it was
// answered in.
//
// Claude Code writes one assistant line per content block of a response —
// thinking, text, each tool call — and each of those lines carries the whole
// request's `usage`, with `apiBlockIndex` counting the blocks from 0. The
// transcript scan summed every line, so a request answered in three blocks was
// counted three times: in the session's totals, in the per-model split the cost
// is priced from, and in every subagent file folded into them. Measured across
// forty real transcripts, the sum came to 1.94x the request-by-request total.
//
// The cases below are one request as Claude Code writes it, the same request
// followed by a second one, the records an older Claude Code wrote without the
// field (which must go on counting as they did), a subagent's file, and the
// model and context readings that come off the same lines and must not move.
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

// @ts-expect-error — plain .mjs server module, no types
const enrichment = await import("../../server/session-enrichment.mjs");
const { sessionUsageTotals, sessionUsageByModel, readModelFromTranscript, readContextFromTranscript } = enrichment as {
  sessionUsageTotals(p: string): Promise<Record<string, number> | null>;
  sessionUsageByModel(p: string): Promise<Record<string, Record<string, number>> | null>;
  readModelFromTranscript(p: string): Promise<{ rootModel: string | null } | null>;
  readContextFromTranscript(p: string): Promise<{ currentContextTokens: number } | null>;
};

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-usage-per-request-"));
afterAll(() => rmTempDir(DIR));

const USAGE = {
  input_tokens: 10, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 300,
  cache_creation: { ephemeral_1h_input_tokens: 300, ephemeral_5m_input_tokens: 0 },
};
/** The totals one USAGE block adds, in the shape the scan reports. */
const ONCE = {
  input_tokens: 10, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 300,
  ephemeral_1h_input_tokens: 300, ephemeral_5m_input_tokens: 0,
};
const times = (n: number) => Object.fromEntries(Object.entries(ONCE).map(([k, v]) => [k, v * n]));

/** One request answered in `kinds.length` content blocks, one line per block,
 *  as Claude Code writes it. `index: false` leaves the field off, as a version
 *  from before it existed did. */
function request(id: string, kinds: string[], { model = "claude-opus-4-7", index = true } = {}): string {
  return kinds.map((kind, i) => JSON.stringify({
    type: "assistant", requestId: `req_${id}`, ...(index ? { apiBlockIndex: i } : {}),
    timestamp: "2026-09-28T10:00:00Z",
    message: { id: `msg_${id}`, model, usage: USAGE, content: [{ type: kind }] },
  }) + "\n").join("");
}

let n = 0;
function transcript(body: string): string {
  const path = join(DIR, `session-${++n}.jsonl`);
  writeFileSync(path, body);
  return path;
}

describe("a request answered in several content blocks", () => {
  it("is counted once in the session's totals", async () => {
    const path = transcript(request("1", ["thinking", "text", "tool_use"]));
    expect(await sessionUsageTotals(path)).toEqual(ONCE);
  });

  it("is counted once in the per-model split the cost is priced from", async () => {
    const path = transcript(request("1", ["thinking", "text", "tool_use"]));
    expect(await sessionUsageByModel(path)).toEqual({ "claude-opus-4-7": ONCE });
  });

  it("and the next request is counted once more, under its own model", async () => {
    const path = transcript(
      request("1", ["thinking", "tool_use"]) + request("2", ["text", "tool_use", "tool_use"], { model: "claude-sonnet-5" }),
    );
    expect(await sessionUsageTotals(path)).toEqual(times(2));
    expect(await sessionUsageByModel(path)).toEqual({ "claude-opus-4-7": ONCE, "claude-sonnet-5": ONCE });
  });

  it("still names the model and the context window off those same lines", async () => {
    const path = transcript(request("1", ["thinking", "text", "tool_use"]));
    expect((await readModelFromTranscript(path))?.rootModel).toBe("claude-opus-4-7");
    // The window is the last usage block's reading, which a repeat restates
    // rather than adds to — so it is one request's input side either way.
    expect((await readContextFromTranscript(path))?.currentContextTokens).toBe(10 + 5000 + 300);
  });
});

describe("records written before Claude Code marked its blocks", () => {
  it("are counted line by line, as they always were", async () => {
    const path = transcript(request("1", ["text", "tool_use"], { index: false }));
    expect(await sessionUsageTotals(path)).toEqual(times(2));
  });
});

describe("a subagent's transcript", () => {
  it("bills each of its requests once too, in the session's delegated spend", async () => {
    const main = join(DIR, "with-agent.jsonl");
    writeFileSync(main, request("m", ["text"]));
    mkdirSync(join(DIR, "with-agent", "subagents"), { recursive: true });
    writeFileSync(join(DIR, "with-agent", "subagents", "agent-a1b2c3.jsonl"),
      request("s", ["thinking", "tool_use", "tool_use", "text"], { model: "claude-haiku-4-5" }));
    expect(await sessionUsageTotals(main)).toEqual(times(2));
    expect(await sessionUsageByModel(main)).toEqual({ "claude-opus-4-7": ONCE, "claude-haiku-4-5": ONCE });
  });
});
