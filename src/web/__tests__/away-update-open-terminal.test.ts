// An open terminal panel counts as somebody at the deck, so the away-update
// does not restart the deck under it.
//
// The away-update (auto-update.mjs, lifecycle.mjs) installs and restarts only
// while nobody is looking. A tab says it is looking only while it is visible
// AND holds focus (src/web/presence.ts), so a person reading an agent in the
// terminal panel while their keyboard is in another window was "nobody": the
// restart closed their socket with `server-shutdown`, the tickets died with the
// process, and whatever they typed before the panel reconnected went nowhere.
// lifecycle.mjs's deckPresence counts each open terminal socket as one more
// looking tab.
//
// These pin the rule on its own, the same rule over the real count of sockets
// a real upgrade admitted, and the wiring that hands it to the tick — the tick
// itself is not exported (dead-surface-993.test.ts), so its two reads are
// pinned in its source the way auto-update-away.test.ts pins the rest.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
import { openWs, type WsClient } from "./ws-test-client";

// Sandbox first, module import second: lifecycle.mjs reaches the prefs and
// the deck's directories, and the real ones must stay untouched.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-away-terminal-"));
const prevEnv = { ...process.env };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.CCDECK_HOME = join(DIR, "deck");
for (const p of [process.env.HOME, process.env.USERPROFILE, process.env.CLAUDE_CONFIG_DIR, process.env.CODEX_HOME, process.env.CCDECK_HOME]) {
  if (!resolve(p!).startsWith(resolve(DIR))) throw new Error(`sandbox escaped: ${p}`);
}

// @ts-expect-error — plain .mjs server module, no types
const { deckPresence } = await import("../../server/lifecycle.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { createPresence, PRESENCE_TTL_MS } = await import("../../server/presence.mjs");
// @ts-expect-error — plain .mjs server module, no types
const ts = await import("../../server/terminal-socket.mjs");

const T0 = 1_800_000_000_000;

describe("presence as the away-update reads it", () => {
  it("is a tab that says it is looking, until its claim runs out, as it always was", () => {
    const p = deckPresence(createPresence(), () => 0);
    expect(p.looking(T0), "nobody yet").toBe(false);
    expect(p.report("tab-1", true, T0)).toBe(true);
    expect(p.looking(T0 + 1_000)).toBe(true);
    expect(p.looking(T0 + PRESENCE_TTL_MS + 1), "a claim nobody renewed").toBe(false);
    expect(p.report("../not-a-tab", true, T0), "an id no page makes is still refused").toBe(false);
  });

  it("is an open terminal, with no tab looking at all", () => {
    let open = 1;
    const p = deckPresence(createPresence(), () => open);
    expect(p.looking(T0)).toBe(true);
    open = 0;
    expect(p.looking(T0), "and stops being one when the panel closes").toBe(false);
  });

  it("is not ended by a tab saying it stopped looking while its terminal is still open", () => {
    // The person moved their keyboard to another window; the panel is still
    // on screen and still connected to the agent.
    const p = deckPresence(createPresence(), () => 1);
    p.report("tab-1", true, T0);
    p.report("tab-1", false, T0 + 1_000);
    expect(p.looking(T0 + 1_000)).toBe(true);
  });
});

describe("over the sockets a real upgrade admitted", () => {
  let server: Server;
  let port = 0;
  const tickets = ts.createTicketStore();
  const clients: WsClient[] = [];

  beforeAll(async () => {
    server = createServer((_req, res) => { res.end("routed"); });
    ts.installTerminalUpgrade(server, {
      enabled: () => true,
      tickets,
      // The bridge is not what this is about: it answers nothing, and the
      // socket stays open until the client closes it.
      openBridge: () => ({ message() {}, closed() {}, shutdown() {} }),
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    for (const c of clients) c.socket.destroy();
    await new Promise(r => server.close(r));
    for (const k of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CCDECK_HOME"]) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
    rmTempDir(DIR);
  });

  it("says somebody is at the deck while a panel's socket is open, and not once it has closed", async () => {
    const p = deckPresence(createPresence(), ts.openTerminalCount);
    expect(p.looking(Date.now()), "no tab, no terminal").toBe(false);

    const origin = `http://127.0.0.1:${port}`;
    const ticket = tickets.mint({ kind: "A", pane: "%1", origin });
    const c = await openWs({
      port, path: `${ts.ATTACH_PATH}?ticket=${encodeURIComponent(ticket)}`,
      headers: { Host: `127.0.0.1:${port}`, Origin: origin, "Sec-Fetch-Site": "same-origin" },
    });
    clients.push(c);
    expect(c.status, c.head).toBe(101);
    expect(p.looking(Date.now()), "the panel is open and no tab has said a word").toBe(true);

    c.sendClose(1000);
    await c.closed;
    await vi.waitFor(() => expect(ts.openTerminalCount()).toBe(0));
    expect(p.looking(Date.now())).toBe(false);
  });
});

describe("the wiring", () => {
  const lifecycle = readFileSync(new URL("../../server/lifecycle.mjs", import.meta.url), "utf8");

  it("builds the away-update's presence from the tabs and the deck's own terminal count", () => {
    expect(lifecycle).toContain('import { openTerminalCount } from "./terminal-socket.mjs";');
    expect(lifecycle).toContain("const presence = deckPresence(createPresence(), openTerminalCount);");
  });

  it("asks it at both of the tick's checks, and feeds the tabs' claims into it", () => {
    const tick = lifecycle.slice(lifecycle.indexOf("async function awayUpdateTick()"));
    expect(tick).toContain("looking: presence.looking(now),");
    expect(tick).toContain("if (presence.looking(again) || activity.busy(again) || _restarting) return null;");
    expect(lifecycle).toContain("const ok = presence.report(body.tab, body.looking === true, Date.now());");
  });
});
