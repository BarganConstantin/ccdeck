// A fake tracker for the integrations host's suites (#2178). The host's cases
// hold for any provider, so they are run against this one rather than the
// deck's own (src/server/integrations/providers.mjs): a suite registers it
// itself — a provider with the registry's shape, and a small HTTP server on
// this machine that answers as a tracker would and keeps a record of every
// request it was sent.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
// @ts-expect-error — plain .mjs server module, no types
import { errorBody, errorFromFetchFailure, errorFromStatus, errorResponse, integrationError } from "../../server/integrations/errors.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { fetchImage, normaliseBaseUrl } from "../../server/integrations/proxy.mjs";

/** A fake token, built at run time so no literal here reads as a live one. */
export function fakeToken(seed: string): string {
  return ["fake", seed, "token", "0123456789abcdef"].join("-");
}

export const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a1e3f6a40000000049454e44ae426082", "hex");
export const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

/** "echo" quotes the Authorization header it was sent back in its answers,
 *  as a careless tracker or proxy does; "echo-refuse" refuses every signed
 *  request with a 403 that quotes it. */
export type TrackerMode = "ok" | "401" | "429" | "old" | "echo" | "echo-refuse";

export interface FakeTracker {
  url: string;
  /** Every request, in order: its path and whether it carried the token. */
  requests: Array<{ path: string; signed: boolean }>;
  setMode(mode: TrackerMode): void;
  close(): Promise<void>;
}

/** The HTTP Basic credential a user and a token make. */
export const basicCredential = (user: string, token: string) => Buffer.from(`${user}:${token}`, "utf8").toString("base64");

/** The user of an HTTP Basic header made with `token`, or null. */
function basicUserOf(auth: string, token: string): string | null {
  if (!auth.startsWith("Basic ")) return null;
  const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
  const at = decoded.lastIndexOf(":");
  return at > 0 && decoded.slice(at + 1) === token ? decoded.slice(0, at) : null;
}

/** A tracker on 127.0.0.1 that takes `Bearer <token>`, or HTTP Basic with any
 *  user and that token, and nothing else. */
