// The gate was applied to half the surface.
//
// `isAuthorizedMutation` exists because `curl -XPOST localhost:4317/api/
// claude-accounts/admin` handed a live OAuth refresh token to a sandboxed
// subprocess with loopback egress — a caller denied the credential store but
// allowed to talk to this port. That same caller could go on running
// `curl localhost:4317/api/events` and read the whole ring: prompt text, the
// Bash command lines the agent ran, the paths and contents it wrote, the
// contents of every file it read back. Plus the account roster, the live OAuth
// authorize URL, and the browsing episodes.
//
// The read gate cannot be spelled the way the mutation gate is: a same-origin
// GET carries no `Origin` header at all, so the deck's own page cannot be
// recognised by Origin. `Sec-Fetch-Site: same-origin` is what a page's fetch
// and its EventSource both send, on every browser new enough to run this
// bundle, and no non-browser client sends it by accident.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { request } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { GROUPS as STRIP_GROUPS } from "../components/MachineStrip";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-guarded-reads-"));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.XDG_CONFIG_HOME = join(DIR, "config");
if (!resolve(process.env.CLAUDE_CONFIG_DIR).startsWith(resolve(DIR))) throw new Error("sandbox escaped");

// @ts-expect-error — plain .mjs server module, no types
const mod = await import("../../server/index.mjs");

let server: Server;
let port = 0;
beforeAll(async () => {
  server = await mod.startServer({ port: 0, persist: false, open: false, claude: false, codex: false });
  port = (server.address() as { port: number }).port;
}, 30_000);
afterAll(async () => {
  await new Promise(r => server.close(r));
  rmTempDir(DIR);
});

const get = (path: string, headers: Record<string, string> = {}) =>
  new Promise<number>((resolve_, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", headers }, res => {
      res.resume();
      resolve_(res.statusCode ?? 0);
    });
    req.on("error", reject);
    // SSE never ends on its own; the status line is all this asks for.
    req.setTimeout(4000, () => { req.destroy(); resolve_(0); });
    req.end();
  });

const uiHeaders = (p = port) => ({ host: `127.0.0.1:${p}`, "sec-fetch-site": "same-origin" });

/** The whole answer, for the cases that care what came back and not only that
 *  something did. Never pointed at /events, which does not end. */
const getJson = (path: string, headers: Record<string, string> = {}) =>
  new Promise<{ status: number; body: any; raw: string; headers: IncomingHttpHeaders }>((resolve_, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", headers }, res => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", c => { raw += c; });
      res.on("end", () => {
        let body: any = null;
        try { body = JSON.parse(raw); } catch { /* not JSON; `raw` has it */ }
        resolve_({ status: res.statusCode ?? 0, body, raw, headers: res.headers });
      });
    });
    req.on("error", reject);
    req.end();
  });

describe("what a plain loopback client can read", () => {
  for (const path of ["/api/events", "/api/claude-accounts", "/api/claude-accounts/login", "/api/browser-watch", "/api/lan", "/api/prefs"]) {
    it(`refuses ${path} with no browser headers and no token`, async () => {
      expect(await get(path)).toBe(401);
    });
  }

  it("refuses the SSE stream too, which is the same ring one event at a time", async () => {
    expect(await get("/events")).toBe(401);
  });
});

describe("what the deck's own page can read", () => {
  // Exactly 200, not merely "not 401". A gate change that answered the deck's
  // own page with 403 — or a route that fell over behind the gate — would pass
  // a test that only asks whether the refusal it is looking for came back, and
  // the panel it locks out would find out first (#1168).
  for (const path of ["/api/events", "/api/claude-accounts", "/api/claude-accounts/login", "/api/browser-watch", "/api/lan", "/api/prefs"]) {
    it(`allows ${path} for a same-origin request addressed to loopback`, async () => {
      expect(await get(path, uiHeaders())).toBe(200);
    });
  }

  it("answers the sign-in route with the dialog's own state, which is idle until somebody signs in", async () => {
    // The one guarded read whose answer can carry a live OAuth authorize URL and
    // the account being added. Nobody has started a sign-in here, so what the
    // page reads is the idle state — and it reads it rather than a refusal.
    const r = await getJson("/api/claude-accounts/login", uiHeaders());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, state: "idle" });
  });

  it("allows the token instead, for a client that is not a browser", async () => {
    const token = mod.hookToken();
    expect(typeof token).toBe("string");
    expect(await get("/api/events", { "x-ccdeck-token": token })).toBe(200);
  });

  it("refuses a rebound page, which also reports same-origin", async () => {
    // The Host is what gives it away: attacker.example resolved to 127.0.0.1 is
    // still not a name that can only ever be this machine.
    // 403 rather than 401: the rebinding gate above this one turns it away
    // first, as a page rather than as an unauthenticated caller. Either way it
    // does not read the ring, and asserting the exact code keeps the two gates
    // distinguishable if one of them is ever moved.
    expect(await get("/api/events", { host: "attacker.example", "sec-fetch-site": "same-origin" })).toBe(403);
  });

  it("refuses a cross-site read even from a loopback host", async () => {
    expect(await get("/api/events", { host: `127.0.0.1:${port}`, "sec-fetch-site": "cross-site" })).toBe(401);
  });
});

