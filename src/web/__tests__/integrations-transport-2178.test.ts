// The rules that keep a tracker's token where it belongs (#2178), held against
// a fake fetch so every request the deck would have made is on the record: the
// token goes to the connection's own origins and nowhere else, a redirect is
// checked hop by hop, an image comes only from a host the provider names and
// only as a raster, and every failure is the shared error envelope.
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs server module, no types
import { createProxy, fetchImage, isPrivateHost, normaliseBaseUrl, IMAGE_MAX_BYTES } from "../../server/integrations/proxy.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { errorResponse, integrationError, isTypedError, ERROR_STATUS } from "../../server/integrations/errors.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { jiraAuthCheck, jiraImageHost, imageUrl, signJira } from "../../server/integrations/jira.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { scrub } from "../../server/reports.mjs";

// Fake tokens, built at run time so no literal here reads as a live one to a
// secret scanner. A Data Center PAT is the base64 of "<id>:<random>", 44
// characters; an Atlassian API token starts ATATT.
const PAT = Buffer.from("000000000000:not-a-real-token-xyz").toString("base64");
const API_TOKEN = "ATATT" + "notarealtoken".repeat(3);
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a1e3f6a40000000049454e44ae426082", "hex");
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

interface Call { url: string; headers: Record<string, string>; redirect?: string }

/** A fetch that answers from a table by URL and records what it was sent. */
function fakeFetch(routes: Record<string, () => Response>) {
  const calls: Call[] = [];
  const impl = async (url: string, init: { headers?: Record<string, string>; redirect?: string } = {}) => {
    calls.push({ url, headers: { ...(init.headers ?? {}) }, redirect: init.redirect });
    const route = routes[url];
    if (!route) return new Response("nope", { status: 404 });
    return route();
  };
  return { calls, impl };
}
const redirect = (to: string, status = 302) => () => new Response(null, { status, headers: { location: to } });
const image = (bytes: Buffer, type = "image/png", headers: Record<string, string> = {}) =>
  () => new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": type, ...headers } });
const json = (body: unknown, headers: Record<string, string> = {}) =>
  () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });

const authOf = (c: Call) => c.headers.Authorization ?? c.headers.authorization;
const SITE = "https://jira.example.com";
const conn = { id: "c1", baseUrl: SITE, allowedOrigins: [SITE] };
const sign = (secret: { token: string }) => ({ Authorization: `Bearer ${secret.token}` });

