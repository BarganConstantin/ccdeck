// Codex keeps conversation titles in a separate append-only index, not in
// the rollout. Read its bounded tail once per home and retain no prompts.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

export const CODEX_NAMES_BYTES = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createCodexNameReader() {
  const homes = new Map();
  return async function names(home, now = Date.now()) {
    const old = homes.get(home);
    if (old && now >= old.checked && now - old.checked < 1000) return old.names;
    let file;
    try {
      file = await open(join(home, 'session_index.jsonl'), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = await file.stat();
      if (!stat.isFile()) return new Map();
      const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
      if (old?.stamp === stamp) { old.checked = now; return old.names; }
      const size = Math.min(stat.size, CODEX_NAMES_BYTES);
      const from = stat.size - size;
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await file.read(buffer, 0, size, from);
      const text = buffer.subarray(0, bytesRead).toString('utf8');
      const lines = text.split('\n');
      if (from > 0) lines.shift();
      lines.pop(); // an incomplete last append is not an index record
      const result = new Map();
      for (const line of lines) {
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        if (!UUID.test(row?.id ?? '') || typeof row.thread_name !== 'string') continue;
        const name = row.thread_name.trim();
        if (!name || name.length > 160 || /[\u0000-\u001f\u007f]/.test(name)) continue;
        const id = row.id.toLowerCase();
        result.delete(id); result.set(id, name);
        while (result.size > 512) result.delete(result.keys().next().value);
      }
      homes.delete(home); homes.set(home, { stamp, checked: now, names: result });
      while (homes.size > 32) homes.delete(homes.keys().next().value);
      return result;
    } catch { return old?.names ?? new Map(); }
    finally { await file?.close(); }
  };
}

export const readCodexNames = createCodexNameReader();
