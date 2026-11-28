// What the deck asks ccdeck on another machine, and how it reads the answer.
//
// NO NEW DOOR ON THE DEVICE. A device's sessions are read by running
// `ccdeck sessions --json` there, over SSH: the command a person types after
// `ssh` today. It finds the deck running on that machine through the registry
// record only that user can read (deck-client.mjs), asks its loopback port
// with the deck's own token, prints one JSON object and exits. So the token
// never leaves the device, the deck there opens nothing to the network, and
// what this deck may do there is exactly what that command does — read.
// Shipped since 3.44.0, with the same row shape since.
//
// THE REMOTE COMMAND IS A CONSTANT. ssh hands it to the device's login shell
// as one string, which is unavoidable, so it is built from the words below
// and nothing else: no host, no path, no id, nothing a request carried. Two
// spellings, because a non-interactive SSH session often lacks the PATH a
// terminal has (npm's global folder, nvm, Homebrew):
//
//   plain   `ccdeck …`, which works on any shell — cmd and PowerShell on a
//           Windows device too — when ccdeck is on that PATH
//   posix   the same through `sh -c` with the usual install folders added,
//           and nvm loaded when nothing else found it
//
// The one that worked is remembered on the device's record (device-store.mjs).
//
// WHAT COMES BACK IS READ AS DATA FROM ANOTHER MACHINE: one JSON object on the
// last line, every field checked for its type and cut to a length, so a
// device that answers nonsense shows nothing rather than something huge.
import { providerOf } from "./provider-ids.mjs";
import { isOlder } from "./version-order.mjs";

/** The oldest ccdeck whose `sessions --json` this reads. */
export const REMOTE_MIN_VERSION = "3.44.0";

/** The arguments of each thing the deck asks. Fixed words only. */
export const REMOTE_VERBS = Object.freeze({
  version: Object.freeze(["--version"]),
  sessions: Object.freeze(["sessions", "--json"]),
});

// No single quote anywhere in it: it travels inside one.
export const POSIX_FIND = [
  'for d in "$HOME/.local/bin" "$HOME/.npm-global/bin" "$HOME/.volta/bin" "$HOME/.bun/bin" /opt/homebrew/bin /usr/local/bin; do [ -d "$d" ] && PATH="$PATH:$d"; done',
  'command -v ccdeck >/dev/null 2>&1 || { [ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1; }',
  'command -v ccdeck >/dev/null 2>&1 || exit 127',
  'exec ccdeck "$@"',
].join("; ");

/** The launchers, in the order they are tried on a device that has none. */
export const LAUNCH_ORDER = Object.freeze(["plain", "posix"]);

/** The remote command for `verb` through `launcher`. */
export function remoteCommand(launcher, verb) {
  const args = REMOTE_VERBS[verb];
  if (!args) throw new Error(`unknown remote verb ${verb}`);
  if (launcher === "plain") return ["ccdeck", ...args].join(" ");
  if (launcher === "posix") return `sh -c '${POSIX_FIND}' ccdeck ${args.join(" ")}`;
  throw new Error(`unknown launcher ${launcher}`);
}

/** Whether a finished remote command says ccdeck is not there to run: a POSIX
 *  shell's 127, or cmd's and PowerShell's own sentence. */
export function remoteMissing({ code, stdout, stderr }) {
  if (code === 127) return true;
  if (code === 0) return false;
  return /command not found|not recognized as an internal or external command|is not recognized as the name of a cmdlet|ccdeck: not found/i
    .test(`${stderr ?? ""}\n${stdout ?? ""}`);
}

/** The version `ccdeck --version` printed — its last non-empty line — or null. */
export function parseRemoteVersion(stdout) {
  const lines = String(stdout ?? "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const m = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(lines.at(-1) ?? "");
  return m ? m[1] : null;
}

/** Whether a device's ccdeck is too old for what the deck reads from it. */
export const tooOld = (version) => isOlder(version, REMOTE_MIN_VERSION);

/** The last line of `stdout` that parses as a JSON object, or null. */
export function lastJsonObject(stdout) {
  const lines = String(stdout ?? "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch { /* not this line */ }
  }
  return null;
}

const STATES = new Set(["waiting", "working", "idle", "ended"]);
const UNSHOWABLE = /[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
/** The most sessions one device's answer is read for. */
export const MAX_REMOTE_SESSIONS = 500;

const text = (v, max) => (typeof v === "string" && v !== "" ? v.replace(UNSHOWABLE, "").slice(0, max) : null);
const time = (v) => (Number.isFinite(v) ? v : null);

/**
 * One device's session rows, each kept with its device: `key` is the device's
 * id and the session's together, so the same session id, project or title on
 * two machines stays two rows everywhere the page keys a list.
 */
export function remoteSessions(rows, device) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== "object") continue;
    const id = text(row.id, 200);
    if (!id || id !== row.id) continue;
    const state = STATES.has(row.state) ? row.state : null;
    if (!state) continue;
    const w = row.waiting && typeof row.waiting === "object" ? row.waiting : null;
    out.push({
      key: `${device.id}:${id}`,
      id,
      device: { id: device.id, name: device.name },
      provider: providerOf(row.provider),
      cwd: text(row.cwd, 4096),
      project: text(row.project, 256),
      name: text(row.name, 256),
      model: text(row.model, 128),
      state,
      since: time(row.since),
      startedAt: time(row.startedAt),
      lastEventAt: time(row.lastEventAt),
      waiting: w && typeof w.kind === "string" && /^[a-z_]{1,32}$/.test(w.kind)
        ? { kind: w.kind, message: text(w.message, 2000) ?? "", since: time(w.since), tool: text(w.tool, 128) }
        : null,
    });
    if (out.length >= MAX_REMOTE_SESSIONS) break;
  }
  return out;
}

/**
 * What `ccdeck sessions --json` answered, read:
 *
 *   { ok: true, deckVersion, remoteNow, rows }   the deck there answered
 *   { ok: false, reason: "no_deck" }             ccdeck is there, no deck runs
 *   { ok: false, reason: "unreadable" }          anything else
 *
 * `remoteNow` is the device's clock, for ages: two machines' clocks differ.
 */
export function readSessionsAnswer({ code, stdout }) {
  const doc = lastJsonObject(stdout);
  if (code === 3 || doc?.error?.code === "no_deck") return { ok: false, reason: "no_deck" };
  if (code !== 0 || !doc || doc.ok !== true || !Array.isArray(doc.sessions)) return { ok: false, reason: "unreadable" };
  return {
    ok: true,
    deckVersion: typeof doc.deck?.version === "string" ? doc.deck.version.slice(0, 64) : null,
    remoteNow: time(doc.now),
    rows: doc.sessions,
  };
}
