/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
// The deck's own two questions about a request's address, asked of the
// terminal socket's upgrade below in the same words the deck asks them.
// @ts-expect-error — plain .mjs server module, no types
import { isLoopbackHost, originMatchesHost } from "./src/server/request-gates.mjs";
import { generateThemes } from "./scripts/theme-compiler.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const devBackend = `http://127.0.0.1:${process.env.CCDECK_DEV_SERVER_PORT ?? "4317"}`;
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

/** The deck this dev server forwards to. */
const DECK = "http://127.0.0.1:4317";

/**
 * The Origin to forward with the terminal socket's upgrade: the deck's own
 * when the request comes from a page this dev server served, and otherwise
 * null, which forwards the browser's Origin untouched for the deck to refuse.
 *
 * The page is served by the dev server and its socket goes to the deck, so the
 * deck's Origin-equals-Host check (terminal-socket.mjs, upgradeVerdict) can
 * only pass if the Origin is rewritten — the same reason the /api hook below
 * rewrites every POST's. But a WebSocket is not a POST: browsers apply no
 * same-origin policy to it, and the Origin check is the ONE thing between a
 * page on another site and a typeable terminal. A blanket rewrite would hand
 * every page the browser has open a way in through this proxy. So it is
 * rewritten only when it names this very dev server — the Origin equals the
 * Host the request was sent to — and that Host is a loopback name, which is
 * the deck's own defence against DNS rebinding, here as well.
 *
 * `headers` is the incoming request's; `deck` is the origin to forward.
 */
export function terminalSocketOrigin(headers: { origin?: unknown; host?: unknown }, deck: string = DECK): string | null {
  const origin = typeof headers?.origin === "string" ? headers.origin.trim() : "";
  const host = typeof headers?.host === "string" ? headers.host : "";
  if (!origin || !isLoopbackHost(host) || !originMatchesHost(origin, host)) return null;
  return deck;
}

export default defineConfig({
  root: resolve(root, "src/web"),
  plugins: [{
    name: "ccdeck-json-themes",
    buildStart() { generateThemes(root); },
    configureServer(server) {
      const themeDir = resolve(root, "src/web/themes");
      server.watcher.add(themeDir);
      const update = (file: string) => {
        if (dirname(file) !== themeDir || !file.endsWith(".json")) return;
        try {
          generateThemes(root);
          // Re-read the canvas palette too; CSS HMR alone leaves its JS cache
          // on the previous values until the user switches themes.
          server.ws.send({ type: "full-reload", path: "*" });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(message);
          server.ws.send({ type: "error", err: { message, stack: "", plugin: "ccdeck-json-themes" } });
        }
      };
      for (const event of ["add", "change", "unlink"] as const) server.watcher.on(event, update);
      server.httpServer?.once("close", () => {
        for (const event of ["add", "change", "unlink"] as const) server.watcher.off(event, update);
      });
    },
  }, react()],
  define: {
    // Injected at build time so the topbar can show the real version without
    // a hardcoded string. JSON.stringify wraps it as a valid JS literal.
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: resolve(root, "dist/web"),
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5174,
    proxy: {
      // THE TERMINAL'S SOCKET, and the only path a WebSocket is forwarded on.
      // First, so it is the entry that matches this path whichever way the
      // proxy walks its list; a plain request on it goes to the deck as any
      // /api request would, and the deck answers it with its 404. The Origin
      // is rewritten only on the upgrade, and only for a page this dev server
      // served — see terminalSocketOrigin.
      "/api/terminal/attach": {
        target: DECK,
        changeOrigin: true,
        ws: true,
        configure: (proxy) => {
          proxy.on("proxyReqWs", (proxyReq, req) => {
            const origin = terminalSocketOrigin(req.headers);
            if (origin) proxyReq.setHeader("origin", origin);
          });
        },
      },
      // READS WORKED HERE AND WRITES DID NOT, which is the worst shape a dev
      // server can have: the panel polls, fills with real accounts and looks
      // alive, and every press comes back refused.
      //
      // index.mjs guards mutations by comparing the request's Origin against
      // its Host — a page may only change the deck it was served by. Through
      // this proxy the page is served by :5174 and the request arrives at
      // :4317, so the two never match and every POST is a 403 the UI could
      // only report as `command failed`.
      //
      // `changeOrigin` rewrites Host to the target; the hook rewrites Origin to
      // match it, and together they make a forwarded request look like what it
      // is — the deck's own UI talking to the deck. THE DEV SERVER ONLY: it is
      // not in the build, it binds loopback, and it already forwards reads of
      // everything the writes would change.
      ...Object.fromEntries(["/api", "/events"].map(path => [path, {
        target: devBackend,
        changeOrigin: true,
        configure: (proxy: { on: (e: string, fn: (req: { setHeader: (k: string, v: string) => void }) => void) => void }) => {
          proxy.on("proxyReq", req => req.setHeader("origin", devBackend));
        },
      }])),
    },
  },
  // #499. There was no `test` block here at all, which meant every budget in
  // the suite was either an explicit number inside a file or vitest's default
  // by omission — survivable while the suite only ran on developer machines,
  // and not once CI runs it on three operating systems. Both numbers below are
  // chosen rather than inherited, and both are stated so that removing a file's
  // local budget leaves it on a documented default instead of an accidental
  // one.
  test: {
    // Up from the 5,000 nobody picked, and the direction deserves a word. The
    // slowest case in this suite that runs on the default measures 2.5s on a
    // developer machine — quota-held-age, which spawns child processes — so the
    // inherited number carried a factor of two, and a factor of two is not
    // headroom on a shared runner with fewer cores. Twenty seconds is eight
    // times the slowest case that runs on it, sits in the same band as the
    // 20s/25s/30s the server-booting suites already state for themselves, and
    // is still a number no healthy case here can reach.
    //
    // The budget also stops being advisory. `__tests__/budget.ts` re-reads the
    // clock after every case and fails one that overran, which is the only way
    // a CPU-bound case can be caught at all: vitest enforces a timeout with a
    // timer, and a synchronous loop never yields to let one fire.
    testTimeout: 20_000,
    // `beforeAll` was on a 10,000 nobody picked either, and the hooks in this
    // suite boot HTTP servers, run `npm pack` and install tarballs. The three
    // that measured their own need said 60s and 90s out loud; thirty is above
    // every one that did not, and still fails a hook that has hung rather than
    // one that is merely slow on Windows.
    hookTimeout: 30_000,
    // no-lan.ts keeps every deck a suite boots off the office network, now that
    // Local network is on by default, and from reporting itself to
    // api.ccdeck.dev as an install, now that anonymous reports are (#1853).
    setupFiles: ["./__tests__/budget.ts", "./__tests__/no-lan.ts"],
    // #702. Several suites here start a real deck out of a temp install and one
    // of them stopped only half of it — a supervisor SIGKILLed, its worker
    // re-parented to init with the port still bound — for months, on every
    // green run. A globalSetup rather than a hook in a file, because the whole
    // failure is that no file noticed: it counts the decks running out of the
    // OS temp directory before and after the suite, and fails the run over any
    // that appeared. Never the user's own deck, which is never installed there.
    globalSetup: ["./__tests__/no-stray-decks.ts"],
  },
});
