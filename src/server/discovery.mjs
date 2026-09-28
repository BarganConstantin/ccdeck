// This deck's entry in the discovery dir: the record every hook reads to find a
// deck to post to, written so no reader lands inside it, and kept on disk for as
// long as the deck runs.
//
// These lived in src/server/installer.mjs, after the hook installer, and share
// nothing with it but the directory and the atomic write. The hooks are
// installed once per boot; the record is written at boot, re-asserted every five
// seconds and removed at shutdown, by bin/deck.js. So they moved to a module of
// their own, and the directory's definition came with them. installer.mjs
// imports the directory and re-exports every name, so bin/deck.js and the CLI
// still import them from there. The code is unchanged.
import { readFile, mkdir, unlink, chmod, utimes } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { claudeConfigDir } from "./claude-dir.mjs";
// Under the name installer.mjs gives it, which is the one the bodies below use.
import { CODEX_HOME as CODEX_DIR } from "./codex-dir.mjs";
import { canonicalLogPath } from "./log-writer.mjs";
import { stripBom, writeFileAtomic } from "./atomic-write.mjs";

// Resolved through claude-dir.mjs, the module that owns the rule, exactly as
// installer.mjs resolves it: the record has to land where the hooks it is for
// look, and they follow CLAUDE_CONFIG_DIR.
const CLAUDE_DIR = claudeConfigDir();

// Single shared discovery dir — both providers' hook scripts post here so one
// running agent-dag server can match either ecosystem's events. It follows the
// Claude config dir, so hook/hook.js has to resolve that dir the same way: it
// reads what this writes, and a disagreement means the hooks find no server.
const AGENT_DAG_DIR = join(CLAUDE_DIR, "agent-dag");

/**
 * The events log as the record spells it: an absolute path, or null when this
 * deck writes none. Shared by the writer and by ensureDiscovery's comparison,
 * so a file this process wrote can never read back as somebody else's.
 */
function persistField(persist) {
  return typeof persist === "string" && persist !== "" ? persist : null;
}

/**
 * The Codex tree as the record spells it: the canonical path of the CODEX_HOME
 * this process reads, or null for a --no-codex deck, which reads none. Shared by
 * the writer and by ensureDiscovery's comparison for the reason persistField
 * is, and exported for a start's own shape in bin/deck.js — so a start asking
 * "does the running deck read my tree" spells the tree exactly the way the
 * record it compares against does. Worked out on every call rather than once at
 * load: it is one realpath on a five-second heartbeat, and a tree that did not
 * exist when the deck started — the first `codex login` creates it — is then
 * named the way it is named once it does.
 */
export function codexHomeField(codex) {
  return codex !== false ? canonicalLogPath(CODEX_DIR) : null;
}

// Every deck's token lives in this directory, and writeFileAtomic's temp file is
// created beside its target with whatever the umask allows — 0644 on most
// machines — so for the moment before the rename the token would sit in a
// world-readable file. 0700 on the directory closes that window from the outside:
// another user cannot traverse into it whatever the mode of a file inside says.
// The dir usually predates this code, so the mode is re-asserted rather than only
// set at creation, where it would be masked by the umask anyway. Windows ignores
// both — NTFS ACLs inherit from the per-user profile directory.
async function ensureDiscoveryDir() {
  if (!existsSync(AGENT_DAG_DIR)) await mkdir(AGENT_DAG_DIR, { recursive: true, mode: 0o700 });
  await chmod(AGENT_DAG_DIR, 0o700).catch(() => {});
}

/**
 * Register this deck, in one step no reader can land inside.
 *
 * The record used to go down with a plain writeFile, which truncates the target
 * and then fills it, so the file existed and was empty for a moment on every
 * rewrite. Everything that reads this directory parses each record whole —
 * electWriters in hook/hook.js, readLiveDecks in live-decks.mjs and
 * sweepStaleDiscovery in index.mjs — and a record that fails to parse is a deck
 * missing from that cycle: the event it should have logged is either logged by
 * nobody or logged twice by the decks that remain, which is the exact failure
 * the single-writer election exists to prevent, reached through the file the
 * election reads. A rename is atomic on Linux, macOS and Windows alike, so a
 * reader now sees the previous record or the new one and never half of either.
 *
 * The token is the deck's proof of identity, so the file holding it is the
 * deck's key material: readable and writable by its owner, nobody else. The mode
 * is pinned after the write because writeFileAtomic can only carry over a mode
 * the target already had — a first registration, or one left by an earlier run
 * under a recycled pid, would otherwise keep whatever the umask handed it.
 */
