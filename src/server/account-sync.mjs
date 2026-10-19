// Settings sync between this deck and its account: the deck server's half
// (design 4.6).
//
// WHERE EACH HALF LIVES. The settings themselves stay in the browser's
// localStorage, as they always have — the theme, text size, density, the
// panels, sound and the rest of account-ui-fields.mjs. The tab tells this
// module what the person changed (POST /api/account/ui), and applies what the
// account says (the `apply` values, then POST /api/account/ui/applied). This
// module holds the account's side: which profile this device is bound to, the
// last revision it knows of, edits not yet saved, a conflict, values a tab has
// not applied yet — and keeps all of it in account.json, so a restart loses
// neither a pending edit nor a conflict.
//
// SAVED IS NOT APPLIED. Saved is the API's revision of the bound profile;
// applied is the revision a tab on this machine has really put on screen, which
// the next status frame reports. With no tab open the two differ, and the
// console says so ("Saved r15 · Applied r14") rather than pretending.
//
// NO AUTOMATIC MERGING. A save against a stale revision is a 409 with the
// latest; the edit stays pending and the conflict is raised, and the person
// picks: Use latest (drop the draft) or Save mine over rN. A pull that finds a
// newer revision while an edit is pending raises the same conflict instead of
// applying over the edit.
//
// A DIFFERENT ACCOUNT NEVER GETS THIS DECK'S SETTINGS BY ITSELF. On a first
// connect, or a reconnect to the account this deck was last connected to, the
// tab's values are uploaded as the device profile. Connected to another
// account, nothing is uploaded until somebody asks ("Save this deck's settings
// to …") or makes an edit.
import {
  DEFAULT_OVERRIDES, UI_SCHEMA, cleanUiValues, resolveUiValues, splitByOverrides,
} from "./account-ui-fields.mjs";

const revisionOf = v => (Number.isInteger(v) && v >= 0 ? v : 0);

/** A profile from the API, kept as the parts this deck uses. */
function keptProfile(p) {
  if (!p || typeof p !== "object") return null;
  return {
    id: typeof p.id === "string" ? p.id : null,
    kind: p.kind === "shared" ? "shared" : "device",
    revision: revisionOf(p.revision),
    values: cleanUiValues(p.values).values,
    updatedBy: p.updatedBy && typeof p.updatedBy === "object"
      ? { kind: String(p.updatedBy.kind ?? ""), name: typeof p.updatedBy.name === "string" ? p.updatedBy.name.slice(0, 64) : "" }
      : null,
  };
}

/** A fresh sync state for a device the API just enrolled. */
export function initialSync({ accountId, previousAccountId, settings }) {
  const same = !previousAccountId || previousAccountId === accountId;
  return {
    accountId,
    mode: settings?.mode === "shared" ? "shared" : "independent",
    overrides: [...DEFAULT_OVERRIDES],
    profileId: settings?.profileId ?? null,
    base: { id: settings?.profileId ?? null, kind: settings?.mode === "shared" ? "shared" : "device", revision: revisionOf(settings?.revision), values: {}, updatedBy: null },
    own: null,
    pending: null,
    conflict: null,
    apply: null,
    appliedRevision: null,
    local: {},
    skipped: null,
    initialUpload: same,
    askUpload: !same,
    saving: "idle",
  };
}

