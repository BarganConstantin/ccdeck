// #2179: the GitHub and GitLab panels read their forge through one transport,
// src/server/forge-http.mjs.
//
// What these pin: the token goes only to the origins the connection allowed,
// and a redirect off them drops it; every failure leaves as one of the panel's
// error kinds (auth, expired, permission, unreachable, tls, rate-limit,
// incompatible, not-found, upstream) with the retry time when the forge gave
// one; a 2xx that is not JSON is the wrong address; GraphQL errors with data
// are handed back and errors without data throw; and a job log's end is read
// without its colour codes, section markers or a half line.
import { describe, expect, it } from "vitest";
import {
  cleanLogLine, createForgeTransport, epoch, ForgeError, forgeErrorInfo, graphqlError, mapLimit, networkError,
  nextLink, retryAfterSeconds,
  // @ts-expect-error — plain JS module, no types
} from "../../server/forge-http.mjs";

type Call = { url: string; headers: Record<string, string>; method: string };

/** A fetch that answers from a table of URL → Response factory and records
 *  what it was asked. */
function fakeFetch(routes: Record<string, () => Response>) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: { headers: Record<string, string>; method?: string }) => {
    calls.push({ url, headers: init.headers, method: init.method ?? "GET" });
    const route = routes[url];
    if (!route) throw new Error(`unexpected ${url}`);
    return route();
  };
  return { calls, fetchImpl };
}

const jsonRes = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function transport(routes: Record<string, () => Response>, now = 1_700_000_000_000) {
  const f = fakeFetch(routes);
  const t = createForgeTransport({
    token: "glpat-SECRET",
    authHeaders: (tok: string) => ({ authorization: `Bearer ${tok}` }),
    allowedOrigins: ["https://gitlab.example.com"],
    fetchImpl: f.fetchImpl,
    now: () => now,
  });
  return { t, calls: f.calls };
}

async function failure(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    return err as InstanceType<typeof ForgeError>;
  }
  throw new Error("expected a failure");
}

describe("where the token goes", () => {
  it("is attached on the allowed origin and nowhere else", async () => {
    const { t, calls } = transport({
      "https://gitlab.example.com/api/v4/user": () => jsonRes({ id: 1 }),
      "https://elsewhere.example.org/x": () => jsonRes({}),
    });
    await t.json("https://gitlab.example.com/api/v4/user");
    await t.json("https://elsewhere.example.org/x");
    expect(calls[0].headers.authorization).toBe("Bearer glpat-SECRET");
    expect(calls[1].headers.authorization).toBeUndefined();
  });

  it("is dropped when a redirect leaves the allowed origin, and kept when it does not", async () => {
    const { t, calls } = transport({
      "https://gitlab.example.com/a": () => new Response(null, { status: 302, headers: { location: "/b" } }),
      "https://gitlab.example.com/b": () => new Response(null, { status: 302, headers: { location: "https://blob.example.net/log?sig=1" } }),
      "https://blob.example.net/log?sig=1": () => jsonRes({ ok: true }),
    });
    expect((await t.json("https://gitlab.example.com/a")).data).toEqual({ ok: true });
    expect(calls.map(c => c.url)).toEqual([
      "https://gitlab.example.com/a", "https://gitlab.example.com/b", "https://blob.example.net/log?sig=1",
    ]);
    expect(calls[1].headers.authorization).toBe("Bearer glpat-SECRET");
    expect(calls[2].headers.authorization).toBeUndefined();
  });

  it("stops after three redirects", async () => {
    const { t } = transport({
      "https://gitlab.example.com/loop": () => new Response(null, { status: 302, headers: { location: "/loop" } }),
    });
    expect((await failure(t.json("https://gitlab.example.com/loop"))).kind).toBe("upstream");
  });
});

