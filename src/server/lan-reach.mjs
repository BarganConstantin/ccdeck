// Why another deck cannot reach this one — read off the machine, not guessed.
//
// THE FAILURE THIS EXISTS FOR. Two decks on one router, LAN sync on at both
// ends, and one of them shows an empty list forever. Reported as "he sees me
// and I see nobody", which is the shape that gives it away: Windows lets a
// process send without asking anybody, and drops unsolicited inbound unless a
// rule says otherwise. So the beacon leaves, the far deck hears it and draws a
// row — and the answer coming back is dropped at this machine's edge. Both
// halves of the feature look broken from here and neither is.
//
// WHY IT CANNOT BE FIXED FROM HERE, and this is settled rather than open.
// Creating a firewall rule needs elevation, and `relay-guard.mjs` already wrote
// down why no route in this server may raise a password dialog: `index.mjs`
// deliberately trusts a request carrying no Origin header so hook.js and curl
// keep working, on the reasoning that a process able to POST to loopback can
// already run anything as the user. That holds only while no route can do
// something the caller could not do for itself. One route that elevates hands
// every local process a way to make an authentication prompt appear wearing
// ccdeck's name, at a moment ccdeck chose. So this module reads, decides, and
// hands back a command as TEXT. It is the same shape and the same refusal.
//
// WHY IT IS WORTH SAYING ANYTHING AT ALL, given a manual address already makes
// the feature work without any of this: because "nothing here yet" and "this
// machine cannot be reached" are different facts, and an empty list says the
// first while meaning the second. A person reading it concludes the feature is
// broken, or that the other machine is off. Neither is true and neither is
// actionable.
//
// EVERYTHING BELOW IS A PURE FUNCTION. The probe is one PowerShell call that
// knows nothing and reports three lists; every judgement is here, where the
// suite can run it on any platform. That is the same division lan-sync.mjs and
// lan-socket.mjs already keep, for the same reason.

/** What the probe asks Windows for. Three reads, none of them privileged —
 *  measured: `Get-NetConnectionProfile`, `Get-NetFirewallProfile` and
 *  `Get-NetFirewallApplicationFilter` all answer for an ordinary user, while
 *  `Get-NetFirewallPortFilter` returns "Access is denied". So the rule this
 *  looks for is scoped to a PROGRAM rather than to a port, which is also the
 *  only kind that keeps working: the sync listener's port is ephemeral and is
 *  a different number after every restart. */
export const PROBE_PS = [
  "$ErrorActionPreference='SilentlyContinue'",
  "$nets = @(Get-NetConnectionProfile | ForEach-Object { [pscustomobject]@{ alias=$_.InterfaceAlias; category=[string]$_.NetworkCategory; v4=[string]$_.IPv4Connectivity } })",
  "$profiles = @(Get-NetFirewallProfile | ForEach-Object { [pscustomobject]@{ name=[string]$_.Name; enabled=[bool]$_.Enabled } })",
  "$rules = @(Get-NetFirewallApplicationFilter | Where-Object { $_.Program -eq $env:CCDECK_EXE } | ForEach-Object { $_ | Get-NetFirewallRule } | ForEach-Object { [pscustomobject]@{ direction=[string]$_.Direction; action=[string]$_.Action; enabled=[bool]$_.Enabled; profile=[string]$_.Profile } })",
  // WHICH INTERFACE IS THE LAN, asked of the routing table rather than guessed
  // from a name. The beacon goes to 255.255.255.255, so the interface that
  // carries the broadcast IS the one this feature lives or dies on — and on a
  // machine with Tailscale beside wifi the two have different categories, so
  // picking the wrong one reports Private and clears a machine that is blocked.
  "$bcast = [string](Find-NetRoute -RemoteIPAddress 255.255.255.255 | Select-Object -First 1 -ExpandProperty InterfaceAlias)",
  "[pscustomobject]@{ nets=$nets; profiles=$profiles; rules=$rules; bcast=$bcast } | ConvertTo-Json -Depth 4 -Compress",
].join("; ");

/**
 * Read what the probe printed, or null.
 *
 * REFUSES RATHER THAN GUESSES. Every field here comes back from a shell on
 * somebody else's machine, where a policy, a missing cmdlet or a locale can
 * turn any of it into something this did not expect. A null answer means the
 * panel says nothing, which is what it did before this module existed — the
 * one outcome that cannot make anything worse.
 *
 * `ConvertTo-Json` collapses a one-element array to a bare object, which is
 * the classic way a Windows probe passes its own tests and fails on the one
 * machine that has exactly one network. Normalised here rather than worked
 * around at each use.
 */