export async function writeDiscovery({ port, workspace, token, persist = null, codex = true, claude = true, version = "", parent = null }) {
  await ensureDiscoveryDir();
  const file = discoveryPath();
  const data = {
    pid: process.pid,
    port,
    workspace: workspace ?? "",
    // Without this the hooks refuse to post: a file naming a port it cannot
    // authenticate is exactly the stale-file case they now decline to trust.
    token: token ?? "",
    // Absolute path of the events log this deck appends to, or null under
    // --no-persist. The hook reads it to elect a single writer per file:
    // several decks receive the same event by design, and without this they
    // each appended their own copy to the one log they share. See
    // electWriters in hook/hook.js.
    persist: persistField(persist),
    // Is this deck tailing Codex's rollout files? Those events never pass
    // through a hook, so the decks elect a writer for them among themselves —
    // and a deck running --no-codex must be left out of that election rather
    // than win it and record a rollout it is not even reading. See
    // writesCodexLog in src/server/log-writer.mjs.
    codex: codex !== false,
    // And WHOSE rollouts. `codex: true` says this deck tails them and never said
    // from where, while CODEX_HOME moves the whole tree — #375 was five modules
    // disagreeing about where it points. Two decks sharing one events.jsonl can
    // therefore be reading two different trees, and the election grouped them
    // anyway, because an unscoped deck's workspace contains every cwd and this
    // was the one field that could have told them apart. The lower-port deck won
    // a rollout it had never opened, the deck reading it stood down, and the
    // shared log recorded nothing of that session (#982).
    //
    // Canonical rather than as spelled, for the reason canonicalLogPath gives
    // the log path above (#793): a symlinked ~/.codex, an 8.3-shortened
    // USERPROFILE or /tmp against /private/tmp would otherwise put two decks
    // reading one tree into two groups and elect them both — the duplicate the
    // election exists to end. Only this published copy is canonicalised.
    // codex-dir.mjs goes on reading and writing through the spelling the user
    // chose, which it has to for a symlinked home (see codexHome() there).
    codexHome: codexHomeField(codex),
    // Does this deck run Browser Watch? The watch elects a single writer among
    // the decks on a machine, and it elected on port alone — so an older ccdeck
    // that predates the feature won the election by having the lower port and
    // then wrote nothing, while the deck that HAS the watch stood down. Measured
    // on this machine: a v1.46 deck from an npx cache held 4317, answered the
    // watch route with the SPA's index.html, and Browser Watch silently
    // recorded nothing for as long as both were up. No error, no log line — the
    // panel showed findings on screen and the disk stayed empty.
    //
    // Same shape as `codex` above, and for the same reason: a deck that is not
    // doing the work must be left out of the election rather than win it. An
    // older deck has no such field, so it is excluded by construction.
    watch: true,
    // Is the Claude side of this deck switched on? Same shape as `codex` above
    // and there for a second reader: a bare `ccdeck` that finds this deck
    // running attaches to it instead of starting a rival, and it may only do
    // that when the deck on the port is the deck it would itself have built. A
    // `--no-claude` deck has no hooks, no accounts panel and no switcher, and
    // until this field existed it was indistinguishable from one that has all
    // three. An older deck has no such field, so it never passes for one and is
    // replaced instead — see secondStart.
    claude: claude !== false,
    // What this deck IS, so a launcher that attaches can say whether the deck
    // it found is the version the user just asked for. Never a decision: a
    // rival deck on a random port is worse than an older deck said out loud.
    version: typeof version === "string" ? version : "",
    // The supervisor above this worker, or null when nothing is supervising.
    //
    // Only `ccdeck --stop` reads it, and only on the path where the polite
    // request failed. A worker killed on its own leaves its supervisor alive,
    // and a supervisor that puts crashed workers back would answer that kill by
    // starting the deck again — so the ladder has to end the parent first and
    // the child second, which it cannot do without being told who the parent is.
    parent: Number.isInteger(parent) ? parent : null,
    startedAt: new Date().toISOString(),
  };
  await writeFileAtomic(file, JSON.stringify(data, null, 2) + "\n");
  await chmod(file, 0o600).catch(() => {});
  return file;
}

export async function removeDiscovery(file) {
  try { await unlink(file); } catch {}
}

/** Where this process registers itself. One file per deck, named by pid. */
export function discoveryPath() {
  return join(AGENT_DAG_DIR, `${process.pid}.json`);
}

/**
 * Make sure this deck's discovery file is on disk and says what it should.
 *
 * Registration was a single write at boot, so anything that took the file away
 * afterwards — a sweep on another machine's clock, a half-finished restart, a
 * user tidying the directory — left a deck that was listening, serving and
 * completely invisible: hook.js enumerates this directory and nothing else, so
 * the deck received zero events while looking perfectly healthy. Re-asserting
 * is cheap (one small read), so the deck checks rather than assumes.
 *
 * A file this process wrote is left alone, mode and contents included — only its
 * mtime moves, stamped on every check; see the note where it is. Anything else —
 * no file, unreadable, another pid, a stale port, token, events log, Codex
 * setting or Codex tree, Claude setting, or a version left by the deck this
 * process replaced — is replaced. Every field another deck decides by is compared, the
 * log path included: leave one out and a record missing it would pass as ours
 * forever, which for the log path means no deck can tell which of them share a
 * file and they all write their own copy of every event again. The Codex tree
 * is compared strictly for the same reason: a record from before the field
 * existed has none, and `undefined` must read as "rewrite", never as a
 * --no-codex deck's null.
 */
