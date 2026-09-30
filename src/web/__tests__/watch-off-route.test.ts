// The badge's `live=0` poll, through the route a real deck answers it on —
// moved here from watch-off-reads-nothing.test.ts, which says why the flag
// exists.
//
// APART BECAUSE IT BOOTS A WHOLE DECK. Every file that imports browser-watch.mjs
// traps child_process (browser-watch-guard.ts, #1847), and a deck started here
// samples the machine the way every deck does: `vm_stat`, `ioreg` and `pmset` on
// a Mac, PowerShell on Windows. That is the Machine panel's work, not Browser
// Watch's, and the trap refused it. This case never reaches the browser survey:
// the watch is off and the poll says `live=0`, so the answer comes from the
// archive, and the case checks that it read no browser to give it.
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Sandboxed BEFORE the server module is imported: it resolves its config
// directories at import time, and the developer's own watch setting — this one
// is on — would otherwise decide what the case below sees.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-watch-off-"));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.XDG_CONFIG_HOME = join(DIR, "config");
if (!resolve(process.env.CLAUDE_CONFIG_DIR).startsWith(resolve(DIR))) throw new Error("sandbox escaped");
afterAll(() => rmTempDir(DIR));

describe("who asks for what", () => {
  it("reads the flag in the handler that answers this route", async () => {
    // NOT A GREP FOR THE LINE. The first version of this case asserted the
    // source contained `const readBrowsers = …`, and the line had been inserted
    // into handleQuota — a different handler that also parses `refresh` — so
    // the suite was green while every request to /api/browser-watch answered
    // `500 {"error":"internal error"}` with a ReferenceError behind it. A
    // source assertion cannot tell one handler from another; a request can.
    // OFF ON PURPOSE, which is the whole subject of this case. The watch ships
    // ON since 3.22.7, so a sandboxed home with no state.json is a watch that
    // is on — and the route would then read live for a reason that has nothing
    // to do with what is being tested here.
    const store = await import("../../server/browser-watch-store.mjs") as never;
    await store.writeStore({
      settings: { ...store.DEFAULTS, enabled: false }, episodes: [], dismissed: [],
    });
    const { startServer } = await import("../../server/index.mjs") as never;
    const server = await startServer({ port: 0, persist: false, open: false, claude: false, codex: false });
    const { port } = server.address() as { port: number };
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/browser-watch?live=0`, {
        headers: { "sec-fetch-site": "same-origin" },
      });
      expect(r.status, "the route answered an error").toBe(200);
      const body = await r.json() as {
        ok: boolean; settings: { enabled: boolean }; coverage?: { why?: string };
        profiles: unknown[]; browsers: unknown[]; relay: unknown;
      };
      expect(body.ok).toBe(true);
      // On a sandboxed home the watch is off, so `live=0` must be honoured and
      // the reason said out loud.
      expect(body.settings.enabled).toBe(false);
      expect(body.coverage?.why).toMatch(/watch is off/);
      // And no browser was read to answer: no profile, no survey, no relay.
      expect({ profiles: body.profiles, browsers: body.browsers, relay: body.relay })
        .toEqual({ profiles: [], browsers: [], relay: null });
    } finally {
      await new Promise(r => server.close(r));
    }
  }, 30_000);
});
