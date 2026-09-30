// The mutation gate used to ask only that Origin and Host agree. Both are
// filled in from the URL the page was served from, so DNS rebinding makes them
// agree on a name the attacker owns: the victim opens http://attacker.example
// on the deck's port, the attacker re-points that record at 127.0.0.1, and the
// next POST arrives with Host: attacker.example:4317, a matching Origin and
// Sec-Fetch-Site: same-origin — fetch metadata is derived from the origin tuple,
// never from the address the socket landed on. The gate passed it, and because
// the browser calls the reply same-origin too, the page could read the body:
// POST /api/claude-accounts/admin {action:'share'} answers with the account's
// exported OAuth credentials, and the same hole reaches account remove/import,
// switch, /api/upgrade's global npm install, /api/restart and /api/clear.
//
// The Host must now name a loopback identity as well. These pin the attack
// itself, the loopback spellings that still have to work, and the clients that
// are not browsers at all: they dial 127.0.0.1, and one that names another host
// is let through only with the deck's token.
//
// The gate was then applied to mutations only, on the reasoning that a
// cross-site page cannot read a loopback reply. A REBOUND page can: the browser
// resolved the attacker's name to 127.0.0.1 itself, so it calls the answer
// same-origin and hands the body over. Every read was open to the same attack,
// and the reads are the interesting half — GET /api/events is the whole ring
// buffer, prompt text and Bash command lines and file contents included. The
// second half of this file pins the read gate and pins it at the routing table,
// where the routes actually live.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { request, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Temp home, set before the dynamic import: the server resolves its config
// directories at import time and the real ~/.claude must stay untouched.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-csrf-loopback-"));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
for (const p of [process.env.HOME, process.env.USERPROFILE, process.env.CLAUDE_CONFIG_DIR, process.env.CODEX_HOME]) {
  if (!resolve(p!).startsWith(resolve(DIR))) throw new Error(`sandbox escaped: ${p}`);
}

// @ts-expect-error — plain .mjs module, no types
const { startServer, hookToken } = await import("../../server/index.mjs");
// @ts-expect-error — plain .mjs module, no types
const { isTrustedMutation, isTrustedRead } = await import("../../server/request-gates.mjs");

const HOST = "127.0.0.1:4317";

