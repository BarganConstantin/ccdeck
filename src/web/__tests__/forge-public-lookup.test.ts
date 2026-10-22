// A read that leaves the connection's own hosts — a job log's tail sent
// on to blob storage — connects only to a public address.
//
// forge-redirects pins the rule by NAME: such a hop goes only to a public
// https host. A name is not where a socket goes, though: its DNS can answer
// 127.0.0.1, a LAN address or the cloud metadata address. So the hop is made
// by src/server/forge-public-fetch.mjs, whose `lookup` resolves the name once,
// refuses it if any address is not public, and hands the socket only what it
// checked (which also closes DNS rebinding).
//
// What these pin: the address table; the lookup over a fake resolver (the
// six private answers refused, a public one passed); end to end with real
// sockets, that a name answering a loopback address is refused before a
// connection is made, through the transport and through the GitHub client
// built the way the deck builds it, whose own resolver is node:dns; and that
// the answer of such a request reads as fetch's does, tail and all.
//
// Sockets here only ever point at loopback; no test asks real DNS.
import net from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type Found = { address: string; family: number };
type Resolve = (host: string, opts: Record<string, unknown>, cb: (err: Error | null, found?: Found[]) => void) => void;

const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:dns")>();
  return { ...real, default: { ...real, lookup: dns.lookup }, lookup: dns.lookup };
});

import http from "node:http";
import {
  isPublicAddress, NOT_PUBLIC, publicFetch, publicLookup, responseOf,
  // @ts-expect-error — plain JS module, no types
} from "../../server/forge-public-fetch.mjs";
import {
  createForgeTransport, ForgeError,
  // @ts-expect-error — plain JS module, no types
} from "../../server/forge-http.mjs";
// @ts-expect-error — plain JS module, no types
import { createGithubClient } from "../../server/github-api.mjs";

/** A resolver that answers every name with `addresses`, as dns.lookup does
 *  with `all: true`, and records what it was asked. */
function answering(...addresses: string[]) {
  const asked: string[] = [];
  const resolve: Resolve = (host, _opts, cb) => {
    asked.push(host);
    setImmediate(() => cb(null, addresses.map(address => ({ address, family: net.isIP(address) }))));
  };
  return { asked, resolve };
}

/** What a lookup hands back, or the error it refuses with. */
function lookupResult(resolve: Resolve, opts: Record<string, unknown> = {}) {
  return new Promise<{ err: (Error & { code?: string }) | null; address?: unknown; family?: unknown }>((done) => {
    publicLookup(resolve)("blob.example.test", opts, (err: Error | null, address?: unknown, family?: unknown) => done({ err, address, family }));
  });
}

async function failure(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    return err as Error & { code?: string; kind?: string; status?: number };
  }
  throw new Error("expected a failure");
}

