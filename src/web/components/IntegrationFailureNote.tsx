// A failed read in an integration panel, and its one way out (#2178, #2179).
//
//   <IntegrationFailureNote error={{ kind, message?, detail?, retryAfter? }}
//     provider="GitHub" host? stale? onRetry? onReconnect? title? body?>
//     {extra actions}
//   </IntegrationFailureNote>
//
// One design for Jira and the forges: the error mark and a heading, the
// sentence under it, and the provider's own words quietly below when they add
// something. The action comes from the kind (integrations/failure.ts):
// Reconnect for a token, Open connection settings for scopes or an address,
// Try again for the rest, nothing for a page that is gone. `onReconnect` serves
// both of the first two (it opens Settings › Integrations at this connection);
// a button whose handler is not passed is not drawn. A rate limit holds Try
// again, counting the wait down on the button itself, and a press before then
// does nothing. `stale` is the compact note over rows that are the last answer:
// the warning mark and edge instead of the error's, since what is on screen is
// still useful. The words are an alert (a status when stale); the buttons sit
// outside it, so the countdown is not read out every second. `title` and
// `body` replace the shared words when a panel has better ones.
import { useEffect, useState, type ReactNode } from "react";
import { ErrorMark, WarnMark } from "./integration-glyphs";
import { useT } from "../i18n";
import { actionLabel, failureAction, failureSaid, failureWords, retryWait, retryWhen, waitLabel, type FailureInfo } from "../integrations/failure";

export default function IntegrationFailureNote({ error, provider, host, stale = false, onRetry, onReconnect, title, body, children, now }: {
  error: FailureInfo;
  /** The provider's name as the reader knows it: "Jira", "GitHub", "GitLab". */
  provider: string;
  /** The site's host, for a failure that is about the place ("… did not answer"). */
  host?: string;
  stale?: boolean;
  onRetry?: () => void;
  onReconnect?: () => void;
  title?: string;
  body?: string;
  children?: ReactNode;
  /** The clock, for tests. */
  now?: number;
}) {
  const t = useT();
  // When this failure arrived: the rate limit's wait counts from here. A new
  // failure is a new object, and starts its own wait.
  const [arrived, setArrived] = useState(() => now ?? Date.now());
  const [clock, setClock] = useState(() => now ?? Date.now());
  useEffect(() => { const at = Date.now(); setArrived(at); setClock(at); }, [error]);
  const at = now ?? clock;
  const wait = retryWait(error, arrived, at);
  useEffect(() => {
    if (wait <= 0) return;
    const timer = window.setTimeout(() => setClock(Date.now()), 1000);
    return () => window.clearTimeout(timer);
  }, [wait, clock]);

  const words = failureWords(error, provider, host, at, t);
  const heading = title ?? words.title;
  const sentence = body ?? words.body;
  const said = failureSaid(error, sentence);
  const action = failureAction(error.kind);
  const handler = action === "retry" ? onRetry : action === "none" ? undefined : onReconnect;
  const label = action === "none" ? "" : actionLabel(action, t);
  const primary = action === "reconnect";

  return (
    <div className="ig-failure" data-kind={error.kind} data-stale={stale || undefined}>
      <div className="ig-failure-text" role={stale ? "status" : "alert"}>
        <p className="ig-failure-title">{stale ? <WarnMark /> : <ErrorMark />}<strong>{heading}</strong></p>
        {sentence && <p className="ig-failure-body">{sentence}</p>}
        {said && !stale && <p className="ig-failure-said">{t("integrations.failure.said", { provider, said })}</p>}
      </div>
      {(handler || children) && (
        <div className="ig-failure-actions">
          {handler && (
            <button type="button" className={primary ? "btn primary" : "btn"}
              aria-disabled={wait > 0 || undefined}
              onClick={() => { if (wait <= 0) handler(); }}>
              {wait > 0 ? waitLabel(label, retryWhen(wait, at, t), t) : label}
            </button>
          )}
          {children}
        </div>
      )}
    </div>
  );
}
