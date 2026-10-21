// A fake tracker for the integrations host's suites (#2178). This deck
// registers no provider (src/server/integrations/providers.mjs), so a suite
// that needs one registers this one itself: a provider with the registry's
// shape, and a small HTTP server on this machine that answers as a tracker
// would and keeps a record of every request it was sent.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
// @ts-expect-error — plain .mjs server module, no types
import { errorBody, errorFromFetchFailure, errorFromStatus, errorResponse, integrationError } from "../../server/integrations/errors.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { fetchImage } from "../../server/integrations/proxy.mjs";

/** A fake token, built at run time so no literal here reads as a live one. */
export function fakeToken(seed: string): string {
  return ["fake", seed, "token", "0123456789abcdef"].join("-");
}

export const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a1e3f6a40000000049454e44ae426082", "hex");
export const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

export type TrackerMode = "ok" | "401" | "429" | "old";

export interface FakeTracker {
  url: string;
  /** Every request, in order: its path and whether it carried the token. */
  requests: Array<{ path: string; signed: boolean }>;
  setMode(mode: TrackerMode): void;
  close(): Promise<void>;
}

/** A tracker on 127.0.0.1 that takes `Bearer <token>` and nothing else. */
export async function startFakeTracker({ token }: { token: string }): Promise<FakeTracker> {
  let mode: TrackerMode = "ok";
  const requests: FakeTracker["requests"] = [];
  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = String(req.url ?? "/");
    const signed = req.headers.authorization === `Bearer ${token}`;
    requests.push({ path, signed });
    if (mode === "401") return json(res, 401, { message: "Unauthorized" });
    if (mode === "429") return json(res, 429, { message: "Slow down" }, { "Retry-After": "30" });
    if (path === "/avatar.png") { res.writeHead(200, { "Content-Type": "image/png" }); return res.end(PNG); }
    if (path === "/icon.svg") { res.writeHead(200, { "Content-Type": "image/svg+xml" }); return res.end(SVG); }
    if (path === "/fake.png") { res.writeHead(200, { "Content-Type": "image/png" }); return res.end("<!doctype html><title>Log in</title>"); }
    if (path === "/redirect-foreign") { res.writeHead(302, { Location: "https://evil.example/a.png" }); return res.end(); }
    if (!signed) return json(res, 401, { message: "Unauthorized" });
    if (path === "/myself") return json(res, 200, { id: "u-1", login: "jdoe", name: "Jane Doe", version: mode === "old" ? 1 : 9 });
    if (path === "/items") return json(res, 200, [{ id: 1, title: "First" }, { id: 2, title: "Second" }]);
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

/**
 * A provider for the fake tracker, with the registry's shape. The secret is
 * the token as the form gave it (the default parseInput). `extraOrigins` are
 * origins its client finds it needs while validating, as a real one may.
 */
export function fakeProvider({ kind = "tracker", label = "Tracker", extraOrigins = () => [] as string[] } = {}) {
  const calls: ProviderCalls = { createClient: 0, validate: 0, asset: 0, routes: [] };
  const provider = {
    kind,
    label,
    calls,
    createClient(conn: { baseUrl: string; allowedOrigins?: string[] }, secret: string) {
      calls.createClient += 1;
      const sign = () => ({ Authorization: `Bearer ${secret}` });
      const origins = [...(conn.allowedOrigins ?? [])];
      async function get(path: string, phase = "use", signal?: AbortSignal) {
        let res: Response;
        try {
          res = await fetch(`${conn.baseUrl}${path}`, { headers: { Accept: "application/json", ...sign() }, redirect: "manual", signal });
        } catch (err) {
          throw errorFromFetchFailure(err, label);
        }
        if (!res.ok) throw errorFromStatus(res.status, res.headers, { phase, label });
        return res.json();
      }
      const client = {
        allowedOrigins: origins,
        get,
        async validate({ phase, signal }: { phase?: string; signal?: AbortSignal } = {}) {
          calls.validate += 1;
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
    async routes(client: { get: (path: string, phase?: string, signal?: AbortSignal) => Promise<unknown> }, method: string, subpath: string, _query: URLSearchParams, _req: unknown, { signal }: { signal?: AbortSignal } = {}) {
      calls.routes.push(`${method} ${subpath}`);
      // A provider whose reads are GET only, as the forge's are.
      if (method !== "GET") return { status: 405, body: errorBody(integrationError("invalid", "That method is not allowed here.")) };
      try {
        if (subpath === "items") return { status: 200, body: { ok: true, items: await client.get("/items", "use", signal) } };
        return { status: 404, body: errorBody(integrationError("not-found", "No such read.")) };
      } catch (err) {
        return errorResponse(err);
      }
    },
  };
  return provider;
}
