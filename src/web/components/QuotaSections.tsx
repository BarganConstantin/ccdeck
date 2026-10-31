// The usage panel's two quota sections: Claude's windows and top-up, and
// Codex's lanes and credits.
//
// Lifted out of UsagePanel.tsx unchanged, with the words each prints when it
// has nothing to show (claudeQuotaHint, codexHint), where a Claude reading came
// from (quotaSourceHint) and how old each reading is (ageLabel). Nothing here
// fetches or holds state: the readings are use-quota.ts's, handed in by the
// panel under the names the markup already used, and whether a section is
// drawn at all is still the panel's call, from which CLIs the deck watches
// (#402).
import { PRODUCT } from "../brand";
import { useT, type TFunction } from "../i18n";
import { resetCreditsLine } from "../reset-credits";
import type { Incident } from "../provider-status";
import type { CodexQuotaData, QuotaData } from "../use-quota";
import { weekEndsLine, weekEndsTitle, type QuotaClose } from "../quota-closes";
import { QuotaIncident } from "./ProviderIncidents";
import QuotaBar from "./QuotaBar";

/** "just now" / "40s ago" / "17m ago" / "2h ago", or null when never fetched.
 *
 *  Asked per section, not per panel. The two quotas come from different places
 *  and age at very different rates — Codex is fetched from its endpoint,
 *  Claude is usually read from claude-swap's last collection, which can be half
 *  an hour old. One combined "just now" in the header took the fresher of the
 *  two and stamped it on both. */
function ageLabel(t: TFunction, ms: number | undefined, nowSec: number): string | null {
  if (!ms) return null;
  const s = nowSec - Math.floor(ms / 1000);
  if (s < 10)   return t("quota.age.now");
  if (s < 60)   return t("quota.age.seconds", { n: s });
  if (s < 3600) return t("quota.age.minutes", { n: Math.floor(s / 60) });
  return t("quota.age.hours", { n: Math.floor(s / 3600) });
}

/** Which of the three sources answered, in words. */
function quotaSourceHint(t: TFunction, source?: string): string {
  if (source === "claude-swap") return t("quota.source.swap");
  if (source === "api")         return t("quota.source.api");
  if (source === "cli")         return t("quota.source.cli");
  return t("quota.source.other");
}

/**
 * Why the Claude quota section is empty, in the reader's terms.
 *
 * One sentence used to cover every failure — "Run /usage in a claude session,
 * then click ↻" — and on an API-key, Bedrock or Vertex install that is advice
 * which cannot work: those are billed per token and have no five-hour window to
 * report. Worse, that machine did not even get this far. The CLI ran, printed
 * no quota lines, and the server read that as a genuine "<1%", so the panel drew
 * two empty bars for a measurement nobody had taken.
 *
 * Same shape as codexHint below, which has answered this properly all along.
 */
function claudeQuotaHint(t: TFunction, reason?: string): string {
  switch (reason) {
    case "no_subscription":
      return t("quota.hint.noSubscription");
    case "rate_limited":  return t("quota.hint.rateLimitedAnthropic");
    case "waiting":       return t("quota.hint.waiting");
    default:              return t("quota.hint.runUsage");
  }
}

/** Why the Codex section is empty, in words that say what to do about it. */
function codexHint(t: TFunction, reason?: string): string {
  switch (reason) {
    case "no_token":         return t("quota.hint.codexNoToken");
    case "api_key_mode":     return t("quota.hint.codexApiKey");
    case "refresh_rejected": return t("quota.hint.codexExpired");
    case "refresh_failed":   return t("quota.hint.codexRefreshFailed");
    // The deck will not put a live ChatGPT token on the wire to somewhere it
    // read out of a config file it does not own, so it says which file.
    case "untrusted_base_url": return t("quota.hint.codexUntrusted");
    // The two states a refused read is answered with, said as the Claude
    // section says them: the API did answer, and ↻ is what the wait refuses.
    case "rate_limited":     return t("quota.hint.rateLimitedOpenai");
    case "waiting":          return t("quota.hint.waiting");
    default:                 return t("quota.hint.codexUnreachable");
  }
}

/** How full the account's last weeks ended, under the bars. A footnote, so it is
 *  absent until a week has ended with a reading near its reset (quota-closes.ts). */
function WeekEnds({ weeks = [] }: { weeks?: QuotaClose[] }) {
  const line = weekEndsLine(weeks);
  return line ? <div className="up-quota-sub" title={weekEndsTitle(weeks)}>{line}</div> : null;
}

