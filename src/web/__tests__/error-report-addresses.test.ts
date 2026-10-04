// What an error report keeps of an address with no scheme in front.
//
// The scrub took the host out of every web address (error-report-origins.test.ts)
// and left a bare one alone, so a network error still named the machine it
// failed on: `connect ECONNREFUSED 192.168.1.5:4317`, `getaddrinfo ENOTFOUND
// bobs-pc.local`, an IPv6 address with its zone, a Tailscale address or ts.net
// name.
//
// The rule now: every IPv4 and IPv6 address, and a host name where a network
// error puts one — after a DNS or connect failure, glued to a port, or ending in
// a local-network suffix — becomes `<host>`, with a port kept apart from it left
// where it was. The loopback and the any-address name nobody and stay, so a
// local port error reads as it is; a version number or a file:line:col frame is
// not an address. Both scrubs hold to it — the server's, which runs on every
// error that leaves, and the page's, which runs on the crash text a person reads
// before sending feedback.
import { describe, it, expect } from "vitest";
import { normalise } from "../../server/deck-prefs.mjs";
import {
  createReporter, scrub, ADDRESS_PATTERN as SERVER_ADDRESS, HOST_PATTERN as SERVER_HOST,
  // @ts-expect-error — plain JS module, no types
} from "../../server/reports.mjs";
import { ADDRESS_PATTERN, HOST_PATTERN, scrubReport } from "../report-errors";

const HOME = "/home/alice";
const NPX_ROOT = "/home/alice/.npm/_npx/1a2b3c/node_modules/ccdeck";

/** Bare addresses and host names, in the shapes errors carry them. */
const BARE: [string, string][] = [
  ["connect ECONNREFUSED 192.168.1.5:4317", "connect ECONNREFUSED <host>:4317"],
  ["connect ETIMEDOUT 100.101.102.103:4317", "connect ETIMEDOUT <host>:4317"],
  ["getaddrinfo ENOTFOUND bobs-pc.local", "getaddrinfo ENOTFOUND <host>"],
  ["getaddrinfo EAI_AGAIN forklore", "getaddrinfo EAI_AGAIN <host>"],
  ["fetch failed: getaddrinfo ENOTFOUND api.acme-corp.com", "fetch failed: getaddrinfo ENOTFOUND <host>"],
  ["no route to fe80::1%en0", "no route to <host>"],
  ["dial [fd7a:115c::5]:4317 refused", "dial <host>:4317 refused"],
  // Node glues the port to an IPv6 address with no brackets: nothing tells it from the last group.
  ["connect ECONNREFUSED fd7a:115c:a1e0::5:4317", "connect ECONNREFUSED <host>"],
  ["connect EHOSTUNREACH 2001:db8:85a3:0:0:8a2e:370:7334:443", "connect EHOSTUNREACH <host>"],
  ["peer ::ffff:192.168.1.20 dropped", "peer <host> dropped"],
  ["peer bobs-pc.tail1234.ts.net unreachable", "peer <host> unreachable"],
  ["deck at alices-mac.lan answered 403, nas.home timed out", "deck at <host> answered 403, <host> timed out"],
  ["proxy.acme-corp.internal refused", "<host> refused"],
  ["Connect Timeout Error (attempted address: bobs-pc:4317, timeout: 10000ms)", "Connect Timeout Error (attempted address: <host>:4317, timeout: 10000ms)"],
];

/** What must come through untouched: the loopback and the any-address, versions, frames. */
const KEPT: string[] = [
  "connect ECONNREFUSED 127.0.0.1:4317",
  "connect ECONNREFUSED ::1:4317",
  "connect ECONNREFUSED [::1]:4317",
  "getaddrinfo ENOTFOUND localhost",
  "fetch localhost:4317 failed",
  "listen EADDRINUSE: address already in use 0.0.0.0:4317",
  "listen EADDRINUSE: address already in use :::4317",
  "update 3.36.8 -> 3.36.9 on node-22.18.0, Chrome/130.0.0.0",
  "    at Object.<anonymous> (index.js:12:5)",
  "    at readTranscript (ccdeck/src/server/tail.mjs:42:7)",
  "    at Inner (<deck>/assets/index-abc.js:1:2345)",
  "codex_core::exec::ExecError at 10:00:00",
  // Already scrubbed, as the API gets it from a deck that scrubbed first.
  "connect ECONNREFUSED <host>:4317, getaddrinfo ENOTFOUND <host>",
];

describe("the server's scrub sends no bare address", () => {
  it.each(BARE)("%s", (input, output) => {
    expect(scrub(input, HOME, NPX_ROOT)).toBe(output);
  });

  it.each(KEPT)("leaves %s as it was", text => {
    expect(scrub(text, HOME, NPX_ROOT)).toBe(text);
  });
});

describe("the page's scrub shows none either", () => {
  it.each(BARE)("%s", (input, output) => {
    expect(scrubReport(input)).toBe(output);
  });

  it.each(KEPT)("leaves %s as it was", text => {
    expect(scrubReport(text)).toBe(text);
  });

  it("finds addresses and host names with the server's very patterns", () => {
    expect(typeof SERVER_ADDRESS).toBe("string");
    expect(typeof SERVER_HOST).toBe("string");
    expect(ADDRESS_PATTERN).toBe(SERVER_ADDRESS);
    expect(HOST_PATTERN).toBe(SERVER_HOST);
  });
});

describe("a network error the deck sends", () => {
  it("names neither the address nor the machine it failed on", async () => {
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
    const error = new Error("fetch failed: getaddrinfo ENOTFOUND bobs-pc.local");
    error.stack = [
      "Error: connect ECONNREFUSED 192.168.1.5:4317",
      "    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1611:16)",
      `    at dial (file://${NPX_ROOT}/src/server/lan-engine.mjs:515:5)`,
    ].join("\n");

    expect(await reporter.reportError("server", error)).toBe(true);

    const body = sent.at(-1)!;
    const text = JSON.stringify(body);
    for (const word of ["bobs-pc", "192.168"]) expect(text).not.toContain(word);
    expect(body.message).toBe("fetch failed: getaddrinfo ENOTFOUND <host>");
    expect(String(body.stack)).toContain("Error: connect ECONNREFUSED <host>:4317");
    expect(String(body.stack)).toContain("at dial (ccdeck/src/server/lan-engine.mjs:515:5)");
  });
});
