// The settings a ccdeck account carries between this person's decks — the
// page's copy of schema 1, with where each one lives in localStorage.
//
// THE SAME LIST AS THE SERVER'S, held identical by
// account-ui-fields-mirror.test.ts (src/server/account-ui-fields.mjs): the
// keys, what each may hold, and which a device keeps for itself in shared
// mode. The server refuses anything else before it reaches the API; this copy
// adds the half only the page knows — the storage key each setting has always
// been kept under, and how its stored string reads as a value.
//
// Pure, and importing nothing, because storage.ts imports it to know which
// writes to announce (the `ccdeck:stored` event), and the suite runs it in
// bare node.

export const UI_SCHEMA = 1;

export type UiValue = string | number | boolean;
export type UiValues = Record<string, UiValue>;

export interface UiField {
  key: string;
  kind: "theme" | "choice" | "minutes" | "bool";
  choices?: readonly (string | number)[];
  /** Kept by the device in shared mode unless told otherwise. */
  override?: boolean;
  /** The localStorage key the page has always kept it under. */
  storage: string;
  /** What a missing stored value reads as: each setting's own first-run default. */
  fallback: UiValue;
}

export const TEXT_SIZES = ["smallest", "smaller", "default", "larger", "largest"] as const;
export const DENSITIES = ["tightest", "tighter", "compact", "default", "comfortable"] as const;
export const HIDE_FINISHED_CHOICES = [0, 5, 15, 30, 60] as const;
export const THEME_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const UI_FIELDS: readonly UiField[] = [
  { key: "theme", kind: "theme", storage: "agent-dag.theme", fallback: "rider-black" },
  { key: "textSize", kind: "choice", choices: TEXT_SIZES, storage: "agent-dag.text-size", fallback: "default" },
  { key: "density", kind: "choice", choices: DENSITIES, storage: "agent-dag.density", fallback: "default" },
  { key: "panels.sessionList", kind: "bool", storage: "agent-dag.sessionListOpen", fallback: false },
  { key: "panels.accounts", kind: "bool", storage: "agent-dag.accountsPanelOpen", fallback: true },
  { key: "panels.detail", kind: "bool", storage: "agent-dag.detailOpen", fallback: false },
  { key: "panels.usage", kind: "bool", storage: "agent-dag.usagePanelOpen", fallback: true },
  { key: "panels.machine", kind: "bool", storage: "agent-dag.systemPanelOpen", fallback: true },
  { key: "singleKeyShortcuts", kind: "bool", storage: "agent-dag.single-key-shortcuts", fallback: true },
  { key: "hideFinishedAfter", kind: "minutes", choices: HIDE_FINISHED_CHOICES, storage: "agent-dag.hide-finished-after", fallback: 0 },
  { key: "character", kind: "bool", storage: "agent-dag.character-enabled", fallback: true },
  { key: "sound", kind: "bool", override: true, storage: "agent-dag.sound", fallback: true },
];

export const UI_KEYS: readonly string[] = UI_FIELDS.map(f => f.key);

const BY_KEY = new Map(UI_FIELDS.map(f => [f.key, f]));
const BY_STORAGE = new Map(UI_FIELDS.map(f => [f.storage, f]));

/** The storage keys whose writes storage.ts announces. */
export const UI_STORAGE_KEYS: ReadonlySet<string> = new Set(UI_FIELDS.map(f => f.storage));

export function fieldForStorageKey(storageKey: string): UiField | undefined {
  return BY_STORAGE.get(storageKey);
}

export function fieldFor(key: string): UiField | undefined {
  return BY_KEY.get(key);
}

/** Whether `value` is one `key` may hold — the server's rule, word for word. */
export function validUiValue(key: string, value: unknown): boolean {
  const field = BY_KEY.get(key);
  if (!field) return false;
  switch (field.kind) {
    case "theme": return typeof value === "string" && THEME_ID.test(value);
    case "choice": return typeof value === "string" && (field.choices ?? []).includes(value);
    case "minutes": return typeof value === "number" && (field.choices ?? []).includes(value);
    case "bool": return typeof value === "boolean";
    default: return false;
  }
}

/** A stored string as the value the deck shows for it — the rule each
 *  setting's own reader applies (theme.ts, reading-preferences.ts, the panel
 *  loaders, single-key-shortcuts.ts, hide-finished.ts, appearance.ts,
 *  use-sound-switch.ts). */
export function decodeStored(field: UiField, raw: string | null): UiValue {
  if (raw === null) return field.fallback;
  switch (field.key) {
    case "theme": return THEME_ID.test(raw) ? raw : field.fallback;
    case "textSize":
    case "density": return (field.choices ?? []).includes(raw) ? raw : "default";
    case "panels.sessionList":
    case "panels.accounts":
    case "panels.detail":
    case "panels.usage":
    case "panels.machine": return raw === "1";
    case "singleKeyShortcuts":
    case "character": return raw !== "0";
    case "hideFinishedAfter": {
      const n = Number(raw);
      return (field.choices ?? []).includes(n) ? n : 0;
    }
    case "sound": return raw === "on";
    default: return field.fallback;
  }
}

/** A value as the string its setting stores. */
export function encodeStored(field: UiField, value: UiValue): string {
  if (field.key === "sound") return value ? "on" : "off";
  if (field.kind === "bool") return value ? "1" : "0";
  return String(value);
}

/** Every setting as this tab shows it now. */
export function readUiValues(read: (storageKey: string) => string | null): UiValues {
  const out: UiValues = {};
  for (const field of UI_FIELDS) out[field.key] = decodeStored(field, read(field.storage));
  return out;
}

/** The allowlisted, valid part of `raw`. */
export function cleanUiValues(raw: unknown): UiValues {
  const out: UiValues = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (validUiValue(k, v)) out[k] = v as UiValue;
  }
  return out;
}

/** What a setting is called in Settings › Account's lists. */
export const UI_LABELS: Record<string, string> = {
  theme: "Theme",
  textSize: "Text size",
  density: "Density",
  "panels.sessionList": "Session list open",
  "panels.accounts": "Accounts panel open",
  "panels.detail": "Detail panel open",
  "panels.usage": "Usage panel open",
  "panels.machine": "Machine panel open",
  singleKeyShortcuts: "Single-key shortcuts",
  hideFinishedAfter: "Hide finished sessions after",
  character: "Character",
  sound: "Sound",
};