export function ClaudeQuotaSection({ quota, quotaLoading, nowSec, incident, weekEnds }: {
  /** The last /api/quota answer, or null until the first one lands. */
  quota: QuotaData | null;
  /** This account's last weeks that ran to their reset, newest first. */
  weekEnds?: QuotaClose[];
  /** A forced read is out, and the age is not shown while it is. */
  quotaLoading: boolean;
  /** The panel's clock in seconds, for the ages, countdowns and pace. */
  nowSec: number;
  /** Anthropic's status page reports an incident (#1311). */
  incident?: Incident;
}) {
  const t = useT();
  const claudeAge = ageLabel(t, quota?.fetchedAt, nowSec);
  return (
    <section className="up-section up-quota-section">
      <h3 className="up-section-title">
        {t("quota.claude.title")}
        {quota?.ok && quota.planLabel && (
          <span className="up-plan-badge">{quota.planLabel}</span>
        )}
        {/* Where the numbers came from, on hover. Anthropic's usage endpoint
            allows ~28-30 calls an hour per account, shared by every tool on
            the machine, so when claude-swap is already collecting them the
            deck reads its store instead of spending a second call — which is
            why this age is minutes rather than seconds. */}
        {claudeAge && !quotaLoading && (
          <span className="up-section-age" title={quotaSourceHint(t, quota?.source)}>
            {/* Said when the server is holding the last reading it has rather
                than a new one, as a bar says its window has reset: the age
                alone reads as the last poll's. */}
            {claudeAge}{quota?.stale && ` · ${t("quota.noNewer")}`}
          </span>
        )}
      </h3>
      {/* Above the bars rather than beside "Quota unavailable.": the quota can
          read fine through an incident, and when it cannot, this is the line
          that says why before the hint below guesses at a local cause. */}
      <QuotaIncident incident={incident} />
      {quota?.ok ? (
        <div className="up-quota-bars">
          {quota.session5hPct != null && (
            <QuotaBar
              label={t("quota.window.5h")}
              pct={quota.session5hPct}
              reset={quota.session5hReset}
              resetAt={quota.session5hResetAt}
              windowSec={quota.session5hWindowSec}
              nowSec={nowSec}
            />
          )}
          {/* Drawn whether or not there is a number for it (#1627). A source
              that sent no 7-day window has not said the week is empty, so the
              bar says "no reading" — not the "< 1%" the server's stand-in zero
              used to print, and not a missing row, which is how the CLI's
              reading showed the same gap. */}
          <QuotaBar
            label={t("quota.window.7d")}
            pct={quota.week7dPct ?? null}
            reset={quota.week7dReset}
            resetAt={quota.week7dResetAt}
            windowSec={quota.week7dWindowSec}
            nowSec={nowSec}
          />
          <WeekEnds weeks={weekEnds} />
          {quota.weekSonnetPct != null && (
            <QuotaBar label={t("quota.sonnet7d")} pct={quota.weekSonnetPct} nowSec={nowSec} />
          )}
          {quota.weekOpusPct != null && (
            <QuotaBar label={t("quota.opus7d")} pct={quota.weekOpusPct} nowSec={nowSec} />
          )}
          {/* The top-up, when there is one. A bar because it is the same kind
              of fact as the two above — a fraction of an allowance with a
              hard edge — and because a percentage is the one reading that is
              true whatever unit the upstream sends. */}
          {quota.extraEnabled && quota.extraUsedCredits != null && quota.extraMonthlyLimit
            ? (
              <QuotaBar
                label={quota.extraCurrency ? t("quota.extraCurrency", { currency: quota.extraCurrency }) : t("quota.extra")}
                pct={Math.min(100, Math.round((quota.extraUsedCredits / quota.extraMonthlyLimit) * 100))}
                nowSec={nowSec}
              />
            )
            : quota.extraEnabled && (
              /* Enabled with no ceiling to measure against: say that it is on
                 rather than draw a bar with no denominator. */
              <div className="up-quota-sub up-credits">{t("quota.extraOn")}</div>
            )}
          {/* Saved limit resets (#1308). Not the windows' own reset times
              above — those say when a window rolls over by itself; these are
              one-off resets the account holds. Counted, never spent: the
              deck has no way to redeem one and does not want one. */}
          {quota.resetCredits && quota.resetCredits.availableCount > 0 && (
            <div className="up-quota-sub up-reset-credits" title={`Saved in Claude as "Reset for free". Redeem one in Claude on the web or desktop — ${PRODUCT} only reports them`}>
              {resetCreditsLine("limit reset", quota.resetCredits)}
            </div>
          )}
        </div>
      ) : quota?.ok === false ? (
        <div className="up-quota-na">
          <span>{quota.reason === "no_subscription" ? t("quota.none") : t("quota.unavailable")}</span>
          <span className="up-quota-hint">{claudeQuotaHint(t, quota.reason)}</span>
        </div>
      ) : (
        <div className="up-quota-na up-quota-loading">{t("quota.checking")}</div>
      )}
    </section>
  );
}

