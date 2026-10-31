// Supported Codex JSONL RPC; no credential files, token extraction or login.
// Protocol: https://developers.openai.com/codex/app-server
// account/rateLimits/read may proactively refresh via Codex's own AuthManager:
// https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/manager.rs
// account/read currently exposes email/plan, not workspace ID: equal revisions
// cannot prove that two same-email workspaces are the same account. Managed
// home labels remain essential. Recheck account/read after every quota read.
import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { candidateSpec, isBatch, pathLookup } from './exec-spec.mjs';
import { killTree, watchChild } from './exec-children.mjs';

const cache = new Map();
const dependencyIds = new WeakMap();
let nextDependency = 0;
const CACHE_LIMIT = 64;
const CACHE_MS = 60_000;
const activeQuotaFloor = (entry, now) => entry.quotaValue && Number.isFinite(entry.quotaAt) && now - entry.quotaAt < CACHE_MS;
const DEADLINE_MS = 12_000;
const MAX_OUTPUT = 1024 * 1024;
const MAX_LINE = 64 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
async function authFileVersion(home, path, readStat = stat) {
  try {
    const info = await readStat(path.join(home, 'auth.json'));
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  } catch (error) { return error.code === 'ENOENT' ? 'missing' : null; }
}
const dependencyId = value => {
  if (!value || !['function', 'object'].includes(typeof value)) return 0;
  if (!dependencyIds.has(value)) dependencyIds.set(value, ++nextDependency);
  return dependencyIds.get(value);
};
const bounded = (value, maximum) => Number.isFinite(value) && value > 0 ? Math.min(value, maximum) : maximum;
const safePlan = value => typeof value === 'string' && /^[a-z0-9_-]{1,40}$/.test(value) ? value : null;
const failure = (reason, now, identity = {}) => ({
  ok: false, signedIn: false, label: null, identityVersion: null, plan: null,
  ...identity, ok: false, windows: [], fetchedAt: now(), reason,
});

function accountIdentity(result) {
  if (!result || !Object.hasOwn(result, 'account')) return null;
  const account = result.account;
  if (account === null) return { ok: true, signedIn: false, label: null, identityVersion: hash('null'), plan: null };
  if (!account || !['chatgpt', 'apiKey'].includes(account.type)) return null;
  const rawEmail = typeof account.email === 'string' ? account.email.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 254) : null;
  const email = rawEmail && /^[^\s@/\\]+@[^\s@/\\]+$/.test(rawEmail) ? rawEmail : null;
  // Some versions may add a public account ID. Hash it; never serialize it.
  const rawId = account.id ?? account.accountId;
  const accountHash = typeof rawId === 'string' && rawId.length <= 256 ? hash(rawId) : null;
  const workspace = accountHash?.slice(0, 8) ?? null;
  const plan = account.type === 'apiKey' ? 'api' : safePlan(account.planType);
  return {
    ok: true, signedIn: true,
    label: account.type === 'apiKey' ? 'Codex API key' : `${email ?? 'Codex account'}${workspace ? ` · ${workspace}` : ''}`,
    identityVersion: hash(JSON.stringify([account.type, email, plan, accountHash])), plan,
  };
}
function quotaWindows(result) {
  const bucket = result?.rateLimitsByLimitId?.codex ?? result?.rateLimits;
  if (!bucket || (bucket.limitId != null && bucket.limitId !== 'codex')) return null;
  const window = value => {
    if (!value || typeof value.usedPercent !== 'number' || !Number.isFinite(value.usedPercent) || value.usedPercent < 0) return null;
    const seconds = typeof value.windowDurationMins === 'number' ? value.windowDurationMins * 60 : null;
    return {
      usedPercent: value.usedPercent,
      seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : null,
      resetAt: typeof value.resetsAt === 'number' && Number.isFinite(value.resetsAt) && value.resetsAt >= 0 ? value.resetsAt : null,
    };
  };
  return [window(bucket.primary), window(bucket.secondary)].filter(Boolean);
}

