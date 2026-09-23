// The network section's readings, as pure functions of what the platform prints.
//
// Everything here is text in, numbers out, so a Linux answer can be checked from
// a Mac and a Windows one from either — the same reason every parser in
// system-metrics.mjs is exported and pure. The sampler that runs the commands,
// times the connection and keeps the history lives there; this file only reads.
//
// THREE READINGS, AND WHY THESE THREE (#network). The first build of this idea
// was a speed test, and a speed test is the wrong instrument twice over: it
// fills the line for as long as it runs — which is exactly the stall a person
// opens this section to explain — and the maximum a line can carry is not what
// was wrong the day this was designed. That day the Wi-Fi measured 270 Mbit/s
// and Claude FM still went silent for twenty seconds at a time, because every
// packet was leaving through a Tailscale exit node on another continent's relay.
// So the section reports what is MOVING (throughput), how FAR Claude is
// (latency), and which WAY the traffic goes (the route) — the three things a
// person needs to tell "the network is slow" from "the network is fine and
// something else is".

/**
 * Bytes received and sent across the interfaces that are wires, out of
 * `/proc/net/dev`.
 *
 * `include` decides which interfaces count, and the sampler passes the set of
 * physical ones (those with a `device` under /sys/class/net). Counting every
 * interface would count a VPN's traffic twice — once inside the tunnel and once
 * again, encrypted, on the Wi-Fi that carries it — and loopback's traffic,
 * which never leaves the machine, would read as the deck downloading.
 *
 * Returns null when nothing matched, which is not the same as zero: a machine
 * whose counters read zero moved nothing, and one this could not read did not
 * say.
 */
export function parseProcNetDev(text, include = name => name !== "lo") {
  if (typeof text !== "string") return null;
  let rx = 0;
  let tx = 0;
  const ifaces = [];
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    if (!name || name.includes("|") || !include(name)) continue;
    const f = line.slice(colon + 1).trim().split(/\s+/).map(Number);
    // Receive is the first eight columns and transmit the next eight; bytes
    // lead each group.
    if (f.length < 9 || !Number.isFinite(f[0]) || !Number.isFinite(f[8])) continue;
    rx += f[0];
    tx += f[8];
    ifaces.push(name);
  }
  return ifaces.length ? { rx, tx, ifaces } : null;
}

/**
 * The same two totals out of macOS's `netstat -ibn`.
 *
 * Only the `enN` rows, which are the Mac's Ethernet and Wi-Fi ports, and only
 * their `<Link#N>` row — netstat prints one row per address family per
 * interface, and summing all of them would count every byte two or three times.
 * `utun` (every VPN, Tailscale included), `lo`, `awdl`, `llw`, `bridge` and the
 * rest are left out for the reason the Linux reader leaves virtual interfaces
 * out. Read from the END of the row, because the Address column is empty on
 * some interfaces and a count from the front would shift by one.
 */
export function parseNetstatIbn(text) {
  if (typeof text !== "string") return null;
  let rx = 0;
  let tx = 0;
  let seen = 0;
  for (const line of text.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 8 || !/^en\d+$/.test(f[0]) || !f.some(c => c.startsWith("<Link#"))) continue;
    // … Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll
    const ibytes = Number(f[f.length - 5]);
    const obytes = Number(f[f.length - 2]);
    if (!Number.isFinite(ibytes) || !Number.isFinite(obytes)) continue;
    rx += ibytes;
    tx += obytes;
    seen++;
  }
  return seen ? { rx, tx } : null;
}

/**
 * The two totals out of Windows' `netstat -e`.
 *
 * Found by shape rather than by label: the first row that is a word followed by
 * exactly two integers is the Bytes row, in every language Windows ships —
 * "Bytes" is "Octets" on a French machine, and a parser that matched the word
 * would read nothing there. The totals cover every adapter; Windows offers no
 * cheaper per-adapter figure than a PowerShell start, which costs more than
 * this whole section is worth every five seconds.
 */
export function parseNetstatE(text) {
  if (typeof text !== "string") return null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*\S[^\d]*?\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) return { rx: Number(m[1]), tx: Number(m[2]) };
  }
  return null;
}

