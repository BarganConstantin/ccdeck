// Read only the credential owned/refreshed by the selected native Codex home.
// Never log RPC payloads, expose refresh tokens, or write auth/config files.
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { readCodexSelection } from './codex-selection.mjs';
import { startEngineRpc } from './codex-engine-rpc.mjs';
import { pathLookup } from './exec-spec.mjs';
import { holdWindowsPrivatePath } from './codex-windows-private.mjs';

const MAX_AUTH_BYTES = 1024 * 1024;
// Windows cold CLI startup needs the same twelve-second request allowance as
// native quota inspection, plus the owned process's four-second shutdown.
const NATIVE_DEADLINE_MS = process.platform === 'win32' ? 16000 : 7000;
// startEngineRpc.stop() closes stdin, then escalates at 2s and 4s. Reserve its
// full shutdown window rather than giving each request another seven seconds.
const STOP_RESERVE_MS = 4000;
class CredentialError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.stack = `Error: ${code}`;
  }
}
const fail = code => { throw new CredentialError(code); };
const sanitized = (error, code) => error instanceof CredentialError ? error : new CredentialError(code);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sameNode = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
const sameFile = (a, b) => sameNode(a, b) && a.uid === b.uid && a.size === b.size
  && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink;

async function beforeDeadline(action, deadline) {
  const remaining = deadline - performance.now();
  if (remaining <= 0) fail('native_timeout');
  let timer;
  try {
    const value = await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new CredentialError('native_timeout')), remaining); }),
    ]);
    if (performance.now() >= deadline) fail('native_timeout');
    return value;
  } finally { clearTimeout(timer); }
}

function profileFrom(selection, profileId) {
  const profile = selection.profiles.find(p => p.id === profileId);
  if (!profile) fail('unknown_profile');
  if (!profile.available) fail('profile_unavailable');
  return profile;
}
async function captureProfile(profile) {
  const canonical = await realpath(profile.home);
  if (createHash('sha256').update(canonical).digest('hex').slice(0, 20) !== profile.id) fail('profile_changed');
  const literal = await lstat(profile.home, { bigint: true });
  const directory = await lstat(canonical, { bigint: true });
  if (!directory.isDirectory()) fail('profile_unavailable');
  return { canonical, literal, directory };
}
async function revalidateProfile(profile, captured, revision, options) {
  try {
    const selection = await readCodexSelection(options);
    const current = profileFrom(selection, profile.id);
    if (selection.revision !== revision || current.home !== profile.home || await realpath(current.home) !== captured.canonical
      || !sameNode(await lstat(current.home, { bigint: true }), captured.literal)
      || !sameNode(await lstat(captured.canonical, { bigint: true }), captured.directory)) fail('profile_changed');
  } catch { fail('profile_changed'); }
}

async function nativeAccount(home, env, executable, startRpc, refresh) {
  const deadline = performance.now() + NATIVE_DEADLINE_MS;
  const requestDeadline = deadline - STOP_RESERVE_MS;
  let rpc, account, failure;
  try {
    rpc = startRpc(executable, ['app-server', '--listen', 'stdio://'], home, {
      env, deadlineMs: Math.max(1, requestDeadline - performance.now()),
      spawnChild: (file, args, settings) => spawn(file, args, { ...settings, cwd: home }),
    });
    await beforeDeadline(() => rpc.request('initialize', {
      clientInfo: { name: 'ccdeck', title: 'ccdeck', version: '1' },
      capabilities: { experimentalApi: true },
    }), requestDeadline);
    await beforeDeadline(() => rpc.send({ method: 'initialized', params: {} }), requestDeadline);
    const result = await beforeDeadline(() => rpc.request('config/read', { includeLayers: false, cwd: home }), requestDeadline);
    if (!record(result?.config)) fail('unsupported_credentials_store');
    const store = result.config.cli_auth_credentials_store;
    if (store != null && store !== 'file') fail('unsupported_credentials_store');
    account = await beforeDeadline(() => rpc.request('account/read', { refreshToken: refresh }), requestDeadline);
    if (account?.account?.type !== 'chatgpt') fail('unsupported_auth');
  } catch (error) { failure = sanitized(error, 'native_error'); }
  finally {
    if (rpc) {
      // This handle is created for this read alone; never stop a shared engine.
      try {
        const stopping = Promise.resolve(rpc.stop());
        // Always initiate shutdown, even if an event-loop stall used the budget.
        stopping.catch(() => {});
        if (await beforeDeadline(() => stopping, deadline) === false) fail('native_error');
      } catch (error) { failure ??= sanitized(error, 'native_error'); }
    }
  }
  if (failure) throw failure;
  return account.account;
}

