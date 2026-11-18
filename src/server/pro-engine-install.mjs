// Optional local executable verification. No downloads or public runtime deps.
//
// TWO CALLERS, ONE SET OF RULES. verifyEngineInstallation checks the folder the
// engine runs from (`<deck data folder>/engine`). engine-package.mjs checks the
// platform package the engine arrives in before copying it there, with the
// same signed-manifest, size, hash and file-reading rules (the exports below),
// so a file is held to one standard before and after the copy.
//
// UNIX: the folder and files belong to the user (a package source may also
// belong to root, since a global install is often made by it), nobody else may
// write them, and root is refused as a user of the engine. Nobody else may
// write a folder above them either, since the engine is started by its path
// after the check; on Linux a folder only the user's own group may write is
// the user's alone (ownGroup).
//
// WINDOWS: the ownership and mode bits mean nothing there, so the same
// questions are put to an ACL reader the caller hands in (`windowsAcl`): who
// owns it, who may write it, whether it is a reparse point or has a second hard
// link, and whether this process is elevated. A caller may hand one in; without
// one the gate builds the deck's own (windows-acl.mjs); Windows is offered by
// ENGINE_ON_WINDOWS (engine-package.mjs). The rules below are written against a reader's answers and have been run against
// a test double and, in CI only, the real reader.
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { createWindowsAcl } from './windows-acl.mjs';
import { PRODUCT } from './brand.mjs';

export const ENGINE_PROTOCOL = 1;
export const ENGINE_MAX_FRAME = 2 * 1024 * 1024;
export const ENGINE_MAX_BYTES = 128 * 1024 * 1024;
export const ENGINE_MANIFEST_MAX = 16 * 1024;
export const TARGETS = {
  'darwin-x64': 'x86_64-apple-darwin', 'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-gnu', 'linux-arm64': 'aarch64-unknown-linux-gnu',
  'win32-x64': 'x86_64-pc-windows-msvc',
};
/** Who may not hold write access to anything the engine runs from on Windows:
 *  by the names and by the well-known identifiers Windows gives the same
 *  groups (Everyone, Authenticated Users, Users). */
const WINDOWS_WRITERS_REFUSED = /^(?:everyone|authenticated users|users|builtin\\users|nt authority\\authenticated users|s-1-1-0|s-1-5-11|s-1-5-32-545)$/i;
const invalid = () => new Error('The installed terminal engine could not be verified.');

/** The one refusal that carries a code: a folder above the engine that other
 *  accounts can change (refuseFolder). The page then says which check it was,
 *  not that the signature failed; the folder itself goes to the log alone. */
export const UNSAFE_FOLDER = 'unsafe-folder';
const folderRefused = () => Object.assign(invalid(), { code: UNSAFE_FOLDER });

/** Where Linux keeps who has which primary group, and who else is in a group. */
const ACCOUNT_FILES = Object.freeze({ passwd: '/etc/passwd', group: '/etc/group' });

/** The lines of an account file with `fields` fields each, comments and blank
 *  lines left out as the C library leaves them. Throws for a line these rules
 *  cannot read and for a `+` or `-` line, which pulls accounts in from NIS. */
async function accountRows(file, fields) {
  const rows = [];
  for (const raw of (await fs.readFile(file, 'utf8')).split('\n')) {
    const line = raw.trimStart();
    if (!line || line.startsWith('#')) continue;
    const row = line.split(':');
    if (row.length !== fields || /^[+-]/.test(row[0]) || !/^[0-9]+$/.test(row[2]) || (fields === 7 && !/^[0-9]+$/.test(row[3]))) throw invalid();
    rows.push(row);
  }
  return rows;
}

