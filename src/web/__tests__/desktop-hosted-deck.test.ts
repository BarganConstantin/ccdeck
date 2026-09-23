// The deck the desktop app starts, and the tray's connection to it (#1176).
//
// Three things had no case at all. The environment `startDeck` hands the deck
// is the whole contract between the app and the deck it hosts: drop
// ELECTRON_RUN_AS_NODE and the app's binary opens a second window instead of
// running the supervisor; drop AGENTS_DECK_DETACHED and the supervisor forks
// itself into the background and the app holds nothing; drop CCDECK_APP and the
// deck starts installing a global npm copy the app never runs; drop
// CCDECK_HOOK_RUNTIME and every Claude Code hook runs `<the app> hook.js`,
// which opens the app. `deck-link.mjs` — every byte between the tray and the
// deck — was imported by no test in the suite. And the opt-out CCDECK_APP
// stands for was pinned only as a boolean on its own, never where it is read.
import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
import { startDeck } from "../../../desktop/deck-host.mjs";
import { deckJson, openTrayStream, parseSse } from "../../../desktop/deck-link.mjs";
import { upgradeBlock, versionReport } from "../../server/self-update.mjs";

const temps: string[] = [];
const servers: Server[] = [];
const newTemp = (name: string) => {
  const dir = mkdtempSync(join(tmpdir(), `ccdeck-${name}-`));
  temps.push(dir);
  return dir;
};

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const dir of temps.splice(0)) rmTempDir(dir);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** A server on 127.0.0.1, and the `deck` object deck-link talks to it with. */
async function fakeDeck(handler: Parameters<typeof createServer>[1]) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };
  return { deck: { port, token: "tok-en", pid: 1 }, server };
}

describe("the deck the app starts", () => {
  it("is run as Node, already detached, told the app hosts it, and given the hook's launcher", async () => {
    const deckRoot = newTemp("deck-root");
    const out = join(deckRoot, "seen.json");
    mkdirSync(join(deckRoot, "bin"));
    // Stands in for the supervisor: it records what it was started with.
    writeFileSync(join(deckRoot, "bin", "agent-dag.js"), [
      `const { writeFileSync } = require("node:fs");`,
      `writeFileSync(${JSON.stringify(out)}, JSON.stringify({`,
      `  argv: process.argv.slice(2), cwd: process.cwd(), env: process.env,`,
      `}));`,
      `process.stdout.write("deck said this\\n");`,
    ].join("\n"));
    const logFile = join(deckRoot, "deck.log");
    const launcher = join(deckRoot, "ccdeck-node");

    const child = startDeck({
      deckRoot,
      appBinary: process.execPath,
      logFile,
      path: "/usr/bin:/bin",
      launcher,
      env: { HOME: "/home/someone", ELECTRON_RUN_AS_NODE: undefined as unknown as string },
    });
    await new Promise(done => child.on("exit", done));

    const seen = JSON.parse(readFileSync(out, "utf8"));
    expect(seen.argv).toEqual(["--no-open"]);
    expect(seen.cwd.endsWith(deckRoot.replace(/^\/private/, ""))).toBe(true);
    expect(seen.env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(seen.env.AGENTS_DECK_DETACHED).toBe("1");
    expect(seen.env.CCDECK_APP).toBe("1");
    expect(seen.env.CCDECK_HOOK_RUNTIME).toBe(launcher);
    expect(seen.env.PATH).toBe("/usr/bin:/bin");
    // The app's own environment is carried, not replaced.
    expect(seen.env.HOME).toBe("/home/someone");
    // And its output is the log the app names, which is where anyone looking
    // for why a hosted deck did not start has to find it.
    expect(readFileSync(logFile, "utf8")).toContain("deck said this");
  });
});

describe("a deck the app hosts", () => {
  it("never installs a global copy of itself, whatever else is true of the install", () => {
    const pkgRoot = newTemp("pkg-root");
    writeFileSync(join(pkgRoot, "package.json"), JSON.stringify({ name: "ccdeck", version: "3.0.0" }));
    expect(upgradeBlock(pkgRoot)).not.toBe("opted_out");
    vi.stubEnv("CCDECK_APP", "1");
    expect(upgradeBlock(pkgRoot)).toBe("opted_out");
  });

  it("does not ask npm what the latest version is", async () => {
    const pkgRoot = newTemp("pkg-root-2");
    writeFileSync(join(pkgRoot, "package.json"), JSON.stringify({ name: "ccdeck", version: "3.0.0" }));
    const fetched: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      fetched.push(String(url));
      return Promise.reject(new Error("the registry must not be asked here"));
    });
    vi.stubEnv("CCDECK_APP", "1");
    const report = await versionReport({ running: "3.0.0", pkgRoot, now: Date.now(), force: true });
    expect(fetched).toEqual([]);
    expect(report.latest).toBeNull();
    // Not silence: the app's own updater is the one that answers this.
    expect(report.upgradeBlocked).toBe("opted_out");
    expect(report.upgradeMode).toBeNull();
  });
});

