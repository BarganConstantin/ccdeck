// Where the deck was looked at from on a UTC day (usage-day.mjs, feature-use.mjs):
// the desktop app's window, a browser tab, or `ccdeck tui`, as three feature
// names on the daily "active" report.
//
// A window or a tab is connected for hours or days, not used at one moment, so
// it counts for every day it was connected on — including a day it was already
// open when it began. `ccdeck tui` says so in a header on the requests it makes,
// and only it: the one-shot commands send nothing new.
import { EventEmitter } from "node:events";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { describe, it, expect, afterAll, beforeAll } from "vitest";
// @ts-expect-error — plain JS module, no types
import { FEATURES, createUsageDay } from "../../server/usage-day.mjs";
// @ts-expect-error — plain JS module, no types
import { holdPageSurface, noteClientFeature, pageSurface } from "../../server/feature-use.mjs";
// @ts-expect-error — plain JS module, no types
import { askDeck } from "../../server/deck-client.mjs";
// @ts-expect-error — plain .js module, no types
const { deckSource } = await import("../../../bin/cli/tui.js");

const HOUR = 60 * 60_000;
const CHROME = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const APP = `${CHROME} Electron/38.0.0 ccdeck-desktop/3.81.2`;

/** A tally on a clock the test moves. */
function tally(start = "2026-11-04T22:00:00Z") {
  let at = new Date(start).getTime();
  const usage = createUsageDay({ now: () => new Date(at) });
  return {
    usage,
    advance: (ms: number) => { at += ms; },
    /** The day being counted now — rolled over first, as any reading does. */
    today: (): string[] => {
      usage.finished("0000-00-00");
      return usage.saved().current?.features ?? [];
    },
    finished: (day: string): string[] | undefined => usage.finished(day)?.features,
  };
}

describe("the three surfaces are features a day can say", () => {
  it("are on the fixed list", () => {
    expect(FEATURES).toEqual(expect.arrayContaining(["desktop-window", "browser-tab", "tui"]));
  });
});

describe("a feature held for as long as it lasts", () => {
  it("is used today the moment it is held", () => {
    const t = tally();
    t.usage.holdFeature("browser-tab");
    expect(t.today()).toEqual(["browser-tab"]);
  });

  it("counts on the next day too when it is still held as that day starts", () => {
    const t = tally();
    t.usage.holdFeature("desktop-window");
    t.advance(4 * HOUR);                         // 02:00 on the 5th, nothing else heard
    expect(t.finished("2026-11-05")).toEqual(["desktop-window"]);
    expect(t.today()).toEqual(["desktop-window"]);
    t.advance(24 * HOUR);                        // and the 6th
    expect(t.finished("2026-11-06")).toEqual(["desktop-window"]);
    expect(t.today()).toEqual(["desktop-window"]);
  });

  it("counts on the day it ends, even when nothing else read that day before", () => {
    const t = tally();
    const release = t.usage.holdFeature("browser-tab");
    t.advance(2.5 * HOUR);                       // 00:30 on the 5th, the day's first reading
    release();
    t.advance(HOUR);
    expect(t.today()).toEqual(["browser-tab"]);
    // Not on the day after it ended.
    t.advance(24 * HOUR);
    expect(t.finished("2026-11-06")).toEqual(["browser-tab"]);
    expect(t.today()).toEqual([]);
  });

  it("stays held while any holder is left, and a second release does nothing", () => {
    const t = tally();
    const a = t.usage.holdFeature("browser-tab");
    const b = t.usage.holdFeature("browser-tab");
    a();
    a();
    t.advance(4 * HOUR);
    expect(t.today()).toEqual(["browser-tab"]);
    b();
    t.advance(24 * HOUR);
    expect(t.today()).toEqual([]);
  });

  it("holds nothing for a name off the list", () => {
    const t = tally();
    const release = t.usage.holdFeature("/home/alice/secret");
    release();
    t.advance(4 * HOUR);
    expect(t.today()).toEqual([]);
  });

  it("survives a save and restore as an ordinary feature of the day", () => {
    const t = tally();
    t.usage.holdFeature("tui");
    const later = createUsageDay({ now: () => new Date("2026-11-04T23:00:00Z") });
    later.restore(t.usage.saved());
    expect(later.saved().current.features).toEqual(["tui"]);
  });
});

