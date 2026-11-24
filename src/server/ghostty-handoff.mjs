// Ask a verified Ghostty surface to invoke Claude's empty-prompt background
// shortcut. Never send Enter or submit text: the prompt may contain a draft.
import { basename } from "node:path";
import { realpath, stat as fsStat } from "node:fs/promises";
import { adminClaudeBin } from "./claude-identity.mjs";
import { run } from "./exec.mjs";

const LOOKUP_OPTIONS = { timeout: 4000, maxBuffer: 1024 * 1024 };
const SDEF_OPTIONS = { timeout: 4000, maxBuffer: 4 * 1024 * 1024 };

const sendLeft = (app) => `
on run argv
  set wantedPid to (item 1 of argv) as integer
  set wantedTty to item 2 of argv
  tell application ${JSON.stringify(app)}
    set matched to missing value
    repeat with surface in terminals
      if (pid of surface) is wantedPid and (tty of surface) is wantedTty then
        if matched is not missing value then return "ambiguous"
        set matched to contents of surface
      end if
    end repeat
    if matched is missing value then return "unmatched"
    if (pid of matched) is not wantedPid or (tty of matched) is not wantedTty then return "changed"
    if (perform action "csi:D" on matched) then return "sent"
    return "failed"
  end tell
end run
`;

// A tag's attributes, quoted values read whole: a `>` or a `name=` inside a
// description is part of the value.
const ATTRS = String.raw`(?:\s(?:[^>"']|"[^"]*"|'[^']*')*)?`;
// Not self-closing: `<class … />` has no properties, and its match would run
// on into the next class's.
const CLASS_TAG = new RegExp(String.raw`<(class(?:-extension)?)(${ATTRS})(?<!/)>([\s\S]*?)</\1\s*>`, "g");
const PROPERTY_TAG = new RegExp(String.raw`<property(${ATTRS})>`, "g");

function attributes(text) {
  const found = new Map();
  for (const [, key, double, single] of text.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    if (!found.has(key)) found.set(key, double ?? single);
  }
  return found;
}

/** Whether a scripting dictionary (the XML `sdef` prints) lets the script
 *  above tell one surface from another: a class named `terminal` with both a
 *  `pid` and a `tty` property. Properties a `class-extension` of `terminal`
 *  adds count too, and attributes may come in any order. Ghostty 1.3 has the
 *  class and `perform action` but neither property; 1.4 has both. */
export function surfacesIdentifiable(sdef) {
  if (typeof sdef !== "string") return false;
  const xml = sdef.replace(/<!--[\s\S]*?-->/g, "");
  const names = new Set();
  for (const [, tag, attrs, body] of xml.matchAll(CLASS_TAG)) {
    const own = attributes(attrs);
    if ((tag === "class" ? own.get("name") : own.get("extends") ?? own.get("name")) !== "terminal") continue;
    for (const [, property] of body.matchAll(PROPERTY_TAG)) {
      const name = attributes(property).get("name");
      if (name) names.add(name);
    }
  }
  return names.has("pid") && names.has("tty");
}

// Each Ghostty app's answer, by its path, until the bundle's Info.plist
// changes: an update replaces it, so the new version is asked again.
const scripting = new Map();

async function ghosttyCanBeScripted(app, { exec, stat, cache }) {
  let stamp = null;
  try {
    const info = await stat(`${app}/Contents/Info.plist`);
    stamp = `${info.mtimeMs}:${info.size}`;
  } catch { /* Not cached: asked again next time. */ }
  const known = stamp === null ? undefined : cache.get(app);
  if (known && known.stamp === stamp) return known.ok;
  // sdef reads the dictionary from the bundle and sends Ghostty no Apple event,
  // so it never asks for Automation permission.
  const result = await exec("/usr/bin/sdef", [app], SDEF_OPTIONS);
  if (!result.ok) return false;
  const ok = surfacesIdentifiable(result.stdout);
  if (stamp !== null) cache.set(app, { stamp, ok });
  return ok;
}

const SURFACE_CHANGED = new Set(["ambiguous", "unmatched", "changed"]);

function sendOutcome(result) {
  const said = typeof result.stdout === "string" ? result.stdout.trim() : "";
  if (result.ok && said === "sent") return { ok: true };
  if (SURFACE_CHANGED.has(said)) return { ok: false, reason: "surface-changed" };
  // errAEEventNotPermitted (-1743), or consent that could not be asked (-1744).
  if (/-174[34]\b|Not authorized to send Apple events/i.test(String(result.stderr ?? ""))) {
    return { ok: false, reason: "automation-denied" };
  }
  return { ok: false, reason: "failed" };
}

const no = (reason) => ({ ok: false, reason });

