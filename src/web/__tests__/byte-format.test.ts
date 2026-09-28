// The one byte formatter (#1128): one decimal place at every unit, "0 B" for
// zero. Run, not read — every case below calls the function.
import { describe, it, expect } from "vitest";
import { fmtBytes } from "../byte-format";
import { clientPairs, sourceOf } from "./client-source";

const KB = 1024, MB = 1024 ** 2, GB = 1024 ** 3, TB = 1024 ** 4;

describe("fmtBytes", () => {
  it("prints the owner's three examples", () => {
    expect(fmtBytes(MB)).toBe("1.0 MB");
    expect(fmtBytes(512 * KB)).toBe("512.0 KB");
    expect(fmtBytes(3.4 * GB)).toBe("3.4 GB");
  });

  it("says nothing plainly: zero is 0 B, with no decimal and no bigger unit", () => {
    // The machine panel's idle swap was "0 KB" and the process list's "0 B".
    expect(fmtBytes(0)).toBe("0 B");
  });

  it("gives bytes the same one decimal as every other unit", () => {
    expect(fmtBytes(1)).toBe("1.0 B");
    expect(fmtBytes(812)).toBe("812.0 B");
    expect(fmtBytes(1023)).toBe("1023.0 B");
  });

  it("steps up a unit at 1024, through to terabytes", () => {
    expect(fmtBytes(KB)).toBe("1.0 KB");
    expect(fmtBytes(1536)).toBe("1.5 KB");
    expect(fmtBytes(725 * MB)).toBe("725.0 MB");
    expect(fmtBytes(20.5 * GB)).toBe("20.5 GB");
    expect(fmtBytes(2 * TB)).toBe("2.0 TB");
    // Terabytes is the last unit, so a larger count stays in it.
    expect(fmtBytes(2048 * TB)).toBe("2048.0 TB");
  });

  it("picks the unit from the rounded figure, so no reading says 1024.0 of anything", () => {
    expect(fmtBytes(MB - 1)).toBe("1.0 MB");
    expect(fmtBytes(GB - 1)).toBe("1.0 GB");
    expect(fmtBytes(KB - 0.01)).toBe("1.0 KB");
    // Just under the promotion, the figure stays where it is.
    expect(fmtBytes(1023.9 * KB)).toBe("1023.9 KB");
  });

  it("reads a count nobody took as —, not as a number", () => {
    for (const n of [undefined, NaN, -1, Infinity, -Infinity]) expect(fmtBytes(n), String(n)).toBe("—");
  });

  it("prints exactly one decimal for every non-zero count, at every scale", () => {
    const seen = new Set<string>();
    for (let e = 0; e <= 44; e++) {
      for (const f of [1, 1.37, 3, 7.77]) {
        const s = fmtBytes(f * 2 ** e);
        expect(s, `${f} × 2^${e}`).toMatch(/^\d+\.\d (?:B|KB|MB|GB|TB)$/);
        seen.add(s.split(" ")[1]);
      }
    }
    // The sweep reached every unit, so a pass is not a pass over one of them.
    expect([...seen].sort()).toEqual(["B", "GB", "KB", "MB", "TB"]);
  });
});

describe("the three panels that each had their own (#1128)", () => {
  // The process list's fmtBytes, the machine panel's bytes and the context
  // modal's fmtKB, which printed one mebibyte as "1.0 MB", "1 MB" and "1.00 MB".
  const SITES: Array<[file: string, call: string]> = [
    ["components/ProcessListModal.tsx", "fmtBytes(p.rssBytes)"],
    ["components/MachinePanel.tsx", "fmtBytes(memory.total)"],
    ["components/ContextModal.tsx", "fmtBytes(f.bytes)"],
  ];

  it("print through this one", () => {
    for (const [file, call] of SITES) {
      const text = sourceOf(file);
      expect(text, file).toMatch(/import \{ fmtBytes \} from "\.\.\/byte-format";/);
      expect(text, file).toContain(call);
    }
  });

  it("leave no private copy behind anywhere in the client", () => {
    const copies = clientPairs()
      .filter(([file]) => file !== "byte-format.ts")
      .filter(([, text]) => /\bfunction (?:fmtBytes|fmtKB|bytes)\s*\(/.test(text))
      .map(([file]) => file);
    expect(copies).toEqual([]);
  });
});