export async function startFakeTracker({ token }: { token: string }): Promise<FakeTracker> {
  let mode: TrackerMode = "ok";
  const requests: FakeTracker["requests"] = [];
  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = String(req.url ?? "/");
    const auth = String(req.headers.authorization ?? "");
    const basicUser = basicUserOf(auth, token);
    const signed = auth === `Bearer ${token}` || basicUser !== null;
    requests.push({ path, signed });
    if (mode === "401") return json(res, 401, { message: "Unauthorized" });
    if (mode === "429") return json(res, 429, { message: "Slow down" }, { "Retry-After": "30" });
    if (path === "/avatar.png") { res.writeHead(200, { "Content-Type": "image/png" }); return res.end(PNG); }
    // Jira Data Center serves an uploaded avatar's PNG under the JPEG label.
    if (path === "/useravatar") { res.writeHead(200, { "Content-Type": "image/jpeg;charset=UTF-8" }); return res.end(PNG); }
    if (path === "/icon.svg") { res.writeHead(200, { "Content-Type": "image/svg+xml" }); return res.end(SVG); }
    if (path === "/fake.png") { res.writeHead(200, { "Content-Type": "image/png" }); return res.end("<!doctype html><title>Log in</title>"); }
    if (path === "/redirect-foreign") { res.writeHead(302, { Location: "https://evil.example/a.png" }); return res.end(); }
    const echo = mode === "echo" || mode === "echo-refuse" ? `, sent ${auth}` : "";
    if (!signed) return json(res, 401, { message: `Unauthorized${echo}` });
    if (mode === "echo-refuse") return json(res, 403, { message: `Not allowed${echo}` });
    if (path === "/myself") return json(res, 200, { id: "u-1", login: basicUser ?? "jdoe", name: `Jane Doe${echo}`, version: mode === "old" ? 1 : 9 });
    if (path === "/items") return json(res, 200, [{ id: 1, title: `First${echo}` }, { id: 2, title: "Second", ...(echo ? { [token]: "a key" } : {}) }]);
    if (path === "/broken") return json(res, 400, { message: `Refused${echo}` });
    return json(res, 404, { message: "Not found" });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    setMode: m => { mode = m; },
    close: () => new Promise<void>(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

export interface ProviderCalls { createClient: number; validate: number; asset: number; routes: string[] }

type Secret = string | { auth: "basic"; email: string; token: string };

/**
 * A provider for the fake tracker, with the registry's shape. The secret is
 * the token as the form gave it (the default parseInput), or with `basic`
 * an object of an email and a token, signed as HTTP Basic. `extraOrigins`
 * are origins its client finds it needs while validating, as a real one may.
 * The tracker's own words on a failure become the error's detail, as a real
 * provider passes them on.
 */
export interface FakeProviderOptions {
  kind?: string;
  label?: string;
  extraOrigins?: () => string[];
  basic?: boolean;
  /** The registry's `available`, when the suite wants one. */
  available?: () => boolean;
  /** An error validate throws before it asks the tracker, or nothing. */
  validateFails?: () => unknown;
}

export function fakeProvider({ kind = "tracker", label = "Tracker", extraOrigins = () => [], basic = false, available, validateFails }: FakeProviderOptions = {}) {
  const calls: ProviderCalls = { createClient: 0, validate: 0, asset: 0, routes: [] };
  const provider = {
    kind,
    label,
    calls,
    ...(available ? { available } : {}),
    ...(basic ? {
      parseInput(input: { baseUrl?: string; email?: string; token?: string }, existing: { secret?: { token?: string } } | null) {
        const baseUrl = normaliseBaseUrl(input?.baseUrl, { field: "baseUrl" });
        const email = typeof input?.email === "string" ? input.email.trim() : "";
        if (!email) throw integrationError("invalid", "Enter the email address.", { field: "email" });
        const token = (typeof input?.token === "string" ? input.token.trim() : "") || existing?.secret?.token || "";
        if (!token) throw integrationError("invalid", "Enter a token.", { field: "token" });
        return { baseUrl, secret: { auth: "basic", email, token }, meta: {} };
      },
    } : {}),
    createClient(conn: { baseUrl: string; allowedOrigins?: string[] }, secret: Secret) {
      calls.createClient += 1;
      const sign = () => (typeof secret === "string"
        ? { Authorization: `Bearer ${secret}` }
        : { Authorization: `Basic ${basicCredential(secret.email, secret.token)}` });
      const origins = [...(conn.allowedOrigins ?? [])];
      async function get(path: string, phase = "use", signal?: AbortSignal) {
        let res: Response;
        try {
          res = await fetch(`${conn.baseUrl}${path}`, { headers: { Accept: "application/json", ...sign() }, redirect: "manual", signal });
        } catch (err) {
          throw errorFromFetchFailure(err, label);
        }
        if (!res.ok) {
          let detail: string | undefined;
          try { detail = String((await res.json())?.message ?? "") || undefined; } catch { /* no reason given */ }
          throw errorFromStatus(res.status, res.headers, { phase, label, detail });
        }
        return res.json();
      }
      const client = {
        allowedOrigins: origins,
        get,
        /** A bug, not a typed error: it names what the client holds. */
        crash(): never {
          throw new Error(`The client failed holding ${JSON.stringify(secret)}`);
        },
        async validate({ phase, signal }: { phase?: string; signal?: AbortSignal } = {}) {
          calls.validate += 1;
          const failure = validateFails?.();
          if (failure) throw failure;
          const me = await get("/myself", phase, signal);
          if (me.version < 2) throw integrationError("incompatible", `This ${label} is older than the deck reads.`);
          for (const origin of extraOrigins()) if (!client.allowedOrigins.includes(origin)) client.allowedOrigins.push(origin);
          return { account: { id: me.id, login: me.login, name: me.name, avatarUrl: `${conn.baseUrl}/avatar.png` }, meta: { version: me.version } };
        },
        fetchAsset(url: string, { maxBytes, signal }: { maxBytes: number; signal?: AbortSignal }) {
          calls.asset += 1;
          return fetchImage(url, { tokenOrigins: client.allowedOrigins, sign, secret, maxBytes, signal });
        },
      };
      return client;
    },
    async routes(client: { get: (path: string, phase?: string, signal?: AbortSignal) => Promise<unknown>; crash: () => never }, method: string, subpath: string, _query: URLSearchParams, _req: unknown, { signal }: { signal?: AbortSignal } = {}) {
      calls.routes.push(`${method} ${subpath}`);
      // A provider whose reads are GET only, as the forge's are.
      if (method !== "GET") return { status: 405, body: errorBody(integrationError("invalid", "That method is not allowed here.")) };
      if (subpath === "crash") return client.crash();
      try {
        if (subpath === "items") return { status: 200, body: { ok: true, items: await client.get("/items", "use", signal) } };
        if (subpath === "broken") return { status: 200, body: { ok: true, broken: await client.get("/broken", "use", signal) } };
        // What serves the reads went away in the middle of one.
        if (subpath === "gone") throw integrationError("unavailable", `${label} stopped answering.`);
        return { status: 404, body: errorBody(integrationError("not-found", "No such read.")) };
      } catch (err) {
        return errorResponse(err);
      }
    },
  };
  return provider;
}
