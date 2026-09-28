// The discovery records of decks that are no longer running, removed as a
// deck starts.
//
// This lived in src/server/index.mjs, after the hook challenge; startServer
// calls it once, before it reads the log. Whether a record's process is alive
// is deck-probe.mjs's question. The body is unchanged.
import { readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { claudeConfigDir } from "./claude-dir.mjs";
import { isProcessAlive } from "./deck-probe.mjs";

export async function sweepStaleDiscovery() {
  // Same directory the installer writes and the hooks read — see claude-dir.mjs.
  const dir = join(claudeConfigDir(), "agent-dag");
  let files;
  try { files = await readdir(dir); } catch { return 0; }
  let removed = 0;
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const p = join(dir, f);
    try {
      const d = JSON.parse(await readFile(p, "utf8"));
      if (d && typeof d.pid === "number" && !isProcessAlive(d.pid)) {
        await unlink(p).catch(() => {});
        removed++;
      }
    } catch { /* corrupt — leave it */ }
  }
  return removed;
}
