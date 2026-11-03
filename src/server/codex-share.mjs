// Explicit, portable file-auth transfer. This is encoding, not encryption:
// possession of the code grants the same login as possession of auth.json.
// No expiry, revocation, JWT verification, refresh, native login or network I/O.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createTemp, renameWithRetry } from './atomic-write.mjs';
import { readCodexSelection, importCodexProfiles, withCodexProfileLocked } from './codex-selection.mjs';
import { ensureWindowsPrivateDirectory, holdWindowsPrivatePath } from './codex-windows-private.mjs';

export const CODEX_SHARE_PREFIX = 'ccdeck-codex-v1.';
export const CODEX_SHARE_MAX_LENGTH = 512_000;
export const CODEX_SHARE_MAX_ACCOUNTS = 20;
const AUTH_MAX_BYTES = 32_000;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const token = value => typeof value === 'string' && value.length > 0 && value.length <= 16_000 && /^[\x21-\x7e]+$/.test(value);
const safeLabel = value => value === null || (typeof value === 'string' && value.length > 0 && value.length <= 80 && value === value.trim() && !/[\x00-\x1f\x7f/\\]/.test(value));

function oauthProvenance(value) {
  if (value === undefined || value === null) return true;
  if (!keys(value, ['issuer', 'client_id']) || !token(value.issuer) || value.issuer.length > 2048
    || !token(value.client_id) || value.client_id.length > 512) return false;
  // Codex uses this issuer as the refresh destination, not just display data.
  // Transfer only HTTPS OpenAI authorities; never infer one from JWT claims.
  try {
    const issuer = new URL(value.issuer);
    return issuer.protocol === 'https:' && !issuer.username && !issuer.password && !issuer.port
      && !/[?#\\]/.test(value.issuer)
      && ['openai.com', 'chatgpt.com'].some(host => issuer.hostname === host || issuer.hostname.endsWith(`.${host}`));
  } catch { return false; }
}

/** Whitelist the on-disk ChatGPT schema, never source paths/config/extra keys.
 * Token strings stay opaque; a decoded JWT is never proof of identity. */
function chatgptAuth(raw) {
  if (!keys(raw, ['auth_mode', 'OPENAI_API_KEY', 'tokens', 'last_refresh'])
    || (raw.auth_mode !== undefined && raw.auth_mode !== 'chatgpt')
    || (raw.OPENAI_API_KEY !== undefined && raw.OPENAI_API_KEY !== null)
    || !keys(raw.tokens, ['access_token', 'refresh_token', 'id_token', 'account_id', 'oauth_provenance', 'login_owner_id'])
    || !['access_token', 'refresh_token', 'id_token'].every(key => token(raw.tokens[key]))
    || !oauthProvenance(raw.tokens.oauth_provenance)
    || (raw.tokens.login_owner_id != null && (typeof raw.tokens.login_owner_id !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(raw.tokens.login_owner_id)))
    || (raw.tokens.account_id !== undefined && (!token(raw.tokens.account_id) || raw.tokens.account_id.length > 512))
    || (raw.last_refresh !== undefined && (typeof raw.last_refresh !== 'string' || raw.last_refresh.length > 40 || !Number.isFinite(Date.parse(raw.last_refresh))))) fail('unsupported_auth');
  // Codex 0.166 TokenData preserves these optional fields across refreshes.
  // login_owner_id identifies a completed login, not a machine: preserve it
  // with its grant rather than generating a new login or dropping provenance.
  // Schema/semantics: openai/codex rust-v0.166.0 (6ff1e1ca), login/src/token_data.rs,
  // server.rs and auth/{account_grant,manager}.rs. Legacy fields stay absent.
  const auth = { auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { ...raw.tokens }, ...(raw.last_refresh !== undefined ? { last_refresh: raw.last_refresh } : {}) };
  if (Buffer.byteLength(JSON.stringify(auth)) > AUTH_MAX_BYTES) fail('unsupported_auth');
  return auth;
}

function privateAuthFile(info, platform) {
  if (!info.isFile() || info.size > AUTH_MAX_BYTES || info.nlink !== 1
    || (platform !== 'win32' && (typeof process.getuid !== 'function' || info.uid !== process.getuid() || (info.mode & 0o7777 & ~0o600) !== 0))) fail('file_auth_required');
}
const unchangedFile = (a, b) => a.ino === b.ino && a.dev === b.dev && a.size === b.size
  && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.mode === b.mode && a.uid === b.uid && a.nlink === b.nlink;

/** Conservative store detection, NOT a TOML parser. Profiles/dotted keys,
 * duplicates, multiline strings and escaped key spellings are ambiguous.
 * Only absent/default or one literal root-level file setting is exportable. */
function requireFileStore(config) {
  if (/'''|"""/.test(config)) fail('file_auth_required');
  let section = false, seen = false;
  for (const line of config.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('[')) { section = true; continue; }
    const key = line.split('=')[0];
    if (key.includes('\\')) fail('file_auth_required');
    if (!key.includes('cli_auth_credentials_store')) continue;
    if (section || seen || !/^\s*(?:cli_auth_credentials_store|["']cli_auth_credentials_store["'])\s*=\s*["']file["']\s*(?:#.*)?$/.test(line)) fail('file_auth_required');
    seen = true;
  }
}

async function readFileAuth(home, options) {
  const platform = options.platform ?? process.platform;
  let handle, guard;
  try {
    // A non-file store can leave a stale auth.json behind. Never export that
    // stale copy as if it were the actual native login. Unknown TOML is refused.
    let config = '';
    try {
      const file = join(home, 'config.toml');
      if ((await lstat(file)).size > 128_000) fail('unsupported_auth');
      config = await readFile(file, 'utf8');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    requireFileStore(config);
    const file = join(home, 'auth.json');
    if (platform === 'win32') guard = await holdWindowsPrivatePath(file, { ...options, kind: 'file' });
    const before = await lstat(file);
    privateAuthFile(before, platform);
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    privateAuthFile(opened, platform);
    if (!unchangedFile(opened, before)) fail('file_auth_required');
    // Bounded even if the file grows after stat.
    const bytes = Buffer.alloc(AUTH_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat(), pathAfter = await lstat(file);
    privateAuthFile(after, platform);
    if (bytesRead > AUTH_MAX_BYTES || bytesRead !== opened.size || !unchangedFile(opened, after) || !unchangedFile(opened, pathAfter)) fail('file_auth_required');
    if (guard && !guard.valid()) fail('file_auth_required');
    return chatgptAuth(JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')));
  } catch (error) {
    if (['file_auth_required', 'unsupported_auth'].includes(error.code)) throw error;
    fail('file_auth_required');
  } finally { try { await handle?.close(); } finally { await guard?.release(); } }
}

/** Called only by explicit POST export, against opaque registered profile IDs. */
export async function createCodexShare({ ids } = {}, options = {}) {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > CODEX_SHARE_MAX_ACCOUNTS
    || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !/^[a-f0-9]{20}$/.test(id))) fail('invalid_profiles');
  const selection = await readCodexSelection(options);
  const profiles = ids.map(id => selection.profiles.find(profile => profile.id === id));
  if (profiles.some(profile => !profile)) fail('unknown_profile');
  const accounts = [];
  for (const profile of profiles) {
    const label = selection.profileLabels.find(entry => entry.id === profile.id)?.label ?? null;
    accounts.push({ label, auth: await readFileAuth(profile.home, options) });
  }
  const blob = CODEX_SHARE_PREFIX + Buffer.from(JSON.stringify({ version: 1, provider: 'codex', accounts })).toString('base64url');
  if (blob.length > CODEX_SHARE_MAX_LENGTH) fail('share_too_large');
  return { ok: true, blob, count: accounts.length };
}

function parseShare(blob) {
  if (typeof blob !== 'string' || blob.length > CODEX_SHARE_MAX_LENGTH) fail('invalid_share');
  const code = blob.trim();
  if (!code.startsWith(CODEX_SHARE_PREFIX)) fail('invalid_share');
  const encoded = code.slice(CODEX_SHARE_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) fail('invalid_share');
  let payload;
  try {
    const decoded = Buffer.from(encoded, 'base64url');
    if (decoded.toString('base64url') !== encoded) fail('invalid_share');
    payload = JSON.parse(decoded.toString('utf8'));
  } catch { fail('invalid_share'); }
  if (!keys(payload, ['version', 'provider', 'accounts']) || payload.version !== 1 || payload.provider !== 'codex'
    || !Array.isArray(payload.accounts) || payload.accounts.length < 1 || payload.accounts.length > CODEX_SHARE_MAX_ACCOUNTS) fail('invalid_share');
  return payload.accounts.map(entry => {
    if (!keys(entry, ['label', 'auth']) || !safeLabel(entry.label)) fail('invalid_share');
    const auth = chatgptAuth(entry.auth);
    // Exact credential dedup only. No unsigned JWT claim is used as authority
    // to replace another account's login or suppress a different credential.
    const fingerprint = createHash('sha256').update(auth.tokens.refresh_token).digest('hex');
    return { label: entry.label, auth, fingerprint };
  });
}

/** The logins a share carries, validated as an import validates them, without
 *  touching disk: Local network reads who a login is before it lands. */
export function readCodexShare(blob) { return parseShare(blob); }

/** Put the one login a share carries into a registered profile's home in place
 *  of the login there — only while `stillDead(auth)` says that login is still
 *  the one the caller proved superseded. The check and the write happen under
 *  the registry lock every sign-in and move of this deck takes, so a sign-in
 *  that lands meanwhile is never overwritten. Local network's heal, and only
 *  that: an import never replaces anything (see importCodexShare). */
export async function replaceCodexLoginFromShare({ blob, id, stillDead } = {}, options = {}) {
  const entries = parseShare(blob);
  if (entries.length !== 1 || typeof stillDead !== 'function') fail('invalid_share');
  return withCodexProfileLocked({ id }, async home => {
    const target = join(home, 'auth.json');
    let current = null;
    try {
      const info = await lstat(target);
      if (info.isFile() && info.size <= AUTH_MAX_BYTES) current = JSON.parse(await readFile(target, 'utf8'));
    } catch { /* no login there to replace */ }
    if (!current || !stillDead(current)) fail('login_changed');
    let tmp, guard;
    try {
      // ON WINDOWS ONLY INTO A PRIVATE FOLDER, by the rule secureCodexImportHome
      // states: a profile that arrived over the network has one, while a folder
      // made by a plain mkdir (a sign-in profile, or ~/.codex) does not and is
      // refused here rather than repaired — its permissions are never changed.
      if ((options.platform ?? process.platform) === 'win32') guard = await holdWindowsPrivatePath(home, { ...options, kind: 'directory' });
      const staged = await createTemp(target, { mode: 0o600 });
      tmp = staged.tmp;
      try { await staged.handle.writeFile(JSON.stringify(entries[0].auth) + '\n'); await staged.handle.sync(); }
      finally { await staged.handle.close(); }
      await chmod(tmp, 0o600);
      if (guard && !guard.valid()) fail('windows_permissions_failed');
      await renameWithRetry(tmp, target);
      tmp = null;
    } catch (error) {
      if (tmp) await unlink(tmp).catch(() => {});
      if (error.code === 'windows_permissions_failed' || error.code === 'windows_private_path_unsafe') fail('windows_permissions_failed');
      fail('import_write_failed');
    } finally { await guard?.release(); }
    return { ok: true, home };
  }, options);
}

/** The common Windows helper creates the directory with its protected DACL
 * atomically. Never stage a secret into a directory created by plain mkdir on
 * Windows; chmod there controls read-only, not confidentiality. */
export async function secureCodexImportHome(home, options = {}) {
  if ((options.platform ?? process.platform) !== 'win32') { await mkdir(home, { mode: 0o700 }); return; }
  try { await ensureWindowsPrivateDirectory(home, options); }
  catch { fail('windows_permissions_failed'); }
}

export async function importCodexShare({ blob, expectedRevision } = {}, options = {}) {
  const entries = parseShare(blob); // validate the entire batch before touching disk
  const metadata = entries.map(({ label, fingerprint }) => ({ label, fingerprint }));
  const result = await importCodexProfiles({ entries: metadata, expectedRevision }, async (home, index) => {
    let tmp, guard;
    try {
      await secureCodexImportHome(home, options);
      if ((options.platform ?? process.platform) === 'win32') guard = await holdWindowsPrivatePath(home, { ...options, kind: 'directory' });
      const target = join(home, 'auth.json');
      const staged = await createTemp(target, { mode: 0o600 });
      tmp = staged.tmp;
      try { await staged.handle.writeFile(JSON.stringify(entries[index].auth) + '\n'); await staged.handle.sync(); }
      finally { await staged.handle.close(); }
      await chmod(tmp, 0o600);
      await renameWithRetry(tmp, target);
      // Keep the Windows directory pinned until the registry commit completes.
      return guard;
    } catch (error) {
      await guard?.release();
      if (tmp) await unlink(tmp).catch(() => {});
      if (error.code === 'windows_permissions_failed' || error.code === 'windows_private_path_unsafe') fail('windows_permissions_failed');
      fail('import_write_failed');
    }
  }, options);
  return { ok: true, ...result };
}
