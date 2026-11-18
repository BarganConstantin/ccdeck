// Ask a verified Ghostty surface to invoke Claude's empty-prompt background
// shortcut. Never send Enter or submit text: the prompt may contain a draft.
import { basename } from "node:path";
import { realpath } from "node:fs/promises";
import { adminClaudeBin } from "./claude-identity.mjs";
import { run } from "./exec.mjs";

const LOOKUP_OPTIONS = { timeout: 4000, maxBuffer: 1024 * 1024 };

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

export async function backgroundInGhostty(session, {
  exec = run, resolvePath = realpath, cli = adminClaudeBin, platform = process.platform,
  enabled = () => true,
} = {}) {
  if (platform !== "darwin") return false;
  const listed = await exec(cli(), ["agents", "--json", "--cwd", session.cwd], LOOKUP_OPTIONS);
  if (!listed.ok) return false;
  let agents;
  try { agents = JSON.parse(listed.stdout); } catch { return false; }
  if (!Array.isArray(agents)) return false;
  const matches = agents.filter(agent => agent?.sessionId === session.sessionId && agent.kind === "interactive");
  if (matches.length !== 1) return false;
  const [agent] = matches;
  if (!Number.isSafeInteger(agent.pid) || agent.pid < 2 || typeof agent.cwd !== "string") return false;
  try { if (await resolvePath(agent.cwd) !== await resolvePath(session.cwd)) return false; }
  catch { return false; }

  const processInfo = await exec("/bin/ps", ["-ax", "-o", "pid=,ppid=,pgid=,tpgid=,tty=,comm="], LOOKUP_OPTIONS);
  if (!processInfo.ok) return false;
  const processes = new Map();
  for (const line of processInfo.stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(.+)$/);
    if (!match) continue;
    const [, pid, parent, group, foreground, tty, command] = match;
    processes.set(Number(pid), { pid: Number(pid), parent: Number(parent), group, foreground, tty, command });
  }
  const claude = processes.get(agent.pid);
  if (!claude || basename(claude.command) !== "claude" || !/^ttys\d+$/.test(claude.tty) ||
      claude.group !== claude.foreground) return false;
  // The installed API can report the surface's login process even when a
  // descendant owns the foreground group. Match that login PID and the TTY.
  let surface = claude;
  for (let depth = 0; depth < 8; depth++) {
    const parent = processes.get(surface.parent);
    if (!parent) return false;
    const app = parent.command.match(/^(\/[^\r\n]+\/Ghostty\.app)\/Contents\/MacOS\/ghostty$/)?.[1];
    if (app) {
      if (!enabled()) return false;
      const result = await exec("/usr/bin/osascript", ["-e", sendLeft(app), String(surface.pid), `/dev/${claude.tty}`],
        { timeout: 30_000, maxBuffer: 8192 });
      return result.ok && result.stdout.trim() === "sent";
    }
    if (parent.tty !== claude.tty) return false;
    surface = parent;
  }
  return false;
}
