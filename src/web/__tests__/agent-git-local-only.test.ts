// The record of which agent made which commit stays on this machine.
//
// It holds commit subjects, repository paths and what each session had spent,
// and none of that belongs in a usage report or an error report. Nothing sends
// it today; these pin the structure that keeps it so, the way a reader of the
// code would check it: the modules that send anything to the reports API
// cannot reach the commit store through any import, the store is read only
// through the git view's own tap, and the store itself opens no connection.
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { withoutComments } from "./tsx-scan";

const SERVER = fileURLToPath(new URL("../../server/", import.meta.url));
const code = (abs: string) => withoutComments(readFileSync(abs, "utf8"));
const rel = (abs: string) => relative(SERVER, abs).replaceAll("\\", "/");

/** Every server module, subfolders included. */
function serverModules(dir = SERVER): string[] {
  return readdirSync(dir).flatMap(name => {
    const abs = join(dir, name);
    return statSync(abs).isDirectory() ? serverModules(abs) : abs.endsWith(".mjs") ? [abs] : [];
  });
}

/** The project modules one module imports — statically, by re-export, or by a
 *  dynamic `import()` with a literal path. */
function depsOf(abs: string): string[] {
  const text = code(abs);
  const specs = [
    ...[...text.matchAll(/(?:^|[\s;])(?:import|export)\b[^;]*?\bfrom\s+["'](\.{1,2}\/[^"']+)["']/g)].map(m => m[1]),
    ...[...text.matchAll(/\bimport\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)].map(m => m[1]),
  ];
  return specs.map(s => resolve(dirname(abs), s)).filter(p => existsSync(p));
}

function closure(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const walk = (abs: string) => {
    if (seen.has(abs)) return;
    seen.add(abs);
    for (const d of depsOf(abs)) walk(d);
  };
  for (const e of entries) walk(join(SERVER, e));
  return seen;
}

// Everything that talks to api.ccdeck.dev: the reports and their facts, the
// error reports, and the feedback form's relay.
const REPORTING = ["reports.mjs", "reports-routes.mjs", "feedback-form.mjs"];
const STORE = join(SERVER, "agent-git-store.mjs");

describe("the agent commit store", () => {
  it("is out of reach of every module that sends a report", () => {
    const reach = [...closure(REPORTING)];
    expect(reach.length, "the walk found the reporting modules' imports").toBeGreaterThan(10);
    expect(reach.map(rel).filter(f => f.startsWith("agent-git-"))).toEqual([]);
    for (const abs of reach) {
      const text = code(abs);
      expect(text, `${rel(abs)} names the commit store`).not.toMatch(/agent-commits|agent-git-/);
    }
  });

  it("is imported only by the git view's own modules, and named only by itself", () => {
    const importers = serverModules().filter(abs => depsOf(abs).includes(STORE)).map(rel);
    expect(importers.every(f => f.startsWith("agent-git-")), importers.join(", ")).toBe(true);
    expect(importers).toContain("agent-git-tap.mjs");
    const naming = serverModules().filter(abs => code(abs).includes("agent-commits.jsonl")).map(rel);
    expect(naming).toEqual(["agent-git-store.mjs"]);
  });

  it("opens no connection of its own", () => {
    // The same walk as above, shown here to follow the git view's own imports.
    const reach = closure(["agent-git-tap.mjs"]);
    expect(reach.has(STORE)).toBe(true);
    for (const abs of closure(["agent-git-store.mjs"])) {
      const text = code(abs);
      expect(text, rel(abs)).not.toMatch(/\bfetch\s*\(|from\s+["']node:(?:https?|http2|net|tls|dgram)["']/);
    }
  });
});
