// Installing Claude Code from the deck, for the two places that find none: a
// session pane told `agent-missing`, and an Accounts sign-in whose `claude`
// could not be run. Both offer Install Claude Code, which is this.
//
//   GET  /api/claude-install   { ok, state: idle|running|done|failed, id?, reason?, detail?, command, blocked? }
//   POST /api/claude-install   start one: { ok: true, id }, or 409 { ok: false, code }
//
// THE OFFICIAL INSTALLER, AND NOTHING OF OUR OWN. What runs is the script
// Anthropic's setup page labels Recommended, the same one `command` names for
// people who would rather paste it into a terminal: install.sh through bash on
// macOS and Linux, install.ps1 through Windows PowerShell on Windows. It needs
// no administrator, and it puts `claude` in ~/.local/bin (claude.exe in
// %USERPROFILE%\.local\bin on Windows), the first place the deck's own list
// looks (claude-dir.mjs).
//
// DOWNLOADED, THEN RUN AS A FILE. https only, under a deadline and a size cap,
// into a 0600 file inside a fresh 0700 folder of its own, run as an argument
// vector and never through a shell string, and the folder removed afterwards
// whatever happened. Node's fetch goes first; when it cannot reach the script
// at all (an error, or an answer that is not ok), the system's curl tries once,
// into that same folder and under the same rules, because fetch ignores
// HTTPS_PROXY and the system's certificate store: behind a company proxy or TLS
// inspection it fails where the manual command's curl gets through.
//
// NOTHING OF IT IS LOGGED. Neither the script nor what it prints. The last few
// lines of its output are kept in memory for one reason, a failure's, and are
// shown only to the page that asked, with the home folder written as ~.
//
// DONE MEANS THE DECK CAN RUN IT. An installer that exits 0 is not enough: the
// install counts only when the deck's own resolver (claude-identity.mjs) now
// finds `claude`, the one the session pane and the sign-in will go on to run.
//
// ONE AT A TIME. The job is one value per deck that every tab reads; a second
// start while it runs is refused, and the outcome stays readable afterwards
// under the id it was started with, so a page shows only an outcome it watched.
//
// AGENTS_DECK_NO_INSTALL=1 and AGENTS_DECK_NO_DOWNLOAD=1 turn the download
// off, as they do for tmux and the engine: the status says so, and the page
// offers the command to run instead.
import { spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, win32 as winPath } from "node:path";
import { adminClaudeBin } from "./claude-identity.mjs";
import { killTree, watchChild } from "./exec-children.mjs";
import { pathLookup } from "./exec-spec.mjs";
import { readBody, send } from "./http-io.mjs";

export const CLAUDE_INSTALL_ROUTE = "/api/claude-install";

/** The script, as Anthropic publishes it for each platform. */
export const INSTALL_SCRIPTS = Object.freeze({
  posix: "https://claude.ai/install.sh",
  win32: "https://claude.ai/install.ps1",
});

/** The scripts are a few KB; anything near this is not one. */
export const INSTALL_SCRIPT_MAX = 1024 * 1024;
/** The script's download. */
export const DOWNLOAD_TIMEOUT_MS = 60_000;
/** The whole install: the installer fetches Claude Code itself, tens of MB. */
export const INSTALL_TIMEOUT_MS = 10 * 60_000;
/** How much of the installer's output a failure keeps. */
export const TAIL_LINES = 5;
/** And how much of it is held while it runs, from its end. */
const TAIL_BYTES = 8 * 1024;
/** A line of it, at most, as a failure shows it. */
const LINE_MAX = 240;
/** The requests carry no body worth reading; a small cap answers 413 above it. */
const BODY_LIMIT = 1024;

/** The manual command, the one Anthropic's setup page labels Recommended. */
export function claudeInstallCommand(platform = process.platform) {
  return platform === "win32"
    ? `irm ${INSTALL_SCRIPTS.win32} | iex`
    : `curl -fsSL ${INSTALL_SCRIPTS.posix} | bash`;
}

/** Why no download may start here, or null. */
export function claudeInstallBlocked(env = process.env) {
  return env.AGENTS_DECK_NO_INSTALL === "1" || env.AGENTS_DECK_NO_DOWNLOAD === "1" ? "download-disabled" : null;
}

