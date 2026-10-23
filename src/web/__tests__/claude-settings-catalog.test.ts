// The short list (claude-settings-catalog.mjs) against the list of every key
// Claude Code documents (claude-settings-index.json, read from its reference
// by claude-settings-docs.mjs): a row writes only a key Claude Code documents,
// in the kind of value the reference gives it, and the reading of the page
// holds to the page's shape.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { CLAUDE_SETTING_GROUPS, CLAUDE_SETTINGS } from "../../server/claude-settings-catalog.mjs";
// @ts-expect-error — server module, untyped by design (tsconfig.build.json)
import { anchorFor, parseSettingsReference } from "../../server/claude-settings-docs.mjs";
import index from "../../server/claude-settings-index.json";
import { indexNote, matchKeys, type IndexedKey } from "../components/ClaudeSettingsIndex";

const keys = index.keys as IndexedKey[];
const doc = (key: string) => keys.find(k => k.key === key);

describe("the short list", () => {
  it("writes only keys the reference documents, as the kind of value it documents", () => {
    for (const entry of CLAUDE_SETTINGS) {
      const known = doc(entry.kind === "allowTool" ? "permissions.deny" : entry.key);
      expect(known, entry.id).toBeDefined();
      expect(known!.scope, entry.id).not.toBe("Managed");
      expect(known!.scope, entry.id).not.toBe("Global config");
      if (entry.kind === "switch") expect(known!.kind, entry.id).toBe("boolean");
      if (entry.kind === "days") expect(known!.kind, entry.id).toBe("number");
      if (entry.kind === "choice") {
        expect(known!.kind, entry.id).toBe("choice");
        const offered = (entry.options as { value: string | null }[]).map(o => o.value).filter(v => v !== null);
        expect(offered.every(v => known!.options!.includes(v as string)), entry.id).toBe(true);
      }
    }
  });

  it("shows, for a key no file sets, the default the reference documents", () => {
    for (const entry of CLAUDE_SETTINGS) {
      if (entry.kind !== "switch" && entry.kind !== "days") continue;
      const documented = doc(entry.key)!.default;
      // "unset, so …" in the reference: the words say what that does, which
      // the row's note and its `unset` were written from.
      if (documented === null) continue;
      expect(String(entry.unset), entry.id).toBe(documented);
    }
    // And the ones that read "unset" are the ones checked by hand: off.
    expect(CLAUDE_SETTINGS.filter(e => e.kind === "switch" && doc(e.key)!.default === null).map(e => [e.id, e.unset]))
      .toEqual([["isolatePeerMachines", false]]);
  });

  it("asks for the version the reference names for each key it writes", () => {
    for (const entry of CLAUDE_SETTINGS) {
      const since = doc(entry.kind === "allowTool" ? "crossSessionInbound" : entry.key)!.since;
      if (since) expect(entry.since, entry.id).toBe(since);
    }
  });

  it("puts every row under a caption, gives each a unique id, and keeps every note to one line's worth", () => {
    const groups = new Set(CLAUDE_SETTING_GROUPS.map(g => g.id));
    expect(CLAUDE_SETTINGS.every(e => groups.has(e.group))).toBe(true);
    expect(new Set(CLAUDE_SETTINGS.map(e => e.id)).size).toBe(CLAUDE_SETTINGS.length);
    for (const entry of CLAUDE_SETTINGS) {
      expect(entry.note.length, entry.id).toBeLessThanOrEqual(130);
      expect(entry.note, entry.id).not.toMatch(/!|\bsimply\b|\bjust\b/i);
    }
  });
});

describe("reading the reference", () => {
  // A page of the reference's shape, written for this test.
  const page = [
    "## Settings index", "",
    "| Key | Description | Topic | Scope |", "| :- | :- | :- | :- |",
    "| [`alpha`](#alpha) | Something | Interface | Any file |",
    "| [`beta.gamma`](#beta-gamma) | Something else | Tools | Managed |", "",
    "## Interface", "",
    "### `alpha`", "", "Words about alpha. Requires Claude Code v2.1.50 or later.", "",
    "* **Scope**: [`Any file`](#scopes)", "* **Type**: string, one of:", "  * `\"on\"`: yes", "  * `\"off\"`: no",
    "* **Default**: unset, so it does what it likes", "",
    "### `beta.gamma`", "", "* **Type**: Boolean", "* **Default**: `true`", "",
    "### `delta`", "", "* **Type**: string, one of the model names", "* **Default**: `\"x\"`",
  ].join("\n");

  it("keeps facts about each key and no sentence of the page", () => {
    const { keys: read } = parseSettingsReference(page);
    expect(read).toEqual([
      { key: "alpha", topic: "Interface", scope: "Any file", kind: "choice", options: ["on", "off"], default: null, since: "2.1.50", anchor: "alpha" },
      { key: "beta.gamma", topic: "Tools", scope: "Managed", kind: "boolean", default: "true", since: null, anchor: "beta-gamma" },
      { key: "delta", topic: null, scope: null, kind: "text", default: "\"x\"", since: null, anchor: "delta" },
    ]);
    expect(JSON.stringify(read)).not.toContain("Words about");
    expect(anchorFor("attribution.sessionUrl")).toBe("attribution-sessionurl");
  });

  it("holds the committed list to the same shape, with no prose in it", () => {
    expect(keys.length).toBeGreaterThan(200);
    expect(new Set(keys.map(k => k.key)).size).toBe(keys.length);
    const raw = readFileSync(new URL("../../server/claude-settings-index.json", import.meta.url), "utf8");
    expect(raw).not.toMatch(/"(description|desc|summary)"/);
    for (const k of keys) {
      expect(k.anchor, k.key).toMatch(/^[a-z0-9-]+$/);
      if (k.default) expect(k.default.length, k.key).toBeLessThanOrEqual(40);
    }
  });
});

describe("All settings", () => {
  it("finds a key by its name before its topic", () => {
    const found = matchKeys(keys, "memory").map(k => k.key);
    expect(found[0]).toMatch(/memory/i);
    expect(matchKeys(keys, "  ")).toEqual([]);
    expect(matchKeys(keys, "zzzz-no-such-key")).toEqual([]);
  });

  it("says where a key lives and what it takes, in one line", () => {
    expect(indexNote({ key: "a", topic: "Tools", scope: "Global config", kind: "boolean", default: null, since: "2.1.1", anchor: "a" }))
      .toBe("Tools · on or off · kept in ~/.claude.json · Claude Code 2.1.1+");
    expect(indexNote({ key: "b", topic: "MCP", scope: "Managed", kind: "structured", default: null, since: null, anchor: "b" }))
      .toBe("MCP · a list or object · managed settings only");
  });
});
