// The process table's header was three inert cells (#739). It looked like a
// table header, it was styled like one, and in every other table anybody has
// used a table header is where you click to sort. Here nothing happened.
//
// Making the cells controls is the easy half. The half worth a test file is
// that the server had already sorted and then truncated after sorting: `ps`
// returns a CPU-descending list and eight rows were kept from the top of it, so
// sorting those eight by memory produced a table that was honest about the rows
// it held and wrong about the question being asked. The machine's heaviest
// memory consumer need never have been in a CPU top eight at all. Nothing would
// have been empty and nothing would have errored — the same shape as #492, and
// the reason that class of bug survives review.
//
// So there are two contracts here and they are checked separately: the payload
// contains enough to rank either column truthfully (pickCandidates), and the
// panel spends it without ever printing an order it cannot support (sortProcs,
// visibleProcs).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parsePsProcesses, pickCandidates } from "../../server/system-metrics.mjs";
import {
  ariaSort, nextSort, sortProcs, visibleProcs,
  SORT_DEFAULT, type Proc, type Sort,
} from "../components/SystemMeter";

const proc = (pid: number, cpu: number | null, mem: number, name = `p${pid}`): Proc =>
  ({ pid, cpu, mem, name });

describe("what the server sends, given the client decides the order", () => {
  it("carries the heaviest process by memory even when it is idle", () => {
    // THE BUG, as a fixture. Twelve busy-but-small processes ahead of one
    // 30%-of-RAM process that is using no CPU at all. A top-3 by CPU excludes
    // it, and a memory ranking built from that top-3 is a lie about the
    // machine.
    const rows = [
      ...Array.from({ length: 12 }, (_, i) => proc(i + 1, 90 - i, 0.2)),
      proc(99, 0.1, 30.4, "Xcode"),
    ];
    const sent = pickCandidates(rows, 3);
    expect(sent.map(r => r.name)).toContain("Xcode");
  });

  it("still leads with the busiest, which is what the section is headed", () => {
    const rows = [proc(1, 5, 0.1), proc(2, 90, 0.1), proc(3, 40, 0.1)];
    expect(pickCandidates(rows, 3)[0].pid).toBe(2);
  });

  it("sends each process once, however many rankings reach it", () => {
    // The overlap is the normal case: on a real machine most of the CPU top N
    // is also in the memory top N.
    const rows = [proc(1, 90, 9), proc(2, 80, 8), proc(3, 70, 7)];
    expect(pickCandidates(rows, 3)).toHaveLength(3);
  });

  it("deduplicates by row and not by pid, so a pid it could not read costs nothing", () => {
    // parseGetProcessJson falls back to pid 0 for a row whose `Id` did not
    // parse, and more than one row can do that. A pid-keyed set would drop real
    // processes in order to deduplicate a placeholder.
    const rows = [proc(0, 90, 1, "a"), proc(0, 80, 2, "b"), proc(0, 70, 3, "c")];
    expect(pickCandidates(rows, 3).map(r => r.name).sort()).toEqual(["a", "b", "c"]);
  });

  it("does not let an unknown CPU take the busiest slot", () => {
    // A Windows first reading: every percentage is null because a rate needs
    // two samples. Unknown is not busiest, and it is not idle either — the row
    // still arrives, through the memory half.
    const rows = [proc(1, null, 9, "unknown"), proc(2, 12, 0.1, "known")];
    const sent = pickCandidates(rows, 1);
    expect(sent[0].name).toBe("known");
    expect(sent.map(r => r.name)).toContain("unknown");
  });

  it("hands back everything when the machine has less than a full ranking", () => {
    const rows = [proc(1, 3, 1), proc(2, 2, 2)];
    expect(pickCandidates(rows, 40)).toHaveLength(2);
  });
});

