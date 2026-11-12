// Every warning that was a colour alone now says itself twice more: the
// warning mark before the figure and a word after it, both in the figure's
// tone, in every theme. The quota bars from 70%, the rail's meter at its error
// level, the machine panel's meters from 90%, a reading past its sensor's
// critical point (a GPU's among them), and the process list's strip past a
// threshold. Below the level, nothing is added.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import QuotaBar, { quotaMeterColor, quotaTone } from "../components/QuotaBar";
import { LevelMark } from "../components/LevelMark";
import { PlainRow, Row } from "../components/MachineReadout";
import { Cell } from "../components/MachineStrip";
import { RailUsage } from "../components/RailParts";
import type { Series } from "../components/SectionHistoryModal";
import { usageMeter } from "../rail-usage";
import type { QuotaData } from "../use-quota";
import { catalogFor } from "../i18n/catalogs";
import { sheetText } from "./sheet-source";

const css = sheetText();
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
/** The mark's tone and its word, or null when the markup carries no mark. */
function mark(markup: string): { tone: string; word: string } | null {
  const m = /<span class="level-mark" data-tone="(\w+)"><svg[^>]*class="level-mark-glyph"[\s\S]*?<span class="level-mark-word">([^<]*)<\/span><\/span>/.exec(markup);
  return m ? { tone: m[1], word: m[2] } : null;
}

describe("the mark and the word", () => {
  it("draws nothing round a figure under its level", () => {
    expect(html(createElement(LevelMark, { tone: null, word: "high" }, "42%"))).toBe("42%");
  });

  it("puts the kit's warning glyph before the figure and the word after a dot, the dot unread", () => {
    const out = html(createElement(LevelMark, { tone: "err", word: "high" }, "92%"));
    expect(mark(out)).toEqual({ tone: "err", word: "high" });
    expect(out.indexOf("level-mark-glyph")).toBeLessThan(out.indexOf("92%"));
    expect(out.indexOf("92%")).toBeLessThan(out.indexOf("level-mark-word"));
    expect(out).toContain('<span class="level-mark-dot" aria-hidden="true">·</span>');
    expect(out).toMatch(/<svg[^>]*aria-hidden="true"/);
  });

  it("is the mark and the word alone when there is no figure inside", () => {
    const out = html(createElement(LevelMark, { tone: "warn", word: "hot" }));
    expect(mark(out)).toEqual({ tone: "warn", word: "hot" });
    expect(out).not.toContain("level-mark-dot");
  });

  it("takes the warning tokens for its tone, which every theme declares", () => {
    expect(css).toContain('.level-mark[data-tone="warn"] { color: var(--warn); }');
    expect(css).toContain('.level-mark[data-tone="err"] { color: var(--err); }');
    expect(css).toMatch(/\.level-mark-glyph \{[^}]*width: 12px; height: 12px;/);
  });

  it("has the words in all ten languages, and not in English in the nine others", () => {
    const codes = ["en", "de", "es", "fr", "ja", "ko", "pt-BR", "ro", "zh-CN", "zh-TW"];
    for (const code of codes) {
      const cat = catalogFor(code);
      expect(cat["common.level.high"], code).toBeTruthy();
      expect(cat["common.level.hot"], code).toBeTruthy();
      if (code !== "en") {
        expect(cat["common.level.high"], code).not.toBe("high");
        expect(cat["common.level.hot"], code).not.toBe("hot");
      }
    }
  });
});

describe("a quota bar from 70%", () => {
  const bar = (pct: number, limitReached = false) =>
    html(createElement(QuotaBar, { pct, label: "5-hour window", nowSec: 0, limitReached }));

  it.each([0, 0.5, 42, 69])("has no mark at %d%%", pct => {
    expect(mark(bar(pct))).toBeNull();
  });

  it.each([[70, "warn"], [89, "warn"], [90, "err"], [100, "err"]])("marks %d%% in the fill's own tone, %s, and says high", (pct, tone) => {
    expect(mark(bar(pct as number))).toEqual({ tone, word: "high" });
  });

  it("marks a window at its limit as an error before it is full", () => {
    expect(mark(bar(40, true))).toEqual({ tone: "err", word: "high" });
  });

  it("matches the tone to the fill at every level", () => {
    for (const pct of [0, 69, 70, 89, 90, 100]) {
      const tone = quotaTone(pct);
      const fill = quotaMeterColor(pct);
      expect(tone === null ? "var(--accent)" : tone === "warn" ? "var(--warn)" : "var(--err)").toBe(fill);
    }
  });

  it("has no mark on a window with no reading", () => {
    expect(mark(html(createElement(QuotaBar, { pct: null, label: "Week", nowSec: 0 })))).toBeNull();
  });

  it("colours the figure in the mark's tone rather than in --text", () => {
    expect(css).toContain(".level-mark > .qb-pct[data-known] { color: inherit; }");
  });
});

