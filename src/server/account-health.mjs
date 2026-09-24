/** A collector's verdict is about the stored copy, not the live CLI session.
 * In particular, an inaccessible Keychain does not make the stored copy dead:
 * treating it as dead starts a futile peer-healing loop on every LAN round. */
const LOST_COPY = new Set(["no_credentials", "relogin_required", "foreign_credential"]);

export function storedCopyAlive(alive, verdict) {
  // An unreadable keychain or a deferred token refresh is a failure to CHECK,
  // not evidence that the stored login has died. Do not repeatedly overwrite
  // that slot with copies from a peer while the check is unavailable.
  if (verdict === "keychain_unavailable" || verdict === "token_expired") return true;
  return alive === true && !LOST_COPY.has(verdict);
}

/** When a collector verdict is present, only `ok` is positive export evidence.
 * Unknown and transient verdict strings are therefore fail-closed. */
export function exportVerdictOk(verdict) {
  return verdict === "ok";
}

/** Cached preflight for the LAN hot path. Older decks and stale caches may have
 * no verdict, so absence is allowed to reach the bounded export itself. A
 * KNOWN bad or unknown verdict is refused before spawning it. The exported
 * blob is identity-checked, and a failed macOS export refreshes verdicts in the
 * background for the next round. */
export function cachedExportReadable(verdict) {
  return verdict == null || exportVerdictOk(verdict);
}
