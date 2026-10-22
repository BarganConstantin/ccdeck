// What a failed read says, and the one way out it offers, for every
// integration panel (#2178, #2179). Jira and the forges each had a table of
// these and they disagreed: a refused token offered Reconnect in one and
// "Open connection settings" in the other, a missing issue offered Try again
// in one and nothing in the other, and a rate limit showed its wait as prose
// beside a Try again that could be pressed at once. One table now, by kind:
//
//   auth, expired            → Reconnect (a new token is the fix)
//   permission, incompatible → Open connection settings (scopes or address)
//   not-found                → nothing to press; the sentence says why
//   everything else          → Try again, held until a rate limit lifts
//
// The words name the provider ("Jira", "GitHub", "GitLab") and, where the
// place matters, the host; a panel can still pass its own sentence.
import type { IntegrationErrorKind } from "./types";

export type FailureAction = "reconnect" | "settings" | "retry" | "none";

/** The part of a failure the words are made from: the deck's error envelope. */
export interface FailureInfo {
  kind: IntegrationErrorKind;
  /** Diagnostic words from the deck, never a token or a header. */
  message?: string;
  /** What the provider itself said, when the deck passed it on. */
  detail?: string;
  /** Seconds until a rate limit lifts, when the provider said. */
  retryAfter?: number;
}

export function failureAction(kind: IntegrationErrorKind): FailureAction {
  switch (kind) {
    case "auth":
    case "expired":
      return "reconnect";
    case "permission":
    case "incompatible":
      return "settings";
    case "not-found":
      return "none";
    default:
      return "retry";
  }
}

/** The button's words for an action. */
export function actionLabel(action: Exclude<FailureAction, "none">): string {
  return action === "reconnect" ? "Reconnect" : action === "settings" ? "Open connection settings" : "Try again";
}

/** "in 42s" under a minute, "after 14:05" past it (the reader's own clock). */
export function retryWhen(seconds: number, now = Date.now()): string {
  if (seconds < 60) return `in ${Math.max(1, Math.ceil(seconds))}s`;
  return `after ${new Date(now + seconds * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

/** The heading and the sentence under it, by kind, in the provider's name. */
export function failureWords(error: FailureInfo, provider: string, host = provider, now = Date.now()): { title: string; body: string } {
  const said = error.message?.trim() || "";
  switch (error.kind) {
    case "auth":
      return { title: `${provider} did not accept the saved token`, body: "It may have been revoked or replaced. Reconnect with a new one." };
    case "expired":
      return { title: `The saved ${provider} token has expired`, body: "Make a new token and reconnect with it." };
    case "permission":
      return { title: "The token cannot read this", body: "Check the token's scopes in the connection's settings." };
    case "unreachable":
      return { title: `${host} did not answer`, body: "Check the network or VPN, and whether the site is up." };
    case "tls":
      return {
        title: `${host}'s certificate is not trusted here`,
        body: "The deck checks every certificate and cannot skip one: add the issuing authority to this machine's trust store, then try again.",
      };
    case "rate-limit":
      return {
        title: `${provider} asked the deck to slow down`,
        // The wait itself is on Try again, which counts it down.
        body: error.retryAfter == null ? "Try again in a minute."
          : error.retryAfter < 60 ? "It will answer again in a moment." : `It will answer again ${retryWhen(error.retryAfter, now)}.`,
      };
    case "incompatible":
      return { title: `This is not a ${provider} the deck can read`, body: said || "Check the address in the connection's settings." };
    case "not-found":
      return { title: "Not there any more", body: "It was deleted or moved, or this token cannot see it." };
    case "network":
      return { title: "The deck could not be reached", body: "Check that the deck is still running, then try again." };
    case "unavailable":
      return { title: `${provider} is unavailable on this deck`, body: "The deck cannot read it right now. Try again in a moment." };
    case "invalid":
      return { title: "The deck could not ask for that", body: said };
    default:
      return { title: `${provider} answered with an error`, body: said };
  }
}

/** The provider's own words, shown quietly under the sentence when they add
 *  something to it. Never for a token failure, whose answer can echo what was sent. */
export function failureSaid(error: FailureInfo, body: string): string | null {
  if (error.kind === "auth" || error.kind === "expired") return null;
  const detail = error.detail?.trim();
  if (!detail || body.includes(detail)) return null;
  return detail;
}

/** Seconds left before Try again may be pressed, from when the failure arrived. */
export function retryWait(error: FailureInfo, arrivedAt: number, now = Date.now()): number {
  if (error.kind !== "rate-limit" || error.retryAfter == null) return 0;
  return Math.max(0, Math.ceil(error.retryAfter - (now - arrivedAt) / 1000));
}