/**
 * Bytes per second between two readings, or null when the pair cannot say.
 *
 * A counter that went BACKWARDS is an adapter that was reset — unplugged,
 * resumed from sleep, a driver reloaded — and the difference across a reset is
 * not a rate, it is a large negative number. Too short a gap is refused for the
 * opposite reason: two reads a few milliseconds apart turn one packet into a
 * wild figure.
 */
export function rateBetween(prev, next) {
  if (!prev || !next) return null;
  const seconds = (next.at - prev.at) / 1000;
  if (!(seconds >= 0.5)) return null;
  const drx = next.rx - prev.rx;
  const dtx = next.tx - prev.tx;
  if (drx < 0 || dtx < 0) return null;
  return { down: Math.round(drx / seconds), up: Math.round(dtx / seconds) };
}

/** The interface Linux would send a packet for this address out of, from
 *  `ip -o route get <address>`. Asking sends nothing; it reads the routing
 *  table, including the policy tables a Tailscale exit node installs, which
 *  `/proc/net/route` does not show. */
export function routeIfaceLinux(text) {
  if (typeof text !== "string") return null;
  return /\bdev\s+(\S+)/.exec(text)?.[1] ?? null;
}

/** The same question on macOS, from `route -n get <address>`. */
export function routeIfaceDarwin(text) {
  if (typeof text !== "string") return null;
  return /^\s*interface:\s*(\S+)/m.exec(text)?.[1] ?? null;
}

/**
 * What kind of path an interface name is.
 *
 * Direct is the ordinary case and draws nothing at all in the panel: only a
 * route that is not the machine's own connection is worth a line. Names, not
 * probes, because the kernel already named them — `tailscale0`, `wg0`,
 * `nordlynx`, `utun4`, `tun0`, `ppp0`, `zt…` — and asking each VPN client
 * whether it is running would cost a process per client per sample.
 */
export function classifyRoute(iface) {
  if (typeof iface !== "string" || !iface) return null;
  if (/^tailscale\d*$/.test(iface)) return { kind: "tailscale", iface };
  if (/^(wg\d|nordlynx|mullvad|proton|wgpia)/.test(iface)) return { kind: "vpn", iface, name: "WireGuard" };
  if (/^zt/.test(iface)) return { kind: "vpn", iface, name: "ZeroTier" };
  if (/^(utun|tun|tap|ppp|ipsec|gpd|cscotun|vpn)/.test(iface)) return { kind: "vpn", iface, name: null };
  return { kind: "direct", iface };
}

/**
 * The exit node carrying this machine's traffic, and whether it is reached
 * directly or through one of Tailscale's relays, from `tailscale status --json`.
 *
 * The relay is the half that matters. A direct path to an exit node costs a
 * hop; a relayed one sends every byte through a DERP server — `nue` is
 * Nuremberg — and adds the round trip to wherever that is, twice. That is what
 * made a live stream buffer every few minutes on the day this was written, on a
 * line that was otherwise fine.
 */
export function tailscaleExitFromStatus(json) {
  let status = json;
  if (typeof json === "string") {
    try { status = JSON.parse(json); } catch { return null; }
  }
  if (!status || typeof status !== "object" || !status.ExitNodeStatus) return null;
  const peer = Object.values(status.Peer ?? {}).find(p => p && p.ExitNode);
  const node = peer?.HostName || peer?.DNSName?.split(".")[0] || null;
  // CurAddr is set when the path is direct; an empty one with a Relay named is
  // every packet going through that relay.
  const relay = peer && !peer.CurAddr && peer.Relay ? String(peer.Relay) : null;
  return { node, relay };
}

/** One line for a route, the same words the panel and the history use, so the
 *  two can never describe one path differently. */
export function routeLabel(route) {
  if (!route) return null;
  if (route.kind === "direct") return "direct";
  if (route.kind === "tailscale-exit") {
    return `through Tailscale exit node${route.node ? ` ${route.node}` : ""}${route.relay ? `, relayed via ${route.relay}` : ""}`;
  }
  if (route.kind === "tailscale") return "through Tailscale";
  return `through ${route.name ? `${route.name} ` : "a "}VPN${route.iface ? ` (${route.iface})` : ""}`;
}