describe("the parser stopped truncating, which is what made the above possible", () => {
  const PS = ["  PID  %CPU %MEM COMM",
    ...Array.from({ length: 30 }, (_, i) => `${100 + i}  ${30 - i}.0  0.${i} proc${i}`)].join("\n");

  it("parses every row `ps` printed rather than the first eight", () => {
    // Selection belongs to pickCandidates, which cannot rank a column out of
    // rows this function has already thrown away.
    expect(parsePsProcesses(PS)).toHaveLength(30);
  });

  it("still honours an explicit limit, for a caller that wants one", () => {
    expect(parsePsProcesses(PS, 2)).toHaveLength(2);
  });
});

describe("what a click on a header does", () => {
  it("opens a quantity biggest-first and a name A to Z", () => {
    expect(nextSort(SORT_DEFAULT, "mem")).toMatchObject({ key: "mem", dir: "desc" });
    expect(nextSort(SORT_DEFAULT, "name")).toMatchObject({ key: "name", dir: "asc" });
  });

  it("flips the column you are already on", () => {
    const once = nextSort(SORT_DEFAULT, "cpu");
    expect(once.dir).toBe("asc");
    expect(nextSort(once, "cpu").dir).toBe("desc");
  });

  it("keeps the ranking column when the name is clicked", () => {
    // Sorting by name is a request to reorder these rows, not a request for a
    // different eight.
    const byMem = nextSort(SORT_DEFAULT, "mem");
    expect(nextSort(byMem, "name").rank).toBe("mem");
  });

  it("takes the ranking over when a quantity is clicked", () => {
    expect(nextSort(SORT_DEFAULT, "mem").rank).toBe("mem");
  });

  it("says the state in aria-sort's own words, once", () => {
    expect(ariaSort(SORT_DEFAULT, "cpu")).toBe("descending");
    expect(ariaSort(SORT_DEFAULT, "mem")).toBe("none");
    expect(ariaSort(nextSort(SORT_DEFAULT, "name"), "name")).toBe("ascending");
  });
});

describe("the ordering itself", () => {
  const sort = (key: Sort["key"], dir: Sort["dir"]): Sort =>
    ({ key, dir, rank: key === "name" ? "cpu" : key });

  it("puts an unknown CPU last in both directions", () => {
    const rows = [proc(1, null, 1, "unknown"), proc(2, 5, 1, "low"), proc(3, 90, 1, "high")];
    expect(sortProcs(rows, sort("cpu", "desc")).map(r => r.name)).toEqual(["high", "low", "unknown"]);
    // Ascending would rank a null as the smallest number if it were treated as
    // one. It is not a number.
    expect(sortProcs(rows, sort("cpu", "asc")).map(r => r.name)).toEqual(["low", "high", "unknown"]);
  });

  it("does not shuffle ties, whichever order they arrive in", () => {
    // `mem` reads 0.2 for half a real list. Without a fixed second key the
    // table would visibly reorder on every four-second poll while nothing had
    // changed.
    const rows = [proc(1, 10, 0.2), proc(2, 40, 0.2), proc(3, 25, 0.2)];
    const asGiven = sortProcs(rows, sort("mem", "desc")).map(r => r.pid);
    const reversed = sortProcs([...rows].reverse(), sort("mem", "desc")).map(r => r.pid);
    expect(asGiven).toEqual(reversed);
    expect(asGiven).toEqual([2, 3, 1]);   // the tie breaks on CPU, descending
  });

  it("breaks a tie the same way in both directions, so only the rows move", () => {
    const rows = [proc(1, 10, 0.2), proc(2, 40, 0.2)];
    expect(sortProcs(rows, sort("mem", "asc")).map(r => r.pid)).toEqual([2, 1]);
  });

  it("sorts names the way a reader reads them, not the way ASCII files them", () => {
    // ASCII puts every capital ahead of every lowercase letter, which would
    // leave WindowServer and ccusage in different halves of one list.
    const rows = [proc(1, 1, 1, "ccusage"), proc(2, 1, 1, "WindowServer"), proc(3, 1, 1, "aria")];
    expect(sortProcs(rows, sort("name", "asc")).map(r => r.name))
      .toEqual(["aria", "ccusage", "WindowServer"]);
  });

  it("leaves the caller's array alone", () => {
    const rows = [proc(1, 1, 1), proc(2, 9, 1)];
    sortProcs(rows, sort("cpu", "desc"));
    expect(rows.map(r => r.pid)).toEqual([1, 2]);
  });
});