describe("isTrustedMutation under DNS rebinding", () => {
  it("refuses a rebound page whose Origin and Host agree on a name the attacker owns", () => {
    // Every header here is self-consistent and every one is attacker-chosen.
    // Equality alone cannot tell this apart from the deck's own UI.
    expect(isTrustedMutation({
      origin: "http://attacker.example:4317", host: "attacker.example:4317", secFetchSite: "same-origin",
    })).toBe(false);
    // `none` is what a top-level navigation reports, so a rebound form POST
    // gets no further than a rebound fetch.
    expect(isTrustedMutation({
      origin: "http://attacker.example:4317", host: "attacker.example:4317", secFetchSite: "none",
    })).toBe(false);
    // Older Safari sends no fetch metadata at all, which is the shape the
    // Origin/Host comparison exists to cover — it must not be the way in.
    expect(isTrustedMutation({
      origin: "http://attacker.example:4317", host: "attacker.example:4317",
    })).toBe(false);
    // A subdomain of a name that reads as local is still a name in DNS.
    expect(isTrustedMutation({
      origin: "http://localhost.attacker.example:4317", host: "localhost.attacker.example:4317",
    })).toBe(false);
    expect(isTrustedMutation({
      origin: "http://127.0.0.1.attacker.example:4317", host: "127.0.0.1.attacker.example:4317",
    })).toBe(false);
  });

  it("refuses a browser request addressed to an address that is not this machine", () => {
    // A deck reached over the LAN, or through a proxy that keeps its own name
    // in the Host header, has no loopback binding left to authorize it.
    expect(isTrustedMutation({ origin: "http://192.168.1.5:4317", host: "192.168.1.5:4317", secFetchSite: "same-origin" })).toBe(false);
    expect(isTrustedMutation({ origin: "https://deck.example.com", host: "deck.example.com" })).toBe(false);
    expect(isTrustedMutation({ origin: "http://[fe80::1]:4317", host: "[fe80::1]:4317" })).toBe(false);
    // 0.0.0.0 is the unspecified address, not a loopback one, even though some
    // platforms let a browser reach a local listener through it.
    expect(isTrustedMutation({ origin: "http://0.0.0.0:4317", host: "0.0.0.0:4317" })).toBe(false);
  });

  it("still lets the deck's own UI through on every loopback spelling", () => {
    expect(isTrustedMutation({ origin: `http://${HOST}`, host: HOST, secFetchSite: "same-origin" })).toBe(true);
    expect(isTrustedMutation({ origin: "http://localhost:4317", host: "localhost:4317", secFetchSite: "same-origin" })).toBe(true);
    expect(isTrustedMutation({ origin: "http://[::1]:4317", host: "[::1]:4317", secFetchSite: "same-origin" })).toBe(true);
    // The whole 127.0.0.0/8 is this machine: a second deck parked on 127.0.0.2
    // is as local as the first, and Windows, macOS and Linux all route it home.
    expect(isTrustedMutation({ origin: "http://127.0.0.2:4317", host: "127.0.0.2:4317" })).toBe(true);
    expect(isTrustedMutation({ origin: "http://127.255.255.254:4317", host: "127.255.255.254:4317" })).toBe(true);
  });

  it("lets the hook through, and leaves the name it dialled to the read gate", () => {
    // hook/hook.js is a bare Node http.request: no Origin, no fetch metadata,
    // and no ambient authority for a page to borrow, so this gate — did a page
    // choose this? — has nothing to ask it. Which name it addressed the deck by
    // is isTrustedRead's question, and the router asks that one first, of every
    // method: the hook dials 127.0.0.1, and another name is refused there.
    expect(isTrustedMutation({ host: "deck.local:4317" })).toBe(true);
    expect(isTrustedRead({ host: "deck.local:4317" })).toBe(false);
    expect(isTrustedMutation({ host: HOST })).toBe(true);
    expect(isTrustedMutation()).toBe(true);
  });

  it("refuses a browser that sends fetch metadata but no Origin", () => {
    // Every browser sends Origin on a POST, but the gate must not rest on that:
    // metadata present means a page sent this, so the Host is measured too.
    expect(isTrustedMutation({ host: "attacker.example:4317", secFetchSite: "same-origin" })).toBe(false);
    expect(isTrustedMutation({ host: HOST, secFetchSite: "same-origin" })).toBe(true);
  });

  it("reads the Host header as it actually arrives", () => {
    // Case and surrounding whitespace are the client's business, not a signal.
    expect(isTrustedMutation({ origin: "http://localhost:4317", host: "LOCALHOST:4317" })).toBe(true);
    expect(isTrustedMutation({ origin: `http://${HOST}`, host: ` ${HOST} ` })).toBe(true);
    // The long form of ::1 is the same address written out, and a browser that
    // sent no Origin has nothing else for it to be compared against.
    expect(isTrustedMutation({ host: "[0:0:0:0:0:0:0:1]:4317", secFetchSite: "same-origin" })).toBe(true);
    // Userinfo and a path have no business in a Host header, and both would
    // otherwise parse to a loopback hostname while naming something else.
    expect(isTrustedMutation({ origin: `http://${HOST}`, host: `attacker.example@${HOST}` })).toBe(false);
    expect(isTrustedMutation({ origin: `http://${HOST}`, host: `${HOST}/attacker.example` })).toBe(false);
  });
});

