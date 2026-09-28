// Which decks are up right now, as their own discovery records spell them —
// and only the ones that proved, over their own port, that they are still the
// deck the record describes (#695).
//
// This lived in src/server/index.mjs, inside the Codex rollout watcher, and has
// two readers: the watcher's log election (writesCodexLog), still in index.mjs,
// and logSharing in event-log.mjs, which tells the Clear dialog who owns the
// log. Neither needs anything from the server but the registry directory and
// the challenge, so it moved to a leaf both can import. The verdict cache moved with it and is still
// the only state.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { claudeConfigDir } from "./claude-dir.mjs";
import { challengeDeck, isProcessAlive } from "./deck-probe.mjs";

// How long one record's challenge verdict is trusted. The rollout scan runs
// every 1.5s and would otherwise pay a round trip per record per tick for an
// answer that changes about once per deck lifetime.
//
// Both answers are cached, and neither one delays a takeover, because the pid
// probe runs first and is not cached at all: a deck killed with SIGTERM or
// SIGKILL loses its pid immediately and its record is dropped on the very next
// tick whatever this map says. What the TTL bounds is only the ghost case — a
// record whose pid was recycled by an unrelated process — where five seconds of
// believing a stale "yes" is at most a few unwritten lines, against a directory
// listing plus an HTTP round trip on every tick of every deck forever.
const DECK_PROOF_TTL_MS = 5000;
// `${pid}:${port}:${token}` -> { at, ok }. Keyed on the record's own identity so
// a rewritten record — a deck that restarted onto the same port with a fresh
// token — is a new question rather than an inherited answer.
const deckProofs = new Map();

/**
 * Is the process listening on this record's port the deck the record describes?
 *
 * WHY THE SERVER ASKS AT ALL (#695). readLiveDecks used to trust the pid and
 * nothing else, and a pid is not evidence: a record left behind by a deck that
 * is gone — SIGKILL, an OOM kill, a power cut, a console window closed on
 * Windows, none of which run the shutdown that unlinks it — passes a signal-0
 * probe forever once the OS hands that number to some other long-lived process.
 * writesCodexLog then elected it, because it named a lower port than any real
 * deck, and every deck tailing the rollout drew the events while none of them
 * appended a line. The canvas looked perfectly normal and events.jsonl stopped
 * growing, so nothing said so until a restart replayed a log that had stopped
 * days earlier.
 *
 * hook.js has had the answer to this since the handshake landed and the Codex
 * half never got it — this is that half. The record carries the deck's own token
 * in plaintext (mode 0600, same user, and it is written there precisely so that
 * another process can challenge with it), so we can ask its port to hash that
 * token against a nonce it has never seen. A stranger cannot answer; the deck
 * that wrote the file can.
 *
 * Two records pass without being asked:
 *
 *   • our own. We are the process the record describes, and challenging
 *     ourselves over loopback inside our own scan is a question we already know
 *     the answer to. It also must never fail: writesCodexLog looks itself up in
 *     this list, and a deck that cannot find its own record falls back to
 *     writing — so a self-challenge that timed out under load would turn one
 *     unwritten line into a duplicated one.
 *   • a record with no token, written by a deck older than the handshake. That
 *     is exactly requiresProof's fallback in hook.js, kept in step with it on
 *     purpose: refusing those would make every pre-1.33.71 deck invisible to the
 *     election, which elects a writer for a log those decks are still appending
 *     to.
 *
 * A timeout counts as a failure, like a refusal and a wrong answer. That is the
 * same verdict hook.js reaches — a target that misses the deadline is not posted
 * to either — and it errs the direction the server has always erred: the deck
 * writes, and "a line written twice is recoverable; a deck that quietly stops
 * recording anything is not" (writesCodexLog).
 */
async function provesDeck(d) {
  if (d.pid === process.pid) return true;
  if (typeof d.token !== "string" || d.token === "") return true;

  const key = `${d.pid}:${d.port}:${d.token}`;
  const cached = deckProofs.get(key);
  const now = Date.now();
  if (cached && now - cached.at < DECK_PROOF_TTL_MS) return cached.ok;

  const ok = await challengeDeck(d.port, d.token);
  deckProofs.set(key, { at: now, ok });
  // Records come and go; without this the map would grow by one entry per deck
  // that ever registered on this machine while the process is up.
  for (const [k, v] of deckProofs) {
    if (now - v.at >= DECK_PROOF_TTL_MS) deckProofs.delete(k);
  }
  return ok;
}


/**
 * Every deck registered right now, as its own discovery record spells it — and
 * only the ones that proved they are still the deck their record describes.
 *
 * These are the files hook.js enumerates; this is the server reading them for
 * itself, because the rollout watcher has no hook to do it and still has to know
 * which other decks are tailing the same file into the same log. Dead pids are
 * ignored rather than unlinked — sweepStaleDiscovery owns that, and a poll
 * running every 1.5s is no place to be deleting other decks' registrations. A
 * record that fails the challenge is likewise left alone HERE. The hook is the one
 * reader that does delete a record, and only one that stayed silent through both
 * of its challenge deadlines and has not been restamped for a minute, which a
 * live deck does every five seconds (proveTargets in hook/hook.js, #1119). One
 * missed answer on this poll's timer is not that evidence, so nothing here acts
 * on it.
 *
 * The pid probe stays, in front of the challenge, because it is free and it is
 * the one test that answers instantly when a deck is killed — which is what
 * keeps the takeover immediate rather than TTL-bound. See provesDeck.
 */
async function readLiveDecks() {
  const dir = join(claudeConfigDir(), "agent-dag");
  let files;
  try { files = await readdir(dir); } catch { return []; }
  const candidates = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const d = JSON.parse(await readFile(join(dir, f), "utf8"));
      // Without both numbers there is nothing to group or tie-break on, so the
      // record cannot take part in an election either way.
      if (!d || typeof d.pid !== "number" || typeof d.port !== "number") continue;
      if (!isProcessAlive(d.pid)) continue;
      candidates.push(d);
    } catch { /* corrupt, or gone between listing and read */ }
  }
  // In parallel: with several decks up this is the difference between one 400ms
  // deadline for the scan and one per record.
  const proven = await Promise.all(candidates.map(provesDeck));
  return candidates.filter((_, i) => proven[i]);
}

// What index.mjs calls. Listed rather than marked at the declaration, so the
// declaration reads as it did where it came from.
export { readLiveDecks };