describe("the proxy a provider reads through", () => {
  it("never sends the token to an origin the connection does not name, and never fetches it", async () => {
    const f = fakeFetch({ "https://evil.example/x": json({}) });
    const proxy = createProxy({ conn, secret: { token: PAT }, sign, fetchImpl: f.impl });
    await expect(proxy.json("https://evil.example/x")).rejects.toMatchObject({ kind: "permission" });
    expect(f.calls).toEqual([]);
  });

  it("follows a redirect by hand, and refuses one off the connection's origins without sending the token there", async () => {
    const f = fakeFetch({
      [`${SITE}/rest/api/2/myself`]: redirect("https://evil.example/steal"),
      "https://evil.example/steal": json({ stolen: true }),
    });
    const proxy = createProxy({ conn, secret: { token: PAT }, sign, fetchImpl: f.impl });
    await expect(proxy.json(`${SITE}/rest/api/2/myself`)).rejects.toMatchObject({ kind: "upstream" });
    expect(f.calls.map(c => c.url)).toEqual([`${SITE}/rest/api/2/myself`]);
    expect(f.calls[0].redirect).toBe("manual");
  });

  it("follows a redirect on its own origins, signed again", async () => {
    const f = fakeFetch({ [`${SITE}/a`]: redirect("/b"), [`${SITE}/b`]: json({ ok: 1 }) });
    const proxy = createProxy({ conn, secret: { token: PAT }, sign, fetchImpl: f.impl });
    expect(await proxy.json(`${SITE}/a`)).toEqual({ ok: 1 });
    expect(f.calls.map(authOf)).toEqual([`Bearer ${PAT}`, `Bearer ${PAT}`]);
  });

  it("reads a refused credential that Jira answers as an anonymous 200", async () => {
    const f = fakeFetch({ [`${SITE}/rest/api/2/myself`]: json({}, { "x-seraph-loginreason": "AUTHENTICATED_FAILED" }) });
    const proxy = createProxy({ conn, secret: { auth: "bearer", token: PAT }, sign, fetchImpl: f.impl, authCheck: jiraAuthCheck, phase: "use" });
    await expect(proxy.json(`${SITE}/rest/api/2/myself`)).rejects.toMatchObject({ kind: "expired" });
    const asked = createProxy({ conn, secret: { auth: "bearer", token: PAT }, sign, fetchImpl: f.impl, authCheck: jiraAuthCheck, phase: "validate" });
    await expect(asked.json(`${SITE}/rest/api/2/myself`)).rejects.toMatchObject({ kind: "auth" });
  });

  it("says a CAPTCHA is a CAPTCHA, which only a browser sign-in clears", () => {
    expect(jiraAuthCheck(new Headers({ "x-seraph-loginreason": "AUTHENTICATION_DENIED" }), {})).toMatch(/CAPTCHA/i);
    expect(jiraAuthCheck(new Headers({}), {})).toBeNull();
  });

  it("gives up at its deadline rather than hanging the panel", async () => {
    const hang = (_url: string, init: { signal?: AbortSignal }) => new Promise<Response>((_, reject) => {
      init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })));
    });
    const proxy = createProxy({ conn, secret: { token: PAT }, sign, fetchImpl: hang });
    await expect(proxy.json(`${SITE}/slow`, { timeoutMs: 50 })).rejects.toSatisfy(isTypedError);
  });

  it("takes https, or plain http on this machine only, and no credentials in the address", () => {
    expect(normaliseBaseUrl("jira.example.com/jira/")).toBe("https://jira.example.com/jira");
    expect(normaliseBaseUrl("http://127.0.0.1:4751")).toBe("http://127.0.0.1:4751");
    expect(() => normaliseBaseUrl("http://jira.example.com")).toThrow(/https/);
    expect(() => normaliseBaseUrl("https://me:pw@jira.example.com")).toThrow(/user name/);
  });
});

