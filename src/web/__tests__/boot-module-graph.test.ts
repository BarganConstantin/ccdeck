// A module cycle in src/server showed up as a boot step that silently did
// nothing, on two of three CI runners, with every test passing.
//
// `startServer` hands cswap-admin's `autoRecapture` to claude-accounts'
// `repairStaleCopyWith`, so a paused account's roster row carries its own
// repair instead of a button. What CI printed:
//
//     Test Files  446 passed (446)
//          Tests  6740 passed (6740)
//         Errors  1 error
//     TypeError: accounts.repairStaleCopyWith is not a function
//
// Instrumenting the call site printed the reason: `Object.keys(accounts)` and
// `Object.keys(admin)` were BOTH empty. claude-accounts.mjs imported
// `currentIdentity` from cswap-admin.mjs, and cswap-admin.mjs imported
// `backupRoot`, `invalidateClaudeAccountsCache` and `verdictNow` back — one
// cycle, and the only one in src/server. Two dynamic imports that enter a cycle
// concurrently are each handed the other module's half-built namespace instead
// of waiting for it, and a half-built namespace has no exports defined on it
// yet. So the wiring ran against two empty objects, threw inside a promise
// nothing awaits, and the repair was never installed — while the summary above
// it said everything was fine. Only vitest counting an unhandled rejection made
// the run exit 1 at all.
//
// TWO THINGS THAT MAKE THIS WORTH A FILE OF ITS OWN.
//
// It could not be reproduced by importing the two modules and checking them. On
// its own the concurrent version resolves both perfectly well; it took a full
// 445-file suite, and then only on Linux and macOS — Windows passed the same
// commit. Bisecting across seven full-suite runs put the trigger at "any change
// to the import list of a module that reaches this pair": adding one import to
// cswap-auto.mjs was enough, while the parent commit — and the parent commit
// plus two extra test files, to rule out worker scheduling — exited 0. And
// sequencing the one call site was NOT enough, which is how it failed CI twice:
// `cswapAutoModule()` imports claude-accounts.mjs a few lines later, and
// `startServer` can be called again before the first wiring has settled.
//
// So the assertion cannot be about that call site. It has to be about the
// graph, which is the thing that was actually wrong and the only thing a test
// can check deterministically: there is no cycle to enter.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";

const PKG_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const SERVER = resolve(fileURLToPath(new URL("../../server", import.meta.url)));
const read = (name: string) => readFileSync(join(SERVER, name), "utf8");

/** Every `./x.mjs` one server module pulls in, by import OR by re-export. */
function relativeDeps(source: string): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(/^\s*(?:import|export)[^;]*?from\s+"(\.\/[^"]+)"/gm)) {
    out.add(m[1].slice(2));
  }
  return [...out].sort();
}

/** The static import graph of src/server, file name to file names. */
function graph(): Record<string, string[]> {
  const g: Record<string, string[]> = {};
  for (const f of readdirSync(SERVER).filter(n => n.endsWith(".mjs")).sort()) {
    g[f] = relativeDeps(read(f));
  }
  return g;
}

describe("the static import graph of src/server", () => {
  it("has no cycles, because a cycle is handed out as an empty namespace", () => {
    // Dynamic `import()` is what the deck's boot uses everywhere, and a module
    // reached through a cycle while it is still evaluating comes back with no
    // exports rather than throwing. That is a whole class of silent failure —
    // the caller sees an object, reads `undefined` off it, and either calls it
    // (a TypeError nobody catches, which is this bug) or stores it and does
    // nothing (which would not even be a TypeError).
    //
    // Checked over the whole directory rather than over the one pair that
    // broke: the next cycle will be between two other files, and the cost of
    // knowing is one directory read.
    const g = graph();
    const cycles: string[] = [];
    const seenFrom = new Set<string>();
    const walk = (node: string, stack: string[]) => {
      for (const next of g[node] ?? []) {
        const at = stack.indexOf(next);
        if (at !== -1) { cycles.push([...stack.slice(at), next].join(" -> ")); continue; }
        if (seenFrom.has(next)) continue;
        seenFrom.add(next);
        walk(next, [...stack, next]);
      }
    };
    for (const entry of Object.keys(g)) walk(entry, [entry]);
    expect([...new Set(cycles)], "a module cycle is back in src/server").toEqual([]);
  });

  it("keeps the two modules that were in one importing only in one direction", () => {
    // Named explicitly as well, because this pair is the one the boot wires
    // together and the general rule above would not say which edge came back.
    expect(read("cswap-admin.mjs")).toMatch(/^import .*from "\.\/claude-accounts\.mjs";$/m);
    expect(
      read("claude-accounts.mjs"),
      "claude-accounts.mjs imports cswap-admin.mjs again, which is the cycle",
    ).not.toMatch(/^import .*from "\.\/cswap-admin\.mjs";$/m);
  });
});