describe("a browser that sends no fetch metadata", () => {
  // Sec-Fetch-Site is Safari 16.4 and newer. Vite's default target is Safari
  // 16, so 16.0-16.3 runs this bundle perfectly well and sends none of it —
  // and without a fallback those users get an empty canvas and a 401 they
  // cannot act on. Referer is what they do send, on a page's own fetches and on
  // its EventSource.
  it("is recognised by a Referer naming this very origin", async () => {
    expect(await get("/api/events", { host: `127.0.0.1:${port}`, referer: `http://127.0.0.1:${port}/` })).toBe(200);
    expect(await get("/events", { host: `127.0.0.1:${port}`, referer: `http://127.0.0.1:${port}/` })).toBe(200);
  });

  // A REBOUND page on that same browser, which is the case the fallback above
  // has to get right and had no test. Its Referer and its Host agree, on the
  // attacker's name, so `originMatchesHost(referer, host)` says yes — and before
  // #1168 the one thing standing between it and the ring was the loopback test
  // at the top of isAuthorizedDataRead. It is turned away a step earlier now, by
  // the rebinding gate, which counts a Referer as the mark of a page; 403 says
  // which gate did it, as it does for the same-origin rebound shape above.
  for (const path of ["/api/events", "/events", "/api/claude-accounts", "/api/claude-accounts/login", "/api/browser-watch", "/api/lan", "/api/prefs"]) {
    it(`refuses ${path} to a rebound page whose Referer agrees with its Host`, async () => {
      expect(await get(path, {
        host: `attacker.example:${port}`,
        referer: `http://attacker.example:${port}/`,
      })).toBe(403);
    });
  }

  it("refuses a client that names another host and presents nothing", async () => {
    // Not a page, so the rebinding gate lets it by — hook.js reaches the deck
    // under whatever name it used — but naming the deck by another name earns
    // no more than naming it by its own: the token is still the way in.
    expect(await get("/api/events", { host: `deck.local:${port}` })).toBe(401);
  });

  it("is refused when the Referer names somebody else", async () => {
    // A cross-site page's Referer names its own origin.
    expect(await get("/api/events", { host: `127.0.0.1:${port}`, referer: "https://evil.example/" })).toBe(401);
    // A different loopback port is a different deck, and not this page.
    expect(await get("/api/events", { host: `127.0.0.1:${port}`, referer: `http://127.0.0.1:${port + 1}/` })).toBe(401);
  });

  it("is refused when there is no Referer either", async () => {
    // Which is where curl lands, and where the token is the way in.
    expect(await get("/api/events", { host: `127.0.0.1:${port}` })).toBe(401);
  });

  it("does not let a stated cross-site request in through the Referer", async () => {
    // Fetch metadata that SAYS cross-site is a page that is not this one, and a
    // Referer beside it changes nothing.
    expect(await get("/api/events", {
      host: `127.0.0.1:${port}`,
      "sec-fetch-site": "cross-site",
      referer: `http://127.0.0.1:${port}/`,
    })).toBe(401);
  });
});

// The two routes the gate was written for and did not cover. Filed after a
// request carrying NO HEADERS AT ALL got 401 from /api/claude-accounts and 200
// from /api/lan on the same deck, one route apart.
describe("the LAN routes carry the same class of secret as the roster", () => {
  it("does not hand the shared-account list to a caller the roster refuses", async () => {
    // `shared` is one `<email>@@<organization uuid>` per account this deck
    // offers, and `peers[].offers.accounts[].email` is the same for every
    // paired deck. A caller that cannot read /api/claude-accounts must not
    // read the same addresses out of the sync panel's route.
    expect(await get("/api/claude-accounts")).toBe(401);
    expect(await get("/api/lan")).toBe(401);
  });

  it("does not hand out a live invite token, which is a bearer credential", async () => {
    // Not a description of the pairing — the thing that performs it.
    // readInvite -> connectToPeer({code}) -> onInviteUsed pins the caller as
    // trusted with nobody pressing anything, and a trusted deck may then send
    // `manifest` and `want` and receive sealed OAuth credentials.
    expect(await get("/api/lan")).toBe(401);
  });

  it("keeps lan.shared out of prefs as well, where publicPrefs leaves it", async () => {
    // publicPrefs strips `lan.secret` and every `trusted[].pub`, which was the
    // half that had to be right. It keeps `lan.shared` and every trusted
    // peer's name, which is the same inventory by another door.
    expect(await get("/api/prefs")).toBe(401);
  });
});