describe("an image for the asset route (fetchImage)", () => {
  const cloud = { id: "c2", baseUrl: "https://acme.atlassian.net", allowedOrigins: ["https://acme.atlassian.net"], meta: { deployment: "cloud" } };
  const hosts = (c: typeof cloud) => (u: URL) => jiraImageHost(c, u.href);
  const read = (url: string, f: ReturnType<typeof fakeFetch>, extra: Record<string, unknown> = {}) =>
    fetchImage(url, { tokenOrigins: cloud.allowedOrigins, imageHost: hosts(cloud), sign, secret: { token: PAT }, fetchImpl: f.impl, ...extra });

  it("reads a raster image off a token origin, with the token", async () => {
    const f = fakeFetch({ "https://acme.atlassian.net/secure/useravatar?id=1": image(PNG) });
    const got = await read("https://acme.atlassian.net/secure/useravatar?id=1", f);
    expect(got.contentType).toBe("image/png");
    expect(Buffer.compare(got.bytes, PNG)).toBe(0);
    expect(authOf(f.calls[0])).toBe(`Bearer ${PAT}`);
  });

  it("reads Atlassian's public avatar CDN and Gravatar without the token", async () => {
    const cdn = "https://avatar-management--avatars.us-west-2.prod.public.atl-paas.net/initials/JD-1.png";
    const f = fakeFetch({
      "https://secure.gravatar.com/avatar/abc?d=x": redirect(cdn),
      [cdn]: image(PNG),
    });
    const got = await read("https://secure.gravatar.com/avatar/abc?d=x", f);
    expect(got.contentType).toBe("image/png");
    expect(f.calls.map(c => c.url)).toEqual(["https://secure.gravatar.com/avatar/abc?d=x", cdn]);
    expect(f.calls.map(authOf)).toEqual([undefined, undefined]);
  });

  it("refuses a foreign host before fetching anything", async () => {
    const f = fakeFetch({ "https://evil.example/a.png": image(PNG) });
    await expect(read("https://evil.example/a.png", f)).rejects.toMatchObject({ kind: "permission" });
    expect(f.calls).toEqual([]);
  });

  it("refuses a redirect to a foreign host, and the token never travels with it", async () => {
    const f = fakeFetch({
      "https://acme.atlassian.net/secure/useravatar?id=2": redirect("https://evil.example/steal.png"),
      "https://evil.example/steal.png": image(PNG),
    });
    await expect(read("https://acme.atlassian.net/secure/useravatar?id=2", f)).rejects.toMatchObject({ kind: "permission" });
    expect(f.calls.map(c => c.url)).toEqual(["https://acme.atlassian.net/secure/useravatar?id=2"]);
  });

  it("refuses a redirect to loopback or a private address from a host that is not the tracker", async () => {
    for (const to of ["http://127.0.0.1:4317/api/prefs", "https://127.0.0.1/a.png", "https://10.0.0.5/a.png", "https://intranet/a.png", "https://[::1]/a.png"]) {
      const f = fakeFetch({ "https://secure.gravatar.com/avatar/z": redirect(to), [to]: image(PNG) });
      await expect(read("https://secure.gravatar.com/avatar/z", f), to).rejects.toMatchObject({ kind: "permission" });
      expect(f.calls.map(c => c.url), to).toEqual(["https://secure.gravatar.com/avatar/z"]);
    }
    expect(["127.0.0.1", "10.1.2.3", "192.168.1.1", "172.16.0.1", "169.254.169.254", "100.64.0.1", "intranet", "jira.local", "::1", "fd00::1", "2130706433"].every(isPrivateHost)).toBe(true);
    expect(["jira.sapec.md", "secure.gravatar.com", "8.8.8.8"].some(isPrivateHost)).toBe(false);
  });

  it("lets the tracker's own origin be on this machine, which is a mock or a container", async () => {
    const local = "http://127.0.0.1:4751";
    const f = fakeFetch({ [`${local}/secure/useravatar`]: image(PNG) });
    const got = await fetchImage(`${local}/secure/useravatar`, { tokenOrigins: [local], sign, secret: { token: PAT }, fetchImpl: f.impl });
    expect(got.contentType).toBe("image/png");
  });

  it("refuses SVG, and anything whose bytes are not the image it says it is", async () => {
    const f = fakeFetch({
      "https://acme.atlassian.net/images/icons/priorities/high.svg": image(SVG, "image/svg+xml"),
      "https://acme.atlassian.net/fake.png": image(Buffer.from("<!doctype html><title>Log in</title>"), "image/png"),
      "https://acme.atlassian.net/page": image(Buffer.from("<html></html>"), "text/html"),
    });
    await expect(read("https://acme.atlassian.net/images/icons/priorities/high.svg", f)).rejects.toMatchObject({ kind: "not-found" });
    await expect(read("https://acme.atlassian.net/fake.png", f)).rejects.toMatchObject({ kind: "not-found" });
    await expect(read("https://acme.atlassian.net/page", f)).rejects.toMatchObject({ kind: "not-found" });
  });

  it("caps the size while it streams, whatever Content-Length claims", async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(IMAGE_MAX_BYTES)]);
    const f = fakeFetch({
      "https://acme.atlassian.net/big.png": image(big),
      "https://acme.atlassian.net/liar.png": image(big, "image/png", { "content-length": "100" }),
    });
    await expect(read("https://acme.atlassian.net/big.png", f)).rejects.toMatchObject({ kind: "not-found" });
    await expect(read("https://acme.atlassian.net/liar.png", f)).rejects.toMatchObject({ kind: "not-found" });
    expect(IMAGE_MAX_BYTES).toBe(8 * 1024 * 1024);
  });

  it("reads a 401 on an image as a missing image, never as a token that expired", async () => {
    const f = fakeFetch({ "https://acme.atlassian.net/secure/useravatar?id=3": () => new Response("no", { status: 401 }) });
    const err = await read("https://acme.atlassian.net/secure/useravatar?id=3", f).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "not-found" });
    expect(["auth", "expired"]).not.toContain((err as { kind: string }).kind);
  });

  it("keeps Server and Data Center to the instance itself, plus Gravatar when an admin turned it on", () => {
    const server = { id: "s", baseUrl: "https://jira.example.com", allowedOrigins: ["https://jira.example.com"], meta: { deployment: "server" } };
    expect(jiraImageHost(server, "https://secure.gravatar.com/avatar/x")).toBe(true);
    expect(jiraImageHost(server, "https://avatar-management--avatars.us-west-2.prod.public.atl-paas.net/x.png")).toBe(false);
    expect(jiraImageHost(cloud, "https://avatar-management--avatars.us-west-2.prod.public.atl-paas.net/x.png")).toBe(true);
    expect(jiraImageHost(cloud, "https://api.media.atlassian.com/file/1/binary")).toBe(true);
    expect(jiraImageHost(cloud, "https://evil.atl-paas.net/x.png")).toBe(false);
  });

  it("names every image for the page through the asset route, and draws no SVG at all", () => {
    expect(imageUrl(cloud, "https://acme.atlassian.net/secure/useravatar?id=1")).toBe(
      `/api/integrations/jira/c2/asset?url=${encodeURIComponent("https://acme.atlassian.net/secure/useravatar?id=1")}`);
    expect(imageUrl(cloud, "https://secure.gravatar.com/avatar/x")).toMatch(/^\/api\/integrations\/jira\/c2\/asset\?url=/);
    expect(imageUrl(cloud, "https://acme.atlassian.net/images/icons/priorities/high.svg")).toBeNull();
    expect(imageUrl(cloud, "https://evil.example/a.png")).toBeNull();
  });
});