describe("the two modules the boot wires together", () => {
  it("each expose the function the call site reaches for", async () => {
    // Loaded the way index.mjs loads them — by file URL out of the package root
    // — rather than by the specifier this file would normally use, because that
    // is the resolution the boot actually performs.
    const accounts = await import(pathToFileURL(join(PKG_ROOT, "src/server/claude-accounts.mjs")).href);
    const admin = await import(pathToFileURL(join(PKG_ROOT, "src/server/cswap-admin.mjs")).href);
    expect(typeof (accounts as Record<string, unknown>).repairStaleCopyWith).toBe("function");
    expect(typeof (admin as Record<string, unknown>).autoRecapture).toBe("function");
  });

  it("still answer for the two names the identity oracle moved out from under", () => {
    // `adminClaudeBin` and `currentIdentity` live in claude-identity.mjs now and
    // are re-exported from cswap-admin.mjs, which is where their callers and
    // their tests look. A move that quietly dropped the re-export would leave
    // admin-claude-bin.test.ts and cswap-identity.test.ts importing undefined.
    expect(read("cswap-admin.mjs")).toMatch(/^export \{ adminClaudeBin, currentIdentity \};$/m);
  });
});

describe("the modules that exist so that others need not import each other", () => {
  it("import nothing of this project's, so they can never join a cycle", () => {
    // store-lock.mjs holds the one store mutex, which four writers in three
    // files must all reach; claude-identity.mjs holds the CLI identity oracle,
    // which both halves of the accounts surface need. Each exists precisely so
    // that the modules needing it do not have to import one another — and each
    // is worth nothing if it is itself reachable only through a cycle, because
    // a lock or an oracle read out of a half-built namespace is `undefined` at
    // the moment it is wanted. For the lock that is worse than no lock: the
    // mutation throws instead of queueing.
    //
    // Asserted as "no relative import AT ALL" rather than "not those two",
    // because the next dependency added here is the one that would put it back
    // in a cycle, and it would look reasonable at the time.
    expect(relativeDeps(read("store-lock.mjs"))).toEqual([]);
    // claude-identity.mjs runs a subprocess, so it needs two modules — both of
    // which are leaves themselves, which is the property that matters.
    const identity = relativeDeps(read("claude-identity.mjs"));
    expect(identity).toEqual(["claude-dir.mjs", "exec.mjs"]);
    for (const leaf of identity) {
      expect(relativeDeps(read(leaf)), `${leaf} is no longer a leaf`).toEqual([]);
    }
  });

  it("are the single lock all four writers hold", async () => {
    // One module instance, one chain. Two modules each importing a lock from a
    // different place would each be serialized against themselves and against
    // nothing else — the defect wearing the fix's clothes — and identity is the
    // only assertion that tells those apart.
    const lock = await import("../../server/store-lock.mjs");
    const admin = await import("../../server/cswap-admin.mjs");
    expect(admin.withStoreLock).toBe(lock.withStoreLock);
    for (const name of ["claude-accounts.mjs", "cswap-auto.mjs"]) {
      expect(read(name), `${name} takes the lock from somewhere else`)
        .toMatch(/^import \{ withStoreLock \} from "\.\/store-lock\.mjs";$/m);
    }
  });
});