// The floor job asks four endpoints for a 200 and one of them, /api/state, has
// never been a route: the string appeared exactly once in the whole repo, in
// that loop. It answered 200 because an unmatched GET fell through to the SPA
// shell — and so would the other three if the route table were deleted. A
// status code under /api/ has to be able to say no.
describe("an unmatched /api path is a 404, not the SPA shell", () => {
  it("does not answer a route that does not exist", async () => {
    expect(await get("/api/state")).toBe(404);              // the CI probe's own ghost
    expect(await get("/api/definitely-not-a-route")).toBe(404);
    expect(await get("/api/health/bogus")).toBe(404);
  });

  it("refuses it the same way for a page as for a bare client", async () => {
    // Not a guard: the path is absent for everyone, so the deck's own page
    // must not get a 200 the SPA fallback would once have given it.
    expect(await get("/api/definitely-not-a-route", uiHeaders())).toBe(404);
  });

  it("still serves the SPA for a client-side route outside /api/", async () => {
    // The fallback is for deep links into the deck's own UI, and that is the
    // half this must not break.
    expect(await get("/some/client/side/route")).toBe(200);
  });
});

describe("what stays open, and why", () => {
  it("leaves the hook's readiness probe and its handshake alone", async () => {
    // hook/hook.js is a plain Node http.request with no browser headers, and it
    // has to reach both of these before it can present a token at all.
    expect(await get("/api/health")).toBe(200);
    expect(await get("/api/hook-challenge?nonce=abc")).toBe(200);
  });

  it("leaves the machine's own measurements alone", async () => {
    // These are about the machine, not about what the user is doing on it, and
    // nothing in them names a session, a path or a prompt.
    expect(await get("/api/system")).toBe(200);
  });

  // The route glue in front of historySnapshot, which is tested on its own and
  // was never asked through the socket (#1168). The allowlist is the part with
  // two ways to go wrong: drift from the names the UI sends and a chart opens
  // empty or on an error; drop it and a group that does not exist answers as a
  // machine with nothing to report. So the names are read from the two places
  // that send them rather than typed a third time here.
  it("answers every history section the machine panel and the strip ask for", async () => {
    const panel = readFileSync(fileURLToPath(new URL("../components/MachinePanel.tsx", import.meta.url)), "utf8");
    const asked = new Set<string>([
      ...[...panel.matchAll(/<OpensHistory\s+group="(\w+)"/g)].map(m => m[1]),
      ...STRIP_GROUPS,
    ]);
    // Five, so a reading of the panel that found nothing cannot pass for one
    // that found everything.
    expect([...asked].sort()).toEqual(["cores", "load", "memory", "network", "thermal"]);
    for (const group of asked) {
      const r = await getJson(`/api/system/history?group=${group}`);
      expect(r.status, group).toBe(200);
      expect(Array.isArray(r.body?.series), `${group} has no series`).toBe(true);
    }
  });

  it("refuses a history section that does not exist rather than drawing it empty", async () => {
    for (const query of ["?group=bogus", "?group=", "", "?group=CORES"]) {
      const r = await getJson(`/api/system/history${query}`);
      expect(r.status, query || "(no group)").toBe(400);
      expect(r.body).toEqual({ ok: false, error: "unknown_group" });
    }
  });

  it("answers the process list, and reads the argument vector only for the modal that asks", async () => {
    // Plain first: a detailed reading is cached for a poll and serves a plain
    // caller too, so the other order would read the modal's answer twice.
    const plain = await getJson("/api/system/processes");
    expect(plain.status).toBe(200);
    expect(plain.body.ok).toBe(true);
    expect(typeof plain.body.total).toBe("number");
    expect(Array.isArray(plain.body.procs)).toBe(true);
    // The command tail is the one field that has ever been near an argv, and
    // it is `detail=1` that asks for it — a panel that never opens the modal
    // never reads one.
    expect(plain.body.procs.some((p: Record<string, unknown>) => "cmd" in p)).toBe(false);

    const detailed = await getJson("/api/system/processes?detail=1");
    expect(detailed.status).toBe(200);
    expect(detailed.body.ok).toBe(true);
    // On POSIX the plain rows carry no thread count and the detailed ones do,
    // which is the flag reaching readProcesses. Windows reads Threads on its one
    // Get-Process call either way, and that call sits on its own six-second
    // deadline, so there the rows prove nothing about the flag.
    if (process.platform !== "win32") {
      expect(plain.body.procs.length).toBeGreaterThan(0);
      expect(plain.body.procs.some((p: Record<string, unknown>) => "threads" in p)).toBe(false);
      expect(detailed.body.procs.some((p: { threads?: number }) => Number.isInteger(p.threads) && p.threads! > 0)).toBe(true);
    }
  }, 30_000);
});