/** Windows' own folder, the one System32 is in. */
const systemRoot = (env) => env.SystemRoot || env.SYSTEMROOT || env.systemroot || "C:\\Windows";

/**
 * The program and its arguments for the downloaded `file`: bash on macOS and
 * Linux, Windows PowerShell from System32 on Windows (by its full path, so
 * nothing on PATH or in the deck's folder can stand in for it).
 */
export function installerArgv(platform, file, { env = process.env, exists = existsSync } = {}) {
  if (platform === "win32") {
    const ps = winPath.join(systemRoot(env), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return { file: ps, args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file] };
  }
  return { file: exists("/bin/bash") ? "/bin/bash" : "bash", args: [file] };
}

/**
 * The system's curl and its arguments for saving `url` to `file`, or null when
 * the machine has none: /usr/bin/curl on macOS and Linux, else the curl PATH
 * holds; on Windows the curl.exe System32 has carried since Windows 10 1803
 * (it reads the Windows certificate store), by its full path as PowerShell is
 * taken above, and never one from PATH. https only, redirects included, under
 * the download's deadline and the script's cap.
 */
export function downloaderArgv(platform, url, file, {
  env = process.env, exists = existsSync, timeoutMs = DOWNLOAD_TIMEOUT_MS,
} = {}) {
  let program;
  if (platform === "win32") {
    const exe = winPath.join(systemRoot(env), "System32", "curl.exe");
    program = exists(exe) ? exe : null;
  } else {
    program = exists("/usr/bin/curl")
      ? "/usr/bin/curl"
      : pathLookup("curl", platform, { pathEnv: env.PATH ?? env.Path ?? env.path ?? "", exists });
  }
  if (!program) return null;
  const seconds = String(Math.max(1, Math.ceil(timeoutMs / 1000)));
  return {
    file: program,
    args: [
      "-fsSL", "--proto", "=https", "--proto-redir", "=https",
      "--max-time", seconds, "--max-filesize", String(INSTALL_SCRIPT_MAX),
      "-o", file, url,
    ],
  };
}

/**
 * Whether the deck's own resolver finds `claude` now: the path the sign-in
 * and the quota read run (adminClaudeBin, over claude-dir.mjs's list), there
 * on disk, or a bare name PATH holds.
 */
export function deckFindsClaude({
  platform = process.platform, env = process.env, home = homedir(), exists = existsSync,
} = {}) {
  const bin = adminClaudeBin(platform, env, home, exists);
  if (/[\\/]/.test(bin)) return Boolean(exists(bin));
  return pathLookup(bin, platform, { pathEnv: env.PATH ?? env.Path ?? env.path ?? "", exists }) !== null;
}

const ESCAPES = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;
const CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The last lines of what the installer printed, as a failure shows them: no
 * terminal escapes or control characters, a progress line's carriage returns
 * read as the line it ended on, blank lines dropped, each line cut short, and
 * the home folder written as ~.
 */
