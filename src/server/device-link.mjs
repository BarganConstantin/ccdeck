// The deck's connections to its devices: one SSH connection kept open per
// device and reused, the test a device has to pass, its sessions, and the
// host-key confirmation.
//
// ONE CONNECTION, MANY QUESTIONS. On macOS and Linux each device gets an ssh
// master (`-M -N`) on a control socket in a private folder, and every command
// after it rides that connection: one handshake, then each question costs a
// channel. The master is a child of this deck, not a ControlPersist daemon —
// so it dies with the deck, a Disconnect is a kill, and "connected" is simply
// "its socket is there and it has not exited". It is dropped after LINK_IDLE_MS
// unused. Windows' OpenSSH has no connection sharing, so there every command
// connects on its own and the device's state is its last answer.
//
// THE CONTROL FOLDER IS THIS USER'S ALONE: the runtime folder, else one under
// the temporary folder, made 0700 and refused unless it is a real directory
// owned by this uid with no bits for anyone else. A folder somebody else made
// first is not used — the deck goes without connection sharing rather than put
// a socket that carries an authenticated session where another account can
// reach it. Socket names carry this deck's own prefix, so a second deck with
// another data folder never sweeps or reuses this one's.
//
// A HOST KEY IS NEVER TRUSTED ON THE QUIET. Every connection runs with strict
// checking. An unknown key ends the test with the key's fingerprint, read by
// letting ssh connect once into a throwaway known_hosts file with every way
// of authenticating switched off — through the user's own configuration, so a
// jump host or a HostKeyAlias is honoured exactly as it will be later. Only
// when the page sends back the single-use `confirm` it was handed is that very
// key (not a fresh scan) appended to the known_hosts file ssh itself writes
// to. A changed key is a hard stop: nothing here removes or replaces a key.
//
// NOTHING ON THE DEVICE IS STARTED. The remote commands are the read-only ones
// in device-remote.mjs; a deck that is not running there is reported, never
// started from here.
import { createHash, randomBytes } from "node:crypto";
import { appendFile, lstat, mkdir, mkdtemp, readdir, readFile, rm, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { deckDataDir } from "./deck-home.mjs";
import { destinationKey } from "./device-input.mjs";
import {
  LAUNCH_ORDER, REMOTE_MIN_VERSION, parseRemoteVersion, readSessionsAnswer, remoteCommand, remoteMissing, remoteSessions, tooOld,
} from "./device-remote.mjs";
import {
  CONNECT_TIMEOUT_S, classifySsh, parseHostKeys, parseSshConfig, runSsh, spawnSsh, sshArgs, sshConfigArgs, sshDetail,
} from "./device-ssh.mjs";
import { deviceStore } from "./device-store.mjs";
import { killTree } from "./exec.mjs";

/** How long a connection nobody uses stays open. */
export const LINK_IDLE_MS = 10 * 60_000;
/** The same, for a device that was only tested and never saved. */
export const DRAFT_IDLE_MS = 60_000;
/** How long a connection may take to come up: ssh's own connect timeout, and
 *  room for a jump host and the handshake. */
export const CONNECT_MS = (CONNECT_TIMEOUT_S + 7) * 1000;
/** How long one remote command may run: node starting on a small machine, and
 *  nvm loading before it. */
export const EXEC_MS = 20_000;
/** How long a fingerprint the page was shown can still be confirmed. */
export const TRUST_TTL_MS = 5 * 60_000;
/** The most confirmations waiting at once; the oldest goes first. */
export const MAX_PENDING_TRUST = 16;
/** The most ssh processes running at once, across every device. */
export const MAX_SSH = 6;
/** The most bytes a sessions answer may be. */
export const SESSIONS_MAX_BYTES = 2 << 20;

// The shorter of the two socket-path limits (macOS: 104 bytes with the NUL),
// and what ssh adds while it binds: `<path>.<16 random characters>`.
const SUN_PATH_MAX = 103;
const SSH_BIND_SUFFIX = 17;
const SOCKET = /^[0-9a-f]{16}$/;

const hex = (text) => createHash("sha256").update(text).digest("hex");

/** Whether a path names something, without following or throwing. */
const exists = (path) => lstat(path).then(() => true, () => false);

/**
 * The folder this deck keeps its control sockets in, or null when there is no
 * folder it can trust (and so no connection sharing). Never on Windows.
 */
export async function privateControlDir({
  platform = process.platform, env = process.env, tmp = tmpdir(), uid = process.getuid?.(),
} = {}) {
  if (platform === "win32" || !Number.isInteger(uid)) return null;
  const candidates = [];
  if (env.XDG_RUNTIME_DIR && isAbsolute(env.XDG_RUNTIME_DIR)) candidates.push(join(env.XDG_RUNTIME_DIR, "ccdeck-ssh"));
  candidates.push(join(tmp, `ccdeck-ssh-${uid}`));
  for (const dir of candidates) {
    // ssh splits option values on whitespace; and the socket path has to fit.
    if (/\s/.test(dir) || dir.length + 1 + 16 + SSH_BIND_SUFFIX > SUN_PATH_MAX) continue;
    try { await mkdir(dir, { mode: 0o700 }); }
    catch (err) { if (err?.code !== "EEXIST") continue; }
    const st = await lstat(dir).catch(() => null);
    if (!st || st.isSymbolicLink() || !st.isDirectory() || st.uid !== uid || (st.mode & 0o077) !== 0) continue;
    return dir;
  }
  return null;
}

/**
 * Append host keys to a known_hosts file the way ssh does when somebody
 * answers its "yes": the folder made 0700 when missing, the file 0600 when
 * new, a line already there not written twice.
 */
export async function appendKnownHosts(file, lines) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  let existing = "";
  try { existing = await readFile(file, "utf8"); }
  catch (err) { if (err?.code !== "ENOENT") throw err; }
  const have = new Set(existing.split(/\r?\n/).map(l => l.trim()));
  const fresh = lines.filter(line => !have.has(line));
  if (!fresh.length) return 0;
  const lead = existing !== "" && !existing.endsWith("\n") ? "\n" : "";
  await appendFile(file, `${lead}${fresh.join("\n")}\n`, { mode: 0o600 });
  return fresh.length;
}

