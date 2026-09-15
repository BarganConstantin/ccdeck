// #830: with several deck tabs open, a new tab said "Server unreachable — check
// that ccdeck is still running" while the server was fine. Every tab holds one
// /events stream, a browser keeps at most six live connections to one host,
// and the seventh tab's stream (and every fetch behind it) waits in the
// browser's queue. The tabs can still hear one another over a BroadcastChannel,
// so a tab whose stream has not opened asks who is streaming, and the hero says
// "too many tabs" when that explains the wait.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BROWSER_STREAM_CAP, CENSUS_CHANNEL, joinCensus, tooManyTabs,
  type CensusChannel, type CensusMessage,
} from "../tab-census";

const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");

/** An in-memory BroadcastChannel: every channel on the hub hears every other
 *  one's posts and never its own, which is what the real one does. */
function hub() {
  const members = new Set<Fake>();
  class Fake implements CensusChannel {
    listeners = new Set<(e: { data: unknown }) => void>();
    constructor() { members.add(this); }
    postMessage(msg: CensusMessage) {
      for (const m of [...members]) if (m !== this) for (const l of [...m.listeners]) l({ data: msg });
    }
    addEventListener(_: "message", fn: (e: { data: unknown }) => void) { this.listeners.add(fn); }
    removeEventListener(_: "message", fn: (e: { data: unknown }) => void) { this.listeners.delete(fn); }
    close() { members.delete(this); }
  }
  return () => new Fake();
}
const now = (fn: () => void) => { fn(); };

describe("the tabs count one another (#830)", () => {
  it("counts the other tabs that are streaming, and never itself", async () => {
    const channel = hub();
    for (let i = 0; i < 6; i++) joinCensus(channel(), `peer${i}`, () => true);
    for (let i = 0; i < 2; i++) joinCensus(channel(), `idle${i}`, () => false);
    const me = joinCensus(channel(), "me", () => false);
    expect(await me.ask(600, now)).toBe(6);
  });

  it("reads each tab's answer at the moment of the question", async () => {
    const channel = hub();
    let open = false;
    joinCensus(channel(), "peer", () => open);
    const me = joinCensus(channel(), "me", () => false);
    expect(await me.ask(600, now)).toBe(0);
    open = true;
    expect(await me.ask(600, now)).toBe(1);
  });

  it("stops counting a tab that has closed", async () => {
    const channel = hub();
    const peers = Array.from({ length: 6 }, (_, i) => joinCensus(channel(), `peer${i}`, () => true));
    const me = joinCensus(channel(), "me", () => false);
    peers[0].leave();
    expect(await me.ask(600, now)).toBe(5);
  });

  it("calls it too many tabs at the browser's own cap", () => {
    expect(BROWSER_STREAM_CAP).toBe(6);
    expect(tooManyTabs(6)).toBe(true);
    expect(tooManyTabs(5)).toBe(false);
  });
});

describe("a queued tab says so instead of blaming the server (#830)", () => {
  it("joins the census inside the stream's own effect, and asks only while not streaming", () => {
    expect(app).toMatch(/joinCensus\(new BroadcastChannel\(CENSUS_CHANNEL\), [^,]+, \(\) => streaming\)/);
    expect(app).toMatch(/if \(streaming \|\| !census\) return;\s*void census\.ask\(600\)\.then\(peers => \{ if \(!streaming\) setTabCapped\(tooManyTabs\(peers\)\); \}\);/);
    expect(app).toMatch(/es\.addEventListener\("open", \(\) => \{ streaming = true; setTabCapped\(false\); \}\);/);
    expect(app).toMatch(/es\.addEventListener\("error", \(\) => \{ streaming = false; \}\);/);
    expect(app).toMatch(/window\.clearInterval\(probe\);\s*census\?\.leave\(\);/);
    expect(CENSUS_CHANNEL).toBe("ccdeck-tabs");
  });

  it("tells the reader to close a tab, not to check the server", () => {
    expect(app).toMatch(/\{agentCount === 0 && \(!live && tabCapped\s*\? <TabCapHero \/>\s*: <EmptyHero live=\{live\}/);
    const hero = /function TabCapHero\(\) \{[\s\S]*?\n\}/.exec(app)?.[0] ?? "";
    const said = /<p>([\s\S]*?)<\/p>/.exec(hero)?.[1].replace(/\s+/g, " ").trim() ?? "";
    expect(said).toBe("This browser keeps at most six live connections to one address, and other <code>{PRODUCT}</code> tabs are holding them. Close one and this tab connects on its own.");
    expect(hero).toMatch(/<h2>Too many \{PRODUCT\} tabs are open<\/h2>/);
    expect(hero).not.toMatch(/still running|unreachable/);
  });
});
