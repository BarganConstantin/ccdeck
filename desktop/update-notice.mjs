// Whether the desktop app should put its staged update in front of the person
// who is already looking at ccdeck (#1182).
//
// This deliberately knows nothing about Electron. main.mjs supplies the
// window and tray-model state so the rule is small enough to pin directly:
// one notice per version, only in an existing focused window, and only once
// the deck is idle.
export function shouldOfferReadyUpdate({
  status,
  version,
  shownVersion,
  windowOpen,
  windowVisible,
  windowFocused,
  running,
  waiting,
  prompting,
}) {
  return status === "ready"
    && typeof version === "string"
    && version.length > 0
    && shownVersion !== version
    && windowOpen
    && windowVisible
    && windowFocused
    && running === 0
    && waiting === 0
    && !prompting;
}
