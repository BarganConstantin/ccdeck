// Browser Watch reads Chrome's `History` database, and every one of the three
// things that can go wrong there fails silently if it is got wrong.
//
// A JS number cannot hold `visit_time`. Chrome counts microseconds since 1601,
// so a value today is ~1.34e16 and 2^53 is 9.0e15. That is not a rounding
// nuisance: `node:sqlite` refuses the read outright —
//
//   RangeError: The value of column 0 is too large to be represented as a
//   JavaScript number: 13432716408648765   (code: ERR_OUT_OF_RANGE)
//
// — and it throws from `.all()`, so ONE such column loses EVERY row of the
// query. `CAST(… AS TEXT)` is the fix and it is the kind of fix that gets
// deleted by someone tidying up a SELECT, because the schema says INTEGER and
// the cast looks redundant. The suite therefore asserts the SQL TEXT the module
// hands to each backend, not just the rows that come back: with the casts
// removed a fake reader returns the same rows and only a real database on a real
// machine notices, which is the definition of a bug that ships.
//
// The live file cannot be opened. Chrome holds an exclusive lock, so a read-only
// open of the real path answers `database is locked` on the first statement —
// measured against a running Brave here. The module copies the file and reads the
// copy, and the case below pins that by asserting the path the reader is handed
// is the copy and never the original.
//
// There may be no SQLite reader at all. `node:sqlite` starts at Node 22.5 and
// this package supports Node 18; CI runs Node 20. The `sqlite3` CLI covers macOS
// and most Linux and does not exist on Windows. So "no reader" is a state one of
// the three CI legs is always in, and it has to answer `degraded: true` with
// empty rows rather than throw — the caller falls back to the file's mtime.
//
// HOW THESE CASES RUN EVERYWHERE. The backend, the filesystem and the command
// runner are all injected, so no case here needs SQLite, a browser, or a
// platform. That is deliberate rather than convenient: a gate would have to be
// registered in skip-gates.mjs and would leave the interesting cases running on
// one leg of the matrix. The two cases that do touch the real machine ("this
// machine" below) assert the same contract whichever of the three answers it
// gives, so they are real assertions on all three legs rather than a skip
// wearing a condition.
import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { withoutComments } from "./tsx-scan";
import { dirname, join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
import {
  chromeTimeToMs,
  msToChromeTime,
  readVisitsSince,
  sqliteBackend,
} from "../../server/browser-history.mjs";

type RawRow = { url: string; t: string; tr: string };

/** Everything the module did to the outside world during one call. */
type Trace = {
  mkdir: Array<{ dir: string; opts: unknown }>;
  copies: Array<{ from: string; to: string }>;
  removed: string[];
  /** Paths handed to a SQLite reader — the assertion that the live file is never one. */
  opened: Array<{ file: string; options: unknown }>;
  /** SQL as each backend received it, which is what the CAST rule is about. */
  sql: string[];
  params: unknown[][];
  closed: number;
  ran: Array<{ bin: string; args: string[]; opts: Record<string, unknown> }>;
};

const newTrace = (): Trace => ({
  mkdir: [], copies: [], removed: [], opened: [], sql: [], params: [], closed: 0, ran: [],
});

/** The filesystem half of `deps`: records, touches nothing. */
function fakeFs(trace: Trace, failCopy?: Error) {
  return {
    mkdir: async (dir: string, opts: unknown) => { trace.mkdir.push({ dir, opts }); },
    copyFile: async (from: string, to: string) => {
      trace.copies.push({ from, to });
      if (failCopy) throw failCopy;
    },
    rm: async (path: string) => { trace.removed.push(path); },
  };
}

/**
 * A stand-in for `node:sqlite`.
 *
 * `openThrows` is the torn-copy case: the real reader throws
 * `Error: file is not a database` from the constructor, reproduced here by
 * handing the real one 4 KB of /dev/urandom.
 */
function fakeSqlite(trace: Trace, rows: RawRow[], openThrows?: Error) {
  return async () => ({
    DatabaseSync: class {
      constructor(file: string, options: unknown) {
        trace.opened.push({ file, options });
        if (openThrows) throw openThrows;
      }
      prepare(sql: string) {
        trace.sql.push(sql);
        return { all: (...params: unknown[]) => { trace.params.push(params); return rows; } };
      }
      close() { trace.closed += 1; }
    },
  });
}

// The separators sqlite3 -ascii uses: 0x1F between columns, 0x1E after every
// row including the last. Written as escapes, never as the bytes themselves —
// see source-nul-bytes.test.ts for what a raw control byte does to grep.
const UNIT = "\u001f";
const RECORD = "\u001e";

const asciiOf = (rows: RawRow[]) =>
  rows.map(r => [r.url, r.t, r.tr].join(UNIT) + RECORD).join("");

/** Everything up to ` FROM `, which is the part the CAST rule is about. */
const selectList = (sql: string) => sql.slice(0, sql.indexOf(" FROM "));

/** The command-runner half of `deps`, shaped like exec.mjs's `run`. */
function fakeRun(trace: Trace, result: Partial<{ ok: boolean; code: unknown; stdout: string; stderr: string }>) {
  return async (bin: string, args: string[], opts: Record<string, unknown>) => {
    trace.ran.push({ bin, args, opts });
    return { ok: true, code: 0, killed: false, timedOut: false, stdout: "", stderr: "", ...result };
  };
}

/** A chrome time `n` milliseconds after the epoch reference below. */
const CHROME_EPOCH_US = 11644473600000000n;
const chromeAt = (ms: number) => String(BigInt(ms) * 1000n + CHROME_EPOCH_US);

const ROW_A: RawRow = { url: "https://example.com/a", t: "13432716408648765", tr: "805306368" };
const ROW_B: RawRow = { url: "https://example.com/b", t: "13432716408649999", tr: "0" };

describe("chrome time, which does not fit in a JavaScript number", () => {
  it("round-trips a known wall-clock instant in both directions", () => {
    // 2026-09-01T06:06:48.648Z, checked against the machine's own clock while
    // the real profile was open. Both halves are pinned: a conversion that is
    // wrong by a constant round-trips perfectly and is still wrong.
    const iso = "2026-09-01T06:06:48.648Z";
    const ms = Date.parse(iso);
    expect(ms).toBe(1788242808648);

    expect(msToChromeTime(ms)).toBe("13432716408648000");
    expect(chromeTimeToMs("13432716408648000")).toBe(ms);
    expect(new Date(chromeTimeToMs("13432716408648000")).toISOString()).toBe(iso);

    // The Unix epoch itself is the offset stated as a value, so a wrong delta
    // cannot hide behind a matching pair.
    expect(msToChromeTime(0)).toBe("11644473600000000");
    expect(chromeTimeToMs("11644473600000000")).toBe(0);
  });

  it("converts a real value past 2^53 to an exact integer millisecond", () => {
    // Straight off the real database. `Number(t) / 1000 - 11644473600000` — the
    // obvious spelling — answers 1788242808648.7637 here: a FRACTIONAL
    // millisecond, because the input was rounded before it was ever divided.
    const ms = chromeTimeToMs("13432716408648765");
    expect(ms).toBe(1788242808648);
    expect(Number.isInteger(ms)).toBe(true);
    expect(Number("13432716408648765")).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
  });

  it("answers with a string, because a chrome time is past the safe range", () => {
    const t = msToChromeTime(1788242808648);
    expect(typeof t).toBe("string");
    expect(Number(t)).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    // A whole millisecond happens to land on an even value, which a double can
    // still hold. The MICROSECOND values that actually come out of the column
    // do not, and that is the whole reason for the CAST and for this string:
    // node:sqlite refuses to read them as integers at all.
    expect(String(Number("13432716408648765"))).not.toBe("13432716408648765");
  });

  it("answers NaN for a value that is not a run of digits, instead of throwing", () => {
    // BigInt("") and BigInt("nope") both throw SyntaxError, and this runs once
    // per row inside a poll — one unreadable row must not cost the request.
    for (const junk of ["", "   ", "nope", "12e5", "1.5", null, undefined, {}]) {
      expect(chromeTimeToMs(junk as never)).toBeNaN();
    }
    expect(msToChromeTime(Number.NaN)).toBe("0");
    expect(msToChromeTime("nope" as never)).toBe("0");
  });
});

describe("the SQL every backend is handed", () => {
  it("casts visit_time AND transition to TEXT on the in-process path", async () => {
    const trace = newTrace();
    await readVisitsSince("/profile/History", "13000000000000000", {
      copyDir: "/copies",
      backend: { kind: "node-sqlite" },
      deps: { ...fakeFs(trace), importSqlite: fakeSqlite(trace, [ROW_A]) },
    });

    expect(trace.sql).toHaveLength(1);
    const sql = trace.sql[0];
    // Both casts, spelled out. Without the visit_time one the real reader
    // throws ERR_OUT_OF_RANGE and loses every row; without the transition one
    // the same failure is one Chrome release away, and it is per-STATEMENT, so
    // it takes the URLs down with it. The whole select list is pinned rather
    // than searched, because "contains a CAST somewhere" would still pass with
    // one of the two columns read raw.
    expect(selectList(sql)).toBe(
      "SELECT u.url AS url, CAST(v.visit_time AS TEXT) t, CAST(v.transition AS TEXT) tr",
    );
    expect(sql).toContain("ORDER BY v.visit_time");
    expect(sql).toContain("JOIN urls u ON u.id = v.url");
  });

  it("binds the floor as a BigInt rather than leaning on column affinity", async () => {
    const trace = newTrace();
    await readVisitsSince("/profile/History", "13000000000000000", {
      copyDir: "/copies",
      backend: { kind: "node-sqlite" },
      deps: { ...fakeFs(trace), importSqlite: fakeSqlite(trace, []) },
    });
    // A string parameter would compare through SQLite's implicit TEXT→INTEGER
    // conversion — it happens to work and it works by accident of the schema.
    expect(trace.sql[0]).toContain("v.visit_time > ?");
    expect(trace.params).toEqual([[13000000000000000n]]);
  });

  it("casts on the CLI path too, where the floor is inlined and cannot be bound", async () => {
    const trace = newTrace();
    await readVisitsSince("/profile/History", "13000000000000000", {
      copyDir: "/copies",
      backend: { kind: "sqlite3-cli", bin: "/usr/bin/sqlite3" },
      deps: { ...fakeFs(trace), run: fakeRun(trace, { stdout: asciiOf([ROW_A]) }) },
    });

    expect(trace.ran).toHaveLength(1);
    const { bin, args } = trace.ran[0];
    expect(bin).toBe("/usr/bin/sqlite3");
    const sql = args[args.length - 1];
    expect(selectList(sql)).toBe(
      "SELECT u.url AS url, CAST(v.visit_time AS TEXT) t, CAST(v.transition AS TEXT) tr",
    );
    expect(sql).toContain("v.visit_time > 13000000000000000");
    // -readonly so the CLI writes no journal beside the copy; -ascii because
    // -json needs sqlite3 3.33 and Ubuntu 20.04 ships 3.31.
    expect(args.slice(0, 2)).toEqual(["-readonly", "-ascii"]);
    // The steady poll returns kilobytes; a watermark of 0 asks for the whole
    // history, and run's 4 MB default turns that into ENOBUFS.
    expect(Number(trace.ran[0].opts.maxBuffer)).toBeGreaterThan(4 << 20);
  });

  it("never pastes a non-numeric watermark into the CLI command line", async () => {
    const trace = newTrace();
    await readVisitsSince("/profile/History", "0; DROP TABLE urls;--", {
      copyDir: "/copies",
      backend: { kind: "sqlite3-cli", bin: "/usr/bin/sqlite3" },
      deps: { ...fakeFs(trace), run: fakeRun(trace, { stdout: "" }) },
    });
    const sql = trace.ran[0].args[trace.ran[0].args.length - 1];
    expect(sql).not.toContain("DROP");
    expect(sql).toContain("v.visit_time > 0");
  });
});

describe("which reader this machine has", () => {
  const lookupFinding = (bin: string | null) => () => bin;

  it("prefers node:sqlite when the dynamic import answers", async () => {
    const backend = await sqliteBackend({
      importSqlite: async () => ({ DatabaseSync: class {} }),
      lookup: lookupFinding("/usr/bin/sqlite3"),
      platform: "darwin",
      env: { PATH: "/usr/bin" },
    });
    // In-process beats a spawn per poll, so the CLI being present must not win.
    expect(backend).toEqual({ kind: "node-sqlite" });
  });

  it("falls back to the sqlite3 CLI when the import throws, as it does on Node 20", async () => {
    const seen: unknown[][] = [];
    const backend = await sqliteBackend({
      importSqlite: async () => { throw Object.assign(new Error("No such built-in module: node:sqlite"), { code: "ERR_UNKNOWN_BUILTIN_MODULE" }); },
      lookup: (...args: unknown[]) => { seen.push(args); return "C:\\tools\\sqlite3.exe"; },
      platform: "win32",
      env: { PATH: "C:\\tools" },
    });
    expect(backend).toEqual({ kind: "sqlite3-cli", bin: "C:\\tools\\sqlite3.exe" });
    // Through the repo's own PATH walk, with the platform passed: spawn is not
    // a shell and applies no PATHEXT, so a bare-name probe answers ENOENT on
    // the one platform where the answer decides whether the feature exists.
    expect(seen[0][0]).toBe("sqlite3");
    expect(seen[0][1]).toBe("win32");
    expect(seen[0][2]).toEqual({ pathEnv: "C:\\tools" });
  });

  it("answers none when there is neither — the Windows case", async () => {
    const backend = await sqliteBackend({
      importSqlite: async () => { throw new Error("No such built-in module: node:sqlite"); },
      lookup: lookupFinding(null),
      platform: "win32",
      env: { PATH: "C:\\Windows\\System32" },
    });
    expect(backend).toEqual({ kind: "none" });
  });

  it("refuses a node:sqlite that has no DatabaseSync", async () => {
    // Selecting it and then throwing once per poll is worse than not selecting
    // it: the failure would arrive as "unreadable-copy" for every browser.
    const backend = await sqliteBackend({
      importSqlite: async () => ({ default: {} }),
      lookup: lookupFinding("/usr/bin/sqlite3"),
      platform: "linux",
      env: { PATH: "/usr/bin" },
    });
    expect(backend).toEqual({ kind: "sqlite3-cli", bin: "/usr/bin/sqlite3" });
  });

  it("caches the real answer and never caches an injected one", async () => {
    // Same object twice: the probe is one dynamic import and one PATH walk, and
    // this runs on a poll.
    expect(await sqliteBackend()).toBe(await sqliteBackend());
    // And a probe with a made-up PATH must not become this process's permanent
    // answer, nor be answered from a cache it never filled.
    const injected = await sqliteBackend({
      importSqlite: async () => { throw new Error("nope"); },
      lookup: () => null,
      platform: "win32",
      env: { PATH: "" },
    });
    expect(injected).toEqual({ kind: "none" });
    expect(await sqliteBackend()).toBe(await sqliteBackend());
  });
});

describe("reading visits", () => {
  it("reads a copy and never the file Chrome has locked", async () => {
    const trace = newTrace();
    const live = join("/profile", "History");
    await readVisitsSince(live, "13000000000000000", {
      copyDir: "/copies",
      backend: { kind: "node-sqlite" },
      deps: { ...fakeFs(trace), importSqlite: fakeSqlite(trace, [ROW_A]) },
    });

    expect(trace.mkdir[0].dir).toBe("/copies");
    expect(trace.copies).toHaveLength(1);
    expect(trace.copies[0].from).toBe(live);
    // The reader is handed the copy. A read-only open of the live path answers
    // `database is locked` while Chrome runs, so this is the whole feature.
    expect(trace.opened).toHaveLength(1);
    expect(trace.opened[0].file).toBe(trace.copies[0].to);
    expect(trace.opened[0].file).not.toBe(live);
    expect(dirname(trace.opened[0].file)).toBe(join("/copies"));
    expect(trace.opened[0].options).toEqual({ readOnly: true });
  });

  it("shapes rows as url, millisecond time and numeric transition", async () => {
    const trace = newTrace();
    const out = await readVisitsSince("/profile/History", "13000000000000000", {
      copyDir: "/copies",
      backend: { kind: "node-sqlite" },
      deps: { ...fakeFs(trace), importSqlite: fakeSqlite(trace, [ROW_A, ROW_B]) },
    });

    expect(out.degraded).toBe(false);
    expect(out.reason).toBeNull();
    expect(out.rows).toEqual([
      { url: "https://example.com/a", timeMs: 1788242808648, transition: 805306368 },
      { url: "https://example.com/b", timeMs: 1788242808649, transition: 0 },
    ]);
    // A string here would be drawn as one and compared as one; transition is a
    // bit field the caller masks.
    expect(typeof out.rows[0].transition).toBe("number");
  });

  it("advances the watermark to the newest row, whatever order they arrive in", async () => {
    const trace = newTrace();
    const out = await readVisitsSince("/profile/History", "13000000000000000", {
      copyDir: "/copies",
      backend: { kind: "node-sqlite" },
      // Deliberately not sorted. The ORDER BY makes them sorted today; a
      // watermark taken from the last row rather than the largest one is the
      // one mistake here that loses rows permanently rather than for a poll.
      deps: { ...fakeFs(trace), importSqlite: fakeSqlite(trace, [ROW_B, ROW_A]) },
    });
    expect(out.watermark).toBe(ROW_B.t);
    expect(BigInt(out.watermark)).toBeGreaterThan(BigInt(ROW_A.t));
  });

  it("hands the watermark back unchanged when nothing is new", async () => {
    const trace = newTrace();
    const out = await readVisitsSince("/profile/History", "13432716408648765", {
      copyDir: "/copies",
      backend: { kind: "node-sqlite" },
      deps: { ...fakeFs(trace), importSqlite: fakeSqlite(trace, []) },
    });
    expect(out.rows).toEqual([]);
    expect(out.degraded).toBe(false);
    expect(out.watermark).toBe("13432716408648765");
  });

  it("normalises a first call with no watermark to the 1601 floor", async () => {
    const trace = newTrace();
    const out = await readVisitsSince("/profile/History", undefined, {
      copyDir: "/copies",
      backend: { kind: "node-sqlite" },
      deps: { ...fakeFs(trace), importSqlite: fakeSqlite(trace, []) },
    });
    // A string either way, so a caller can store the answer without a special
    // case for "there was nothing yet".
    expect(out.watermark).toBe("0");
    expect(trace.params).toEqual([[0n]]);
  });

  it("drops a row it cannot read rather than letting it become the watermark", async () => {
    const trace = newTrace();
    const out = await readVisitsSince("/profile/History", "13000000000000000", {
      copyDir: "/copies",
      backend: { kind: "node-sqlite" },
      deps: {
        ...fakeFs(trace),
        importSqlite: fakeSqlite(trace, [
          ROW_A,
          { url: "https://example.com/junk", t: "not-a-time", tr: "0" },
          { url: "", t: "13432716408650000", tr: "0" },
        ]),
      },
    });
    expect(out.rows.map(r => r.url)).toEqual(["https://example.com/a"]);
    // The dropped rows must not move the watermark: a floor taken from a value
    // the module could not read skips every real row behind it, forever.
    expect(out.watermark).toBe(ROW_A.t);
  });

  it("parses the CLI's ascii records, trailing separator and all", async () => {
    const trace = newTrace();
    const out = await readVisitsSince("/profile/History", "13000000000000000", {
      copyDir: "/copies",
      backend: { kind: "sqlite3-cli", bin: "/usr/bin/sqlite3" },
      deps: { ...fakeFs(trace), run: fakeRun(trace, { stdout: asciiOf([ROW_A, ROW_B]) }) },
    });
    expect(out.rows).toEqual([
      { url: "https://example.com/a", timeMs: 1788242808648, transition: 805306368 },
      { url: "https://example.com/b", timeMs: 1788242808649, transition: 0 },
    ]);
    expect(out.watermark).toBe(ROW_B.t);
    expect(out.degraded).toBe(false);
  });

  it("deletes the copy afterwards, on the good path and the bad one", async () => {
    const ok = newTrace();
    await readVisitsSince("/profile/History", "0", {
      copyDir: "/copies",
      backend: { kind: "node-sqlite" },
      deps: { ...fakeFs(ok), importSqlite: fakeSqlite(ok, [ROW_A]) },
    });
    // 21 MB per poll, and it is a full unencrypted list of everywhere the user
    // has been, sitting in a temp directory under a predictable name.
    expect(ok.removed).toEqual([ok.copies[0].to]);

    const torn = newTrace();
    await readVisitsSince("/profile/History", "0", {
      copyDir: "/copies",
      backend: { kind: "node-sqlite" },
      deps: { ...fakeFs(torn), importSqlite: fakeSqlite(torn, [], new Error("file is not a database")) },
    });
    expect(torn.removed).toEqual([torn.copies[0].to]);
  });

  it("gives each copy its own name, so one poll never reads the last one's file", async () => {
    const trace = newTrace();
    for (let i = 0; i < 3; i++) {
      await readVisitsSince("/profile/History", "0", {
        copyDir: "/copies",
        backend: { kind: "node-sqlite" },
        deps: { ...fakeFs(trace), importSqlite: fakeSqlite(trace, []) },
      });
    }
    expect(new Set(trace.copies.map(c => c.to)).size).toBe(3);
    // The pid is in there because two decks can share one copyDir.
    for (const c of trace.copies) expect(c.to).toContain(String(process.pid));
  });
});

describe("what happens when it cannot read", () => {
  it("reports degraded with no rows when the machine has no SQLite at all", async () => {
    const trace = newTrace();
    const out = await readVisitsSince("/profile/History", "13432716408648765", {
      copyDir: "/copies",
      backend: { kind: "none" },
      deps: { ...fakeFs(trace), importSqlite: fakeSqlite(trace, [ROW_A]) },
    });

    expect(out.degraded).toBe(true);
    expect(out.rows).toEqual([]);
    // The caller falls back to the file's mtime — "something navigated at X, no
    // URL" — and needs its watermark back untouched to keep doing that.
    expect(out.watermark).toBe("13432716408648765");
    expect(out.reason).toMatch(/^no-sqlite-reader: /);
    // And it does not copy 21 MB to find out there is nothing to read it with.
    expect(trace.copies).toEqual([]);
  });

  it("reports a torn database image instead of throwing", async () => {
    // The real failure, verbatim: a copy taken while Chrome was mid-transaction
    // (journal_mode is `delete` here, not WAL) can be a torn page, and
    // node:sqlite answers `Error: file is not a database` from the constructor.
    // Thrown, this takes the whole deck down from inside a poll.
    const trace = newTrace();
    const out = await readVisitsSince("/profile/History", "13432716408648765", {
      copyDir: "/copies",
      backend: { kind: "node-sqlite" },
      deps: { ...fakeFs(trace), importSqlite: fakeSqlite(trace, [], new Error("file is not a database")) },
    });

    expect(out.degraded).toBe(true);
    expect(out.rows).toEqual([]);
    expect(out.watermark).toBe("13432716408648765");
    expect(out.reason).toBe("unreadable-copy: file is not a database");
  });

  it("reports a torn image the CLI refused, naming the tool that refused it", async () => {
    const trace = newTrace();
    const out = await readVisitsSince("/profile/History", "13432716408648765", {
      copyDir: "/copies",
      backend: { kind: "sqlite3-cli", bin: "/usr/bin/sqlite3" },
      deps: {
        ...fakeFs(trace),
        // Exactly what /usr/bin/sqlite3 3.51.0 says to 4 KB of urandom.
        run: fakeRun(trace, { ok: false, code: 26, stderr: "Error: in prepare, file is not a database (26)" }),
      },
    });
    expect(out.degraded).toBe(true);
    expect(out.rows).toEqual([]);
    expect(out.reason).toMatch(/^unreadable-copy: sqlite3 exited 26/);
    expect(out.reason).toContain("file is not a database");
  });

  it("reports a browser that is not installed as a copy failure, not a crash", async () => {
    const trace = newTrace();
    const enoent = Object.assign(new Error("ENOENT: no such file or directory, copyfile"), { code: "ENOENT" });
    const out = await readVisitsSince("/nowhere/History", "13432716408648765", {
      copyDir: "/copies",
      backend: { kind: "node-sqlite" },
      deps: { ...fakeFs(trace, enoent), importSqlite: fakeSqlite(trace, [ROW_A]) },
    });
    expect(out.degraded).toBe(true);
    expect(out.rows).toEqual([]);
    expect(out.watermark).toBe("13432716408648765");
    expect(out.reason).toMatch(/^copy-failed: ENOENT/);
    expect(trace.opened).toEqual([]);
  });

  it("keeps the reason to one line, however many the error had", async () => {
    const trace = newTrace();
    const out = await readVisitsSince("/profile/History", "0", {
      copyDir: "/copies",
      backend: { kind: "node-sqlite" },
      deps: {
        ...fakeFs(trace),
        importSqlite: fakeSqlite(trace, [], new Error(`file is not a database\n${"x".repeat(5000)}`)),
      },
    });
    // This ends up in a log line and, one day, in a panel.
    expect(out.reason).toBe("unreadable-copy: file is not a database");
    expect(out.reason!.length).toBeLessThan(250);
  });
});

describe("this machine, whichever of the three answers it gives", () => {
  it("names a backend of a known kind, with a bin whenever it is the CLI", async () => {
    const backend = await sqliteBackend();
    expect(["node-sqlite", "sqlite3-cli", "none"]).toContain(backend.kind);
    if (backend.kind === "sqlite3-cli") {
      expect(typeof backend.bin).toBe("string");
      expect(backend.bin.length).toBeGreaterThan(0);
    } else {
      expect(backend).toEqual({ kind: backend.kind });
    }
  });

  it("survives a real torn file on the real reader and leaves no copy behind", async () => {
    // No fakes at all below this line: the real filesystem, the real backend,
    // and 4 KB of random bytes standing in for the copy that landed mid-write.
    // Every leg of the CI matrix reaches a different arm of this — Windows has
    // no reader, Node 20 on Linux and macOS uses the sqlite3 CLI, a developer
    // machine on Node 22 uses node:sqlite — and all three owe the same answer.
    const root = mkdtempSync(join(tmpdir(), "ccdeck-bh-"));
    try {
      const history = join(root, "History");
      writeFileSync(history, randomBytes(4096));
      const copies = join(root, "copies");

      const out = await readVisitsSince(history, "13432716408648765", { copyDir: copies });

      expect(out.rows).toEqual([]);
      expect(out.degraded).toBe(true);
      expect(out.watermark).toBe("13432716408648765");
      expect(out.reason).toMatch(/^(no-sqlite-reader|unreadable-copy|copy-failed): /);
      // The copy is deleted whichever way it failed; on the "none" arm it is
      // never made, so the directory may not exist at all.
      const left = existsSync(copies) ? readdirSync(copies).filter(n => n.startsWith("history-")) : [];
      expect(left).toEqual([]);
    } finally {
      rmTempDir(root);
    }
  });
});

describe("the branch most users run, and the reason it was untestable", () => {
  it("resolves to node:sqlite here, rather than quietly falling to the CLI", async () => {
    // This is the whole point of the createRequire loader. `await
    // import("node:sqlite")` is what this module used to say, and under vitest
    // vite strips the `node:` prefix and looks for a package called `sqlite`
    // (vitest-dev/vitest#7177) — so the import threw, the catch swallowed it,
    // and sqliteBackend() answered `sqlite3-cli` in EVERY case here. Nothing
    // failed. The suite was green about a branch it could not reach, which is
    // worse than a red one.
    //
    // Guarded on the runtime rather than skipped, so this case says something
    // on a Node without the module too: there it must be the CLI or nothing,
    // and it must never be node-sqlite.
    let has = true;
    try { createRequire(import.meta.url)("node:sqlite"); } catch { has = false; }

    const backend = await sqliteBackend();
    if (has) {
      expect(backend.kind, "the runtime has node:sqlite and the module must use it").toBe("node-sqlite");
    } else {
      expect(["sqlite3-cli", "none"]).toContain(backend.kind);
    }
  });

  it("does not reach for the module through the bundler", () => {
    // The spelling that reintroduces the bug, refused by name. A dynamic
    // `import("node:sqlite")` reads as more idiomatic and would pass every
    // other case in this file.
    // Through withoutComments, because the module explains the trap in prose
    // directly above the fix — and a check that cannot tell the warning from
    // the mistake would fail on the file that gets it right.
    const src = withoutComments(readFileSync(
      fileURLToPath(new URL("../../server/browser-history.mjs", import.meta.url)), "utf8"));
    expect(src).not.toMatch(/import\(\s*["']node:sqlite["']\s*\)/);
    expect(src).toMatch(/createRequire\(import\.meta\.url\)/);
  });
});

/** Does this runtime have the in-process reader at all? Node 22.5+, which every
 *  CI leg is, and which the register in skip-gates.mjs records — the two cases
 *  below BUILD a database with it, so unlike the branch case above they cannot
 *  say anything useful without it. */
const hasNodeSqlite = (() => {
  try { createRequire(import.meta.url)("node:sqlite"); return true; } catch { return false; }
})();

describe.skipIf(!hasNodeSqlite)("a real database, with a real Chrome timestamp in it", () => {
  it("reads a real Chrome database whose visit_time is past 2^53", async () => {
    // The claim this whole file is built around, finally made against a real
    // SQLite file instead of against the text of a SELECT.
    //
    // Every other case here proves the CAST is in the SQL, or that a fake
    // reader was handed it. None of them can fail if the cast is correct in
    // spelling and wrong in effect, and none can fail if node:sqlite one day
    // stops refusing the column — which is the day all that text-matching
    // becomes a rule nobody needs. A database with a genuine 1.34e16 in it
    // answers both questions by being read.
    const dir = mkdtempSync(join(tmpdir(), "ccdeck-real-chrome-"));
    try {
      const historyPath = join(dir, "History");
      const db = new (createRequire(import.meta.url)("node:sqlite").DatabaseSync)(historyPath);
      // Chrome's own shape, cut down to the two tables and the four columns the
      // module's SELECT touches. INTEGER, as Chrome declares them — the schema
      // is exactly what makes the cast look redundant to a tidier.
      db.exec("CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT)");
      db.exec("CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER, transition INTEGER)");
      db.exec("INSERT INTO urls (id, url) VALUES (1, 'https://news.example/story')");
      // The value from the module's own error message: microseconds since 1601,
      // measured off a real profile, and 1.49x the safe integer limit.
      db.exec("INSERT INTO visits (id, url, visit_time, transition) VALUES (1, 1, 13432716408648765, 805306368)");
      db.close();

      const got = await readVisitsSince(historyPath, "0", { copyDir: join(dir, "copies") });
      expect(got.degraded, `the real read degraded: ${got.reason}`).toBeFalsy();
      expect(got.rows).toHaveLength(1);
      expect(got.rows[0].url).toBe("https://news.example/story");
      // Converted, not passed through: the row's time is a millisecond number
      // the rest of the deck can do arithmetic on.
      expect(got.rows[0].timeMs).toBe(chromeTimeToMs("13432716408648765"));
      expect(got.rows[0].transition).toBe(805306368);
      expect(got.watermark).toBe("13432716408648765");
    } finally {
      rmTempDir(dir);
    }
  });

  it("would lose every row of that read without the cast, which is why it is there", () => {
    // The other half, and the reason a tidier must not delete `CAST(… AS TEXT)`
    // from a column the schema calls INTEGER. Run against the same shape of
    // database, with the cast removed: node:sqlite does not round, or return
    // null, or drop the one row — it THROWS, from `.all()`, so a single
    // unreadable column costs the entire query.
    const dir = mkdtempSync(join(tmpdir(), "ccdeck-uncast-chrome-"));
    try {
      const historyPath = join(dir, "History");
      const db = new (createRequire(import.meta.url)("node:sqlite").DatabaseSync)(historyPath);
      db.exec("CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT)");
      db.exec("CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER, transition INTEGER)");
      db.exec("INSERT INTO urls (id, url) VALUES (1, 'https://news.example/story')");
      db.exec("INSERT INTO visits (id, url, visit_time, transition) VALUES (1, 1, 13432716408648765, 805306368)");
      const uncast = db.prepare(
        "SELECT u.url AS url, v.visit_time t, v.transition tr"
        + " FROM visits v JOIN urls u ON u.id = v.url WHERE v.visit_time > 0 ORDER BY v.visit_time");
      expect(() => uncast.all(), "node:sqlite stopped refusing the column — the cast may no longer be load-bearing")
        .toThrow(/too large to be represented as a JavaScript number|ERR_OUT_OF_RANGE/);
      db.close();
    } finally {
      rmTempDir(dir);
    }
  });
});
