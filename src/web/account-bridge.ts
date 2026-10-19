// The tab's half of the account's settings sync: what this tab applies from
// the account, and what it tells the deck a person changed (design 4.6).
//
// THE SETTINGS STAY WHERE THEY ARE. Each lives in localStorage under the key
// it always had, set by its own control through its own setter. The bridge
// only watches those writes (storage.ts announces them as `ccdeck:stored`) and
// calls those setters — it never writes a stored value itself, so applying a
// theme is exactly the same act as pressing T.
//
// ONE RULE DECIDES WHAT A WRITE IS. A write whose value differs from the value
// the account last knew for that setting is a person's change; one that
// matches is the deck's own echo — an apply's setter writing back, a mount
// effect re-asserting what was stored. Before applying anything the bridge
// records it as known, so the writes the apply causes match and are ignored.
// Changes are gathered for two seconds and sent together.
//
// A TAB REPORTS ONLY AFTER ITS FIRST SYNC. On the first view of a connected
// account it either uploads (the deck's first connect: `initialUpload`) or
// adopts what the account says — the outstanding `apply`, else the resolved
// values — so a second browser profile opening the same deck takes the
// account's settings instead of overwriting them with its own.
//
// Pure, and DOM-free: the hook (use-account.ts) hands it the fetch, the store,
// the setters and the clock, and the suite does the same.
import { cleanUiValues, decodeStored, fieldForStorageKey, readUiValues, type UiValue, type UiValues } from "./account-ui-fields";

export const REPORT_DEBOUNCE_MS = 2_000;

export interface SyncView {
  mode: "independent" | "shared";
  overrides: string[];
  profileId: string | null;
  savedRevision: number;
  appliedRevision: number | null;
  adopt: { revision: number; values: UiValues };
  pending: { since: string; keys: string[] } | null;
  conflict: { latest: { revision: number; values: UiValues; updatedBy: { kind: string; name: string } | null }; mine: UiValues } | null;
  apply: { revision: number; values: UiValues } | null;
  askUploadForNewAccount: boolean;
  initialUpload: boolean;
  saving: "idle" | "saving" | "offline" | "refused";
  skipped: { theme?: string } | null;
}

export type AccountState = "disconnected" | "connecting" | "connected" | "revoked" | "error";

export interface AccountView {
  enabled: boolean;
  vetoed: boolean;
  state: AccountState;
  connect: { userCode: string; verificationUri: string; verificationUriComplete: string; expiresAt: string } | null;
  account: { email: string } | null;
  device: { id: string; name: string; consoleUrl: string | null } | null;
  suggestedName: string;
  tokenStorage: "keychain" | "dpapi" | "secret-service" | "file" | null;
  status: { lastSentAt: string | null; lastResult: "ok" | "offline" | "rejected" | null; nextAt: string | null; everySec: number } | null;
  sync: SyncView | null;
  revokedReason: string | null;
  problem: string | null;
}

/** The setter that puts one setting on screen, by schema key. */
export type Appliers = Partial<Record<string, (value: UiValue) => void>>;

export interface BridgeDeps {
  post: (path: string, body: unknown) => Promise<unknown>;
  read: (storageKey: string) => string | null;
  appliers: () => Appliers;
  /** The theme ids this version of the deck has. */
  themes: () => readonly string[];
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  debounceMs?: number;
}

export function createAccountBridge({
  post, read, appliers, themes,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = t => clearTimeout(t as ReturnType<typeof setTimeout>),
  debounceMs = REPORT_DEBOUNCE_MS,
}: BridgeDeps) {
  let synced = false;
  let known: UiValues = {};
  let lastApplied: number | null = null;
  let batch: UiValues = {};
  let timer: unknown = null;

  function cancelBatch() {
    if (timer != null) clearTimer(timer);
    timer = null;
    batch = {};
  }

  /** Put `target` on screen through the setters, and say so. A theme this
   *  version has no palette for is left alone and named, and the revision
   *  still counts as processed. */
  function apply(target: { revision: number; values: UiValues }) {
    const set = appliers();
    let skipped: { theme: string } | undefined;
    const shown = readUiValues(read);
    for (const [key, value] of Object.entries(cleanUiValues(target.values))) {
      if (key === "theme" && !themes().includes(value as string)) {
        skipped = { theme: value as string };
        continue;
      }
      known[key] = value;
      if (shown[key] !== value) set[key]?.(value);
    }
    lastApplied = target.revision;
    void post("/api/account/ui/applied", { revision: target.revision, ...(skipped ? { skipped } : {}) }).catch(() => {});
  }

  /** A new answer from /api/account or `event: account`. */
  function onView(view: AccountView | null) {
    const sync = view?.state === "connected" ? view.sync : null;
    if (!sync) {
      synced = false;
      lastApplied = null;
      cancelBatch();
      return;
    }
    if (!synced) {
      synced = true;
      known = readUiValues(read);
      if (sync.initialUpload) {
        void post("/api/account/ui", { values: { ...known }, reason: "initial" }).catch(() => {});
        return;
      }
      apply(sync.apply ?? sync.adopt);
      return;
    }
    if (sync.apply && sync.apply.revision !== lastApplied) apply(sync.apply);
  }

  function flush() {
    timer = null;
    const values = batch;
    batch = {};
    if (Object.keys(values).length) void post("/api/account/ui", { values, reason: "user" }).catch(() => {});
  }

  /** A write writeStored announced. */
  function onStored(storageKey: string, raw: string | null) {
    if (!synced) return;
    const field = fieldForStorageKey(storageKey);
    if (!field) return;
    const value = decodeStored(field, raw);
    if (known[field.key] === value) return;
    known[field.key] = value;
    batch[field.key] = value;
    if (timer != null) clearTimer(timer);
    timer = setTimer(flush, debounceMs);
  }

  return {
    onView,
    onStored,
    /** For the suite: send what is gathered now. */
    flush: () => { if (timer != null) clearTimer(timer); flush(); },
    dispose: cancelBatch,
  };
}
