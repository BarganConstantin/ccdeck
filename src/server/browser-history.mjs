// Reading Chrome's visit log out from under a browser that is still writing it.
//
// Browser Watch wants one thing: the URLs navigated to since the last poll.
// Chrome (and every Chromium fork — Brave, Edge, Vivaldi) keeps them in a
// SQLite file called `History` in the profile directory, and three separate
// facts stand between that file and a list of rows. All three were measured on
// this machine against a real 21 MB Brave profile rather than reasoned about,
// because each of them fails in a way that looks like something else.
//
// ── 1. THE LIVE FILE CANNOT BE OPENED, EVEN READ-ONLY ───────────────────────
//
// Chrome holds an exclusive lock for as long as it is running. A read-only open
// of the real path answers `SQLITE_BUSY: database is locked` — not "empty", not
// "no such table", a hard error on the very first statement. So the file is
// COPIED and the copy is read. 21 MB copies in 168 ms and 20 of 20 copies came
// back readable; that is the whole cost of the poll.
//
// The copy is not the tidy kind either. `journal_mode` on this file is `delete`,
// NOT WAL — there is no `-wal`/`-shm` sidecar to copy alongside it, which is the
// usual Chromium advice and is wrong here. What does sit beside it during a
// write is a `History-journal` file holding the UNDO image, so a copy taken
// mid-transaction can contain writes Chrome was about to roll back, and a copy
// taken at exactly the wrong moment can be a torn page — `SQLITE_NOTADB: file is
// not a database`, reproduced here by handing the reader 4 KB of /dev/urandom.
// A few extra rows are harmless for a feature that lists navigations. A throw is
// not: this runs on a poll inside the deck's own process, so an uncaught one
// takes the whole deck down over a browser that happened to be busy. Nothing
// below throws; a failure comes back as `degraded` with a reason.
//
// ── 2. `visit_time` DOES NOT FIT IN A JAVASCRIPT NUMBER ─────────────────────
//
// Chrome counts MICROSECONDS since 1601-01-01 UTC, so today's values are around
// 1.34e16 — past 2^53. `node:sqlite` refuses to guess and throws rather than
// hand back a rounded integer:
//
//   RangeError: The value of column 0 is too large to be represented as a
//   JavaScript number: 13432716408648765   (code: ERR_OUT_OF_RANGE)
//
// That is a throw from `.all()`, i.e. the whole query fails, not one row. So
// every 64-bit column in the SELECT is read as `CAST(… AS TEXT)` and stays a
// STRING until `chromeTimeToMs` converts it through BigInt. `transition` is cast
// too even though its values are 32-bit today, because the failure is per-STATEMENT
// rather than per-column: one out-of-range column loses every row of the query,
// so there is no version of this worth leaving to chance for one saved cast.
//
// ── 3. THERE MAY BE NO SQLITE READER AT ALL ─────────────────────────────────
//
// `node:sqlite` exists only from Node 22.5, and this package declares
// `engines: { node: ">=18" }` — CI runs Node 22 on all three OSes and
// Node 18 on one Linux leg, which is the version the package advertises. A top-level
// `import "node:sqlite"` is therefore not an option: it throws
// ERR_UNKNOWN_BUILTIN_MODULE at module load, before any of this file's own error
// handling exists, and takes the server's import graph with it. It is loaded
// through a dynamic import inside a try/catch, once.
//
// The fallback is the `sqlite3` CLI, which ships with macOS (/usr/bin/sqlite3,
// 3.51.0 here) and is usually present on Linux — and is ABSENT ON WINDOWS, where
// Microsoft ships no sqlite3.exe. So the third answer is real and has to be a
// first-class one: `{ kind: "none" }`, `degraded: true`, no rows, and the caller
// falls back to the file's mtime — "something navigated at 09:06, no URL" is a
// weaker signal than a list of URLs and it is a great deal better than a blank
// panel and a crash.
import { copyFile, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
const { COPYFILE_EXCL } = fsConstants;
import { pathLookup, run } from "./exec.mjs";

/**
 * 1601-01-01 → 1970-01-01, in microseconds.
 *
 * A BigInt because that is the unit the arithmetic has to happen in: the whole
 * point of the conversion is that the operands do not fit in a double, so doing
 * it as `Number(t) / 1000 - 11644473600000` rounds the input before it is ever
 * used. The error is under a microsecond and it is still the wrong shape — it
 * produces a FRACTIONAL millisecond (1788242808648.7637 for the newest row on
 * this machine), which then feeds a Date, a diff and a watermark.
 */
const EPOCH_DELTA_US = 11644473600000000n;
const US_PER_MS = 1000n;

/**
 * Chrome time (microseconds since 1601, as a STRING) → JS epoch milliseconds.
 *
 * The argument is a string because every caller gets it out of a `CAST(… AS
 * TEXT)` column; a Number is accepted too, and is exactly the lossy input this
 * function exists to avoid, so it is converted through its decimal spelling.
 *
 * Division truncates toward zero, which is floor for every value this can be
 * handed — Chrome cannot record a visit before 1601. It is stated because a
 * machine whose clock sat before 1970 would produce a negative microsecond count
 * and truncation would round it toward the future by up to 1 ms, which is a
 * rounding artefact rather than a bug worth branching for.
 *
 * A value that is not a run of digits answers NaN rather than throwing.
 * `BigInt("")` and `BigInt("abc")` both throw SyntaxError, and this is called
 * once per row inside a poll: one unreadable row must cost that row, not the
 * request. readVisitsSince drops rows whose time is not finite.
 */
export function chromeTimeToMs(t) {
  const digits = String(t ?? "").trim();
  if (!/^-?\d+$/.test(digits)) return NaN;
  return Number((BigInt(digits) - EPOCH_DELTA_US) / US_PER_MS);
}

/**
 * JS epoch milliseconds → Chrome time, as a STRING.
 *
 * A string because the result does not fit in a Number — today's values are
 * 1.34e16 — so returning one would corrupt the watermark it exists to produce.
 * That is the caller this function is for: a first poll has no watermark and
 * seeds one from the wall clock, which is what keeps the first read to "since
 * the deck started" instead of the user's entire browsing history.
 *
 * A non-finite input answers "0", the same floor a first call with no watermark
 * gets. Zero means 1601, so nothing is skipped: an unusable input costs a wide
 * read, never a silently missed navigation.
 */
export function msToChromeTime(ms) {
  const whole = Math.trunc(Number(ms));
  if (!Number.isFinite(whole)) return "0";
  return String(BigInt(whole) * US_PER_MS + EPOCH_DELTA_US);
}

/**
 * The SELECT, in one place, for both backends.
 *
 * `floor` is the `>` operand: `"?"` for the node:sqlite path, which binds it as
 * a BigInt, and a validated run of digits for the CLI path, which has no way to
 * bind a parameter at all. Everything else about the statement is byte-identical
 * between the two — one query to read, one query to get the casts right.
 *
 * Verified against the real profile: 4,893 rows in 15 ms with node:sqlite.
 */
const visitsSql = (floor) =>
  "SELECT u.url AS url, CAST(v.visit_time AS TEXT) t, CAST(v.transition AS TEXT) tr" +
  " FROM visits v JOIN urls u ON u.id = v.url" +
  ` WHERE v.visit_time > ${floor}` +
  " ORDER BY v.visit_time";

/**
 * The floor as a run of digits, or "0".
 *
 * Two jobs, and the second is the one that matters. It normalises "no watermark
 * yet" — undefined, null, "" — to the 1601 floor. And it is the ONLY thing
 * standing between a stored watermark and the CLI's command line, where the
 * value is pasted into SQL text because sqlite3(1) offers no parameter binding.
 * The watermark is the deck's own output round-tripped through the caller's
 * state, not user input in the web sense; it is validated anyway, because
 * "nobody can reach that value" is a claim about code that is not in this file.
 */
function chromeFloor(since) {
  const digits = String(since ?? "").trim();
  return /^\d+$/.test(digits) ? digits : "0";
}

/** Compare two digit strings by value, without BigInt. Runs once per row. */
function cmpDigits(a, b) {
  const x = a.replace(/^0+(?=\d)/, "");
  const y = b.replace(/^0+(?=\d)/, "");
  if (x.length !== y.length) return x.length - y.length;
  return x < y ? -1 : x > y ? 1 : 0;
}

/** The one line of an error worth putting in a `reason`. */
function why(err) {
  const text = String(err?.message ?? err ?? "unknown");
  return text.split("\n")[0].slice(0, 200);
}

/** Cached answer of the real probe. A promise, so two concurrent first calls
 *  share one dynamic import and one PATH walk rather than racing to do both. */
let memo = null;

/**
 * `node:sqlite`, loaded through Node's own resolver rather than the bundler's.
 *
 * `await import("node:sqlite")` is the obvious spelling and it is the wrong one
 * here. Vite's builtin list predates the module, so under the test runner it
 * strips the `node:` prefix and looks for a package called `sqlite` instead:
 * "Failed to load url sqlite (resolved id: sqlite)". vitest 2 carries that bug
 * (vitest-dev/vitest#7177, fixed upstream in #7179 and not in the 2.x pinned
 * here), and its cost was not a failing test. `sqliteBackend()` simply resolved
 * to the CLI arm in every case, so the branch most users actually run was the
 * one branch no test could reach — and the suite was green about it.
 *
 * `createRequire` goes straight to Node, which knows the module on any runtime
 * that has it, and behaves identically in production, where no bundler is
 * involved at all. Still inside the caller's try/catch: a Node without the
 * module throws here exactly as the dynamic import did.
 */
const requireNode = createRequire(import.meta.url);

/**
 * Node prints `ExperimentalWarning: SQLite is an experimental feature` to
 * stderr the first time the module is loaded, and that stderr is the terminal
 * the user started the deck in. It is a warning about a decision they did not
 * make, about a module they cannot choose, at a moment they were looking at a
 * browser tab — and there is nothing they can do with it.
 *
 * Only this one warning, and only by swapping the default listener for one that
 * forwards everything else untouched: a blanket NODE_NO_WARNINGS would also
 * swallow a deprecation the deck genuinely needs to hear about. Installed lazily
 * on the first load rather than at import, so a deck whose panel is never opened
 * never touches the process's listeners at all.
 */
let quieted = false;
function quietSqliteWarning() {
  if (quieted) return;
  quieted = true;
  const existing = process.listeners("warning");
  process.removeAllListeners("warning");
  process.on("warning", warning => {
    if (warning?.name === "ExperimentalWarning" && /\bSQLite\b/.test(warning.message ?? "")) return;
    for (const listener of existing) listener(warning);
  });
}

const loadSqlite = async () => {
  quietSqliteWarning();
  return requireNode("node:sqlite");
};

/**
 * Which SQLite reader this machine has, resolved once and cached.
 *
 * `{ kind: "node-sqlite" }` | `{ kind: "sqlite3-cli", bin }` | `{ kind: "none" }`
 *
 * ORDER IS DELIBERATE. node:sqlite is in-process — no spawn, no command line, no
 * output to parse, and parameter binding — so it wins wherever it exists. The
 * CLI is the fallback rather than the default because every call to it costs a
 * process, and this runs on a poll.
 *
 * The dynamic import is inside a try/catch and covers more than "Node 18 has no
 * such module". Between 22.5 and 22.12 node:sqlite existed but required
 * `--experimental-sqlite`, which the deck is not started with, and the import
 * fails there too — the same catch, the same fallback, no version arithmetic
 * anywhere in this file. `DatabaseSync` is checked for by name because that is
 * what the read path actually calls; a future module that exists under this
 * specifier without it would otherwise be selected and then throw per poll.
 *
 * The CLI is found with the repo's own `pathLookup` rather than by spawning
 * `sqlite3` and seeing what happens, for the reason exec.mjs was written: on
 * Windows the thing on PATH is `sqlite3.exe`, spawn is not a shell and applies
 * no PATHEXT, so a bare-name probe answers ENOENT on the one platform where the
 * answer decides whether the feature exists at all.
 *
 * `deps` is for tests and is NEVER memoised — a probe with an injected PATH must
 * not become this process's permanent answer, and the real answer must not be
 * whatever a test asked for first. Passing nothing takes the cache; passing even
 * `{}` re-probes.
 */
export async function sqliteBackend(deps) {
  if (deps) return probeBackend(deps);
  memo ??= probeBackend({});
  return memo;
}

async function probeBackend({
  importSqlite = loadSqlite,
  lookup = pathLookup,
  platform = process.platform,
  env = process.env,
} = {}) {
  try {
    const mod = await importSqlite();
    if (typeof mod?.DatabaseSync === "function") return { kind: "node-sqlite" };
  } catch {
    // Node < 22.5, or 22.5–22.12 without --experimental-sqlite. Both are "no
    // in-process reader", which is a state and not an error.
  }
  const bin = lookup("sqlite3", platform, { pathEnv: env.PATH ?? env.Path ?? "" });
  if (bin) return { kind: "sqlite3-cli", bin };
  return { kind: "none" };
}

/** Distinguishes this deck's copies from a sibling deck's in a shared copyDir.
 *  pid alone is not enough — one deck polls repeatedly and must not read a copy
 *  it is still writing. */
let copySeq = 0;

/**
 * Every navigation newer than `sinceChromeTime`.
 *
 * `{ rows, watermark, degraded, reason }`
 *   rows       [{ url, timeMs, transition }], oldest first
 *   watermark  the newest chrome time seen, as a string, or the input unchanged
 *              when there was nothing to see — store it and hand it back next
 *              poll
 *   degraded   true when no rows could be read for a reason that is not "no new
 *              navigations": no SQLite reader on this machine, no readable copy,
 *              a torn image. The caller falls back to the file's mtime in all of
 *              them, which is why they share one flag rather than one each — the
 *              distinction that matters to a caller is "is this list complete",
 *              and `reason` carries the rest for the log.
 *   reason     null on success, otherwise a stable slug and a detail:
 *              "no-sqlite-reader: …" | "copy-failed: …" | "unreadable-copy: …"
 *
 * `opts.copyDir` is where the copy of the locked file goes; `opts.backend` skips
 * the probe when the caller already resolved it; `opts.deps` injects the
 * filesystem, the runner and the import for tests.
 *
 * NEVER THROWS. Not "rarely" — this is called from a poll in the deck's own
 * process and the inputs are a file another program owns, so the failure modes
 * are ordinary rather than exceptional.
 */
export async function readVisitsSince(historyPath, sinceChromeTime, opts = {}) {
  const { copyDir = join(tmpdir(), "ccdeck-browser-watch"), backend } = opts;
  const deps = opts.deps ?? {};
  const {
    copyFile: copy = copyFile,
    mkdir: makeDir = mkdir,
    rm: remove = rm,
    run: exec = run,
    importSqlite = loadSqlite,
  } = deps;

  const floor = chromeFloor(sinceChromeTime);
  // What comes back when there is nothing to advance to. The input verbatim
  // where it was usable, so a caller that stores it sees no change at all; the
  // normalised floor where it was not, so the answer is always a string a later
  // call can be handed.
  const unchanged = floor === String(sinceChromeTime ?? "").trim() ? String(sinceChromeTime) : floor;

  const chosen = backend ?? await sqliteBackend(opts.deps);
  if (!chosen || chosen.kind === "none") {
    return {
      rows: [],
      watermark: unchanged,
      degraded: true,
      reason: "no-sqlite-reader: node:sqlite needs Node 22.5+ and no sqlite3 was found on PATH",
    };
  }

  let copyPath = null;
  try {
    // MODE 0700, AND A NAME NOBODY ELSE CAN PREDICT.
    //
    // `os.tmpdir()` is per-user on macOS (/var/folders/…, 0700) and on Windows,
    // and on Linux it is the shared, world-writable /tmp. A fixed directory
    // name and `history-<pid>-<n>.sqlite` inside it meant three things there,
    // all of them avoidable:
    //
    //   * a complete, unencrypted copy of the user's browsing history, mode
    //     0644, under a predictable path, readable by every other account on
    //     the machine for the life of the poll;
    //   * another UID can create the directory first — `mkdir` with `recursive`
    //     swallows EEXIST and keeps THEIR mode — and then read every copy, or
    //     plant a symlink at the name and have this overwrite a file the user
    //     owns, because `copyFile` was called without COPYFILE_EXCL;
    //   * a second user on the same box then fails EACCES on a directory they
    //     cannot write, and their deck is degraded for good.
    //
    // The mode is set on creation AND after, because the directory may already
    // exist from an earlier run of this same deck.
    await makeDir(copyDir, { recursive: true, mode: 0o700 });
    copyPath = join(copyDir, `history-${process.pid}-${++copySeq}-${randomUUID().slice(0, 8)}.sqlite`);
    // COPYFILE_EXCL: refuse rather than write through a symlink or over a file
    // that is already there. A refusal is one degraded poll; the alternative is
    // clobbering whatever the name pointed at.
    await copy(historyPath, copyPath, COPYFILE_EXCL);
  } catch (err) {
    // The browser is not installed, the profile moved, the disk is full. All of
    // them are "no rows this poll", none of them is a reason to stop polling.
    await discard(remove, copyPath);
    return { rows: [], watermark: unchanged, degraded: true, reason: `copy-failed: ${why(err)}` };
  }

  let raw;
  try {
    raw = chosen.kind === "node-sqlite"
      ? await readViaNode(copyPath, floor, importSqlite)
      : await readViaCli(copyPath, floor, chosen.bin, exec);
  } catch (err) {
    return { rows: [], watermark: unchanged, degraded: true, reason: `unreadable-copy: ${why(err)}` };
  } finally {
    // A 21 MB file per poll. Left behind, this fills the user's temp directory
    // at the rate the deck polls — and the copy is a full, unencrypted list of
    // everywhere they have been, which is not a thing to leave lying around
    // under a predictable name.
    await discard(remove, copyPath);
  }

  const rows = [];
  let top = floor;
  for (const row of raw) {
    const timeMs = chromeTimeToMs(row?.t);
    // A row with no URL or an unreadable time is dropped rather than repaired.
    // It cannot be drawn and it must not become the watermark, because a
    // watermark taken from a value this could not read would skip every real
    // row behind it, permanently.
    if (!row?.url || !Number.isFinite(timeMs)) continue;
    const transition = Number(row.tr);
    rows.push({ url: String(row.url), timeMs, transition: Number.isFinite(transition) ? transition : 0 });
    const t = String(row.t).trim();
    if (cmpDigits(t, top) > 0) top = t;
  }

  // `top` rather than the last row's time. The ORDER BY makes those the same
  // today, and the watermark is the one value whose being wrong loses rows
  // forever rather than for one poll — so it is computed from what was read
  // instead of from an assumption about how it was sorted.
  return { rows, watermark: rows.length ? top : unchanged, degraded: false, reason: null };
}

/**
 * Delete the copy, and never let the deletion be the thing that fails.
 *
 * `maxRetries` is Node's own answer to a Windows file whose last handle is still
 * closing — see __tests__/rm-temp-dir.ts, which paid for that knowledge twice.
 * The catch is on top of it because a leftover 21 MB file in a temp directory is
 * not worth a failed poll.
 */
async function discard(remove, path) {
  if (!path) return;
  try {
    await remove(path, { force: true, maxRetries: 5, retryDelay: 20 });
  } catch {
    // The OS still has it. It is in a temp directory and it is one file.
  }
}

/**
 * The in-process read.
 *
 * `readOnly` is passed even though the target is a copy this module owns: it
 * stops SQLite creating a `-journal` beside it and makes an attempt to write a
 * bug rather than a silent edit of the snapshot. Older node:sqlite builds that
 * predate the option ignore it, which on a private copy is harmless — the
 * fallback that would otherwise be needed here would have to tell an unknown
 * option apart from "file is not a database", and guessing at that is worse than
 * opening a scratch file read-write.
 *
 * The floor is BOUND, as a BigInt, because it does not fit in a Number either.
 * Binding it as a string would work by SQLite's column affinity rules rather
 * than by intent — the comparison would go through an implicit TEXT→INTEGER
 * conversion that the schema happens to ask for — and that is a thing to rely on
 * only when there is no alternative. Here there is one.
 */
async function readViaNode(file, floor, importSqlite) {
  const { DatabaseSync } = await importSqlite();
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(visitsSql("?")).all(BigInt(floor));
  } finally {
    try { db.close(); } catch { /* already closed, or never opened cleanly */ }
  }
}