export function CodexQuotaSection({ codexQuota, codexLoading, nowSec, incident, weekEnds }: {
  /** The last /api/codex-quota answer, or null until the first one lands. */
  codexQuota: CodexQuotaData | null;
  /** This account's last weeks that ran to their reset, newest first. */
  weekEnds?: QuotaClose[];
  /** A forced read is out, and the age is not shown while it is. */
  codexLoading: boolean;
  /** The panel's clock in seconds, for the ages, countdowns and pace. */
  nowSec: number;
  /** OpenAI's status page reports an incident on a Codex component (#1311). */
  incident?: Incident;
}) {
  const t = useT();
  const codexAge  = ageLabel(t, codexQuota?.fetchedAt, nowSec);
  return (
    <section className="up-section up-quota-section">
      <h3 className="up-section-title">
        {t("quota.codex.title")}
        {codexQuota?.ok && codexQuota.planLabel && (
          <span className="up-plan-badge">{codexQuota.planLabel}</span>
        )}
        {codexAge && !codexLoading && (
          <span className="up-section-age" title={t("quota.source.codex")}>{codexAge}</span>
        )}
      </h3>
      <QuotaIncident incident={incident} />
      {codexQuota?.ok ? (
        <div className="up-quota-bars">
          {codexQuota.windows?.map(w => (
            <QuotaBar
              key={w.id}
              label={w.label}
              pct={w.pct}
              reset={w.reset ?? undefined}
              resetAt={w.resetAt ?? undefined}
              windowSec={w.windowSec ?? undefined}
              limitReached={codexQuota.limitReached && w.pct >= 100}
              nowSec={nowSec}
            />
          ))}
          <WeekEnds weeks={weekEnds} />

          {/* Per-model families (Codex Spark and friends) — separate caps
              that run out independently of the account-wide lanes. */}
          {codexQuota.extraWindows?.map(w => (
            <QuotaBar
              key={w.id}
              label={w.label}
              pct={w.pct}
              reset={w.reset ?? undefined}
              resetAt={w.resetAt ?? undefined}
              windowSec={w.windowSec ?? undefined}
              nowSec={nowSec}
            />
          ))}

          {/* Spend cap (team/enterprise, or a personal monthly credit limit).
              Denominated in dollars, so it gets its own bar rather than
              pretending to be a rate-limit lane. */}
          {codexQuota.creditLimit && (
            <QuotaBar
              label={t("quota.spendCap", { used: `$${Math.round(codexQuota.creditLimit.used)}`, limit: `$${Math.round(codexQuota.creditLimit.limit)}` })}
              pct={codexQuota.creditLimit.usedPct}
              reset={codexQuota.creditLimit.reset ?? undefined}
              resetAt={codexQuota.creditLimit.resetAt ?? undefined}
              limitReached={codexQuota.spendControlReached}
              nowSec={nowSec}
            />
          )}

          {codexQuota.creditsBalance && !codexQuota.creditsUnlimited && (
            <div className="up-quota-sub up-credits">
              {t("quota.creditsBalance", { amount: `$${codexQuota.creditsBalance}` })}
              {codexQuota.overageReached && ` · ${t("quota.overage")}`}
            </div>
          )}
          {codexQuota.creditsUnlimited && (
            <div className="up-quota-sub up-credits">{t("quota.creditsUnlimited")}</div>
          )}
          {codexQuota.resetCredits && codexQuota.resetCredits.availableCount > 0 && (
            <div className="up-quota-sub up-reset-credits" title={`Redeem in the Codex CLI or ChatGPT — ${PRODUCT} only reports them`}>
              {resetCreditsLine("rate-limit reset", codexQuota.resetCredits)}
            </div>
          )}
          {codexQuota.promo && (
            <div className="up-quota-sub">{codexQuota.promo}</div>
          )}
          {codexQuota.partial && (
            <div className="up-quota-sub up-quota-hint">
              {t("quota.partial")}
            </div>
          )}
        </div>
      ) : codexQuota?.ok === false ? (
        <div className="up-quota-na">
          <span>{t("quota.unavailable")}</span>
          <span className="up-quota-hint">{codexHint(t, codexQuota.reason)}</span>
        </div>
      ) : (
        <div className="up-quota-na up-quota-loading">{t("quota.checking")}</div>
      )}

    </section>
  );
}
