// What the accounts panel says when there is no roster to draw.
//
// Lifted out of AccountsPanel.tsx unchanged. The roster read answers `ok:
// false` for five different reasons — claude-swap still installing, not
// installed, installed with nothing in its store, a copy the deck refused to
// drive, or a store that could not be read — and each needs a different thing
// from the reader, so each gets its own sentence. It was a forty-line branch of the panel's render that read nothing
// but the answer's reason and hint, and that is all it is handed.
import { type AccountsData } from "../claude-accounts";
import { useT } from "../i18n";
import { Rich } from "../accounts-rich";

export default function AccountsEmptyState({ data }: { data: Pick<AccountsData, "reason" | "hint" | "version" | "want"> }) {
  const t = useT();
  return (
    <div className="ap-empty">
      {/* The deck's own install, still running. Said as a wait rather
          than a fault, and with no command in it: the command belongs
          to `no_cswap`, where there is no install coming, and printed
          here it sent people to race a second installer against the
          one already running. */}
      {data.reason === "cswap_installing" ? (
        <>
          <span>{t("accounts.empty.installing")}</span>
          <span className="ap-hint">{t("accounts.empty.installingHint")}</span>
        </>
      ) : data.reason === "no_cswap" ? (
        <>
          <span>{t("accounts.empty.noCswap")}</span>
          <span className="ap-hint">{t("accounts.empty.noCswapHint")}</span>
          {data.hint && <code className="ap-cmd">{data.hint}</code>}
          <span className="ap-hint"><Rich text={t("accounts.empty.thenAdd")} /></span>
        </>
      ) : data.reason === "cswap_refused" ? (
        <>
          {/* #1799: the deck installed claude-swap and a different version
              answered. Said as the deck's decision, with the two ways out of
              it, rather than as "not installed" — it is installed, and the
              boot row names it. */}
          <span>{t("accounts.empty.refused")}</span>
          <span className="ap-hint">
            {t("accounts.empty.refusedHint", {
              answered: data.version ? t("accounts.empty.answeredVersion", { version: data.version }) : t("accounts.empty.answeredOther"),
              wanted: data.want ? t("accounts.empty.wanted", { want: data.want }) : "",
            })}
          </span>
        </>
      ) : data.reason === "no_accounts" ? (
        <>
          <span>{t("accounts.empty.none")}</span>
          <span className="ap-hint"><Rich text={t("accounts.empty.noneHint")} /></span>
        </>
      ) : (
        <>
          <span>{t("accounts.empty.unreadable")}</span>
          <span className="ap-hint">
            {t("accounts.empty.unreadableHint", { reason: data.reason ? t("accounts.empty.reason", { reason: data.reason }) : "" })}
          </span>
        </>
      )}
    </div>
  );
}
