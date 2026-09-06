// Four server defects, each one a fallback or a flag that was right about the
// happy path and wrong about the failure beside it.
//
//   #789  a failed vm_stat reported 99% memory used, and the max-bucketed
//         chart kept that peak for twenty-four hours
//   #790  a failed self-repair permanently disabled the self-repair
//   #791  changing the auto-switch interval during boot was silently a no-op
//   #792  the Codex rollout was read whole into memory on the open route
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-server-defects-"));
afterAll(() => rmTempDir(DIR));

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

// @ts-expect-error — plain .mjs server module, no types
const { readCodexRollout } = await import("../../server/index.mjs");

/** A rollout of the shape Codex writes: session_meta first, the readings last,
 *  and `pad` bytes of unremarkable records in between. */
function rollout(pad: number): string {
  const filler = JSON.stringify({ type: "response_item", payload: { model: "gpt-5.1-codex" } }) + "\n";
  return [
    JSON.stringify({ type: "session_meta", payload: { cwd: "/w/paycore", model: "gpt-5.1-codex" } }),
    "",
  ].join("\n")
    + filler.repeat(Math.max(0, Math.ceil(pad / filler.length)))
    + [
      JSON.stringify({ type: "event_msg", payload: { type: "task_started", model_context_window: 272000 } }),
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 10, output_tokens: 5 } } } }),
      JSON.stringify({ type: "response_item", payload: { model: "gpt-5.1-codex-max" } }),
      "",
    ].join("\n");
}

describe("#789 — a memory poll that could not measure", () => {
  it("reports nothing rather than the number the module exists to suppress", () => {
    // `os.freemem()` on macOS counts only genuinely free pages: ~0.5% on an
    // idle 32 GB Mac, which is exactly the 99.5% reading the function's own
    // header says this readout exists to prevent. Substituting it turned a
    // failed measurement into the worst possible measurement.
    const src = read("../../server/system-metrics.mjs");
    expect(src, "darwin substitutes freemem again")
      .not.toMatch(/return parsed \?\? os\.freemem\(\);/);
    // Both real sources answer null when they could not be read; the last
    // branch still answers freemem, because on Windows that IS the measurement
    // rather than a substitute for one.
    expect((src.match(/return os\.freemem\(\);/g) ?? []).length).toBe(1);
  });

  it("keeps the previous reading and records no history point", () => {
    // The half that outlives the poll. `record` folds into the minute bucket by
    // MAXIMUM, so one bad sample paints a red 99% peak that survives every good
    // one for a day. A gap in the chart is honest; that peak is not.
    const src = read("../../server/system-metrics.mjs");
    expect(src).toContain("if (available != null) {");
    expect(src).toMatch(/if \(available != null\) \{[\s\S]{0,400}?record\("mem:physical", memory\.usedPct\);[\s\S]{0,40}?\}/);
    // Swap is a separate measurement and must still be taken and recorded.
    expect(src).toContain('if (swap && swap.total > 0) record("mem:swap"');
  });

  it("still records a reading that succeeded, so the meter is not simply off", () => {
    const src = read("../../server/system-metrics.mjs");
    expect(src).toContain('record("mem:physical", memory.usedPct);');
  });
});

describe("#790 — the one-repair budget", () => {
  it("is spent only once the directory is really gone", () => {
    // It was set before the try. On Windows the rm fails for the reason the
    // function's own maxRetries comment gives — the child that just exited
    // still holds a handle — so the flag was burned by a repair that never
    // happened, and every later poll for the life of the deck short-circuited
    // on it, including seconds later once the handle was released.
    const src = read("../../server/ccusage.mjs");
    expect(src).toContain("if (gone) _repairedThisRun = true;");
    // And not before the attempt: the only assignment must be the guarded one.
    expect((src.match(/_repairedThisRun = true/g) ?? []).length).toBe(1);
    const guard = src.indexOf("if (_repairedThisRun || runner.kind");
    const set = src.indexOf("if (gone) _repairedThisRun = true;");
    const rm = src.indexOf("rmSync(PKG_DIR");
    expect(guard).toBeGreaterThan(-1);
    expect(set, "the flag is set before the rm again").toBeGreaterThan(rm);
  });

  it("still refuses a second repair in one process once one has happened", () => {
    // The budget exists to stop a loop of installs, and must survive the fix.
    const src = read("../../server/ccusage.mjs");
    expect(src).toContain("if (_repairedThisRun || runner.kind !== \"node\" || installsDisabled()) return false;");
  });
});