/**
 * Whether `gid` is the user's own group, so that a folder only it may write is
 * a folder only the user may write. Ubuntu, Debian and Fedora make a group of
 * the user's name for each user (useradd's USERGROUPS_ENAB) and give them a
 * umask of 002, so the folders their programs make are 0775: the ~/.local the
 * deck or an installer made first, a second Claude profile CLAUDE_CONFIG_DIR
 * names. Read as "others may write", every engine under them was refused.
 *
 * It is the user's own only when /etc/passwd and /etc/group say so with
 * nothing left over: it is this process's group and the primary group of the
 * user's own entry, no other account has it as theirs or shares the user's
 * name, and no entry for it in /etc/group names anybody else. Either file
 * unreadable, the user or the group not in it (an account from LDAP or another
 * directory, whose groups these files do not hold), or a line these rules
 * cannot read, and it is not: refused as it always was. Linux only: macOS
 * gives every user one shared group.
 */
async function ownGroup(uid, gid) {
  if (typeof process.getgid !== 'function' || gid !== process.getgid()) return false;
  try {
    const [users, groups] = await Promise.all([accountRows(ACCOUNT_FILES.passwd, 7), accountRows(ACCOUNT_FILES.group, 4)]);
    const mine = users.filter(row => Number(row[2]) === uid);
    const names = new Set(mine.map(row => row[0]));
    const entries = groups.filter(row => Number(row[2]) === gid);
    return mine.length > 0 && mine.every(row => Number(row[3]) === gid)
      && users.every(row => (Number(row[3]) !== gid && !names.has(row[0])) || Number(row[2]) === uid)
      && entries.length > 0 && entries.every(row => row[3].split(',').map(name => name.trim()).every(name => !name || names.has(name)));
  } catch {
    return false;
  }
}

// Each folder the deck's log has named, so a status read every few hundred
// milliseconds names it once.
const named = new Set();

/** Refuses the engine for a folder above it that someone else may change, and
 *  says once in the deck's log which folder and what would let it run. The
 *  path goes to the log only, never to the page: a route's body is readable by
 *  a DNS-rebound page, and a path names the user. The page gets the code
 *  alone (UNSAFE_FOLDER). */
function refuseFolder(folder, ownedByOther) {
  const key = `${ownedByOther ? 'owner' : 'write'} ${folder}`;
  if (!named.has(key)) {
    named.add(key);
    const quoted = `'${folder.replaceAll("'", "'\\''")}'`;
    console.error(ownedByOther
      ? `${PRODUCT}: terminal: the engine is refused: ${folder}, a folder above it, belongs to another account, which could replace it. Set CCDECK_HOME to a folder under your own.`
      : `${PRODUCT}: terminal: the engine is refused: other accounts can write ${folder}, a folder above it, and could replace it. If nobody else should: chmod go-w ${quoted}`);
  }
  throw folderRefused();
}

/**
 * What a file or folder must be to be trusted, for `platform`. Unix asks the
 * file's own stat; Windows asks `windowsAcl`:
 *   `identity()`      -> `{ user, elevated }`, the user this process runs as;
 *   `inspect(path)`   -> `{ owner, writers: [names or SIDs that may write], reparsePoint, links }`.
 * Resolves to `{ directory(path, stat), file(path, stat, executable) }`, each
 * throwing when the answer is no. `allowRoot` also accepts root as the owner
 * of a Unix package source, and `allowGroupWrite` its group's write bit:
 * npm writes a package under the user's umask, and the usual 002 leaves files
 * 664 and folders 775. That is safe for a source only, because what is
 * installed is the bytes read once and checked against the signed manifest,
 * never the file as it stands later. Write by others is refused either way.
 */
