// Where a forge read may be redirected (#2179: off-origin
// hops). The transport follows redirects by hand and drops the token on any hop
// off the connection's origins; that alone kept the token home, but a JSON or
// GraphQL read still followed a hop to ANY host, unsigned, and handed what came
// back to the page as the forge's answer. A hostile or misconfigured forge
// could point the deck at this machine, the LAN or a cloud metadata address
// (server-side request forgery). So:
//   - a JSON or GraphQL read follows a redirect only on the connection's own
//     origins, and refuses any other before it is fetched;
//   - a job log's tail may still leave them — GitHub sends a job's log to a
//     signed blob-storage address — but only for a public https host, never
//     plain http, credentials in the address, this machine or a private
//     network, and never with the token.
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain JS module, no types
import { createForgeTransport, ForgeError } from "../../server/forge-http.mjs";

type Call = { url: string; headers: Record<string, string>; method: string };

/** A fake token, built at run time so no literal here reads as a live one. */
const TOKEN = ["fake", "redirects", "token", "0123456789abcdef"].join("-");
const FORGE = "https://gitlab.example.com";

function transport(routes: Record<string, () => Response>) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: { headers: Record<string, string>; method?: string }) => {
    calls.push({ url, headers: init.headers, method: init.method ?? "GET" });
    const route = routes[url];
    if (!route) throw new Error(`unexpected ${url}`);
    return route();
  };
  const t = createForgeTransport({
    token: TOKEN,
    authHeaders: (tok: string) => ({ authorization: `Bearer ${tok}` }),
    allowedOrigins: [FORGE],
    fetchImpl,
    // A hop off FORGE is made by publicFetchImpl; the fake answers it here, so
    // these tests are about the redirect rule. forge-public-lookup tests that road.
    publicFetchImpl: fetchImpl,
    now: () => 1_700_000_000_000,
  });
  return { t, calls };
}

const jsonRes = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const textRes = (text: string) => new Response(text, { status: 200, headers: { "content-type": "text/plain" } });
const to = (location: string, status = 302) => () => new Response(null, { status, headers: { location } });

async function failure(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    return err as InstanceType<typeof ForgeError>;
  }
  throw new Error("expected a failure");
}

// Hosts a forge must never send the deck to: this machine, private networks,
// a cloud metadata address, and a name with no public suffix.
const PRIVATE = [
  "http://169.254.169.254/latest/meta-data/",
  "https://169.254.169.254/latest/meta-data/",
  "https://127.0.0.1:4317/api/prefs",
  "https://localhost/x",
  "https://10.0.0.5/x",
  "https://192.168.1.10/x",
  "https://[::1]/x",
  "https://intranet/x",
];

describe("a JSON read redirected off the connection's origins", () => {
  for (const away of ["https://elsewhere.example.org/api", ...PRIVATE]) {
    it(`is refused before ${away} is asked`, async () => {
      const { t, calls } = transport({ [`${FORGE}/api/v4/user`]: to(away), [away]: () => jsonRes({ id: 1 }) });
      const err = await failure(t.json(`${FORGE}/api/v4/user`));
      expect(err).toBeInstanceOf(ForgeError);
      expect(err.kind).toBe("incompatible");
      expect(calls.map(c => c.url)).toEqual([`${FORGE}/api/v4/user`]);
    });
  }

  it("is refused for a GraphQL query too, whatever the redirect's status", async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const { t, calls } = transport({
        [`${FORGE}/api/graphql`]: to("https://elsewhere.example.org/graphql", status),
        "https://elsewhere.example.org/graphql": () => jsonRes({ data: { ok: true } }),
      });
      expect((await failure(t.graphql(`${FORGE}/api/graphql`, "query { ok }"))).kind, String(status)).toBe("incompatible");
      expect(calls.map(c => c.url), String(status)).toEqual([`${FORGE}/api/graphql`]);
    }
  });

  it("still follows a redirect on the connection's own origin, signed again", async () => {
    const { t, calls } = transport({ [`${FORGE}/a`]: to("/b"), [`${FORGE}/b`]: () => jsonRes({ ok: true }) });
    expect((await t.json(`${FORGE}/a`)).data).toEqual({ ok: true });
    expect(calls.map(c => [c.url, c.headers.authorization])).toEqual([
      [`${FORGE}/a`, `Bearer ${TOKEN}`], [`${FORGE}/b`, `Bearer ${TOKEN}`],
    ]);
  });
});

describe("a job log's tail redirected off the connection's origins", () => {
  it("follows a public https host, without the token", async () => {
    const blob = "https://results.blob.example.net/logs/1.txt?sig=abc";
    const { t, calls } = transport({ [`${FORGE}/job/1/trace`]: to(blob), [blob]: () => textRes("one\ntwo\n") });
    expect(await t.tail(`${FORGE}/job/1/trace`)).toEqual({ lines: ["one", "two"], truncated: false });
    expect(calls.map(c => c.url)).toEqual([`${FORGE}/job/1/trace`, blob]);
    expect(calls[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[1].headers.authorization).toBeUndefined();
  });

  for (const away of [...PRIVATE, "http://results.blob.example.net/logs/1.txt", "https://user:secret@results.blob.example.net/logs/1.txt"]) {
    it(`refuses ${away} before it is asked`, async () => {
      const { t, calls } = transport({ [`${FORGE}/job/1/trace`]: to(away), [away]: () => textRes("metadata") });
      const err = await failure(t.tail(`${FORGE}/job/1/trace`));
      expect(err).toBeInstanceOf(ForgeError);
      expect(err.kind).toBe("permission");
      expect(calls.map(c => c.url)).toEqual([`${FORGE}/job/1/trace`]);
    });
  }

  it("checks every hop, not only the first", async () => {
    const blob = "https://results.blob.example.net/logs/1.txt";
    const { t, calls } = transport({
      [`${FORGE}/job/1/trace`]: to(blob),
      [blob]: to("http://169.254.169.254/latest/meta-data/"),
      "http://169.254.169.254/latest/meta-data/": () => textRes("metadata"),
    });
    expect((await failure(t.tail(`${FORGE}/job/1/trace`))).kind).toBe("permission");
    expect(calls.map(c => c.url)).toEqual([`${FORGE}/job/1/trace`, blob]);
  });
});