describe("what a failure is called", () => {
  const url = "https://gitlab.example.com/api/v4/user";
  const kindOf = async (res: () => Response) => (await failure(transport({ [url]: res }).t.json(url)));

  it("401 is auth, or expired when the forge says the token expired", async () => {
    expect((await kindOf(() => jsonRes({ message: "401 Unauthorized" }, 401))).kind).toBe("auth");
    const e = await kindOf(() => jsonRes({ error: "invalid_token", error_description: "Token is expired. You can either do re-authorization or token refresh." }, 401));
    expect(e.kind).toBe("expired");
    expect(e.status).toBe(401);
  });

  it("403 is permission, unless it is GitHub's exhausted rate limit", async () => {
    expect((await kindOf(() => jsonRes({ message: "insufficient_scope" }, 403))).kind).toBe("permission");
    const limited = await kindOf(() => jsonRes({ message: "API rate limit exceeded" }, 403, {
      "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(1_700_000_000 + 90),
    }));
    expect(limited).toMatchObject({ kind: "rate-limit", retryAfter: 90 });
    const secondary = await kindOf(() => jsonRes({ message: "You have exceeded a secondary rate limit" }, 403, { "retry-after": "60" }));
    expect(secondary).toMatchObject({ kind: "rate-limit", retryAfter: 60 });
  });

  it("429 is rate-limit with the wait the forge gave", async () => {
    expect(await kindOf(() => jsonRes({ message: "Retry later" }, 429, { "retry-after": "30" })))
      .toMatchObject({ kind: "rate-limit", retryAfter: 30 });
  });

  it("404 is not-found, a proxy's 502-504 is unreachable, other errors are upstream", async () => {
    expect((await kindOf(() => jsonRes({ message: "404 Project Not Found" }, 404))).kind).toBe("not-found");
    expect((await kindOf(() => new Response("<html>Bad Gateway</html>", { status: 502 }))).kind).toBe("unreachable");
    expect((await kindOf(() => jsonRes({ message: "boom" }, 500))).kind).toBe("upstream");
  });

  it("carries the forge's own sentence, not an HTML page", async () => {
    expect((await kindOf(() => jsonRes({ message: "404 Project Not Found" }, 404))).message).toBe("404 Project Not Found");
    expect((await kindOf(() => new Response("<html>Bad Gateway</html>", { status: 502 }))).message).toBe("http 502");
  });

  it("a 2xx that is not JSON is the wrong address", async () => {
    const e = await kindOf(() => new Response("<html>Sign in</html>", { status: 200, headers: { "content-type": "text/html" } }));
    expect(e.kind).toBe("incompatible");
  });

  it("no answer at all is tls for a certificate, unreachable for the rest", () => {
    const wrap = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });
    expect(networkError(wrap("SELF_SIGNED_CERT_IN_CHAIN"), "https://g").kind).toBe("tls");
    expect(networkError(wrap("ERR_TLS_CERT_ALTNAME_INVALID"), "https://g").kind).toBe("tls");
    expect(networkError(wrap("ENOTFOUND"), "https://g").kind).toBe("unreachable");
    const dual = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new AggregateError([Object.assign(new Error("x"), { code: "ECONNREFUSED" })]), {}),
    });
    expect(networkError(dual, "https://g").message).toContain("ECONNREFUSED");
    expect(networkError(new DOMException("t", "TimeoutError"), "https://g").kind).toBe("unreachable");
  });

  it("is reported without the message of an error that is not ours", () => {
    expect(forgeErrorInfo(new Error("secret detail"))).toEqual({ kind: "upstream", message: "unexpected error reading the forge" });
    expect(forgeErrorInfo(new ForgeError("rate-limit", "slow down", { status: 429, retryAfter: 5 })))
      .toEqual({ kind: "rate-limit", message: "slow down", status: 429, retryAfter: 5 });
  });
});

describe("GraphQL", () => {
  const url = "https://gitlab.example.com/api/graphql";

  it("hands back data with its errors", async () => {
    const { t, calls } = transport({ [url]: () => jsonRes({ data: { a: 1 }, errors: [{ message: "field hidden" }] }) });
    const r = await t.graphql(url, "{ a }", { x: 1 });
    expect(r).toEqual({ data: { a: 1 }, errors: [{ message: "field hidden" }] });
    expect(calls[0].method).toBe("POST");
  });

  it("throws typed errors when there is no data", () => {
    expect(graphqlError([{ type: "RATE_LIMITED", message: "API rate limit exceeded" }]).kind).toBe("rate-limit");
    expect(graphqlError([{ type: "INSUFFICIENT_SCOPES", message: "needs read:org" }]).kind).toBe("permission");
    expect(graphqlError([{ type: "NOT_FOUND", message: "Could not resolve to a Repository" }]).kind).toBe("not-found");
    // GitLab hides what a token may not see behind the same sentence as what
    // is gone, so it is not-found: the item is not there for this token.
    expect(graphqlError([{ message: "The resource that you are attempting to access does not exist or you don't have permission to perform this action" }]).kind)
      .toBe("not-found");
    expect(graphqlError([]).kind).toBe("upstream");
  });
});

describe("the end of a job log", () => {
  const url = "https://gitlab.example.com/api/v4/projects/1/jobs/2/trace";

  it("cleans colour codes, GitLab section markers and redrawn progress", () => {
    expect(cleanLogLine("\x1b[32;1mJob succeeded\x1b[0;m")).toBe("Job succeeded");
    expect(cleanLogLine("section_start:1700000000:step_script\r\x1b[0K\x1b[0K\x1b[36;1mExecuting \"step_script\" stage\x1b[0;m"))
      .toBe("Executing \"step_script\" stage");
    expect(cleanLogLine("section_end:1700000001:step_script\r\x1b[0K")).toBe("");
    expect(cleanLogLine("10%\r50%\r100% done\r")).toBe("100% done");
  });

  it("drops the half line a suffix range starts with", async () => {
    const { t, calls } = transport({
      [url]: () => new Response("ment\nline a\n\x1b[31mERROR boom\x1b[0m\n\n", { status: 206, headers: { "content-type": "text/plain" } }),
    });
    expect(await t.tail(url)).toEqual({ lines: ["line a", "ERROR boom"], truncated: true });
    expect(calls[0].headers.range).toBe("bytes=-262144");
  });

  it("keeps only the last lines of a whole log", async () => {
    const body = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const { t } = transport({ [url]: () => new Response(body, { status: 200 }) });
    const r = await t.tail(url, { lines: 3 });
    expect(r).toEqual({ lines: ["line 497", "line 498", "line 499"], truncated: true });
  });

  it("does not let the blank lines a log ends on take the place of real ones", async () => {
    const body = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n") + "\n\n\n";
    const { t } = transport({ [url]: () => new Response(body, { status: 200 }) });
    expect((await t.tail(url, { lines: 3 })).lines).toEqual(["line 497", "line 498", "line 499"]);
  });

  it("says nothing was cut from a short log", async () => {
    const { t } = transport({ [url]: () => new Response("a\nb\n", { status: 200 }) });
    expect(await t.tail(url)).toEqual({ lines: ["a", "b"], truncated: false });
  });

  it("refuses a log past the cap rather than show its middle as its end", async () => {
    const { t } = transport({ [url]: () => new Response("x".repeat(5000), { status: 200 }) });
    expect((await failure(t.tail(url, { maxBytes: 1000 }))).kind).toBe("upstream");
  });
});

