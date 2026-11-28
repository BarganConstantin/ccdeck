// A stand-in for the system `ssh`, for the device tests. No network, no keys:
// every machine it "reaches" is a line in a scenario file, and every call it
// gets is written down so a test can read back exactly what the deck ran.
//
// Everything lives under the directory FAKE_SSH_DIR names:
//
//   scenario.json   { hosts: { <destination>: Host } }
//   calls.jsonl     one line per run: { argv, env: { LC_ALL, SSH_ASKPASS_REQUIRE } }
//   home/.ssh/known_hosts   the "user's" known_hosts, the file `-G` reports
//
// Host: {
//   net:     "ok" | "refused" | "dns" | "hang" | "noroute"   (default ok)
//   key:     base64 host key blob (ssh-ed25519)
//   auth:    "ok" | "denied"                                  (default ok)
//   ccdeck:  null (not installed) | { version, path: "plain" | "posix", deck: bool, sessions: [...], raw?: string }
// }
//
// Run by node: `node fake-ssh.mjs <ssh arguments>`, or through a `ssh` shim on
// PATH that does the same.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const dir = process.env.FAKE_SSH_DIR;
if (!dir) { process.stderr.write("fake-ssh: FAKE_SSH_DIR is not set\n"); process.exit(254); }
const argv = process.argv.slice(2);
appendFileSync(join(dir, "calls.jsonl"), JSON.stringify({
  argv, env: { LC_ALL: process.env.LC_ALL ?? null, SSH_ASKPASS_REQUIRE: process.env.SSH_ASKPASS_REQUIRE ?? null },
}) + "\n");

// ── the command line, the way ssh's getopt reads it ─────────────────────────
const WITH_VALUE = new Set(["-o", "-S", "-l", "-p", "-O", "-F", "-i", "-J", "-E"]);
const opts = {};
const flags = new Set();
let socket = null, user = null, port = null, control = null;
let i = 0;
for (; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--") { i++; break; }
  if (!a.startsWith("-")) break;
  if (WITH_VALUE.has(a)) {
    const v = argv[++i];
    if (a === "-o") { const eq = v.indexOf("="); opts[v.slice(0, eq).toLowerCase()] = v.slice(eq + 1); }
    else if (a === "-S") socket = v;
    else if (a === "-l") user = v;
    else if (a === "-p") port = v;
    else if (a === "-O") control = v;
    continue;
  }
  flags.add(a);
}
const dest = argv[i];
const command = argv.slice(i + 1).join(" ");
if (!dest) { process.stderr.write("usage: ssh destination\n"); process.exit(255); }
if (dest.startsWith("-")) { process.stderr.write("hostname contains invalid characters\n"); process.exit(255); }

const scenario = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8"));
const host = scenario.hosts?.[dest] ?? { net: "dns" };
const userKnownHosts = join(dir, "home", ".ssh", "known_hosts");
const fail = (text, code = 255) => { process.stderr.write(text.endsWith("\n") ? text : `${text}\n`); process.exit(code); };

// `ssh -G`: what the configuration resolves the destination to.
if (flags.has("-G")) {
  process.stdout.write([
    `user ${user ?? "me"}`, `hostname ${dest}`, `port ${port ?? 22}`,
    `userknownhostsfile ${userKnownHosts} ${userKnownHosts}2`, "",
  ].join("\n"));
  process.exit(0);
}

// `ssh -O exit`: tell a master on a socket to go.
if (control) {
  if (socket && existsSync(socket)) { rmSync(socket, { force: true }); process.exit(0); }
  fail(`Control socket connect(${socket}): No such file or directory`);
}

// Through a live master, nothing about the network or the key is asked again.
const viaMaster = socket && !flags.has("-M") && existsSync(socket);

let hung = false;
if (!viaMaster) {
  const net = host.net ?? "ok";
  if (net === "dns") fail(`ssh: Could not resolve hostname ${dest}: Name or service not known`);
  if (net === "refused") fail(`ssh: connect to host ${dest} port ${port ?? 22}: Connection refused`);
  if (net === "noroute") fail(`ssh: connect to host ${dest} port ${port ?? 22}: No route to host`);
  if (net === "hang") { hung = true; setInterval(() => {}, 1 << 30); }
  else checkHostKey();
}

function checkHostKey() {
  const name = port && port !== "22" ? `[${dest}]:${port}` : dest;
  const file = opts.userknownhostsfile ? opts.userknownhostsfile.replace(/^"|"$/g, "") : userKnownHosts;
  const lines = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/) : [];
  const known = lines.map(l => l.trim().split(/\s+/)).filter(f => f[0] === name);
  const strict = opts.stricthostkeychecking;
  if (known.length && !known.some(f => f[2] === host.key)) {
    fail([
      "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@",
      "@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @",
      "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@",
      "The fingerprint for the ED25519 key sent by the remote host is",
      `${host.fingerprint ?? "SHA256:unknown"}.`,
      `Host key for ${name} has changed and you have requested strict checking.`,
      "Host key verification failed.",
    ].join("\n"));
  }
  if (!known.length) {
    if (strict === "accept-new") {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${name} ssh-ed25519 ${host.key}\n`);
    } else {
      fail(`No ED25519 host key is known for ${name} and you have requested strict checking.\nHost key verification failed.`);
    }
  }
  // Every way of authenticating switched off: how the deck's learning run ends.
  if (opts.pubkeyauthentication === "no") fail(`${user ?? "me"}@${dest}: Permission denied (publickey).`);
  if ((host.auth ?? "ok") === "denied") fail(`${user ?? "me"}@${dest}: Permission denied (publickey).`);
}

// A master: hold the socket until told to stop.
if (hung) { /* never answers */ }
else if (flags.has("-M")) {
  writeFileSync(socket, "");
  const stop = () => { rmSync(socket, { force: true }); process.exit(0); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  setInterval(() => {}, 1 << 30);
} else {
  runRemote(command);
}

function runRemote(cmd) {
  if (cmd === "exit") process.exit(0);
  const ccdeck = host.ccdeck ?? null;
  const posix = cmd.startsWith("sh -c '");
  const verb = cmd.endsWith(" sessions --json") ? "sessions" : cmd.endsWith(" --version") ? "version" : null;
  const known = cmd === "ccdeck --version" || cmd === "ccdeck sessions --json"
    || (posix && /' ccdeck (--version|sessions --json)$/.test(cmd));
  if (!known || !verb) fail(`fake-ssh: unexpected remote command: ${cmd}`, 99);
  const found = ccdeck && (posix || (ccdeck.path ?? "plain") === "plain");
  if (!found) fail(posix ? "" : "bash: line 1: ccdeck: command not found", 127);
  if (verb === "version") { process.stdout.write(`${ccdeck.version}\n`); process.exit(0); }
  if (ccdeck.raw !== undefined) { process.stdout.write(ccdeck.raw); process.exit(ccdeck.rawCode ?? 0); }
  if (!ccdeck.deck) {
    process.stdout.write(JSON.stringify({ schemaVersion: 1, ok: false, error: { code: "no_deck", message: "no deck is running" } }) + "\n");
    process.exit(3);
  }
  process.stdout.write(JSON.stringify({ schemaVersion: 1, ok: true, deck: { port: 4317, version: ccdeck.deckVersion ?? ccdeck.version }, sessions: ccdeck.sessions ?? [] }) + "\n");
  process.exit(0);
}
