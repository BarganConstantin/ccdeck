// The band under the process list.
//
// Three things are asserted here and they are not the same kind of thing.
//
// The FIRST is a mirror. `liveReadings` recomputes, in the browser, quantities
// the server already computes for its ring — and the two have to agree on both
// the name and the arithmetic or a cell shows one machine's number under
// another machine's line. Nothing in either file says the other exists, so the
// join is checked against the server's own source rather than against a copy of
// it written here, which would only prove this file agrees with itself.
//
// The SECOND is a set of refusals: what does NOT get a cell, and why. A reading
// that is always zero, a label that is allowed to wrap, a span that claims an
// hour it has not had.
//
// The THIRD is layout that was wrong when it was written and was fixed from a
// measurement. Those numbers are pinned with the measurement beside them, so
// the next person to change them has to disagree with a number rather than with
// a preference.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fmtReading, liveReadings, THROTTLE_SERIES, type LiveSource } from "../machine-live";
import { cellLabel, worthACell, windowOf, SPARK_W, SPARK_H, WINDOW_BUCKETS, REFRESH_MS, GROUPS } from "../components/MachineStrip";
import { spanLabel, type Series } from "../components/SectionHistoryModal";

const at = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const metrics = readFileSync(at("../../server/system-metrics.mjs"), "utf8");
const strip = readFileSync(at("../components/MachineStrip.tsx"), "utf8");
const css = readFileSync(at("../styles.css"), "utf8");

/** A series with everything filled in, so each test states only what it is
 *  about. */
const series = (over: Partial<Series> = {}): Series => ({
  key: "cpu:all",
  label: "All cores",
  unit: "%",
  top: 100,
  warnAt: null,
  critAt: null,
  restsAtZero: false,
  points: [{ t: 0, v: 10 }, { t: 60_000, v: 20 }],
  ...over,
});

/** A machine that answers everything. Individual tests take pieces away. */
const full = (): LiveSource => ({
  cpu: 41.5,
  perCore: [10, 99, 30],
  memory: { total: 34359738368, available: 13146943488, usedPct: 61.7 },
  swap: { total: 13958643712, used: 12329680896 },
  loadavg: [78.89, 53.49, 40.2],
  thermal: { celsius: [{ label: "GPU", celsius: 64 }], throttle: { speedLimit: 82 } },
});