// sqlite3 -ascii separators: 0x1F between columns, 0x1E after every row
// including the last. Chosen over `-json` because `-json` needs sqlite3 3.33
// (2020) and Ubuntu 20.04 still ships 3.31, while `-ascii` has been there since
// 3.8 — and over the default `|` because a URL may legally contain a pipe,
// where 0x1F and 0x1E cannot appear in one at all. Confirmed against the real
// profile: 0 of 172,000 URLs contain either separator or a newline.
const UNIT = "\u001f";
const RECORD = "\u001e";

/**
 * The out-of-process read.
 *
 * Through the repo's `run` rather than `execFile` directly, for what exec.mjs
 * exists to do: candidate spelling on Windows, a deadline that reports before it
 * kills, and a contract that answers `{ ok: false }` instead of rejecting.
 *
 * `maxBuffer` is raised well past run's 4 MB default. The steady-state poll
 * returns kilobytes, but a caller that seeds its watermark at 0 asks for the
 * entire history in one statement — 170k rows here — and the failure mode of the
 * default is ENOBUFS, which arrives looking like a broken database rather than
 * like a large one.
 */
async function readViaCli(file, floor, bin, exec) {
  const res = await exec(bin, ["-readonly", "-ascii", file, visitsSql(floor)], {
    timeout: 15_000,
    maxBuffer: 64 << 20,
  });
  if (!res?.ok) {
    // sqlite3 puts "file is not a database" on stderr and exits 26. Reported,
    // never rethrown as-is, so the reason names the tool that said it.
    const said = why(res?.stderr || res?.stdout || "");
    throw new Error(`sqlite3 exited ${res?.code ?? "?"}${said ? `: ${said}` : ""}`);
  }
  const out = [];
  for (const record of String(res.stdout ?? "").split(RECORD)) {
    if (!record) continue;
    const [url, t, tr] = record.split(UNIT);
    out.push({ url, t, tr });
  }
  return out;
}
