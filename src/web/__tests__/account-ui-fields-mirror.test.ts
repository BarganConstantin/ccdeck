// The schema-1 allowlist lives twice — the server's (account-ui-fields.mjs),
// which refuses anything else before it reaches the API, and the page's
// (account-ui-fields.ts), which adds where each setting is stored — and the
// two are held identical here, the way block-notify's rule is held to the
// page's. Then the page's half is held to the deck's own settings: the storage
// key each one has always used, and the way each one reads a stored string.
import { describe, expect, it } from "vitest";
import * as web from "../account-ui-fields";
import { API_SCHEMA1 } from "./account-fake-api";
import { THEME_KEY } from "../theme";
import { DENSITY_KEY, TEXT_SIZE_KEY, resolveDensity, resolveTextSize } from "../reading-preferences";
import { SINGLE_KEY_SHORTCUTS_KEY, resolveSingleKeyShortcuts } from "../single-key-shortcuts";
import { HIDE_FINISHED_KEY, resolveHideFinishedAfter } from "../hide-finished";
import { CHARACTER_ENABLED_KEY, resolveCharacterEnabled } from "../appearance";
import { sourceOf } from "./client-source";
// @ts-expect-error — plain .mjs server module, no types
import * as server from "../../server/account-ui-fields.mjs";

const shape = (fields: readonly { key: string; kind: string; choices?: readonly unknown[]; override?: boolean }[]) =>
  fields.map(f => ({ key: f.key, kind: f.kind, choices: f.choices ? [...f.choices] : undefined, override: f.override === true }));

describe("the two allowlists", () => {
  it("name the same keys, of the same kinds, with the same choices and overrides", () => {
    expect(shape(web.UI_FIELDS)).toEqual(shape(server.UI_FIELDS));
    expect(web.UI_SCHEMA).toBe(server.UI_SCHEMA);
    expect([...web.UI_KEYS]).toEqual([...server.UI_KEYS]);
    expect(web.THEME_ID.source).toBe(server.THEME_ID.source);
  });

  it("are the API's schema 1, key for key", () => {
    expect([...web.UI_KEYS].sort()).toEqual(Object.keys(API_SCHEMA1).sort());
  });

  it("take and refuse the same values", () => {
    const probes: unknown[] = [true, false, 0, 5, 7, 60, "", "default", "compact", "larger", "rider-black", "Rider Black", "x".repeat(41), null, undefined, {}, [], "1"];
    for (const key of [...web.UI_KEYS, "fontFamily", "notifications", "lan.secret"]) {
      for (const v of probes) {
        const valid = web.validUiValue(key, v);
        expect(server.validUiValue(key, v), `${key} = ${JSON.stringify(v)}`).toBe(valid);
        if (key in API_SCHEMA1) expect(API_SCHEMA1[key](v), `API ${key} = ${JSON.stringify(v)}`).toBe(valid);
      }
    }
  });

  it("keep sound on the device in shared mode, and only sound", () => {
    expect([...server.DEFAULT_OVERRIDES]).toEqual(["sound"]);
    expect(web.UI_FIELDS.filter(f => f.override).map(f => f.key)).toEqual(["sound"]);
  });
});

describe("the page's half", () => {
  const storage = Object.fromEntries(web.UI_FIELDS.map(f => [f.key, f.storage]));

  it("reads each setting from the key it has always been kept under", () => {
    expect(storage.theme).toBe(THEME_KEY);
    expect(storage.textSize).toBe(TEXT_SIZE_KEY);
    expect(storage.density).toBe(DENSITY_KEY);
    expect(storage.singleKeyShortcuts).toBe(SINGLE_KEY_SHORTCUTS_KEY);
    expect(storage.hideFinishedAfter).toBe(HIDE_FINISHED_KEY);
    expect(storage.character).toBe(CHARACTER_ENABLED_KEY);
    // The panel flags and the sound switch keep their keys as literals in
    // their hooks; read them out of the source.
    const left = sourceOf("use-left-column.ts");
    const right = sourceOf("use-right-panels.ts");
    const sound = sourceOf("use-sound-switch.ts");
    expect(left).toContain(`SESSION_LIST_OPEN_KEY = "${storage["panels.sessionList"]}"`);
    expect(left).toContain(`ACCOUNTS_PANEL_OPEN_KEY = "${storage["panels.accounts"]}"`);
    expect(right).toContain(`DETAIL_OPEN_KEY = "${storage["panels.detail"]}"`);
    expect(right).toContain(`USAGE_PANEL_OPEN_KEY = "${storage["panels.usage"]}"`);
    expect(right).toContain(`MACHINE_PANEL_OPEN_KEY = "${storage["panels.machine"]}"`);
    expect(sound).toContain(`readStored("${storage.sound}")`);
  });

  it("reads a stored string the way each setting's own reader does", () => {
    const f = (key: string) => web.fieldFor(key)!;
    for (const raw of [null, "", "smallest", "larger", "bogus"]) expect(web.decodeStored(f("textSize"), raw), String(raw)).toBe(resolveTextSize(raw));
    for (const raw of [null, "", "tightest", "comfortable", "bogus"]) expect(web.decodeStored(f("density"), raw), String(raw)).toBe(resolveDensity(raw));
    for (const raw of [null, "0", "1", "x"]) expect(web.decodeStored(f("singleKeyShortcuts"), raw), String(raw)).toBe(resolveSingleKeyShortcuts(raw));
    for (const raw of [null, "0", "5", "15", "60", "7", "x"]) expect(web.decodeStored(f("hideFinishedAfter"), raw), String(raw)).toBe(resolveHideFinishedAfter(raw));
    for (const raw of [null, "0", "1"]) expect(web.decodeStored(f("character"), raw), String(raw)).toBe(resolveCharacterEnabled(raw));
    expect(web.decodeStored(f("sound"), null)).toBe(true);
    expect(web.decodeStored(f("sound"), "on")).toBe(true);
    expect(web.decodeStored(f("sound"), "off")).toBe(false);
    expect(web.decodeStored(f("panels.accounts"), null), "open on a first run").toBe(true);
    expect(web.decodeStored(f("panels.sessionList"), null)).toBe(false);
    expect(web.decodeStored(f("theme"), null)).toBe("rider-black");
  });

  it("writes back the string it reads", () => {
    for (const field of web.UI_FIELDS) {
      const value = field.fallback;
      expect(web.decodeStored(field, web.encodeStored(field, value)), field.key).toBe(value);
    }
  });

  it("announces exactly these keys' writes", () => {
    expect([...web.UI_STORAGE_KEYS].sort()).toEqual(Object.values(storage).sort());
    expect(web.UI_STORAGE_KEYS.has("agent-dag.layout")).toBe(false);
    expect(web.UI_STORAGE_KEYS.has("agent-dag.fm-volume")).toBe(false);
  });
});