export function createDeviceLinks({
  store = deviceStore,
  bin = "ssh",
  prefix = [],
  extra = [],
  env = process.env,
  spawnImpl,
  controlDir = () => privateControlDir(),
  namespace = () => hex(deckDataDir()).slice(0, 6),
  home = homedir,
  now = Date.now,
  idleMs = LINK_IDLE_MS,
  connectMs = CONNECT_MS,
  execMs = EXEC_MS,
} = {}) {
  const sshOpts = { bin, prefix, env, ...(spawnImpl ? { spawnImpl } : {}) };
  const links = new Map();
  const trusts = new Map();
  const inflight = new Map();
  let ns = null;
  let dirReady = null;

  // ── ssh, bounded ──────────────────────────────────────────────────────────
  let running = 0;
  const queue = [];
  async function ssh(args, opts) {
    while (running >= MAX_SSH) await new Promise(r => queue.push(r));
    running++;
    try { return await runSsh(args, { ...sshOpts, ...opts }); }
    finally { running--; queue.shift()?.(); }
  }

  /** The control folder, resolved once; its leftovers swept the first time. */
  function control() {
    dirReady ??= (async () => {
      ns = namespace();
      const dir = await controlDir();
      if (dir) await sweep(dir);
      return dir;
    })().catch(() => null);
    return dirReady;
  }

  /** Sockets of this deck's that an earlier run left: a master orphaned by a
   *  deck that was killed is told to exit, and the name is removed. */
  async function sweep(dir) {
    const names = await readdir(dir).catch(() => []);
    for (const name of names) {
      if (!SOCKET.test(name) || !name.startsWith(ns)) continue;
      const path = join(dir, name);
      await ssh(["-S", path, "-O", "exit", "--", "ccdeck-sweep"], { timeoutMs: 3_000, maxOut: 1024 });
      await unlink(path).catch(() => {});
    }
  }

  // ── one link per destination ──────────────────────────────────────────────
  function linkOf(device) {
    const key = hex(destinationKey(device)).slice(0, 10);
    let link = links.get(key);
    if (!link) {
      link = { key, state: "offline", master: null, path: null, opening: null, idle: null, idleMs, last: null, checkedAt: null, version: null, launcher: null };
      links.set(key, link);
    }
    return link;
  }

  function touch(link) {
    clearTimeout(link.idle);
    link.idle = setTimeout(() => drop(link), link.idleMs);
    link.idle.unref?.();
  }

  function drop(link) {
    clearTimeout(link.idle);
    link.idle = null;
    const master = link.master;
    link.master = null;
    link.version = null;
    link.launcher = null;
    if (master) killTree(master, "SIGTERM");
    if (link.state !== "offline") link.state = "offline";
  }

  /** `{ type: "ok", shared }` once there is a way to reach the device, or the
   *  typed failure of the master that could not come up. */
  async function connect(device) {
    const link = linkOf(device);
    const dir = await control();
    const path = dir ? join(dir, `${ns}${link.key}`) : null;
    if (!path || path.length + SSH_BIND_SUFFIX > SUN_PATH_MAX) return { type: "ok", shared: false };
    if (link.master && link.state === "connected" && await exists(path)) {
      touch(link);
      return { type: "ok", shared: true };
    }
    link.opening ??= openMaster(device, link, path).finally(() => { link.opening = null; });
    return link.opening;
  }

  async function openMaster(device, link, path) {
    if (link.master) drop(link);
    // A socket a killed master left behind would read as ready; the folder is
    // this user's alone, so whatever is at this name is ours to remove.
    await unlink(path).catch(() => {});
    link.state = "connecting";
    let child;
    try {
      child = spawnSsh(sshArgs(device, { mode: "master", control: path, extra }), { ...sshOpts, stdio: ["ignore", "ignore", "pipe"] });
    } catch (err) {
      link.state = "offline";
      return err?.code === "ENOENT" ? { type: "ssh_missing" } : { type: "failed", detail: sshDetail(err?.message) };
    }
    link.master = child;
    link.path = path;
    let stderr = "";
    child.stderr?.on("data", chunk => { if (stderr.length < 16_384) stderr += chunk; });

    return new Promise(resolve => {
      let settled = false, looking = false;
      const settle = (result) => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        clearTimeout(deadline);
        resolve(result);
      };
      const poll = setInterval(async () => {
        if (looking || settled) return;
        looking = true;
        const up = await exists(path);
        looking = false;
        if (!up || settled || link.master !== child) return;
        link.state = "connected";
        touch(link);
        settle({ type: "ok", shared: true });
      }, 50);
      poll.unref?.();
      const deadline = setTimeout(() => {
        if (link.master === child) drop(link);
        settle({ type: "unreachable", detail: "timeout" });
      }, connectMs);
      deadline.unref?.();
      child.on("error", err => {
        if (link.master === child) { link.master = null; link.state = "offline"; }
        settle(err?.code === "ENOENT" ? { type: "ssh_missing" } : { type: "failed", detail: sshDetail(err?.message) });
      });
      child.on("close", code => {
        if (link.master === child) {
          link.master = null;
          link.version = null;
          link.launcher = null;
          link.state = "offline";
          clearTimeout(link.idle);
        }
        settle(classifySsh({ code: code ?? 255, stderr }) ?? { type: "unreachable", detail: "closed" });
      });
    });
  }

  /** Run one remote command, through the device's master when it has one. */
  async function exec(device, command, { maxOut = 4096 } = {}) {
    const link = linkOf(device);
    const shared = link.master && link.state === "connected" ? link.path : null;
    const result = await ssh(sshArgs(device, { mode: "exec", control: shared, command, extra }), { timeoutMs: execMs, maxOut });
    if (shared && link.master) touch(link);
    return result;
  }

  // ── host keys ─────────────────────────────────────────────────────────────

  function sweepTrusts() {
    const t = now();
    for (const [confirm, entry] of trusts) if (entry.expires <= t) trusts.delete(confirm);
  }

  /** The key the device presents, read without authenticating, and a
   *  single-use confirmation for it — or the failure that stopped the read. */
  async function learn(device) {
    let dir = null;
    try {
      dir = await mkdtemp(join(tmpdir(), "ccdeck-hostkey-"));
      const file = join(dir, "known_hosts");
      let args;
      try { args = sshArgs(device, { mode: "learn", knownHosts: file, extra }); }
      catch { return { type: "host_key_unknown", keys: [], confirm: null }; }
      const r = await ssh(args, { timeoutMs: connectMs, maxOut: 4096 });
      const keys = parseHostKeys(await readFile(file, "utf8").catch(() => ""));
      if (!keys.length) {
        // Refused authentication is how a learning run is meant to end.
        const failure = classifySsh(r);
        return failure && failure.type !== "auth_failed" ? failure : { type: "host_key_unknown", keys: [], confirm: null };
      }
      sweepTrusts();
      while (trusts.size >= MAX_PENDING_TRUST) trusts.delete(trusts.keys().next().value);
      const confirm = randomBytes(24).toString("base64url");
      trusts.set(confirm, { device: { ...device }, keys, expires: now() + TRUST_TTL_MS });
      return { type: "host_key_unknown", keys: keys.map(({ keyType, fingerprint }) => ({ keyType, fingerprint })), confirm };
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** A failure, with the fingerprint attached when it is an unknown host key. */
  const withHostKey = (failure, device) => (failure.type === "host_key_unknown" ? learn(device) : failure);

  /** The known_hosts file ssh adds keys to for this device, from `ssh -G`. */
  async function knownHostsFile(device) {
    const r = await ssh(sshConfigArgs(device, { extra }), { timeoutMs: 5_000, maxOut: 64 << 10 });
    if (r.code !== 0) return null;
    let file = parseSshConfig(r.stdout).knownHosts;
    if (!file || file === "none") return null;
    if (file === "~" || file.startsWith("~/") || file.startsWith("~\\")) file = join(home(), file.slice(2));
    return isAbsolute(file) && !/[\r\n]/.test(file) ? file : null;
  }

  // ── what a device answers ─────────────────────────────────────────────────

  /** Which ccdeck the device has and how it is started there. */
  async function remoteVersion(device, link) {
    if (link.master && link.version && link.launcher) {
      // Learned while the device was a draft, before it had a record to keep it on.
      if (device.id && device.launcher !== link.launcher) await store.setLauncher(device.id, link.launcher).catch(() => {});
      return { type: "ok", version: link.version, launcher: link.launcher };
    }
    const order = device.launcher ? [device.launcher, ...LAUNCH_ORDER.filter(l => l !== device.launcher)] : LAUNCH_ORDER;
    for (const launcher of order) {
      const r = await exec(device, remoteCommand(launcher, "version"));
      const failure = classifySsh(r);
      if (failure) return withHostKey(failure, device);
      if (remoteMissing(r)) continue;
      const version = parseRemoteVersion(r.stdout);
      if (!version) return { type: "no_remote_ccdeck", detail: "unrecognised" };
      if (tooOld(version)) return { type: "version_too_old", version, minimum: REMOTE_MIN_VERSION };
      if (link.master) { link.version = version; link.launcher = launcher; }
      if (device.id && device.launcher !== launcher) await store.setLauncher(device.id, launcher).catch(() => {});
      return { type: "ok", version, launcher };
    }
    return { type: "no_remote_ccdeck", detail: "not_installed" };
  }

  /** Connect, check the version, read the sessions: the typed failure of the
   *  first step that fails, or `{ type: "ok", version, deckVersion, remoteNow,
   *  sessions }` with the rows already read as another machine's. */
  async function readDevice(device) {
    const link = linkOf(device);
    // A device only being tested keeps its connection a minute, not ten: it is
    // either saved now, and asked again under its id, or not at all.
    link.idleMs = device.id ? idleMs : Math.min(idleMs, DRAFT_IDLE_MS);
    if (link.state !== "connected") link.state = "connecting";
    const result = await (async () => {
      const conn = await connect(device);
      if (conn.type !== "ok") return withHostKey(conn, device);
      const v = await remoteVersion(device, link);
      if (v.type !== "ok") return v;
      const r = await exec(device, remoteCommand(v.launcher, "sessions"), { maxOut: SESSIONS_MAX_BYTES });
      const failure = classifySsh(r);
      if (failure) return withHostKey(failure, device);
      const answer = readSessionsAnswer(r);
      if (!answer.ok) {
        return answer.reason === "no_deck"
          ? { type: "no_remote_ccdeck", detail: "not_running", version: v.version }
          : { type: "failed", detail: r.overflow ? "sessions_too_large" : "sessions_unreadable" };
      }
      return {
        type: "ok", version: v.version, deckVersion: answer.deckVersion, remoteNow: answer.remoteNow,
        sessions: remoteSessions(answer.rows, device),
      };
    })();
    link.last = result.type;
    link.checkedAt = now();
    if (!link.master) link.state = result.type === "ok" ? "connected" : "offline";
    return result;
  }

  /** One read per device at a time: a second caller shares the first's. Keyed
   *  by the record too, since the rows of a read carry the id they were read
   *  under, and a draft tested beside its saved twin has none. */
  function once(device, job) {
    const key = `${linkOf(device).key}:${device.id ?? ""}`;
    let p = inflight.get(key);
    if (!p) {
      p = job().finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    return p;
  }

  /** The test a device passes before it is saved, and again on demand. */
  async function check(device) {
    const r = await once(device, () => readDevice(device));
    // A draft that failed is not going to be saved as it is: nothing is kept open for it.
    if (r.type !== "ok" && !device.id) drop(linkOf(device));
    if (r.type !== "ok") return r;
    return { type: "ok", version: r.version, deckVersion: r.deckVersion, sessions: r.sessions.length };
  }

  return {
    check,

    /** The device's live sessions, each tied to it. */
    async sessions(device) {
      const r = await once(device, () => readDevice(device));
      if (r.type !== "ok") return r;
      return {
        type: "ok", device: { id: device.id ?? null, name: device.name },
        version: r.version, deckVersion: r.deckVersion, remoteNow: r.remoteNow, sessions: r.sessions,
      };
    },

    /** Trust the key a `host_key_unknown` answer showed, then test again. */
    async trust(confirm) {
      sweepTrusts();
      const entry = typeof confirm === "string" ? trusts.get(confirm) : null;
      if (!entry) return { type: "trust_expired" };
      trusts.delete(confirm);
      const file = await knownHostsFile(entry.device);
      if (!file) return { type: "failed", detail: "known_hosts_unavailable" };
      await appendKnownHosts(file, entry.keys.map(k => k.line));
      return check(entry.device);
    },

    /** Close the device's connection. Nothing runs on the device because of it. */
    disconnect(device) {
      drop(linkOf(device));
    },

    /** Close it and forget everything kept for it: on removal. */
    forget(device) {
      const link = linkOf(device);
      drop(link);
      links.delete(link.key);
      const key = destinationKey(device);
      for (const [confirm, entry] of trusts) if (destinationKey(entry.device) === key) trusts.delete(confirm);
    },

    /** What the page shows next to a device. */
    status(device) {
      const link = links.get(hex(destinationKey(device)).slice(0, 10));
      if (!link) return { state: "offline", checkedAt: null, last: null };
      const state = link.opening ? "connecting" : link.master && link.state === "connected" ? "connected" : link.state;
      return { state, checkedAt: link.checkedAt, last: link.last };
    },

    /** Close every connection: the deck is stopping. */
    closeAll() {
      for (const link of links.values()) drop(link);
    },
  };
}
