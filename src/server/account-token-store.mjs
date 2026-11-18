// Where the device token is kept: the OS's own secret store where there is
// one, otherwise account.json at 0600.
//
//   macOS    the login Keychain, through /usr/bin/security -i
//   Windows  DPAPI (CurrentUser) through powershell.exe; the ciphertext is kept
//            in account.json, which only this Windows user can decrypt
//   Linux    the Secret Service through secret-tool, when a session bus and
//            the tool are both there
//   any      account.json, mode 0600 — the protection prefs.json gives the LAN
//            private key (deck-prefs.mjs PREFS_MODE)
//
// THE SECRET IS NEVER ON A COMMAND LINE. Every platform's argv is readable by
// every other process on the machine through `ps` or /proc, so the token goes
// to each tool on its STDIN: `security -i` reads its commands from there,
// secret-tool reads the secret from there, and the PowerShell script reads the
// token from [Console]::In. The script itself rides in -EncodedCommand and
// holds no secret. account-token-store.test.ts mocks the runner on each
// platform and holds every argv to that.
//
// A KEYCHAIN THAT WILL NOT OPEN IS NOT A LOST TOKEN. Over ssh, or before the
// user has logged in at the console, macOS answers "User interaction is not
// allowed" — the condition cswap-admin.mjs knows as keychain_unavailable. That
// is reported as `locked`, the token is left where it is, and the service asks
// again later; only "not found" is `missing`.
//
// A WRITE THAT FAILS FALLS BACK TO THE FILE rather than leaving the deck with
// a token it cannot keep: a fresh token that dies with the process would cost
// the user a second approval in the browser.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants as fsConstants } from "node:fs";
import { delimiter, join } from "node:path";
import { deckDataDir } from "./deck-home.mjs";
import { DEVICE_TOKEN } from "./account-store.mjs";

/** The service name every backend files the token under. */
export const TOKEN_SERVICE = "ccdeck.account";

/** How long one call to a secret store may take. A Keychain prompt nobody can
 *  answer must not hold a connect open. */
const RUN_TIMEOUT_MS = 10_000;
const OUTPUT_MAX = 64 * 1024;

/** The account name a deck's token is filed under: one per data folder, so two
 *  CCDECK_HOMEs on one machine are two devices with two tokens. Hashed, so the
 *  folder's path is not written into the keychain's item list. */
export function tokenAccountName(home = deckDataDir()) {
  return createHash("sha256").update(String(home)).digest("hex").slice(0, 16);
}

/**
 * Run `cmd` with `args`, writing `input` to its stdin. Resolves to the exit
 * code and what it printed; never rejects (a tool that cannot be started is
 * code -1). No shell, a bounded wait, bounded output.
 */
export function runWithStdin(cmd, args, { input = "", timeout = RUN_TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = code => { if (!done) { done = true; clearTimeout(timer); resolve({ code, stdout, stderr }); } };
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false });
    } catch {
      resolve({ code: -1, stdout: "", stderr: "spawn failed" });
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish(-1); }, timeout);
    timer.unref?.();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", c => { if (stdout.length < OUTPUT_MAX) stdout += c; });
    child.stderr.on("data", c => { if (stderr.length < OUTPUT_MAX) stderr += c; });
    child.on("error", () => finish(-1));
    child.on("close", code => finish(typeof code === "number" ? code : -1));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/** Whether `cmd` is an executable on PATH. */
export function onPath(cmd, env = process.env) {
  for (const dir of String(env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    try { accessSync(join(dir, cmd), fsConstants.X_OK); return true; } catch { /* next */ }
  }
  return false;
}

/** PowerShell's -EncodedCommand: the script as UTF-16LE, base64. */
export function encodePowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

const PS_PROTECT = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Security",
  "$t = [Console]::In.ReadToEnd().Trim()",
  "$c = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($t), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "[Console]::Out.Write([Convert]::ToBase64String($c))",
].join("\n");

const PS_UNPROTECT = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Security",
  "$c = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())",
  "$b = [Security.Cryptography.ProtectedData]::Unprotect($c, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($b))",
].join("\n");

const POWERSHELL_ARGS = script => ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(script)];

/** macOS: the Keychain refusing because nobody can be asked — locked, or a
 *  session with no window server. errSecInteractionNotAllowed is -25308. */
function keychainLocked(stderr) {
  return /interaction is not allowed|-25308|keychain is locked|could not be unlocked/i.test(stderr);
}