function privateFile(info, windows) {
  if (!info.isFile() || info.size > BigInt(MAX_AUTH_BYTES)
    || !windows && (typeof process.getuid !== 'function' || info.uid !== BigInt(process.getuid())
      || (info.mode & 0o7777n & ~0o600n) !== 0n)) fail('credential_file_unsafe');
}
function jwtClaims(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) fail('invalid_credentials');
  let claims;
  try { claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); }
  catch { fail('invalid_credentials'); }
  if (!record(claims)) fail('invalid_credentials');
  return claims;
}
const validEmail = value => typeof value === 'string' && value.length <= 254 && /^[^\s@/\\\x00-\x1f\x7f]+@[^\s@/\\\x00-\x1f\x7f]+$/.test(value);
const validAccountId = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\s/\\\x00-\x1f\x7f]/.test(value);
const plan = value => typeof value === 'string' && /^[a-z0-9_-]{1,40}$/.test(value) ? value : null;
function credentialFrom(auth, account, profileId) {
  if (auth?.auth_mode !== 'chatgpt' || auth.OPENAI_API_KEY != null) fail('unsupported_auth');
  const tokens = auth.tokens;
  if (!record(tokens) || !validAccountId(tokens.account_id)) fail('invalid_credentials');
  // Deliberately never access tokens.refresh_token, even when native refreshed.
  const identity = jwtClaims(tokens.id_token);
  const access = jwtClaims(tokens.access_token);
  const email = identity.email ?? identity['https://api.openai.com/profile']?.email;
  const claims = identity['https://api.openai.com/auth'];
  if (!validEmail(email) || !validEmail(account.email) || email.toLowerCase() !== account.email.toLowerCase()
    || (claims?.chatgpt_account_id != null && claims.chatgpt_account_id !== tokens.account_id)
    || (account.accountId != null && account.accountId !== tokens.account_id)
    || (account.id != null && account.id !== tokens.account_id)) fail('identity_mismatch');
  if (!Number.isSafeInteger(access.exp) || access.exp <= 0 || access.exp > 8_640_000_000_000) fail('invalid_credentials');
  const expiresAt = access.exp * 1000;
  if (expiresAt <= Date.now()) fail('credential_expired');
  return { profileId, accessToken: tokens.access_token, accountId: tokens.account_id, email,
    planType: plan(account.planType) ?? plan(claims?.chatgpt_plan_type), expiresAt };
}

/** Server-owned options only. profileId is a roster ID, never a home/path.
 * expiresAt is Unix milliseconds. Native Codex owns any requested refresh.
 * POSIX uses UID/private modes and O_NOFOLLOW; Windows uses pinned private
 * DACL-validated directory/file handles as its no-follow substitute.
 */
export async function readLiveCodexCredential(profileId, options = {}) {
  let phase = 'profile_unavailable', profileGuard;
  try {
    const platform = options.platform ?? process.platform, windows = platform === 'win32';
    if (typeof profileId !== 'string' || !/^[a-f0-9]{20}$/.test(profileId)) fail('unknown_profile');
    const env = { ...(options.env ?? process.env) };
    const selectionOptions = { store: options.store, env };
    const selection = await readCodexSelection(selectionOptions);
    const profile = profileFrom(selection, profileId);
    if (windows) {
      try { profileGuard = await holdWindowsPrivatePath(profile.home, { ...options.windowsPrivate, kind: 'directory' }); }
      catch { fail('credential_file_unsafe'); }
    }
    const captured = await captureProfile(profile);
    const childEnv = { ...env, CODEX_HOME: captured.canonical };
    for (const key of Object.keys(childEnv)) if (/^(OPENAI_API_KEY|CODEX_API_KEY)$/i.test(key)) delete childEnv[key];
    phase = 'native_unavailable';
    const executable = options.executable ?? pathLookup('codex', platform, { pathEnv: childEnv.PATH ?? childEnv.Path ?? '' });
    if (typeof executable !== 'string' || !executable || executable.includes('\0')) fail('native_unavailable');
    phase = 'native_error';
    // Resolve before entering the profile directory so a relative PATH entry
    // cannot select an executable from that profile instead of the server cwd.
    const account = await nativeAccount(captured.canonical, childEnv, resolve(executable), options.startRpc ?? startEngineRpc, options.refresh === true);
    // Native has finished refreshing and its owned process has stopped. No
    // pre-refresh file version is compared with the legitimately renewed file.
    await revalidateProfile(profile, captured, selection.revision, selectionOptions);
    phase = 'credential_unavailable';
    const file = join(captured.canonical, 'auth.json');
    let handle, fileGuard;
    try {
      if (windows) {
        try { fileGuard = await holdWindowsPrivatePath(file, { ...options.windowsPrivate, kind: 'file' }); }
        catch { fail('credential_file_unsafe'); }
      }
      const initial = await lstat(file, { bigint: true });
      privateFile(initial, windows);
      if (!windows && typeof constants.O_NOFOLLOW !== 'number') fail('credential_file_unsafe');
      handle = await open(file, constants.O_RDONLY | (windows ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
      const opened = await handle.stat({ bigint: true });
      privateFile(opened, windows);
      if (!sameFile(initial, opened)) fail('credential_file_changed');
      const bytes = Buffer.alloc(MAX_AUTH_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > MAX_AUTH_BYTES || BigInt(length) !== opened.size) fail('credential_file_changed');
      let auth;
      try { auth = JSON.parse(bytes.subarray(0, length).toString('utf8')); }
      catch { fail('invalid_credentials'); }
      const credential = credentialFrom(auth, account, profileId);
      await revalidateProfile(profile, captured, selection.revision, selectionOptions);
      if (!sameFile(opened, await handle.stat({ bigint: true })) || !sameFile(opened, await lstat(file, { bigint: true }))) fail('credential_file_changed');
      if (windows && (!profileGuard.valid() || !fileGuard.valid())) fail('credential_file_changed');
      if (credential.expiresAt <= Date.now()) fail('credential_expired');
      return credential;
    } finally { await handle?.close(); await fileGuard?.release(); }
  } catch (error) { throw sanitized(error, phase); }
  finally { await profileGuard?.release(); }
}
