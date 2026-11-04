// The surfaces a real deck counts (usage-surfaces.test.ts has the rules): a
// page on /events is the desktop window or a browser tab by its User-Agent, the
// app's tray connection is neither, and `x-ccdeck-client: tui` counts only on a
// request that carries the deck's token. Reports are off for the whole suite
// (no-lan.ts), so nothing here leaves the machine.
//
// The cases run in order against one deck and one day's tally: each says what
// it adds, so the ones that must add nothing go first.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { request, type ClientRequest, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-usage-surfaces-"));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.XDG_CONFIG_HOME = join(DIR, "config");
if (!resolve(process.env.CLAUDE_CONFIG_DIR).startsWith(resolve(DIR))) throw new Error("sandbox escaped");

const mod = await import("../../server/index.mjs");
// @ts-expect-error — plain JS module, no types
const { usageDay } = await import("../../server/usage-day.mjs");
// @ts-expect-error — plain JS module, no types
const { askDeck } = await import("../../server/deck-client.mjs");
const token = (): string => mod.hookToken();

const CHROME = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const APP = `${CHROME} Electron/38.0.0 ccdeck-desktop/3.81.2`;
const SURFACES = ["desktop-window", "browser-tab", "tui"];

let server: Server;
let port = 0;
const open: Array<{ req: ClientRequest; res?: IncomingMessage }> = [];

beforeAll(async () => {
  server = await mod.startServer({ port: 0, persist: false, open: false, claude: false, codex: false });
  port = (server.address() as { port: number }).port;
}, 30_000);
afterAll(async () => {
  for (const s of open.splice(0)) { s.res?.destroy(); s.req.destroy(); }
  await new Promise(done => server.close(done));
  rmTempDir(DIR);
});

/** The surfaces today's tally holds. */
const surfaces = (): string[] => (usageDay.saved().current?.features ?? []).filter((f: string) => SURFACES.includes(f));

/** An /events stream, open until the end of the file, resolved once the deck
 *  has said the replay is done — by then the connection is counted. */
function connect(path: string, headers: Record<string, string>): Promise<void> {
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", headers: { accept: "text/event-stream", ...headers } }, res => {
      open.push({ req, res });
      let text = "";
      res.setEncoding("utf8");
      res.on("data", chunk => {
        text += chunk;
        if (text.includes("event: replay-end")) done();
      });
    });
    req.on("error", fail);
    req.end();
  });
}

describe("what a deck counts as looked at", () => {
  it("does not count the desktop app's tray connection", async () => {
    await connect("/events?role=tray", { "user-agent": "node", "x-ccdeck-token": token() });
    expect(surfaces()).toEqual([]);
  });

  it("does not count a tui header without the deck's token, or a value that is not tui", async () => {
    expect((await askDeck({ port, token: "" }, { path: "/api/version", client: "tui" })).status).toBeGreaterThan(0);
    for (const client of ["vscode", "browser-tab"]) {
      expect((await askDeck({ port, token: token() }, { path: "/api/version", client })).ok).toBe(true);
    }
    // And a command that names no client, as every one but `ccdeck tui` does.
    expect((await askDeck({ port, token: token() }, { path: "/api/version" })).ok).toBe(true);
    expect(surfaces()).toEqual([]);
  });

  it("counts `ccdeck tui` on a request with the deck's token", async () => {
    expect((await askDeck({ port, token: token() }, { path: "/api/version", client: "tui" })).ok).toBe(true);
    expect(surfaces()).toEqual(["tui"]);
  });

  it("counts the app's window by its user agent", async () => {
    await connect("/events", { "user-agent": APP, "x-ccdeck-token": token() });
    expect(surfaces()).toEqual(["desktop-window", "tui"]);
  });

  it("counts any other page as a browser tab", async () => {
    await connect("/events", { "user-agent": CHROME, "x-ccdeck-token": token() });
    expect(surfaces()).toEqual(["desktop-window", "browser-tab", "tui"]);
  });
});
