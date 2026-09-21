// Finding the owner's other machines on Tailscale, for the LAN beacon to reach.
//
// A TAILNET HAS NO BROADCAST DOMAIN. Tailscale routes IP between nodes and
// forwards neither broadcast nor multicast (tailscale#1013, #11134, both open),
// so the beacon that finds a deck on the office Wi-Fi never reaches the same
// person's laptop at home. What a tailnet does have is a list: every node this
// machine can see, with its address, its owner and whether it is online. So
// discovery over Tailscale is the same beacon, sent to each address on that
// list instead of to a broadcast address — and the list is read, never guessed.
// Sweeping 100.64.0.0/10 would be four million addresses of which Tailscale
// delivers only the ones already listed.
//
// THE CLI, NOT THE DAEMON'S LOCAL API. The local API would save a process per
// read, and it is not reachable the same way on the three platforms: on Windows
// it is a named pipe that refuses a Node client ("Unable to impersonate using a
// named pipe until data has been read from that pipe", measured on 1.102.3), and
// on the standalone macOS app its token file is readable by admin-group users
// only. `tailscale status --json` answers on all three, from a plain user, in
// 45-70 ms measured on macOS and Windows.
//
// ONLY THE OWNER'S OWN MACHINES. Paired decks exchange the logins somebody
// ticked, and a tailnet can hold a colleague's laptop, a tagged server, or a
// node somebody else shared in. A node counts as this person's only when it is
// signed in to the same Tailscale user as this one, carries no tag, and was not
// shared in — the same test Taildrop uses before it offers a node as a target.
import { existsSync } from "node:fs";
import { posix as posixPath, win32 as winPath } from "node:path";
import { run as runCommand } from "./exec.mjs";

/** How often the list is read while the switch is on — the beacon's own
 *  interval, so a machine that comes online is announced to on the next
 *  beacon rather than one after it. */
export const TAILNET_MS = 30_000;

/** How old a read may be while the switch is off. Off, the list is only there
 *  to say whether Tailscale is on this machine at all and to tell a tailnet
 *  address from a LAN one, and neither is worth a process every half minute. */
export const IDLE_MS = 5 * 60_000;

/** One read may not hold anything up for longer than this. A healthy one is
 *  under a tenth of a second; a daemon that does not answer is not going to. */
const READ_MS = 4_000;

/** The operating systems a deck runs on, spelled the way Tailscale reports
 *  them. A phone or a TV on the tailnet is online and can never answer, and a
 *  beacon to it wakes its tunnel for nothing. */
const DECK_OS = new Set(["linux", "macOS", "windows"]);

/**
 * Where the CLI may be, best first, for one platform.
 *
 * macOS ships it inside the app bundle — App Store and standalone builds alike —
 * and puts nothing on PATH unless the owner pressed "Install CLI" in the app's
 * settings. A deck started at login gets launchd's PATH, which has none of
 * these directories, so the bundle path goes first. Homebrew's open-source
 * daemon is the other install.
 *
 * Windows installs to Program Files unless somebody chose another folder, and
 * the bare name last lets PATH find that other folder.
 *
 * Built with the asked-about platform's own path module rather than node:path's
 * bound one, because the suite asks for the Windows answer from macOS.
 */
export function tailscaleCandidates(platform = process.platform, env = process.env) {
  if (platform === "win32") {
    const roots = [env.ProgramFiles, env.ProgramW6432, "C:\\Program Files"].filter(Boolean);
    const out = roots.map(root => winPath.join(root, "Tailscale", "tailscale.exe"));
    return [...new Set([...out, "tailscale"])];
  }
  if (platform === "darwin") {
    return [
      "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
      "/opt/homebrew/bin/tailscale",
      "/usr/local/bin/tailscale",
      "tailscale",
    ];
  }
  // The deb and rpm packages install /usr/bin; the static tarball is unpacked
  // wherever its owner put it, which PATH then has to know.
  return ["/usr/bin/tailscale", "/usr/local/bin/tailscale", "tailscale"];
}

/**
 * The environment the CLI is run with.
 *
 * THE macOS BINARY IS ALSO THE APP. With no TERM, TERM_PROGRAM, SHLVL or PS1 it
 * decides it was double-clicked, prints "The Tailscale GUI failed to start" to
 * stdout and exits 0 — measured with a launchd-shaped environment, which is
 * exactly what a deck started at login has. `TAILSCALE_BE_CLI` is Tailscale's
 * own switch for this, and TERM covers a build older than that switch.
 */
export function cliEnv(env = process.env) {
  return { ...env, TAILSCALE_BE_CLI: "1", TERM: env.TERM || "dumb" };
}

/** A node's IPv4 tailnet addresses. The beacon socket is udp4, and a node with
 *  only IPv6 on an IPv6-only tailnet is not somewhere it can send. */
function ipv4s(list) {
  return (Array.isArray(list) ? list : []).filter(a => typeof a === "string" && /^\d{1,3}(\.\d{1,3}){3}$/.test(a));
}

/** What to call a node: the first label of its MagicDNS name, which is unique
 *  on the tailnet, or its hostname, which is not. */
function nodeName(n) {
  const dns = typeof n?.DNSName === "string" ? n.DNSName.split(".")[0] : "";
  return dns || (typeof n?.HostName === "string" ? n.HostName : "");
}

/**
 * `tailscale status --json`, as much of it as this feature reads.
 *
 * The CLI's help says the format "has changed between releases and might change
 * more", so everything is read leniently: a missing field is false, an unknown
 * one is ignored. Null for anything that is not a status document at all —
 * the macOS GUI message above, a version warning, an empty read.
 *
 * `--json` exits 0 while Tailscale is stopped or signed out, so `running` is
 * the backend's own word for it, never the exit code.
 */