/** Whatever account.json held, coerced. */
export function normaliseSync(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.accountId !== "string") return null;
  const values = v => cleanUiValues(v).values;
  const pending = raw.pending && typeof raw.pending === "object" && Object.keys(values(raw.pending.values)).length
    ? { values: values(raw.pending.values), since: typeof raw.pending.since === "string" ? raw.pending.since : new Date(0).toISOString() }
    : null;
  return {
    accountId: raw.accountId,
    mode: raw.mode === "shared" ? "shared" : "independent",
    overrides: Array.isArray(raw.overrides) ? raw.overrides.filter(k => typeof k === "string") : [...DEFAULT_OVERRIDES],
    profileId: typeof raw.profileId === "string" ? raw.profileId : null,
    base: keptProfile(raw.base) ?? { id: null, kind: "device", revision: 0, values: {}, updatedBy: null },
    own: keptProfile(raw.own),
    pending,
    conflict: raw.conflict?.latest ? { latest: keptProfile(raw.conflict.latest), target: raw.conflict.target === "own" ? "own" : "bound" } : null,
    apply: raw.apply && Number.isInteger(raw.apply.revision) ? { revision: raw.apply.revision, values: values(raw.apply.values) } : null,
    appliedRevision: Number.isInteger(raw.appliedRevision) ? raw.appliedRevision : null,
    local: values(raw.local),
    skipped: raw.skipped && typeof raw.skipped === "object" ? { theme: typeof raw.skipped.theme === "string" ? raw.skipped.theme : undefined } : null,
    initialUpload: raw.initialUpload === true,
    askUpload: raw.askUpload === true,
    saving: "idle",
  };
}

/**
 * The sync. `state` is the persisted object (initialSync or normaliseSync's);
 * every change is handed to `persist(state)` and announced through `onChange`.
 * `onUnauthorized(error)` is a final 401 from any call — the service's to
 * handle, as the publisher's is.
 */
