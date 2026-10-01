// Which features got used today (feature-use.mjs, feature-use.ts): the page's
// beacon, the server's own routes, and what reaches the "active" report.
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { describe, it, expect, vi, afterEach } from "vitest";
// @ts-expect-error — plain JS module, no types
import { handleFeature, noteRouteFeature } from "../../server/feature-use.mjs";
// @ts-expect-error — plain JS module, no types
import { usageDay } from "../../server/usage-day.mjs";
import { noteFeature } from "../feature-use";

const today = () => usageDay.saved().current?.features ?? [];

function post(body: unknown) {
  const req = Readable.from([typeof body === "string" ? body : JSON.stringify(body)]);
  const res = {
    headersSent: false,
    status: 0,
    text: "",
    writeHead(status: number) { res.status = status; res.headersSent = true; },
    end(text: string) { res.text = text; },
  };
  return { req, res };
}

describe("POST /api/feature", () => {
  it("keeps a name off the list as used today", async () => {
    const { req, res } = post({ name: "usage-history" });
    await handleFeature(req, res);
    expect(res.status).toBe(200);
    expect(today()).toContain("usage-history");
  });

  it("refuses anything else, and keeps nothing of it", async () => {
    for (const body of [{ name: "/home/alice/secret" }, { name: 7 }, {}, "not json"]) {
      const { req, res } = post(body);
      await handleFeature(req, res);
      expect(res.status).toBe(400);
    }
    expect(today().join(" ")).not.toMatch(/alice|secret/);
  });
});

describe("the server's own routes", () => {
  it("count the actions somebody takes on purpose", () => {
    noteRouteFeature("POST", "/api/claude-accounts/switch");
    noteRouteFeature("POST", "/api/lan/invite");
    expect(today()).toEqual(expect.arrayContaining(["account-switch", "lan-pairing"]));
  });

  it("never count a read the page makes on its own", () => {
    const before = today().length;
    for (const path of ["/api/claude-accounts", "/api/quota", "/api/claude-fm", "/api/cswap-auto", "/api/lan"]) {
      noteRouteFeature("GET", path);
    }
    expect(today().length).toBe(before);
  });

  it("are noted past the deck's gates, and the page's route sits above the 404", () => {
    const src = readFileSync(new URL("../../server/index.mjs", import.meta.url), "utf8");
    const gates = src.indexOf("!OPEN_MUTATIONS.has(url.pathname) && !isAuthorizedMutation(req)");
    const noted = src.indexOf("noteRouteFeature(req.method, url.pathname);");
    const route = src.indexOf('url.pathname === "/api/feature"');
    const notFound = src.indexOf("AN UNMATCHED /api/ PATH IS A 404");
    expect(gates).toBeGreaterThan(0);
    expect(noted).toBeGreaterThan(gates);
    expect(route).toBeGreaterThan(0);
    expect(route).toBeLessThan(notFound);
  });
});

describe("the page's beacon", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("says a name once a day, and again after a beacon that was not queued", () => {
    const sent: string[] = [];
    let queue = false;
    vi.stubGlobal("navigator", { sendBeacon: (url: string, body: string) => { sent.push(`${url} ${body}`); return queue; } });
    noteFeature("feedback");          // not queued: forgotten, so tried again
    queue = true;
    noteFeature("feedback");
    noteFeature("feedback");          // already said today
    expect(sent).toEqual([
      '/api/feature {"name":"feedback"}',
      '/api/feature {"name":"feedback"}',
    ]);
  });

  it("never uses fetch, so a panel's own requests stay its own", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("navigator", undefined);
    noteFeature("keyboard-help");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
