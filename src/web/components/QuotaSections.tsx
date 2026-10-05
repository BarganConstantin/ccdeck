// The usage panel's two quota sections: Claude's windows and top-up, and
// Codex's lanes, credits and local token count.
//
// Lifted out of UsagePanel.tsx unchanged, with the words each prints when it
// has nothing to show (claudeQuotaHint, codexHint), where a Claude reading came
// from (quotaSourceHint) and how old each reading is (ageLabel). Nothing here
// fetches or holds state: the readings are use-quota.ts's, handed in by the
// panel under the names the markup already used, and whether a section is
// drawn at all is still the panel's call, from which CLIs the deck watches
// (#402).
import { PRODUCT } from "../brand";
import { resetCreditsLine } from "../reset-credits";
import { fmtTokens } from "../token-format";
import type { Incident } from "../provider-status";
import type { CodexQuotaData, CodexUsageData, QuotaData } from "../use-quota";
import { QuotaIncident } from "./ProviderIncidents";
import QuotaBar from "./QuotaBar";

/** "just now" / "40s ago" / "17m ago" / "2h ago", or null when never fetched.
 *
 *  Asked per section, not per panel. The two quotas come from different places
 *  and age at very different rates — Codex is fetched from its endpoint,
 *  Claude is usually read from claude-swap's last collection, which can be half
 *  an hour old. One combined "just now" in the header took the fresher of the
 *  two and stamped it on both. */
