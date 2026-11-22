// Which CLI an event came from, read one way on both sides of the wire.
//
// hook.js stamps `provider` from its `--provider` argument: "claude" for Claude
// Code's hooks, "codex" for Codex's, and since opencode and the GitHub Copilot
// CLI forward their events through the same script, "opencode" and "copilot".
// A payload with no provider is Claude's: events written before multi-provider
// support carry none, and that is how the reducer has always read them. An
// unknown name is read the same way, so a newer hook talking to an older rule
// changes nothing that worked before.
//
// opencode and Copilot are EVENTS ONLY. The deck hears what their plugin or
// hooks forward and nothing else: it reads no transcript of theirs, holds none
// of their accounts or quota, and runs neither in its terminal. Every path that
// reads a Claude transcript, a Claude account or a Claude terminal asks
// `payloadProvider` first, so their sessions are never taken for Claude's.

/** Every provider the deck draws sessions for. */
export const PROVIDERS = Object.freeze(["claude", "codex", "opencode", "copilot"]);

/** The providers the deck hears only through forwarded events. */
export const EVENT_ONLY_PROVIDERS = Object.freeze(["opencode", "copilot"]);

const KNOWN = new Set(PROVIDERS);
const EVENT_ONLY = new Set(EVENT_ONLY_PROVIDERS);

/** A provider name as the deck keeps it: one of PROVIDERS, else "claude". */
export function providerOf(name) {
  return typeof name === "string" && KNOWN.has(name) ? name : "claude";
}

/** The provider a payload names, read as providerOf reads a name. */
export function payloadProvider(raw) {
  return providerOf(raw && typeof raw === "object" ? raw.provider : undefined);
}

/** Whether the deck hears this provider only through forwarded events: no
 *  transcript, no accounts, no terminal of its own. */
export function isEventOnly(name) {
  return typeof name === "string" && EVENT_ONLY.has(name);
}
