// The desktop window can ask for a staged app update to be applied, but the
// page is not part of the updater trust boundary. The updater remains the only
// authority: only its exact, currently ready version may restart into itself.
export function restartReadyUpdate(updater, requestedVersion) {
  const version = typeof requestedVersion === "string" ? requestedVersion.trim() : "";
  if (!version || updater?.state?.status !== "ready" || updater.state.version !== version) return false;
  updater.restartNow();
  return true;
}
