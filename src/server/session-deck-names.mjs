// The names a reader gives sessions in the deck (internal #101).
//
// A NAME OF THE DECK'S OWN, NOT THE PROVIDER'S. Claude Code has `/rename` and
// writes a `custom-title` record into its transcript; Codex has nothing of the
// kind. Writing either provider's files would put the deck in the middle of a
// conversation it only watches, so a name typed in the deck is kept here, in
// session-names.json beside prefs.json, and never leaves this machine. The
// provider's own name (/rename, Claude's made-up slug, the ai-title) is left
// alone: it is what the session reads by again once the reader clears theirs.
//
// KEYED BY PROVIDER AND SESSION ID, never by folder or by place in a list:
// two sessions in one folder are two names, and a session keeps its name when
// the list reorders, the deck restarts or the session is reopened.
//
// HOW IT REACHES A PAGE. As the provider's name does, on a `SessionNamed`
// event, with one more field: `deckName`, the name, or null for "cleared". An
// absent `deckName` says nothing, so a transcript's own naming, which keeps
// arriving while the session runs, never overwrites a name typed here. The
// write is announced at once (session-name-route.mjs) and logged, so a reload
// and a restart replay it; a session heard from again after a restart is told
// once more (session-enrichment.mjs, maybeAnnounceDeckName), for the log a
// rotation took it out of.
import { readFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { deckDataDir } from "./deck-home.mjs";
import { writeFileAtomic } from "./atomic-write.mjs";

/** The longest name kept, in characters (code points). The field holds the
 *  same, so a name is never cut where the reader cannot see it. */
export const DECK_NAME_MAX = 120;
/** The most names kept. Past it the oldest goes: a name for a session nobody
 *  has seen in months is the one nobody misses. */
export const DECK_NAMES_CAP = 1000;

const PROVIDERS = new Set(["claude", "codex"]);
// A Claude session id is a UUID, a Codex thread id one too; the deck's own
// ids for a launch are letters, digits and dashes. Nothing here is a path.
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// What a name may not hold: control characters (a newline would break the
// row it is drawn on), the zero-width and direction marks that make two names
// look the same, and the byte-order mark.
const UNSEEN = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;

export function deckNamesPath(home = deckDataDir()) {
  return join(home, "session-names.json");
}

/** Where a session's name is kept, or null for a provider or id the deck does
 *  not name. A missing provider is Claude's, as the reducer reads one. */
export function deckNameKey(provider, sessionId) {
  const p = provider ?? "claude";
  if (!PROVIDERS.has(p) || typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return null;
  return `${p}:${sessionId}`;
}

/**
 * A name as it is kept: one line, its spaces collapsed, at most DECK_NAME_MAX
 * characters. Null for one that is empty after that, or for null itself: the
 * name cleared. Undefined for anything that is not a name at all.
 */
export function cleanDeckName(raw) {
  if (raw === null) return null;
  if (typeof raw !== "string") return undefined;
  const one = raw.replace(UNSEEN, " ").replace(/\s+/g, " ").trim();
  if (!one) return null;
  return [...one].slice(0, DECK_NAME_MAX).join("").trim();
}

/** Whatever is on disk, as a map of key to { name, at }. A file this version
 *  cannot read is no names, not an error: the deck still runs. */
export function normaliseDeckNames(raw) {
  const out = new Map();
  const names = raw && typeof raw === "object" && raw.names && typeof raw.names === "object" ? raw.names : {};
  for (const [key, entry] of Object.entries(names)) {
    const cut = key.indexOf(":");
    if (cut < 0 || deckNameKey(key.slice(0, cut), key.slice(cut + 1)) !== key) continue;
    const name = cleanDeckName(entry && typeof entry === "object" ? entry.name : undefined);
    if (typeof name !== "string") continue;
    out.set(key, { name, at: Number.isFinite(entry.at) ? entry.at : 0 });
  }
  return capDeckNames(out);
}

/** The newest DECK_NAMES_CAP of them. */
export function capDeckNames(names) {
  if (names.size <= DECK_NAMES_CAP) return names;
  const kept = [...names].sort((a, b) => b[1].at - a[1].at).slice(0, DECK_NAMES_CAP);
  return new Map(kept);
}

// The names as last read or written. This process is the file's only writer,
// so after the boot read every question is answered from memory.
let _held = null;
let _path = null;

/** Read the file once, as the deck starts. Later calls answer what is held. */
export async function loadDeckNames(path = deckNamesPath()) {
  if (_held && _path === path) return _held;
  _path = path;
  try { _held = normaliseDeckNames(JSON.parse(await readFile(path, "utf8"))); } catch { _held = new Map(); }
  return _held;
}

/** A session's name, or undefined for none — or before the boot read. */
export function deckNameFor(provider, sessionId) {
  const key = deckNameKey(provider, sessionId);
  return key && _held ? _held.get(key)?.name : undefined;
}

/** Every name held, as [provider, sessionId, name] — the boot's announce. */
export function heldDeckNames() {
  if (!_held) return [];
  return [..._held].map(([key, { name }]) => {
    const cut = key.indexOf(":");
    return [key.slice(0, cut), key.slice(cut + 1), name];
  });
}

let _writes = Promise.resolve();
/**
 * Keep a session's name, or clear it with null, one write at a time. The file
 * is written whole and atomically before memory changes, so a write that
 * fails leaves both as they were and the caller says so. Answers the name
 * kept (null when cleared).
 */
export function writeDeckName(provider, sessionId, name, { path = deckNamesPath(), now = Date.now(), writeFile = writeFileAtomic } = {}) {
  const key = deckNameKey(provider, sessionId);
  if (!key) return Promise.reject(new TypeError("not a session the deck names"));
  const clean = cleanDeckName(name);
  if (clean === undefined) return Promise.reject(new TypeError("not a name"));
  const done = _writes.then(async () => {
    const before = await loadDeckNames(path);
    const next = new Map(before);
    if (clean === null) next.delete(key); else next.set(key, { name: clean, at: now });
    const kept = capDeckNames(next);
    const body = { version: 1, names: Object.fromEntries(kept) };
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(body)}\n`);
    _held = kept;
    return clean;
  });
  _writes = done.catch(() => {});
  return done;
}

/** Tests only: forget what is held, as a new process would. */
export function resetDeckNamesForTest() {
  _held = null;
  _path = null;
  _writes = Promise.resolve();
}
