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
export function fixSteps({ category, alias, exePath, rules = [] }) {
  const steps = [];
  const name = profileFor(category);
  if (name === "Public" && alias) {
    steps.push(`Set-NetConnectionProfile -InterfaceAlias "${alias}" -NetworkCategory Private`);
  }
  // THE PROFILE OF THE NETWORK THE DECK IS ON, NOT ALWAYS PRIVATE. A company
  // LAN joined to a domain is `DomainAuthenticated`, which the firewall answers
  // with its Domain profile, and a rule scoped to Private never applies there.
  // Measured on a Windows box whose Ethernet is DomainAuthenticated: the rule
  // was pasted, the panel went on saying there was none — correctly — and a
  // second paste made a second rule that did nothing either. Domain and
  // Private together, so a laptop that goes home keeps working there too.
  // Public is never added: a Public network gets the category line above.
  const profile = name === "Domain" ? "Domain,Private" : "Private";
  // AND A RULE THAT IS ALREADY THERE IS WIDENED, NOT JOINED BY ANOTHER. The
  // probe only returns rules for this program, so an inbound allow rule in
  // `rules` is one of ours on the wrong profile, and a new rule beside it is
  // the duplicate this was reported with.
  const ours = (Array.isArray(rules) ? rules : [])
    .some(r => r?.enabled && String(r.direction).toLowerCase() === "inbound" && String(r.action).toLowerCase() === "allow");
  steps.push(ours
    ? `Get-NetFirewallApplicationFilter -Program "${exePath}" | Get-NetFirewallRule | Set-NetFirewallRule -Profile ${profile}`
    : "New-NetFirewallRule -DisplayName \"ccdeck (local network)\" -Direction Inbound"
      + ` -Program "${exePath}" -Action Allow -Profile ${profile}`);
  return steps;
}

// ── linux ───────────────────────────────────────────────────────────────────
//
// THE SAME FAILURE, ONE DISTRIBUTION FURTHER. Reported from a pair of decks on
// one router: a Mac heard an Arch machine's beacon every thirty seconds and
// every dial to it timed out. The Arch box was running Omarchy, which installs
// `ufw` and enables it, and `ufw` denies inbound by default — so the beacon
// left (outbound is allowed) and nothing could ever get back in. Both sides
// read `handshake timed out`, which names the symptom and nothing else.
//
// WHAT CANNOT BE READ HERE, and it is the difference from the Windows path
// above. `ufw status` is root-only — it reads /etc/ufw/user.rules, mode 0640
// root:root — so an ordinary process can learn that the firewall is ON and
// what its default inbound policy is, and CANNOT learn whether somebody has
// already allowed these two ports. firewalld is the same: `--state` answers
// anybody, `--list-ports` answers root.
//
// SO THE MEASUREMENT CARRIES THE VERDICT AND THE CONFIGURATION ONLY RAISES
// THE QUESTION. `inbound` is when a connection from another machine last
// arrived on the sync listener (see lan-engine's inboundAt). If one ever has,
// the path is open and nothing here has an opinion, whatever the rule files
// say. Only when the firewall is on, its inbound default drops, and nothing
// has ever got in does this speak — and it says what it measured, in those
// terms, rather than claiming to have read a rule it cannot read.
//
// THE COMMANDS ARE SAFE TO PASTE TWICE. `ufw allow` on a rule that exists
// prints "Skipping adding existing rule" and changes nothing; firewalld's
// --add-port is idempotent the same way. That is what makes an unverifiable
// question worth asking at all: the cost of a false alarm is one paste.

/** Both world-readable (0644), on every distribution that ships ufw: the
 *  switch, and the default this feature lives or dies on. */
export const UFW_CONF = "/etc/ufw/ufw.conf";
export const UFW_DEFAULTS = "/etc/default/ufw";

/**
 * What ufw's two readable files say: whether it is on, and what it does with
 * an inbound packet no rule matched.
 *
 * Both are shell fragments sourced by ufw's own scripts, so the values may or
 * may not be quoted and the file may hold comments and blank lines. Anything
 * unreadable — a machine with no ufw at all — comes in as null and reads as
 * off, which is the answer that says nothing rather than the one that blames.
 */