export async function trustGate({ platform = process.platform, windowsAcl, allowRoot = false, allowGroupWrite = false, uid } = {}) {
  if (platform === 'win32') {
    windowsAcl ??= createWindowsAcl();
    if (typeof windowsAcl.identity !== 'function' || typeof windowsAcl.inspect !== 'function') throw invalid();
    const me = await windowsAcl.identity();
    if (!me || me.elevated !== false || typeof me.user !== 'string' || !me.user) throw invalid();
    const check = async (target, stat, isFile) => {
      const info = await windowsAcl.inspect(target);
      if (!info || info.owner !== me.user || info.reparsePoint !== false || !Array.isArray(info.writers)) throw invalid();
      if (info.writers.some(name => WINDOWS_WRITERS_REFUSED.test(String(name)))) throw invalid();
      if (isFile && (info.links !== 1 || (stat.nlink ?? 1) > 1)) throw invalid();
    };
    return { directory: (target, stat) => check(target, stat, false), file: (target, stat) => check(target, stat, true) };
  }
  const me = uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
  if (me === undefined || me === 0) throw invalid();
  const owners = allowRoot ? [me, 0] : [me];
  const writers = allowGroupWrite ? 0o002 : 0o022;
  const owned = (stat, executable) => owners.includes(stat.uid) && !(stat.mode & writers) && (!executable || !!(stat.mode & 0o100));
  return {
    directory: async (_target, stat) => { if (!owned(stat, false)) throw invalid(); },
    file: async (_target, stat, executable) => { if (!owned(stat, executable)) throw invalid(); },
    me,
  };
}

/** Reads `file` through O_NOFOLLOW, bounded, refusing a link, a non-file, a
 *  file the gate does not trust, an empty or oversized one, and one that
 *  changed while it was read. */
export async function readTrusted(file, limit, gate, executable = false) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > limit || before.size < 1) throw invalid();
    await gate.file(file, before, executable);
    // Bound reads even if a concurrent writer grows the file after fstat.
    const buffer = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const data = buffer.subarray(0, offset);
    const after = await handle.stat();
    if (data.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw invalid();
    return { data, stat: after };
  } finally { await handle.close(); }
}

/** The signed entry of a manifest's bytes, once its envelope, signature (by
 *  any of `keys`) and six fields are right for `target`. Throws otherwise. */
export function signedEntry(manifestBytes, keys, target, platform = process.platform) {
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (!manifest || Object.keys(manifest).sort().join(',') !== 'payload,signature' || typeof manifest.payload !== 'string' || typeof manifest.signature !== 'string') throw invalid();
  const trusted = keys.map(key => createPublicKey(key));
  if (trusted.some(key => key.asymmetricKeyType !== 'ed25519')) throw invalid();
  const payload = Buffer.from(manifest.payload, 'base64');
  const signature = Buffer.from(manifest.signature, 'base64');
  if (payload.toString('base64') !== manifest.payload || signature.toString('base64') !== manifest.signature || !trusted.some(key => verify(null, payload, key, signature))) throw invalid();
  const entry = JSON.parse(payload.toString('utf8'));
  const name = platform === 'win32' ? /^ccdeck-pro-engine(?:-[a-zA-Z0-9.-]+)?\.exe$/ : /^ccdeck-pro-engine(?:-[a-zA-Z0-9.-]+)?$/;
  if (!entry || Object.keys(entry).sort().join(',') !== 'file,protocol,sha256,size,target,version' || entry.protocol !== ENGINE_PROTOCOL || entry.target !== target || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > ENGINE_MAX_BYTES || typeof entry.version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?$/.test(entry.version) || !name.test(entry.file)) throw invalid();
  return entry;
}

/** The version text split as SemVer 2.0 does, or an error for anything else. */
function parseVersion(text) {
  const m = /^([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([a-zA-Z0-9.-]+))?(?:\+[a-zA-Z0-9.-]+)?$/.exec(typeof text === 'string' ? text : '');
  if (!m) throw invalid();
  return { core: m.slice(1, 4).map(BigInt), pre: m[4] === undefined ? [] : m[4].split('.') };
}

/** SemVer 2.0 precedence of two versions (-1, 0, 1), build metadata ignored.
 *  Throws for a text that is not a version, so a bad floor refuses everything. */
export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return Math.sign(y.pre.length - x.pre.length);
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === q) continue;
    const pn = /^[0-9]+$/.test(p), qn = /^[0-9]+$/.test(q);
    if (pn && qn) return BigInt(p) < BigInt(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return Math.sign(x.pre.length - y.pre.length);
}

/** Whether the executable's header says it is for `platform` and `arch`: ELF
 *  (64-bit, little-endian) on Linux, a thin 64-bit Mach-O on macOS, a PE image
 *  on Windows, each with the machine of that arch. Anything else, a script, a
 *  universal binary or a different machine, is no. */
