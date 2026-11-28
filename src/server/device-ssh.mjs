// How the deck talks to another machine: the system's own `ssh`, an argument
// vector this file builds, and a reading of what ssh says when it fails.
//
// THE SYSTEM SSH, NOT A LIBRARY. It is the only client that reads the user's
// ~/.ssh/config (aliases, jump hosts, certificates, per-host keys) and talks
// to their SSH agent, and the only one whose host-key store is the one they
// already trust. The deck never holds a private key or a password: ssh gets
// its credentials where it always does, and BatchMode means that when it has
// none it fails instead of asking.
//
// NO SHELL ON THIS MACHINE. ssh is spawned from an argument vector with
// `shell: false`. On the far side ssh hands the remote command to the user's
// login shell, and nothing can change that — so the remote command is always
// one of the constants in device-remote.mjs, never built from anything a
// request carried. Every value a request does carry (host, user, port, alias)
// is held to device-input.mjs's shapes and lands in this vector as its own
// entry, after `--`.
//
// WHAT THE OPTIONS PIN, whatever the user's configuration says, because the
// command line wins over ~/.ssh/config:
//
//   BatchMode=yes            never a prompt; no password, no passphrase
//   StrictHostKeyChecking    yes: an unknown or changed key is a failure the
//                            deck reports, never a key added on the quiet
//   UpdateHostKeys=no        nothing written to known_hosts unasked
//   ClearAllForwardings      a LocalForward in the config opens no port here
//   ForwardAgent=no, -a      the agent never travels to the device
//   ForwardX11=no, -x        nor the display
//   PermitLocalCommand=no    no LocalCommand runs on this machine
//   RequestTTY=no, -T        a pipe, not a terminal
//   ControlMaster/Path       the deck's own connection reuse or none — never
//                            a ControlPersist master from the user's config,
//                            which would fork away holding this process's pipes
//   LogLevel=ERROR           the lines classifySsh reads, and not the rest
//
// The locale is C for the child, so the messages classifySsh matches are the
// English ones whatever language the machine speaks.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { killTree } from "./exec.mjs";
import { watchChild } from "./exec-children.mjs";

/** Seconds ssh waits for a TCP connection before it gives up on its own. */
export const CONNECT_TIMEOUT_S = 8;

const FIXED = Object.freeze([
  "-T", "-x", "-a",
  "-o", "BatchMode=yes",
  "-o", `ConnectTimeout=${CONNECT_TIMEOUT_S}`,
  "-o", "ClearAllForwardings=yes",
  "-o", "ForwardAgent=no",
  "-o", "ForwardX11=no",
  "-o", "PermitLocalCommand=no",
  "-o", "RequestTTY=no",
  "-o", "UpdateHostKeys=no",
  "-o", "LogLevel=ERROR",
  "-o", "ServerAliveInterval=10",
  "-o", "ServerAliveCountMax=3",
]);

/** The options every connection the deck opens carries. */
export const SSH_FIXED_OPTIONS = FIXED;

/** The destination, as the tail of the vector: always after `--`. */
export function destinationArgs(device) {
  if (device?.alias) return ["--", device.alias];
  const port = device?.port ? ["-p", String(device.port)] : [];
  return ["-l", device.user, ...port, "--", device.host];
}

/**
 * A value for an ssh option that names a file. ssh splits such values on
 * whitespace and honours double quotes, so a path with a space in it — any
 * Windows profile named for a person — is quoted. A path with a double quote
 * or a line break cannot be said at all, and is refused rather than guessed.
 */