export function readUfw(conf, defaults) {
  const on = /^[ \t]*ENABLED[ \t]*=[ \t]*["']?yes["']?[ \t]*$/im.test(String(conf ?? ""));
  const raw = /^[ \t]*DEFAULT_INPUT_POLICY[ \t]*=[ \t]*["']?([A-Za-z]+)["']?/im.exec(String(defaults ?? ""));
  return { enabled: on, input: (raw?.[1] ?? "").toUpperCase() };
}

/** A systemd unit's state, from `systemctl is-active <unit>`. The command exits
 *  non-zero for anything that is not active, so its output is what is read and
 *  its status is not: `inactive`, `failed` and `unknown` are all "not running"
 *  and only one of them is an error. */
export const isActive = out => String(out ?? "").trim().split("\n")[0]?.trim() === "active";

/**
 * The two lines that open the path, as text.
 *
 * SCOPED TO PORTS, because Linux firewalls have no equivalent of the
 * program-scoped rule the Windows path uses. That makes the sync port's
 * stability load-bearing rather than merely nice: the listener asks for the
 * port it had last time (see createSyncServer), so a rule written today is
 * still the right rule after a restart. A deck that has not started listening
 * yet has no port to name, and then only the discovery line is offered — half
 * an answer, and the half that never changes.
 */
export function linuxFixSteps({ tool, syncPort, discoveryPort }) {
  const sync = Number.isInteger(syncPort) && syncPort > 0 ? syncPort : null;
  if (tool === "firewalld") {
    const steps = [`sudo firewall-cmd --permanent --add-port=${discoveryPort}/udp`];
    if (sync) steps.push(`sudo firewall-cmd --permanent --add-port=${sync}/tcp`);
    steps.push("sudo firewall-cmd --reload");
    return steps;
  }
  const steps = [`sudo ufw allow ${discoveryPort}/udp comment 'ccdeck discovery'`];
  if (sync) steps.push(`sudo ufw allow ${sync}/tcp comment 'ccdeck sync'`);
  return steps;
}

/**
 * Whether other decks can reach this Linux machine, from what can be read
 * without root plus the one thing that was measured.
 *
 * Null for a machine with no firewall running, which is most of them: nothing
 * to say, so nothing said.
 */
export function linuxReach({ ufw = null, firewalld = false, inbound = null, syncPort = null, discoveryPort = 45_317 } = {}) {
  // MEASURED BEATS READ. A connection from another machine has arrived, so
  // whatever the rules are, they let this through.
  if (inbound) return { blocked: false, why: "inbound seen", category: "", alias: "" };
  const drops = ufw?.enabled && (ufw.input === "DROP" || ufw.input === "REJECT");
  const tool = drops ? "ufw" : firewalld ? "firewalld" : null;
  if (!tool) return null;
  return {
    blocked: true,
    why: `${tool} inbound default`,
    category: "",
    alias: "",
    shell: "sh",
    tool,
    // The reason in the reader's terms. Both halves are said because the
    // asymmetry is the confusing part: their deck may already show this
    // machine's name, which reads as a working connection and is not one.
    text: tool === "ufw"
      ? "ufw is running here and drops what it was not told to allow, so other decks cannot reach this one. They can still hear it — that is why one of them may already show this machine."
      : "firewalld is running here and drops what it was not told to allow, so other decks cannot reach this one. They can still hear it — that is why one of them may already show this machine.",
    // Said out loud, because it is the difference between this verdict and the
    // Windows one and a reader deserves to know which they are holding.
    unsure: `${tool} does not show its rules to anything but root, so this cannot tell whether the two ports are already allowed. Running the lines again when they are changes nothing.`,
    steps: linuxFixSteps({ tool, syncPort, discoveryPort }),
  };
}

// ── macos ───────────────────────────────────────────────────────────────────
//
// THE REVERSAL. This module used to say macOS was deliberately silent: the
// firewall ships off, and when it is on it asks the person at the keyboard the
// first time a program listens — so the answer was either "nothing is in the
// way" or "somebody was shown a dialog and pressed a button".
//
// The second half of that is what gave way. A deck started from a terminal, or
// by npx, or by a launch agent, is not always a program somebody is sitting in
// front of when the question is asked, and a dialog nobody answers is a denial
// that looks exactly like an empty list. And the answer IS readable. Measured
// on macOS 26.6, as an ordinary user, no password and exit 0 on all four:
// `--getglobalstate`, `--getblockall`, `--getstealthmode`, and
// `--getappblocked <path>`.
//
// WHICH MAKES THIS THE BEST-INFORMED OF THE THREE PLATFORMS, not the worst.
// ufw will not show its rules to anybody but root, so the Linux verdict reasons
// from a default policy and says out loud that it could not check. This one can
// ask the exact question — is an incoming connection to THIS binary permitted —
// about the binary the listener actually runs as. So there is no `unsure` here,
// because there is nothing it could not look at.
//
// WHAT IS NOT EVIDENCE, and the trap this nearly walked into: with the firewall
// OFF, `--getappblocked` answers "is permitted" for every path handed to it,
// including one that does not exist. Measured, and it is the reason the order
// in macReach is load-bearing rather than tidy — the per-app answer means
// nothing at all until the global state says the firewall is on.
//
// STEALTH MODE IS READ AND NOT ACTED ON. It drops unsolicited probes to ports
// nothing is listening on, which is not this: a deck that is listening and
// allowed still answers. Blaming it would send somebody to change a setting
// that was never in the way.

/** The application firewall's own tool. Not on PATH, and the full path is what
 *  goes in the lines somebody pastes, so it is written once. */
export const MAC_FW = "/usr/libexec/ApplicationFirewall/socketfilterfw";

/**
 * What the three reads said, as a verdict-shaped thing.
 *
 * Every field can come back null, which is this file's word for "the machine
 * did not answer that" — a locked-down build, a future macOS that renamed the
 * flag, a tool that is not there at all. Null travels to macReach and comes out
 * as silence rather than as a guess.
 */
export function readMacProbe({ global: globalState, blockAll, app } = {}) {
  // "Firewall is disabled. (State = 0)" / "Firewall is enabled. (State = 1)".
  // The number is read rather than the adjective: it is the stable half of the
  // sentence, and 2 is a third state that says enabled in words.
  const state = /State\s*=\s*(\d+)/i.exec(String(globalState ?? ""))?.[1];
  return {
    on: state == null ? null : Number(state) > 0,
    // "Firewall has block all state set to enabled." — the setting that turns
    // every allowance off at once, including one this deck already has.
    blockAll: /block all state set to enabled/i.test(String(blockAll ?? "")),
    // "Incoming connection to <path> is permitted." / "... is blocked."
    appBlocked: /is blocked/i.test(String(app ?? "")) ? true
      : /is permitted/i.test(String(app ?? "")) ? false
      : null,
  };
}

/**
 * The lines that open the path, as text.
 *
 * SCOPED TO THE PROGRAM, like the Windows rule and unlike the Linux ones: the
 * application firewall has no notion of a port, which is what makes it the
 * right shape here — the sync listener's port is a different number after some
 * restarts, and a rule about the binary survives that.
 *
 * `--add` before `--unblockapp` because a binary the firewall has never heard
 * of cannot be unblocked; adding one that is already listed changes nothing,
 * so the pair is safe to paste twice.
 */
export function macFixSteps({ exePath, blockAll = false } = {}) {
  const steps = [];
  // First, because while it is on nothing else in this list has any effect.
  if (blockAll) steps.push(`sudo ${MAC_FW} --setblockall off`);
  steps.push(`sudo ${MAC_FW} --add "${exePath}"`);
  steps.push(`sudo ${MAC_FW} --unblockapp "${exePath}"`);
  return steps;
}

/**
 * Whether other decks can reach this Mac, from what the application firewall
 * says about this deck's own binary.
 *
 * Null for anything it could not read, and for the ordinary machine whose
 * firewall is simply off — see the block above for why `appBlocked` is not
 * consulted until `on` is true.
 */
export function macReach({ probe = null, exePath = "", inbound = null } = {}) {
  // MEASURED BEATS READ, here as on the other two: a connection from another
  // machine has arrived, so the path is open whatever the settings say.
  if (inbound) return { blocked: false, why: "inbound seen", category: "", alias: "" };
  if (!probe || probe.on == null) return null;
  if (!probe.on) return { blocked: false, why: "firewall off", category: "", alias: "" };
  // Both halves of the sentence, because the asymmetry is the confusing part:
  // the other deck may already show this machine's name, which reads as a
  // working connection and is not one.
  const heard = " They can still hear it — that is why one of them may already show this machine.";
  if (probe.blockAll) {
    return {
      blocked: true,
      why: "block all incoming",
      category: "",
      alias: "",
      shell: "sh",
      text: "macOS is set to block all incoming connections, so other decks cannot reach this one." + heard,
      steps: macFixSteps({ exePath, blockAll: true }),
    };
  }
  if (probe.appBlocked === true) {
    return {
      blocked: true,
      why: "app blocked",
      category: "",
      alias: "",
      shell: "sh",
      text: "The macOS firewall is refusing incoming connections to this deck, so other decks cannot reach it." + heard,
      steps: macFixSteps({ exePath }),
    };
  }
  if (probe.appBlocked === false) return { blocked: false, why: "app permitted", category: "", alias: "" };
  return null;
}

/**
 * Whether other decks can reach this one, and what to do when they cannot.
 *
 * `null` means "no opinion", and it is the answer for every machine this cannot
 * speak about: anything that is none of the three platforms below, and any
 * probe that did not come back. Silence rather than a hedge — a panel line that
 * says "possibly" about a thing it did not measure is worse than no line.
 *
 * `blocked: false` is a real finding and is worth returning: it lets the panel
 * stop blaming the firewall for an empty list and say the other thing instead,
 * which is that nobody else is running.
 */
export function reachability({ platform, probe, aliases = [], exePath = "", inbound = null, linux = null, mac = null } = {}) {
  // Three platforms, three entirely different reads — see each block above for
  // why none of them can be written in another's shape. `inbound` is the one
  // input all of them share: it is a measurement rather than a read, so it
  // outranks whatever any platform's configuration says.
  if (platform === "linux") return linux ? linuxReach({ ...linux, inbound }) : null;
  if (platform === "darwin") return mac ? macReach({ probe: mac, exePath, inbound }) : null;
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
  // MEASURED BEATS READ, here as on Linux: a connection from another machine
  // has arrived on the sync listener, so the path is open whatever rule this
  // was about to fail to find. See lan-engine's inboundAt.
  if (inbound) return { blocked: false, why: "inbound seen", category, alias: net?.alias ?? "" };
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
    // Which shell the steps are written in, so the panel says where to paste
    // them without asking what platform it is drawing for. Every other field
    // here is already the verdict's to choose; this is one more.
    shell: "powershell",
    // The reason in the reader's terms, not the registry's. What they need to
    // know is which half is broken, because the other half is what makes the
    // workaround below obvious rather than magic.
    text: name === "Public"
      ? "This network is set to Public, and Windows drops what other decks send. They can still hear this deck — that is why one of them may already show it."
      : name === "Domain" && probe.rules.length
        ? "Windows lets this deck in on Private networks only, and this one is a company (Domain) network, so it drops what other decks send. They can still hear it — that is why one of them may already show this machine."
        : "Windows has no inbound rule for this deck, so it drops what other decks send. They can still hear it — that is why one of them may already show this machine.",
    steps: fixSteps({ category, alias: net?.alias ?? "", exePath, rules: probe.rules }),
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
// ── the machine nothing can be asked about ──────────────────────────────────
//
// Every block above depends on the operating system answering a question.
// FreeBSD has nobody to ask; a Linux box running plain nftables has no ufw.conf
// to read; a Windows probe comes back empty for a dozen policy reasons; a
// hardened Mac can refuse the tool. All of them arrive at `reachability` as
// null — which is honest, and no use at all to somebody watching an empty list.
//
// WHAT IS MEASURABLE ON ANY OF THEM. A beacon ARRIVING proves this machine
// hears the network. `inboundAt` still null proves nothing has ever connected
// in. Those two facts together are the exact shape of a blocked inbound path,
// and neither of them asks the OS anything.
//
// SO IT IS A LAST RESORT, NOT A SECOND OPINION. It speaks only where a platform
// verdict said nothing: a read of the actual configuration beats an inference
// from silence every time, including when the read says the firewall is off and
// the silence has some other cause this cannot name.

/** How long this deck has to have been listening — hearing other machines and
 *  receiving nothing — before the silence is worth reporting.
 *
 *  Deliberately many times over the interval anything would have dialled on: a
 *  paired deck runs a round every SYNC_MS (60s) and a stranger that hears this
 *  one asks within ASKING_MS (8s), autoAsk being on by default. Five minutes is
 *  therefore dozens of missed chances rather than one — and the cost of getting
 *  this wrong is telling somebody their network is broken when it is quiet. */
export const QUIET_MS = 5 * 60_000;

/**
 * The verdict for a machine this file cannot read: measured, never read.
 *
 * WHAT IT REFUSES TO SAY. It names no firewall and offers no command, because
 * it looked at no configuration and would be guessing at both. Everything it
 * has is in the one sentence it returns, and the ways out the panel draws under
 * it need no rule on this machine at all.
 */
export function silentInbound({ heard = 0, listeningSince = null, inbound = null, now = Date.now() } = {}) {
  // Something got in, so the path is open — the same measurement that outranks
  // a configuration read everywhere else in this file.
  if (inbound) return null;
  // Nobody is out there. "Nothing has arrived" and "nothing can arrive" are the
  // two facts this whole module exists to tell apart, and with no beacon in
  // hand this one is the first.
  if (!heard) return null;
  if (!listeningSince) return null;
  const listening = now - listeningSince;
  if (listening < QUIET_MS) return null;
  const mins = Math.round(listening / 60_000);
  return {
    blocked: true,
    why: "heard them, nothing got in",
    category: "",
    alias: "",
    text: `This deck hears ${heard === 1 ? "another deck" : `${heard} other decks`} on the network and, in the ${mins} minutes it has been listening, nothing has ever connected to it — which is what a blocked inbound path looks like from this side. This machine cannot be asked which firewall it runs, so there is no line to paste.`,
  };
}

export function workaround(blocked) {
  if (!blocked) return null;
  return {
    dial: "This deck can still reach out, and one connection is all a round needs.",
    invite: "Ask them to make the invite and paste it here — an invite is dialled by whoever pastes it, so it has to be pasted on this machine rather than made on it.",
    address: "Or type their address below, and this deck will call them.",
  };
}