describe("which surface a page is", () => {
  it("is the desktop window when the app's user agent says so, and a browser tab otherwise", () => {
    expect(pageSurface({ "user-agent": APP })).toBe("desktop-window");
    expect(pageSurface({ "user-agent": CHROME })).toBe("browser-tab");
    expect(pageSurface({ "user-agent": "curl/8.5.0" })).toBe("browser-tab");
    expect(pageSurface({})).toBe("browser-tab");
    expect(pageSurface(undefined)).toBe("browser-tab");
  });

  it("is held from the connection until it closes", () => {
    const t = tally();
    const req = Object.assign(new EventEmitter(), { headers: { "user-agent": APP } });
    holdPageSurface(req, t.usage);
    expect(t.today()).toEqual(["desktop-window"]);
    t.advance(4 * HOUR);
    expect(t.today()).toEqual(["desktop-window"]);
    req.emit("close");
    t.advance(24 * HOUR);
    expect(t.today()).toEqual([]);
  });

  it("never throws on a request it cannot read", () => {
    const t = tally();
    expect(() => holdPageSurface(null, t.usage)).not.toThrow();
    expect(() => holdPageSurface({ headers: {} }, t.usage)).not.toThrow();
  });
});

describe("a terminal client saying what it is", () => {
  it("counts `ccdeck tui` on a request with the deck's own token", () => {
    const t = tally();
    noteClientFeature({ "x-ccdeck-client": "tui" }, true, t.usage);
    expect(t.today()).toEqual(["tui"]);
  });

  it("ignores the header without the token, and any value but tui", () => {
    const t = tally();
    noteClientFeature({ "x-ccdeck-client": "tui" }, false, t.usage);
    for (const value of ["vscode", "accounts", "desktop-window", "browser-tab", "usage-history", "", "tui2", "/home/alice"]) {
      noteClientFeature({ "x-ccdeck-client": value }, true, t.usage);
    }
    noteClientFeature({ "x-ccdeck-client": ["tui"] }, true, t.usage);
    noteClientFeature({}, true, t.usage);
    noteClientFeature(undefined, true, t.usage);
    expect(t.today()).toEqual([]);
  });
});

describe("what a terminal command sends", () => {
  let server: Server;
  let port = 0;
  const seen: IncomingHttpHeaders[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push(req.headers);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    port = (server.address() as { port: number }).port;
  });
  afterAll(async () => { await new Promise(done => server.close(done)); });

  const deck = () => ({ port, token: "tok" });

  it("says nothing about itself unless it is asked to", async () => {
    seen.length = 0;
    expect((await askDeck(deck(), { path: "/api/sessions" })).ok).toBe(true);
    expect(seen[0]["x-ccdeck-token"]).toBe("tok");
    expect(seen[0]).not.toHaveProperty("x-ccdeck-client");
  });

  it("names the client when one is given, and never a value that is not a bare word", async () => {
    seen.length = 0;
    await askDeck(deck(), { path: "/api/sessions", client: "tui" });
    await askDeck(deck(), { path: "/api/sessions", client: "Tui\r\nx-evil: 1" });
    await askDeck(deck(), { path: "/api/sessions", client: 7 });
    expect(seen.map(h => h["x-ccdeck-client"])).toEqual(["tui", undefined, undefined]);
    expect(seen[1]).not.toHaveProperty("x-evil");
  });

  it("is `tui` from the screen's own deck source", async () => {
    seen.length = 0;
    const r = await deckSource(null).ask(deck(), { path: "/api/sessions", timeoutMs: 3_000 });
    expect(r.ok).toBe(true);
    expect(seen[0]["x-ccdeck-client"]).toBe("tui");
  });
});