/**
 * The token store for this machine. `run` and `which` are the suite's
 * stand-ins; the product passes nothing.
 *
 * save(token)  → the fields account.json keeps: { tokenStorage, token?, tokenCipher? }
 * load(record) → { ok: true, token } | { ok: false, reason: "locked" | "missing" }
 * remove(record) → forgets what save kept outside account.json (best effort)
 */
export function createTokenStore({
  platform = process.platform,
  env = process.env,
  home = deckDataDir(),
  run = runWithStdin,
  which = cmd => onPath(cmd, env),
} = {}) {
  const account = tokenAccountName(home);
  const secretTool = () => platform === "linux" && !!env.DBUS_SESSION_BUS_ADDRESS && which("secret-tool");

  /** Which backend a new token goes to. */
  function backend() {
    if (platform === "darwin") return "keychain";
    if (platform === "win32") return "dpapi";
    if (secretTool()) return "secret-service";
    return "file";
  }

  const asFile = token => ({ tokenStorage: "file", token });

  async function save(token) {
    if (!DEVICE_TOKEN.test(String(token ?? ""))) throw new Error("not a device token");
    const kind = backend();
    if (kind === "keychain") {
      const r = await run("/usr/bin/security", ["-i"], {
        input: `add-generic-password -U -s ${TOKEN_SERVICE} -a ${account} -w ${token}\n`,
      });
      return r.code === 0 && !/security: |error/i.test(r.stderr) ? { tokenStorage: "keychain" } : asFile(token);
    }
    if (kind === "dpapi") {
      const r = await run("powershell.exe", POWERSHELL_ARGS(PS_PROTECT), { input: token });
      const cipher = r.stdout.trim();
      return r.code === 0 && /^[A-Za-z0-9+/=]{16,4096}$/.test(cipher) ? { tokenStorage: "dpapi", tokenCipher: cipher } : asFile(token);
    }
    if (kind === "secret-service") {
      const r = await run("secret-tool", ["store", "--label=ccdeck account", "service", TOKEN_SERVICE, "account", account], { input: token });
      return r.code === 0 ? { tokenStorage: "secret-service" } : asFile(token);
    }
    return asFile(token);
  }

  async function load(record) {
    const storage = record?.tokenStorage;
    if (storage === "file") {
      return DEVICE_TOKEN.test(record.token ?? "") ? { ok: true, token: record.token } : { ok: false, reason: "missing" };
    }
    if (storage === "keychain") {
      if (platform !== "darwin") return { ok: false, reason: "missing" };
      const r = await run("/usr/bin/security", ["-i"], {
        input: `find-generic-password -s ${TOKEN_SERVICE} -a ${account} -w\n`,
      });
      const token = r.stdout.trim().split(/\s+/).find(w => DEVICE_TOKEN.test(w));
      if (token) return { ok: true, token };
      if (keychainLocked(r.stderr) || r.code === -1) return { ok: false, reason: "locked" };
      return { ok: false, reason: "missing" };
    }
    if (storage === "dpapi") {
      if (platform !== "win32" || !record.tokenCipher) return { ok: false, reason: "missing" };
      const r = await run("powershell.exe", POWERSHELL_ARGS(PS_UNPROTECT), { input: record.tokenCipher });
      const token = r.stdout.trim();
      if (r.code === 0 && DEVICE_TOKEN.test(token)) return { ok: true, token };
      // A PowerShell that would not start is this machine, not the token.
      return { ok: false, reason: r.code === -1 ? "locked" : "missing" };
    }
    if (storage === "secret-service") {
      if (!secretTool()) return { ok: false, reason: "locked" };
      const r = await run("secret-tool", ["lookup", "service", TOKEN_SERVICE, "account", account], { input: "" });
      const token = r.stdout.trim();
      if (r.code === 0 && DEVICE_TOKEN.test(token)) return { ok: true, token };
      // Nothing found prints nothing and exits 1; a collection that will not
      // unlock says why on stderr.
      return { ok: false, reason: r.stderr.trim() || r.code === -1 ? "locked" : "missing" };
    }
    return { ok: false, reason: "missing" };
  }

  async function remove(record) {
    const storage = record?.tokenStorage;
    if (storage === "keychain" && platform === "darwin") {
      await run("/usr/bin/security", ["-i"], { input: `delete-generic-password -s ${TOKEN_SERVICE} -a ${account}\n` });
    } else if (storage === "secret-service" && secretTool()) {
      await run("secret-tool", ["clear", "service", TOKEN_SERVICE, "account", account], { input: "" });
    }
    // The file and DPAPI backends keep everything in account.json, which the
    // caller rewrites without it.
  }

  return { backend, save, load, remove };
}