export function createSync({ client, token, state: initial, persist = async () => {}, onChange = () => {}, onUnauthorized = () => {}, now = Date.now }) {
  let s = initial;
  let queue = Promise.resolve();

  /** One operation at a time, in order: a save and a pull must never race
   *  over the same base revision. */
  const serial = job => {
    const run = queue.then(job, job);
    queue = run.then(() => {}, () => {});
    return run;
  };

  async function changed() {
    try { await persist(s); } catch { /* the in-memory state stands; the next change tries again */ }
    onChange();
  }

  /** What the account says this device shows: the bound profile, with the
   *  device's own values over it for the override keys in shared mode. */
  const resolvedBase = () => resolveUiValues({ mode: s.mode, bound: s.base, own: s.own, overrides: s.overrides });

  /** What this device shows now: the account's values, what a tab reported,
   *  and the edits not yet saved — in that order of precedence, lowest first. */
  const shownValues = () => ({ ...resolvedBase(), ...s.local, ...(s.pending?.values ?? {}) });

  /** A 401 that ends the device. Anything else is the caller's to handle. */
  function unauthorized(res) {
    if (res.status === 401 && ["device_revoked", "invalid_token", "account_gone"].includes(res.error)) {
      onUnauthorized(res.error);
      return true;
    }
    return false;
  }

  /** The settings document, taken in: the binding, both profiles. */
  function takeDocument(doc) {
    if (!doc || typeof doc !== "object") return false;
    const profile = keptProfile(doc.profile);
    if (!profile) return false;
    s.mode = doc.mode === "shared" ? "shared" : "independent";
    s.overrides = Array.isArray(doc.overrides) ? doc.overrides.filter(k => typeof k === "string") : s.overrides;
    s.profileId = profile.id;
    s.base = profile;
    s.own = keptProfile(doc.own) ?? (s.mode === "independent" ? profile : s.own);
    return true;
  }

  /**
   * Values for one profile's PUT: every key of it this deck writes there, with
   * the edits over them. In shared mode that is only the override keys for the
   * device's own profile, and everything but them for the shared one (design
   * 3.5): the API refuses either the other way round with a 400 naming the key,
   * and both profiles can hold keys this deck must not send back — the own
   * profile still has what it showed while it was independent, and the console
   * may give the shared profile a sound for the machines that do not keep
   * their own. A key left out here is not unset: the API keeps those as stored.
   */
  async function put(profile, edits, target) {
    const stored = s.mode === "shared" ? splitByOverrides(profile.values, s.overrides)[target === "own" ? "own" : "shared"] : profile.values;
    return client.put("/v1/device/settings", {
      profileId: profile.id,
      baseRevision: profile.revision,
      schema: UI_SCHEMA,
      values: { ...stored, ...edits },
    }, { token: token() });
  }

  /** Save what is pending, now. Resolves to what became of it. */
  function save() {
    return serial(async () => {
      if (!s.pending || s.conflict || !token()) return "idle";
      const edits = s.pending.values;
      const { own: ownEdits, shared: boundEdits } = s.mode === "shared"
        ? splitByOverrides(edits, s.overrides)
        : { own: {}, shared: edits };
      s.saving = "saving";
      onChange();
      for (const [target, part] of [["bound", boundEdits], ["own", ownEdits]]) {
        if (!Object.keys(part).length) continue;
        const profile = target === "bound" ? s.base : s.own;
        if (!profile?.id) continue;
        const res = await put(profile, part, target);
        if (unauthorized(res)) { s.saving = "idle"; return "revoked"; }
        if (res.ok && res.body?.profile) {
          const saved = keptProfile(res.body.profile);
          if (target === "bound") {
            s.base = saved;
            if (s.mode === "independent") s.own = saved;
            // This device already shows what it just saved.
            s.appliedRevision = saved.revision;
            if (s.apply && s.apply.revision <= saved.revision) s.apply = null;
          } else {
            s.own = saved;
          }
          // Only the edits that were sent and have not changed since.
          for (const [k, v] of Object.entries(part)) if (s.pending?.values[k] === v) delete s.pending.values[k];
          s.local = { ...s.local, ...part };
          continue;
        }
        if (res.status === 409 && res.error === "revision_conflict" && res.body?.latest) {
          s.conflict = { latest: keptProfile(res.body.latest), target };
          s.saving = "idle";
          await changed();
          return "conflict";
        }
        if (res.status === 409 && res.error === "profile_not_bound") {
          // The binding moved under this deck. Read it again; the edit stays
          // pending and goes to the right profile on the next try.
          s.saving = "idle";
          await pullDocument();
          await changed();
          return "rebound";
        }
        if (res.status === 400 || res.status === 413) {
          // The API refused these values as values. Sending them again would
          // be refused again, so they are dropped rather than retried forever.
          for (const k of Object.keys(part)) delete s.pending?.values[k];
          s.saving = "refused";
          if (s.pending && !Object.keys(s.pending.values).length) s.pending = null;
          await changed();
          return "refused";
        }
        s.saving = "offline";
        await changed();
        return "offline";
      }
      if (s.pending && !Object.keys(s.pending.values).length) s.pending = null;
      s.saving = "idle";
      await changed();
      return "saved";
    });
  }

  /** GET the settings document, and take it in — or raise a conflict when an
   *  edit is pending and the account moved past it. No queueing: callers are
   *  already inside `serial`. */
  async function pullDocument() {
    const res = await client.get("/v1/device/settings", { token: token() });
    if (unauthorized(res)) return "revoked";
    if (!res.ok) return "offline";
    const latest = keptProfile(res.body?.profile);
    if (!latest) return "offline";
    // Only an edit bound for THIS profile conflicts with it: in shared mode a
    // pending sound change is the device's own profile's business.
    const boundEdits = s.mode === "shared" ? splitByOverrides(s.pending?.values, s.overrides).shared : (s.pending?.values ?? {});
    if (Object.keys(boundEdits).length && latest.id === s.base.id && latest.revision > s.base.revision) {
      s.conflict = { latest, target: "bound" };
      return "conflict";
    }
    takeDocument(res.body);
    const revision = s.base.revision;
    if (revision > (s.appliedRevision ?? -1)) {
      const values = resolvedBase();
      // Nothing to apply is still a revision this device has processed.
      if (Object.keys(values).length) s.apply = { revision, values };
      else s.appliedRevision = revision;
    }
    return "pulled";
  }

  const pull = () => serial(async () => {
    const out = await pullDocument();
    await changed();
    return out;
  });

  /**
   * A tab's report. `initial` is a tab that has just loaded: on a first
   * connect its values are the device profile; otherwise it is about to adopt
   * the account's values, and what it held before is not news. `user` is a
   * person changing something.
   */
  async function reportUi(raw, reason) {
    const { values } = cleanUiValues(raw);
    if (reason === "initial") {
      if (!s.initialUpload) return view();
      s.initialUpload = false;
      s.local = { ...s.local, ...values };
      if (Object.keys(values).length) s.pending = { values: { ...values }, since: new Date(now()).toISOString() };
      await changed();
      await save();
      return view();
    }
    const base = resolvedBase();
    const pending = { ...(s.pending?.values ?? {}) };
    let edits = 0;
    for (const [k, v] of Object.entries(values)) {
      if (base[k] === v) delete pending[k];
      else { pending[k] = v; edits++; }
    }
    s.local = { ...s.local, ...values };
    // An edit is the person engaging with this account: it is saved, and the
    // question about uploading everything stops being asked.
    if (edits) s.askUpload = false;
    s.pending = Object.keys(pending).length ? { values: pending, since: s.pending?.since ?? new Date(now()).toISOString() } : null;
    await changed();
    if (s.pending) await save();
    return view();
  }

  /** A tab put revision `revision` on screen. `skipped` names what it could
   *  not apply — a theme this version does not have — which still counts as
   *  processed. */
  async function applied(revision, skipped) {
    if (!Number.isInteger(revision) || revision < 0 || revision > s.base.revision) return view();
    if (s.apply && s.apply.revision <= revision) {
      s.local = { ...s.local, ...s.apply.values };
      s.apply = null;
    }
    s.appliedRevision = Math.max(s.appliedRevision ?? -1, revision);
    s.skipped = skipped && typeof skipped.theme === "string" ? { theme: skipped.theme.slice(0, 40) } : null;
    await changed();
    return view();
  }

  /** The conflict, answered. */
  function resolve(action) {
    return serial(async () => {
      if (!s.conflict) return view();
      const latest = s.conflict.latest;
      if (action === "use-latest") {
        s.pending = null;
        if (s.conflict.target === "own") s.own = latest;
        else { s.base = latest; if (s.mode === "independent") s.own = latest; }
        s.conflict = null;
        const values = resolvedBase();
        if (Object.keys(values).length) s.apply = { revision: s.base.revision, values };
        else s.appliedRevision = s.base.revision;
        await changed();
        return view();
      }
      if (action === "reapply") {
        // Save mine over rN: the latest revision becomes the base, the draft
        // goes on top of it.
        if (s.conflict.target === "own") s.own = latest;
        else { s.base = latest; if (s.mode === "independent") s.own = latest; }
        s.conflict = null;
        await changed();
        return null;
      }
      return view();
    }).then(async out => {
      if (out !== null) return out;
      await save();
      return view();
    });
  }

  /** The join preview: this device's values against the shared profile's. */
  async function preview() {
    const res = await client.get("/v1/device/settings?include=shared", { token: token() });
    if (unauthorized(res)) return { error: "revoked" };
    if (!res.ok) return { error: res.network ? "offline" : `status_${res.status}` };
    const shared = keptProfile(res.body?.shared);
    const local = shownValues();
    const differences = [];
    if (shared) {
      for (const key of new Set([...Object.keys(local), ...Object.keys(shared.values)])) {
        const a = Object.hasOwn(local, key) ? local[key] : null;
        const b = Object.hasOwn(shared.values, key) ? shared.values[key] : null;
        if (a !== b) differences.push({ key, local: a, shared: b });
      }
    }
    return {
      local,
      shared: shared ? { revision: shared.revision, values: shared.values, updatedBy: shared.updatedBy } : null,
      differences,
    };
  }

  /** Join or leave shared settings — only ever from this deck. */
  function setMode(body) {
    return serial(async () => {
      let request;
      const shown = shownValues();
      // `schema` is optional on this body and 1 by default (SettingsModeRequest
      // in ccdeck-api); said anyway, so the values are read as this deck means them.
      if (body?.mode === "shared" && body.join === "use-shared") {
        request = { mode: "shared", join: "use-shared", schema: UI_SCHEMA };
      } else if (body?.mode === "shared" && body.join === "publish") {
        const rev = Number.isInteger(body.previewRevision) && body.previewRevision >= 0 ? body.previewRevision : 0;
        request = { mode: "shared", join: "publish", sharedBaseRevision: rev, schema: UI_SCHEMA, values: shown };
      } else if (body?.mode === "independent") {
        request = { mode: "independent", schema: UI_SCHEMA, values: shown };
      } else {
        return { error: "bad_mode" };
      }
      const res = await client.post("/v1/device/settings/mode", request, { token: token() });
      if (unauthorized(res)) return { error: "revoked" };
      if (res.status === 409) return { error: res.error ?? "conflict", latest: keptProfile(res.body?.latest) };
      if (!res.ok || !takeDocument(res.body)) return { error: res.network ? "offline" : `status_${res.status}` };
      s.pending = null;
      s.conflict = null;
      if (request.join === "use-shared") {
        const values = resolvedBase();
        if (Object.keys(values).length) s.apply = { revision: s.base.revision, values };
        else s.appliedRevision = s.base.revision;
      } else {
        // Publishing and leaving both wrote what this device shows.
        s.appliedRevision = s.base.revision;
        s.apply = null;
      }
      s.askUpload = false;
      s.initialUpload = false;
      await changed();
      return { ok: true };
    });
  }

  /** "Save this deck's settings to <email>": the deck's values, uploaded to a
   *  different account because somebody asked. */
  async function upload(values) {
    const clean = cleanUiValues(values).values;
    s.local = { ...s.local, ...clean };
    const all = { ...shownValues() };
    s.askUpload = false;
    if (Object.keys(all).length) s.pending = { values: all, since: new Date(now()).toISOString() };
    await changed();
    await save();
    return view();
  }

  /** What /api/account says about the sync. */
  function view() {
    return {
      mode: s.mode,
      overrides: [...s.overrides],
      profileId: s.profileId,
      savedRevision: s.base.revision,
      appliedRevision: s.appliedRevision,
      // What a tab that has just loaded takes on when nothing is waiting to be
      // applied: the account's values with this deck's unsaved edits over
      // them, so a reload while offline does not undo an edit still pending.
      adopt: { revision: s.base.revision, values: { ...resolvedBase(), ...(s.pending?.values ?? {}) } },
      pending: s.pending ? { since: s.pending.since, keys: Object.keys(s.pending.values) } : null,
      conflict: s.conflict ? {
        latest: { revision: s.conflict.latest.revision, values: s.conflict.latest.values, updatedBy: s.conflict.latest.updatedBy },
        mine: s.pending?.values ?? {},
      } : null,
      apply: s.apply ? { revision: s.apply.revision, values: { ...s.apply.values } } : null,
      askUploadForNewAccount: s.askUpload,
      initialUpload: s.initialUpload,
      saving: s.saving,
      skipped: s.skipped,
    };
  }

  return {
    pull,
    save,
    reportUi,
    applied,
    resolve,
    preview,
    setMode,
    upload,
    view,
    /** What the status frame reports. */
    binding: () => (s.profileId ? { profileId: s.profileId, appliedRevision: s.appliedRevision } : null),
    /** A frame's answer: a newer revision is pulled, and whatever is pending is
     *  tried again — every successful frame is a sign the API is reachable. */
    async onControl(settings) {
      const newer = settings && typeof settings.revision === "number"
        && (settings.profileId !== s.profileId || settings.revision > s.base.revision);
      if (newer) await pull();
      if (s.pending && !s.conflict) await save();
    },
    state: () => s,
  };
}
