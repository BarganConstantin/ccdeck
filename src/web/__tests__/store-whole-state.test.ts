// `writeStore` writes what it is handed, so every caller must hand it
// everything.
//
// There is no merge with what is on disk, on purpose: a writer that read first
// would have to decide what wins, and two decks racing on that is worse than one
// deck writing a whole state. The cost is that an omitted field is an erased
// field, and that cost was paid once — the settings route wrote `{settings,
// episodes}` and so wiped every dismissal, which meant changing the reaction or
// the quiet gate brought back every episode the reader had reviewed. Measured
// live: two dismissals on disk before a settings POST, zero after.
//
// Grepped rather than exercised, because the failure is a caller that forgets a
// field — which no test of `writeStore` itself can see.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const serverDir = fileURLToPath(new URL("../../server", import.meta.url));

/** Every `writeStore({...})` call in the server, with its object literal. */
function calls(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const name of readdirSync(serverDir)) {
    if (!name.endsWith(".mjs")) continue;
    const text = readFileSync(join(serverDir, name), "utf8");
    for (const m of text.matchAll(/writeStore\)?\(\s*(\{[^}]*\})/g)) out.push([name, m[1]]);
  }
  return out;
}

/** Whether an object literal names a field, by either spelling. */
const NAMES = (literal: string, field: string) =>
  new RegExp(`\\b${field}\\s*[:,}]`).test(literal);

describe("every caller hands writeStore a whole state", () => {
  it("finds the call sites at all", () => {
    // If a rename ever slips them out of this sweep, the assertions below pass
    // by finding nothing — which is the failure mode this file exists to avoid.
    expect(calls().length).toBeGreaterThanOrEqual(2);
  });

  it("names `dismissed` in each one", () => {
    // The field that was dropped. A caller that omits it does not leave the
    // dismissals alone — it erases them.
    // Shorthand counts: `{ dismissed }` hands over the same field as
    // `{ dismissed: x }`, and a test that forced one spelling would be
    // enforcing a style rather than a fact.
    const missing = calls().filter(([, lit]) => !NAMES(lit, "dismissed"));
    expect(missing.map(([f, lit]) => `${f}: ${lit.replace(/\s+/g, " ")}`)).toEqual([]);
  });

  it("names `settings` and `episodes` in each one too", () => {
    // The same argument, for the two fields that happen not to have been
    // forgotten yet.
    const missing = calls().filter(([, lit]) =>
      !NAMES(lit, "settings") || !NAMES(lit, "episodes"));
    expect(missing.map(([f, lit]) => `${f}: ${lit.replace(/\s+/g, " ")}`)).toEqual([]);
  });

  it("says in the writer itself that this is the contract", () => {
    // So the next person to add a field reads why they have to update the
    // callers rather than discovering it the way this was discovered.
    const store = readFileSync(join(serverDir, "browser-watch-store.mjs"), "utf8");
    expect(store).toMatch(/IT WRITES WHAT IT IS HANDED/);
  });
});