describe("#791 — a restart asked for while one is in flight", () => {
  it("is remembered rather than dropped", () => {
    // `initCswapAuto()` is fired unawaited at boot, so startLoop sits inside
    // `await tickInterval()` while the panel is already serving. A user setting
    // the interval in that window hit `if (_timer || _starting) return;` and
    // the boot's own start then installed the timer at the value it had read
    // BEFORE the write — the panel reading back the new number while the loop
    // kept the old one for the life of the process.
    const src = read("../../server/cswap-auto.mjs");
    expect(src).toContain("if (_starting) { _restartWanted = true; return; }");
    expect(src).toContain("if (_restartWanted) continue;   // the interval changed under this read");
    expect(src, "the old swallow-and-forget guard is back")
      .not.toContain("if (_timer || _starting) return;");
  });

  it("re-reads in a loop, so a second write during the re-read is not lost either", () => {
    // The flag is cleared at the top of each pass and checked after the await,
    // so the value that wins is the last one written rather than the first one
    // noticed.
    const src = read("../../server/cswap-auto.mjs");
    expect(src).toMatch(/for \(;;\) \{[\s\S]{0,200}?_restartWanted = false;[\s\S]{0,200}?await tickInterval\(\)/);
  });
});

describe("#792 — how much of a Codex rollout reaches memory", () => {
  it("is bounded by two constants, whatever the file's size", () => {
    // The rule OPEN_MUTATIONS states about this very route: the deck's memory
    // "cannot be a function of anything but the two constants named here".
    // 44.4 MB read whole was 185 MB resident and 95ms of synchronous parsing on
    // the credential-free ingest path.
    const src = read("../../server/index.mjs");
    expect(src).toContain("const CODEX_HEAD_BYTES = 256 * 1024;");
    expect(src).toContain("const CODEX_TAIL_BYTES = 2 * 1024 * 1024;");
    expect(src, "the whole-file read is back")
      .not.toMatch(/const buf = Buffer\.alloc\(s\.size\);\s*\n\s*await fh\.read\(buf, 0, s\.size, 0\);/);
  });

  it("reads a small rollout in one piece, so nothing changes for the ordinary one", () => {
    const src = read("../../server/index.mjs");
    expect(src).toContain("if (s.size <= CODEX_HEAD_BYTES + CODEX_TAIL_BYTES) {");
    expect(src).toContain("text = await readByteRange(path, 0, s.size);");
  });

  it("takes the head as well as the tail, because the two carry different fields", () => {
    // `session_meta` — cwd, and sometimes the model — is the FIRST record,
    // while the last token_count, the last task_started and the newest
    // response_item model are all at the end. A pure tail read would silently
    // lose the working directory of every long session.
    const src = read("../../server/index.mjs");
    expect(src).toContain("const head = await readByteRange(path, 0, CODEX_HEAD_BYTES);");
    expect(src).toContain("const tail = await readByteRange(path, s.size - CODEX_TAIL_BYTES, s.size);");
  });

  it("joins the two windows with a newline, so no record is spliced into being", () => {
    // Without it the head's last partial line and the tail's first partial line
    // would be concatenated into a line that never existed in the file, and
    // JSON.parse might well accept it.
    const src = read("../../server/index.mjs");
    expect(src).toMatch(/text = `\$\{head\}\\n\$\{tail\}`;/);
  });

  it("still finds every field when the whole file fits in the windows", async () => {
    const path = join(DIR, "small.jsonl");
    writeFileSync(path, rollout(0));
    const out = await readCodexRollout(path);
    expect(out).toBeTruthy();
    expect(out.cwd).toBe("/w/paycore");
    expect(out.contextWindow).toBe(272000);
    expect(out.model).toBe("gpt-5.1-codex-max");
    expect(out.usage.input_tokens).toBe(10);
  });

  it("finds them all in a file far larger than both windows put together", async () => {
    // The branch the fix exists for. Padding between the head and the tail is
    // an order of magnitude past `CODEX_HEAD_BYTES + CODEX_TAIL_BYTES`, so the
    // middle is genuinely never read — and the four fields still arrive,
    // because they live at the two ends.
    const path = join(DIR, "huge.jsonl");
    writeFileSync(path, rollout(6 * 1024 * 1024));
    const out = await readCodexRollout(path);
    expect(out).toBeTruthy();
    expect(out.cwd, "the head was not read").toBe("/w/paycore");
    expect(out.usage.input_tokens, "the tail was not read").toBe(10);
    expect(out.model).toBe("gpt-5.1-codex-max");
  });

  it("never reads the middle, however big the middle is", async () => {
    // The decisive form, and it replaced a heap measurement that proved
    // nothing: `readByteRange` caps every read at MAX_SCAN_CHUNK internally, so
    // even a deliberately reintroduced "whole file" read stayed under the
    // ceiling I had set and the case passed over the bug.
    //
    // A marker placed in the middle of a file far larger than both windows is
    // not a measurement of anything — it is either read or it is not. Here it
    // must not be: `session_meta` carries the cwd, and a middle one winning
    // would mean the middle was parsed.
    const path = join(DIR, "middle.jsonl");
    const filler = JSON.stringify({ type: "response_item", payload: { model: "gpt-5.1-codex" } }) + "\n";
    const pad = filler.repeat(Math.ceil((6 * 1024 * 1024) / filler.length));
    writeFileSync(path,
      JSON.stringify({ type: "session_meta", payload: { cwd: "/w/head" } }) + "\n"
      + pad
      + JSON.stringify({ type: "session_meta", payload: { cwd: "/w/MIDDLE" } }) + "\n"
      + pad
      + JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 3 } } } }) + "\n");

    const out = await readCodexRollout(path);
    expect(out.cwd, "the middle of the file was parsed").not.toBe("/w/MIDDLE");
    expect(out.cwd, "the head was not read").toBe("/w/head");
    expect(out.usage.input_tokens, "the tail was not read").toBe(3);
  });

  it("does not splice a record into being across the join", async () => {
    // The head ends mid-line and the tail begins mid-line. Concatenated without
    // a separator those two halves can form a line that never existed, and
    // JSON.parse might accept it. The parser must see two broken lines and skip
    // both rather than one plausible one.
    const path = join(DIR, "splice.jsonl");
    const head = JSON.stringify({ type: "session_meta", payload: { cwd: "/w/real" } }) + "\n";
    const filler = JSON.stringify({ type: "response_item", payload: { model: "filler" } }) + "\n";
    const tail = JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 7 } } } }) + "\n";
    writeFileSync(path, head + filler.repeat(Math.ceil((6 * 1024 * 1024) / filler.length)) + tail);
    const out = await readCodexRollout(path);
    expect(out.cwd).toBe("/w/real");
    expect(out.usage.input_tokens).toBe(7);
  });
});