describe("the tray's connection to the deck", () => {
  it("reads whole frames and carries the unfinished tail into the next chunk", () => {
    const first = parseSse('event: hook\ndata: {"a":1}\n\n: ping\n\nevent: noti');
    expect(first.frames).toEqual([{ event: "hook", data: '{"a":1}', id: null }]);
    expect(first.rest).toBe("event: noti");
    const second = parseSse(`${first.rest}fy\ndata: {"title":"x"}\nid: 7\n\n`);
    expect(second.frames).toEqual([{ event: "notify", data: '{"title":"x"}', id: "7" }]);
    expect(second.rest).toBe("");
  });

  it("sends the deck's token with every call, and hands back what the deck said", async () => {
    const seen: { url?: string; method?: string; token?: string; body?: string }[] = [];
    const { deck } = await fakeDeck((req, res) => {
      let body = "";
      req.on("data", c => { body += c; });
      req.on("end", () => {
        seen.push({ url: req.url, method: req.method, token: String(req.headers["x-ccdeck-token"]), body });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    const answer = await deckJson(deck, "/api/restart", { method: "POST", body: { upgrade: false } });
    expect(answer).toEqual({ status: 200, json: { ok: true } });
    expect(seen).toEqual([{ url: "/api/restart", method: "POST", token: "tok-en", body: '{"upgrade":false}' }]);
  });

  it("subscribes as the tray, not as a page, and reports what it is told", async () => {
    const asked: { url?: string; token?: string; accept?: string }[] = [];
    const { deck } = await fakeDeck((req, res) => {
      asked.push({ url: req.url, token: String(req.headers["x-ccdeck-token"]), accept: String(req.headers.accept) });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('event: hook\ndata: {"seq":1}\n\n');
      res.write('event: replay-end\ndata: \n\n');
      res.write('event: notify\ndata: {"title":"agent","body":"waiting"}\n\n');
      res.write('event: desktop-update-restart\ndata: {"version":"3.28.0"}\n\n');
      res.write("event: hook\ndata: not json\n\n");
    });
    const hooks: unknown[] = [];
    const notices: unknown[] = [];
    const restarts: unknown[] = [];
    let connected = 0, live = 0;
    const stream = openTrayStream(deck, {
      connected: () => { connected++; },
      live: () => { live++; },
      hook: (e: unknown) => hooks.push(e),
      notify: (n: unknown) => notices.push(n),
      restartUpdate: (request: unknown) => restarts.push(request),
    });
    await vi.waitFor(() => expect(notices).toHaveLength(1));
    stream.close();

    // role=tray is the whole point: the deck counts this client as no page, so
    // a tray reading the board does not silence the closed-deck notifications.
    expect(asked).toEqual([{ url: "/events?role=tray", token: "tok-en", accept: "text/event-stream" }]);
    expect(connected).toBe(1);
    expect(live).toBe(1);
    expect(hooks).toEqual([{ seq: 1 }]);       // the unparseable frame is dropped, the stream is not
    expect(notices).toEqual([{ title: "agent", body: "waiting" }]);
    expect(restarts).toEqual([{ version: "3.28.0" }]);
  });

  it("keeps trying when the deck refuses the stream, and stops when it is closed", async () => {
    let attempts = 0;
    const { deck } = await fakeDeck((_req, res) => { attempts++; res.writeHead(401); res.end(); });
    let lost = 0;
    const stream = openTrayStream(deck, { lost: () => { lost++; } }, { retryMs: 10 });
    await vi.waitFor(() => expect(attempts).toBeGreaterThan(2));
    stream.close();
    expect(lost).toBeGreaterThan(0);
    // One retry may already be in flight when close() lands; what has to stop
    // is the loop, so the count is read after that one and then again.
    await new Promise(done => setTimeout(done, 80));
    const settled = attempts;
    await new Promise(done => setTimeout(done, 80));
    expect(attempts).toBe(settled);
  });
});