// THE STATIC HANDLER, THROUGH THE SOCKET (#1168). cacheControlFor and
// pickEncoding are unit-tested in static-cache's own suite, and what nobody
// checked is that serveStatic still hands its answer to them: both could stay
// right while the handler stopped using either. A lost no-cache on index.html
// sends a tab reloaded after a self-update back to the old hashed bundle; a
// Content-Encoding that does not match the bytes is a blank page. The build is
// what is served, so this needs it — the register in skip-gates.mjs is what
// notices a leg where it is missing.
const dist = fileURLToPath(new URL("../../../dist/web/index.html", import.meta.url));

describe.skipIf(!existsSync(dist))("the deck's own files, as a browser is served them", () => {
  /** Bytes as they came off the wire: node:http does not decompress, which is
   *  what lets the encoding be checked against the file rather than trusted. */
  const fetchRaw = (path: string, headers: Record<string, string> = {}, method = "GET") =>
    new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>((resolve_, reject) => {
      const req = request({ host: "127.0.0.1", port, path, method, headers }, res => {
        const chunks: Buffer[] = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => resolve_({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on("error", reject);
      req.end();
    });

  const webRoot = dirname(dist);
  const index = () => readFileSync(dist);
  /** The bundle index.html names — a hashed file, so the immutable half. */
  const bundle = () => {
    const src = /src="\/(assets\/[^"]+\.js)"/.exec(index().toString("utf8"))?.[1];
    if (!src) throw new Error("index.html names no bundle");
    return src;
  };

  it("serves the page itself uncached, so a tab reloaded after an update asks again", async () => {
    const r = await fetchRaw("/");
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/^text\/html\b/);
    expect(r.headers["cache-control"]).toBe("no-cache");
    expect(r.headers.vary).toBe("Accept-Encoding");
    // Nothing was offered, so nothing is encoded, and the bytes are the file's.
    expect(r.headers["content-encoding"]).toBeUndefined();
    expect(r.body.equals(index())).toBe(true);
  });

  it("serves a hashed bundle for good, in the encoding the browser takes", async () => {
    const rel = bundle();
    const file = readFileSync(join(webRoot, rel));

    const br = await fetchRaw(`/${rel}`, { "accept-encoding": "br" });
    expect(br.status).toBe(200);
    expect(br.headers["content-encoding"]).toBe("br");
    expect(br.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(br.headers["content-type"]).toMatch(/javascript/);
    expect(Number(br.headers["content-length"])).toBe(br.body.length);
    // The label and the bytes agree — a mismatch here is a blank page.
    expect(brotliDecompressSync(br.body).equals(file)).toBe(true);

    const gz = await fetchRaw(`/${rel}`, { "accept-encoding": "gzip" });
    expect(gz.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(gz.body).equals(file)).toBe(true);

    const plain = await fetchRaw(`/${rel}`, { "accept-encoding": "identity" });
    expect(plain.headers["content-encoding"]).toBeUndefined();
    expect(plain.body.equals(file)).toBe(true);
  });

  it("answers a deep link with the page, uncached like the page", async () => {
    // The SPA fallback. It used to omit the no-cache the normal path sends, and
    // it is index.html either way — the file that names the bundle.
    const r = await fetchRaw("/deep/link");
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/^text\/html\b/);
    expect(r.headers["cache-control"]).toBe("no-cache");
    expect(r.body.equals(index())).toBe(true);
  });

  it("answers a directory with a 404 rather than a listing or the page", async () => {
    const r = await fetchRaw("/assets");
    expect(r.status).toBe(404);
    expect(JSON.parse(r.body.toString("utf8"))).toEqual({ error: "not found" });
  });

  it("never serves a file from outside the web root, however the path is spelled", async () => {
    // The dot segments are resolved by the URL parser before the handler sees
    // them, and an encoded slash is never decoded, so none of these can name a
    // file above dist/web. package.json two levels up is the file they reach
    // for; what comes back must not be it.
    for (const path of [
      "/../../package.json",
      "/%2e%2e/%2e%2e/package.json",
      "/..%2f..%2fpackage.json",
      "/..%5c..%5cpackage.json",
      "/assets/../../../package.json",
    ]) {
      const r = await fetchRaw(path);
      expect(r.body.toString("utf8"), path).not.toContain('"name": "ccdeck"');
    }
  });

  it("answers anything but a GET with 405, the token notwithstanding", async () => {
    const r = await fetchRaw("/", { "x-ccdeck-token": mod.hookToken() }, "POST");
    expect(r.status).toBe(405);
    expect(JSON.parse(r.body.toString("utf8"))).toEqual({ error: "method not allowed" });
  });
});
