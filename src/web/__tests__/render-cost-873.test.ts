// #873: every card and every tool bubble re-rendered four times a second even
// when nothing on them had changed. App's 250ms `setNow` built node data as
// `{ ...a, now, onOpenContext }` — a fresh object per card per tick, so React
// Flow's memoised node wrapper never bailed — and AgentNode and each bubble had
// no memo of their own.
//
// Now node data keeps its identity until the board's revision moves, the card
// is memoised on it, time reaches the card only through the three leaves that
// print it (each on a shared one-second beat), and each bubble is memoised on
// the values it draws. There is no DOM in this suite, so the render paths are
// read as source, the way render-path-cost-612-613.test.ts reads them; the
// shared beat is exercised directly.
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { subscribeNow, nowAt } from "../use-now";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const app = read("../App.tsx");
const node = read("../components/AgentNode.tsx");
const bursts = read("../components/ToolBursts.tsx");

describe("node data holds still between events (#873)", () => {
  it("no longer puts the clock in a card's data", () => {
    expect(app).not.toMatch(/data: \{ \.\.\.a, now/);
    expect(app).toMatch(/data: dataFor\(a\),/);
  });

  it("reuses a card's data until the board's revision moves", () => {
    expect(app).toMatch(/entry\.revision !== state\.revision/);
    expect(app).toMatch(/const dataFor = nodeDataFor\(state, onOpenContext\);/);
  });

  it("does not rebuild the session handles on the clock either", () => {
    expect(app).not.toMatch(/\}, \[nodes, now\]\);/);
  });
});

describe("a card renders on its agent, and only its clocks on time (#873)", () => {
  it("is memoised", () => {
    expect(node).toMatch(/^export default memo\(AgentNode\);$/m);
    expect(node).not.toMatch(/export default function AgentNode/);
  });

  it("reads no time from its data", () => {
    expect(node).not.toMatch(/data\.now/);
  });

  it("gives the three leaves that print time a beat of their own", () => {
    for (const leaf of ["function Elapsed", "function WaitingRow", "function ToolRateSpark"]) {
      const at = node.indexOf(leaf);
      expect(at, `${leaf} is gone`).toBeGreaterThan(-1);
      expect(node.slice(at, at + 400), leaf).toMatch(/const now = useNow\(1000\);/);
    }
    expect(node).not.toMatch(/now=\{now\}/);
  });
});

describe("a bubble renders on what it draws (#873)", () => {
  it("is memoised with a comparator over its drawn values", () => {
    expect(bursts).toMatch(/const Bubble = memo\(function Bubble\(/);
    expect(bursts).toMatch(/\}, sameBubble\);/);
    for (const field of ["status", "fading", "worldX", "worldY", "name", "category", "mcpHue"]) {
      expect(bursts, field).toMatch(new RegExp(`a\\.${field} === c\\.${field}`));
    }
  });
});

describe("the shared beat (#873)", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("serves every subscriber at one rate from one timer, and stops with the last", () => {
    vi.useFakeTimers();
    const before = vi.getTimerCount();
    const seen: number[] = [];
    const offA = subscribeNow(1000, () => seen.push(nowAt(1000)));
    const offB = subscribeNow(1000, () => {});
    expect(vi.getTimerCount() - before).toBe(1);
    vi.advanceTimersByTime(3000);
    expect(seen).toHaveLength(3);
    offA();
    expect(vi.getTimerCount() - before).toBe(1);
    offB();
    expect(vi.getTimerCount() - before).toBe(0);
  });

  it("moves the time it reports on each beat", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const off = subscribeNow(1000, () => {});
    const first = nowAt(1000);
    vi.advanceTimersByTime(1000);
    expect(nowAt(1000) - first).toBe(1000);
    off();
  });
});
