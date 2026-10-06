// The deck's memory of which agent made which commit: one JSON line per commit
// it saw an agent make, in `agent-commits.jsonl` in the deck's data directory.
//
// WHY A FILE OF ITS OWN. The events log rotates at 50 MB and a Clear empties
// it, and a session's events leave the replay window within hours on a busy
// machine — so a mark derived from the log alone would vanish on the next
// restart. This file is what keeps "made by this agent" true for as long as
// the commit exists. It lives with the deck's data (prefs.json's directory),
// not its log, because nothing can rebuild it: it is data a person would miss,
// in deck-home.mjs's terms.
//
// LOCAL ONLY. Nothing sends it anywhere — not the usage reports, not the error
// reports — and a test walks the reports' imports to keep it that way.
//
// THE LINE (version 1):
//
//   { v: 1, repo, top, sha, shaFull, subject, authorTime, branch, detached,
//     sessionId, agentId, label, agentType, model, kind, at, cwd, cost,
//     durationMs, durationFrom, confidence, amend, subcommand, source? }
//
// `source: "replay"` marks a line recorded after the fact, from a commit found
// in the events log the deck replayed at boot rather than as it was made; a
// line recorded live carries no `source`.
//
// `repo` is the realpath of the repository's common git directory, which is
// what every worktree of one repository shares; `sha` is the full SHA when the
// commit was confirmed against the repo (`shaFull: true`), else the short one
// git printed. See agent-git-record.mjs `buildCommitRecord` for
// every field.
//
// HOW IT IS KEPT HONEST:
//   - appends are one write(2) of one whole line on an O_APPEND descriptor, so
//     two decks appending at once cannot interleave inside a line;
//   - a reader skips a line it cannot parse or that lacks a required field,
//     counts it, and carries on; a torn last line (a kill mid-write) is never
//     glued to the next record — the next append starts on a fresh line;
//   - one commit is held once: the same SHA in the same repo is a duplicate,
//     a short SHA that is the prefix of a held one is a duplicate, and a full
//     SHA replaces the short one it extends;
//   - the file is bounded: past `maxBytes` it is rewritten (atomically, from a
//     fresh read of the file, so a line another deck appended is not lost to a
//     stale picture) with duplicates and junk removed and the oldest commits
//     dropped until it is three quarters of the cap. The window that remains —
//     another deck appending between that read and the rename — is a few
//     milliseconds, once per many thousand commits.
//
// TWO DECKS, ONE FILE. Two decks on one machine share the data directory (the
// desktop app and a deck started in a terminal), and only the one writing the
// events log records live commits. So every read first takes in what the file
// gained since the last one: the whole lines past what was read, or the whole
// file again when it was rewritten (another deck compacted it) — told by the
// file's identity and size, one stat a read.
//
// A DECK WITH NO LOG (`--no-persist`) records what it sees in memory only:
// those lines are held beside the file's and never written.
import { mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "./atomic-write.mjs";
import { deckDataDir } from "./deck-home.mjs";

export const COMMIT_STORE_FILE = "agent-commits.jsonl";

/** 16 MiB: at roughly 600 bytes a line, some 28,000 commits before the oldest
 *  are dropped — years of a busy person's agent commits. */
export const COMMIT_STORE_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Where the store lives: `<deck data dir>/agent-commits.jsonl`. The data
 * directory honours CCDECK_HOME, CLAUDE_CONFIG_DIR and XDG_DATA_HOME exactly as
 * prefs.json's does (deck-home.mjs).
 *
 * @param {string} [dir] the data directory, when already known
 * @param {{ platform?: string, env?: Record<string, string | undefined>, home?: string }} [where]
 */
export function commitStorePath(dir, { platform, env, home } = {}) {
  return join(dir ?? deckDataDir(platform, env, home), COMMIT_STORE_FILE);
}

const SHA = /^[0-9a-f]{7,64}$/;
const KINDS = new Set(["claude", "codex"]);

/** Does this parsed line carry what every reader relies on? Unknown fields —
 *  a newer deck's — are kept as they are. */
export function isCommitRecord(r) {
  return !!r && typeof r === "object" && !Array.isArray(r)
    && typeof r.v === "number" && r.v >= 1
    && typeof r.repo === "string" && r.repo !== ""
    && typeof r.sha === "string" && SHA.test(r.sha)
    && typeof r.sessionId === "string" && r.sessionId !== ""
    && (r.agentId === null || r.agentId === undefined || typeof r.agentId === "string")
    && KINDS.has(r.kind)
    && typeof r.at === "number" && Number.isFinite(r.at)
    && (r.subject === undefined || r.subject === null || typeof r.subject === "string");
}

/** The held records, de-duplicated, with an index that makes the SHA-prefix
 *  checks cheap: records are bucketed by repo and the SHA's first 7 hex. */
function createIndex() {
  const byKey = new Map(); // `${repo}\0${sha}` -> record, in admission order
  const buckets = new Map(); // `${repo}\0${sha.slice(0, 7)}` -> Set<key>
  const bucketOf = r => `${r.repo}\0${r.sha.slice(0, 7)}`;

  /** What admitting `r` would do: refuse it as a duplicate, add it, or add it
   *  in place of a shorter SHA it extends. */
  function plan(r) {
    const key = `${r.repo}\0${r.sha}`;
    if (byKey.has(key)) return { dup: true, existing: byKey.get(key) };
    for (const k of buckets.get(bucketOf(r)) ?? []) {
      const held = byKey.get(k);
      if (held.sha.startsWith(r.sha)) return { dup: true, existing: held };
      if (r.sha.startsWith(held.sha)) return { dup: false, key, replaces: k };
    }
    return { dup: false, key, replaces: null };
  }

  function apply(r, p) {
    if (p.replaces) {
      byKey.delete(p.replaces);
      buckets.get(bucketOf(r))?.delete(p.replaces);
    }
    byKey.set(p.key, r);
    const b = bucketOf(r);
    if (!buckets.has(b)) buckets.set(b, new Set());
    buckets.get(b).add(p.key);
  }

  return {
    plan,
    apply,
    admit(r) { const p = plan(r); if (!p.dup) apply(r, p); return !p.dup; },
    values() { return [...byKey.values()]; },
    get size() { return byKey.size; },
  };
}

/** Admit every whole line of `text` into `index`; answers how many it could
 *  not read. */
function admitLines(index, text) {
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { skipped++; continue; }
    if (!isCommitRecord(r)) { skipped++; continue; }
    index.admit(r);
  }
  return skipped;
}

