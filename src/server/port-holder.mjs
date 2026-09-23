// Which program holds a UDP port, in the words the LAN panel prints.
//
// A deck that cannot bind the discovery port says so, and "another program"
// is a sentence nobody can act on. On the Mac where this was measured the
// program was Tailscale, and finding that out took netstat and an hour. The
// operating system will usually say, without elevation, and when it will not
// the sentence stays the one it was.
//
// Pure readers per platform, and one runner that picks the command; nothing
// here is ever a reason for the deck to fail.
import { run as runCommand } from "./exec.mjs";

/**
 * macOS: `netstat -anv -p udp` lists every UDP socket with its owner as
 * `name:pid` in the process column — readable by a plain user for sockets of
 * any user, which is the reason this is the Mac's answer.
 */
export function holderFromNetstat(text, port) {
  const at = new RegExp(`[.:]${port}\\s`);
  for (const line of String(text ?? "").split("\n")) {
    if (!/^udp/.test(line) || !at.test(line.split(/\s+/).slice(0, 5).join(" ") + " ")) continue;
    const owner = line.split(/\s+/).find(f => /^[A-Za-z][\w.-]*:\d+$/.test(f));
    if (owner) return owner.replace(/:\d+$/, "");
  }
  return null;
}

/** Linux: `ss -H -uanp 'sport = :PORT'` — `users:(("name",pid=…))`, shown
 *  only for this user's own processes; somebody else's is an unnamed row. */
export function holderFromSs(text) {
  const m = /users:\(\("([^"]+)"/.exec(String(text ?? ""));
  return m ? m[1] : null;
}

/** Windows: the owning process's name, one line, from the PowerShell below. */
export function holderFromPowershell(text) {
  const name = String(text ?? "").split(/\r?\n/).map(l => l.trim()).find(Boolean);
  return name && /^[\w .()-]{1,64}$/.test(name) ? name : null;
}

/** The name a person knows the program by. Tailscale is the one measured,
 *  and it goes by a different process name on each platform. */
export function friendlyHolder(name) {
  if (!name) return null;
  if (/tailscale/i.test(name)) return "Tailscale";
  return name;
}

/** Who holds UDP `port` here, or null when the machine will not say. */
export async function portHolder(port, { platform = process.platform, run = runCommand } = {}) {
  try {
    if (platform === "darwin") {
      const r = await run("netstat", ["-anv", "-p", "udp"], { timeout: 5_000 });
      return friendlyHolder(r?.ok ? holderFromNetstat(r.stdout, port) : null);
    }
    if (platform === "win32") {
      const ps = `Get-NetUDPEndpoint -LocalPort ${Number(port)} -ErrorAction SilentlyContinue | Select-Object -First 1 | ForEach-Object { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName }`;
      const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 15_000 });
      return friendlyHolder(r?.ok ? holderFromPowershell(r.stdout) : null);
    }
    const r = await run("ss", ["-H", "-uanp", `sport = :${Number(port)}`], { timeout: 5_000 });
    return friendlyHolder(r?.ok ? holderFromSs(r.stdout) : null);
  } catch {
    return null;
  }
}