describe("the rail's usage meter at its error level", () => {
  const NOW = 1_800_000_000;
  const reading = (session5hPct: number): QuotaData => ({ ok: true, planLabel: "Max 20x", session5hPct, session5hResetAt: NOW + 3600 });
  const meter = (pct: number) => usageMeter({ reading: reading(pct), readAt: NOW * 1000, failed: false }, NOW * 1000);
  const draw = (pct: number) => html(createElement(RailUsage, { meter: meter(pct), onPress: () => {} }));

  it("marks 90% and over in --err and says high, aloud too", () => {
    expect(mark(draw(95))).toEqual({ tone: "err", word: "high" });
    expect(meter(95)?.spoken).toContain("5-hour limit 95%, high");
  });

  it("adds nothing under 90, where the figure takes no warning colour", () => {
    expect(mark(draw(75))).toBeNull();
    expect(meter(75)?.spoken).not.toContain("high");
  });

  it("keeps the mark at the line's end, where the figure stood", () => {
    expect(css).toContain(".session-list .sl-usage-line1 > .level-mark { margin-left: auto; }");
  });
});

describe("the machine panel", () => {
  it("marks a meter from 90%, swap and the GPU's among them, and says high", () => {
    expect(mark(html(createElement(Row, { label: "Swap", value: "15 of 16 GB", pct: 93 })))).toEqual({ tone: "err", word: "high" });
    expect(mark(html(createElement(Row, { label: "Utilization", value: "92%", pct: 92 })))).toEqual({ tone: "err", word: "high" });
    // The colour comes from the figure as printed: 89.6 says "90%" and is red.
    expect(mark(html(createElement(Row, { label: "VRAM", value: "90%", pct: 89.6 })))).toEqual({ tone: "err", word: "high" });
  });

  it("leaves a meter under 90 as it was", () => {
    expect(mark(html(createElement(Row, { label: "Swap", value: "8 of 16 GB", pct: 50 })))).toBeNull();
  });

  it("says hot beside a reading past its sensor's critical point, the GPU's among them", () => {
    const hot = html(createElement(PlainRow, { label: "GPU", value: "97 °C", err: true, hint: "critical at 95 °C" }));
    expect(mark(hot)).toEqual({ tone: "err", word: "hot" });
    expect(hot).toContain('<span class="sd-plain-val" data-err="">97 °C</span>');
    expect(mark(html(createElement(PlainRow, { label: "GPU", value: "60 °C" })))).toBeNull();
  });

  it("colours the meter's figure in the mark's tone and keeps the plain reading at the row's end", () => {
    expect(css).toContain(".level-mark > .sd-row-val { color: inherit; }");
    expect(css).toContain(".sd-plain > .level-mark { margin-left: auto; }");
  });
});

describe("the process list's strip", () => {
  const series = (over: Partial<Series>): Series => ({
    key: "thermal:gpu", label: "GPU", unit: "C", top: 110, warnAt: 75, critAt: 90, restsAtZero: false,
    points: [{ t: 0, v: 60 }, { t: 60_000, v: 70 }], ...over,
  });
  const cell = (s: Series, now: number) => html(createElement(Cell, { series: s, stepMs: 60_000, now, span: "1 hour" }));

  it("says hot under a temperature past its critical line, and past its warn line", () => {
    expect(mark(cell(series({}), 93))).toEqual({ tone: "err", word: "hot" });
    expect(mark(cell(series({}), 80))).toEqual({ tone: "warn", word: "hot" });
  });

  it("says high under any other reading past a line", () => {
    const swap = series({ key: "mem:swap", label: "Swap", unit: "%", top: 100, warnAt: null, critAt: 90 });
    expect(mark(cell(swap, 94))).toEqual({ tone: "err", word: "high" });
  });

  it("adds nothing under the lines, and keeps the head to the label and the number", () => {
    const calm = cell(series({}), 50);
    expect(mark(calm)).toBeNull();
    const hot = cell(series({}), 93);
    const head = /<div class="pl-cell-head">([\s\S]*?)<\/div>/.exec(hot)![1];
    expect(head).not.toContain("level-mark");
  });
});