export async function ensureDiscovery({ port, workspace, token, persist = null, codex = true, claude = true, version = "", parent = null }) {
  const file = discoveryPath();
  try {
    const d = JSON.parse(stripBom(await readFile(file, "utf8")));
    if (d
      && d.pid === process.pid
      && d.port === port
      && (d.workspace ?? "") === (workspace ?? "")
      && (d.token ?? "") === (token ?? "")
      && (d.persist ?? null) === persistField(persist)
      && d.codex === (codex !== false)
      && d.codexHome === codexHomeField(codex)
      && d.claude === (claude !== false)
      && (d.version ?? "") === (typeof version === "string" ? version : "")
      && (d.parent ?? null) === (Number.isInteger(parent) ? parent : null)) {
      // STAMPED, though nothing in it changed. The mtime is how a reader tells a
      // record some deck is still keeping from one whose deck is gone while its
      // pid lives on under another process: hook.js unlinks a record whose port
      // lets both challenge deadlines pass only once this stamp is a minute old
      // (#1069), which a deck running this check every five seconds never lets
      // happen. Best-effort — a stamp that cannot be written leaves the record
      // exactly as every deck before this one left it.
      const now = new Date();
      await utimes(file, now, now).catch(() => {});
      return { file, rewritten: false };
    }
  } catch { /* missing, unreadable or corrupt — rewritten below */ }
  await writeDiscovery({ port, workspace, token, persist, codex, claude, version, parent });
  return { file, rewritten: true };
}

/**
 * Keep this deck registered for as long as it runs, and tell the caller when
 * that stops being true.
 *
 * `onState` hears the first outcome, every change of health, and every
 * re-registration after the first — never a steady state. A deck that cannot
 * write the file has to say so: silently listening while no hook can find it
 * is the failure this exists to end, not a state worth hiding.
 *
 * The interval is unref'd, so it never keeps a finished process alive, and
 * `stop()` must be called before the file is removed on shutdown — otherwise
 * the next tick would put it straight back.
 *
 * `stop()` ANSWERS WITH THE CHECK ALREADY IN FLIGHT, and shutdown has to await
 * it. Clearing the interval stops the next tick; it does nothing about the one
 * that started a moment ago and is currently inside writeFileAtomic. That tick
 * finishes after the unlink and re-creates the file — exactly the "leave the
 * file behind for the hooks to find once nothing is listening" that stopping
 * first is supposed to prevent, reached by the one route stopping first does
 * not cover. The window is a rename and an fsync on POSIX; on Windows it is
 * that plus renameWithRetry's ladder, up to 200ms of sleeping while a scanner
 * holds the target — the platform the retry was written for is the platform
 * where the race is twenty times wider.
 *
 * `run()` never rejects (every failure is a state), so awaiting this cannot
 * throw and cannot outlast one bounded check.
 */
export function keepDiscovery({ port, workspace, token, persist = null, codex = true, claude = true, version = "", parent = null, intervalMs = 5000, onState = null } = {}) {
  // null until the first outcome, which therefore always differs and is always
  // reported — the caller learns where it stands before anything else happens.
  let healthy = null;

  const run = async () => {
    let state;
    try {
      const { rewritten } = await ensureDiscovery({ port, workspace, token, persist, codex, claude, version, parent });
      state = { ok: true, rewritten, file: discoveryPath(), error: null };
    } catch (err) {
      state = { ok: false, rewritten: false, file: discoveryPath(), error: err };
    }
    const worthSaying = healthy !== state.ok || state.rewritten;
    healthy = state.ok;
    if (worthSaying && onState) { try { onState(state); } catch { /* not our problem */ } }
    return state;
  };

  // One check at a time. Registration is a write and a write is now a rename,
  // which costs an fsync — long enough that a tick can land inside the boot-time
  // check bin/deck.js runs by hand. That second check reads a file the first has
  // not renamed into place yet, concludes the deck is unregistered and writes it
  // again, and the two writes race over one record: the deck reports itself
  // unregistered on a machine where nothing whatsoever is wrong. A caller that
  // asks mid-check gets the answer the check already in flight is fetching.
  let inFlight = null;
  const check = () => (inFlight ??= run().finally(() => { inFlight = null; }));

  const timer = setInterval(() => { check(); }, intervalMs);
  timer.unref?.();

  const stop = () => {
    clearInterval(timer);
    return inFlight ?? Promise.resolve(null);
  };

  return { file: discoveryPath(), check, stop };
}

export { AGENT_DAG_DIR };
