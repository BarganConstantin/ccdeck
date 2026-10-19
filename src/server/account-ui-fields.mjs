// The settings a ccdeck account may carry between this person's decks: schema
// 1's keys, what each may hold, and nothing else.
//
// AN ALLOWLIST, ENFORCED ON BOTH ENDS. The API refuses any other key by name
// (ValidationProblem, `errors["values.<key>"]`); this is the deck refusing to
// send one in the first place, so a page that posts something new to
// /api/account/ui cannot make the deck upload it. What the deck shows comes
// from the browser's localStorage; which localStorage key holds each of these
// is the page's business and lives in the web copy (src/web/account-ui-fields.ts).
// The two copies are held identical by account-ui-fields-mirror.test.ts — the
// pattern block-notify.mjs uses for a rule both runtimes need.
//
// EXPLICITLY NEVER SYNCED, so nobody adds them here by accident: anything in
// prefs.json (notifications, autoUpdate, reports, the accounts the deck signed
// in, the LAN section and its key), the tour marker, the layout and viewport,
// Claude FM and the radio, custom sounds, feedback drafts, removed nodes,
// panel internals and Browser Watch's state.

/** The schema these keys are. A write declares it; the API preserves keys of
 *  any newer schema this deck does not know. */
export const UI_SCHEMA = 1;

/** The choices each closed field takes, in the order the deck offers them. */
export const TEXT_SIZES = Object.freeze(["smallest", "smaller", "default", "larger", "largest"]);
export const DENSITIES = Object.freeze(["tightest", "tighter", "compact", "default", "comfortable"]);
export const HIDE_FINISHED_CHOICES = Object.freeze([0, 5, 15, 30, 60]);

/** A theme id the API takes. Whether this deck has that theme is the page's
 *  question (its catalog), never the server's. */
export const THEME_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * Every key, with its kind. `override: true` marks the one key a device keeps
 * for itself in shared mode unless told otherwise — sound, because a laptop
 * and a server want different answers.
 */
export const UI_FIELDS = Object.freeze([
  Object.freeze({ key: "theme", kind: "theme" }),
  Object.freeze({ key: "textSize", kind: "choice", choices: TEXT_SIZES }),
  Object.freeze({ key: "density", kind: "choice", choices: DENSITIES }),
  Object.freeze({ key: "panels.sessionList", kind: "bool" }),
  Object.freeze({ key: "panels.accounts", kind: "bool" }),
  Object.freeze({ key: "panels.detail", kind: "bool" }),
  Object.freeze({ key: "panels.usage", kind: "bool" }),
  Object.freeze({ key: "panels.machine", kind: "bool" }),
  Object.freeze({ key: "singleKeyShortcuts", kind: "bool" }),
  Object.freeze({ key: "hideFinishedAfter", kind: "minutes", choices: HIDE_FINISHED_CHOICES }),
  Object.freeze({ key: "character", kind: "bool" }),
  Object.freeze({ key: "sound", kind: "bool", override: true }),
]);

export const UI_KEYS = Object.freeze(UI_FIELDS.map(f => f.key));

/** The keys a device keeps for itself in shared mode by default. */
export const DEFAULT_OVERRIDES = Object.freeze(UI_FIELDS.filter(f => f.override).map(f => f.key));

const BY_KEY = new Map(UI_FIELDS.map(f => [f.key, f]));

/** Whether `value` is one `key` may hold. Unknown keys hold nothing. */
export function validUiValue(key, value) {
  const field = BY_KEY.get(key);
  if (!field) return false;
  switch (field.kind) {
    case "theme": return typeof value === "string" && THEME_ID.test(value);
    case "choice": return typeof value === "string" && field.choices.includes(value);
    case "minutes": return typeof value === "number" && field.choices.includes(value);
    case "bool": return typeof value === "boolean";
    default: return false;
  }
}

/**
 * The allowlisted part of `raw`: every known key with a value it may hold, and
 * the names of what was refused — unknown keys and bad values alike — so a
 * caller can say what it dropped. Never throws; anything that is not a plain
 * object is no values at all.
 */
export function cleanUiValues(raw) {
  const values = {};
  const refused = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { values, refused };
  for (const key of Object.keys(raw)) {
    if (validUiValue(key, raw[key])) values[key] = raw[key];
    else refused.push(key);
  }
  return { values, refused };
}

/** Two value sets that hold the same keys with the same values. */
export function sameUiValues(a, b) {
  const ak = Object.keys(a ?? {});
  const bk = Object.keys(b ?? {});
  return ak.length === bk.length && ak.every(k => Object.hasOwn(b, k) && b[k] === a[k]);
}

/** `values` split by where shared mode stores each key: the shared profile,
 *  or the device's own one for the override keys. */
export function splitByOverrides(values, overrides) {
  const own = {};
  const shared = {};
  const keep = new Set(overrides ?? []);
  for (const [k, v] of Object.entries(values ?? {})) (keep.has(k) ? own : shared)[k] = v;
  return { own, shared };
}

/**
 * What a device shows for a settings binding (design 3.5, "Resolution on a
 * device"): independent mode is its own profile; shared mode is the shared
 * profile with the override keys taken from its own profile instead. A key
 * with no value is absent, and the page leaves it alone.
 */
export function resolveUiValues({ mode, bound, own, overrides }) {
  const boundValues = cleanUiValues(bound?.values).values;
  if (mode !== "shared") return boundValues;
  const ownValues = cleanUiValues(own?.values).values;
  const out = { ...boundValues };
  // The API's rule (UiSettingsSchema.Resolve in ccdeck-api): an override key is
  // the device's own whatever the shared profile says — taken from the device
  // profile when it has one, and absent (left alone on the device) when not.
  // Never the shared value: that would hand a laptop's sound to a server.
  for (const key of overrides ?? []) {
    delete out[key];
    if (Object.hasOwn(ownValues, key)) out[key] = ownValues[key];
  }
  return out;
}