// A TCP server on loopback that counts the connections it is offered: a
// refused name must never reach it.
let server: net.Server;
let port = 0;
let connections = 0;
beforeAll(async () => {
  server = net.createServer((socket) => {
    connections++;
    socket.destroy();
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  port = (server.address() as net.AddressInfo).port;
});
afterAll(() => new Promise<void>(done => server.close(() => done())));
beforeEach(() => {
  connections = 0;
  dns.lookup.mockReset();
  dns.lookup.mockImplementation((host: string) => {
    throw new Error(`real DNS asked for ${host}`);
  });
});

const PRIVATE_ANSWERS = ["127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.0.1", "::1", "::ffff:127.0.0.1"];
const LOOPBACK_ANSWERS = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];

describe("which addresses are public", () => {
  it("refuses this machine, private networks, link-local, CGNAT, unique-local, multicast and their IPv6 forms", () => {
    for (const a of [
      "127.0.0.1", "127.255.255.254", "0.0.0.0", "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255",
      "192.168.1.1", "169.254.169.254", "169.254.0.1", "100.64.0.1", "100.127.255.255", "224.0.0.1",
      "239.255.255.250", "240.0.0.1", "255.255.255.255", "192.0.2.10", "198.51.100.7", "203.0.113.9", "198.18.0.1",
      "::", "::1", "fe80::1", "febf::1", "fc00::1", "fd12:3456::1", "ff02::1", "fec0::1",
      "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "::ffff:100.64.0.1",
      "::127.0.0.1", "64:ff9b::7f00:1", "64:ff9b::a00:1", "64:ff9b:1::1", "2002:7f00:1::1", "2002:a9fe:a9fe::1",
      "2001:db8::1", "2001:0:4136:e378::1", "100::1",
      "[::1]", "fe80::1%eth0", "", "localhost", "blob.example.test", "not an address",
    ]) expect(isPublicAddress(a), a).toBe(false);
  });

  it("passes public addresses, including the edges of the private ranges", () => {
    for (const a of [
      "1.1.1.1", "8.8.8.8", "93.184.215.14", "100.63.255.255", "100.128.0.0", "172.15.255.255", "172.32.0.0",
      "169.253.255.255", "192.167.255.255", "223.255.255.255", "126.255.255.255", "11.0.0.1",
      "2606:4700:4700::1111", "2a00:1450:4001:80b::200e", "::ffff:1.1.1.1", "64:ff9b::101:101", "2002:101:101::1",
    ]) expect(isPublicAddress(a), a).toBe(true);
  });
});

describe("the lookup a hop's socket uses", () => {
  for (const address of PRIVATE_ANSWERS) {
    it(`refuses a name that resolves to ${address}`, async () => {
      const r = await lookupResult(answering(address).resolve);
      expect(r.err?.code).toBe(NOT_PUBLIC);
      expect(r.address).toBeUndefined();
      const all = await lookupResult(answering(address).resolve, { all: true });
      expect(all.err?.code).toBe(NOT_PUBLIC);
    });
  }

  it("passes a name that resolves to a public address, in both of a socket's forms", async () => {
    const one = await lookupResult(answering("1.1.1.1").resolve, { family: 0 });
    expect(one).toEqual({ err: null, address: "1.1.1.1", family: 4 });
    const all = await lookupResult(answering("2606:4700:4700::1111", "1.1.1.1").resolve, { all: true });
    expect(all).toEqual({ err: null, address: [{ address: "2606:4700:4700::1111", family: 6 }, { address: "1.1.1.1", family: 4 }], family: undefined });
  });

  it("refuses a name with one private address among public ones", async () => {
    expect((await lookupResult(answering("1.1.1.1", "10.0.0.1").resolve)).err?.code).toBe(NOT_PUBLIC);
    expect((await lookupResult(answering("1.1.1.1", "::ffff:169.254.169.254").resolve, { all: true })).err?.code).toBe(NOT_PUBLIC);
  });

  it("asks the resolver for every address, once, and passes its failure on", async () => {
    const seen: Record<string, unknown>[] = [];
    const failing: Resolve = (_h, opts, cb) => {
      seen.push(opts);
      const err = Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
      setImmediate(() => cb(err));
    };
    expect((await lookupResult(failing, { family: 4 })).err?.code).toBe("ENOTFOUND");
    expect(seen).toEqual([{ family: 4, all: true }]);
    expect((await lookupResult(answering().resolve)).err?.code).toBe("ENOTFOUND");
  });
});

describe("a request to a host nobody typed", () => {
  for (const address of LOOPBACK_ANSWERS) {
    it(`never connects when the name resolves to ${address}`, async () => {
      const { asked, resolve } = answering(address);
      const err = await failure(publicFetch({ resolve })(`https://blob.example.test:${port}/log`, { headers: { accept: "text/plain" } }));
      expect(err.code).toBe(NOT_PUBLIC);
      expect(asked).toEqual(["blob.example.test"]);
      expect(connections).toBe(0);
    });
  }

  it("never connects to a private address written as the host, or over plain http", async () => {
    const { asked, resolve } = answering("1.1.1.1");
    for (const url of [`https://127.0.0.1:${port}/log`, `https://[::ffff:127.0.0.1]:${port}/log`, `http://blob.example.test:${port}/log`]) {
      expect((await failure(publicFetch({ resolve })(url))).code, url).toBe(NOT_PUBLIC);
    }
    expect(asked).toEqual([]);
    expect(connections).toBe(0);
  });
});

describe("what such a request answers", () => {
  // The answer is read off node:http, not fetch; here it is checked to read
  // as fetch's would, by the same tail that reads a fetch answer. Plain http
  // on loopback stands in for the public https host.
  let web: http.Server;
  let webPort = 0;
  beforeAll(async () => {
    web = http.createServer((req, res) => {
      if (req.url === "/log") {
        res.writeHead(206, { "content-type": "text/plain", "set-cookie": ["a=1", "b=2"] });
        res.write("ment of a line\none\n");
        setTimeout(() => res.end("two\nthree\n"), 5);
      } else if (req.url === "/cut") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("half a log\n");
        setTimeout(() => res.socket?.destroy(), 5);
      } else if (req.url === "/moved") {
        res.writeHead(302, { location: "https://blob.example.test/x" });
        res.end("moved");
      } else {
        res.writeHead(304);
        res.end();
      }
    });
    await new Promise<void>(done => web.listen(0, "127.0.0.1", done));
    webPort = (web.address() as net.AddressInfo).port;
  });
  afterAll(() => new Promise<void>(done => web.close(() => done())));

  const get = (path: string, init: { method?: string; headers?: Record<string, string> } = {}) => new Promise<Response>((done, fail) => {
    const req = http.request({ host: "127.0.0.1", port: webPort, path, method: init.method ?? "GET", headers: init.headers }, r => done(responseOf(r, init.method)));
    req.on("error", fail);
    req.end();
  });

  it("reads as fetch's Response: status, headers and a streamed body", async () => {
    const res = await get("/log");
    expect(res.status).toBe(206);
    expect(res.ok).toBe(true);
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(res.headers.get("set-cookie")).toContain("b=2");
    expect(await res.text()).toBe("ment of a line\none\ntwo\nthree\n");
    const moved = await get("/moved");
    expect([moved.status, moved.headers.get("location")]).toEqual([302, "https://blob.example.test/x"]);
    await moved.body?.cancel();
    const none = await get("/none");
    expect([none.status, none.body]).toEqual([304, null]);
  });

  it("fails its reader, and nothing else, when the connection is cut mid-answer", async () => {
    // Readable.toWeb threw "Controller is already closed" out of a close event
    // on Node 18 — an uncaught exception in the deck.
    const res = await get("/cut");
    expect(res.status).toBe(200);
    expect(await failure(res.text())).toBeInstanceOf(Error);
  });

  it("is what a job log's tail reads, without the token", async () => {
    const seen: Record<string, string>[] = [];
    const publicFetchImpl = (url: string, init: { headers: Record<string, string> }) => {
      seen.push(init.headers);
      expect(url).toBe("https://blob.example.test/logs/1.txt?sig=abc");
      return get("/log", { headers: init.headers });
    };
    const t = createForgeTransport({
      token: "fake-lookup-token",
      authHeaders: (tok: string) => ({ authorization: `Bearer ${tok}` }),
      allowedOrigins: ["https://gitlab.example.com"],
      fetchImpl: async () => new Response(null, { status: 302, headers: { location: "https://blob.example.test/logs/1.txt?sig=abc" } }),
      publicFetchImpl,
    });
    expect(await t.tail("https://gitlab.example.com/job/1/trace")).toEqual({ lines: ["one", "two", "three"], truncated: true });
    expect(seen).toHaveLength(1);
    expect(seen[0].authorization).toBeUndefined();
    expect(seen[0].range).toMatch(/^bytes=-\d+$/);
  });
});

