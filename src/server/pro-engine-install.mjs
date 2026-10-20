// Optional local executable verification. No downloads or public runtime deps.
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, createPublicKey, verify } from 'node:crypto';

export const ENGINE_PROTOCOL = 1;
export const ENGINE_MAX_FRAME = 2 * 1024 * 1024;
const TARGETS = { 'darwin-x64': 'x86_64-apple-darwin', 'darwin-arm64': 'aarch64-apple-darwin', 'linux-x64': 'x86_64-unknown-linux-gnu', 'linux-arm64': 'aarch64-unknown-linux-gnu' };
const invalid = () => new Error('The installed terminal engine could not be verified.');
function owned(stat, executable = false) {
  return stat.uid === process.getuid() && !(stat.mode & 0o022) && (!executable || !!(stat.mode & 0o100));
}
async function readOwned(file, limit, executable = false) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || !owned(before, executable) || before.size > limit || before.size < 1) throw invalid();
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

/** A trusted owner-provided Ed25519 public key, never browser/request input. */
export async function verifyEngineInstallation({ directory, publicKey }) {
  try {
    const target = TARGETS[`${process.platform}-${process.arch}`];
    // Windows ACL/identity verification is provided by the native-platform gate.
    if (!target || typeof process.getuid !== 'function' || process.getuid() === 0) throw invalid();
    const root = await fs.realpath(directory);
    const rootStat = await fs.lstat(root);
    if (!rootStat.isDirectory() || !owned(rootStat) || (rootStat.mode & 0o077)) throw invalid();
    let ancestor = path.dirname(root);
    while (true) {
      const s = await fs.stat(ancestor);
      if ((s.mode & 0o022) && !(s.mode & 0o1000)) throw invalid();
      const parent = path.dirname(ancestor); if (parent === ancestor) break; ancestor = parent;
    }
    const { data: manifestBytes } = await readOwned(path.join(root, 'manifest.json'), 16 * 1024);
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    if (!manifest || Object.keys(manifest).sort().join(',') !== 'payload,signature' || typeof manifest.payload !== 'string' || typeof manifest.signature !== 'string') throw invalid();
    const key = createPublicKey(publicKey);
    if (key.asymmetricKeyType !== 'ed25519') throw invalid();
    const payload = Buffer.from(manifest.payload, 'base64');
    const signature = Buffer.from(manifest.signature, 'base64');
    if (payload.toString('base64') !== manifest.payload || signature.toString('base64') !== manifest.signature || !verify(null, payload, key, signature)) throw invalid();
    const entry = JSON.parse(payload.toString('utf8'));
    if (!entry || Object.keys(entry).sort().join(',') !== 'file,protocol,sha256,size,target,version' || entry.protocol !== ENGINE_PROTOCOL || entry.target !== target || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > 128 * 1024 * 1024 || typeof entry.version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?$/.test(entry.version) || !/^ccdeck-pro-engine(?:-[a-zA-Z0-9.-]+)?$/.test(entry.file)) throw invalid();
    const executable = path.join(root, entry.file);
    const { data, stat } = await readOwned(executable, entry.size, true);
    if (stat.size !== entry.size || createHash('sha256').update(data).digest('hex') !== entry.sha256) throw invalid();
    return Object.freeze({ executable, digest: entry.sha256, target, version: entry.version });
  } catch { throw invalid(); }
}