function rpcRead(home, options) {
  const { platform, env, now, includeQuota } = options;
  const lookup = options.pathLookup ?? pathLookup;
  let executable;
  try { executable = options.executable ?? lookup('codex', platform, { pathEnv: env.PATH ?? env.Path ?? '' }); }
  catch { return Promise.resolve(failure('cli_unavailable', now)); }
  if (!executable) return Promise.resolve(failure('cli_unavailable', now));
  // PATH lookup happens in the deck's cwd, before the child moves to its home.
  const path = platform === 'win32' ? win32 : posix;
  if (!path.isAbsolute(executable)) executable = path.resolve(process.cwd(), executable);
  const spec = candidateSpec(executable, ['app-server'], platform);
  if (isBatch(executable, platform) && !win32.isAbsolute(spec.file)) {
    const root = env.SystemRoot ?? env.systemroot;
    // A bare cmd.exe could be shadowed inside the selected home on Windows.
    const wrapper = root && win32.isAbsolute(root) ? win32.join(root, 'System32', 'cmd.exe')
      : lookup('cmd.exe', platform, { pathEnv: env.PATH ?? env.Path ?? '' });
    if (!wrapper || !win32.isAbsolute(wrapper)) return Promise.resolve(failure('cli_unavailable', now));
    spec.file = wrapper;
  }
  const childEnv = { ...env, CODEX_HOME: home };
  // Ambient API keys must not replace this home's keyring identity.
  delete childEnv.OPENAI_API_KEY; delete childEnv.CODEX_API_KEY;
  if (platform === 'win32') childEnv.NoDefaultCurrentDirectoryInExePath = '1';
  return new Promise(resolve => {
    let child, timer, done = false, expected = 0, before = null, windows = [], bytes = 0, pending = '';
    const decoder = new StringDecoder('utf8');
    const finish = value => {
      if (done) return;
      done = true; clearTimeout(timer);
      pending = ''; before = null;
      try { child?.stdin?.end(); } catch { /* already closed */ }
      try { (options.killChild ?? killTree)(child, 'SIGKILL'); } catch { /* already gone */ }
      child?.stdout?.destroy(); child?.stderr?.destroy();
      resolve(value);
    };
    const send = value => {
      if (done) return;
      try { child.stdin.write(JSON.stringify(value) + '\n'); }
      catch { finish(failure('rpc_error', now)); }
    };
    const response = message => {
      if (!message || typeof message !== 'object') return finish(failure('protocol_error', now));
      if (message.method && Object.hasOwn(message, 'id')) {
        // External-token callbacks and tool requests are outside this reader.
        // Never answer with credentials, approve actions, or start a login.
        return finish(failure('unsupported_auth', now));
      }
      if (message.id !== expected) return; // notifications / unrelated responses
      if (message.error) {
        const reason = [-32601, -32602].includes(message.error.code) ? 'unsupported' : 'rpc_error';
        return finish(failure(reason, now, before ?? {}));
      }
      if (!Object.hasOwn(message, 'result')) return finish(failure('protocol_error', now));
      if (expected === 0) {
        expected = 1;
        send({ method: 'initialized', params: {} });
        send({ id: 1, method: 'account/read', params: { refreshToken: false } });
      } else if (expected === 1) {
        before = accountIdentity(message.result);
        if (!before) return finish(failure('unsupported', now));
        if (!includeQuota || !before.signedIn || before.plan === 'api') {
          return finish({ ...before, windows: [], fetchedAt: now() });
        }
        expected = 2;
        send({ id: 2, method: 'account/rateLimits/read' });
      } else if (expected === 2) {
        windows = quotaWindows(message.result);
        if (!windows) return finish(failure('quota_unavailable', now, before));
        expected = 3;
        send({ id: 3, method: 'account/read', params: { refreshToken: false } });
      } else {
        const after = accountIdentity(message.result);
        if (!after || after.identityVersion !== before.identityVersion) return finish(failure('profile_changed', now, after ?? {}));
        finish({ ...after, windows, fetchedAt: now() });
      }
    };
    try {
      child = watchChild((options.spawn ?? spawn)(spec.file, spec.args, {
        ...spec.opts, cwd: home, env: childEnv, shell: false, windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      }));
      timer = setTimeout(() => finish(failure('timeout', now)), bounded(options.deadlineMs, DEADLINE_MS));
      child.on('error', error => finish(failure(error?.code === 'ENOENT' ? 'cli_unavailable' : 'rpc_error', now)));
      child.on('close', () => finish(failure('unsupported', now)));
      child.stdin.on('error', () => finish(failure('rpc_error', now)));
      child.stdout.on('error', () => finish(failure('rpc_error', now)));
      child.stderr.on('error', () => {});
      child.stderr.resume(); // drain without buffering, returning or logging it
      child.stdout.on('data', chunk => {
        if (done) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > bounded(options.maxOutputBytes, MAX_OUTPUT)) return finish(failure('output_limit', now));
        pending += typeof chunk === 'string' ? chunk : decoder.write(chunk);
        let newline;
        while (!done && (newline = pending.indexOf('\n')) >= 0) {
          if (Buffer.byteLength(pending.slice(0, newline)) > MAX_LINE) return finish(failure('output_limit', now));
          const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
          if (!line.trim()) continue;
          let message;
          try { message = JSON.parse(line); } catch { return finish(failure('protocol_error', now)); }
          response(message);
        }
        if (Buffer.byteLength(pending) > MAX_LINE) finish(failure('output_limit', now));
      });
      send({ id: 0, method: 'initialize', params: { clientInfo: { name: 'ccdeck', version: '3.39.1' } } });
    } catch { finish(failure('cli_unavailable', now)); }
  });
}

