import { useEffect, useState } from "react";
import { useT } from "../i18n";

/** A transcript being read, without provisional token or cost values. */
export default function SessionUsageLoading() {
  const t = useT();
  const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.hidden);
  useEffect(() => {
    const changed = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  return <div className="su-loading" role="status" aria-label={t("insights.session.reading")} data-paused={hidden || undefined}>
    <svg className="su-loading-art" viewBox="0 0 144 88" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M47 21v-7a4 4 0 0 1 4-4h39a4 4 0 0 1 4 4v49" />
      <rect x="39" y="21" width="46" height="56" rx="4" />
      <path d="M49 32h26M49 40h19M49 48h24M49 62h12" />
      <path className="su-loading-read" d="M49 32h26" />
    </svg>
    <strong>{t("insights.session.reading")}</strong>
    <span>{t("insights.session.checking")}</span>
  </div>;
}