describe("the client's readings and the server's ring agree", () => {
  // Every `record("x", …)` the sampler makes, which is the complete list of
  // names the ring can ever be keyed by, read out of the server itself.
  const recorded = new Set(
    [...metrics.matchAll(/\brecord\(\s*(?:"([^"]+)"|`([^`]+)`)/g)]
      .map(m => m[1] ?? m[2])
      // `thermal:${label}` is one call that produces a key per sensor, and the
      // sensors are whatever the chip publishes. Its dynamic half is covered
      // by its own test below.
      .filter(k => !k.includes("${") || k.startsWith("thermal:")),
  );

  it("asks for nothing the ring does not record", () => {
    const asked = Object.keys(liveReadings(full()));
    const dynamicThermal = [...recorded].some(k => k.startsWith("thermal:"));
    const unknown = asked.filter(k => !recorded.has(k) && !(dynamicThermal && k.startsWith("thermal:")));
    expect(unknown).toEqual([]);
  });

  it("answers every fixed reading the ring records", () => {
    // The other direction, and the one that catches a reading the server learns
    // and the strip silently never shows a live number for: its cell would draw
    // its line and print the last bucket, up to a minute stale, for ever.
    const asked = new Set(Object.keys(liveReadings(full())));
    const fixed = [...recorded].filter(k => !k.includes("${"));
    expect(fixed.filter(k => !asked.has(k))).toEqual([]);
  });

  it("names throttling the way the server spells it", () => {
    expect(metrics).toContain('export const THROTTLE_LABEL = "Throttling"');
    expect(THROTTLE_SERIES).toBe("thermal:Throttling");
    expect(liveReadings(full())[THROTTLE_SERIES]).toBe(18);
  });

  it("computes swap the way the server rounds it, not to full precision", () => {
    // The server stores `Math.round(used / total * 1000) / 10`. Recomputing the
    // ratio here to full precision would put 88.4 in one place and
    // 88.36988... in the other, for the same machine at the same instant.
    const sys = full();
    const mine = liveReadings(sys)["mem:swap"];
    const theirs = Math.round((sys.swap!.used / sys.swap!.total) * 1000) / 10;
    expect(mine).toBe(theirs);
    expect(String(mine).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(1);
  });

  it("takes the busiest core from the per-core list, as `cpu:busiest` is recorded", () => {
    expect(metrics).toContain('record("cpu:busiest", Math.max(...per))');
    expect(liveReadings(full())["cpu:busiest"]).toBe(99);
  });
});

describe("what a machine that cannot answer gets", () => {
  it("omits load on a platform that publishes none, rather than reading zero", () => {
    // Windows. `os.loadavg()` returns zeros there and the server refuses to
    // record them; a strip that printed `0.00` would be inventing calm.
    expect(metrics).toContain('const hasLoad = process.platform !== "win32"');
    const { loadavg, ...rest } = full();
    expect("load:1m" in liveReadings({ ...rest, loadavg: null })).toBe(false);
  });

  it("omits every temperature on a machine with no sensor", () => {
    const sys = { ...full(), thermal: null };
    expect(Object.keys(liveReadings(sys)).filter(k => k.startsWith("thermal:"))).toEqual([]);
  });

  it("omits swap where there is none, which is not the same as swap at zero", () => {
    const sys = { ...full(), swap: { total: 0, used: 0 } };
    expect("mem:swap" in liveReadings(sys)).toBe(false);
  });

  it("omits cpu until two samples exist", () => {
    expect("cpu:all" in liveReadings({ ...full(), cpu: null })).toBe(false);
  });
});

describe("which series is worth a cell", () => {
  it("refuses a reading that rests at zero and has not left it", () => {
    // Throttling on a desktop, essentially always. A cell that says `0%` under
    // a flat line every time it is looked at is read as broken, and then it is
    // not believed on the day it is not zero — which the panel has already
    // learned once, in `heldBackSoFar`.
    const flat = series({ key: THROTTLE_SERIES, restsAtZero: true, points: [{ t: 0, v: 0 }, { t: 60_000, v: 0 }] });
    expect(worthACell(flat)).toBe(false);
  });

  it("keeps that same reading the moment it has been anything else", () => {
    const held = series({ key: THROTTLE_SERIES, restsAtZero: true, points: [{ t: 0, v: 0 }, { t: 60_000, v: 12 }] });
    expect(worthACell(held)).toBe(true);
  });

  it("keeps a reading at zero that does not rest there", () => {
    // An idle CPU is a real answer to a real question, and `restsAtZero` is
    // false for it deliberately. A rule written over "all points are zero"
    // instead of over the flag would have dropped the cell on a quiet machine.
    const idle = series({ points: [{ t: 0, v: 0 }, { t: 60_000, v: 0 }] });
    expect(idle.restsAtZero).toBe(false);
    expect(worthACell(idle)).toBe(true);
  });

  it("refuses a series with no points at all", () => {
    expect(worthACell(series({ points: [] }))).toBe(false);
  });
});

describe("the window, and what it is allowed to claim", () => {
  it("draws at most an hour of buckets", () => {
    const many = series({ points: Array.from({ length: 500 }, (_, i) => ({ t: i * 60_000, v: i % 100 })) });
    expect(windowOf(many).points).toHaveLength(WINDOW_BUCKETS);
    // The TAIL, not the head: the last hour, not the first.
    expect(windowOf(many).points[WINDOW_BUCKETS - 1]).toEqual(many.points[499]);
  });

  it("leaves a shorter series exactly as it is", () => {
    const short = series();
    expect(windowOf(short)).toBe(short);
  });

  it("names the span it actually has instead of saying an hour", () => {
    // The line is stretched to the full width whatever it holds, so four
    // minutes and an hour occupy the same box. Saying "the last hour" over the
    // first would be read as an hour of calm.
    expect(spanLabel(0, 7 * 60_000)).toBe("7 minutes");
    expect(spanLabel(0, 61 * 60_000)).toBe("1h 1m");
    expect(strip).toContain("spanLabel");
    // And nothing in the component hard-codes the claim.
    expect(/last hour/i.test(strip.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, ""))).toBe(false);
  });

  it("re-reads the ring at the width of a bucket and no faster", () => {
    // Buckets are a minute wide; anything quicker re-fetches a ring that has
    // not changed. The NUMBER is live at the panel's own three seconds.
    expect(REFRESH_MS).toBe(60_000);
    expect(metrics).toContain("const BUCKET_MS = 60_000;");
  });

  it("asks for the four groups the server allows, in the panel's order", () => {
    expect([...GROUPS]).toEqual(["cores", "memory", "load", "thermal"]);
    // Every one of them is a group the endpoint accepts — a typo here is an
    // empty band with no error anywhere.
    const allow = readFileSync(at("../../server/index.mjs"), "utf8")
      .match(/\[("(?:thermal|cores|memory|load)",?\s*)+\]\.includes\(group\)/)?.[0] ?? "";
    for (const g of GROUPS) expect(allow).toContain(`"${g}"`);
  });
});

describe("how a reading is printed in a cell", () => {
  it("keeps a percentage whole and a temperature whole", () => {
    expect(fmtReading(61.66, "%")).toBe("62%");
    expect(fmtReading(64.2, "C")).toBe("64°");
  });

  it("keeps the load average's two decimals, because the panel prints two", () => {
    // A strip reading `78` beside a panel reading `78.89` is two numbers, and
    // the reader has to work out that they are one.
    expect(fmtReading(78.89, "")).toBe("78.89");
    expect(fmtReading(5, "")).toBe("5.00");
  });
});

describe("the layout, pinned to what was measured", () => {
  const rule = (sel: string) => {
    const i = css.indexOf(`${sel} {`);
    return i < 0 ? "" : css.slice(i, css.indexOf("}", i));
  };

  it("gives the head one line, because a wrapped label drops its own sparkline", () => {
    // Measured at 13.6px of misalignment on `Queued work`, the one label long
    // enough to break at the first width. Thermal labels come from the chip, so
    // this is not a fact about this machine: a Linux hwmon box publishes
    // `Package id 0` where this one says `GPU`.
    expect(rule(".pl-cell-head")).toContain("white-space: nowrap");
  });

  it("makes the label yield and the number hold", () => {
    const label = rule(".pl-cell-label");
    expect(label).toContain("text-overflow: ellipsis");
    expect(label).toContain("overflow: hidden");
    // Without this the number is what gets squeezed, and the number is the
    // reading.
    expect(rule(".pl-cell-now")).toContain("flex: none");
  });

  it("keeps the head and the sparkline the same width", () => {
    const w = rule(".pl-cell-head").match(/width:\s*(\d+)px/)?.[1];
    expect(Number(w)).toBe(SPARK_W);
  });

  it("is wide enough for the worst head, not for the one on screen", () => {
    // The longest label plus 8px of gap plus about 33px for a three-digit load
    // average. The label measured 59.7px (`Busiest core`) when this was
    // written and 67px (`Swap memory`) once the names grew their nouns — the
    // number that matters lives in the cellLabel block, which is where the
    // widest name is decided.
    expect(SPARK_W).toBeGreaterThanOrEqual(67 + 8 + 33);
  });

  it("holds its own height before the first bucket exists", () => {
    // Buckets are a minute wide. Without this the band is 12px of border and
    // padding until the first one lands and then jumps to 54 — under a centred
    // dialog, which is the same defect the usage history modal was just fixed
    // for.
    const min = Number(rule(".pl-strip").match(/min-height:\s*(\d+)px/)?.[1]);
    expect(min).toBeGreaterThanOrEqual(SPARK_H + 24);
  });

  it("wraps rather than scrolling sideways", () => {
    // Measured: six cells are one row at 880px and three rows at 420px, with no
    // horizontal overflow at either. A footer is not a place anyone thinks to
    // scroll.
    expect(rule(".pl-strip")).toContain("flex-wrap: wrap");
  });

  it("draws the box as the scale, so a line's height means something", () => {
    // The panel's own grammar for these readings — `.sd-track` holds a
    // `.sd-fill` against the same 0-100. Without a track, 4px and 15px in a
    // 24px box are two positions with nothing to be positions against.
    expect(rule(".pl-spark")).toMatch(/background:\s*var\(--line-soft\)/);
    expect(rule(".sd-track")).toContain("background: var(--line)");
  });

  it("draws the floor before anything stands on it", () => {
    // A series with one bucket has no line — a shape needs two points — and an
    // empty box reads as a broken chart rather than as a young deck.
    expect(strip).toContain("pl-spark-floor");
    expect(rule(".pl-spark-floor")).toContain("stroke: var(--line-soft)");
  });
});

describe("what a cell calls its reading", () => {
  it("gives a name its own noun, because the band has no heading", () => {
    // The panel puts `Physical` under a section called Memory and the history
    // dialog under `Memory history`. Six readings in a row with nothing above
    // them cannot borrow that: `Physical 63%` is a number about nothing.
    expect(cellLabel(series({ key: "mem:physical", label: "Physical" }))).toBe("Physical RAM");
  });

  it("derives the temperature name from the unit, not from a list of sensors", () => {
    // A Linux hwmon box publishes whatever the chip calls its sensors. A
    // lookup table would have covered `GPU` and left `Package id 0` bare.
    expect(cellLabel(series({ key: "thermal:GPU", label: "GPU", unit: "C" }))).toBe("GPU temp");
    expect(cellLabel(series({ key: "thermal:Package id 0", label: "Package id 0", unit: "C" })))
      .toBe("Package id 0 temp");
  });

  it("keeps the server's word for swap, because Windows has no swap file", () => {
    // The server already renames that reading `Commit` there. A hardcoded
    // "Swap memory" would have been wrong on the one platform nobody re-reads.
    expect(cellLabel(series({ key: "mem:swap", label: "Swap" }))).toBe("Swap memory");
    expect(cellLabel(series({ key: "mem:swap", label: "Commit" }))).toBe("Commit memory");
  });

  it("leaves alone the names that already read", () => {
    // `All cores` and `Busiest core` explain each other, and `Queued work` is
    // plainer than "load average". Renaming those would be churn.
    expect(cellLabel(series({ key: "cpu:all", label: "All cores" }))).toBe("All cores");
    expect(cellLabel(series({ key: "cpu:busiest", label: "Busiest core" }))).toBe("Busiest core");
    expect(cellLabel(series({ key: "load:1m", label: "Queued work", unit: "" }))).toBe("Queued work");
  });

  it("does not treat the throttle percentage as a temperature", () => {
    // It lives in the thermal group and is measured in %, so the rule keyed on
    // the unit is what keeps `Throttling temp` off the screen.
    expect(cellLabel(series({ key: "thermal:Throttling", label: "Throttling", unit: "%" })))
      .toBe("Throttling");
  });

  it("still fits the widest name it can now produce", () => {
    // Re-measured after the labels grew nouns: `Swap memory` is 67px where
    // `Busiest core` was 59.7, and the widest reading is a three-digit load
    // average at about 33px, plus 8px of gap.
    expect(SPARK_W).toBeGreaterThanOrEqual(67 + 8 + 33);
  });
});

describe("the process block opens the list it is a preview of", () => {
  const meter = readFileSync(at("../components/SystemMeter.tsx"), "utf8");
  const rule = (sel: string) => {
    const i = css.indexOf(`${sel} {`);
    return i < 0 ? "" : css.slice(i, css.indexOf("}", i));
  };

  it("takes the press anywhere in the block, not only on the word", () => {
    // Eight rows of processes read as something you can look further into, and
    // the only thing that said so was a 10px word in the corner.
    expect(meter).toContain("sd-openable");
    expect(rule(".sysdetail .sd-section.sd-openable")).toContain("cursor: pointer");
  });

  it("steps aside for the controls already inside it", () => {
    // The column headers sort and `more` opens this same dialog. Without the
    // guard a press on `cpu` would sort AND open the modal over it, and `more`
    // would fire twice. Verified in the page: sorting does not open, a row
    // does, the heading does, and `more` opens exactly one.
    expect(meter).toContain('(e.target as HTMLElement).closest("button")');
  });

  it("does not claim to be a control the keyboard can reach", () => {
    // role="button" plus a tabindex was the obvious next step and is wrong
    // twice: a second tab stop for an action `more` already offers with a real
    // name, on an element that CONTAINS the sort buttons. The mouse gets a
    // shortcut; the keyboard and a screen reader keep the button.
    const block = meter.slice(meter.indexOf("function Processes("), meter.indexOf("function Row("));
    const opening = block.slice(block.indexOf("<div"), block.indexOf(">", block.indexOf("onClick")));
    expect(opening).not.toContain('role="button"');
    expect(opening).not.toContain("tabIndex");
    expect(opening).toContain('role="group"');
  });

  it("only becomes a target when there is a list to open", () => {
    expect(meter).toContain("const openable = read != null && procs != null && procs.length > 0");
  });

  it("lights the way the four sections above it already do", () => {
    // A fifth block that behaved differently would read as a different kind of
    // thing. Same fill, same 6% of --text, same active scale.
    const mine = rule(".sysdetail .sd-section.sd-openable:hover");
    const theirs = rule(".sysdetail .sd-open:hover");
    expect(mine).toContain("color-mix(in srgb, var(--text) 6%, transparent)");
    expect(theirs).toContain("color-mix(in srgb, var(--text) 6%, transparent)");
    expect(rule(".sysdetail .sd-section.sd-openable:active")).toContain("scale(0.97)");
  });

  it("keeps the gap between sections it bleeds into", () => {
    // The margin is on the SECTION, not on a button inside it, so a flat -4px
    // would have eaten the 13px `.sd-section + .sd-section` gap. 9 + 4 is that
    // 13 — measured in the page at the same 5px of daylight the other sections
    // leave.
    expect(rule(".sysdetail .sd-section + .sd-section.sd-openable")).toContain("margin-top: 9px");
    expect(rule(".sysdetail .sd-section.sd-openable")).toContain("margin-bottom: -4px");
    expect(rule(".sd-section + .sd-section")).toContain("margin-top: 13px");
  });

  it("drops the press animation for anyone who asked for less movement", () => {
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce) {\n  .sysdetail"));
    expect(reduced.slice(0, reduced.indexOf("\n}"))).toContain(".sysdetail .sd-section.sd-openable:active { transform: none; }");
  });
});

describe("the dialog's own rhythm", () => {
  const rule = (sel: string) => {
    const i = css.indexOf(`${sel} {`);
    return i < 0 ? "" : css.slice(i, css.indexOf("}", i));
  };
  const pad = (sel: string) => {
    const m = rule(sel).match(/padding:\s*([^;]+);/);
    const parts = (m?.[1] ?? "").trim().split(/\s+/);
    // top right bottom left, CSS shorthand rules
    const [t, r, b] = parts.length === 2 ? [parts[0], parts[1], parts[0]] : parts;
    return { top: parseFloat(t), bottom: parseFloat(b ?? t), right: parseFloat(r) };
  };

  it("gives the sticky header a floor, so a scrolled row stops instead of vanishing", () => {
    // It was opaque and edgeless: rows went under the labels with nothing
    // marking where the header ended, and two are mid-disappearance at any
    // scroll position. Measured gap between header and first row: -0.8px.
    expect(rule(".pl-table thead th")).toContain("box-shadow: inset 0 -1px 0 var(--line)");
    // A shadow and not a border: a border on a sticky cell is painted by the
    // table rather than by the stuck box in more than one engine, which is how
    // a rule scrolls away from the header it belongs to.
    expect(rule(".pl-table thead th")).not.toContain("border-bottom");
  });

  it("puts the same air around every rule between peer bands", () => {
    // Four bands, three identical 1px rules, and the space around them was
    // 22 / 14 / 10 — not a cadence but a decay, each band having picked its own
    // padding locally. The further down you read the more cramped it got, and
    // the tightest rule sat above the densest text in the dialog.
    const body = pad(".pl-body"), strip = pad(".pl-strip"), foot = pad(".pl-foot");
    const head = 12; // .modal-head, shared by every dialog
    expect(body.bottom + strip.top).toBe(20);
    expect(strip.bottom + foot.top).toBe(20);
    // A title is not a peer, so it keeps slightly more.
    expect(head + body.top).toBe(22);
    // And the outer frame matches itself top and bottom.
    expect(foot.bottom).toBe(12);
  });

  it("makes the table the thing that gives, not the fixed bands", () => {
    // Both bands sit in a column flex box at its max height. With the default
    // shrink the browser took the room out of THEM — measured with the
    // sparklines hanging 9px below their own band, into the footer's space.
    expect(rule(".pl-strip")).toContain("flex-shrink: 0");
    expect(rule(".pl-foot")).toContain("flex-shrink: 0");
  });

  it("reserves the height the band actually needs", () => {
    // 41.3px of cell inside 10 + 10 of padding. Pinned against the padding it
    // is derived from, so changing one without the other fails here rather
    // than clipping a sparkline in the page.
    const strip = pad(".pl-strip");
    const min = Number(rule(".pl-strip").match(/min-height:\s*(\d+)px/)?.[1]);
    expect(min).toBeGreaterThanOrEqual(41 + strip.top + strip.bottom);
  });

  it("spends its column padding where the content changes kind, and nowhere else", () => {
    // The first version widened the gaps after `threads` and after `pid` to
    // group the columns three ways, and measuring every row said it did not
    // work: between two RIGHT-ALIGNED columns the ink gap is whatever the
    // shorter value leaves over. Measured across the table: 14-23, 43-57,
    // 18-28, 8, 13-70, 18. `memory → threads` — two numbers inside what should
    // be the tightest group — was the WIDEST gap in the table, because
    // `threads` is a 3-digit column under a 7-letter heading. No padding fixes
    // that, and right alignment is not the mistake: it is what lets a column be
    // read down, which is the whole reason to have one.
    //
    // The two boundaries padding does govern are the ones where a right-aligned
    // number meets left-aligned text. They are constant to the pixel, and they
    // are exactly where the reading changes kind — numbers to a name, name to
    // the command line. One of them was 8px, the tightest gap in the table.
    const padded = css.match(/\.pl-body \.pl-table th:nth-child\((\d)\),\n\.pl-body \.pl-table td:nth-child\(\d\),\n\.pl-body \.pl-table th:nth-child\((\d)\),\n\.pl-body \.pl-table td:nth-child\(\d\) \{ padding-right: 18px !important; \}/);
    expect(padded, "the two kind-change boundaries are padded together").not.toBeNull();
    // 4 is `up`, the last number before `user`; 6 is `pid`, the last before the
    // command line. Not 3 (`threads`), which is number-to-number.
    expect([padded![1], padded![2]]).toEqual(["4", "6"]);
  });
});

describe("the dialog's type", () => {
  const modalSrc = readFileSync(at("../components/ProcessListModal.tsx"), "utf8");
  const rule = (sel: string) => {
    const i = css.indexOf(`${sel} {`);
    return i < 0 ? "" : css.slice(i, css.indexOf("}", i));
  };

  it("keeps tabular figures for the columns that are numbers", () => {
    // What tabular is FOR: digits of one width so a column can be read down.
    // Six of the eight columns are numbers, so the table sets it and the
    // exceptions name themselves.
    expect(css).toContain(":is(.sysdetail, .pl-body) .sd-procs { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }");
  });

  it("takes them off the two columns that are prose", () => {
    // It reached the text columns as well, and there the feature does visible
    // harm: every digit in `--metrics-client-id=6ff2549f-9feb-40ee` and in
    // `--port 4319` padded to the width of a zero, inside a run of proportional
    // letters, so the numbers in a command line come out gappy and wider than
    // the words around them. An account name has it for the same reason.
    const off = rule(":is(.sysdetail, .pl-body) .sd-procs :is(.pl-name, .pl-user, .sd-proc-name)");
    expect(off).toContain("font-variant-numeric: normal");
    // Both tables, because it is one defect and one rule produced it.
    expect(off).toContain(".sd-proc-name");
  });

  it("writes the footnote as statements rather than as a paragraph", () => {
    // Run together in a box this wide it measured 142 characters a line over
    // four lines — nearly double the comfortable maximum, at the smallest size
    // in the dialog and in its dimmest colour. Split, the sentences are 103,
    // 119 and 89: they were written as readable units and the paragraph was
    // what ruined them. Each renders on ONE line at the dialog's own width, so
    // there is no return sweep at all.
    const foot = modalSrc.slice(modalSrc.indexOf('className="pl-foot"'));
    const body = foot.slice(0, foot.indexOf("</div>"));
    expect((body.match(/<p>/g) ?? []).length).toBe(3);
    expect(rule(".pl-foot p")).toContain("margin: 0");
    // Three captions in one footnote, not three paragraphs: the line break
    // already separates them and a paragraph's gap would make it read as a
    // list of rules.
    expect(rule(".pl-foot p + p")).toContain("margin-top: 3px");
  });

  it("gives the footnote's one literal the treatment every other literal has", () => {
    // `ps` reached the page as a bare family swap — monospace at the same 10px
    // in the same muted grey — which at that size reads as a rendering fault
    // rather than as a command you could type. The deck already treats inline
    // code this way in six other places.
    const code = rule(".pl-foot code");
    expect(code).toContain("background: var(--line)");
    expect(code).toContain("color: var(--text)");
    expect(code).toMatch(/font-family:\s*ui-monospace/);
    // The one place it is spelled in the markup, so a future footnote that
    // needs a second literal already has the shape.
    expect(modalSrc).toContain("<code>ps</code>");
  });
});

describe("the server publishes a key for every series", () => {
  it("gives one to each, because the label is platform-dependent", () => {
    // `Swap` is `Commit` on Windows, so anything joining a live reading to its
    // history by what the eye reads breaks on exactly the platform nobody
    // re-checks.
    expect(metrics).toContain('const swapLabel = process.platform === "win32" ? "Commit" : "Swap"');
    const body = metrics.slice(metrics.indexOf("function seriesFor"), metrics.indexOf("export function historySnapshot"));
    // Counted over `restsAtZero`, which the Series type requires of every
    // series and which nothing else in the function has. Counting `label`
    // instead was the first version and it counted seven for six: the
    // `new Map((thermal?.celsius ?? []).map(r => [r.label, r]))` above the
    // series is not a series.
    const seriesCount = (body.match(/\brestsAtZero:/g) ?? []).length;
    const keys = (body.match(/\bkey:/g) ?? []).length;
    expect(seriesCount).toBeGreaterThan(0);
    expect(keys).toBe(seriesCount);
  });
});
