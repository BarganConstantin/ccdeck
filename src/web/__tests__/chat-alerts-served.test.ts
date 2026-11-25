// Interactive alerts, the server's half: the deck serves its service worker
// (src/web/public/sw.js, copied to dist/web/sw.js by the build) at /sw.js, as
// a script, and revalidated on every load, so a deck that upgrades never runs
// last version's worker. Run through the real static handler, with only the
// disk under it stood in for, so the test needs no build.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const WORKER = readFileSync(resolve(here, "../public/sw.js"));
const BUILT = join(resolve(here, "../../.."), "dist", "web", "sw.js");

vi.mock("node:fs/promises", async importOriginal => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    stat: async (path: string) => (path === BUILT ? { isDirectory: () => false, mtimeMs: 1 } : real.stat(path)),
    readFile: async (path: string, ...rest: unknown[]) => (path === BUILT ? WORKER : (real.readFile as (...a: unknown[]) => unknown)(path, ...rest)),
  };
});

const { serveStatic } = await import("../../server/static-serve.mjs");

function fakeRes() {
  const r: { status?: number; headers?: Record<string, unknown>; body?: string } = {};
  return {
    r,
    res: {
      writeHead(status: number, headers?: Record<string, unknown>) { r.status = status; r.headers = headers; },
      end(b?: unknown) { r.body = b == null ? "" : String(b); },
      setHeader() {}, getHeader() { return undefined; },
    },
  };
}

describe("the deck serving its service worker", () => {
  it("serves /sw.js as a script, revalidated on every load", async () => {
    const { r, res } = fakeRes();
    await serveStatic({ method: "GET", url: "/sw.js", headers: {} }, res, new URL("http://127.0.0.1/sw.js"));
    expect(r.status).toBe(200);
    expect(r.headers?.["Content-Type"]).toBe("text/javascript; charset=utf-8");
    expect(r.headers?.["Cache-Control"]).toBe("no-cache");
    expect(r.body).toContain("notificationclick");
  });

  it("serves every script of the deck as text/javascript", () => {
    const src = readFileSync(resolve(here, "../../server/static-serve.mjs"), "utf8");
    expect(src).toMatch(/"\.js":\s*"text\/javascript; charset=utf-8"/);
    expect(src).toMatch(/"\.mjs":\s*"text\/javascript; charset=utf-8"/);
  });

  it("ships the worker at the root of the build, where its scope is the whole deck", () => {
    // Vite copies src/web/public to the root of dist/web; the worker is not a
    // bundled module and must not be one, or it would get a hashed name.
    expect(readFileSync(resolve(here, "../../../vite.config.ts"), "utf8")).not.toMatch(/publicDir:\s*false/);
    expect(WORKER.toString()).not.toMatch(/addEventListener\("fetch"/);
  });
});
