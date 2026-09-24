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

/** Cached preflight for the LAN hot path. A KNOWN bad or unknown verdict is
 * refused before spawning an export. An inactive slot with no verdict may reach
 * the bounded export itself: it exports the stored copy, which carries the
 * slot's own identity. The ACTIVE slot may not, because its export is the live
 * CLI login, which can belong to another account or be expired while the
 * blob's labels still name the slot, so the identity check cannot catch it.
 * Its verdict is refreshed in the background and the next round shares it. */
export function cachedExportReadable(verdict, { active = false } = {}) {
  if (verdict == null) return !active;
  return exportVerdictOk(verdict);
}

/** Is the live CLI login the account this slot names? The active slot exports
 * the live login, and a verdict can predate a `/login` as somebody else. */
export function liveLoginIs(identity, email, org) {
  const live = String(identity?.email ?? "").trim().toLowerCase();
  if (!live || live !== String(email ?? "").trim().toLowerCase()) return false;
  return !identity.orgId || !org || identity.orgId === org;
}