/** Capture home once. Injectable spawn/executable/pathLookup/killChild/now
 * support synthetic tests; callers never forward HTTP input as options.
 * Cache keys separate quota from metadata. No reads of plaintext auth files.
 */
export async function readNativeCodexAccount(home, options = {}) {
  const now = options.now ?? Date.now;
  const platform = options.platform ?? process.platform;
  const path = platform === 'win32' ? win32 : posix;
  if (typeof home !== 'string' || !path.isAbsolute(home) || home.includes('\0')) return Promise.resolve(failure('profile_unavailable', now));
  const env = { ...(options.env ?? process.env) };
  // Match Codex's canonical-home keyring identity and share floors across aliases.
  try { home = await (options.realpath ?? realpath)(home); }
  catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error.code)) return failure('profile_unavailable', now);
  }
  const includeQuota = options.includeQuota === true;
  const key = JSON.stringify([home, includeQuota, platform, options.executable ?? null, env.PATH ?? env.Path ?? '',
    dependencyId(options.spawn), dependencyId(options.pathLookup), dependencyId(options.killChild), dependencyId(options.now), dependencyId(options.stat), dependencyId(options.realpath), options.deadlineMs ?? null, options.maxOutputBytes ?? null]);
  const started = now();
  const held = cache.get(key);
  if (held && (held.pending || (!options.force && started >= held.at && started - held.at < CACHE_MS))) return (held.pending ?? Promise.resolve(structuredClone(held.value))).then(value => structuredClone(value));
  cache.delete(key);
  for (const [id, entry] of cache) if (!entry.pending && !activeQuotaFloor(entry, started) && (started < entry.at || started - entry.at >= CACHE_MS)) cache.delete(id);
  if (cache.size >= CACHE_LIMIT) {
    const settled = [...cache].find(([, entry]) => !entry.pending && !activeQuotaFloor(entry, started));
    if (!settled) return Promise.resolve(failure('native_busy', now));
    cache.delete(settled[0]);
  }
  let attemptedQuota = false;
  const entry = { at: started, pending: null, value: null, quotaAt: held?.quotaAt, quotaValue: held?.quotaValue, quotaFileVersion: held?.quotaFileVersion };
  const pending = Promise.resolve().then(async () => {
    // One shared wall-clock budget; verification cannot reuse either cache or
    // the first process's in-memory auth snapshot. Keep admission held throughout.
    const deadline = Date.now() + bounded(options.deadlineMs, DEADLINE_MS);
    const fileVersion = await authFileVersion(home, path, options.stat);
    if (fileVersion === null) return failure('profile_unavailable', now);
    const initialRemaining = deadline - Date.now();
    if (initialRemaining <= 0) return failure('timeout', now);
    // Force means verify identity now, never bypass the per-home usage floor.
    if (includeQuota && activeQuotaFloor(entry, started)) {
      const fresh = await rpcRead(home, { ...options, platform, env, now, includeQuota: false, deadlineMs: initialRemaining });
      if (!fresh.ok) return failure(fresh.reason ?? 'rpc_error', now);
      if (fileVersion !== entry.quotaFileVersion || await authFileVersion(home, path, options.stat) !== fileVersion) return failure('profile_changed', now);
      const old = entry.quotaValue;
      if (old.ok && (!fresh.signedIn || fresh.identityVersion !== old.identityVersion)) return failure('profile_changed', now);
      return { ...old, stale: true };
    }
    if (includeQuota) { attemptedQuota = true; entry.quotaAt = started; entry.quotaFileVersion = fileVersion; }
    const value = await rpcRead(home, { ...options, platform, env, now, includeQuota, deadlineMs: initialRemaining });
    if (includeQuota) entry.quotaValue = value;
    if (!includeQuota || !value.ok || !value.signedIn || value.plan === 'api') return value;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return failure('timeout', now);
    const fresh = await rpcRead(home, { ...options, platform, env, now, includeQuota: false, deadlineMs: remaining });
    if (!fresh.ok) return failure(fresh.reason ?? 'rpc_error', now);
    if (await authFileVersion(home, path, options.stat) !== fileVersion) return failure('profile_changed', now);
    if (!fresh.signedIn || fresh.identityVersion !== value.identityVersion) return failure('profile_changed', now, fresh);
    return { ...value, fetchedAt: now() };
  })
    .catch(() => failure('rpc_error', now)).then(value => {
    if (attemptedQuota) entry.quotaValue = value;
    entry.pending = null; entry.at = now(); entry.value = value;
    return structuredClone(value);
  });
  entry.pending = pending; cache.set(key, entry);
  return pending;
}
