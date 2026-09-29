// ownRow — the one spelling of "does this table have its own row for this name"
// (#474), which tool-skin.ts wrote out six times as
// `Object.hasOwn(T, k) ? T[k] : fallback`.
//
// Called directly, on the names that make the question necessary: every member
// an object literal inherits, `__proto__` and `constructor` among them. Then
// swept against a local re-implementation of the six copies it replaced, the
// way duplicated-helpers.test.ts holds a shared function to the copies it
// retired — and tool-skin.ts is read, comments stripped, to prove none of them
// was kept. What the bubbles draw for those names is prototype-keys-474's, and
// it runs against the same code.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { ownRow } from "../own-row";
import { CODEX_TOOL_EMOJI, CODEX_TOOL_LABEL } from "../tool-taxonomy";
import { WEB_DIR } from "./client-source";
import { withoutComments } from "./tsx-scan";

/** Every name an object literal answers without having a row for it. */
const PROTO_KEYS = [
  "toString", "constructor", "valueOf", "hasOwnProperty",
  "isPrototypeOf", "propertyIsEnumerable", "toLocaleString", "__proto__",
];

/** A table shaped like tool-skin's: an object literal with string rows. */
const TABLE: Record<string, string> = { Read: "📖", git: "🌿", ts: "🟦", "package.json": "📦" };

describe("ownRow", () => {
  it("answers a row the table has", () => {
    expect(ownRow(TABLE, "Read")).toBe("📖");
    expect(ownRow(TABLE, "package.json")).toBe("📦");
  });

  it("answers undefined for a name with no row", () => {
    expect(ownRow(TABLE, "frobnicate")).toBeUndefined();
    expect(ownRow(TABLE, "")).toBeUndefined();
    // Case is the caller's business: tool-skin lower-cases filenames and MCP
    // segments before it asks, and nothing here does it for them.
    expect(ownRow(TABLE, "read")).toBeUndefined();
  });

  it("answers undefined for every name the prototype answers", () => {
    for (const key of PROTO_KEYS) {
      // The fixture really is poisonous: bracket access finds something.
      expect((TABLE as Record<string, unknown>)[key], key).toBeDefined();
      expect(ownRow(TABLE, key), key).toBeUndefined();
    }
  });

  it("answers a prototype-named row a table really has", () => {
    // Computed keys, because `{ "__proto__": x }` written as a literal sets the
    // prototype instead of making a row.
    const odd: Record<string, string> = { ["__proto__"]: "p", constructor: "c", toString: "t" };
    expect(Object.hasOwn(odd, "__proto__")).toBe(true);
    expect(ownRow(odd, "__proto__")).toBe("p");
    expect(ownRow(odd, "constructor")).toBe("c");
    expect(ownRow(odd, "toString")).toBe("t");
    expect(ownRow(odd, "valueOf")).toBeUndefined();
  });

  it("hands back the row itself, falsy or not, and never a copy", () => {
    const row = { emoji: "🐙", name: "GitHub" };
    expect(ownRow({ github: row }, "github")).toBe(row);
    expect(ownRow({ empty: "" }, "empty")).toBe("");
    expect(ownRow({ zero: 0 }, "zero")).toBe(0);
    expect(ownRow({ no: false }, "no")).toBe(false);
  });

  it("reads a table with no prototype at all", () => {
    const bare = Object.assign(Object.create(null) as Record<string, string>, { a: "x" });
    expect(ownRow(bare, "a")).toBe("x");
    expect(ownRow(bare, "constructor")).toBeUndefined();
  });
});

describe("the six copies it replaced", () => {
  /** The copy each call site held, with the fallback it held. */
  const copy = <T,>(table: Record<string, T>, key: string, fallback: T) =>
    Object.hasOwn(table, key) ? table[key] : fallback;

  it("answers what each copy answered, over rows, misses and prototype names", () => {
    const tables: Record<string, string>[] = [
      TABLE, CODEX_TOOL_EMOJI, CODEX_TOOL_LABEL,
      { ["__proto__"]: "p", constructor: "c" },
    ];
    const keys = [...PROTO_KEYS, ...Object.keys(TABLE), ...Object.keys(CODEX_TOOL_LABEL), "", "frobnicate", "READ"];
    for (const table of tables) {
      for (const key of keys) {
        for (const fallback of ["✨", "⚙️", ""]) {
          expect(ownRow(table, key) ?? fallback, key).toBe(copy(table, key, fallback));
        }
      }
    }
  });

  it("leaves `??` nothing to change: no row the Codex tables spread in is nullish", () => {
    // `ownRow(T, k) ?? fallback` differs from the copy only on a row whose value
    // is null or undefined. tool-skin's own literals are strings by their type;
    // the two it takes from the Codex spec are derived, so they are asked.
    for (const table of [CODEX_TOOL_EMOJI, CODEX_TOOL_LABEL]) {
      for (const [name, value] of Object.entries(table)) {
        expect(typeof value, name).toBe("string");
        expect(value, name).not.toBe("");
      }
    }
  });

  it("is what tool-skin.ts asks with, and none of the copies is left there", () => {
    const skin = withoutComments(readFileSync(`${WEB_DIR}tool-skin.ts`, "utf8"));
    expect(skin).toMatch(/^import \{ ownRow \} from "\.\/own-row";$/m);
    expect(skin).not.toMatch(/Object\.hasOwn\(/);
    expect(skin.match(/\bownRow\(/g)).toHaveLength(6);
  });

  it("is what every other table read in the client asks with too", () => {
    // The six tables outside tool-skin.ts that answered a name off the wire or
    // off a reply with the same guard spelled out, each its own copy.
    const SITES: Array<[file: string, calls: number]> = [
      ["tool-taxonomy.ts", 1], ["provider-copy.ts", 1], ["injected-prompt.ts", 1],
      ["lan-round.ts", 1], ["sound.ts", 1], ["admin-failure.ts", 2],
    ];
    for (const [file, calls] of SITES) {
      const text = withoutComments(readFileSync(`${WEB_DIR}${file}`, "utf8"));
      expect(text, file).toMatch(/^import \{ ownRow \} from "\.\/own-row";$/m);
      expect(text, file).not.toMatch(/Object\.hasOwn\(/);
      expect(text.match(/\bownRow\(/g), file).toHaveLength(calls);
    }
  });
});