/** The answer as `{ ok, reason }`, `reason` set when `ok` is false:
 *  `not-mac`, `not-ghostty`, `ghostty-unsupported` (its scripting cannot
 *  identify a surface), `claude-not-ready` (not one interactive Claude in the
 *  foreground of its terminal), `automation-denied`, `surface-changed` or
 *  `failed`.
 *
 *  `check`: answer whether the move could be asked, by every lookup the real
 *  move makes, and stop before Ghostty is asked anything. The pane offers the
 *  move only where this says yes, so Linux, Windows and a Mac terminal other
 *  than Ghostty, or a Ghostty too old to find the surface, never show a button
 *  that can only fail. */
export async function backgroundInGhostty(session, {
  exec = run, resolvePath = realpath, cli = adminClaudeBin, platform = process.platform,
  enabled = () => true, check = false, stat = fsStat, cache = scripting,
} = {}) {
  if (platform !== "darwin") return no("not-mac");
  const listed = await exec(cli(), ["agents", "--json", "--cwd", session.cwd], LOOKUP_OPTIONS);
  if (!listed.ok) return no("failed");
  let agents;
  try { agents = JSON.parse(listed.stdout); } catch { return no("failed"); }
  if (!Array.isArray(agents)) return no("failed");
  const matches = agents.filter(agent => agent?.sessionId === session.sessionId && agent.kind === "interactive");
  if (matches.length !== 1) return no("claude-not-ready");
  const [agent] = matches;
  if (!Number.isSafeInteger(agent.pid) || agent.pid < 2 || typeof agent.cwd !== "string") return no("claude-not-ready");
  try { if (await resolvePath(agent.cwd) !== await resolvePath(session.cwd)) return no("claude-not-ready"); }
  catch { return no("claude-not-ready"); }

  const processInfo = await exec("/bin/ps", ["-ax", "-o", "pid=,ppid=,pgid=,tpgid=,tty=,comm="], LOOKUP_OPTIONS);
  if (!processInfo.ok) return no("failed");
  const processes = new Map();
  for (const line of processInfo.stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(.+)$/);
    if (!match) continue;
    const [, pid, parent, group, foreground, tty, command] = match;
    processes.set(Number(pid), { pid: Number(pid), parent: Number(parent), group, foreground, tty, command });
  }
  const claude = processes.get(agent.pid);
  if (!claude || basename(claude.command) !== "claude" || !/^ttys\d+$/.test(claude.tty) ||
      claude.group !== claude.foreground) return no("claude-not-ready");
  // The installed API can report the surface's login process even when a
  // descendant owns the foreground group. Match that login PID and the TTY.
  let surface = claude;
  for (let depth = 0; depth < 8; depth++) {
    const parent = processes.get(surface.parent);
    if (!parent) return no("not-ghostty");
    const app = parent.command.match(/^(\/[^\r\n]+\/Ghostty\.app)\/Contents\/MacOS\/ghostty$/)?.[1];
    if (app) {
      if (!enabled()) return no("failed");
      // Without both identifiers the script cannot tell which surface is
      // Claude's, and no key goes to a surface it did not verify.
      if (!await ghosttyCanBeScripted(app, { exec, stat, cache })) return no("ghostty-unsupported");
      if (check) return { ok: true };
      const result = await exec("/usr/bin/osascript", ["-e", sendLeft(app), String(surface.pid), `/dev/${claude.tty}`],
        { timeout: 30_000, maxBuffer: 8192 });
      return sendOutcome(result);
    }
    if (parent.tty !== claude.tty) return no("not-ghostty");
    surface = parent;
  }
  return no("not-ghostty");
}

// A move sent to Ghostty, remembered by session until its continued session
// is found (session-transcript-routes.mjs) or HANDOFF_SENT_FOR passes. A second
// press, another tab, or a press after a slow arrival is answered from here and
// never sends the shortcut twice.
export const HANDOFF_SENT_FOR = 120_000;
const handoffs = new Map();

// Claude writes session ids in lower case; the routes may not.
const key = (sessionId) => String(sessionId).toLowerCase();

export function handoffSent(sessionId) {
  return handoffs.has(key(sessionId));
}

export function rememberHandoff(sessionId, ms = HANDOFF_SENT_FOR) {
  const id = key(sessionId);
  clearTimeout(handoffs.get(id));
  const timer = setTimeout(() => { if (handoffs.get(id) === timer) handoffs.delete(id); }, ms);
  timer.unref?.();
  handoffs.set(id, timer);
}

/** The continued session of a moved one was found: it may be moved again. */
export function handoffContinued(sessionId) {
  const id = key(sessionId);
  clearTimeout(handoffs.get(id));
  handoffs.delete(id);
}