describe("a job log's tail sent on to blob storage", () => {
  const FORGE = "https://gitlab.example.com";
  const TOKEN = ["fake", "lookup", "token", "0123456789abcdef"].join("-");

  function transport(publicFetchImpl: unknown) {
    const asked: string[] = [];
    const fetchImpl = async (url: string) => {
      asked.push(url);
      if (url === `${FORGE}/job/1/trace`) return new Response(null, { status: 302, headers: { location: `https://blob.example.test:${port}/logs/1.txt?sig=abc` } });
      throw new Error(`unexpected ${url}`);
    };
    const t = createForgeTransport({
      token: TOKEN,
      authHeaders: (tok: string) => ({ authorization: `Bearer ${tok}` }),
      allowedOrigins: [FORGE],
      fetchImpl,
      publicFetchImpl,
    });
    return { t, asked };
  }

  for (const address of LOOPBACK_ANSWERS) {
    it(`is refused as a host this connection does not read from when the blob host resolves to ${address}`, async () => {
      const { resolve } = answering(address);
      const { t, asked } = transport(publicFetch({ resolve }));
      const err = await failure(t.tail(`${FORGE}/job/1/trace`));
      expect(err).toBeInstanceOf(ForgeError);
      expect(err.kind).toBe("permission");
      expect(err.status).toBe(403);
      expect(err.message).not.toContain(address);
      expect(asked).toEqual([`${FORGE}/job/1/trace`]);
      expect(connections).toBe(0);
    });
  }

  it("is refused through the GitHub client as the deck builds it, whose resolver is node:dns", async () => {
    dns.lookup.mockImplementation((_host: string, _opts: unknown, cb: (err: Error | null, found?: Found[]) => void) => {
      setImmediate(() => cb(null, [{ address: "127.0.0.1", family: 4 }]));
    });
    const API = "https://api.github.com";
    const asked: string[] = [];
    const fetchImpl = async (url: string) => {
      asked.push(url);
      if (url === `${API}/repos/octo-org/widgets/actions/jobs/118/logs`) {
        return new Response(null, { status: 302, headers: { location: `https://results.blob.example.test:${port}/logs/job-logs.txt?sig=abc` } });
      }
      throw new Error(`unexpected ${url}`);
    };
    const c = createGithubClient({ token: "ghp_TEST", fetchImpl });
    const err = await failure(c.jobLogTail("octo-org/widgets", 118, { lines: 4 }));
    expect(err.kind).toBe("permission");
    expect(dns.lookup).toHaveBeenCalledTimes(1);
    expect(dns.lookup.mock.calls[0][0]).toBe("results.blob.example.test");
    expect(asked).toEqual([`${API}/repos/octo-org/widgets/actions/jobs/118/logs`]);
    expect(connections).toBe(0);
  });
});
