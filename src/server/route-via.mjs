// Which interface the machine would send a packet to an address by.
//
// A BEACON FOR THE LOCAL NETWORK MUST STAY ON IT. A laptop using a Tailscale
// exit node, or any VPN that takes the local network too, routes even a
// broadcast for its own Wi-Fi into the tunnel — and on the far end it comes out
// on somebody else's network: an office Mac that is the exit node for a home
// laptop put the laptop's beacons on the office LAN, where a colleague whose
// network uses the same addresses could see the name of a machine that is
// nothing to do with them. So before a beacon goes, the machine is asked where
// it would go, and a beacon that would leave through a tunnel does not leave.
//
// Asked of the operating system rather than reasoned from interface names,
// because only the routing table knows what a VPN did to it: `route get` on
// macOS, `ip route get` on Linux, Find-NetRoute on Windows. The answers are
// cached, since routes change when networks do and not every thirty seconds,
// and a lookup that fails or cannot be made answers nothing — the beacon then
// goes as it always did.
import { run as runCommand } from "./exec.mjs";

/** How long one answer is kept. Long enough that a Windows machine starts one
 *  PowerShell every couple of minutes rather than every beacon; short enough
 *  that turning an exit node on stops the beacons into it soon after. */
export const ROUTE_TTL_MS = 120_000;

/** `route -n get <ip>` on macOS: the `interface:` line. */
export function viaFromRouteGet(text) {
  const m = /^\s*interface:\s*(\S+)/m.exec(String(text ?? ""));
  return m ? m[1] : null;
}

/** `ip -o route get <ip>` on Linux: the device after `dev`. */
export function viaFromIpRoute(text) {
  const m = /\bdev\s+(\S+)/.exec(String(text ?? ""));
  return m ? m[1] : null;
}

/** The PowerShell below prints `address|alias` per line on Windows. */
export function viaFromFindNetRoute(text) {
  const out = new Map();
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const at = line.indexOf("|");
    if (at <= 0) continue;
    const alias = line.slice(at + 1).trim();
    if (alias) out.set(line.slice(0, at).trim(), alias);
  }
  return out;
}

/**
 * Whether an interface is a tunnel rather than a network a person is on.
 *
 * Used only for the limited broadcast, which belongs to no one interface: a
 * directed broadcast is judged by whether it leaves by the interface whose
 * subnet it is, which needs no names at all. These are the names tunnels go
 * by on the three platforms — macOS numbers every VPN `utun`, and a Windows
 * adapter is called whatever its VPN named it.
 */
export function looksLikeTunnel(name) {
  if (typeof name !== "string" || !name) return false;
  return /^(utun|tun|tap|wg|ppp|ipsec|gpd|zt)\d*$/i.test(name)
    || /tailscale|wireguard|nordlynx|openvpn|vpn/i.test(name);
}

const QUAD = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Ask the machine, for every address in `targets`, which interface it would
 *  use. A Map of address to interface name; missing where it would not say. */
export async function lookupRoutes(targets, { platform = process.platform, run = runCommand } = {}) {
  const list = targets.filter(t => typeof t === "string" && QUAD.test(t));
  const out = new Map();
  if (!list.length) return out;
  if (platform === "win32") {
    const quoted = list.map(t => `'${t}'`).join(",");
    const ps = `foreach($t in @(${quoted})){ $r = Find-NetRoute -RemoteIPAddress $t -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceAlias } | Select-Object -First 1; $t + '|' + $r.InterfaceAlias }`;
    const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 15_000 });
    return r?.ok ? viaFromFindNetRoute(r.stdout) : out;
  }
  for (const t of list) {
    const r = platform === "darwin"
      ? await run("route", ["-n", "get", t], { timeout: 3_000 })
      : await run("ip", ["-o", "route", "get", t], { timeout: 3_000 });
    const via = r?.ok ? (platform === "darwin" ? viaFromRouteGet(r.stdout) : viaFromIpRoute(r.stdout)) : null;
    if (via) out.set(t, via);
  }
  return out;
}

/**
 * The cache the beacon reads synchronously: `via(address)` is the last answer
 * or undefined, and `want(addresses)` starts one lookup for whichever of them
 * are missing or stale. Never more than one lookup at a time.
 */
export function createRouteCheck({ platform = process.platform, run = runCommand, now = Date.now, ttlMs = ROUTE_TTL_MS } = {}) {
  const cache = new Map();
  let busy = null;
  return {
    via: to => cache.get(to)?.via,
    want(targets) {
      if (busy) return busy;
      const stale = (targets ?? []).filter(t => { const c = cache.get(t); return !c || now() - c.at > ttlMs; });
      if (!stale.length) return Promise.resolve();
      busy = lookupRoutes(stale, { platform, run })
        .then(found => { for (const t of stale) cache.set(t, { via: found.get(t) ?? null, at: now() }); })
        .catch(() => { /* nothing learned; the beacon goes as it always did */ })
        .finally(() => { busy = null; });
      return busy;
    },
  };
}
