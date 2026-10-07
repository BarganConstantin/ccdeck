// Which keyboard the person in front of the deck is holding.
//
// Two places print a chord, and a chord is only worth printing in the spelling
// the keys in front of the reader carry: the feedback dialog's send hint and
// the Settings button's tooltip. Both chords work on every platform; this only
// decides which one to show. Lifted out of FeedbackDialog.tsx so the topbar and
// the shortcuts sheet ask the same question the same way.

/** The platform the browser reports, the newer hint first. Empty where there
 *  is no navigator at all — a test, or the server rendering markup. */
export function platformName(): string {
  if (typeof navigator === "undefined") return "";
  const hinted = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform;
  return hinted || navigator.platform || "";
}

/** A Mac, an iPhone or an iPad: the keyboards with a ⌘ on them. */
export function isApplePlatform(platform: string): boolean {
  return /mac|iphone|ipad/i.test(platform);
}
