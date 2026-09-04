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
    for (const m of text.matchAll(/(?<!update)writeStore\)?\(\s*(\{[^}]*\})/g)) out.push([name, m[1]]);
  }
  return out;
}

/** Every `updateStore(cur => …)` mutation in the server, with its body.
 *
 *  A different contract, for a caller that owns ONE field: it runs inside the
 *  write queue against the state on disk at that moment, so it either spreads
 *  `cur` or names every field itself. Both are whole states; only one of them
 *  has to be spelled out. */
function updates(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const name of readdirSync(serverDir)) {
    if (!name.endsWith(".mjs")) continue;
    const text = readFileSync(join(serverDir, name), "utf8");
    for (const m of text.matchAll(/updateStore\)?\(\s*(?:async\s*)?(?:cur|current)\s*=>\s*\(?(\{[^}]*\})/g)) {
      out.push([name, m[1]]);
    }
    // The multi-line form, where the callback has a body and a return.
    for (const m of text.matchAll(/updateStore\)?\(\s*(?:async\s*)?(?:cur|current)\s*=>\s*\{([\s\S]{0,400}?)\n\s*\}/g)) {
      out.push([name, m[1]]);
    }
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
    // Most callers moved to `updateStore` when the three writers were
    // serialized, so both sweeps have to find something.
    expect(calls().length + updates().length).toBeGreaterThanOrEqual(3);
    expect(updates().length).toBeGreaterThanOrEqual(2);
  });

  it("keeps every updateStore mutation whole, by spread or by name", () => {
    // The merge-safe path, and the reason it exists: a snapshot takes ~400ms
    // and used to write back the `dismissed` it had read at the start, so a
    // dismissal made while it ran came back on the next poll. A mutation that
    // neither spreads `cur` nor names a field is the same erasure one level in.
    const bad = updates().filter(([, body]) => {
      if (/\.\.\.(cur|current)\b/.test(body)) return false;
      return !(NAMES(body, "settings") && NAMES(body, "episodes") && NAMES(body, "dismissed"));
    });
    expect(bad.map(([f, b]) => `${f}: ${b.replace(/\s+/g, " ").slice(0, 120)}`)).toEqual([]);
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
    // And the other half of the contract, for the callers that own one field.
    expect(store).toMatch(/Read, change, write — with nothing else writing in between/);
  });
});