export function executableMatchesMachine(bytes, platform = process.platform, arch = process.arch) {
  if (!Buffer.isBuffer(bytes)) return false;
  if (platform === 'linux') {
    const machine = { x64: 62, arm64: 183 }[arch];
    return bytes.length >= 20 && bytes.readUInt32BE(0) === 0x7f454c46 && bytes[4] === 2 && bytes[5] === 1 && bytes.readUInt16LE(18) === machine;
  }
  if (platform === 'darwin') {
    const cpu = { x64: 0x01000007, arm64: 0x0100000c }[arch];
    return bytes.length >= 8 && bytes.readUInt32LE(0) === 0xfeedfacf && bytes.readUInt32LE(4) === cpu;
  }
  if (platform === 'win32') {
    const machine = { x64: 0x8664, arm64: 0xaa64 }[arch];
    if (bytes.length < 0x40 || bytes.readUInt16BE(0) !== 0x4d5a) return false;
    const at = bytes.readUInt32LE(0x3c);
    return at <= bytes.length - 6 && bytes.readUInt32BE(at) === 0x50450000 && bytes.readUInt16LE(at + 4) === machine;
  }
  return false;
}

/** Trusted Ed25519 public keys — one, or a list any of which may have signed
 *  the manifest — from the host, never browser/request input. An empty list
 *  trusts nothing, and is refused before anything is read.
 *
 *  `minimumVersion`, host configuration too, is the lowest engine version the
 *  host accepts: an older one, however validly signed, is refused before it
 *  runs, and a `minimumVersion` that is not a version refuses every engine.
 *  `windowsAcl` is the Windows reader described at the top; `platform` and
 *  `arch` are there for tests. */
export async function verifyEngineInstallation({ directory, publicKey, minimumVersion, windowsAcl, platform = process.platform, arch = process.arch }) {
  const keys = Array.isArray(publicKey) ? publicKey : [publicKey];
  if (keys.length === 0) throw invalid();
  try {
    const target = TARGETS[`${platform}-${arch}`];
    if (!target) throw invalid();
    const gate = await trustGate({ platform, windowsAcl });
    const root = await fs.realpath(directory);
    const rootStat = await fs.lstat(root);
    if (!rootStat.isDirectory()) throw invalid();
    await gate.directory(root, rootStat);
    if (platform !== 'win32') {
      if (rootStat.mode & 0o077) throw invalid();
      // Every folder above: the user's or root's, and writable by nobody else,
      // unless sticky (/tmp: nobody may rename what another made) or, on
      // Linux, writable by the user's own group alone. The account files are
      // read once, and only when a folder needs them.
      let alone;
      let ancestor = path.dirname(root);
      while (true) {
        const s = await fs.stat(ancestor);
        if (![0, gate.me].includes(s.uid)) refuseFolder(ancestor, true);
        if ((s.mode & 0o022) && !(s.mode & 0o1000)) {
          if (platform !== 'linux' || (s.mode & 0o002)) refuseFolder(ancestor, false);
          alone ??= ownGroup(gate.me, process.getgid());
          if (s.gid !== process.getgid() || !(await alone)) refuseFolder(ancestor, false);
        }
        const parent = path.dirname(ancestor); if (parent === ancestor) break; ancestor = parent;
      }
    }
    const { data: manifestBytes } = await readTrusted(path.join(root, 'manifest.json'), ENGINE_MANIFEST_MAX, gate);
    const entry = signedEntry(manifestBytes, keys, target, platform);
    if (minimumVersion !== undefined && compareVersions(entry.version, minimumVersion) < 0) throw invalid();
    const executable = path.join(root, entry.file);
    const { data, stat } = await readTrusted(executable, entry.size, gate, true);
    if (stat.size !== entry.size || createHash('sha256').update(data).digest('hex') !== entry.sha256) throw invalid();
    return Object.freeze({ executable, digest: entry.sha256, target, version: entry.version });
  } catch (error) { throw error?.code === UNSAFE_FOLDER ? folderRefused() : invalid(); }
}