describe("an image for the deck to pass on", () => {
  const png = () => new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { "content-type": "image/png" } });
  const images = (u: URL) => u.host === "gitlab.example.com" || u.host === "img.example.org";

  it("comes back as bytes with its type, the token only on the allowed origin", async () => {
    const { t, calls } = transport({
      "https://gitlab.example.com/uploads/a.png": png,
      "https://img.example.org/b.png": png,
    });
    const a = await t.asset("https://gitlab.example.com/uploads/a.png", { allow: images });
    await t.asset("https://img.example.org/b.png", { allow: images });
    expect(a.contentType).toBe("image/png");
    expect([...a.bytes]).toEqual([137, 80, 78, 71]);
    expect(calls[0].headers.authorization).toBe("Bearer glpat-SECRET");
    expect(calls[1].headers.authorization).toBeUndefined();
  });

  it("is never fetched from a host the forge does not serve images from, nor redirected to one", async () => {
    const { t, calls } = transport({
      "https://img.example.org/hop": () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } }),
    });
    expect((await failure(t.asset("https://intranet.example.net/x.png", { allow: images }))).kind).toBe("permission");
    expect((await failure(t.asset("https://img.example.org/hop", { allow: images }))).kind).toBe("permission");
    expect(calls.map(c => c.url)).toEqual(["https://img.example.org/hop"]);
  });

  it("must be a raster image: an SVG, a page or a JSON answer is refused", async () => {
    const { t } = transport({
      "https://img.example.org/s.svg": () => new Response("<svg/>", { status: 200, headers: { "content-type": "image/svg+xml" } }),
      "https://img.example.org/p": () => new Response("<html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }),
    });
    expect((await failure(t.asset("https://img.example.org/s.svg", { allow: images }))).kind).toBe("incompatible");
    expect((await failure(t.asset("https://img.example.org/p", { allow: images }))).kind).toBe("incompatible");
  });

  it("is refused past the cap, whether or not the size was announced", async () => {
    const big = (announce: boolean) => () => new Response(new Uint8Array(2000), {
      status: 200, headers: { "content-type": "image/jpeg", ...(announce ? { "content-length": "2000" } : {}) },
    });
    const { t } = transport({ "https://img.example.org/a.jpg": big(true), "https://img.example.org/b.jpg": big(false) });
    expect((await failure(t.asset("https://img.example.org/a.jpg", { allow: images, maxBytes: 1000 }))).message).toBe("image too large");
    expect((await failure(t.asset("https://img.example.org/b.jpg", { allow: images, maxBytes: 1000 }))).message).toBe("image too large");
  });

  it("a missing image is the forge's own failure", async () => {
    const { t } = transport({ "https://img.example.org/gone.png": () => new Response("", { status: 404 }) });
    expect((await failure(t.asset("https://img.example.org/gone.png", { allow: images }))).kind).toBe("not-found");
  });
});

describe("small helpers", () => {
  it("reads the next page from a Link header", () => {
    const h = new Headers({ link: '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=9>; rel="last"' });
    expect(nextLink(h)).toBe("https://api.github.com/x?page=2");
    expect(nextLink(new Headers())).toBeNull();
  });

  it("reads Retry-After as seconds or a date", () => {
    const now = Date.parse("2026-10-19T10:00:00Z");
    expect(retryAfterSeconds(new Headers({ "retry-after": "Mon, 19 Oct 2026 10:00:45 GMT" }), now)).toBe(45);
    expect(retryAfterSeconds(new Headers({ "ratelimit-reset": String(now / 1000 + 12) }), now)).toBe(12);
    expect(retryAfterSeconds(new Headers(), now)).toBeUndefined();
  });

  it("parses times and runs work with a limit, in order", async () => {
    expect(epoch("2026-10-19T10:00:00Z")).toBe(Date.parse("2026-10-19T10:00:00Z"));
    expect(epoch(null)).toBeNull();
    let running = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n: number) => {
      peak = Math.max(peak, ++running);
      await new Promise(r => setTimeout(r, 1));
      running--;
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50]);
    expect(peak).toBe(2);
  });
});
