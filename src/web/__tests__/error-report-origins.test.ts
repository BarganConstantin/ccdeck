// What an error report keeps of an address.
//
// A deck opened from another machine is opened by that machine's name, so the
// page's frames carry it: `http://alices-macbook.local:4317/assets/index-abc.js`.
// The scrub took every path out of an error and left addresses alone, so a page
// error sent the name of the machine the deck runs on — and a message naming
// any other address (a paired deck, a proxy) sent that one too.
//
// The rule now: no host leaves. The page's own scripts become `<deck>`, with
// their place in the bundle kept (`<deck>/assets/index-abc.js:1:2345`), so a
// frame still says where the bug is and reads the same on every machine; any
// other address keeps its scheme and path and loses its host (`https://<host>/x`).
// Both scrubs hold to it — the server's, which runs on every error that leaves,
// and the page's, which runs on the crash text a person reads before sending
// feedback.
import { Readable } from "node:stream";
import { describe, it, expect } from "vitest";
import { normalise } from "../../server/deck-prefs.mjs";
import {
  createReporter, scrub, ORIGIN_PATTERN as SERVER_ORIGIN,
  // @ts-expect-error — plain JS module, no types
} from "../../server/reports.mjs";
// @ts-expect-error — plain JS module, no types
import { handleClientError } from "../../server/reports-routes.mjs";
import { ORIGIN_PATTERN, scrubReport } from "../report-errors";

const HOME = "/home/alice";
const NPX_ROOT = "/home/alice/.npm/_npx/1a2b3c/node_modules/ccdeck";

const ADDRESSES: [string, string][] = [
  // The page's own frames, in Chrome's shape and in Firefox's and Safari's.
  ["    at Inner (http://alices-macbook.local:4317/assets/index-abc.js:1:2345)", "    at Inner (<deck>/assets/index-abc.js:1:2345)"],
  ["Inner@http://alices-macbook.local:4317/assets/index-abc.js:1:2345", "Inner@<deck>/assets/index-abc.js:1:2345"],
  ["    at http://alices-macbook.local:4317/assets/index-abc.js:1:2345", "    at <deck>/assets/index-abc.js:1:2345"],
  ["    at Inner (https://deck.acme-corp.internal/assets/index-abc.js:1:2345)", "    at Inner (<deck>/assets/index-abc.js:1:2345)"],
  ["    at Inner (http://127.0.0.1:4317/assets/index-B3x9.js:12:345)", "    at Inner (<deck>/assets/index-B3x9.js:12:345)"],
  ["    at Inner (http://[::1]:4317/assets/index-B3x9.js:12:345)", "    at Inner (<deck>/assets/index-B3x9.js:12:345)"],
  ["    at Inner (http://192.168.1.20:4317/assets/index-B3x9.js:12:345)", "    at Inner (<deck>/assets/index-B3x9.js:12:345)"],
  [
    "Failed to fetch dynamically imported module: http://alices-macbook.local:4317/assets/Settings-abc.js",
    "Failed to fetch dynamically imported module: <deck>/assets/Settings-abc.js",
  ],
  // Any other address: the scheme and the path stay, the host goes.
  ["POST https://api.ccdeck.dev/v1/app/errors failed", "POST https://<host>/v1/app/errors failed"],
  ["fetch http://bobs-pc.local:4317/api/peer/hello failed", "fetch http://<host>/api/peer/hello failed"],
  ["connect to https://alices-macbook.local:4317 refused", "connect to https://<host> refused"],
  ["proxy 'http://bob:hunter2@proxy.acme-corp.internal:3128/' refused", "proxy 'http://<host>/' refused"],
  ["WebSocket to ws://alices-macbook.local:4317/events closed", "WebSocket to ws://<host>/events closed"],
  ["worker blob:http://alices-macbook.local:4317/0f8fad5b failed", "worker blob:http://<host>/0f8fad5b failed"],
  ["GET http://alices-macbook.local:4317/api/state?x=1 (404)", "GET http://<host>/api/state?x=1 (404)"],
  ["open `http://alices-macbook.local:4317` failed", "open `http://<host>` failed"],
  // Already scrubbed, as the API gets it from a deck that scrubbed first: left as it is.
  ["    at Inner (<deck>/assets/index-abc.js:1:2345) via https://<host>/x", "    at Inner (<deck>/assets/index-abc.js:1:2345) via https://<host>/x"],
];

describe("the server's scrub sends no host", () => {
  it.each(ADDRESSES)("%s", (input, output) => {
    expect(scrub(input, HOME, NPX_ROOT)).toBe(output);
  });
});

describe("the page's scrub shows no host either", () => {
  it.each(ADDRESSES)("%s", (input, output) => {
    expect(scrubReport(input)).toBe(output);
  });

  it("finds addresses with the server's very pattern", () => {
    expect(ORIGIN_PATTERN).toBe(SERVER_ORIGIN);
  });
});

/** A request the route reads, and the answer it writes. */
function exchange(body: unknown) {
  const req = Readable.from([JSON.stringify(body)]);
  const res = {
    headersSent: false, status: 0, text: "",
    writeHead(status: number) { res.status = status; res.headersSent = true; },
    end(text: string) { res.text = text; },
  };
  return { req, res };
}

describe("an error the page hands the deck", () => {
  it("leaves without the name of the machine the deck was opened by", async () => {
    let prefs = normalise({});
    const sent: Record<string, unknown>[] = [];
    const reporter = createReporter({
      fetchImpl: async (_url: string, init: { body?: string }) => {
        if (init.body) sent.push(JSON.parse(init.body));
        return { ok: true, status: 202 };
      },
      now: () => new Date("2026-10-05T10:00:00Z"),
      prefs: { current: () => prefs, update: async (mutate: (p: typeof prefs) => object) => (prefs = normalise({ ...prefs, ...mutate(prefs) })) },
      env: {},
      facts: { version: "3.36.0", os: "linux", arch: "x64", channel: "npm", runtime: "node-22.18.0" },
      home: HOME,
      root: NPX_ROOT,
      firstRun: () => true,
    });
    await reporter.checkIn();

    const x = exchange({
      message: "Failed to fetch dynamically imported module: http://alices-macbook.local:4317/assets/Settings-abc.js",
      stack: [
        "TypeError: Cannot read properties of undefined (reading 'agents')",
        "    at Inner (http://alices-macbook.local:4317/assets/index-abc.js:1:2345)",
        "    at Ln (http://alices-macbook.local:4317/assets/index-abc.js:8:9100)",
      ].join("\n"),
    });
    await handleClientError(x.req, x.res, { report: reporter });

    expect(x.res.status).toBe(202);
    const body = sent.at(-1)!;
    expect(body.where).toBe("web");
    expect(JSON.stringify(body)).not.toContain("alices-macbook");
    expect(JSON.stringify(body)).not.toContain("4317");
    expect(body.message).toBe("Failed to fetch dynamically imported module: <deck>/assets/Settings-abc.js");
    expect(String(body.stack)).toContain("at Inner (<deck>/assets/index-abc.js:1:2345)");
    expect(String(body.stack)).toContain("at Ln (<deck>/assets/index-abc.js:8:9100)");
  });
});
