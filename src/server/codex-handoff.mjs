// A transferred rollout contains history the deck already observed in another
// home. New watcher cursors start after that prefix, not by replaying its tools.
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
export const codexHandoffPath = path => `${path}.ccdeck-handoff.json`;
export async function codexHandoffOffset(path, sid, size) {
  let marker, rollout;
  try {
    marker = await open(codexHandoffPath(path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if ((await marker.stat()).size > 512) return 0;
    const value = JSON.parse(await marker.readFile('utf8'));
    if (value.version !== 1 || value.threadId !== sid || !Number.isSafeInteger(value.copiedBytes)
      || value.copiedBytes <= 0 || value.copiedBytes > Math.min(size, 64 * 1024 * 1024)) return 0;
    rollout = await open(path, 'r');
    const boundary = Buffer.alloc(1);
    await rollout.read(boundary, 0, 1, value.copiedBytes - 1);
    return boundary[0] === 10 ? value.copiedBytes : 0;
  } catch { return 0; }
  finally { await marker?.close(); await rollout?.close(); }
}