describe("isTrustedRead under DNS rebinding", () => {
  it("refuses a rebound page's reads", () => {
    // The same self-consistent, entirely attacker-chosen header set as above.
    // A read carrying it used to be answered in full.
    expect(isTrustedRead({ host: "attacker.example:4317", secFetchSite: "same-origin" })).toBe(false);
    expect(isTrustedRead({
      origin: "http://attacker.example:4317", host: "attacker.example:4317", secFetchSite: "same-origin",
    })).toBe(false);
    // A GET sends no Origin unless it is a CORS request, so fetch metadata is
    // usually the only thing marking a read as a page's. Either one is enough.
    expect(isTrustedRead({ origin: "http://attacker.example:4317", host: "attacker.example:4317" })).toBe(false);
    expect(isTrustedRead({ host: "localhost.attacker.example:4317", secFetchSite: "same-origin" })).toBe(false);
    expect(isTrustedRead({ host: "192.168.1.5:4317", secFetchSite: "same-origin" })).toBe(false);
  });

  it("refuses a rebound page that sends only a Referer, which is all Safari 16.0-16.3 sends", () => {
    // A same-origin GET carries no Origin, and that browser sends no fetch
    // metadata, so the Referer is the only thing marking this as a page. It was
    // not counted, and the request was measured as a client that is not a
    // browser: every read the data gate does not list answered it (#1168).
    expect(isTrustedRead({ host: "attacker.example:4317", referer: "http://attacker.example:4317/" })).toBe(false);
    // The same page on the same browser, addressed to the deck itself.
    expect(isTrustedRead({ host: HOST, referer: `http://${HOST}/` })).toBe(true);
    // A link to the deck clicked on some other page carries that page as its
    // Referer. The Host is still the deck's, so it is still the deck's UI.
    expect(isTrustedRead({ host: HOST, referer: "https://evil.example/" })).toBe(true);
  });

  it("lets the deck's own page read on every loopback spelling", () => {
    expect(isTrustedRead({ host: HOST, secFetchSite: "same-origin" })).toBe(true);
    expect(isTrustedRead({ origin: `http://${HOST}`, host: HOST, secFetchSite: "same-origin" })).toBe(true);
    expect(isTrustedRead({ host: "localhost:4317", secFetchSite: "same-origin" })).toBe(true);
    expect(isTrustedRead({ host: "[::1]:4317", secFetchSite: "same-origin" })).toBe(true);
    expect(isTrustedRead({ host: "127.0.0.2:4317", secFetchSite: "same-origin" })).toBe(true);
  });

  it("refuses a request addressed to another name, whatever headers it leaves out", () => {
    // A page's own GET need carry none of the marks above, and a client that
    // is not a browser dials 127.0.0.1. A Host naming anything else is not
    // the deck's own client, whatever the rest of the request leaves out.
    expect(isTrustedRead({ host: "attacker.example:4317" })).toBe(false);
    expect(isTrustedRead({ host: "deck.local:4317" })).toBe(false);
    expect(isTrustedRead({ host: "192.168.1.5:4317" })).toBe(false);
    expect(isTrustedRead({ origin: "", secFetchSite: "", referer: "", host: "attacker.example:4317" })).toBe(false);
  });

  it("still lets a client that is not a browser read under a loopback name, or under none", () => {
    // hook/hook.js, the desktop app and bin/ all dial 127.0.0.1, so the Host
    // Node fills in for them is a loopback one. A request with no Host at all is
    // HTTP/1.0 tooling: a browser always sends one.
    expect(isTrustedRead({ host: HOST })).toBe(true);
    expect(isTrustedRead({ host: "localhost:4317" })).toBe(true);
    expect(isTrustedRead({ origin: "", secFetchSite: "" })).toBe(true);
    expect(isTrustedRead({ host: "" })).toBe(true);
    expect(isTrustedRead()).toBe(true);
  });

  it("lets the deck's token through under another name, and only a client that is not a page", () => {
    // Whoever holds the token read it out of the 0600 discovery file, so the
    // name it dialled says nothing about it.
    expect(isTrustedRead({ host: "deck.local:4317", token: hookToken() })).toBe(true);
    expect(isTrustedRead({ host: "deck.local:4317", token: "0".repeat(64) })).toBe(false);
    // A request a page chose is refused whoever else may be behind it, which is
    // the rule the mutation gate already keeps.
    expect(isTrustedRead({ host: "attacker.example:4317", secFetchSite: "same-origin", token: hookToken() })).toBe(false);
  });

  it("does not borrow the mutation gate's Sec-Fetch-Site test", () => {
    // Deliberate, and the reason this is a separate predicate. A `cross-site`
    // read of a loopback address is an ordinary top-level navigation — a link
    // to the deck clicked on some other page — and the document it loads is the
    // deck's own UI on the deck's own origin. Rebinding does not travel that
    // way: a rebound page's own requests report `same-origin`, and what gives
    // it away is the Host.
    expect(isTrustedRead({ host: HOST, secFetchSite: "cross-site" })).toBe(true);
    expect(isTrustedRead({ host: HOST, secFetchSite: "same-site" })).toBe(true);
    expect(isTrustedMutation({ host: HOST, secFetchSite: "cross-site" })).toBe(false);
  });
});