export function sshPathValue(path) {
  const p = String(path ?? "");
  if (p === "" || /["\r\n]/.test(p)) return null;
  return /\s/.test(p) ? `"${p}"` : p;
}

/**
 * The whole vector for one ssh run.
 *
 *   mode "master"   keep a connection open for reuse: -M -N on `control`
 *   mode "exec"     run `command`, through `control` when there is one
 *   mode "learn"    connect, record the host key into `knownHosts`, and stop
 *                   before authenticating (every method off)
 *
 * `extra` goes before the destination; it is how a test hands ssh a config
 * file of its own, and nothing a request carries reaches it.
 */
export function sshArgs(device, { mode = "exec", control = null, command = null, knownHosts = null, extra = [] } = {}) {
  const args = [...FIXED];
  if (mode === "learn") {
    const file = sshPathValue(knownHosts);
    if (!file) throw new Error("learn needs a known-hosts file ssh can be told about");
    args.push(
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", `UserKnownHostsFile=${file}`,
      "-o", "PubkeyAuthentication=no",
      "-o", "PasswordAuthentication=no",
      "-o", "KbdInteractiveAuthentication=no",
      "-o", "HostbasedAuthentication=no",
      "-o", "GSSAPIAuthentication=no",
      "-o", "ControlMaster=no",
      "-o", "ControlPath=none",
    );
  } else {
    args.push("-o", "StrictHostKeyChecking=yes");
    if (mode === "master") {
      if (!control) throw new Error("a master needs a control path");
      args.push("-M", "-N", "-S", control, "-o", "ControlMaster=yes", "-o", "ControlPersist=no");
    } else if (control) {
      args.push("-S", control, "-o", "ControlMaster=no");
    } else {
      args.push("-o", "ControlMaster=no", "-o", "ControlPath=none");
    }
  }
  args.push(...extra, ...destinationArgs(device));
  // `exit` for the learning run: if a server lets the client in with no
  // authentication at all, the session it opens does nothing and ends.
  if (mode === "learn") args.push("exit");
  else if (mode === "exec") {
    if (typeof command !== "string" || command === "") throw new Error("exec needs a command");
    args.push(command);
  }
  return args;
}

/** The vector for `ssh -G`: what the user's configuration resolves a device
 *  to, without connecting. */
export function sshConfigArgs(device, { extra = [] } = {}) {
  return ["-G", "-T", ...extra, ...destinationArgs(device)];
}

/** The child's environment: the deck's, in the C locale, with no askpass. */
export function sshEnv(env = process.env) {
  return { ...env, LC_ALL: "C", LANG: "C", SSH_ASKPASS_REQUIRE: "never" };
}

/**
 * Start ssh. `bin` is the program (`ssh`, found on PATH the way the user's own
 * terminal finds it); `prefix` goes before the arguments, for a stand-in that
 * is a script run by node. Watched, so a deck that shuts down takes it with it.
 */
export function spawnSsh(args, { bin = "ssh", prefix = [], env = process.env, spawnImpl = spawn, stdio = ["ignore", "pipe", "pipe"] } = {}) {
  const posix = process.platform !== "win32";
  const child = spawnImpl(bin, [...prefix, ...args], {
    stdio, env: sshEnv(env), shell: false, windowsHide: true, detached: posix,
  });
  return watchChild(child, { processGroup: posix });
}

/**
 * Run ssh to the end: `{ code, signal, stdout, stderr, timedOut, missing }`.
 * Never rejects. Output past `maxOut` bytes is cut and the child stopped; a run
 * past `timeoutMs` is stopped and answers `timedOut`. `missing` is an ssh this
 * machine does not have.
 */
export function runSsh(args, { timeoutMs = 20_000, maxOut = 1 << 20, maxErr = 16 << 10, ...spawnOpts } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnSsh(args, spawnOpts);
    } catch (err) {
      resolve({ code: null, signal: null, stdout: "", stderr: "", timedOut: false, missing: err?.code === "ENOENT" });
      return;
    }
    const out = { stdout: [], stderr: [] };
    const size = { stdout: 0, stderr: 0 };
    const cap = { stdout: maxOut, stderr: maxErr };
    let timedOut = false, overflow = false, settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(out.stdout).toString("utf8"),
        stderr: Buffer.concat(out.stderr).toString("utf8"),
        timedOut, overflow, missing: false, ...result,
      });
    };
    for (const name of ["stdout", "stderr"]) {
      child[name]?.on("data", (chunk) => {
        const room = cap[name] - size[name];
        if (room > 0) out[name].push(chunk.subarray(0, room));
        size[name] += chunk.length;
        if (size[name] > cap[name] && name === "stdout" && !overflow) {
          overflow = true;
          killTree(child, "SIGTERM");
        }
      });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, "SIGTERM");
    }, timeoutMs);
    timer.unref?.();
    child.on("error", (err) => finish({ code: null, signal: null, missing: err?.code === "ENOENT" }));
    child.on("close", (code, signal) => finish({ code, signal }));
  });
}

// ── what ssh said ───────────────────────────────────────────────────────────

const CHANGED = /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key for \S+ has changed/i;
const UNKNOWN = /No \S+ host key is known for|Host key verification failed/i;
const AUTH = /Permission denied \(|Too many authentication failures|No supported authentication methods available/i;
const UNREACHABLE = [
  ["dns", /Could not resolve hostname|Name or service not known|nodename nor servname|No address associated with hostname|Temporary failure in name resolution/i],
  ["refused", /Connection refused/i],
  ["timeout", /Connection timed out|Operation timed out|timed out during banner exchange/i],
  ["network", /No route to host|Network is unreachable|Host is down|Network is down/i],
  ["closed", /Connection closed by|Connection reset by|kex_exchange_identification|Broken pipe/i],
];

/** One line of ssh's own words, for a failure nothing above recognised:
 *  printable, trimmed, and short. */
export function sshDetail(stderr) {
  const line = String(stderr ?? "").split(/\r?\n/).map(l => l.trim()).find(Boolean) ?? "";
  return line.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 300);
}