export function readProbe(stdout) {
  let raw = null;
  try { raw = JSON.parse(String(stdout ?? "").trim()); }
  catch { return null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const list = v => (Array.isArray(v) ? v : v == null ? [] : [v]).filter(x => x && typeof x === "object");
  return {
    nets: list(raw.nets).map(n => ({
      alias: typeof n.alias === "string" ? n.alias : "",
      category: typeof n.category === "string" ? n.category : "",
      v4: typeof n.v4 === "string" ? n.v4 : "",
    })).filter(n => n.alias),
    profiles: list(raw.profiles).map(p => ({
      name: typeof p.name === "string" ? p.name : "",
      enabled: p.enabled === true,
    })).filter(p => p.name),
    rules: list(raw.rules).map(r => ({
      direction: typeof r.direction === "string" ? r.direction : "",
      action: typeof r.action === "string" ? r.action : "",
      enabled: r.enabled === true,
      profile: typeof r.profile === "string" ? r.profile : "",
    })),
    bcast: typeof raw.bcast === "string" ? raw.bcast.trim() : "",
  };
}

/** The interfaces this machine holds a routable v4 address on, as the names
 *  Windows knows them by. `faces` is passed in rather than read, for the reason
 *  everything else here is pure. Measured on Windows 11 26200: node's key and
 *  `Get-NetConnectionProfile`'s `InterfaceAlias` are the same string, which is
 *  what makes matching them worth doing at all. */
export function localAliases(faces) {
  const out = [];
  for (const [name, list] of Object.entries(faces ?? {})) {
    for (const n of list ?? []) {
      if (n?.internal) continue;
      if (n?.family !== "IPv4" && n?.family !== 4) continue;
      if (typeof n.address !== "string" || n.address.startsWith("169.254.")) continue;
      if (!out.includes(name)) out.push(name);
    }
  }
  return out;
}

/** A connection profile's category is spelled `DomainAuthenticated`; the
 *  firewall profile it answers to is spelled `Domain`. One mapping, in one
 *  place, because getting it wrong reads the wrong profile's `Enabled` and
 *  produces a confident wrong answer rather than a visible failure. */
export function profileFor(category) {
  const c = String(category ?? "").trim().toLowerCase();
  if (c === "public") return "Public";
  if (c === "private") return "Private";
  if (c === "domainauthenticated" || c === "domain") return "Domain";
  return null;
}

/**
 * The network this deck is actually on.
 *
 * A machine with Tailscale, a container bridge and wifi has several profiles
 * and only one of them is the LAN somebody means.
 *
 * `aliases` IS IN PREFERENCE ORDER and is walked in that order rather than
 * matched as a set. The caller puts the broadcast route's interface first,
 * because that is the one the beacon actually leaves by; matching whichever
 * happened to come first in the probe's own output is how the machine this was
 * written on reports Tailscale's Private and clears a wifi that is Public.
 */
export function lanNet(nets, aliases = []) {
  const rows = Array.isArray(nets) ? nets : [];
  for (const a of (Array.isArray(aliases) ? aliases : [])) {
    const want = String(a ?? "").trim().toLowerCase();
    if (!want) continue;
    const hit = rows.find(n => n.alias.toLowerCase() === want);
    if (hit) return hit;
  }
  return rows.find(n => n.v4 && n.v4 !== "Disconnected") ?? rows[0] ?? null;
}

/** Does an inbound allow rule for this program already cover that profile?
 *  A rule's `Profile` is a comma-joined list, and `Any` means all of them. */
export function ruleCovers(rules, profileName) {
  const want = String(profileName ?? "").toLowerCase();
  return (Array.isArray(rules) ? rules : []).some(r => {
    if (!r.enabled) return false;
    if (r.direction.toLowerCase() !== "inbound") return false;
    if (r.action.toLowerCase() !== "allow") return false;
    const on = r.profile.split(",").map(s => s.trim().toLowerCase());
    return on.includes("any") || on.includes(want);
  });
}

/**
 * The command that would change it — as text, for a person to paste into an
 * elevated shell. Never run from here; see the header.
 *
 * ONE RULE, SCOPED TO THE PROGRAM. It covers the discovery socket and the sync
 * listener at once, and it goes on covering the sync listener after a restart
 * moves it — a rule written against today's port is a rule that works today.
 *
 * The category line is only offered when the network is Public, and it is
 * offered rather than assumed: Public is the right setting for a café and the
 * wrong one for the router at home, and this module cannot tell which one
 * somebody is sitting in. The panel says so beside it.
 */
export function fixSteps({ category, alias, exePath }) {
  const steps = [];
  if (profileFor(category) === "Public" && alias) {
    steps.push(`Set-NetConnectionProfile -InterfaceAlias "${alias}" -NetworkCategory Private`);
  }
  steps.push(
    "New-NetFirewallRule -DisplayName \"ccdeck (local network)\" -Direction Inbound"
    + ` -Program "${exePath}" -Action Allow -Profile Private`,
  );
  return steps;
}

/**
 * Whether other decks can reach this one, and what to do when they cannot.
 *
 * `null` means "no opinion", and it is the answer for every machine this cannot
 * speak about: anything that is not Windows, and any probe that did not come
 * back. Silence rather than a hedge — a panel line that says "possibly" about a
 * thing it did not measure is worse than no line.
 *
 * `blocked: false` is a real finding and is worth returning: it lets the panel
 * stop blaming the firewall for an empty list and say the other thing instead,
 * which is that nobody else is running.
 */
export function reachability({ platform, probe, aliases = [], exePath = "" } = {}) {
  if (platform !== "win32") return null;
  if (!probe) return null;
  // The broadcast route first, then the interfaces the deck holds an address
  // on. The routing table is the authority on where a beacon goes; the deck's
  // own addresses are the fallback for a machine where that read came back
  // empty, and the probe's first connected network is the fallback for that.
  const net = lanNet(probe.nets, [probe.bcast, ...aliases]);
  const category = net?.category ?? "";
  const name = profileFor(category);
  if (!name) return null;
  const prof = probe.profiles.find(p => p.name.toLowerCase() === name.toLowerCase());
  // A firewall that is off blocks nothing, and saying otherwise would send
  // somebody to add a rule that changes nothing.
  if (prof && !prof.enabled) return { blocked: false, why: "firewall off", category, alias: net?.alias ?? "" };
  if (ruleCovers(probe.rules, name)) {
    return { blocked: false, why: "rule present", category, alias: net?.alias ?? "" };
  }
  return {
    blocked: true,
    why: "no inbound rule",
    category,
    alias: net?.alias ?? "",
    // The reason in the reader's terms, not the registry's. What they need to
    // know is which half is broken, because the other half is what makes the
    // workaround below obvious rather than magic.
    text: name === "Public"
      ? "This network is set to Public, and Windows drops what other decks send. They can still hear this deck — that is why one of them may already show it."
      : "Windows has no inbound rule for this deck, so it drops what other decks send. They can still hear it — that is why one of them may already show this machine.",
    steps: fixSteps({ category, alias: net?.alias ?? "", exePath }),
  };
}

/**
 * The way out that needs no rule at all, and the reason this module is not the
 * whole answer.
 *
 * A round is one OUTBOUND connection — `roundWith` dials, both sides prove
 * themselves over that socket, and the manifest and any transfer ride it home.
 * Nothing in a round needs this machine to accept a connection. So a deck that
 * cannot be reached can still do every part of this by dialling first, and the
 * two controls that make it dial are an address somebody typed and an invite
 * somebody else minted.
 *
 * WHICH WAY THE INVITE GOES IS THE WHOLE OF IT, and nothing said so before.
 * An invite carries the addresses of the deck that MINTED it, and the deck that
 * PASTES it dials them. So a blocked machine that mints an invite is asking to
 * be called, which is the one thing it cannot receive; the same pair works on
 * the first try if the invite is minted at the other end and pasted here. Same
 * two controls, opposite order, and only one of the orders works.
 */
export function workaround(blocked) {
  if (!blocked) return null;
  return {
    dial: "This deck can still reach out, and one connection is all a round needs.",
    invite: "Ask them to make the invite and paste it here — an invite is dialled by whoever pastes it, so it has to be pasted on this machine rather than made on it.",
    address: "Or type their address below, and this deck will call them.",
  };
}
