// The small ones the audit turned up, each pinned where it can be seen.
//
// None of these is worth a file of its own; together they are a page of real
// behaviour. Source assertions where the failure is a shape (a listener on the
// wrong event, a pipe nobody drains), values where it is arithmetic.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

// @ts-expect-error — .mjs server module, no types
const { cooldownFromHeader } = await import("../../server/quota.mjs");

describe("a retry-after the deck can live with", () => {
  it("refuses to be told to stop backing off", () => {
    // `0` — or anything the server rounds to it — defeated the cooldown a 429
    // exists to impose, and the next tick asked again immediately.
    expect(cooldownFromHeader("0", 300_000)).toBe(30_000);
    expect(cooldownFromHeader("-5", 300_000)).toBe(30_000);
    expect(cooldownFromHeader("1", 300_000)).toBe(30_000);
  });

  it("refuses to be frozen for the day", () => {
    // 86400 is a legal value, and nothing re-reads this for the life of the
    // process: a quota panel dead until tomorrow because one reply said so.
    expect(cooldownFromHeader("86400", 300_000)).toBe(3600_000);
    expect(cooldownFromHeader("100000", 300_000)).toBe(3600_000);
  });

  it("honours an ordinary one, and falls back when there is none", () => {
    expect(cooldownFromHeader("120", 300_000)).toBe(120_000);
    expect(cooldownFromHeader(null, 300_000)).toBe(300_000);
    expect(cooldownFromHeader("soon", 300_000)).toBe(300_000);
  });

  it("is the one clamp both quota readers use", () => {
    expect(read("../../server/codex-quota.mjs")).toContain("cooldownFromHeader(res?.headers?.get?.(\"retry-after\"), COOLDOWN_MS)");
  });
});

describe("reading a child's output", () => {
  it("decodes the stream rather than each chunk", () => {
    // `out += d` on a Buffer calls toString() per chunk, and a chunk boundary
    // falls wherever the pipe broke — measured on `ps` as 8192/8192/5718 — so a
    // multi-byte character split across two of them became two replacement
    // characters: `Яндекс Музыка` rendered as `Ян��екс Музыка`.
    const metrics = read("../../server/system-metrics.mjs");
    expect(metrics).toContain('child.stdout?.setEncoding("utf8");');
    const exec = read("../../server/exec.mjs");
    expect(exec).toContain('cp.stdout?.setEncoding("utf8");');
    expect(exec).toContain('proc.stdout?.setEncoding("utf8");');
  });

  it("does not open a stderr pipe nobody drains", () => {
    // A pipe nobody reads fills at 64 KB and the writer blocks there until the
    // deadline kills it. system-metrics' `run` resolves on stdout or null and
    // has never looked at stderr.
    const metrics = read("../../server/system-metrics.mjs");
    expect(metrics).toContain('stdio: ["ignore", "pipe", "ignore"],');
  });

  it("waits for the pipes to drain before reading npx's tail", () => {
    // 'exit' says the process ended and nothing about its output. The tail is
    // deliberately the LAST lines — npm's reason lives there — and past one
    // pipe buffer 'exit' handed npxFailureSummary the first 8 KiB instead.
    const npx = read("../../server/npx.mjs");
    expect(npx).toContain('child.on("close", (code, signal) => {');
    expect(npx).not.toContain('child.on("exit", (code, signal) => {');
  });
});

describe("what an upgrade failure says", () => {
  it("keeps the message that named the cause", () => {
    // A missing npm emits 'error' with ENOENT and then 'close' with a null
    // code, and the close handler replaced "spawn npm ENOENT" with
    // "npm exited -2" — the one message that says what is wrong, overwritten by
    // the one that does not.
    expect(read("../../server/self-update.mjs")).toContain('} else if (!timedOut && _upgrade?.state !== "failed") {');
  });
});

describe("the once-a-day version check", () => {
  it("stamps the marker after the request, not before it", () => {
    // Stamped first, a boot with no network — a laptop opened on a train —
    // burned the whole shared 24-hour window on a check that never reached
    // PyPI, and the next real chance was the day after.
    const src = read("../../server/cswap-install.mjs");
    const check = src.slice(src.indexOf("if (!updateCheckDue()) return { state: \"present\""));
    expect(check.indexOf("await latestOnPypi()")).toBeLessThan(check.indexOf("touchMarker()"));
  });
});

describe("the tool sparkline's tooltip", () => {
  it("does not report a peak on a card with no calls", () => {
    // `max` is floored at 1 so an empty spark can be drawn; the peak is a
    // measurement, and the floor made an idle card read
    // "0 tool calls in last 60s · peak 0.4/s".
    const node = read("../components/AgentNode.tsx");
    expect(node).toContain("const observedPeak = Math.max(0, ...counts);");
    expect(node).toContain("const peakRate = observedPeak / (BUCKET_MS / 1000);");
    expect(node).toContain('? "no tool calls in the last 60s"');
  });
});