function ageLabel(ms: number | undefined, nowSec: number): string | null {
  if (!ms) return null;
  const s = nowSec - Math.floor(ms / 1000);
  if (s < 10)   return "just now";
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

/** Which of the three sources answered, in words. */
function quotaSourceHint(source?: string): string {
  if (source === "claude-swap") return "Read from claude-swap's last collection — costs no request against your usage-endpoint budget. Saved limit resets, which it does not collect, are read separately: every 30 minutes, or 5 on refresh";
  if (source === "api")         return "Fetched from Anthropic's usage endpoint, at most once every 5 minutes";
  if (source === "cli")         return "Parsed from `claude /usage`, at most once every 5 minutes";
  return "Last update";
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
function claudeQuotaHint(reason?: string): string {
  switch (reason) {
    case "no_subscription":
      return "This install signs in with an API key (or Bedrock/Vertex), which is billed per token and has no session window.";
    case "rate_limited":  return "Anthropic asked the deck to wait — it will retry on its own.";
    case "waiting":       return "Waiting for the next allowed read — or click ↻.";
    default:              return "Run /usage in a claude session, then click ↻";
  }
}

/** Why the Codex section is empty, in words that say what to do about it. */
function codexHint(reason?: string): string {
  switch (reason) {
    case "no_token":         return "Run codex login to authenticate.";
    case "api_key_mode":     return "API-key login — ChatGPT quota is only available for codex login.";
    case "refresh_rejected": return "Codex session expired — run codex login.";
    case "refresh_failed":   return "Couldn't refresh the Codex token — click ↻ to retry.";
    // The deck will not put a live ChatGPT token on the wire to somewhere it
    // read out of a config file it does not own, so it says which file.
    case "untrusted_base_url": return "chatgpt_base_url in ~/.codex/config.toml is not an https OpenAI host, so the token was not sent.";
    // The two states a refused read is answered with, said as the Claude
    // section says them: the API did answer, and ↻ is what the wait refuses.
    case "rate_limited":     return "OpenAI asked the deck to wait — it will retry on its own.";
    case "waiting":          return "Waiting for the next allowed read — or click ↻.";
    default:                 return "ChatGPT API unreachable — click ↻ to retry.";
  }
}

export function ClaudeQuotaSection({ quota, quotaLoading, nowSec, incident }: {
  /** The last /api/quota answer, or null until the first one lands. */
  quota: QuotaData | null;
  /** A forced read is out, and the age is not shown while it is. */
  quotaLoading: boolean;
  /** The panel's clock in seconds, for the ages, countdowns and pace. */
  nowSec: number;
  /** Anthropic's status page reports an incident (#1311). */
  incident?: Incident;
}) {
  const claudeAge = ageLabel(quota?.fetchedAt, nowSec);
  return (
    <section className="up-section up-quota-section">
      <h3 className="up-section-title">
        Claude quota
        {/* Where the numbers came from, on hover. Anthropic's usage endpoint
            allows ~28-30 calls an hour per account, shared by every tool on
            the machine, so when claude-swap is already collecting them the
            deck reads its store instead of spending a second call — which is
            why this age is minutes rather than seconds. */}
        {claudeAge && !quotaLoading && (
          <span className="up-section-age" title={quotaSourceHint(quota?.source)}>
            {/* Said when the server is holding the last reading it has rather
                than a new one, as a bar says its window has reset: the age
                alone reads as the last poll's. */}
            {claudeAge}{quota?.stale && " · no newer reading"}
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
              label="5-hour window"
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
            label="7-day window"
            pct={quota.week7dPct ?? null}
            reset={quota.week7dReset}
            resetAt={quota.week7dResetAt}
            windowSec={quota.week7dWindowSec}
            nowSec={nowSec}
          />
          {quota.weekSonnetPct != null && (
            <QuotaBar label="Sonnet (7d)" pct={quota.weekSonnetPct} nowSec={nowSec} />
          )}
          {quota.weekOpusPct != null && (
            <QuotaBar label="Opus (7d)" pct={quota.weekOpusPct} nowSec={nowSec} />
          )}
          {/* The top-up, when there is one. A bar because it is the same kind
              of fact as the two above — a fraction of an allowance with a
              hard edge — and because a percentage is the one reading that is
              true whatever unit the upstream sends. */}
          {quota.extraEnabled && quota.extraUsedCredits != null && quota.extraMonthlyLimit
            ? (
              <QuotaBar
                label={`Extra credits (month${quota.extraCurrency ? `, ${quota.extraCurrency}` : ""})`}
                pct={Math.min(100, Math.round((quota.extraUsedCredits / quota.extraMonthlyLimit) * 100))}
                nowSec={nowSec}
              />
            )
            : quota.extraEnabled && (
              /* Enabled with no ceiling to measure against: say that it is on
                 rather than draw a bar with no denominator. */
              <div className="up-quota-sub up-credits">extra usage credits: on</div>
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
          <span>{quota.reason === "no_subscription" ? "No quota to show." : "Quota unavailable."}</span>
          <span className="up-quota-hint">{claudeQuotaHint(quota.reason)}</span>
        </div>
      ) : (
        <div className="up-quota-na up-quota-loading">Checking…</div>
      )}
    </section>
  );
}

export function CodexQuotaSection({ codexQuota, codexLoading, codexUsage, nowSec, incident }: {
  /** The last /api/codex-quota answer, or null until the first one lands. */
  codexQuota: CodexQuotaData | null;
  /** A forced read is out, and the age is not shown while it is. */
  codexLoading: boolean;
  /** The token count from the rollout files on this disk, or null. */
  codexUsage: CodexUsageData | null;
  /** The panel's clock in seconds, for the ages, countdowns and pace. */
  nowSec: number;
  /** OpenAI's status page reports an incident on a Codex component (#1311). */
  incident?: Incident;
}) {
  const codexAge  = ageLabel(codexQuota?.fetchedAt, nowSec);
  return (
    <section className="up-section up-quota-section">
      <h3 className="up-section-title">
        Codex quota
        {codexQuota?.ok && codexQuota.planLabel && (
          <span className="up-plan-badge">{codexQuota.planLabel}</span>
        )}
        {codexAge && !codexLoading && (
          <span className="up-section-age" title="Fetched from the Codex usage endpoint">{codexAge}</span>
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
              label={`spend cap · $${Math.round(codexQuota.creditLimit.used)} of $${Math.round(codexQuota.creditLimit.limit)}`}
              pct={codexQuota.creditLimit.usedPct}
              reset={codexQuota.creditLimit.reset ?? undefined}
              resetAt={codexQuota.creditLimit.resetAt ?? undefined}
              limitReached={codexQuota.spendControlReached}
              nowSec={nowSec}
            />
          )}

          {codexQuota.creditsBalance && !codexQuota.creditsUnlimited && (
            <div className="up-quota-sub up-credits">
              credits: ${codexQuota.creditsBalance}
              {codexQuota.overageReached && " · overage limit reached"}
            </div>
          )}
          {codexQuota.creditsUnlimited && (
            <div className="up-quota-sub up-credits">credits: unlimited</div>
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
              Partial data — OpenAI returned limits this build doesn't recognise.
            </div>
          )}
        </div>
      ) : codexQuota?.ok === false ? (
        <div className="up-quota-na">
          <span>Quota unavailable.</span>
          <span className="up-quota-hint">{codexHint(codexQuota.reason)}</span>
        </div>
      ) : (
        <div className="up-quota-na up-quota-loading">Checking…</div>
      )}

      {/* The 7-day token count, from the rollout files on this disk. It sits
          OUTSIDE the three quota branches above, which is the whole point:
          until #400 it was nested in the success branch, so the one number in
          this section that needs no token, no account and no network was
          withheld whenever the network call failed — on `no_token`, on
          `api_key_mode`, on an expired refresh, on blocked egress. The poll
          ran every 60s regardless and its answer was thrown away.
          Measured on this machine, cold cache, three rounds: /api/codex-usage
          takes 2-4ms and makes zero outbound requests; /api/codex-quota takes
          991-1299ms across two authenticated HTTPS GETs to chatgpt.com. The
          fast local number was waiting on the slow remote one for permission
          to render.
          The 5h window goes in the title rather than on the line: the server
          has computed it since this file was written and nothing has ever
          read it, and this panel is 280px wide (#369) — a second visible
          figure costs more than it says. */}
      {codexUsage?.ok && codexUsage.window7d && codexUsage.window7d.sessionCount > 0 && (
        <div
          className="up-quota-sub"
          title={`Counted from the rollout files under CODEX_HOME — no network, no account${
            codexUsage.window5h ? `\nlast 5h: ${fmtTokens(codexUsage.window5h.totalTokens)} tokens · ${codexUsage.window5h.sessionCount} session${codexUsage.window5h.sessionCount !== 1 ? "s" : ""}` : ""
          }`}
        >
          {fmtTokens(codexUsage.window7d.totalTokens)} tokens · {codexUsage.window7d.sessionCount} session
          {codexUsage.window7d.sessionCount !== 1 ? "s" : ""} (7d)
        </div>
      )}
    </section>
  );
}