export function readTailnet(raw) {
  let doc = raw;
  if (typeof raw === "string") {
    try { doc = JSON.parse(raw); } catch { return null; }
  }
  if (!doc || typeof doc !== "object" || typeof doc.BackendState !== "string") return null;
  const self = doc.Self && typeof doc.Self === "object" ? doc.Self : {};
  const users = doc.User && typeof doc.User === "object" ? doc.User : {};
  // A MACHINE LOGGED IN WITH A TAG KEY OWNS NOTHING. Its user is the shared
  // "tagged-devices" identity, so "same user as me" would be true of every
  // tagged node on the tailnet.
  const selfTagged = Array.isArray(self.Tags) && self.Tags.length > 0;
  const me = self.UserID;
  const peers = Object.values(doc.Peer && typeof doc.Peer === "object" ? doc.Peer : {})
    .filter(p => p && typeof p === "object")
    .map(p => ({
      name: nodeName(p),
      os: typeof p.OS === "string" ? p.OS : "",
      ips: ipv4s(p.TailscaleIPs),
      online: p.Online === true,
      expired: p.Expired === true,
      own: !selfTagged && me != null && p.UserID === me
        && !(Array.isArray(p.Tags) && p.Tags.length > 0)
        && p.ShareeNode !== true,
    }));
  return {
    state: doc.BackendState,
    running: doc.BackendState === "Running",
    self: {
      name: nodeName(self),
      ips: ipv4s(self.TailscaleIPs ?? doc.TailscaleIPs),
      login: typeof users[me]?.LoginName === "string" ? users[me].LoginName : null,
      tagged: selfTagged,
    },
    peers,
  };
}

/**
 * Where a beacon goes on this tailnet: the owner's own machines that are
 * online and could be running a deck, one address each.
 *
 * Offline nodes are skipped rather than tried — a packet to one is relayed to
 * Tailscale's DERP server and dropped there. The list can include this
 * machine's own addresses only if something is badly wrong, and they are
 * filtered anyway: a deck hears its own broadcast already.
 */
export function beaconTargets(tailnet) {
  if (!tailnet?.running || tailnet.self?.tagged) return [];
  const mine = new Set(tailnet.self?.ips ?? []);
  const out = [];
  for (const p of tailnet.peers ?? []) {
    if (!p.own || !p.online || p.expired || !DECK_OS.has(p.os)) continue;
    const at = p.ips[0];
    if (at && !mine.has(at) && !out.includes(at)) out.push(at);
  }
  return out;
}

/** 100.64.0.0/10, the block Tailscale draws every IPv4 node address from. */
function inTailnetBlock(addr) {
  const m = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(addr);
  return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}

/**
 * Whether a packet from `addr` came over the tailnet, and from whom.
 *
 * Null means the local network, which is every answer this deck gave before
 * Tailscale was read — and still the answer on a machine where it is not
 * running.
 *
 * WHAT MAKES THE ANSWER SAFE TO ACT ON is Tailscale, not the packet: WireGuard
 * binds each node address to that node's key, and tailscaled drops a packet
 * whose source is not the node it came from, so a peer cannot claim another
 * peer's address. A node the list does not name yet — it joined since the last
 * read — is still a tailnet address when it is in Tailscale's block and this
 * machine is on one, and it is nobody's own until the list says so.
 */
export function routeOf(tailnet, addr) {
  if (!tailnet?.running) return null;
  const at = String(addr ?? "").replace(/^::ffff:/, "");
  if (!at) return null;
  const node = (tailnet.peers ?? []).find(p => p.ips.includes(at));
  if (node) return { via: "tailscale", own: node.own, name: node.name };
  return inTailnetBlock(at) ? { via: "tailscale", own: false, name: "" } : null;
}

/**
 * The reader: finds the CLI once, reads the list on demand, and keeps the last
 * answer for everything that has to decide synchronously — a beacon arriving,
 * a request to accept.
 *
 * `found` is whether a Tailscale CLI exists on this machine at all, which is
 * what decides whether the dialog shows the switch. A CLI that runs and cannot
 * reach its daemon is found, with no tailnet.
 */
export function createTailnet({
  run = runCommand,
  platform = process.platform,
  env = process.env,
  exists = existsSync,
  now = Date.now,
} = {}) {
  /** The candidate that answered, false once none did, null before looking. */
  let bin = null;
  let tailnet = null;
  let readAt = 0;
  let inFlight = null;

  const isAbsolute = file => (platform === "win32" ? winPath : posixPath).isAbsolute(file);

  const readOnce = async () => {
    const tries = bin ? [bin] : tailscaleCandidates(platform, env).filter(c => !isAbsolute(c) || exists(c));
    let ran = false;
    for (const file of tries) {
      const r = await run(file, ["status", "--json"], { timeout: READ_MS, maxBuffer: 32 << 20, env: cliEnv(env) });
      if (r?.code === "ENOENT") continue;
      ran = true;
      // The document goes to stdout whatever the exit code; a daemon that is
      // not running says so on stderr and leaves stdout empty.
      const read = readTailnet(r?.stdout ?? "");
      bin = file;
      return read;
    }
    if (!ran) bin = false;
    return null;
  };

  const refresh = () => {
    inFlight ??= readOnce()
      .then(read => { tailnet = read; }, () => { tailnet = null; })
      .finally(() => { readAt = now(); inFlight = null; });
    return inFlight;
  };

  return {
    refresh,
    /** Read again only if the last read is older than `maxAge`. */
    freshen(maxAge) {
      if (inFlight || (readAt && now() - readAt < maxAge)) return inFlight ?? Promise.resolve();
      return refresh();
    },
    snapshot: () => tailnet,
    found: () => !!bin,
  };
}
