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
import { currentLanguage, t as translateNow, type TFunction } from "../i18n";
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
export function actionLabel(action: Exclude<FailureAction, "none">, t: TFunction = translateNow): string {
  return action === "reconnect" ? t("integrations.failure.reconnect") : action === "settings" ? t("integrations.failure.openSettings") : t("integrations.failure.retry");
}

/** "in 42s" under a minute, "after 14:05" past it (the reader's own clock). */
export function retryWhen(seconds: number, now = Date.now(), t: TFunction = translateNow): string {
  if (seconds < 60) return t("integrations.failure.in", { n: Math.max(1, Math.ceil(seconds)) });
  return t("integrations.failure.after", { time: new Date(now + seconds * 1000).toLocaleTimeString(currentLanguage(), { hour: "2-digit", minute: "2-digit" }) });
}

/** The button's words while a rate limit holds it: "Try again in 42s". */
export function waitLabel(label: string, when: string, t: TFunction = translateNow): string {
  return t("integrations.failure.wait", { label, when });
}

/** The heading and the sentence under it, by kind, in the provider's name. */
export function failureWords(error: FailureInfo, provider: string, host = provider, now = Date.now(), t: TFunction = translateNow): { title: string; body: string } {
  const said = error.message?.trim() || "";
  switch (error.kind) {
    case "auth":
      return { title: t("integrations.failure.auth.title", { provider }), body: t("integrations.failure.auth.body") };
    case "expired":
      return { title: t("integrations.failure.expired.title", { provider }), body: t("integrations.failure.expired.body") };
    case "permission":
      return { title: t("integrations.failure.permission.title"), body: t("integrations.failure.permission.body") };
    case "unreachable":
      return { title: t("integrations.failure.unreachable.title", { host }), body: t("integrations.failure.unreachable.body") };
    case "tls":
      return {
        title: t("integrations.failure.tls.title", { host }),
        body: t("integrations.failure.tls.body"),
      };
    case "rate-limit":
      return {
        title: t("integrations.failure.rateLimit.title", { provider }),
        // The wait itself is on Try again, which counts it down.
        body: error.retryAfter == null ? t("integrations.failure.rateLimit.minute")
          : error.retryAfter < 60 ? t("integrations.failure.rateLimit.moment") : t("integrations.failure.rateLimit.again", { when: retryWhen(error.retryAfter, now, t) }),
      };
    case "incompatible":
      return { title: t("integrations.failure.incompatible.title", { provider }), body: said || t("integrations.failure.incompatible.body") };
    case "not-found":
      return { title: t("integrations.failure.notFound.title"), body: t("integrations.failure.notFound.body") };
    case "network":
      return { title: t("integrations.failure.network.title"), body: t("integrations.failure.network.body") };
    case "unavailable":
      return { title: t("integrations.failure.unavailable.title", { provider }), body: t("integrations.failure.unavailable.body") };
    case "invalid":
      return { title: t("integrations.failure.invalid.title"), body: said };
    default:
      return { title: t("integrations.failure.default.title", { provider }), body: said };
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
