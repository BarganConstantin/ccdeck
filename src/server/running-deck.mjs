// Why a second `ccdeck` must not quietly become a second deck.
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
// writes ~/.claude/agent-dag/<pid>.json with its pid, port, token and shape.
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
// THE DECK FOUND MUST ALSO BE THE DECK WE WOULD HAVE BUILT. Attaching a plain
// `ccdeck` to a deck started with `--workspace ~/proj` would open a canvas
// filtered to a directory the user never mentioned, and attaching to a
// `--no-claude` deck would open one with no accounts panel and no hooks. So the
// shape is compared field for field, and anything that does not match starts
// its own deck exactly as before.
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
 * The flags that mean "I want a deck of my own", as opposed to "show me the
 * deck".
 *
 * Every one of them changes what the deck IS — which sessions it captures,
 * which log it appends to, which of the two CLIs it serves, which port it
 * binds. A command line carrying any of them is a request that an existing deck
 * cannot satisfy, so it is never answered by attaching to one.
 *
 * `--no-open` is deliberately absent: it changes what the LAUNCHER does once it
 * has a URL, not what the deck is, and it is honoured on the attach path too.
 * `--all` is absent because it has been a no-op since it became the default.
 */
export const SHAPING_FLAGS = Object.freeze([
  "port", "workspace", "scope", "history", "noPersist",
  "codex", "noCodex", "claude", "noClaude",
]);

/**
 * Is this command line one that must build its own deck?
 *
 * Only a shaping flag, and `--new` — the deliberate escape hatch for the person
 * who really does want two.
 *
 * A TYPO IS NOT ONE, and the first version of this had it the other way round.
 * `unknown` and `incomplete` both forced a new deck, on the argument that an
 * attach prints no startup report and would swallow the warning that names the
 * bad token. The consequence of that argument was `ccdeck --stpo` — a typo in
 * the flag that STOPS a deck — building a second one, which is the exact
 * outcome this whole module exists to prevent, reached through the guard meant
 * to protect it.
 *
 * The warning was the real requirement, not the new process, so the attach path
 * prints it instead: see the call to reportUnknownFlags beside the attach in
 * bin/deck.js. Nothing is swallowed, and no misspelling can leave a rival deck
 * on a random port behind it.
 */
export function asksForOwnDeck(flags = {}) {
  if (flags.new === true) return true;
  return SHAPING_FLAGS.some((k) => flags[k] !== undefined);
}

/**
 * Would this record's deck serve what we were about to build?
 *
 * Compared field for field rather than by a version or a heuristic. `claude`
 * and `codex` are strict identity against a boolean, so a record written before
 * either field existed carries `undefined`, fails, and its deck is left alone —
 * which is the old behaviour, reached by construction rather than by a version
 * check nobody would remember to update.
 */
export function sameShape(record, want = {}) {
  if (!record) return false;
  return (record.workspace ?? "") === (want.workspace ?? "")
    && (record.persist ?? null) === (want.persist ?? null)
    && record.codex === (want.codex !== false)
    && record.claude === (want.claude !== false);
}

/** A record complete enough to be worth a challenge. A missing token is a deck
 *  older than the handshake: it cannot prove anything, so it cannot be attached
 *  to, and it keeps the behaviour it has always had. */
function usable(d) {
  return Boolean(d)
    && Number.isInteger(d.pid)
    && Number.isInteger(d.port) && d.port > 0 && d.port < 65536
    && typeof d.token === "string" && d.token !== "";
}

/**
 * Every registered deck whose pid is still there, ordered.
 *
 * NOT PROVED — this is the cheap half, a directory listing and a signal-0 each,
 * and its three callers want different things from it. `detach.mjs` wants only
 * the count, to decide whether deck.log belongs to a deck that is still running
 * or to nobody; a round trip per record to answer that would be absurd. Ordered by port with pid breaking the tie, which is the rule
 * electWriters uses for the log and is here for the same reason: several decks
 * can qualify, and the answer has to be the same one every time it is asked
 * rather than whatever `readdir` happened to return first.
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
 * The deck already serving what this process was about to serve, or null.
 *
 * Only records that already match the shape are challenged, and the walk stops
 * at the first that proves itself. On the ordinary machine that is one loopback
 * round trip; on a machine with no deck running it is a directory listing and
 * nothing else. That is why this is not `liveDecks().find(…)`: the boot path
 * must not pay a round trip per deck to answer a question the first one settles.
 */
export async function runningDeck({
  want = {},
  dir = deckRegistryDir(),
  fs = { readdir, readFile },
  self = process.pid,
  alive = isProcessAlive,
  prove = challengeDeck,
} = {}) {
  for (const d of await registeredDecks({ dir, fs, self, alive })) {
    if (!sameShape(d, want)) continue;
    if (await prove(d.port, d.token)) return d;
  }
  return null;
}

/**
 * Every deck on this machine that answered a challenge, in port order.
 *
 * The list `--status` prints and the list `--stop` chooses from. Everything is
 * challenged here, unlike runningDeck: a list that quietly omitted a deck it
 * could not be bothered to ask about would be worse than no list, because the
 * whole reason to run `--status` is to find the process you did not know was
 * there. The round trips go out together — one deadline for the lot, not one
 * after another — since they are independent and each is bounded at 400ms.
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
 * A mismatch does NOT stop the attach, and that is the deliberate half. Someone
 * who runs `npx ccdeck@latest` while an older deck is up has asked for the new
 * one, but the way to give it to them is not to stand a rival deck on a random
 * port beside the old one — that is the failure this whole module removes. So
 * they are attached and TOLD, with the one sentence that gets them the version
 * they asked for.
 *
 * Empty when the versions agree, and empty when the running deck is too old to
 * report one: "unknown" beside a number is noise, and there is nothing useful
 * to do about it either way.
 */
export function versionNote(running, ours) {
  if (typeof running !== "string" || running === "" || typeof ours !== "string" || ours === "") return "";
  if (running === ours) return "";
  return `running v${running}, you launched v${ours} — restart it from the deck to upgrade`;
}