/** A whole file's text, read tolerantly. */
function parseText(text) {
  const index = createIndex();
  const parts = text.split("\n");
  // The text after the last newline is a torn line when it is not empty.
  const tail = parts.pop();
  const needsNewline = tail !== "";
  const skipped = admitLines(index, parts.join("\n")) + (needsNewline ? 1 : 0);
  return { index, skipped, needsNewline, bytes: Buffer.byteLength(text) };
}

/** Where the whole lines of `buf` end: just past its last newline, or 0. */
const wholeLinesEnd = (buf) => buf.lastIndexOf(10) + 1;

/** The most lines a deck with no log keeps in memory; the oldest go first. */
const MEMORY_MAX = 5000;

/** One whole line onto the end of the file, in one write(2) on an O_APPEND
 *  descriptor (log-writer.mjs explains what each platform promises for that),
 *  created private to the user. */
async function appendWhole(path, line) {
  const buf = Buffer.from(line, "utf8");
  const fh = await open(path, "a", 0o600);
  try {
    let off = 0;
    while (off < buf.length) {
      const { bytesWritten } = await fh.write(buf, off, buf.length - off);
      if (bytesWritten <= 0) throw new Error("short write");
      off += bytesWritten;
    }
  } finally {
    await fh.close();
  }
}

const byAt = (a, b) => a.at - b.at;

/**
 * @param {{ path: string, maxBytes?: number }} opts
 */