/**
 * What went wrong with ssh itself, or null when ssh connected and the remote
 * command ran (whatever it then answered). One of:
 *
 *   { type: "ssh_missing" }
 *   { type: "host_key_changed", fingerprint }
 *   { type: "host_key_unknown" }
 *   { type: "auth_failed" }
 *   { type: "unreachable", detail: dns | refused | timeout | network | closed }
 *   { type: "failed", detail }       ssh failed in a way none of these name
 *
 * ssh exits 255 for its own failures and with the remote command's status
 * otherwise; a run the deck stopped on its deadline is unreachable/timeout.
 */
export function classifySsh({ code, stderr, timedOut, missing } = {}) {
  if (missing) return { type: "ssh_missing" };
  if (timedOut) return { type: "unreachable", detail: "timeout" };
  // Anything else is the remote command's own status, and its stderr is the
  // remote program's words, which are not read for ssh's.
  if (code !== 255) return null;
  const text = String(stderr ?? "");
  if (CHANGED.test(text)) {
    return { type: "host_key_changed", fingerprint: /SHA256:[A-Za-z0-9+/]{43}/.exec(text)?.[0] ?? null };
  }
  if (UNKNOWN.test(text)) return { type: "host_key_unknown" };
  if (AUTH.test(text)) return { type: "auth_failed" };
  for (const [detail, re] of UNREACHABLE) if (re.test(text)) return { type: "unreachable", detail };
  return { type: "failed", detail: sshDetail(text) };
}

// ── host keys ───────────────────────────────────────────────────────────────

const KEY_TYPE = /^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
// A known_hosts host field as ssh writes one: a name or an address, maybe in
// `[host]:port` form, maybe a comma list, maybe hashed (`|1|salt|hash`). No
// pattern characters, no marker, no whitespace.
const HOSTS = /^[A-Za-z0-9._:[\]|+/=,-]{1,1024}$/;

/** `SHA256:…`, the fingerprint ssh prints for a key, from its base64 blob. */
export function fingerprintOf(blob) {
  const digest = createHash("sha256").update(Buffer.from(String(blob), "base64")).digest("base64");
  return `SHA256:${digest.replace(/=+$/, "")}`;
}

/**
 * The host keys in a known_hosts text ssh wrote, each rebuilt from its three
 * fields: `{ line, keyType, fingerprint }`. A line that is not exactly a host
 * field, a key type and a key whose blob names that type is dropped, so what
 * the deck later appends is a line of its own making, never bytes it copied.
 */
export function parseHostKeys(text, { max = 8 } = {}) {
  const keys = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith("@")) continue;
    const [hosts, keyType, blob] = line.split(/\s+/);
    if (!HOSTS.test(hosts ?? "") || !KEY_TYPE.test(keyType ?? "") || !BASE64.test(blob ?? "")) continue;
    // The blob begins with its own type, length-prefixed: a key that says it
    // is something else is not the key the line claims.
    const bytes = Buffer.from(blob, "base64");
    if (bytes.length < 4 + keyType.length) continue;
    const named = bytes.readUInt32BE(0);
    if (named !== keyType.length || bytes.subarray(4, 4 + named).toString("latin1") !== keyType) continue;
    keys.push({ line: `${hosts} ${keyType} ${blob}`, keyType, fingerprint: fingerprintOf(blob) });
    if (keys.length >= max) break;
  }
  return keys;
}

/**
 * What `ssh -G` printed, as the few settings the deck reads: the host name and
 * port ssh will dial, the user, and the first known_hosts file — the one ssh
 * itself adds a key to when somebody answers its "yes".
 */
export function parseSshConfig(text) {
  const out = { hostname: null, port: null, user: null, knownHosts: null };
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = /^(\S+)\s+(.*)$/.exec(line.trim());
    if (!m) continue;
    const [, key, value] = m;
    if (key === "hostname") out.hostname = value;
    else if (key === "port") out.port = Number(value) || null;
    else if (key === "user") out.user = value;
    else if (key === "userknownhostsfile") out.knownHosts = firstPath(value);
  }
  return out;
}

/** The first entry of a whitespace-separated, maybe double-quoted list. */
function firstPath(value) {
  const v = value.trim();
  if (v.startsWith("\"")) {
    const end = v.indexOf("\"", 1);
    return end > 1 ? v.slice(1, end) : null;
  }
  return v.split(/\s+/)[0] || null;
}
