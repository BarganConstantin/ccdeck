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
import { mkdtempSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { request } from "node:http";
import type { Server } from "node:http";

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

describe("what a plain loopback client can read", () => {
  for (const path of ["/api/events", "/api/claude-accounts", "/api/browser-watch"]) {
    it(`refuses ${path} with no browser headers and no token`, async () => {
      expect(await get(path)).toBe(401);
    });
  }

  it("refuses the SSE stream too, which is the same ring one event at a time", async () => {
    expect(await get("/events")).toBe(401);
  });
});

describe("what the deck's own page can read", () => {
  for (const path of ["/api/events", "/api/claude-accounts", "/api/browser-watch"]) {
    it(`allows ${path} for a same-origin request addressed to loopback`, async () => {
      expect(await get(path, uiHeaders())).not.toBe(401);
    });
  }

  it("allows the token instead, for a client that is not a browser", async () => {
    const token = mod.hookToken();
    expect(typeof token).toBe("string");
    expect(await get("/api/events", { "x-ccdeck-token": token })).not.toBe(401);
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
    expect(await get("/api/events", { host: `127.0.0.1:${port}`, referer: `http://127.0.0.1:${port}/` })).not.toBe(401);
    expect(await get("/events", { host: `127.0.0.1:${port}`, referer: `http://127.0.0.1:${port}/` })).not.toBe(401);
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
});
