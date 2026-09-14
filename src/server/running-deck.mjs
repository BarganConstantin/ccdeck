// Why a second `ccdeck` must never leave a second deck behind it.
//
// THE DEFECT. `startServer` is handed `portRange: [4318, 4400]` and answers a
// refused bind on 4317 by taking a random port out of it. That fallback is
// right and stays: 4317 is also the standard OTLP collector port, and on
// Windows `winnat` reserves contiguous TCP blocks for Hyper-V, WSL2 and Docker
// Desktop, so 4317 can be unavailable on a machine with nothing listening on it
// at all. A deck that comes up on 4322 beats a deck that refuses to come up.
//
// What was wrong is that the SAME fallback ran when the thing holding 4317 was
// another ccdeck. Typing `ccdeck` a second time therefore built a second
// everything — supervisor, worker, server, hook registration, LAN identity,
// browser tab — beside a perfectly healthy first one, and neither said a word
// about the other. Twenty of them were counted on one machine.
//
// THE QUESTION IS NOT "IS THE PORT FREE". It is "is one of MY decks already
// running", and the registry answers that without touching a port: every deck
// writes <config>/agent-dag/<pid>.json with its pid, port, token and shape.
//
// A PID IS NOT EVIDENCE, and that is #695's whole lesson. A record left behind
// by a deck that is gone — SIGKILL, an OOM kill, a power cut, a console window
// closed on Windows, none of which run the shutdown that unlinks it — passes a
// signal-0 probe forever once the OS recycles that number, and the port it
// names may by then belong to anything. So the port has to prove itself: the
// record carries the deck's own token in plaintext (mode 0600, same user,
// written there precisely so another process can challenge with it), and
// challengeDeck asks that port to hash the token against a nonce it has never
// seen. A collector, a container, a stranger on a recycled port cannot answer.
// The deck that wrote the file can.
//
// ONE DECK, WHATEVER THE SHAPE. The first answer to "a deck is up" attached
// only to a deck that was exactly the one this start would have built, and
// built a second one beside anything else. So a flag, an older version, or an
// environment that decided `codex` or the log path differently — a login item
// runs under the service manager's environment, not the shell's — each left
// two decks running on one machine, with two LAN keys and two rows on every
// colleague's panel. It was reported from the field exactly that way. Now a
// start keeps at most one:
//
//   the deck found serves what this start asked for, and is not older  → attach
//   anything else                                                        → stop it, start
//
// The newest start wins, because it is the one somebody just asked for. The
// rule is secondStart, a function of what is running and what was asked, so it
// can be pinned without starting a process.
//
// PER CLAUDE CONFIG DIRECTORY, which is where the registry lives. For nearly
// everybody that is one per user; somebody who points CLAUDE_CONFIG_DIR at a
// second directory has a second registry, and has been getting a second deck
// with its own identity on purpose since deck-home.mjs was written.
//
// WHAT THIS FILE DOES NOT IMPORT: src/server/index.mjs. That module is the whole
// server, and it arms its timers the moment it is loaded — but this one is read
// on the boot path, and by `ccdeck --stop`, which is a command that talks to a
// deck and exits. Starting a server to ask a server to stop is absurd on its
// face and, on a cold start, slower than the thing it is asking for. The
// handshake and the liveness probe therefore live in deck-probe.mjs, a leaf
// that imports two node builtins; index.mjs takes them from the same place and
// re-exports them, so there is still exactly one spelling in the package.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { claudeConfigDir } from "./claude-dir.mjs";
import { challengeDeck, isProcessAlive } from "./deck-probe.mjs";

/**
 * Where every deck on this machine registers itself.
 *
 * Still under ~/.claude, and deliberately: deck-home.mjs moved the deck's own
 * state out of Claude Code's directory and left exactly two things behind, of
 * which this is one. A deck of any version has to be able to list the others,
 * and an older deck reads this directory by name — move it and two versions
 * running side by side stop seeing each other, which is precisely the blindness
 * this module exists to end.
 */
export function deckRegistryDir(env = process.env, home = undefined) {
  return join(home === undefined ? claudeConfigDir(env) : claudeConfigDir(env, home), "agent-dag");
}

/**
 * Would this record's deck serve what we were about to build?
 *
 * Compared field for field rather than by a version or a heuristic. `claude`
 * and `codex` are strict identity against a boolean, so a record written before
 * either field existed carries `undefined` and fails — and a deck that old is
 * replaced rather than attached to, which is what a start does with any deck
 * it cannot vouch for.
 */
export function sameShape(record, want = {}) {
  if (!record) return false;
  return (record.workspace ?? "") === (want.workspace ?? "")
    && (record.persist ?? null) === (want.persist ?? null)
    && record.codex === (want.codex !== false)
    && record.claude === (want.claude !== false);
}

/**
 * Is `running` a version older than `ours`?
 *
 * Numeric, field by field, because "3.9.0" sorts after "3.22.0" as a string. A
 * running deck that publishes no version at all predates the field, which makes
 * it older than anything that does. Our own version unreadable is the one case
 * with nothing to compare, and it answers no: a start that cannot say what it
 * is has no grounds to replace anything.
 */