describe("the error envelope", () => {
  it("maps each kind to the status the contract gives it", () => {
    const status = (kind: string) => errorResponse(integrationError(kind, "x")).status;
    expect(["auth", "expired", "permission", "not-found", "rate-limit", "unreachable", "tls", "incompatible", "upstream"].map(status))
      .toEqual([401, 401, 403, 404, 429, 502, 502, 502, 502]);
    expect(Object.keys(ERROR_STATUS)).toEqual(expect.arrayContaining(["auth", "expired", "permission", "unreachable", "tls", "rate-limit", "incompatible", "not-found", "upstream"]));
  });

  it("carries retryAfter for a rate limit, and says nothing of an error it did not type", () => {
    expect(errorResponse(integrationError("rate-limit", "slow down", { retryAfter: 30 })).body)
      .toEqual({ ok: false, error: { kind: "rate-limit", message: "slow down", retryAfter: 30 } });
    const untyped = errorResponse(new Error(`boom ${PAT}`));
    expect(untyped.status).toBe(500);
    expect(JSON.stringify(untyped.body)).not.toContain(PAT);
  });
});

describe("a token that ends up in a report anyway", () => {
  it("is scrubbed whatever its scheme, including a Data Center PAT short of the generic pattern", () => {
    const basic = Buffer.from(`jane@example.com:${API_TOKEN}`).toString("base64");
    const text = [
      `Authorization: Bearer ${PAT}`,
      `Authorization: Basic ${basic}`,
      `token ${API_TOKEN}`,
    ].join("\n");
    const out = scrub(text, "/home/nobody", "/opt/ccdeck");
    expect(out).not.toContain(PAT);
    expect(out).not.toContain(basic);
    expect(out).not.toMatch(/ATATT/);
  });

  it("signs with the scheme each deployment wants, from the opaque secret only", () => {
    expect(signJira({ auth: "bearer", token: PAT })).toEqual({ Authorization: `Bearer ${PAT}` });
    const basic = signJira({ auth: "basic", email: "jane@example.com", token: "ATATTabc" });
    expect(basic.Authorization).toBe(`Basic ${Buffer.from("jane@example.com:ATATTabc").toString("base64")}`);
  });
});

describe("nothing about a connection reaches a paired deck", () => {
  it("is named by no LAN module, and names none itself", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const server = fileURLToPath(new URL("../../server/", import.meta.url));
    const lan = readdirSync(server).filter(f => /^lan.*\.mjs$/.test(f));
    expect(lan.length).toBeGreaterThan(3);
    for (const f of lan) expect(readFileSync(`${server}${f}`, "utf8"), f).not.toMatch(/integration/i);
    for (const f of readdirSync(`${server}integrations`)) {
      expect(readFileSync(`${server}integrations/${f}`, "utf8"), f).not.toMatch(/from "\.\.\/lan[\w-]*\.mjs"/);
    }
  });
});
