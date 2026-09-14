// #850: the tick on each quota bar explained itself only in a title, and told
// over from under pace by red or green alone. A touch or keyboard reader never
// sees a title, and a colour-blind one cannot read the hue.
//
// The note under the bar already says "over pace" or "under pace" in words
// (#823). What it did not say is that the tick IS the pace. So the note now
// leads with the marker's own line in the marker's own colour — a legend — and
// the tick, keyed that way, drops out of the accessibility tree.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { computePace } from "../components/UsagePanel";

const panel = readFileSync(fileURLToPath(new URL("../components/UsagePanel.tsx", import.meta.url)), "utf8");
const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

function decl(selector: string, prop: string): string | null {
  const rule = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css);
  const m = rule && new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`).exec(rule[1]);
  return m ? m[1].trim() : null;
}

const marker = /<div[^>]*?className="qb-pace-marker"[\s\S]*?\/>/.exec(panel)![0];
// A button since #856, which made the note open the number it is measured against.
const note = /className="qb-pace"[\s\S]*?<\/button>/.exec(panel)![0];
const key = /<i className="qb-pace-key"[^>]*\/>/.exec(note)?.[0] ?? null;
const background = (jsx: string) => /background:\s*([^,}]+?)\s*[,}]/.exec(jsx)![1].trim();

describe("the pace note is the marker's legend (#850)", () => {
  it("leads the note with a key, before the words", () => {
    expect(key, "no .qb-pace-key inside the pace note").not.toBeNull();
    expect(note.indexOf("qb-pace-key")).toBeLessThan(note.indexOf("pace.label"));
  });

  it("draws the key in the marker's colour, for every state the marker has", () => {
    expect(background(key!)).toBe(background(marker));
  });

  it("draws the key as the marker's own line", () => {
    expect(decl(".qb-pace-key", "width")).toBe(decl(".qb-pace-marker", "width"));
    expect(decl(".qb-pace-key", "border-radius")).toBe(decl(".qb-pace-marker", "border-radius"));
  });

  it("keeps the key and the keyed tick out of the accessibility tree — the words carry it", () => {
    expect(key).toMatch(/\baria-hidden\b/);
    expect(marker).toMatch(/\baria-hidden\b/);
  });
});

describe("over and under are told apart by words, not only by hue (#850)", () => {
  const HOUR = 3600;
  const WINDOW = 5 * HOUR;
  const half = (pct: number) => computePace(pct, 10 * HOUR, WINDOW, 10 * HOUR - WINDOW / 2)!;

  it("says which side of the pace the reader is on", () => {
    expect(half(70).label).toMatch(/over pace$/);
    expect(half(30).label).toMatch(/under pace$/);
    expect(half(50).label).toBe("on pace");
  });

  it("names the two states with different words even where the hues agree", () => {
    // On pace and under pace share --ok; the words still differ.
    expect(half(50).color).toBe(half(30).color);
    expect(half(50).label).not.toBe(half(30).label);
  });
});