export function olderVersion(running, ours) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? ""));
    return m ? m.slice(1).map(Number) : null;
  };
  const o = parse(ours);
  if (!o) return false;
  const r = parse(running);
  if (!r) return true;
  for (let i = 0; i < 3; i++) if (r[i] !== o[i]) return r[i] < o[i];
  return false;
}

/**
 * Does this running deck already serve what this start asked for?
 *
 * The shape, the port when one was named, and a version no older than ours.
 * `port` is the one `--port` asked for, or null when none was; 0 is "any free
 * port", which every running deck satisfies.
 */
export function serves(record, { want = {}, port = null, ours = "" } = {}) {
  return sameShape(record, want)
    && (port == null || port === 0 || record.port === port)
    && !olderVersion(record.version, ours);
}

/**
 * What a start does about the decks already running.
 *
 *   { act: "start",   stop: [] }        nothing is running
 *   { act: "attach",  deck, stop }      open `deck`; stop the rest — leftovers
 *                                       from before this rule
 *   { act: "replace", stop }            stop every one of them, then start
 *   { act: "yield",   deck, stop: [] }  a respawn found somebody else's deck
 *
 * `fresh` is `--new`: replace even a deck that would have served. `respawn` is
 * the supervisor bringing a crashed or restarted worker back — that is THIS
 * deck returning, so anything already running got there in the gap, was asked
 * for more recently, and keeps its place.
 *
 * The deck kept on an attach is the first that serves, in the registry's port
 * order, so the answer is the same every time it is asked.
 */
export function secondStart({ live = [], want = {}, port = null, ours = "", fresh = false, respawn = false } = {}) {
  if (!live.length) return { act: "start", stop: [] };
  if (respawn) return { act: "yield", deck: live[0], stop: [] };
  const keep = fresh ? null : live.find(d => serves(d, { want, port, ours })) ?? null;
  if (keep) return { act: "attach", deck: keep, stop: live.filter(d => d !== keep) };
  return { act: "replace", stop: [...live] };
}

/** A record complete enough to be worth a challenge. A missing token is a deck
 *  older than the handshake: it cannot prove anything, so it can be neither
 *  attached to nor stopped by token, and it keeps the behaviour it has always
 *  had. */
function usable(d) {
  return Boolean(d)
    && Number.isInteger(d.pid)
    && Number.isInteger(d.port) && d.port > 0 && d.port < 65536
    && typeof d.token === "string" && d.token !== "";
}

/**
 * Every registered deck whose pid is still there, ordered.
 *
 * NOT PROVED — this is the cheap half, a directory listing and a signal-0 each.
 * `detach.mjs` wants only the count, to decide whether deck.log belongs to a
 * deck that is still running or to nobody; a round trip per record to answer
 * that would be absurd. Ordered by port with pid breaking the tie, which is the
 * rule electWriters uses for the log and is here for the same reason: several
 * decks can qualify, and the answer has to be the same one every time it is
 * asked rather than whatever `readdir` happened to return first.
 *
 * A failure to read the directory is "no decks", not an error. This runs on the
 * boot path of a program whose job is to start, and there is no reading of that
 * directory whose failure is worth refusing to start over.
 */
export async function registeredDecks({
  dir = deckRegistryDir(),
  fs = { readdir, readFile },
  self = process.pid,
  alive = isProcessAlive,
} = {}) {
  let names;
  try { names = await fs.readdir(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let d;
    try { d = JSON.parse(await fs.readFile(join(dir, name), "utf8")); } catch { continue; }
    if (!usable(d)) continue;
    if (d.pid === self) continue;
    if (!alive(d.pid)) continue;
    out.push(d);
  }
  return out.sort((a, b) => a.port - b.port || a.pid - b.pid);
}

/**
 * Every deck on this machine that answered a challenge, in port order.
 *
 * What a start decides by, the list `--status` prints and the list `--stop`
 * ends. Everything is challenged: a start that is about to stop a deck must
 * know it is one, and a list that quietly omitted a deck it could not be
 * bothered to ask about would be worse than no list, because the whole reason
 * to run `--status` is to find the process you did not know was there. The
 * round trips go out together — one deadline for the lot, not one after
 * another — since they are independent and each is bounded at 400ms.
 */
export async function liveDecks({
  dir = deckRegistryDir(),
  fs = { readdir, readFile },
  self = process.pid,
  alive = isProcessAlive,
  prove = challengeDeck,
} = {}) {
  const all = await registeredDecks({ dir, fs, self, alive });
  const proved = await Promise.all(all.map(d => prove(d.port, d.token).then(ok => (ok ? d : null))));
  return proved.filter(Boolean);
}

/**
 * What to say about the version of the deck we attached to.
 *
 * An attach only ever keeps a deck at least as new as the one launched — an
 * older one is replaced — so a difference here is somebody running an older
 * copy, an npx cache or a second install, beside a newer deck. That deck is
 * kept and they are told, because the newer one is what they would have wanted.
 *
 * Empty when the versions agree, and empty when either side is too old to
 * report one: "unknown" beside a number is noise.
 */
export function versionNote(running, ours) {
  if (typeof running !== "string" || running === "" || typeof ours !== "string" || ours === "") return "";
  if (running === ours) return "";
  return olderVersion(running, ours)
    ? `running v${running}, older than the v${ours} you launched`
    : `running v${running}, newer than the v${ours} you launched — kept it`;
}