describe("which eight rows are drawn", () => {
  // Ten candidates: five busy and small, five idle and large.
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => proc(i + 1, 90 - i, 0.1, `busy${i}`)),
    ...Array.from({ length: 5 }, (_, i) => proc(i + 11, 0.1, 20 - i, `fat${i}`)),
  ];

  it("shows the busiest by CPU at rest", () => {
    expect(visibleProcs(rows, SORT_DEFAULT, 3).map(r => r.name)).toEqual(["busy0", "busy1", "busy2"]);
  });

  it("changes WHICH rows appear when memory becomes the ranking", () => {
    // The whole point of the wider payload. A memory sort that could only
    // reorder the CPU top three would never name the machine's heaviest
    // process.
    const byMem = nextSort(SORT_DEFAULT, "mem");
    expect(visibleProcs(rows, byMem, 3).map(r => r.name)).toEqual(["fat0", "fat1", "fat2"]);
  });

  it("keeps the same rows when only the direction flips", () => {
    // Ascending by CPU is "the busiest, quietest first" — not "the quietest",
    // which would be a different section under a different heading.
    const asc = nextSort(SORT_DEFAULT, "cpu");
    expect(visibleProcs(rows, asc, 3).map(r => r.name)).toEqual(["busy2", "busy1", "busy0"]);
  });

  it("keeps the same rows when the name becomes the order", () => {
    const byMem = nextSort(SORT_DEFAULT, "mem");
    const byName = nextSort(byMem, "name");
    expect(visibleProcs(rows, byName, 3).map(r => r.name)).toEqual(["fat0", "fat1", "fat2"]);
    // Same three, alphabetically — which for this fixture is the order they
    // were already in, so a case where it is not:
    const named = [proc(1, 9, 1, "zsh"), proc(2, 8, 1, "node"), proc(3, 7, 1, "claude")];
    expect(visibleProcs(named, byName, 3).map(r => r.name)).toEqual(["claude", "node", "zsh"]);
  });

  it("draws what there is when the machine has fewer rows than that", () => {
    expect(visibleProcs([proc(1, 5, 1)], SORT_DEFAULT, 8)).toHaveLength(1);
  });
});

describe("the header is a control a keyboard can reach", () => {
  // No DOM in this suite, so the markup is read rather than rendered — the same
  // way control-defects-546.test.ts reads the controls it pins.
  const src = readFileSync(fileURLToPath(new URL("../components/SystemMeter.tsx", import.meta.url)), "utf8");

  it("puts a real button inside a real column header", () => {
    expect(src).toMatch(/<th scope="col" aria-sort=\{state\}>/);
    expect(src).toMatch(/<button\s+type="button"\s+className="sd-sort"/);
  });

  it("names itself with the word in the column, and describes the press in a title", () => {
    // The accessible name comes from the contents, so a voice-control user says
    // the word they can see. The tooltip is the description.
    expect(src).toMatch(/title=\{`Sort by \$\{label\}`\}/);
  });

  it("hides the arrow from the reading, because aria-sort has already said it", () => {
    expect(src).toMatch(/className="sd-sort-dir" aria-hidden/);
  });

  it("holds the sort in the panel rather than in storage", () => {
    // It resets when the panel closes. A preference nobody would remember
    // setting is not worth a key that outlives the question.
    expect(src).toMatch(/useState<Sort>\(SORT_DEFAULT\)/);
    expect(src, "the sort is being persisted").not.toMatch(/systemPanelSort|sortKey.*localStorage/);
  });
});