// Every named route, at the routing table rather than at the predicate. The
// gate is one line in front of the table, so a route escaping it would be a
// routing bug rather than a logic bug and the unit tests above would not see it.
describe("the rebinding gate in front of the routing table", () => {
  let server: Server;
  let port = 0;

  beforeAll(async () => {
    server = await startServer({ port: 0, host: "127.0.0.1", persist: null, codex: false });
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>(done => {
      server.closeAllConnections?.();
      server.close(() => done());
    });
    rmTempDir(DIR);
  });

  function call(path: string, headers: Record<string, string>): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, method: "GET", headers }, res => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
  }

  // Node's global fetch cannot express this: undici treats Host as a forbidden
  // header and silently drops it, so the request would arrive at the real
  // address and pass. node:http sends what it is given.
  const rebound = {
    Host: "attacker.example:4317",
    Origin: "http://attacker.example:4317",
    "Sec-Fetch-Site": "same-origin",
  };

  const READS = [
    "/api/events?since=0",        // the whole ring buffer
    "/api/claude-accounts",       // account emails, org names, aliases
    "/api/claude-accounts/login", // a live OAuth authorize URL
    "/api/health",                // the absolute workspace path
    "/api/hook-challenge?nonce=n", // a proof oracle for the deck's token
    "/api/version",
    "/api/quota",
    "/api/ccusage",
    "/api/codex-usage",
    "/api/codex-quota",
    "/api/provider-status",
    "/api/cswap-auto",
    "/events",                    // the same buffer, live
    "/",                          // and the page itself
    "/assets/app.js",
  ];

  it("refuses every read from a rebound page", async () => {
    for (const path of READS) {
      expect(await call(path, rebound), `${path} answered a rebound page`).toBe(403);
    }
  });

  // The same page on Safari 16.0-16.3: no Origin on a same-origin GET, no fetch
  // metadata at all, and a Referer that agrees with the Host on the attacker's
  // name. Before #1168 this was measured as a client that is not a browser, so
  // only the reads the data gate lists were refused — and those only because
  // that gate tests the Host before it reads the Referer. /api/health answered
  // with the workspace path, /api/hook-challenge with a proof, / with the page.
  const reboundByReferer = {
    Host: "attacker.example:4317",
    Referer: "http://attacker.example:4317/",
  };

  it("refuses every read from a rebound page that sends only a Referer", async () => {
    for (const path of READS) {
      expect(await call(path, reboundByReferer), `${path} answered a rebound page`).toBe(403);
    }
  });

  it("still answers the deck's own page", async () => {
    const ui = {
      Host: `127.0.0.1:${port}`,
      Origin: `http://127.0.0.1:${port}`,
      "Sec-Fetch-Site": "same-origin",
    };
    expect(await call("/api/health", ui)).toBe(200);
    expect(await call("/api/events?since=0", ui)).toBe(200);
    // The Host the browser sends follows the URL bar, not the socket.
    expect(await call("/api/health", { ...ui, Host: "localhost:4317", Origin: "http://localhost:4317" })).toBe(200);
    // And the page on the browser that sends only a Referer, which that header
    // now marks as a page: its Host is a loopback one, so it reads as before.
    const referer = { Host: `127.0.0.1:${port}`, Referer: `http://127.0.0.1:${port}/` };
    expect(await call("/api/health", referer)).toBe(200);
    expect(await call("/api/events?since=0", referer)).toBe(200);
  });

  // The same page again, this time carrying none of the three marks. What is
  // left is the Host.
  const reboundBare = { Host: "attacker.example:4317" };

  it("refuses every read from a rebound page that sends no browser headers at all", async () => {
    // Every answer at once rather than the first that differs, so a failure
    // names each route that let the page read it.
    const paths = [...READS, "/api/system/processes?detail=1", "/api/clear"];
    const got: Record<string, number> = {};
    for (const path of paths) got[path] = await call(path, reboundBare);
    expect(got).toEqual(Object.fromEntries(paths.map(p => [p, 403])));
  });

  it("still answers a client that sends no browser headers at all", async () => {
    // hook/hook.js, and the deck's own tooling. This is the shape that must not
    // be measured against a rebinding attack it cannot be part of — and it dials
    // 127.0.0.1, so the Host it sends is a loopback one.
    expect(await call("/api/health", {})).toBe(200);
    expect(await call("/api/health", { Host: `127.0.0.1:${port}` })).toBe(200);
    expect(await call("/api/health", { Host: `localhost:${port}` })).toBe(200);
  });

  it("answers the token under another name, which only the deck's own user can hold", async () => {
    expect(await call("/api/health", { ...reboundBare, "x-ccdeck-token": hookToken() })).toBe(200);
    expect(await call("/api/health", { ...reboundBare, "x-ccdeck-token": "0".repeat(64) })).toBe(403);
  });

  it("answers a request with no Host at all, which is HTTP/1.0 tooling and not a page", async () => {
    // node:http always sends a Host, so this goes out over a bare socket.
    const status = await new Promise<number>((resolve, reject) => {
      const sock = connect({ host: "127.0.0.1", port }, () => sock.write("GET /api/health HTTP/1.0\r\n\r\n"));
      let head = "";
      sock.setEncoding("utf8");
      sock.on("data", c => { head += c; });
      sock.on("end", () => resolve(Number(/^HTTP\/1\.\d (\d{3})/.exec(head)?.[1] ?? 0)));
      sock.on("error", reject);
    });
    expect(status).toBe(200);
  });
});