export function outputTail(text, { home = homedir(), platform = process.platform, lines = TAIL_LINES } = {}) {
  const clean = String(text ?? "").replace(ESCAPES, "");
  const kept = clean.split(/\r?\n/)
    .map(line => line.split("\r").filter(part => part.trim()).at(-1) ?? "")
    .map(line => line.replace(CONTROLS, "").trimEnd())
    .filter(line => line.trim())
    .slice(-lines)
    .map(line => (line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 1)}…` : line));
  let out = kept.join("\n");
  if (home && home.length > 1) {
    const flags = platform === "win32" ? "gi" : "g";
    out = out.replace(new RegExp(escapeRe(home), flags), "~");
    if (platform === "win32") out = out.replace(new RegExp(escapeRe(home.replace(/\\/g, "/")), flags), "~");
  }
  return out;
}

class InstallFailure extends Error {
  constructor(reason, detail = "") {
    super(reason);
    this.reason = reason;
    this.detail = detail;
  }
}

/** The script's text, under the deadline and the cap, from an https address
 *  that stayed https: fetched, or, when fetch cannot reach it at all, saved
 *  into the job's folder `dir` by the system's curl. Either way it must then
 *  look like a script. */
async function download(url, { fetchImpl, spawnImpl, platform, env, exists, dir, timeoutMs }) {
  if (new URL(url).protocol !== "https:") throw new InstallFailure("download-failed");
  const body = (await viaFetch(url, { fetchImpl, timeoutMs }))
    ?? (await viaCurl(url, { spawnImpl, platform, env, exists, dir, timeoutMs }));
  // An empty answer, or a web page where the script should be (a sign-in or
  // a challenge in front of it), is not a script to run.
  const head = body.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  if (body.byteLength === 0 || body.byteLength > INSTALL_SCRIPT_MAX
    || head.startsWith("<!doctype") || head.startsWith("<html")) throw new InstallFailure("download-failed");
  return body;
}

/** Fetch's answer, or null when it could not reach the script at all (an
 *  error on the way, its deadline, or an answer that is not ok), which is
 *  what curl is then asked to try. An answer that came but broke a rule fails
 *  here and now. */
async function viaFetch(url, { fetchImpl, timeoutMs }) {
  let res;
  try {
    res = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return null;
  }
  if (!res?.ok) return null;
  // A redirect may not leave https.
  if (res.url && new URL(res.url).protocol !== "https:") throw new InstallFailure("download-failed");
  const declared = Number(res.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > INSTALL_SCRIPT_MAX) throw new InstallFailure("download-failed");
  const chunks = [];
  let size = 0;
  try {
    if (res.body && typeof res.body.getReader === "function") {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > INSTALL_SCRIPT_MAX) {
          try { await reader.cancel(); } catch { /* already closed */ }
          throw new InstallFailure("download-failed");
        }
        chunks.push(Buffer.from(value));
      }
    } else {
      const whole = Buffer.from(await res.arrayBuffer());
      size = whole.byteLength;
      if (size > INSTALL_SCRIPT_MAX) throw new InstallFailure("download-failed");
      chunks.push(whole);
    }
  } catch (err) {
    if (err instanceof InstallFailure) throw err;
    return null; // the connection broke, or the deadline came, mid-answer
  }
  return Buffer.concat(chunks);
}

/** What the system's curl saved, or a download failure when there is no curl,
 *  it cannot start, it fails, or it outlives the deadline (it is then
 *  stopped). Nothing it prints is read: its output goes nowhere. */
async function viaCurl(url, { spawnImpl, platform, env, exists, dir, timeoutMs }) {
  const part = join(dir, "download.part");
  const argv = downloaderArgv(platform, url, part, { env, exists, timeoutMs });
  if (!argv) throw new InstallFailure("download-failed");
  const saved = await new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(argv.file, argv.args, { cwd: dir, env, shell: false, windowsHide: true, stdio: "ignore" });
    } catch {
      resolve(false);
      return;
    }
    watchChild(child);
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child, "SIGKILL"); }, timeoutMs);
    timer.unref?.();
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok && !timedOut);
    };
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
  });
  if (!saved) throw new InstallFailure("download-failed");
  try {
    // Read only what can be a script; a file past the cap is not opened.
    if ((await fs.stat(part)).size > INSTALL_SCRIPT_MAX) throw new InstallFailure("download-failed");
    return await fs.readFile(part);
  } catch {
    // Nothing saved at all, or nothing readable.
    throw new InstallFailure("download-failed");
  }
}

/** Runs the installer to its end, its deadline, or a failure to start. */
function runInstaller({ spawnImpl, argv, cwd, env, timeoutMs, platform }) {
  return new Promise((resolve) => {
    let tail = "";
    const keep = (chunk) => { tail = (tail + chunk.toString("utf8")).slice(-TAIL_BYTES); };
    let child;
    try {
      child = spawnImpl(argv.file, argv.args, {
        cwd, env, shell: false, windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        // Its own process group on POSIX, so the deadline stops what it started too.
        detached: platform !== "win32",
      });
    } catch {
      resolve({ started: false, code: null, timedOut: false, tail });
      return;
    }
    watchChild(child, { processGroup: platform !== "win32" });
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child, "SIGKILL"); }, timeoutMs);
    timer.unref?.();
    const finish = (out) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...out, timedOut, tail });
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    child.on("error", () => finish({ started: false, code: null }));
    child.on("close", (code) => finish({ started: true, code }));
  });
}

/**
 * The deck's one installer. Every dependency is a parameter so the suite runs
 * the whole job with a fake download and a fake installer, never the network
 * and never a real script.
 */
export function createClaudeInstaller({
  platform = process.platform,
  env = process.env,
  home = () => homedir(),
  tmp = () => tmpdir(),
  fetchImpl = (...a) => globalThis.fetch(...a),
  spawnImpl = nodeSpawn,
  exists = existsSync,
  found = () => deckFindsClaude({ platform, env, home: home(), exists }),
  downloadTimeoutMs = DOWNLOAD_TIMEOUT_MS,
  installTimeoutMs = INSTALL_TIMEOUT_MS,
} = {}) {
  let job = null; // { id, state, reason?, detail?, run }

  const run = async (current) => {
    let dir = null;
    try {
      dir = await fs.mkdtemp(join(tmp(), "ccdeck-claude-install-"));
      if (platform !== "win32") await fs.chmod(dir, 0o700);
      const url = platform === "win32" ? INSTALL_SCRIPTS.win32 : INSTALL_SCRIPTS.posix;
      const script = await download(url, {
        fetchImpl, spawnImpl, platform, env, exists, dir, timeoutMs: downloadTimeoutMs,
      });
      const file = join(dir, platform === "win32" ? "install.ps1" : "install.sh");
      await fs.writeFile(file, script, { mode: 0o600, flag: "wx" });
      const out = await runInstaller({
        spawnImpl, platform, env, cwd: dir, timeoutMs: installTimeoutMs,
        argv: installerArgv(platform, file, { env, exists }),
      });
      const detail = outputTail(out.tail, { home: home(), platform });
      if (!out.started) throw new InstallFailure("start-failed");
      if (out.timedOut) throw new InstallFailure("timed-out", detail);
      if (out.code !== 0) throw new InstallFailure("exit-failed", detail);
      if (!found()) throw new InstallFailure("installed-but-not-found");
      Object.assign(current, { state: "done" });
    } catch (err) {
      const failure = err instanceof InstallFailure ? err : new InstallFailure("failed");
      Object.assign(current, { state: "failed", reason: failure.reason, ...(failure.detail ? { detail: failure.detail } : {}) });
    } finally {
      if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  };

  return Object.freeze({
    /** Where the install stands, and the command for doing it by hand. */
    status() {
      const blocked = claudeInstallBlocked(env);
      const out = { state: job?.state ?? "idle", command: claudeInstallCommand(platform), shell: platform === "win32" ? "powershell" : "terminal" };
      if (job) out.id = job.id;
      if (job?.reason) out.reason = job.reason;
      if (job?.detail) out.detail = job.detail;
      if (blocked) out.blocked = blocked;
      return out;
    },
    /** Starts one, unless one runs or downloads are off. Never awaits it. */
    start() {
      if (job?.state === "running") return { ok: false, code: "running" };
      const blocked = claudeInstallBlocked(env);
      if (blocked) return { ok: false, code: blocked };
      const current = { id: randomBytes(8).toString("hex"), state: "running" };
      job = current;
      current.run = run(current);
      return { ok: true, id: current.id };
    },
    /** The running job's end, for the suite. */
    settled: () => job?.run ?? Promise.resolve(),
  });
}

let shared = null;
/** The deck's installer, made on first use. */
export function claudeInstaller() {
  shared ??= createClaudeInstaller();
  return shared;
}

/** GET: where the install stands. */
export async function handleClaudeInstallStatus(_req, res, { installer = claudeInstaller() } = {}) {
  return send(res, 200, { ok: true, ...installer.status() });
}

/** POST: start one. 409 names why not: one runs already, or downloads are off. */
export async function handleClaudeInstallStart(req, res, { installer = claudeInstaller() } = {}) {
  try { await readBody(req, res, BODY_LIMIT); } catch { return; /* answered 413 already */ }
  const out = installer.start();
  return send(res, out.ok ? 200 : 409, out);
}