export function createCommitStore({ path, maxBytes = COMMIT_STORE_MAX_BYTES }) {
  let index = createIndex();
  let bytes = 0;
  let needsNewline = false;
  let skipped = 0;
  let compactions = 0;
  // What has been read of the file: which file (a rewrite is another one) and
  // how far, in whole lines. `file` null: read it all next time.
  let file = null;
  let offset = 0;
  // The lines a deck with no log keeps (`memoryOnly`), held through a reread.
  let memory = [];
  let chain = Promise.resolve();

  /** Run `fn` after everything queued before it, and never break the queue. */
  function enqueue(fn) {
    const next = chain.then(fn, fn);
    chain = next.then(() => {}, () => {});
    return next;
  }

  async function readText() {
    let fh;
    try {
      fh = await open(path, "r");
      return await fh.readFile("utf8");
    } catch {
      return null;
    } finally {
      await fh?.close().catch(() => {});
    }
  }

  /**
   * Take in what the file gained since the last read: the whole lines past
   * `offset` when it is the same file and has grown, all of it when it is
   * another file (rewritten) or shorter. A line still being written by
   * another deck is left for the next read.
   */
  async function refresh() {
    let fh;
    try {
      fh = await open(path, "r");
    } catch {
      // No file (yet, or any more): what is held is what this deck kept.
      if (file !== null || offset > 0) reset(createIndex(), 0, 0, false, 0);
      return;
    }
    let whole = false;
    try {
      const st = await fh.stat({ bigint: true });
      const size = Number(st.size);
      const same = file !== null && file.ino === st.ino && file.dev === st.dev && size >= offset;
      if (!same) {
        const buf = await fh.readFile();
        const parsed = parseText(buf.toString("utf8"));
        reset(parsed.index, wholeLinesEnd(buf), parsed.bytes, parsed.needsNewline, parsed.skipped);
        file = { ino: st.ino, dev: st.dev };
        whole = true;
        return;
      }
      if (size > offset) {
        const buf = Buffer.alloc(size - offset);
        const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
        const got = buf.subarray(0, bytesRead);
        const end = wholeLinesEnd(got);
        skipped += admitLines(index, got.subarray(0, end).toString("utf8"));
        offset += end;
      }
      bytes = size;
      needsNewline = size > offset;
    } catch {
      /* unreadable now: what is held stands, and the next read tries again */
    } finally {
      await fh.close().catch(() => {});
      // Rewritten only once this read's handle is closed.
      if (whole && bytes > maxBytes) await compact();
    }
  }

  function reset(next, readTo, size, torn, junk) {
    index = next;
    for (const r of memory) index.admit(r);
    offset = readTo;
    bytes = size;
    needsNewline = torn;
    skipped = junk;
    file = null;
  }

  /** Rewrite the file from a fresh read: duplicates and junk out, the oldest
   *  commits dropped until it is three quarters of the cap. */
  async function compact() {
    const text = await readText();
    if (text === null) return;
    const parsed = parseText(text);
    const records = parsed.index.values().sort(byAt);
    const lines = records.map(r => JSON.stringify(r) + "\n");
    const target = Math.floor(maxBytes * 0.75);
    let total = lines.reduce((n, l) => n + Buffer.byteLength(l), 0);
    let drop = 0;
    while (total > target && drop < records.length - 1) total -= Buffer.byteLength(lines[drop++]);
    const kept = records.slice(drop);
    try {
      await writeFileAtomic(path, lines.slice(drop).join(""));
    } catch {
      return; // the file stays as it was; the next append tries again
    }
    const next = createIndex();
    for (const r of kept) next.admit(r);
    // Another file now: the next read takes it in whole, with anything
    // appended to it in the meantime.
    reset(next, 0, total, false, skipped);
    compactions++;
  }

  return {
    path,

    /**
     * Add one commit. Answers `{ added: true, record }`, or `{ added: false }`
     * for a duplicate, a malformed record, or a write that failed.
     * `memoryOnly`: held by this store alone and never written — a deck with
     * no events log.
     *
     * @param {object} record a version-1 line (see the header)
     * @param {{ memoryOnly?: boolean }} [opts]
     */
    append(record, { memoryOnly = false } = {}) {
      if (!isCommitRecord(record)) return Promise.resolve({ added: false, record: null });
      return enqueue(async () => {
        await refresh();
        const p = index.plan(record);
        if (p.dup) return { added: false, record: p.existing };
        if (memoryOnly) {
          index.apply(record, p);
          memory.push(record);
          if (memory.length > MEMORY_MAX) memory = memory.slice(-MEMORY_MAX);
          return { added: true, record };
        }
        const line = (needsNewline ? "\n" : "") + JSON.stringify(record) + "\n";
        try {
          await mkdir(dirname(path), { recursive: true, mode: 0o700 });
          await appendWhole(path, line);
        } catch {
          return { added: false, record: null };
        }
        index.apply(record, p);
        needsNewline = false;
        bytes += Buffer.byteLength(line);
        if (bytes > maxBytes) await compact();
        return { added: true, record };
      });
    },

    /** Whether a commit of `repo` with this SHA — or one either SHA is the
     *  start of — is held. */
    holds(repo, sha) {
      return enqueue(async () => {
        await refresh();
        const p = index.plan({ repo, sha });
        return p.dup || p.replaces !== null;
      });
    },

    /** Every held commit, oldest first. */
    all() {
      return enqueue(async () => { await refresh(); return index.values().sort(byAt); });
    },

    /** The commits of one repository (by its common git directory), oldest first. */
    forRepo(repo) {
      return enqueue(async () => { await refresh(); return index.values().filter(r => r.repo === repo).sort(byAt); });
    },

    /** The newest commit a session made — no later than `before` (ms), when
     *  given — or null. */
    lastForSession(sessionId, before = Infinity) {
      return enqueue(async () => {
        await refresh();
        let last = null;
        for (const r of index.values()) if (r.sessionId === sessionId && r.at <= before && (!last || r.at >= last.at)) last = r;
        return last;
      });
    },

    /** What the reader has seen: records held, lines skipped, rewrites done. */
    stats() {
      return { records: index.size, skipped, compactions, bytes };
    },
  };
}
