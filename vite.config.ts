/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";

const root = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

export default defineConfig({
  root: resolve(root, "src/web"),
  plugins: [react()],
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
      "/api": "http://127.0.0.1:4317",
      "/events": "http://127.0.0.1:4317",
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
    setupFiles: ["./__tests__/budget.ts"],
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
