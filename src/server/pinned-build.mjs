// The build this process runs, held in memory before anything can replace it
// on disk (#1042).
//
// This lived in src/server/index.mjs, after the shutdown route. It is the one
// thing an install has to wait for — the Upgrade press and the away-update
// both await it before npm is spawned, and the launcher starts it once the
// boot is over — and none of it touches the server's state, so it moved to a
// leaf those callers can share. The list and the loader are unchanged.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Resolved from this file's own directory, the way every module in src/server
// that imports by URL resolves it, so every URL below is the one the lazy
// imports in src/server name.
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Every server module this process reaches only through `import()`, and so
 * reads off disk the first time it is wanted rather than at boot.
 *
 * THAT IS WHAT A SELF-UPDATE BROKE (#1042). Node caches an evaluated module by
 * its URL for the life of the process, so everything already loaded keeps the
 * code it booted with — which is the whole of why startUpgrade can leave this
 * process serving and let the drift path restart it at an idle moment. A module
 * NOT yet loaded had no such protection: PKG_ROOT is a fixed path, and
 * `npm i -g` rewrites the tree under it. So the first look at the accounts panel
 * after an install evaluated the NEW cswap-admin.mjs beside the OLD
 * claude-accounts.mjs and exec.mjs — a mixed build nobody has ever run — and
 * while npm was mid-reify the same `import()` found no file at all, which
 * lan-engine's roundWith catches and files as that PEER's failed round: a
 * credential sync that did not happen, recorded against the other machine
 * rather than against the install. The window is not short. The idle
 * restart waits on presence and activity, and with autoUpdate off it never
 * comes.
 *
 * Reproduced with the tree swap done in a temp copy of the package: after
 * `POST /api/upgrade`, every one of /api/codex-usage, /api/codex-quota,
 * /api/browser-watch and /api/claude-accounts/login answered 500, and each one
 * had evaluated a module out of the tree npm had just written.
 *
 * So the build is pinned instead. Each module below is imported once, after
 * the boot (markDeckReady) and before any install can start (handleUpgrade and
 * awayUpdateTick both await it), and every lazy import in src/server is a cache
 * hit from then on; their own static imports come with them. Measured, the
 * whole list costs about 10ms and 8MB of RSS, and none of it does any work at
 * import — nothing is spawned, read or written — so the laziness still does
 * what it was for, which is keeping all of this off the path between
 * `npx ccdeck` and a listening socket.
 *
 * The list is every local module that an `import()` in src/server names, and
 * self-update-pins-build.test.ts reads the directory to keep it that way: a lazy
 * import added later without a line here is this bug again.
 */
const PINNED_MODULES = [
  "self-update.mjs",
  "claude-accounts.mjs",
  "account-health.mjs",
  "cswap-admin.mjs",
  "cswap-auto.mjs",
  "quota.mjs",
  "codex-usage.mjs",
  "codex-quota.mjs",
  "ccusage.mjs",
  "browser-watch.mjs",
  "browser-watch-store.mjs",
  "claude-fm.mjs",
  "fm-station.mjs",
  "lofi-girl.mjs",
  "live-radio-mix.mjs",
  "best-of-nostalgia.mjs",
  "good-life-radio.mjs",
  "cafe-music-bgm.mjs",
  // The thermal readers' two (thermal-metrics.mjs imports both; macmon's
  // download is still started from thermal-sampler.mjs), on the platforms that
  // have them, and the one installer.mjs reaches for while it rewrites the hooks.
  "macmon.mjs",
  "hwmonitor.mjs",
  "retire-sound-hook.mjs",
  // The account-projects report: the rollup and the swap log its attribution
  // reads, plus lan-sync for the account key — all reached only through
  // import() from the report's route.
  "account-projects.mjs",
  "swap-log.mjs",
  "lan-sync.mjs",
  // The providers' status pages (#1311), reached only from their route.
  "provider-status.mjs",
];

let _pinned = null;

/**
 * Load every module in PINNED_MODULES, once per process.
 *
 * One at a time rather than all together. It costs nothing measurable, and it
 * means no two of them are ever evaluating at once — the shape that turned an
 * import cycle into an empty namespace (see boot-module-graph.test.ts).
 *
 * A module that fails to load is passed over rather than allowed to stop the
 * rest: waiting will not make it load, and one bad file must not leave the
 * others to be read off whatever npm writes next. The promise never rejects.
 */
export function pinRunningBuild() {
  _pinned ??= (async () => {
    for (const name of PINNED_MODULES) {
      try { await import(pathToFileURL(join(PKG_ROOT, "src/server", name)).href); }
      catch { /* see above */ }
    }
  })();
  return _pinned;
}
